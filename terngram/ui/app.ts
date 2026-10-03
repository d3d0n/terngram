import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@oh-my-pi/pi-tui/keys";
import { base64ImageNode } from "@oh-my-pi/pi-tui/native/blobs";
import type { DescribeContext, NativeNode, NativeScroll, NativeSurface, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { type Component, type OverlayHandle, type TerminalFramePlan, TUI } from "@oh-my-pi/pi-tui/tui";
import { type ChatMessage, type ClientState, type Dialog, type DialogCursor, type DialogPage, type Photo, type TelegramUpdate, Telegram } from "./telegram";
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

const PAGE_SIZE = 50;
const SINGLE_PRESS_KEYS = ["enter", "ctrl+enter", "escape", "ctrl+r", "ctrl+g", "ctrl+k", "ctrl+f", "ctrl+q", "ctrl+c"] as const;
const photoKey = (message: ChatMessage): string => `${message.chat_id}:${message.id}:${message.media_id ?? "none"}`;
/** Incoming messages in a followed open chat count as read only after recent user input. */
const PRESENCE_MS = 60_000;
type Stage = "credentials" | "phone" | "code" | "password" | "chats" | "logout";
const COPY: Record<Stage, { title: string; hint: string; submit: string }> = {
  credentials: { title: "Connect Telegram", hint: "Terngram is an unofficial client using the Telegram API. Use your own application's API ID and API hash from my.telegram.org/apps.", submit: "Connect" },
  phone: { title: "Sign in", hint: "Enter your phone number with its country code.", submit: "Request code" },
  code: { title: "Login code", hint: "Check Telegram on your other device. You can go back to request another code.", submit: "Sign in" },
  password: { title: "Two-step verification", hint: "Your password is masked and never stored.", submit: "Unlock" },
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
  describe(): NativeNode { return this.description ??= this.app.describeBody(); }
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
  private phone: Field;
  private code: Field;
  private password: Field;
  private composer: Editor;

  constructor(private tui: TUI, private python: string, private dataDir: string, private root: string, private exit: () => Promise<void>) {
    const changed = () => this.redraw();
    const disabled = () => this.busy;
    this.apiId = new Field("API ID", false, changed, disabled);
    this.apiHash = new Field("API hash (hidden)", true, changed, disabled);
    this.phone = new Field("+country code and phone number", false, changed, disabled);
    this.code = new Field("Telegram login code", true, changed, disabled);
    this.password = new Field("Telegram two-step password", true, changed, disabled);
    for (const field of [this.apiId, this.apiHash, this.phone, this.code, this.password]) field.onSubmit = () => { void this.submit(); };
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
      this.redraw(false);
    };
    this.composer.onSubmit = text => {
      const thread = this.currentThread();
      if (thread) thread.draft = text;
      this.setComposer(text);
      void this.send(text);
    };
    this.telegram = this.newConnection();
    this.tui.addInputListener(data => this.intercept(data));
  }

  private newConnection(): Telegram {
    const connection = new Telegram(this.python, this.dataDir, this.root, this.cooldowns);
    connection.onUpdate = update => { if (this.telegram === connection && !this.quitting) this.receive(update); };
    connection.onStatus = connected => {
      if (this.telegram !== connection || this.quitting) return;
      this.online = connected;
      if (!connected) this.clearTransient();
      if (connected && this.stage === "chats" && !this.busy) void this.refresh();
      if (connected && this.stage === "chats" && this.selectedId !== null) this.activityCall("select_peer", [this.selectedId]);
      this.redraw();
    };
    connection.onFailure = message => {
      if (this.telegram !== connection || this.quitting) return;
      this.online = false; this.clearTransient(); this.fail(message);
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
    if (Number.isFinite(next)) this.transientTimer = setTimeout(() => { this.expireTransient(); this.redraw(false); }, Math.max(1, next - Date.now()));
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
    this.composer.disableSubmit = this.busy || this.selectedId === null || this.selectedDialog()?.writable === false || !!this.currentThread()?.sending;
    if (this.stage === "chats" && this.composer.focused && this.selectedDialog()?.writable === false) this.tui.setFocus(this);
    this.palette?.setItems(this.paletteItems());
    this.palette?.setLoading(this.loadingMoreChats);
    this.forwardPicker?.setLoading(this.loadingMoreChats);
    if (body) this.body.invalidate();
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
      case "phone": return [this.phone];
      case "code": return [this.code];
      case "password": return [this.password];
      case "chats": return this.selectedId !== null && this.selectedDialog()?.writable !== false ? [this, this.composer] : [this];
      case "logout": return [this];
    }
  }
  private async perform(status: string, action: () => Promise<void>): Promise<void> {
    if (this.busy || this.quitting) return;
    this.busy = true; this.error = false; this.status = status; this.redraw();
    try { await action(); }
    catch (error) { this.fail(error); }
    finally { this.busy = false; this.redraw(); this.focusDefault(); }
  }
  async start(): Promise<void> {
    await this.perform("Checking account…", async () => {
      if (!await this.telegram.call<boolean>("has_credentials")) {
        this.status = "Credentials stay in your private data directory, not in this project."; return;
      }
      await this.connected(await this.telegram.call<boolean>("connect"));
    });
  }
  private async connected(authorized: boolean): Promise<void> {
    if (!authorized) { this.clearAccount(); this.stage = "phone"; this.status = "Sign in to your Telegram account."; return; }
    this.account = await this.telegram.call<string>("me");
    const [page, state] = await Promise.all([
      this.telegram.call<DialogPage>("dialogs"),
      this.telegram.call<ClientState>("load_state"),
    ]);
    this.dialogs = page.dialogs; this.dialogCursor = page.cursor;
    for (const [key, draft] of Object.entries(state.drafts)) {
      const id = Number(key);
      if (!this.threads.has(id)) this.thread(id).draft = draft;
    }
    for (const [key, pending] of Object.entries(state.pending_sends)) {
      this.thread(Number(key)).pendingSend ??= pending;
    }
    this.stage = "chats"; this.online = true; this.error = false; this.status = "";
    const selected = this.selectedId ?? state.selected_id;
    if (selected !== null) {
      if (!this.dialogs.some(dialog => dialog.id === selected)) {
        const dialog = await this.telegram.call<Dialog | null>("dialog", [selected]);
        if (dialog) this.dialogs.push(dialog);
      }
      if (this.dialogs.some(dialog => dialog.id === selected)) await this.selectChat(selected);
      if (this.selectedId !== null) this.activityCall("select_peer", [this.selectedId]);
    }
  }
  private async submit(): Promise<void> {
    if (this.stage === "chats") { await this.send(this.composer.getText()); return; }
    await this.perform("Connecting to Telegram…", async () => {
      switch (this.stage) {
        case "credentials": {
          const id = Number(this.apiId.getValue()); const hash = this.apiHash.getValue().trim(); this.apiHash.setValue("");
          await this.connected(await this.telegram.call<boolean>("connect", [id, hash])); return;
        }
        case "phone": await this.telegram.call("request_code", [this.phone.getValue()]); this.stage = "code"; this.status = "Code requested. Check Telegram."; return;
        case "code": {
          const code = this.code.getValue(); this.code.setValue("");
          if (await this.telegram.call<boolean>("sign_in_code", [code])) await this.connected(true);
          else { this.stage = "password"; this.status = "Enter your two-step verification password."; }
          return;
        }
        case "password": {
          const password = this.password.getValue(); this.password.setValue("");
          await this.telegram.call("sign_in_password", [password]); await this.connected(true); return;
        }
        case "logout":
          clearTimeout(this.persistTimer); await this.persistChain;
          await this.telegram.call("logout"); this.clearAccount(); this.stage = "phone"; this.status = "This client's session was revoked."; return;
      }
    });
  }
  private clearAccount(): void {
    this.clearTransient();
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
    this.dialogs = []; this.selectedId = null; this.account = ""; this.online = false;
    this.actionMessage = this.deleteConfirm = null; this.setComposer("");
    this.phone.setValue(""); this.code.setValue(""); this.password.setValue("");
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
    if (!this.dialogs.some(dialog => dialog.id === id) || this.quitting) return;
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
    if (update.kind === "presence") {
      this.dialogs = this.dialogs.map(dialog => dialog.id === update.chat_id ? { ...dialog, presence: update.presence } : dialog);
      this.expireTransient(); this.redraw(false); return;
    }
    if (update.kind === "typing") {
      if (!this.online || this.stage !== "chats") return;
      let actions = this.transientActions.get(update.chat_id);
      if (!actions) { actions = new Map(); this.transientActions.set(update.chat_id, actions); }
      const labels: Record<string, string> = {
        SendMessageTypingAction: "typing…", SendMessageRecordAudioAction: "recording voice…",
        SendMessageUploadAudioAction: "sending voice…", SendMessageRecordVideoAction: "recording video…",
        SendMessageUploadVideoAction: "sending video…", SendMessageUploadPhotoAction: "sending photo…",
        SendMessageUploadDocumentAction: "sending file…", SendMessageChooseStickerAction: "choosing sticker…",
        SendMessageRecordRoundAction: "recording video message…", SendMessageUploadRoundAction: "sending video message…",
        SendMessageGeoLocationAction: "sharing location…", SendMessageChooseContactAction: "choosing contact…",
        SendMessageGamePlayAction: "playing game…", SpeakingInGroupCallAction: "speaking in call…",
      };
      if (update.action === "SendMessageCancelAction") actions.delete(update.sender_id);
      else actions.set(update.sender_id, { sender: update.sender, action: labels[update.action] ?? "active…", until: Date.now() + 6_000 });
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
      for (const [id, thread] of this.threads) {
        if (id === update.chat_id || (update.chat_id === 0 && id > -1000000000000)) {
          const affected = thread.messages.some(message => ids.has(message.id)) || this.dialogs.some(dialog => dialog.id === id && dialog.last_message_id !== null && ids.has(dialog.last_message_id));
          for (const message of thread.messages) if (ids.has(message.id)) this.invalidatePhoto(message);
          thread.remove(update.ids);
          this.readers.invalidateChat(id);
          if (affected) void this.refreshDialog(id);
        }
      }
      if (this.currentThread()) this.setComposer(this.currentThread()!.draft);
      if (this.photoGroup && (this.photoGroup.chat_id === update.chat_id || (update.chat_id === 0 && this.photoGroup.chat_id > -1000000000000))) {
        const remaining = this.albumMembers(this.photoGroup).filter(message => !ids.has(message.id));
        if (remaining.length) void this.viewPhoto(remaining[0]!, true); else this.closePhoto();
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
    if (previous && previous.media_id !== message.media_id) this.invalidatePhoto(previous);
    const isNew = thread.receive(message);
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
    for (const group of this.thread(id).groups) {
      const photos = group.filter(message => message.photo);
      for (const message of photos.slice(0, 4)) {
        const key = photoKey(message);
        this.previews.request(key, async () => {
          const photo = await this.telegram.call<Photo | null>("photo", [id, message.id, true]);
          return photo ? base64ImageNode(photo.data, photo.mime, {
            alt: "Photo preview", title: "Open full photo",
            max: { w: "32ch", h: "10lines" },
            actions: { click: `photo:${message.id}` },
          }, `preview-${key}`) : null;
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
        if (page.cursor && page.cursor.id === cursor.id && page.cursor.date === cursor.date && page.cursor.peer_id === cursor.peer_id) throw new Error("Telegram dialog pagination did not advance.");
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
    await this.perform("Reconnecting…", async () => {
      this.clearTransient();
      await this.persist(); this.generation++; this.receipts.clear(); this.readers.clear(); this.participantCounts.clear(); this.resolvedAlbums.clear(); this.peerNames.clear();
      await this.telegram.close(); this.telegram = this.newConnection();
      await this.connected(await this.telegram.call<boolean>("connect"));
      if (this.selectedId !== null) await this.loadHistory(this.selectedId, false, true);
    });
  }

  private async send(text: string): Promise<void> {
    const id = this.selectedId;
    if (id === null || !text.trim() || this.selectedDialog()?.writable === false || this.busy) return;
    const thread = this.thread(id);
    if (thread.sending) return;
    this.stopTyping();
    const generation = this.generation;
    const editing = thread.editing;
    const replyTo = thread.replyTo;
    const previousAttempt = thread.pendingSend;
    let submitted = false;
    if (!editing && (thread.pendingSend?.text !== text || thread.pendingSend.reply_to !== replyTo)) {
      const randomId = (crypto.getRandomValues(new BigUint64Array(1))[0]! >> 1n) || 1n;
      thread.pendingSend = { text, reply_to: replyTo, random_id: String(randomId) };
    }
    const attempt = thread.pendingSend;
    thread.sending = true; this.error = false; this.status = ""; this.redraw(false);
    try {
      if (!editing) await this.persist(true); // Commit retry identity before the request can reach Telegram.
      if (generation !== this.generation) return;
      submitted = true;
      const message = editing
        ? await this.telegram.call<ChatMessage>("edit", [id, editing.id, text])
        : await this.telegram.call<ChatMessage>("send", [id, text, replyTo, attempt!.random_id]);
      if (generation !== this.generation || this.threads.get(id) !== thread) return;
      this.receive({ kind: "message", chat_id: id, message });
      if (!editing && thread.pendingSend === attempt) thread.pendingSend = null;
      if (thread.draft === text && thread.editing === editing && thread.replyTo === replyTo) {
        if (editing) thread.cancelEdit();
        else { thread.draft = ""; thread.replyTo = null; }
        if (this.selectedId === id) this.setComposer(thread.draft);
      }
      if (!editing && this.selectedId === id) this.jumpBottom();
      this.schedulePersist();
    } catch (error) {
      if (generation === this.generation) {
        if (!submitted && thread.pendingSend === attempt) thread.pendingSend = previousAttempt;
        this.fail(error);
      }
    }
    finally { thread.sending = false; this.redraw(false); }
  }
  private jumpBottom(): void {
    if (this.selectedId === null) return;
    const id = this.selectedId;
    const thread = this.thread(id);
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
    const request = { intent: background ? this.photoIntent : ++this.photoIntent };
    this.photoLoading.set(key, request); this.redraw();
    try {
      if (message.grouped_id !== null && !this.resolvedAlbums.has(key)) {
        const thread = this.thread(message.chat_id);
        const started = thread.revision;
        const album = await this.telegram.call<ChatMessage[]>("album", [message.chat_id, message.id]);
        if (generation !== this.generation) return;
        thread.applyPage(album, started);
        this.resolvedAlbums.add(key);
        this.queuePreviews(message.chat_id);
      }
      let members: ChatMessage[];
      for (;;) {
        if (request.intent !== this.photoIntent || this.selectedId !== message.chat_id || this.quitting) return;
        members = this.albumMembers(message).filter(item => item.photo);
        const missing = members.filter(item => !this.photoNodes.has(photoKey(item)));
        if (!missing.length) break;
        await Promise.all(missing.map(async item => {
          const imageKey = photoKey(item);
          const photo = await this.telegram.call<Photo>("photo", [item.chat_id, item.id]);
          if (generation !== this.generation || this.thread(item.chat_id).getMessage(item.id)?.media_id !== item.media_id) return;
          this.photoNodes.set(imageKey, base64ImageNode(photo.data, photo.mime, { alt: "Telegram photo", max: { w: "80ch", h: "28lines" } }, `full-photo-${item.chat_id}:${item.id}`));
        }));
        if (generation !== this.generation) return;
      }
      if (request.intent !== this.photoIntent || this.selectedId !== message.chat_id || this.quitting) return;
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
    } catch (error) { if (generation === this.generation && request.intent === this.photoIntent) this.fail(error); }
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
        void this.send(this.composer.getText()); return { consume: true };
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
      if (next === this && this.stage === "chats" && this.actionMessage === null) this.actionMessage = this.currentThread()?.groups.at(-1)?.[0]?.id ?? null;
      this.loadReaders();
      this.redraw(); return { consume: true };
    }
    return undefined;
  }
  handleInput(data: string): void {
    if (this.busy) return;
    if (this.stage === "logout" && matchesKey(data, "enter")) { void this.submit(); return; }
    if (this.stage !== "chats") return;
    const groups = this.currentThread()?.groups ?? [];
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const up = matchesKey(data, "up");
      const current = groups.findIndex(group => group.some(message => message.id === this.actionMessage));
      // The first loaded message is the keyboard edge of history; there is no viewport position to observe.
      if (up && current === 0 && this.selectedId !== null) void this.loadHistory(this.selectedId, true);
      const index = current < 0 ? groups.length - 1 : Math.max(0, Math.min(groups.length - 1, current + (up ? -1 : 1)));
      this.actionMessage = groups[index]?.[0]?.id ?? null;
      if (index !== groups.length - 1 && this.selectedId !== null) this.detached.add(this.selectedId);
      this.loadReaders();
      this.redraw();
      return;
    }
    const message = this.chosenMessage();
    if (!message) return;
    if (matchesKey(data, "enter") || matchesKey(data, "r")) this.reply(message);
    else if (matchesKey(data, "e")) this.edit(message);
    else if (matchesKey(data, "f")) this.openForwardPicker(message);
    else if (matchesKey(data, "p") && message.photo) void this.viewPhoto(message);
    else if ((matchesKey(data, "x") || matchesKey(data, "backspace") || matchesKey(data, "delete")) && message.outgoing) { this.deleteConfirm = message.id; this.redraw(); }
  }
  handleNativeEvent(event: NativeUiEvent): void {
    if (this.quitting || this.busy) return;
    this.lastInput = Date.now();
    this.userActivity();
    if (event.type !== "action") return;
    const [action, value] = event.act.split(":");
    if (action === "chat") { void this.selectChat(Number(value)); return; }
    if (action === "message" || action === "reply-message" || action === "photo") {
      const message = this.currentThread()?.messages.find(item => item.id === Number(value));
      if (!message) return;
      if (action === "message") {
        if (!this.currentThread()?.groups.at(-1)?.some(item => item.id === message.id)) this.detached.add(message.chat_id);
        this.actionMessage = message.id; this.deleteConfirm = null; this.tui.setFocus(this); this.loadReaders(); this.redraw();
      }
      else if (action === "reply-message") this.reply(message);
      else void this.viewPhoto(message);
      return;
    }
    const chosen = this.chosenMessage();
    switch (event.act) {
      case "submit": void this.submit(); break;
      case "send": void this.send(this.composer.getText()); break;
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
      case "logout": this.stopTyping(); this.stage = "logout"; this.redraw(); this.tui.setFocus(this); break;
      case "cancel": this.stage = "chats"; this.redraw(); this.focusDefault(); break;
      case "back": this.stage = "phone"; this.code.setValue(""); this.password.setValue(""); this.redraw(); this.focusDefault(); break;
      case "credentials": this.stage = "credentials"; this.redraw(); this.focusDefault(); break;
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
  describeBody(): NativeNode {
    const title: NativeNode = { k: "text", key: "title", p: { spans: [{ t: "terngram", s: "strong accent" }] } };
    if (this.stage !== "chats") {
      const copy = COPY[this.stage];
      return { k: "col", key: "login", p: { gap: "md" }, c: [title,
        { k: "card", key: "welcome", p: { head: copy.title, tone: "accent" }, c: [
          label(copy.hint),
          { k: "text", key: "api-tools", p: { text: "Telegram API development tools", href: "https://my.telegram.org/apps", actions: { click: "open" }, tone: "info" } },
          label("Credentials and session stay in private local files. Never share account.session."),
        ] },
      ] };
    }
    return { k: "col", key: "client", p: { role: "terngram.client", gap: "sm", min: { w: 0 }, max: { w: 1 } }, c: [
      ...(this.selectedId === null ? [label("Ctrl+K opens chats and commands. Ctrl+G shows keyboard shortcuts.", "empty")] : []),
      ...[...this.threads].filter(([id, state]) => id === this.selectedId || state.loaded || state.loading || state.messages.length > 0).map(([id, state]): NativeNode => ({ k: "col", key: `thread-${id}`, scroll: this.scrolls.get(id), p: { hidden: id !== this.selectedId, gap: "sm" }, c: [
        ...(state.more && state.messages.length ? [button("older", state.loading ? "Loading earlier messages…" : "Load earlier messages", state.loading)] : []),
        ...(!state.messages.length ? [label(state.loading ? "Loading messages…" : state.loaded ? "No messages in this chat." : "Messages are not loaded. Refresh to try again.", "empty")] : state.groups.map(group => this.messageNode(group, state))),
        { k: "text", key: `tail-${this.scrolls.get(id)?.by === "end" ? this.scrolls.get(id)!.n : 0}`, reveal: this.scrolls.get(id)?.by === "end" ? "end" : undefined, p: { text: "" } },
      ] })),
    ] };
  }
  describe(): NativeNode {
    if (this.stage === "chats") {
      const selected = this.chosenMessage();
      return describeChatDock({
        dialog: this.selectedDialog(), thread: this.currentThread(), selected,
        participantsCount: this.selectedId === null ? undefined : this.participantCounts.get(this.selectedId),
        peerNames: this.peerNames,
        incomingActions: this.incomingActions(),
        messageFocus: this.focused, deleting: this.deleteConfirm !== null,
        showHints: this.showContextHints,
        operating: !!selected && this.messageOperations.has(`${selected.chat_id}:${selected.id}`),
        online: this.online, busy: this.busy, status: this.status, error: this.error, editor: this.composer,
      });
    }
    const controls = [button("submit", COPY[this.stage].submit, this.busy)];
    if (this.stage === "logout") controls.push(button("cancel", "Cancel · Esc", this.busy));
    else if (this.stage === "phone") controls.push(button("credentials", "Change API credentials", this.busy));
    else if (this.stage === "code" || this.stage === "password") controls.push(button("back", "Back / request new code", this.busy));
    controls.push(button("quit", "Quit"));
    return { k: "col", key: "dock", p: { gap: "sm" }, c: [
      ...this.fields().filter(field => field !== this),
      { k: "row", key: "controls", p: { gap: "sm", wrap: true }, c: controls },
      ...(this.busy ? [{ k: "spinner" as const, key: "busy", p: { label: "Telegram" } }] : []),
      { k: "text", key: "status", p: { text: this.status, tone: this.error ? "error" : "muted", wrap: "word" } },
      label("Tab: next field · Enter: submit · Ctrl+G: keys · Ctrl+Q: quit", "keys"),
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
    this.clearTransient();
    clearTimeout(this.persistTimer); clearTimeout(this.readerTimer); await this.persist();
    this.avatars.clear(); this.previews.clear(); this.receipts.clear(); this.readers.clear();
    this.closeHelp(); this.closePalette(); this.closePhoto(); this.closeForwardPicker(); this.apiHash.setValue(""); this.password.setValue(""); this.code.setValue("");
    await this.telegram.close(); await this.exit();
  }
}
