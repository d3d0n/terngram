import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@oh-my-pi/pi-tui/keys";
import { base64ImageNode } from "@oh-my-pi/pi-tui/native/blobs";
import type { DescribeContext, NativeNode, NativeScroll, NativeSurface, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { type Component, type OverlayHandle, type TerminalFramePlan, TUI } from "@oh-my-pi/pi-tui/tui";
import { type Authorization, type ChatMessage, type ClientState, type Dialog, type DialogCursor, type DialogPage, type PendingSend, type Photo, type TelegramUpdate, Telegram, TelegramRequestError } from "./telegram";
import { ForwardPicker } from "./forward-picker";
import { ChatState } from "./chat-state";
import { CommandPalette, type PaletteItem } from "./command-palette";
import { ShortcutHelp } from "./shortcut-help";
import { MessageView } from "./message-view";
import { PhotoViewer } from "./photo-viewer";
import { describeChatDock } from "./chat-dock";
import { button, label, preview } from "./nodes";
import { ImageLoader } from "./image-loader";
import { ChatNavigation } from "./chat-navigation";
import { ReadReceipts } from "./read-receipts";
import { RequestCooldowns } from "./request-cooldowns";
import { ReaderCounts } from "./reader-counts";
import type { DebugLog, DebugState } from "./debug-log";

const PAGE_SIZE = 50;
const SINGLE_PRESS_KEYS = ["enter", "ctrl+enter", "escape", "ctrl+r", "ctrl+g", "ctrl+k", "ctrl+f", "ctrl+q", "ctrl+c"] as const;
const photoKey = (message: ChatMessage): string => `${message.chat_id}:${message.id}:${message.media_id ?? "none"}`;
/** Incoming messages in a followed open chat count as read only after recent user input. */
const PRESENCE_MS = 60_000;
type Stage = "credentials" | "qr" | "password" | "closed" | "chats" | "logout";
const COPY: Record<Stage, { title: string; hint: string; submit: string }> = {
  credentials: { title: "Connect Telegram", hint: "Terngram is an unofficial Telegram client. Use your application's API ID and API hash from my.telegram.org/apps.", submit: "Continue with QR" },
  qr: { title: "Log in by QR code", hint: "Use Telegram on a device where you are already signed in.", submit: "Retry QR login" },
  password: { title: "Two-step verification", hint: "Enter your Telegram password. It is masked and never stored.", submit: "Unlock" },
  closed: { title: "Telegram connection closed", hint: "Reconnect to continue securely.", submit: "Reconnect" },
  chats: { title: "Chats", hint: "Choose a conversation.", submit: "Send" },
  logout: { title: "Sign out of terngram?", hint: "This revokes only this client's session and removes its local drafts.", submit: "Sign out" },
};

class Field extends Input {
  constructor(placeholder: string, masked: boolean, private changed: () => void, private disabled: () => boolean) {
    super(); this.prompt = ""; this.placeholder = placeholder; this.mask = masked;
  }
  override handleInput(data: string): boolean {
    if (this.disabled()) return false;
    const before = this.getValue();
    const handled = super.handleInput(data);
    if (before !== this.getValue()) this.changed();
    return handled;
  }
  override handleNativeEvent(event: NativeUiEvent): void {
    if (this.disabled()) return;
    super.handleNativeEvent(event); this.changed();
  }
  override describe(cx: DescribeContext): NativeNode {
    const description = super.describe(cx);
    return this.disabled() ? { ...description, p: { ...description.p, readonly: true } } as NativeNode : description;
  }
}
class Body implements Component {
  private description?: NativeNode;
  constructor(private app: TerngramApp) {}
  describe(cx: DescribeContext): NativeNode { return this.description ??= this.app.describeBody(cx); }
  invalidate(): void { this.description = undefined; }
  handleNativeEvent(event: NativeUiEvent): void { this.app.handleNativeEvent(event); }
  render(): readonly string[] { throw new Error("terngram requires native Tern rendering."); }
}

export class TerngramApp implements Component {
  focused = false;
  stage: Stage = "credentials";
  busy = false; // Authorization/reconnect only; chat requests never lock navigation or typing.
  status = "Starting local Telegram client…";
  error = false;
  account = "";
  dialogs: Dialog[] = [];
  private dialogCursor: DialogCursor | null | undefined;
  private loadingMoreChats = false;
  private moreChatsRequest?: Promise<boolean>;
  private moreChatsToken?: object;
  private fillingDialogs?: Promise<void>;
  private searchingDialogs = false;
  private messageView = new MessageView();
  selectedId: number | null = null;
  private online = false;
  private body = new Body(this);
  private telegram: Telegram;
  private authorizationState: Authorization["state"] = "credentials";
  private authorizationHint = "";
  private authorizationVersion = 0;
  private qrNode?: NativeNode;
  private authOperation?: object;
  private bootstrap?: { connection: Telegram; generation: number; promise: Promise<void> };
  private bootstrapSendStates = new Map<string, Extract<TelegramUpdate, { kind: "send_state" }>>();
  private abandonConfirm: string | null = null;
  private reconcilingSends = new Map<string, { connection: Telegram; generation: number; timer?: Timer }>();
  private savingEdits = new Set<ChatState>();
  private cooldowns = new RequestCooldowns();
  private readers = new ReaderCounts(
    (chat, id) => this.telegram.call<number | null>("message_readers", [chat, id]),
    () => this.redraw(),
    error => this.fail(error),
  );
  private threads = new Map<number, ChatState>();
  private scrolls = new Map<number, NativeScroll>();
  /** Chats whose latest messages the user left by paging, loading history, or selecting older messages. */
  private detached = new Set<number>();
  private navigation = new ChatNavigation();
  private lastInput = 0;
  private receipts = new ReadReceipts(
    (id, maxId) => this.telegram.call<void>("mark_read", [id, maxId]),
    (id, maxId) => {
      this.threads.get(id)?.acknowledgeNewMessages(maxId);
      this.dialogs = this.dialogs.map(dialog => dialog.id === id && (dialog.last_message_id ?? 0) <= maxId ? { ...dialog, unread_count: 0 } : dialog);
      this.redraw();
    },
    error => this.fail(error),
  );
  private forwardPicker?: ForwardPicker;
  private forwardOverlay?: OverlayHandle;
  private photoViewer?: PhotoViewer;
  private photoOverlay?: OverlayHandle;
  private photoGroup: ChatMessage | null = null;
  private photoNodes = new Map<string, NativeNode>();
  private photoLoading = new Map<string, { intent: number }>();
  private photoIntent = 0;
  private photoDisplayedIntent = 0;
  private resolvedAlbums = new Set<string>();
  private photoReturnFocus?: Component;
  private avatars = new ImageLoader(2, () => this.redraw(), error => this.fail(error));
  private previews = new ImageLoader(2, () => this.redraw(), error => this.fail(error));
  private dialogRequests = new Map<number, object>();
  private participantCounts = new Map<number, number | null>();
  private infoRequests = new Map<number, object>();
  private dirtyDialogs = new Set<number>();
  private metadataVersions = new Map<number, number>();
  private peerNames = new Map<number, string>();
  private refreshingDirty = false;
  private actionMessage: number | null = null;
  private deleteConfirm: number | null = null;
  private messageOperations = new Set<string>();
  private refreshing = false;
  private generation = 0;
  private quitting = false;
  private persistTimer?: NodeJS.Timeout;
  private readerTimer?: NodeJS.Timeout;
  private persistChain: Promise<void> = Promise.resolve();
  private settingComposer = false;
  private typingTimer?: NodeJS.Timeout;
  private transientTimer?: NodeJS.Timeout;
  private typingId: number | null = null;
  private typingAt = -Infinity;
  private activityAt = -Infinity;
  private transientActions = new Map<number, Map<number, { sender: string; action: string; until: number }>>();
  private activityChain: Promise<void> = Promise.resolve();
  private activityEpoch = 0;
  private showContextHints = true;
  private palette?: CommandPalette;
  private paletteOverlay?: OverlayHandle;
  private help?: ShortcutHelp;
  private helpOverlay?: OverlayHandle;
  private overlayReturnFocus?: Component;
  private apiId: Field;
  private apiHash: Field;
  private started = false;
  private password: Field;
  private composer: Editor;

  constructor(private tui: TUI, private python: string, private dataDir: string, private root: string, private exit: () => Promise<void>, private readonly debugLog?: DebugLog) {
    const changed = () => this.redraw();
    const disabled = () => this.busy;
    this.apiId = new Field("API ID", false, changed, disabled);
    this.apiHash = new Field("API hash (hidden)", true, changed, disabled);
    this.password = new Field("Telegram two-step password", true, changed, disabled);
    for (const field of [this.apiId, this.apiHash, this.password]) field.onSubmit = () => { void this.submit(); };
    this.composer = new Editor(getEditorTheme());
    this.composer.placeholder = () => this.showContextHints ? "Message · Enter sends · Shift+Enter adds a line" : "Message";
    this.composer.onChange = text => {
      if (this.settingComposer) return;
      this.lastInput = Date.now();
      if (this.selectedId !== null) this.catchUp(this.selectedId);
      const thread = this.currentThread();
      if (thread) { thread.draft = text; this.schedulePersist(); }
      this.userActivity();
      this.composerActivity(text);
      if (this.stage === "chats") this.debugLog?.record("model_edit", this.debugState());
      this.redraw(false);
    };
    this.composer.onSubmit = text => {
      const thread = this.currentThread();
      if (thread) thread.draft = text;
      this.setComposer(text);
      void this.send(text);
    };
    this.telegram = this.newConnection();
    this.tui.addInputListener(data => {
      if (!this.debugLog) return this.intercept(data);
      const before = this.debugState();
      const result = this.intercept(data);
      this.debugLog.record("input_route", { consumed: !!result?.consume, before, after: this.debugState() });
      return result;
    });
  }

  /** Local routing state only: not proof of host focus, visibility, or mounted geometry. */
  debugState(): DebugState {
    const focused = this.tui.getFocused();
    const thread = this.currentThread();
    const writable = this.selectedDialog()?.writable;
    const chats = this.stage === "chats";
    const role = focused === null ? "none"
      : focused === this.composer ? "composer"
      : focused === this.palette ? "palette"
      : focused === this.help ? "help"
      : focused === this.photoViewer ? "gallery"
      : focused === this.forwardPicker ? "forward"
      : focused === this.apiId ? "auth-api-id"
      : focused === this.apiHash ? "auth-api-hash"
      : focused === this.password ? "auth-password"
      : focused === this ? chats ? "messages" : "auth"
      : "unknown";
    return {
      stage: this.stage, busy: this.busy, quitting: this.quitting, online: this.online,
      focusRole: role, hasFocus: focused !== null, canHandleInput: typeof focused?.handleInput === "function",
      messagesFocused: this.focused, composerFocused: this.composer.focused,
      messagesAvailable: chats && this.selectedId !== null,
      composerAvailable: chats && this.selectedId !== null && writable !== false,
      composerSubmitDisabled: this.composer.disableSubmit,
      ...(chats ? { composerLength: this.composer.getText().length } : {}),
      selectedChat: this.selectedId !== null, writable: writable === true,
      palette: !!this.palette, paletteHidden: this.paletteOverlay?.isHidden() ?? false,
      help: !!this.help, helpHidden: this.helpOverlay?.isHidden() ?? false,
      gallery: !!this.photoViewer, galleryHidden: this.photoOverlay?.isHidden() ?? false,
      forward: !!this.forwardPicker, forwardHidden: this.forwardOverlay?.isHidden() ?? false,
      deleteConfirm: this.deleteConfirm !== null, logoutConfirm: this.stage === "logout",
      abandonConfirm: this.abandonConfirm !== null, messageSelected: this.actionMessage !== null,
      threadAvailable: !!thread, threadLoaded: !!thread?.loaded, threadLoading: !!thread?.loading,
      replying: thread?.replyTo != null, editing: !!thread?.editing, sending: !!thread?.sending,
      savingEdit: !!thread && this.savingEdits.has(thread), pendingSend: !!thread?.pendingSend,
      detached: this.selectedId !== null && this.detached.has(this.selectedId),
      refreshing: this.refreshing, loadingMoreChats: this.loadingMoreChats,
      idleMs: this.lastInput ? Math.max(0, Date.now() - this.lastInput) : null,
    };
  }

  private newConnection(): Telegram {
    const connection = new Telegram(this.python, this.dataDir, this.root, this.cooldowns);
    connection.onUpdate = update => { if (this.telegram === connection && !this.quitting) this.receive(update); };
    connection.onStatus = connected => {
      if (this.telegram !== connection || this.quitting) return;
      const wasOnline = this.online;
      this.online = connected;
      if (!connected) this.clearTransient();
      if (connected && this.stage === "chats" && !this.busy) void this.refresh();
      if (connected && this.stage === "chats" && this.selectedId !== null) this.activityCall("select_peer", [this.selectedId]);
      if (connected && !wasOnline && this.stage === "chats") {
        for (const [id, thread] of this.threads) if (thread.pendingSend) this.reconcileSend(id, thread, thread.pendingSend);
      }
      this.redraw();
    };
    connection.onFailure = message => {
      if (this.telegram !== connection || this.quitting) return;
      this.online = false; this.clearTransient(); this.clearQr(); this.password.setValue("");
      this.authorizationVersion++; this.authorizationState = "closed"; this.bootstrap = undefined;
      this.authOperation = undefined; this.busy = false; this.stage = "closed"; this.fail(message);
    };
    return connection;
  }
  private thread(id: number): ChatState {
    let thread = this.threads.get(id);
    if (!thread) { thread = new ChatState(); this.threads.set(id, thread); }
    return thread;
  }
  private currentThread(): ChatState | undefined { return this.selectedId === null ? undefined : this.threads.get(this.selectedId); }
  private selectedDialog(): Dialog | undefined { return this.dialogs.find(dialog => dialog.id === this.selectedId); }
  private activityCall(method: string, args: unknown[] = []): void {
    const connection = this.telegram, generation = this.generation, epoch = this.activityEpoch;
    this.activityChain = this.activityChain.then(async () => {
      if (this.telegram === connection && generation === this.generation && epoch === this.activityEpoch && !this.quitting)
        await connection.call(method, args);
    }).catch(() => {}); // Best-effort transient signals must not flood the notice row.
  }
  private userActivity(): void {
    if (this.stage !== "chats" || !this.online || this.quitting || Date.now() - this.activityAt < 5_000) return;
    this.activityAt = Date.now();
    this.activityCall("activity");
  }
  private stopTyping(): void {
    clearTimeout(this.typingTimer);
    if (this.typingId !== null) this.activityCall("typing", [this.typingId, false]);
    this.typingId = null; this.typingAt = -Infinity;
  }
  private composerActivity(text: string): void {
    if (!text.trim() || this.stage !== "chats" || !this.online || this.selectedId === null
      || this.selectedDialog()?.writable !== true || this.currentThread()?.sending || this.busy) {
      this.stopTyping(); return;
    }
    const id = this.selectedId;
    if (this.typingId !== id) this.stopTyping();
    this.typingId = id;
    if (Date.now() - this.typingAt >= 4_000) {
      this.typingAt = Date.now(); this.activityCall("typing", [id, true]);
    }
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 5_000);
  }
  private clearTransient(): void {
    this.activityEpoch++;
    this.stopTyping(); clearTimeout(this.transientTimer); this.transientActions.clear(); this.activityAt = -Infinity;
  }
  private expireTransient(): void {
    clearTimeout(this.transientTimer);
    let next = Infinity;
    for (const [chat, actions] of this.transientActions) {
      for (const [sender, action] of actions) {
        if (action.until <= Date.now()) actions.delete(sender); else next = Math.min(next, action.until);
      }
      if (!actions.size) this.transientActions.delete(chat);
    }
    for (const dialog of this.dialogs) {
      if (dialog.presence?.state === "online" && dialog.presence.expires) {
        const until = dialog.presence.expires * 1000;
        if (until <= Date.now()) dialog.presence = { state: "unknown" };
        else next = Math.min(next, until);
      }
    }
    // Keep the absolute expiry; JS timers overflow delays above a signed int32.
    if (Number.isFinite(next)) this.transientTimer = setTimeout(() => this.redraw(false), Math.min(2_147_483_647, Math.max(1, next - Date.now())));
  }
  private incomingActions(): string {
    return [...(this.selectedId === null ? [] : this.transientActions.get(this.selectedId)?.values() ?? [])]
      .filter(item => item.until > Date.now()).map(item => `${item.sender} · ${item.action}`).join(" · ");
  }
  private setComposer(text: string, reset = false): void {
    this.stopTyping();
    if (!reset && this.composer.textEquals(text)) return;
    this.settingComposer = true; this.composer.setText(text); this.settingComposer = false;
  }
  private fail(error: unknown): void {
    this.error = true; this.status = error instanceof Error ? error.message : String(error); this.redraw();
  }
  private redraw(body = true): void {
    this.expireTransient();
    const thread = this.currentThread();
    this.composer.disableSubmit = this.busy || this.selectedId === null || this.selectedDialog()?.writable === false || !!thread?.sending || (!!thread?.pendingSend && !thread.editing);
    if (this.stage === "chats" && this.composer.focused && this.selectedDialog()?.writable === false) this.tui.setFocus(this);
    this.palette?.setItems(this.paletteItems());
    this.palette?.setLoading(this.loadingMoreChats);
    this.forwardPicker?.setLoading(this.loadingMoreChats);
    if (body) this.body.invalidate();
    this.debugLog?.record("app_state", this.debugState());
    this.tui.requestRender();
  }
  private focusDefault(): void {
    if (this.quitting) return;
    if (this.help) this.tui.setFocus(this.help);
    else if (this.palette) this.tui.setFocus(this.palette);
    else if (this.photoViewer) this.tui.setFocus(this.photoViewer);
    else if (this.forwardPicker) this.tui.setFocus(this.forwardPicker);
    else this.tui.setFocus(this.stage === "chats" && this.selectedId !== null && this.selectedDialog()?.writable !== false ? this.composer : this.fields()[0] ?? this);
  }
  private fields(): Component[] {
    switch (this.stage) {
      case "credentials": return [this.apiId, this.apiHash];
      case "qr": case "closed": return [this];
      case "password": return [this.password];
      case "chats": return this.selectedId !== null && this.selectedDialog()?.writable !== false ? [this, this.composer] : [this];
      case "logout": return [this];
    }
  }
  private async perform(status: string, action: (operation: object) => Promise<void>): Promise<void> {
    if (this.busy || this.quitting) return;
    const operation = {};
    this.authOperation = operation;
    this.busy = true; this.error = false; this.status = status; this.redraw();
    try { await action(operation); }
    catch (error) { if (this.authOperation === operation && !this.quitting) this.fail(error); }
    finally {
      if (this.authOperation === operation) {
        this.authOperation = undefined; this.busy = !!this.bootstrap; this.redraw(); this.focusDefault();
      }
    }
  }
  async start(): Promise<void> {
    if (this.started || this.quitting) return;
    this.started = true;
    await this.perform("Checking saved authorization…", () => this.authorizationCall("connect"));
  }
  private clearQr(): void {
    this.qrNode = undefined;
    this.body.invalidate();
  }
  private async authorizationCall(method: string, args: unknown[] = []): Promise<void> {
    const connection = this.telegram, version = this.authorizationVersion;
    let authorization: Authorization;
    try { authorization = await connection.call<Authorization>(method, args); }
    catch (error) {
      if (connection !== this.telegram || this.quitting) return;
      if (version !== this.authorizationVersion && this.authorizationState === "ready") {
        await this.bootstrap?.promise; return;
      }
      throw error;
    }
    // Events are authoritative: an RPC snapshot must not replace a newer QR/password/ready event.
    if (connection !== this.telegram || this.quitting) return;
    if (version === this.authorizationVersion) this.authorize(authorization);
    await this.bootstrap?.promise;
  }
  private authorize(authorization: Authorization): void {
    const previous = this.authorizationState;
    this.authorizationVersion++;
    this.authorizationState = authorization.state;
    this.authorizationHint = authorization.hint ?? "";
    this.clearQr();
    if (authorization.state !== "password" || previous !== "password") this.password.setValue("");
    if (authorization.state === "ready") {
      if (this.stage !== "chats" && this.stage !== "logout") {
        this.stage = "qr"; this.status = "Opening your chats…";
        void this.connected();
      }
    } else {
      this.bootstrap = undefined;
      if (previous === "ready" || (this.account && authorization.state !== "closed")) this.clearAccount();
      this.stage = authorization.state;
      this.error = false;
      this.status = authorization.state === "credentials" ? "API credentials stay in your private data directory."
        : authorization.state === "qr" ? "Waiting for you to scan and confirm…"
        : authorization.state === "password" ? "QR confirmed. Enter your two-step verification password."
        : "The local Telegram connection is closed. Reconnect to continue.";
      if (authorization.state === "qr" && authorization.qr) {
        const photo = authorization.qr;
        if (photo.mime !== "image/png" || photo.width !== photo.height || photo.width <= 0) {
          this.fail("Telegram returned an invalid QR image. Retry QR login below.");
        } else {
          this.qrNode = base64ImageNode(photo.data, photo.mime, {
            alt: "Telegram login QR code. Scan with Telegram on your signed-in device.",
            aria: "Telegram login QR code",
            max: { w: "36ch", h: "18lines" }, grow: 0, shrink: 1,
            // Do not open the host's independent image viewer with a sensitive login token.
            actions: { click: "qr-code" },
          }, `login-qr-${this.authorizationVersion}`);
        }
      }
      this.busy = !!this.authOperation;
    }
    this.redraw(); this.focusDefault();
  }
  private connected(): Promise<void> {
    if (this.bootstrap) return this.bootstrap.promise;
    if (this.authorizationState !== "ready" || this.quitting) return Promise.resolve();
    const connection = this.telegram, generation = this.generation;
    const existingThreads = new Set(this.threads.keys());
    this.bootstrapSendStates.clear();
    const bootstrap = { connection, generation, promise: Promise.resolve() };
    this.bootstrap = bootstrap; this.busy = true; this.redraw();
    const current = () => this.bootstrap === bootstrap && connection === this.telegram
      && generation === this.generation && this.authorizationState === "ready" && !this.quitting;
    bootstrap.promise = (async () => {
      try {
        const [account, page, state] = await Promise.all([
          connection.call<string>("me"), connection.call<DialogPage>("dialogs"), connection.call<ClientState>("load_state"),
        ]);
        if (!current()) return;
        this.account = account; this.dialogs = page.dialogs; this.dialogCursor = page.cursor;
        for (const [key, draft] of Object.entries(state.drafts)) {
          const id = Number(key);
          if (Number.isSafeInteger(id) && id !== 0 && !existingThreads.has(id)) this.thread(id).draft = draft;
        }
        for (const thread of this.threads.values()) thread.pendingSend = null;
        for (const [key, pending] of Object.entries(state.pending_sends)) {
          const id = Number(key);
          if (Number.isSafeInteger(id) && id !== 0) {
            const thread = this.thread(id);
            thread.pendingSend = pending;
            if (pending.text && thread.draft === pending.text) thread.replyTo = pending.reply_to;
          }
        }
        for (const update of this.bootstrapSendStates.values()) this.receive(update);
        this.bootstrapSendStates.clear();
        const selected = this.selectedId ?? state.selected_id;
        if (selected !== null && !this.dialogs.some(dialog => dialog.id === selected)) {
          const dialog = await connection.call<Dialog | null>("dialog", [selected]);
          if (!current()) return;
          if (dialog) this.dialogs.push(dialog);
        }
        this.stage = "chats"; this.error = false; this.status = "";
        if (selected !== null && this.dialogs.some(dialog => dialog.id === selected)) await this.selectChat(selected);
        if (!current()) return;
        if (this.selectedId !== null) this.activityCall("select_peer", [this.selectedId]);
        for (const [id, thread] of this.threads) if (thread.pendingSend) this.reconcileSend(id, thread, thread.pendingSend);
      } catch (error) { if (current()) this.fail(error); }
      finally {
        if (this.bootstrap === bootstrap) {
          this.bootstrap = undefined; this.busy = !!this.authOperation; this.redraw(); this.focusDefault();
        }
      }
    })();
    return bootstrap.promise;
  }
  private async submit(): Promise<void> {
    if (this.stage === "chats") return;
    if (this.stage === "qr" && this.qrNode && !this.error && this.authorizationState !== "ready") return;
    if (this.stage === "closed") { await this.reconnect(); return; }
    await this.perform(this.stage === "qr" ? "Retrying QR login…" : "Connecting to Telegram…", async operation => {
      switch (this.stage) {
        case "credentials": {
          const id = Number(this.apiId.getValue()), hash = this.apiHash.getValue().trim();
          if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-f0-9]{32}$/i.test(hash))
            throw new Error("Enter a valid API ID and 32-character API hash from my.telegram.org/apps.");
          this.apiHash.setValue("");
          await this.authorizationCall("connect", [id, hash]); return;
        }
        case "qr":
          this.clearQr();
          await this.authorizationCall(this.authorizationState === "ready" ? "auth_state" : "request_qr"); return;
        case "password": {
          const password = this.password.getValue(); this.password.setValue("");
          if (!password) throw new Error("Enter your two-step verification password.");
          await this.authorizationCall("sign_in_password", [password]); return;
        }
        case "logout": {
          clearTimeout(this.persistTimer); await this.persistChain;
          if (this.authOperation !== operation || this.quitting) return;
          const connection = this.telegram;
          await connection.call("logout");
          if (this.authOperation !== operation || this.telegram !== connection || this.quitting) return;
          this.clearAccount();
          const replacement = this.newConnection(); this.telegram = replacement;
          await connection.close();
          if (this.authOperation !== operation || this.telegram !== replacement || this.quitting) return;
          this.authorizationVersion++; this.authorizationState = "closed"; this.stage = "closed";
          await this.authorizationCall("connect"); return;
        }
      }
    });
  }
  private async changeCredentials(): Promise<void> {
    await this.perform("Closing authorization…", async operation => {
      this.authorizationVersion++; this.clearQr(); this.password.setValue(""); this.apiHash.setValue("");
      await this.persist();
      if (this.authOperation !== operation || this.quitting) return;
      const connection = this.telegram;
      const replacement = this.newConnection();
      this.telegram = replacement; // Old callbacks become stale before its close can emit authorization.
      await connection.close();
      if (this.authOperation !== operation || this.telegram !== replacement || this.quitting) return;
      this.clearAccount(); this.bootstrap = undefined; this.authorizationState = "credentials";
      this.authorizationHint = ""; this.stage = "credentials"; this.error = false;
      this.status = "Enter your application's API credentials.";
    });
  }
  private clearAccount(): void {
    this.clearTransient();
    for (const request of this.reconcilingSends.values()) clearTimeout(request.timer);
    this.reconcilingSends.clear(); this.savingEdits.clear();
    this.generation++; clearTimeout(this.persistTimer); this.closeHelp(); this.closePalette(); this.closePhoto(); this.closeForwardPicker();
    clearTimeout(this.readerTimer);
    this.dialogCursor = undefined; this.moreChatsRequest = undefined; this.moreChatsToken = undefined; this.fillingDialogs = undefined; this.loadingMoreChats = false; this.searchingDialogs = false;
    this.messageView.clear();
    this.receipts.clear();
    this.cooldowns.clear(); this.readers.clear(); this.resolvedAlbums.clear();
    this.navigation.clear();
    this.avatars.clear(); this.previews.clear(); this.dialogRequests.clear();
    this.participantCounts.clear(); this.infoRequests.clear();
    this.dirtyDialogs.clear(); this.metadataVersions.clear(); this.peerNames.clear(); this.refreshingDirty = false;
    this.threads.clear(); this.scrolls.clear(); this.detached.clear(); this.photoNodes.clear();
    this.photoLoading.clear();
    this.bootstrapSendStates.clear(); this.abandonConfirm = null;
    this.dialogs = []; this.selectedId = null; this.account = ""; this.online = false;
    this.actionMessage = this.deleteConfirm = null; this.setComposer("");
    this.clearQr(); this.password.setValue("");
  }
  private schedulePersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { void this.persist(); }, 250);
  }
  private persist(required = false): Promise<void> {
    clearTimeout(this.persistTimer);
    if (this.stage !== "chats" && this.stage !== "logout") return this.persistChain;
    const drafts: Record<string, string> = {};
    const pending_sends: ClientState["pending_sends"] = {};
    for (const [id, thread] of this.threads) {
      const text = thread.editing?.draft ?? thread.draft;
      if (text) drafts[String(id)] = text;
      if (thread.pendingSend) pending_sends[String(id)] = thread.pendingSend;
    }
    const state: ClientState = { drafts, selected_id: this.selectedId, pending_sends };
    const connection = this.telegram;
    const saved = this.persistChain.then(async () => {
      if (this.telegram === connection) await connection.call("save_state", [state]);
    });
    this.persistChain = saved.catch(error => { if (!this.quitting && !required) this.fail(error); });
    return required ? saved : this.persistChain;
  }

  private async selectChat(id: number, fromHistory = false): Promise<void> {
    if (this.stage !== "chats" || !Number.isSafeInteger(id) || !this.dialogs.some(dialog => dialog.id === id) || this.quitting) return;
    if (!fromHistory) this.navigation.visit(id);
    const changingChat = this.selectedId !== id;
    if (changingChat) { this.stopTyping(); this.activityCall("select_peer", [id]); }
    if (changingChat) { this.avatars.cancelQueued(); this.previews.cancelQueued(); this.closePhoto(); }
    this.selectedId = id; this.actionMessage = this.deleteConfirm = null;
    const thread = this.thread(id);
    this.setComposer(thread.draft, changingChat); this.schedulePersist(); this.redraw(); this.focusDefault();
    this.queuePreviews(id);
    for (const message of thread.messages) this.queueAvatar(message.sender_id);
    if (this.dirtyDialogs.has(id)) void this.refreshDialog(id);
    void this.loadChatInfo(id);
    if (thread.loaded) this.catchUp(id);
    else if (!thread.loading) await this.loadHistory(id);
  }
  private async loadChatInfo(id: number, refresh = false): Promise<void> {
    if (this.quitting || this.infoRequests.has(id) || (!refresh && this.participantCounts.has(id))) return;
    const generation = this.generation;
    const version = this.metadataVersions.get(id) ?? 0;
    const request = {};
    let invalidated = false;
    this.infoRequests.set(id, request);
    try {
      const info = await this.telegram.call<{ participants_count: number | null }>("chat_info", [id, refresh]);
      if (generation === this.generation) {
        invalidated = version !== (this.metadataVersions.get(id) ?? 0);
        if (!invalidated) {
          this.participantCounts.set(id, info.participants_count);
          this.loadReaders();
        }
      }
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally {
      if (this.infoRequests.get(id) === request) this.infoRequests.delete(id);
      this.redraw(false);
      if (invalidated && generation === this.generation && this.selectedId === id && !this.cooldowns.remaining("chat_info", id)) void this.loadChatInfo(id);
    }
  }
  private loadReaders(): void {
    clearTimeout(this.readerTimer);
    const message = this.chosenMessage();
    if (!message?.outgoing || !message.read || this.selectedDialog()?.kind !== "group" || !this.focused || this.busy || this.quitting
      || this.palette || this.help || this.photoViewer || this.forwardPicker) return;
    if (this.cooldowns.remaining("message_readers", message.chat_id)) return;
    const count = this.participantCounts.get(message.chat_id);
    if (count === undefined || count === null || count <= 0) return;
    // Selection is not an instruction to query every row traversed by a held arrow.
    this.readerTimer = setTimeout(() => {
      if (this.selectedId !== message.chat_id || this.chosenMessage()?.id !== message.id || !this.focused || this.quitting || this.busy || this.stage !== "chats"
        || this.palette || this.help || this.photoViewer || this.forwardPicker) return;
      void this.readers.request(message.chat_id, message.id);
    }, 300);
  }
  private async refreshDirtyDialogs(): Promise<void> {
    if (this.refreshingDirty) return;
    this.refreshingDirty = true;
    const generation = this.generation;
    try {
      for (const id of this.dirtyDialogs) {
        if (!this.palette || this.quitting || generation !== this.generation || this.cooldowns.remaining("dialog", id)) break;
        await this.refreshDialog(id);
      }
    } finally { if (generation === this.generation) this.refreshingDirty = false; }
  }
  private async loadHistory(id: number, older = false, refresh = false): Promise<void> {
    const thread = this.thread(id);
    if (thread.loading || (older && !thread.more)) return;
    if (older) this.detached.add(id);
    const generation = this.generation;
    const started = thread.revision;
    const firstLoad = !thread.loaded;
    const before = older ? thread.messages[0]?.id ?? 0 : 0;
    const limit = PAGE_SIZE;
    thread.loading = true; this.redraw();
    try {
      const page = await this.telegram.call<ChatMessage[]>("history", [id, before, limit]);
      if (generation !== this.generation || this.threads.get(id) !== thread) return;
      thread.applyPage(page, started, refresh);
      if (this.selectedId === id) for (const message of page) this.queueAvatar(message.sender_id);
      this.queuePreviews(id);
      if (firstLoad || older) thread.more = page.length === limit;
      if (firstLoad && this.selectedId === id) {
        this.scrolls.set(id, { by: "end", n: (this.scrolls.get(id)?.n ?? 0) + 1 });
        thread.acknowledgeNewMessages();
        void this.markRead(id);
      }
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { thread.loading = false; this.redraw(); }
  }
  private receive(update: TelegramUpdate): void {
    if (update.kind === "authorization") { this.authorize(update.authorization); return; }
    if (update.kind === "send_state") {
      if (this.bootstrap) this.bootstrapSendStates.set(update.token, update);
      const thread = this.threads.get(update.chat_id), pending = thread?.pendingSend;
      if (!thread || !pending || pending.token !== update.token) return;
      if (update.status === "sent" || update.status === "abandoned") {
        const request = this.reconcilingSends.get(pending.token);
        if (request?.timer) { clearTimeout(request.timer); this.reconcilingSends.delete(pending.token); }
      }
      if (update.status === "sent") {
        if (update.message) this.sent(update.chat_id, thread, pending, update.message);
        else this.confirmed(update.chat_id, thread, pending); // Durable completion, not a message snapshot to replay.
      } else if (update.status === "abandoned") {
        thread.restorePendingSend(); thread.pendingSend = null;
        if (this.currentThread() === thread) this.setComposer(thread.draft);
        this.abandonConfirm = null; this.error = false;
        this.status = pending.text ? update.admitted === false
          ? "Nothing was submitted; text kept as draft."
          : "Tracking stopped; text kept as draft. This does not cancel Telegram delivery."
          : "Tracking stopped; composer draft unchanged. This does not cancel Telegram delivery.";
        if (update.error) this.fail(update.error);
      } else {
        thread.pendingSend = { ...pending, status: update.status, ...(update.message_id !== undefined ? { message_id: update.message_id } : {}), error: update.error };
        if (update.status === "failed") {
          const failed = thread.getMessage(thread.retryDisplayId ?? pending.message_id ?? update.message_id ?? 0);
          if (failed) {
            thread.retryDisplayId ??= failed.id;
            thread.receive({ ...failed, sending_state: "failed" });
          }
        }
        if (update.message) this.receive({ kind: "message", chat_id: update.chat_id, message: update.message });
        if (update.status !== "queued" && update.error) this.fail(update.error);
      }
      this.schedulePersist(); this.redraw(); return;
    }
    if (this.authorizationState !== "ready") return;
    if (update.kind === "presence") {
      this.dialogs = this.dialogs.map(dialog => dialog.id === update.chat_id ? { ...dialog, presence: update.presence } : dialog);
      this.expireTransient(); this.redraw(false); return;
    }
    if (update.kind === "typing") {
      if (!this.online || this.stage !== "chats") return;
      let actions = this.transientActions.get(update.chat_id);
      if (!actions) { actions = new Map(); this.transientActions.set(update.chat_id, actions); }
      const labels: Record<string, string> = {
        chatActionTyping: "typing…", chatActionRecordingVoiceNote: "recording voice…",
        chatActionUploadingVoiceNote: "sending voice…", chatActionRecordingVideo: "recording video…",
        chatActionUploadingVideo: "sending video…", chatActionUploadingPhoto: "sending photo…",
        chatActionUploadingDocument: "sending file…", chatActionChoosingSticker: "choosing sticker…",
        chatActionRecordingVideoNote: "recording video message…", chatActionUploadingVideoNote: "sending video message…",
        chatActionChoosingLocation: "sharing location…", chatActionChoosingContact: "choosing contact…",
        chatActionStartPlayingGame: "playing game…", chatActionWatchingAnimations: "watching animations…",
      };
      if (update.action === "chatActionCancel" || update.expires_in <= 0) actions.delete(update.sender_id);
      else actions.set(update.sender_id, { sender: update.sender, action: labels[update.action] ?? "active…", until: Date.now() + Math.min(Math.max(update.expires_in, 0), 60) * 1000 });
      this.expireTransient(); this.redraw(false); return;
    }
    if (update.kind === "dialog_changed") {
      const id = update.chat_id;
      this.metadataVersions.set(id, (this.metadataVersions.get(id) ?? 0) + 1);
      const known = this.dialogs.some(dialog => dialog.id === id);
      if (update.title !== undefined) {
        this.dialogs = this.dialogs.map(dialog => dialog.id === id ? { ...dialog, title: update.title! } : dialog);
        this.dirtyDialogs.delete(id);
        this.peerNames.set(id, update.title);
      } else if (known && (!update.participants_changed || update.avatar_changed)) this.dirtyDialogs.add(id);
      if (update.permissions_changed && (known || id < 0)) this.dirtyDialogs.add(id);
      if (update.participants_changed || update.permissions_changed) {
        this.participantCounts.delete(id); this.readers.invalidateChat(id);
        if (id === this.selectedId) void this.loadChatInfo(id);
      }
      if (update.avatar_changed) {
        this.avatars.invalidate(String(id));
        if (update.title !== undefined && this.currentThread()?.messages.some(message => message.sender_id === id)) this.queueAvatar(id);
      }
      if (id === this.selectedId && this.dirtyDialogs.has(id)) void this.refreshDialog(id);
      if (this.palette) void this.refreshDirtyDialogs();
      this.forwardPicker?.setDialogs(this.dialogs);
      this.redraw();
      return;
    }
    if (update.kind === "refresh") {
      this.resolvedAlbums.clear();
      if (this.stage === "chats") void this.refresh();
      return;
    }
    if (update.kind === "delete" && update.ids) {
      const ids = new Set(update.ids);
      const affectsGallery = this.photoGroup?.chat_id === update.chat_id && this.albumMembers(this.photoGroup).some(message => ids.has(message.id));
      for (const [id, thread] of this.threads) {
        if (id === update.chat_id) {
          const affected = thread.messages.some(message => ids.has(message.id)) || this.dialogs.some(dialog => dialog.id === id && dialog.last_message_id !== null && ids.has(dialog.last_message_id));
          for (const message of thread.messages) if (ids.has(message.id)) this.invalidatePhoto(message);
          thread.remove(update.ids);
          this.readers.invalidateChat(id);
          if (affected) void this.refreshDialog(id);
        }
      }
      if (this.currentThread()) this.setComposer(this.currentThread()!.draft);
      if (affectsGallery) {
        this.refreshPhotoViewer();
        if (this.photoGroup) void this.viewPhoto(this.photoGroup, true);
      }
      this.redraw(); return;
    }
    if (update.kind === "read" && update.max_id !== undefined) {
      if (update.outbox) { this.thread(update.chat_id).markRead(update.max_id); this.loadReaders(); }
      else {
        this.dialogs = this.dialogs.map(dialog => dialog.id === update.chat_id && (dialog.last_message_id ?? 0) <= update.max_id ? { ...dialog, unread_count: 0 } : dialog);
        if (this.dialogs.some(dialog => dialog.id === update.chat_id && (dialog.last_message_id ?? 0) > update.max_id)) void this.refreshDialog(update.chat_id);
      }
      this.redraw(); return;
    }
    if (update.kind !== "message" || !update.message) return;
    const message = update.message;
    if (message.sender_id !== null) this.transientActions.get(message.chat_id)?.delete(message.sender_id);
    const thread = this.thread(update.chat_id);
    const previous = thread.getMessage(message.id);
    if (previous && (previous.media_id !== message.media_id || previous.photo && !message.photo)) {
      this.invalidatePhoto(previous);
    }
    const isNew = thread.receive(message);
    this.refreshPhotoViewer();
    if (this.selectedId === message.chat_id) this.queueAvatar(message.sender_id);
    const dialog = this.dialogs.find(item => item.id === update.chat_id);
    if (dialog) {
      const latest = message.id >= (dialog.last_message_id ?? 0);
      const updated = {
        ...dialog,
        ...(latest ? { preview: message.text, last_message_id: message.id } : {}),
        unread_count: dialog.unread_count + (isNew && !message.outgoing && !message.edited && !message.read ? 1 : 0),
      };
      if (isNew && latest) this.dialogs = [updated, ...this.dialogs.filter(item => item.id !== updated.id)];
      else this.dialogs = this.dialogs.map(item => item.id === updated.id ? updated : item);
    } else void this.refreshDialog(update.chat_id);
    if (isNew && !message.outgoing) this.catchUp(update.chat_id);
    this.queuePreviews(update.chat_id);
    // TSP does not report the actual viewport. Never force a user out of history on an incoming event.
    if (this.photoGroup?.chat_id === message.chat_id && (this.photoGroup.id === message.id || (message.grouped_id !== null && this.photoGroup.grouped_id === message.grouped_id))) void this.viewPhoto(message, true);
    this.forwardPicker?.setDialogs(this.dialogs); this.redraw();
  }
  private invalidatePhoto(message: ChatMessage): void {
    const key = photoKey(message);
    this.previews.invalidate(key);
    this.photoNodes.delete(key);
    this.refreshPhotoViewer();
  }
  private refreshPhotoViewer(): void {
    if (!this.photoViewer || !this.photoGroup) return;
    const members = this.albumMembers(this.photoGroup).filter(message => message.photo);
    if (!members.length) { this.closePhoto(); return; }
    const images = members.map(message => this.photoNodes.get(photoKey(message)) ?? {
      k: "spinner", key: `full-photo-${message.chat_id}:${message.id}`, p: { label: "Loading photo…" },
    } satisfies NativeNode);
    this.photoViewer.setContent(images, members.map(message => message.text === "[Photo]" ? "" : message.text));
  }
  private queueAvatar(senderId: number | null): void {
    if (senderId === null || this.quitting || this.cooldowns.remaining("avatar", senderId)) return;
    this.avatars.request(String(senderId), async () => {
      const photo = await this.telegram.call<Photo | null>("avatar", [senderId]);
      return photo ? base64ImageNode(photo.data, photo.mime, {
        alt: "Sender avatar", max: { w: "4ch", h: "2lines" },
      }, `avatar-${senderId}`) : null;
    });
  }
  private queuePreviews(id: number): void {
    if (this.selectedId !== id || this.quitting || this.cooldowns.remaining("photo", id)) return;
    const generation = this.generation;
    const connection = this.telegram;
    for (const group of this.thread(id).groups) {
      const photos = group.filter(message => message.photo);
      for (const message of photos.slice(0, 4)) {
        const key = photoKey(message);
        this.previews.request(key, async currentEntry => {
          try {
            const photo = await connection.call<Photo | null>("photo", [id, message.id, true]);
            const current = this.threads.get(id)?.getMessage(message.id);
            if (generation !== this.generation || connection !== this.telegram || !current?.photo || photoKey(current) !== key) return null;
            return photo ? base64ImageNode(photo.data, photo.mime, {
              alt: "Photo preview", title: "Open full photo",
              max: { w: "32ch", h: "10lines" },
              actions: { click: `photo:${message.id}` },
            }, `preview-${key}`) : null;
          } catch (error) {
            if (!(error instanceof TelegramRequestError) || error.code !== "MEDIA_CHANGED") throw error;
            if (generation === this.generation && connection === this.telegram && currentEntry() && !this.quitting) {
              this.invalidatePhoto(message);
              this.queuePreviews(id);
              const current = this.threads.get(id)?.getMessage(message.id);
              if (current?.photo && this.photoViewer && this.photoGroup?.chat_id === id
                && (this.photoGroup.id === current.id || current.grouped_id !== null && this.photoGroup.grouped_id === current.grouped_id))
                void this.viewPhoto(current, true);
            }
            return null;
          }
        });
      }
    }
  }
  private async refreshDialog(id: number): Promise<void> {
    if (this.dialogRequests.has(id) || this.stage !== "chats" || this.quitting) return;
    const generation = this.generation;
    const request = {};
    this.dialogRequests.set(id, request);
    const before = this.dialogs.find(dialog => dialog.id === id);
    const version = this.metadataVersions.get(id) ?? 0;
    try {
      let dialog = await this.telegram.call<Dialog | null>("dialog", [id]);
      if (generation !== this.generation) return;
      if (!dialog) {
        if (version !== (this.metadataVersions.get(id) ?? 0)) return;
        this.dirtyDialogs.delete(id);
        this.dialogs = this.dialogs.filter(item => item.id !== id);
        if (this.selectedId === id) {
          this.selectedId = null; this.actionMessage = this.deleteConfirm = null;
          this.activityCall("select_peer", [null]);
          this.closePhoto(); this.setComposer(""); this.schedulePersist(); this.focusDefault();
        }
        this.forwardPicker?.setDialogs(this.dialogs); this.redraw();
        return;
      }
      if (version !== (this.metadataVersions.get(id) ?? 0) && this.dirtyDialogs.has(id)) return;
      const live = this.dialogs.find(item => item.id === id);
      if (live && live !== before && live.last_message_id === dialog.last_message_id) {
        dialog = { ...dialog, preview: live.preview, unread_count: live.unread_count,
          ...(version !== (this.metadataVersions.get(id) ?? 0) ? { title: live.title, writable: live.writable, kind: live.kind } : {}) };
      }
      const latest = this.threads.get(id)?.messages.at(-1);
      if (latest && latest.id > (dialog.last_message_id ?? 0)) {
        const unread = this.threads.get(id)!.messages.filter(message => message.id > (dialog!.last_message_id ?? 0) && !message.outgoing && !message.read && !message.edited).length;
        dialog = { ...dialog, preview: latest.text, last_message_id: latest.id, unread_count: dialog.unread_count + unread };
      }
      const index = this.dialogs.findIndex(item => item.id === id);
      if (index >= 0) this.dialogs[index] = dialog; else this.dialogs.unshift(dialog);
      this.dirtyDialogs.delete(id);
      if (this.currentThread()?.messages.some(message => message.sender_id === id)) this.queueAvatar(id);
      this.forwardPicker?.setDialogs(this.dialogs);
      this.redraw();
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally {
      if (this.dialogRequests.get(id) === request) {
        this.dialogRequests.delete(id);
        if (generation === this.generation && this.selectedId === id && this.dirtyDialogs.has(id)
          && version !== (this.metadataVersions.get(id) ?? 0) && !this.cooldowns.remaining("dialog", id)) void this.refreshDialog(id);
      }
    }
  }
  private async refreshDialogs(): Promise<void> {
    if (this.refreshing || this.stage !== "chats" || this.quitting) return;
    this.refreshing = true;
    const generation = this.generation;
    const before = new Map(this.dialogs.map(dialog => [dialog.id, dialog]));
    const versions = new Map(this.metadataVersions);
    try {
      const page = await this.telegram.call<DialogPage>("dialogs");
      if (generation !== this.generation || this.stage !== "chats") return;
      const current = new Map(this.dialogs.map(dialog => [dialog.id, dialog]));
      const head = page.dialogs.map(dialog => {
        const live = current.get(dialog.id);
        const metadataChanged = (versions.get(dialog.id) ?? 0) !== (this.metadataVersions.get(dialog.id) ?? 0);
        const keepMessage = live && ((live.last_message_id ?? 0) > (dialog.last_message_id ?? 0) || (live.last_message_id === dialog.last_message_id && live !== before.get(dialog.id)));
        if (!metadataChanged) this.dirtyDialogs.delete(dialog.id);
        return {
          ...dialog,
          ...(keepMessage ? { preview: live.preview, last_message_id: live.last_message_id, unread_count: live.unread_count } : {}),
          ...(metadataChanged && live ? { title: live.title, writable: live.writable, kind: live.kind } : {}),
        };
      });
      const ids = new Set(head.map(dialog => dialog.id));
      this.dialogs = [...head, ...this.dialogs.filter(dialog => !ids.has(dialog.id))];
      if (this.dialogCursor === undefined) this.dialogCursor = page.cursor;
      this.forwardPicker?.setDialogs(this.dialogs); this.redraw();
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { this.refreshing = false; this.redraw(); }
  }
  private moreChats(): Promise<boolean> {
    if (this.moreChatsRequest) return this.moreChatsRequest;
    const cursor = this.dialogCursor;
    if (!cursor || this.quitting) return Promise.resolve(false);
    const generation = this.generation;
    this.loadingMoreChats = true;
    const token = {};
    this.moreChatsToken = token;
    const request: Promise<boolean> = (async () => {
      let loaded = false;
      try {
        const page = await this.telegram.call<DialogPage>("dialogs", [cursor]);
        if (generation !== this.generation) return false;
        if (page.cursor && (!Number.isSafeInteger(page.cursor.offset) || page.cursor.offset <= cursor.offset)) throw new Error("Telegram dialog pagination did not advance.");
        const ids = new Set(this.dialogs.map(dialog => dialog.id));
        this.dialogs.push(...page.dialogs.filter(dialog => !ids.has(dialog.id)));
        this.dialogCursor = page.cursor;
        this.forwardPicker?.setDialogs(this.dialogs);
        loaded = true;
        return true;
      } catch (error) {
        if (generation === this.generation) this.fail(error);
        return false;
      } finally {
        if (this.moreChatsToken === token) {
          this.moreChatsRequest = undefined; this.moreChatsToken = undefined; this.loadingMoreChats = false; this.redraw();
          if (loaded) { this.palette?.loadNearEnd(); this.forwardPicker?.loadNearEnd(); }
        }
      }
    })();
    this.moreChatsRequest = request;
    this.redraw(false);
    return request;
  }
  private fillDialogsForSearch(): void {
    if (this.fillingDialogs) return;
    const generation = this.generation;
    const filling: Promise<void> = (async () => {
      while (generation === this.generation && !this.quitting && this.dialogCursor
        && ((this.palette && this.searchingDialogs) || this.forwardPicker?.searching)) {
        if (!await this.moreChats()) break;
      }
    })();
    this.fillingDialogs = filling;
    void filling.then(
      () => { if (this.fillingDialogs === filling) this.fillingDialogs = undefined; },
      error => { if (this.fillingDialogs === filling) { this.fillingDialogs = undefined; this.fail(error); } },
    );
  }
  private async refresh(): Promise<void> {
    if (this.refreshing || this.currentThread()?.loading) return;
    const id = this.selectedId;
    this.resolvedAlbums.clear();
    await Promise.all([this.refreshDialogs(), id === null ? Promise.resolve() : this.loadHistory(id, false, true), id === null ? Promise.resolve() : this.loadChatInfo(id, true)]);
    void this.refreshDirtyDialogs();
  }
  private async reconnect(): Promise<void> {
    await this.perform("Reconnecting…", async operation => {
      this.clearTransient(); this.authorizationVersion++; this.clearQr(); this.password.setValue("");
      await this.persist();
      if (this.authOperation !== operation || this.quitting) return;
      this.generation++; this.bootstrap = undefined; this.receipts.clear(); this.readers.clear();
      this.participantCounts.clear(); this.resolvedAlbums.clear(); this.peerNames.clear();
      const connection = this.telegram;
      const replacement = this.newConnection(); this.telegram = replacement;
      await connection.close();
      if (this.authOperation !== operation || this.telegram !== replacement || this.quitting) return;
      this.authorizationState = "closed"; this.stage = "closed";
      await this.authorizationCall("connect");
      if (this.account && this.selectedId !== null) await this.loadHistory(this.selectedId, false, true);
    });
  }

  private async send(text: string): Promise<void> {
    const id = this.selectedId;
    if (id === null || !text.trim() || this.stage !== "chats" || this.selectedDialog()?.writable === false || this.busy) return;
    const thread = this.thread(id);
    if (thread.sending) return;
    const editing = thread.editing, replyTo = thread.replyTo;
    if (!editing && thread.pendingSend) {
      this.fail("A previous message is still pending. Delivery is tracked automatically; your new draft is kept.");
      return;
    }
    this.stopTyping();
    const connection = this.telegram, generation = this.generation;
    let attempt: PendingSend | null = null;
    let submitted = false;
    if (editing) this.savingEdits.add(thread);
    thread.sending = true; this.error = false; this.status = ""; this.redraw();
    try {
      if (!editing) {
        attempt = await connection.call<PendingSend>("prepare_send", [id, text, replyTo]);
        if (connection !== this.telegram || generation !== this.generation || this.threads.get(id) !== thread) return;
        thread.pendingSend = attempt;
        await this.persist(true); // Persist the client intent before it can reach TDLib.
      }
      if (connection !== this.telegram || generation !== this.generation) return;
      submitted = true;
      const message = editing
        ? await connection.call<ChatMessage>("edit", [id, editing.id, text])
        : await connection.call<ChatMessage>("send", [id, text, replyTo, attempt!.token]);
      if (generation !== this.generation || this.threads.get(id) !== thread) return;
      if (attempt) this.sent(id, thread, attempt, message);
      else {
        this.receive({ kind: "message", chat_id: id, message });
        if (thread.draft === text && thread.editing === editing) {
          thread.cancelEdit();
          if (this.selectedId === id) this.setComposer(thread.draft);
        }
        this.schedulePersist();
      }
    } catch (error) {
      if (generation === this.generation) {
        if (attempt && thread.pendingSend?.token !== attempt.token) return; // A terminal backend event wins over this stale rejection.
        if (!submitted && attempt && thread.pendingSend?.token === attempt.token) {
          thread.pendingSend = null;
          this.schedulePersist();
        }
        else if (attempt && thread.pendingSend?.token === attempt.token) {
          this.reconcileSend(id, thread, thread.pendingSend);
          if (thread.pendingSend.status === "queued") return;
        }
        this.fail(error);
      }
    } finally { this.savingEdits.delete(thread); thread.sending = false; this.redraw(); }
  }
  private sent(id: number, thread: ChatState, pending: PendingSend, message: ChatMessage): void {
    if (message.sending_state) {
      if (thread.pendingSend?.token !== pending.token) return; // A native terminal update wins over a stale queued RPC reply.
      thread.pendingSend = { ...pending, status: message.sending_state, message_id: message.id };
      this.receive({ kind: "message", chat_id: id, message });
      if (message.sending_state === "failed") this.fail("Telegram could not send this message. Your draft is kept.");
      else { this.error = false; this.status = ""; }
      this.schedulePersist();
      return;
    }
    if (thread.retryDisplayId !== null) {
      const previousId = thread.retryDisplayId; thread.retryDisplayId = null;
      if (previousId !== message.id) thread.remove([previousId]);
      if (this.actionMessage === previousId) this.actionMessage = message.id;
      if (this.deleteConfirm === previousId) this.deleteConfirm = null;
    }
    if (pending.message_id !== undefined && pending.message_id !== message.id) {
      thread.remove([pending.message_id]);
      if (this.actionMessage === pending.message_id) this.actionMessage = message.id;
      if (this.deleteConfirm === pending.message_id) this.deleteConfirm = null;
      this.dialogs = this.dialogs.map(dialog => dialog.id === id && dialog.last_message_id === pending.message_id
        ? { ...dialog, last_message_id: message.id, preview: message.text } : dialog);
    }
    this.receive({ kind: "message", chat_id: id, message });
    this.confirmed(id, thread, pending);
  }
  private confirmed(id: number, thread: ChatState, pending: PendingSend): void {
    if (thread.pendingSend?.token === pending.token) {
      thread.pendingSend = null;
      if (pending.text && !thread.editing && thread.draft === pending.text && thread.replyTo === pending.reply_to) {
        thread.draft = ""; thread.replyTo = null;
        if (this.selectedId === id) this.setComposer("");
      }
    }
    this.error = false; this.status = "";
    if (this.selectedId === id) this.jumpBottom();
    this.schedulePersist(); this.redraw();
  }
  private reconcileSend(id: number, thread: ChatState, pending: PendingSend): void {
    const connection = this.telegram, generation = this.generation;
    const existing = this.reconcilingSends.get(pending.token);
    if (existing?.connection === connection && existing.generation === generation) return;
    if (existing) clearTimeout(existing.timer);
    const request = { connection, generation, timer: undefined as Timer | undefined };
    this.reconcilingSends.set(pending.token, request);
    const current = () => connection === this.telegram && generation === this.generation
      && this.authorizationState === "ready" && !this.quitting
      && this.threads.get(id) === thread && thread.pendingSend?.token === pending.token;
    const run = async () => {
      if (!current()) {
        if (this.reconcilingSends.get(pending.token) === request) this.reconcilingSends.delete(pending.token);
        return;
      }
      try { await connection.call("reconcile_send", [id, pending.token]); }
      catch (error) {
        if (current() && error instanceof TelegramRequestError && error.retryAfterSeconds > 0) {
          request.timer = setTimeout(() => { request.timer = undefined; void run(); }, error.retryAfterSeconds * 1000);
          return;
        }
        // Native send-state updates remain authoritative; a read failure must not imply non-delivery.
      }
      if (this.reconcilingSends.get(pending.token) === request) this.reconcilingSends.delete(pending.token);
    };
    void run();
  }
  private async retrySend(selected?: ChatMessage): Promise<void> {
    const id = this.selectedId, thread = this.currentThread();
    if (id === null || !thread || thread.sending || this.busy || this.stage !== "chats") return;
    if (selected && (!selected.outgoing || selected.chat_id !== id || selected.sending_state !== "failed")) return;
    let pending = thread.pendingSend;
    const tracked = pending && (!selected || selected.id === pending.message_id || selected.id === thread.retryDisplayId);
    if (tracked && pending?.status !== "failed") return;
    if (!tracked && !selected) return;
    const connection = this.telegram, generation = this.generation;
    thread.sending = true; this.stopTyping(); this.error = false; this.status = ""; this.redraw();
    try {
      if (!tracked) {
        pending = await connection.call<PendingSend>("adopt_failed_send", [id, selected!.id]);
        if (connection !== this.telegram || generation !== this.generation || this.threads.get(id) !== thread) return;
        thread.pendingSend = pending;
        await this.persist(true); // Persist the adopted local identity before asking TDLib to retry it.
      }
      if (connection !== this.telegram || generation !== this.generation || !pending) return;
      thread.retryDisplayId ??= selected?.id ?? pending.message_id ?? null;
      const message = await connection.call<ChatMessage>("retry_send", [id, pending.token]);
      if (generation === this.generation && this.threads.get(id) === thread) this.sent(id, thread, pending, message);
    } catch (error) {
      if (generation === this.generation) {
        if (pending && thread.pendingSend?.token !== pending.token) return;
        if (pending && thread.pendingSend?.token === pending.token) {
          this.reconcileSend(id, thread, thread.pendingSend);
          if (thread.pendingSend.status === "queued") return;
        }
        this.fail(error);
      }
    } finally { thread.sending = false; this.redraw(); }
  }
  private restoreSend(): void {
    const thread = this.currentThread();
    if (!thread?.pendingSend?.text || thread.sending || this.busy || this.stage !== "chats") return;
    thread.restorePendingSend();
    this.setComposer(thread.draft); this.schedulePersist(); this.redraw(); this.focusDefault();
  }
  private async abandonSend(): Promise<void> {
    const id = this.selectedId, thread = this.currentThread(), pending = thread?.pendingSend;
    if (id === null || !thread || !pending || pending.token !== this.abandonConfirm || pending.status !== "uncertain" || thread.sending || this.busy) return;
    const connection = this.telegram, generation = this.generation;
    thread.sending = true; this.stopTyping(); this.error = false; this.status = "Checking this send before stopping tracking…"; this.redraw();
    try {
      await connection.call("abandon_send", [id, pending.token]);
    } catch (error) { if (generation === this.generation && thread.pendingSend?.token === pending.token) this.fail(error); }
    finally { thread.sending = false; this.abandonConfirm = null; this.redraw(); }
  }
  private jumpBottom(): void {
    if (this.selectedId === null) return;
    const id = this.selectedId;
    const thread = this.thread(id);
    this.actionMessage = this.deleteConfirm = null;
    this.scrolls.set(id, { by: "end", n: (this.scrolls.get(id)?.n ?? 0) + 1 }); this.detached.delete(id);
    thread.acknowledgeNewMessages(); this.redraw(); void this.markRead(id);
  }
  /**
   * TSP reports neither viewport position nor pane focus. Read an open chat only while its latest messages are
   * followed and the user is present; trackpad scrolling is not observable.
   */
  private catchUp(id: number): void {
    if (this.quitting || this.stage !== "chats" || this.busy || this.palette || this.help || this.photoViewer || this.forwardPicker) return;
    const thread = this.threads.get(id);
    if (!thread || this.selectedId !== id || this.detached.has(id) || Date.now() - this.lastInput > PRESENCE_MS) return;
    if (!thread.newMessages && !this.selectedDialog()?.unread_count) return;
    thread.acknowledgeNewMessages(); void this.markRead(id);
  }
  private scroll(by: NativeScroll["by"]): void {
    if (this.selectedId === null) return;
    const id = this.selectedId;
    this.scrolls.set(id, { by, n: (this.scrolls.get(id)?.n ?? 0) + 1 }); this.detached.add(id); this.redraw();
  }
  private async markRead(id: number): Promise<void> {
    const maxId = this.thread(id).messages.at(-1)?.id;
    if (maxId !== undefined) await this.receipts.read(id, maxId);
  }
  private chosenMessage(): ChatMessage | undefined { return this.currentThread()?.messages.find(message => message.id === this.actionMessage); }
  private reply(message: ChatMessage): void {
    if (this.selectedDialog()?.writable === false || this.currentThread()?.sending) return;
    const thread = this.thread(message.chat_id);
    thread.cancelEdit(); thread.replyTo = message.id; this.actionMessage = this.deleteConfirm = null;
    this.setComposer(thread.draft); this.redraw(); this.focusDefault();
  }
  private edit(message: ChatMessage): void {
    if (!message.outgoing || message.photo || this.currentThread()?.sending) return;
    const thread = this.thread(message.chat_id); thread.edit(message);
    this.actionMessage = this.deleteConfirm = null; this.setComposer(thread.draft); this.redraw(); this.focusDefault();
  }
  private cancelCompose(): void {
    const thread = this.currentThread();
    if (!thread || thread.sending) return;
    if (thread.editing) thread.cancelEdit(); else thread.replyTo = null;
    this.setComposer(thread.draft); this.schedulePersist(); this.redraw();
  }
  private albumMembers(message: ChatMessage): ChatMessage[] {
    const thread = this.thread(message.chat_id);
    if (message.grouped_id !== null) return thread.messages.filter(item => item.grouped_id === message.grouped_id);
    const current = thread.getMessage(message.id);
    return current ? [current] : [];
  }
  private async deleteMessage(): Promise<void> {
    const id = this.selectedId; const messageId = this.deleteConfirm;
    if (id === null || messageId === null) return;
    const key = `${id}:${messageId}`;
    if (this.messageOperations.has(key)) return;
    const generation = this.generation;
    const message = this.thread(id).messages.find(item => item.id === messageId);
    if (!message) return;
    const ids = this.albumMembers(message).map(item => item.id);
    this.messageOperations.add(key); this.redraw();
    try {
      await this.telegram.call("delete", [id, ids]);
      if (generation !== this.generation) return;
      this.thread(id).remove(ids);
      if (this.selectedId === id) { this.actionMessage = this.deleteConfirm = null; this.setComposer(this.thread(id).draft); }
      void this.refreshDialog(id);
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { this.messageOperations.delete(key); this.redraw(); }
  }
  private navigateChat(direction: -1 | 1): void {
    const id = this.navigation.move(direction, candidate => this.dialogs.some(dialog => dialog.id === candidate));
    if (id === null) return;
    const messagesFocused = this.focused;
    void this.selectChat(id, true);
    if (messagesFocused) { this.tui.setFocus(this); this.redraw(false); }
  }
  private paletteItems(): PaletteItem[] {
    const thread = this.currentThread();
    const chosen = this.chosenMessage();
    const command = (value: string, label: string, description: string, disabled = false): PaletteItem => ({ value, label, description, disabled });
    const recent = this.navigation.recent().flatMap(id => {
      const dialog = this.dialogs.find(item => item.id === id);
      return dialog ? [dialog] : [];
    });
    const recentIds = new Set(recent.map(dialog => dialog.id));
    const chatItem = (dialog: Dialog, recent = false): PaletteItem => ({
      value: `chat:${dialog.id}`, label: dialog.title, recent,
      description: [dialog.id === this.selectedId ? "Current" : "", dialog.unread_count ? `${dialog.unread_count} unread` : "", this.threads.get(dialog.id)?.draft ? "Draft" : "", preview(dialog.preview)].filter(Boolean).join(" · "),
    });
    const available = (id: number) => this.dialogs.some(dialog => dialog.id === id);
    return [
      ...recent.map(dialog => chatItem(dialog, true)),
      command("history-back", "Back to previous chat", "← twice · visit history", !this.navigation.canMove(-1, available)),
      command("history-forward", "Forward in chat history", "→ twice · visit history", !this.navigation.canMove(1, available)),
      ...this.dialogs.filter(dialog => !recentIds.has(dialog.id)).map(dialog => chatItem(dialog)),
      command("help", "Keyboard shortcuts", "Ctrl+G · context-sensitive controls"),
      command("toggle-context-hints", this.showContextHints ? "Hide contextual hints" : "Show contextual hints", "Toggle Commands / Keys, editor hints and viewer Close / zoom hints; keep object information"),
      command("bottom", "Latest messages", "Ctrl+L", !thread),
      ...(thread?.pendingSend ? [
        ...(thread.pendingSend.text ? [command("restore-send", "Restore pending text", "Keep newer draft text; delivery remains tracked", !!thread.sending || this.busy)] : []),
        ...(thread.pendingSend.status === "failed" ? [command("retry-send", "Retry failed message", "Retry the confirmed failed Telegram message", !!thread.sending || this.busy)] : []),
        ...(thread.pendingSend.status === "uncertain" ? [command("abandon-send", "Stop tracking this send…", "Only after checking this chat; does not cancel delivery", !!thread.sending || this.busy)] : []),
      ] : []),
      ...(chosen ? [
        command("reply", "Reply to selected message", "R / Enter in messages", this.selectedDialog()?.writable === false || !!thread?.sending),
        command("forward", "Forward selected message", "F in messages"),
        ...(chosen.photo ? [command(`photo:${chosen.id}`, "View selected photo", "P in messages")] : []),
        ...(chosen.outgoing ? [
          ...(!chosen.photo ? [command("edit", "Edit selected message", "E in messages", !!thread?.sending)] : []),
          command("delete", "Delete selected message…", "X in messages · requires confirmation"),
        ] : []),
      ] : []),
      ...(thread?.editing || thread?.replyTo != null ? [command("cancel-compose", "Cancel reply / edit", "Esc · preserve draft", !!thread?.sending)] : []),
      command("refresh", "Refresh", "Ctrl+R", this.refreshing || !!thread?.loading),
      command("reconnect", "Reconnect Telegram", this.online ? "Connected" : "Offline"),
      command("logout", "Sign out…", this.account || "Requires confirmation"),
      command("quit", "Quit Terngram", "Ctrl+Q"),
    ];
  }
  private openPalette(chatsOnly = false): void {
    if (this.stage !== "chats" || this.busy || this.photoViewer || this.forwardPicker || this.help) return;
    if (this.palette) return;
    this.closePhoto();
    this.overlayReturnFocus = this.composer.focused ? this.composer : this;
    this.palette = new CommandPalette(this.paletteItems(), action => {
      this.closePalette();
      this.handleNativeEvent({ type: "action", key: "", act: action, mods: [] });
    }, () => this.closePalette(), query => {
      this.searchingDialogs = !!query;
      this.fillDialogsForSearch();
      void this.refreshDirtyDialogs();
      this.redraw(false);
    }, chatsOnly, () => { if (this.palette) void this.moreChats(); });
    this.palette.setLoading(this.loadingMoreChats);
    this.paletteOverlay = this.tui.showOverlay(this.palette);
    this.palette.loadNearEnd();
    void this.refreshDirtyDialogs();
  }
  private closePalette(): void {
    if (!this.palette) return;
    this.searchingDialogs = false;
    this.palette = undefined; this.paletteOverlay?.hide(); this.paletteOverlay = undefined;
    this.tui.setFocus(this.overlayReturnFocus ?? this.composer); this.overlayReturnFocus = undefined;
  }
  private openHelp(): void {
    if (this.help) return;
    this.closePhoto();
    this.overlayReturnFocus = this.fields().find(field => (field as Component & { focused?: boolean }).focused) ?? this;
    this.help = new ShortcutHelp(() => this.closeHelp());
    this.helpOverlay = this.tui.showOverlay(this.help);
  }
  private closeHelp(): void {
    if (!this.help) return;
    this.help = undefined; this.helpOverlay?.hide(); this.helpOverlay = undefined;
    this.tui.setFocus(this.overlayReturnFocus ?? this); this.overlayReturnFocus = undefined;
  }
  private openForwardPicker(message: ChatMessage): void {
    if (this.stage !== "chats" || this.busy || this.photoViewer) return;
    if (this.forwardPicker) { this.tui.setFocus(this.forwardPicker); return; }
    this.overlayReturnFocus = this.composer.focused ? this.composer : this;
    this.forwardPicker = new ForwardPicker(this.dialogs, id => {
      this.closeForwardPicker();
      void this.forwardMessage(message, id);
    }, () => this.closeForwardPicker(), () => { if (this.forwardPicker) void this.moreChats(); }, () => this.fillDialogsForSearch());
    this.forwardPicker.setLoading(this.loadingMoreChats);
    this.forwardOverlay = this.tui.showOverlay(this.forwardPicker);
    this.forwardPicker.loadNearEnd();
  }
  private closeForwardPicker(): void {
    if (!this.forwardPicker) return;
    this.forwardPicker = undefined; this.forwardOverlay?.hide(); this.forwardOverlay = undefined;
    this.tui.setFocus(this.overlayReturnFocus ?? this); this.overlayReturnFocus = undefined;
  }
  private async forwardMessage(message: ChatMessage, destination: number): Promise<void> {
    const key = `${message.chat_id}:${message.id}`;
    if (this.messageOperations.has(key)) return;
    const generation = this.generation; this.messageOperations.add(key); this.redraw();
    try {
      const ids = this.albumMembers(message).map(item => item.id);
      const sent = await this.telegram.call<ChatMessage[]>("forward", [message.chat_id, ids, destination]);
      if (generation !== this.generation) return;
      for (const item of sent) this.receive({ kind: "message", chat_id: destination, message: item });
      this.status = `Forwarded to ${this.dialogs.find(dialog => dialog.id === destination)?.title ?? "chat"}.`;
      this.error = false; this.actionMessage = null;
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { this.messageOperations.delete(key); this.redraw(); }
  }
  private async viewPhoto(message: ChatMessage, background = false): Promise<void> {
    if (background && (!this.photoViewer || this.photoDisplayedIntent !== this.photoIntent)) return;
    const key = `${message.chat_id}:${message.grouped_id ?? message.id}`;
    const existing = this.photoLoading.get(key);
    if (existing) {
      if (!background) existing.intent = ++this.photoIntent;
      return;
    }
    const generation = this.generation;
    const connection = this.telegram;
    const request = { intent: background ? this.photoIntent : ++this.photoIntent };
    this.photoLoading.set(key, request); this.redraw();
    try {
      if (message.grouped_id !== null && !this.resolvedAlbums.has(key)) {
        const thread = this.thread(message.chat_id);
        const started = thread.revision;
        const album = await connection.call<ChatMessage[]>("album", [message.chat_id, message.id]);
        if (generation !== this.generation || connection !== this.telegram) return;
        thread.applyPage(album, started);
        this.resolvedAlbums.add(key);
        this.queuePreviews(message.chat_id);
      }
      let members: ChatMessage[];
      for (;;) {
        if (generation !== this.generation || connection !== this.telegram || request.intent !== this.photoIntent || this.selectedId !== message.chat_id || this.quitting) return;
        members = this.albumMembers(message).filter(item => item.photo);
        const missing = members.filter(item => !this.photoNodes.has(photoKey(item)));
        if (!missing.length) break;
        await Promise.all(missing.map(async item => {
          const imageKey = photoKey(item);
          try {
            const photo = await connection.call<Photo>("photo", [item.chat_id, item.id]);
            const current = this.threads.get(item.chat_id)?.getMessage(item.id);
            if (generation !== this.generation || connection !== this.telegram || request.intent !== this.photoIntent || this.selectedId !== item.chat_id || this.quitting || !current?.photo || photoKey(current) !== imageKey) return;
            this.photoNodes.set(imageKey, base64ImageNode(photo.data, photo.mime, { alt: "Telegram photo", max: { w: "80ch", h: "28lines" } }, `full-photo-${item.chat_id}:${item.id}`));
          } catch (error) {
            if (!(error instanceof TelegramRequestError) || error.code !== "MEDIA_CHANGED") throw error;
            if (generation === this.generation && connection === this.telegram && request.intent === this.photoIntent && this.selectedId === item.chat_id && !this.quitting) {
              this.invalidatePhoto(item);
              this.queuePreviews(item.chat_id);
            }
          }
        }));
        if (generation !== this.generation || connection !== this.telegram) return;
      }
      if (generation !== this.generation || connection !== this.telegram || request.intent !== this.photoIntent || this.selectedId !== message.chat_id || this.quitting) return;
      const sameGroup = this.photoGroup?.chat_id === message.chat_id && (message.grouped_id !== null ? this.photoGroup.grouped_id === message.grouped_id : this.photoGroup.id === message.id);
      if (!members.length) { if (sameGroup) this.closePhoto(); return; }
      const images = members.map(item => this.photoNodes.get(photoKey(item))!);
      const captions = members.map(item => item.text === "[Photo]" ? "" : item.text);
      if (this.photoViewer && sameGroup) { this.photoViewer.setContent(images, captions); this.photoDisplayedIntent = request.intent; }
      else if (!this.palette && !this.help && !this.forwardPicker) {
        this.closePhoto(false); this.photoGroup = message;
        this.photoReturnFocus = this.composer.focused ? this.composer : this;
        this.photoViewer = new PhotoViewer(images, captions, () => this.closePhoto(), this.showContextHints);
        this.photoViewer.selectImage(`full-photo-${message.chat_id}:${message.id}`);
        this.photoDisplayedIntent = request.intent;
        this.photoOverlay = this.tui.showOverlay(this.photoViewer);
      }
    } catch (error) { if (generation === this.generation && connection === this.telegram && request.intent === this.photoIntent) this.fail(error); }
    finally {
      if (this.photoLoading.get(key) === request) this.photoLoading.delete(key);
      this.redraw();
    }
  }
  private closePhoto(cancelPending = true): void {
    if (cancelPending) this.photoIntent++;
    if (!this.photoViewer) return;
    this.photoGroup = null; this.photoViewer = undefined; this.photoOverlay?.hide(); this.photoOverlay = undefined;
    this.tui.setFocus(this.photoReturnFocus ?? this); this.photoReturnFocus = undefined;
  }

  private intercept(data: string): { consume: true } | undefined {
    if (isKeyRelease(data)) return undefined;
    if (isKeyRepeat(data) && SINGLE_PRESS_KEYS.some(key => matchesKey(data, key))) return { consume: true };
    this.lastInput = Date.now();
    this.userActivity();
    if (this.stage === "chats" && this.selectedId !== null) this.catchUp(this.selectedId);
    const navigationContext = this.stage === "chats" && !this.busy && this.deleteConfirm === null
      && !this.photoViewer && !this.forwardPicker && !this.palette && !this.help
      && (this.focused || (this.composer.focused && !this.composer.getText()));
    const direction = navigationContext && !isKeyRepeat(data) ? matchesKey(data, "left") ? -1 : matchesKey(data, "right") ? 1 : null : null;
    if (this.navigation.tap(direction) && direction !== null) { this.navigateChat(direction); return { consume: true }; }
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+q")) { void this.quit(); return { consume: true }; }
    if (this.photoViewer || this.forwardPicker || this.palette || this.help) return undefined;
    if (this.busy) return { consume: true };
    if (matchesKey(data, "ctrl+g")) { this.openHelp(); return { consume: true }; }
    if (this.stage === "logout" && matchesKey(data, "escape")) {
      this.stage = "chats"; this.redraw(); this.focusDefault(); return { consume: true };
    }
    if (this.stage === "chats") {
      if (matchesKey(data, "ctrl+k")) { this.openPalette(); return { consume: true }; }
      if (matchesKey(data, "ctrl+f")) { this.openPalette(true); return { consume: true }; }
      if (matchesKey(data, "ctrl+r")) { void this.refresh(); return { consume: true }; }
      if (matchesKey(data, "ctrl+l")) { this.jumpBottom(); return { consume: true }; }
      if (this.focused && (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d"))) {
        this.scroll(matchesKey(data, "ctrl+u") ? "page-up" : "page-down"); return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        for (const request of this.photoLoading.values()) {
          if (request.intent === this.photoIntent) { this.closePhoto(); return { consume: true }; }
        }
        if (this.deleteConfirm !== null) { this.deleteConfirm = null; this.redraw(); }
        else if (this.actionMessage !== null) { this.actionMessage = null; this.redraw(); this.focusDefault(); }
        else { this.cancelCompose(); this.focusDefault(); }
        return { consume: true };
      }
      if (this.deleteConfirm !== null) {
        if (matchesKey(data, "enter")) void this.deleteMessage();
        return { consume: true };
      }
      if (this.composer.focused && (matchesKey(data, "enter") || matchesKey(data, "ctrl+enter"))) {
        if (!this.composer.disableSubmit) void this.send(this.composer.getText());
        return { consume: true };
      }
      if (this.composer.focused && matchesKey(data, "up") && !this.composer.getText()) {
        const messages = this.currentThread()?.messages ?? [];
        let message: ChatMessage | undefined;
        for (let index = messages.length - 1; index >= 0; index--) {
          if (messages[index]!.outgoing && !messages[index]!.photo) { message = messages[index]; break; }
        }
        if (message) { this.edit(message); return { consume: true }; }
      }
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const fields = this.fields(); const current = fields.findIndex(field => (field as Input | Editor | TerngramApp).focused);
      const step = matchesKey(data, "shift+tab") ? -1 : 1;
      const next = fields[(current + step + fields.length) % fields.length] ?? this;
      this.tui.setFocus(next);
      if (next === this && this.stage === "chats" && this.actionMessage === null) {
        const group = this.currentThread()?.groups.at(-1);
        this.actionMessage = (group?.find(message => message.sending_state === "failed") ?? group?.[0])?.id ?? null;
      }
      this.loadReaders();
      this.redraw(); return { consume: true };
    }
    return undefined;
  }
  handleInput(data: string): void {
    if (this.busy) return;
    if (this.stage !== "chats" && matchesKey(data, "enter")) { void this.submit(); return; }
    if (this.stage !== "chats") return;
    const groups = this.currentThread()?.groups ?? [];
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const up = matchesKey(data, "up");
      const current = groups.findIndex(group => group.some(message => message.id === this.actionMessage));
      // The first loaded message is the keyboard edge of history; there is no viewport position to observe.
      if (up && current === 0 && this.selectedId !== null) void this.loadHistory(this.selectedId, true);
      const index = current < 0 ? groups.length - 1 : Math.max(0, Math.min(groups.length - 1, current + (up ? -1 : 1)));
      const group = groups[index];
      this.actionMessage = (group?.find(message => message.sending_state === "failed") ?? group?.[0])?.id ?? null;
      if (index !== groups.length - 1 && this.selectedId !== null) this.detached.add(this.selectedId);
      this.loadReaders();
      this.redraw();
      return;
    }
    const message = this.chosenMessage();
    if (!message) return;
    if (matchesKey(data, "enter") && message.sending_state === "failed") void this.retrySend(message);
    else if (matchesKey(data, "enter") || matchesKey(data, "r")) this.reply(message);
    else if (matchesKey(data, "e")) this.edit(message);
    else if (matchesKey(data, "f")) this.openForwardPicker(message);
    else if (matchesKey(data, "p") && message.photo) void this.viewPhoto(message);
    else if ((matchesKey(data, "x") || matchesKey(data, "backspace") || matchesKey(data, "delete")) && message.outgoing) { this.deleteConfirm = message.id; this.redraw(); }
  }
  handleNativeEvent(event: NativeUiEvent): void {
    if (this.quitting) return;
    if (event.type === "action" && event.act === "quit") { void this.quit(); return; }
    if (this.busy) return;
    this.lastInput = Date.now();
    this.userActivity();
    if (event.type !== "action") return;
    if (this.stage !== "chats" && !["submit", "restart-qr", "credentials", "reconnect", "cancel", "help"].includes(event.act)) return;
    const [action, value] = event.act.split(":");
    if (action === "chat") {
      const id = Number(value);
      if (Number.isSafeInteger(id) && id !== 0) void this.selectChat(id);
      return;
    }
    if (action === "message" || action === "reply-message" || action === "retry-message" || action === "photo") {
      const message = this.currentThread()?.messages.find(item => item.id === Number(value));
      if (!message) return;
      if (action === "message") {
        if (!this.currentThread()?.groups.at(-1)?.some(item => item.id === message.id)) this.detached.add(message.chat_id);
        this.actionMessage = message.id; this.deleteConfirm = null; this.tui.setFocus(this); this.loadReaders(); this.redraw();
      }
      else if (action === "reply-message") this.reply(message);
      else if (action === "retry-message" && message.sending_state === "failed") void this.retrySend(message);
      else void this.viewPhoto(message);
      return;
    }
    const chosen = this.chosenMessage();
    switch (event.act) {
      case "submit": void this.submit(); break;
      case "send": void this.send(this.composer.getText()); break;
      case "retry-send": void this.retrySend(); break;
      case "restore-send": this.restoreSend(); break;
      case "abandon-send": {
        const pending = this.currentThread()?.pendingSend;
        if (pending?.status === "uncertain" && !this.currentThread()?.sending && !this.busy) {
          this.abandonConfirm = pending.token; this.redraw();
        }
        break;
      }
      case "confirm-abandon-send": void this.abandonSend(); break;
      case "cancel-abandon-send": this.abandonConfirm = null; this.redraw(); break;
      case "older": if (this.selectedId !== null) void this.loadHistory(this.selectedId, true); break;
      case "bottom": this.jumpBottom(); break;
      case "refresh": void this.refresh(); break;
      case "reconnect": void this.reconnect(); break;
      case "chats": this.openPalette(); break;
      case "history-back": this.navigateChat(-1); break;
      case "history-forward": this.navigateChat(1); break;
      case "help": this.openHelp(); break;
      case "toggle-context-hints": this.showContextHints = !this.showContextHints; this.redraw(false); break;
      case "reply": if (chosen) this.reply(chosen); break;
      case "edit": if (chosen) this.edit(chosen); break;
      case "forward": if (chosen) this.openForwardPicker(chosen); break;
      case "delete": if (chosen?.outgoing) { this.deleteConfirm = chosen.id; this.tui.setFocus(this); this.redraw(); } break;
      case "confirm-delete": void this.deleteMessage(); break;
      case "cancel-action": this.deleteConfirm = this.actionMessage = null; this.redraw(); this.focusDefault(); break;
      case "cancel-compose": this.cancelCompose(); break;
      case "cancel-delete": this.deleteConfirm = null; this.redraw(); break;
      case "dismiss-status": this.status = ""; this.error = false; this.redraw(false); break;
      case "logout": if (this.stage === "chats") { this.stopTyping(); this.stage = "logout"; this.redraw(); this.tui.setFocus(this); } break;
      case "cancel": if (this.stage === "logout") { this.stage = "chats"; this.redraw(); this.focusDefault(); } break;
      case "restart-qr":
        if (this.stage === "password") void this.perform("Discarding this unfinished login…", async () => {
          this.password.setValue(""); this.clearQr();
          await this.authorizationCall("request_qr");
        });
        break;
      case "credentials": if (this.stage !== "chats" && this.stage !== "logout") void this.changeCredentials(); break;
      case "quit": void this.quit(); break;
    }
  }

  private messageNode(members: readonly ChatMessage[], thread: ChatState): NativeNode {
    const message = members[0]!;
    return this.messageView.describe(members, {
      thread, selectedMessageId: this.selectedId === message.chat_id ? this.actionMessage : null,
      loading: this.photoLoading.has(`${message.chat_id}:${message.grouped_id ?? message.id}`),
      avatar: message.sender_id === null ? undefined : this.avatars.get(String(message.sender_id)),
      previews: members.filter(item => item.photo).slice(0, 4).map(item => this.previews.get(photoKey(item))),
      readerCount: message.outgoing ? this.readers.get(message.chat_id, message.id) : undefined,
      peerNames: this.peerNames,
    });
  }
  describeBody(cx?: DescribeContext): NativeNode {
    const title: NativeNode = { k: "text", key: "title", p: { spans: [{ t: "terngram", s: "strong accent" }] } };
    if (this.stage !== "chats") {
      const copy = COPY[this.stage];
      return { k: "col", key: `login-${this.stage}`, p: { role: "terngram.authorization", gap: "md", align: "center", min: { w: 0 } }, c: [
        title,
        { k: "card", key: "welcome", p: { head: this.stage === "qr" && this.authorizationState === "ready" ? "Opening Telegram" : copy.title, tone: "accent", max: { w: "64ch" }, min: { w: 0 } }, c: [
          label(this.stage === "qr" && this.authorizationState === "ready"
            ? this.error ? "Your account is authorized. Retry opening chats below." : "Your account is authorized. Loading your conversations…"
            : copy.hint),
          ...(this.stage === "credentials" ? [
            { k: "text", key: "api-tools", p: { text: "Get your API credentials", href: "https://my.telegram.org/apps", actions: { click: "open" }, tone: "info" } } satisfies NativeNode,
            label("Credentials and TDLib session stay in private local files. Never share them.", "privacy"),
          ] : []),
          ...(this.stage === "qr" && this.authorizationState !== "ready" ? [
            { k: "col", key: "qr", p: { align: "center", gap: "md", min: { w: 0 } }, c: [
              ...(cx?.supports("image") === false
                ? [label("This terminal cannot display login QR images. Open terngram in an image-capable Tern window to sign in.", "qr-unsupported")]
                : this.qrNode ? [this.qrNode] : [this.error
                  ? label("QR login is unavailable. Retry below.", "qr-error")
                  : { k: "spinner", key: "qr-loading", p: { label: "Preparing a secure QR code…" } } satisfies NativeNode]),
              label("1. Open Telegram on your phone.", "qr-step-1"),
              label("2. Go to Settings → Devices → Link Desktop Device.", "qr-step-2"),
              label("3. Point your camera at this code and confirm.", "qr-step-3"),
              ...(this.qrNode && !this.error && cx?.supports("image") !== false
                ? [{ k: "spinner", key: "qr-waiting", p: { style: "dots", label: "Waiting for confirmation…" } } satisfies NativeNode] : []),
              label("Codes update automatically. Scan only with Telegram; never share this QR code.", "qr-privacy"),
            ] } satisfies NativeNode,
          ] : []),
          ...(this.stage === "password" && this.authorizationHint ? [label(`Password hint: ${this.authorizationHint}`, "password-hint")] : []),
          ...(this.stage === "password" ? [label("To sign in with another account, discard this unfinished login using the button below. Existing Telegram sessions are not signed out.", "password-switch")] : []),
        ] },
      ] };
    }
    return { k: "col", key: "client", p: { role: "terngram.client", gap: "sm", min: { w: 0 }, max: { w: 1 } }, c: [
      ...(this.selectedId === null ? [label("Ctrl+K opens chats and commands. Ctrl+G shows keyboard shortcuts.", "empty")] : []),
      ...[...this.threads].filter(([id, state]) => id === this.selectedId || state.loaded || state.loading || state.messages.length > 0).map(([id, state]): NativeNode => ({ k: "col", key: `thread-${id}`, scroll: this.scrolls.get(id), p: { hidden: id !== this.selectedId, gap: "sm" }, c: [
        ...(state.more && state.messages.length ? [button("older", state.loading ? "Loading earlier messages…" : "Load earlier messages", state.loading)] : []),
        ...(!state.messages.length ? [label(state.loading ? "Loading messages…" : state.loaded ? "No messages in this chat." : "Messages are not loaded. Refresh to try again.", "empty")] : state.groups.map(group => this.messageNode(group, state))),
        { k: "text", key: `tail-${this.scrolls.get(id)?.by === "end" ? this.scrolls.get(id)!.n : 0}`, reveal: id === this.selectedId && this.scrolls.get(id)?.by === "end" ? "end" : undefined, p: { text: "" } },
      ] })),
    ] };
  }
  describe(): NativeNode {
    if (this.stage === "chats") {
      const selected = this.chosenMessage();
      const pending = this.currentThread()?.pendingSend;
      const dock = describeChatDock({
        dialog: this.selectedDialog(), thread: this.currentThread(), selected,
        participantsCount: this.selectedId === null ? undefined : this.participantCounts.get(this.selectedId),
        peerNames: this.peerNames,
        incomingActions: this.incomingActions(),
        messageFocus: this.focused, deleting: this.deleteConfirm !== null,
        showHints: this.showContextHints,
        operating: !!selected && this.messageOperations.has(`${selected.chat_id}:${selected.id}`),
        online: this.online, busy: this.busy, saving: !!this.currentThread() && this.savingEdits.has(this.currentThread()!), status: this.status, error: this.error, editor: this.composer,
      });
      if (!pending || pending.status !== "uncertain") return dock;
      return { k: "col", key: "outbox-dock", p: { gap: "sm" }, c: [
        { k: "card", key: `pending-${pending.token}`, p: { head: "Delivery uncertain", tone: "warning" }, c: [
          label(pending.error ?? "Delivery is tracked automatically. Check this conversation before deciding to stop tracking; your draft is safe."),
          { k: "row", key: "pending-controls", p: { gap: "sm", wrap: true }, c: [
            ...(pending.text ? [button("restore-send", "Restore text to composer", !!this.currentThread()?.sending || this.busy)] : []),
            button("abandon-send", "Stop tracking this send…", !!this.currentThread()?.sending || this.busy),
          ] },
          ...(this.abandonConfirm === pending.token ? [
            label(pending.text ? "Only continue after checking this conversation. This does NOT cancel Telegram delivery or declare success; it keeps the text as a draft. Sending that draft later may duplicate a message already delivered." : "Only continue after checking this conversation. This does NOT cancel Telegram delivery or declare success. Your composer draft is unchanged; retrying the media later may duplicate a message already delivered.", "abandon-warning"),
            { k: "row", key: "abandon-controls", p: { gap: "sm", wrap: true }, c: [
              button("confirm-abandon-send", pending.text ? "I checked this chat · Keep draft and stop tracking" : "I checked this chat · Stop tracking", !!this.currentThread()?.sending || this.busy),
              button("cancel-abandon-send", "Keep tracking", !!this.currentThread()?.sending || this.busy),
            ] } satisfies NativeNode,
          ] : []),
        ] }, dock,
      ] };
    }
    const controls = this.stage === "qr" && this.authorizationState !== "ready" && !this.error
      ? [] : [button("submit", this.stage === "qr" && this.authorizationState === "ready" ? "Retry opening chats" : COPY[this.stage].submit, this.busy)];
    if (this.stage === "logout") controls.push(button("cancel", "Cancel · Esc", this.busy));
    else if (this.stage === "qr" || this.stage === "password" || this.stage === "closed") controls.push(button("credentials", "Change API credentials", this.busy));
    if (this.stage === "password") controls.push(button("restart-qr", "Use a different account", this.busy));
    controls.push(button("quit", "Quit"));
    return { k: "col", key: "dock", p: { gap: "sm" }, c: [
      ...this.fields().filter(field => field !== this),
      { k: "row", key: "controls", p: { gap: "sm", wrap: true }, c: controls },
      ...(this.busy ? [{ k: "spinner" as const, key: "busy", p: { label: "Telegram" } }] : []),
      { k: "text", key: "status", p: { text: this.status, tone: this.error ? "error" : "muted", wrap: "word" } },
      label(this.stage === "qr" ? "Codes update automatically · Ctrl+G: keys · Ctrl+Q: quit" : "Tab: next field · Enter: continue · Ctrl+G: keys · Ctrl+Q: quit", "keys"),
    ] };
  }
  describeSurface(): NativeSurface { return { main: [this.body], dock: [this] }; }
  render(): readonly string[] { throw new Error("terngram requires native Tern rendering."); }
  renderFrame(): TerminalFramePlan { throw new Error("Open terngram inside Tern; ANSI rendering is not supported."); }
  acknowledgeHistory(): void { throw new Error("terngram does not expose ANSI history."); }
  invalidate(): void { this.body.invalidate(); }
  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    for (const request of this.reconcilingSends.values()) clearTimeout(request.timer);
    this.reconcilingSends.clear();
    this.authorizationVersion++; this.clearQr(); this.bootstrap = undefined; this.password.setValue(""); this.apiHash.setValue("");
    this.redraw(); this.clearTransient();
    clearTimeout(this.persistTimer); clearTimeout(this.readerTimer); await this.persist();
    this.avatars.clear(); this.previews.clear(); this.receipts.clear(); this.readers.clear();
    this.closeHelp(); this.closePalette(); this.closePhoto(); this.closeForwardPicker();
    await this.telegram.close(); await this.exit();
  }
}
