import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { NativeBackend, type NativeHost, type NativeOverlay } from "@oh-my-pi/pi-tui/native/backend";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { encodeTspJson, splitTspMessage } from "@oh-my-pi/pi-tui/native/encode";
import type { Component, TUI } from "@oh-my-pi/pi-tui/tui";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import type { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { TSP_KINDS, type TspFrame, type TspNode, type TspOpen } from "@oh-my-pi/pi-wire";
import { TerngramApp } from "./terngram/ui/app";
import { ChatState } from "./terngram/ui/chat-state";
import { TelegramRequestError } from "./terngram/ui/telegram";
import type { RequestCooldowns } from "./terngram/ui/request-cooldowns";
import type { Authorization, ChatMessage, ClientState, Dialog, DialogCursor, DialogPage, PendingSend, Photo, Telegram } from "./terngram/ui/telegram";

interface SmokeClient extends Pick<TerngramApp, "stage" | "account" | "dialogs" | "selectedId" | "busy" | "status" | "handleNativeEvent" | "describeSurface" | "invalidate" | "quit"> {
  telegram: Telegram;
  cooldowns: RequestCooldowns;
  composer: Editor;
  password: { getValue(): string };
  online: boolean;
  activityChain: Promise<void>;
  transientTimer?: NodeJS.Timeout;
  refresh(): Promise<void>;
  connected(): Promise<void>;
  thread(id: number): ChatState;
  selectChat(id: number): Promise<void>;
  send(text: string): Promise<void>;
  markRead(id: number): Promise<void>;
  scroll(by: "page-up"): void;
  viewPhoto(message: ChatMessage): Promise<void>;
  closePhoto(): void;
  persist(): Promise<void>;
  loadHistory(id: number, older: boolean, refresh: boolean): Promise<void>;
  moreChats(): Promise<boolean>;
  refreshDialogs(): Promise<void>;
  refreshDialog(id: number): Promise<void>;
  dialogCursor: DialogCursor | null;
  intercept(data: string): { consume: true } | undefined;
}
const directory = await mkdtemp(join(tmpdir(), "terngram-smoke-"));
const python = process.env.TERNGRAM_SMOKE_PYTHON ?? Bun.spawnSync(["uv", "run", "python", "-c", "import sys; print(sys.executable)"]).stdout.toString().trim();
// These are genuine PNG QR codes encoding offline fixture labels, not Telegram login links.
const qrFixtureProcess = Bun.spawnSync([python, "-c", `
import base64, io, json, qrcode
photos = []
for rotation in (1, 2):
    code = qrcode.QRCode(version=3, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=3, border=4)
    code.add_data(f"terngram-offline-native-qr-fixture-{rotation}", optimize=0)
    code.make(fit=False)
    image = code.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    photos.append({"data": base64.b64encode(buffer.getvalue()).decode(), "mime": "image/png", "width": image.size[0], "height": image.size[1]})
print(json.dumps(photos))
`]);
assert.equal(qrFixtureProcess.exitCode, 0, qrFixtureProcess.stderr.toString());
const qrFixtures = JSON.parse(qrFixtureProcess.stdout.toString()) as [Photo, Photo];
for (const photo of qrFixtures) {
  const bytes = Buffer.from(photo.data, "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.readUInt32BE(16), photo.width);
  assert.equal(bytes.readUInt32BE(20), photo.height);
}
let focus: (Component & { focused?: boolean }) | null = null;
const renders = new EventEmitter();
const overlays: NativeOverlay[] = [];
const writes: { verb: string; body: string; params: Record<string, string> }[] = [];
const frames: TspFrame[] = [];
const documents = new Map<string, TspDocument>();
const chunks = new Map<string, string[]>();
const transport = {
  columns: 110, rows: 40, appearance: "dark",
  setTitle() {},
  write(data: string) {
    for (const sequence of data.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)) {
      const decoded = splitTspMessage(sequence[0]);
      if (!decoded) continue;
      let body = decoded.body;
      if (decoded.params.c) {
        const key = `${decoded.verb}:${decoded.params.c}`;
        const parts = chunks.get(key) ?? [];
        parts.push(body);
        if (decoded.params.m === "1") { chunks.set(key, parts); continue; }
        body = parts.join(""); chunks.delete(key);
      }
      writes.push({ verb: decoded.verb, body, params: decoded.params });
      if (decoded.verb === "o") {
        const surface = JSON.parse(body) as TspOpen;
        documents.set(surface.id, new TspDocument(surface.id));
      }
      if (decoded.verb === "f") {
        const frame = JSON.parse(body) as TspFrame;
        frames.push(frame);
        assert.deepEqual(documents.get(frame.sf)!.applyFrame(frame), [], "native document must accept every frame op");
      }
    }
  },
};
// The harness implements only terminal methods used by NativeBackend, without taking over a user's terminal.
const terminal = transport as unknown as Terminal;
const ui = {
  addInputListener() {}, requestRender() { renders.emit("render"); },
  setFocus(component: Component & { focused?: boolean }) { if (focus) focus.focused = false; focus = component; focus.focused = true; },
  showOverlay(component: Component) {
    const entry: NativeOverlay = { component, options: undefined, focused: true };
    overlays.push(entry); ui.setFocus(component);
    return { hide() { const index = overlays.indexOf(entry); if (index >= 0) overlays.splice(index, 1); } };
  },
};
// UI scheduling/focus is controlled by the harness; actual native reconciliation and wire application are not mocked.
const nativeUi = ui as unknown as TUI;
const client = new TerngramApp(nativeUi, python, directory, process.cwd(), async () => {});
// Private access creates isolated deterministic chat state; it never loads credentials or a user's account.
const app = client as unknown as SmokeClient;
const actualCall = app.telegram.call.bind(app.telegram);
const message = (id: number, chat_id: number, text: string, outgoing = false): ChatMessage => ({
  id, chat_id, text, markdown: text, entities: [], sender_id: outgoing ? 1001 : 1002, outgoing, sender: outgoing ? "You" : "Alice", time: "2026-10-03 12:00", reply_to: null, edited: false, photo: false, media_id: null, forwarded: null, read: false, grouped_id: null,
});
const dialog = (id: number, title: string): Dialog => ({ id, title, kind: "user", unread_count: 0, preview: "Initial", writable: true, last_message_id: 10 });
const { promise: sendResult, resolve: releaseSend } = Promise.withResolvers<ChatMessage>();
const { promise: historyResult, resolve: releaseHistory } = Promise.withResolvers<ChatMessage[]>();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
const historyLimits: number[] = [];
const historyRequests: unknown[][] = [];
const forwards: unknown[][] = [];
const reads: unknown[][] = [];
const receiptGate = Promise.withResolvers<void>();
const pendingAvatars: Array<{ resolve(value: Photo | null): void }> = [];
let avatarRequests = 0, maxAvatarRequests = 0;
let failNextSend = false;
let failNextSave = false;
let dialogPageGate: Promise<DialogPage> | undefined;
let dialogGate: Promise<Dialog | null> | undefined;
const photoRequests: unknown[][] = [];
const sendAttempts: unknown[][] = [];
const retries: unknown[][] = [];
const retryStarts = new EventEmitter();
const retriedNativeIds: number[] = [];
const nativeFailedMessages = new Map<number, ChatMessage>();
let retryGate = Promise.withResolvers<void>();
let reconciliationStatus: "uncertain" | "failed" = "uncertain";
const fixtureAdmissions = new Map<string, PendingSend>();
let fixtureToken = 0;
let realSendPreparation = false;
let confirmNextSend = false;
const queuedMessageId = 2 ** 40;
const failedMessageId = queuedMessageId + 1;
let participantCount = 42;
const rpcCalls: { method: string; args: unknown[] }[] = [];
const delayedPhotos = new Map<number, ReturnType<typeof Promise.withResolvers<Photo>>>();
const delayedPreviewPhotos = new Map<number, { promise: Promise<Photo> }>();
let authorization: Authorization = { state: "credentials" };
app.telegram.call = <T>(method: string, args: unknown[] = []): Promise<T> => {
  rpcCalls.push({ method, args });
  let result: Promise<unknown>;
  if (method === "connect" || method === "auth_state" || method === "request_qr") result = Promise.resolve(authorization);
  else if (method === "sign_in_password") {
    assert.deepEqual(args, ["offline-fixture-password"]);
    authorization = { state: "ready" };
    app.telegram.onUpdate!({ kind: "authorization", authorization });
    result = Promise.resolve(authorization);
  }
  else if (method === "me") result = Promise.resolve("Smoke account");
  else if (method === "prepare_send") {
    result = realSendPreparation ? actualCall(method, args) : Promise.resolve({
      chat_id: Number(args[0]), text: String(args[1]), reply_to: args[2] as number | null,
      token: String(++fixtureToken), status: "queued",
    } satisfies PendingSend);
  }
  else if (method === "send") {
    sendAttempts.push(args);
    const chat_id = Number(args[0]), token = String(args[3]);
    assert(/^[1-9][0-9]*$/.test(token) && Number(token) <= 0x7fffffff, "client send intent is a positive int32 decimal token");
    if (realSendPreparation) result = actualCall(method, args);
    else if (confirmNextSend) {
      confirmNextSend = false;
      const sent = message(3000 + sendAttempts.length, chat_id, String(args[1]), true);
      app.telegram.onUpdate!({ kind: "send_state", chat_id, token, status: "sent", message_id: sent.id, message: sent });
      result = Promise.resolve(sent);
    } else if (failNextSend) {
      failNextSend = false;
      fixtureAdmissions.set(token, { ...app.thread(chat_id).pendingSend!, status: "uncertain" });
      app.telegram.onUpdate!({ kind: "send_state", chat_id, token, status: "uncertain", error: "Delivery uncertain" });
      result = Promise.reject(new TelegramRequestError("send", "[SEND_UNCERTAIN] Delivery uncertain"));
    } else {
      assert.equal(args[1], "First message", "new sends cannot silently replace an unresolved fixture attempt");
      fixtureAdmissions.set(token, { ...app.thread(chat_id).pendingSend!, status: "queued", message_id: queuedMessageId });
      app.telegram.onUpdate!({ kind: "send_state", chat_id, token, status: "queued", message_id: queuedMessageId, message: { ...message(queuedMessageId, chat_id, String(args[1]), true), sending_state: "queued" } });
      result = sendResult.then(sent => { if (!sent.sending_state) fixtureAdmissions.delete(token); return sent; });
    }
  }
  else if (method === "reconcile_send") {
    const pending = app.thread(Number(args[0])).pendingSend!;
    assert.equal(args[1], pending.token);
    const status = pending.status === "queued" ? "queued" : reconciliationStatus;
    const reconciled = { ...pending, status, ...(status === "failed" ? { message_id: pending.message_id ?? failedMessageId } : {}), ...(status !== "queued" ? { error: status === "failed" ? "Offline confirmed send failure" : "Delivery still uncertain; no resend" } : {}) };
    fixtureAdmissions.set(pending.token, reconciled);
    const failed = status === "failed" ? nativeFailedMessages.get(reconciled.message_id!) ?? { ...message(reconciled.message_id!, pending.chat_id, pending.text, true), sending_state: "failed" as const } : undefined;
    if (failed) nativeFailedMessages.set(failed.id, failed);
    app.telegram.onUpdate!({ kind: "send_state", chat_id: reconciled.chat_id, token: reconciled.token, status: reconciled.status, message_id: reconciled.message_id, error: reconciled.error, ...(failed ? { message: failed } : {}) });
    result = Promise.resolve(reconciled);
  }
  else if (method === "adopt_failed_send") {
    const source = nativeFailedMessages.get(Number(args[1]))!;
    assert(source?.chat_id === Number(args[0]) && source.outgoing && source.sending_state === "failed", "adoption addresses the exact existing native failed message, not a visual anchor");
    const pending: PendingSend = { chat_id: source.chat_id, message_id: source.id, text: source.text, reply_to: source.reply_to, token: String(++fixtureToken), status: "failed" };
    result = readFile(join(directory, "tdlib", "state.json"), "utf8").then(async raw => {
      const state = JSON.parse(raw) as ClientState;
      assert(!state.pending_sends[String(source.chat_id)], "adoption cannot replace an unresolved intent");
      await actualCall("save_state", [{ ...state, pending_sends: { ...state.pending_sends, [String(source.chat_id)]: pending } }]);
      fixtureAdmissions.set(pending.token, pending);
      return pending;
    });
  }
  else if (method === "retry_send") {
    retries.push(args);
    const pending = app.thread(Number(args[0])).pendingSend!;
    assert.equal(args[1], pending.token);
    assert.equal(pending.status, "failed");
    const source = nativeFailedMessages.get(pending.message_id!);
    assert(source?.chat_id === pending.chat_id && source.outgoing && source.sending_state === "failed", "only the exact confirmed failed TDLib local message is eligible for explicit retry");
    retriedNativeIds.push(source.id);
    const sent = { ...source, id: 1000, sending_state: undefined };
    result = Promise.all([readFile(join(directory, "tdlib", "state.json"), "utf8"), retryGate.promise]).then(([raw]) => {
      const state = JSON.parse(raw) as ClientState;
      assert.equal(state.pending_sends[String(pending.chat_id)]?.token, pending.token, "retry requires its intent to be durably persisted first");
      fixtureAdmissions.delete(pending.token);
      app.telegram.onUpdate!({ kind: "send_state", chat_id: pending.chat_id, token: pending.token, status: "sent", message_id: sent.id, message: sent });
      return sent;
    });
    retryStarts.emit("start");
  }
  else if (method === "history") {
    historyLimits.push(Number(args[2])); historyRequests.push(args);
    result = args[0] === 2 ? historyResult : Promise.resolve(args[0] === 1 ? app.thread(1).messages.slice(-50) : []);
  } else if (method === "mark_read") { reads.push(args); result = args[0] === 77 && args[1] === 1 ? receiptGate.promise : Promise.resolve(); }
  else if (method === "forward") { forwards.push(args); result = Promise.resolve([]); }
  else if (method === "dialogs") result = dialogPageGate ?? Promise.resolve({ dialogs: args.length ? [dialog(1, "Alice"), dialog(3, "Carol")] : app.dialogs.slice(0, 60), cursor: null });
  else if (method === "photo") {
    photoRequests.push(args);
    const delayed = (args[2] === true ? delayedPreviewPhotos : delayedPhotos).get(Number(args[1]));
    result = delayed?.promise ?? Promise.resolve({ data: png, mime: "image/png", width: 1, height: 1 });
  }
  else if (method === "chat_info") result = Promise.resolve({ participants_count: args[0] === 1 ? participantCount : null });
  else if (method === "message_readers") result = Promise.resolve(3);
  else if (method === "album") {
    const thread = app.thread(Number(args[0]));
    const source = thread.getMessage(Number(args[1]))!;
    result = Promise.resolve(thread.messages.filter(item => source.grouped_id === null ? item.id === source.id : item.grouped_id === source.grouped_id));
  }
  else if (method === "avatar") {
    const pending = Promise.withResolvers<Photo | null>();
    pendingAvatars.push(pending);
    avatarRequests++; maxAvatarRequests = Math.max(maxAvatarRequests, avatarRequests);
    result = pending.promise.finally(() => { avatarRequests--; });
  } else if (method === "dialog") result = dialogGate ?? Promise.resolve(app.dialogs.find(item => item.id === args[0]) ?? null);
  else if (method === "save_state" && failNextSave) { failNextSave = false; result = Promise.reject(new Error("Disk unavailable")); }
  else if (method === "load_state" && fixtureAdmissions.size) {
    // Native sends use an offline TDLib transport; preserve its admission evidence rather
    // than asking the unrelated real worker to classify those fixture intents as orphans.
    result = readFile(join(directory, "tdlib", "state.json"), "utf8").then(raw => {
      const state = JSON.parse(raw) as ClientState;
      for (const pending of fixtureAdmissions.values())
        assert.equal(state.pending_sends[String(pending.chat_id)]?.token, pending.token, "the fixture admission cannot invent a missing durable UI intent");
      return state;
    });
  }
  else if (method === "activity" || method === "select_peer" || method === "typing") result = Promise.resolve();
  else {
    assert(["save_state", "load_state"].includes(method), `unmocked account RPC: ${method}`);
    result = actualCall(method, args);
  }
  // These fixture results have the same method contracts as Telegram; requests that touch local state use the real worker.
  return result as Promise<T>;
};
app.dialogs = [{ ...dialog(1, "Alice"), kind: "group" }, dialog(2, "Bob")];
const alice = app.thread(1); alice.applyPage([message(10, 1, "Initial")], 0);
const host: NativeHost = {
  terminal, describeSurface: () => app.describeSurface(), overlays: () => overlays,
  focused: () => focus, focusFromPointer: owners => { if (owners[0]) ui.setFocus(owners[0]); }, requestRender() {},
  appearanceChanged() {}, motionChanged() {}, invalidate: () => app.invalidate(),
};
const backend = new NativeBackend(host, { r: "hello", v: 1, term: "smoke", kinds: TSP_KINDS, features: ["scroll"], credits: 1000, cols: 110 }, { mirror: true, recordPath: "", surfaceMode: "screen" });
function draw() {
  backend.render();
  for (const frame of frames) backend.handleInput(encodeTspJson("e", { ev: "ack", sf: frame.sf, s: frame.s }));
}
function nodes(node: TspNode): TspNode[] { return [node, ...(node.c ?? []).flatMap(nodes)]; }
function snapshot() {
  const surfaceId = backend.document()!.id;
  return nodes(documents.get(surfaceId)!.snapshot());
}
function action(act: string) { app.handleNativeEvent({ type: "action", key: "", act, mods: [] }); }
function assertCompactSendProgress() {
  const tree = snapshot();
  const composer = tree.find(node => node.p?.role === "terngram.composer");
  assert(composer, "pending delivery retains native composer controls");
  assert((composer.c ?? []).some(node => node.k === "spinner"), "native sending progress sits beside the composer and Send control");
  assert(nodes(composer).some(node => node.p?.actions?.click === "send"), "compact progress shares the Send control surface");
  assert(!tree.some(node => node.k === "card" && nodes(node).some(child => ["restore-send", "retry-send", "abandon-send"].includes(String(child.p?.actions?.click)))), "routine queued delivery has no outbox recovery card");
  assert(!tree.some(node => node.p?.actions?.click === "check-send"), "delivery progress never requires a manual Check delivery control");
}
function deliveryHeader(id: number) {
  const card = snapshot().find(node => node.k === "card" && node.p?.actions?.click === `message:${id}`);
  assert(card, "the outgoing message is visible in the accepted native tree");
  return JSON.stringify(card.p?.head);
}
function sendPalette() {
  app.intercept("\x0b"); draw();
  const picker = snapshot().find(node => node.k === "picker");
  assert(picker, "Ctrl+K exposes the native recovery command palette");
  assert(!picker.p?.items?.some(item => item.id === "check-send"), "delivery checking is automatic, not a manual command");
  return picker;
}
function chooseSendCommand(id: string) {
  const item = sendPalette().p?.items?.find(item => item.id === id);
  assert(item && !item.disabled, "the guarded recovery command is available");
  const palette = overlays.at(-1)!.component;
  for (const key of `>${item.label}`) palette.handleInput!(key);
  draw();
  assert(snapshot().find(node => node.k === "picker")!.p?.items?.some(item => item.id === id), "recovery command remains in native search results");
  palette.handleInput!("\r"); draw();
}
function authorize(next: Authorization) {
  authorization = next;
  app.telegram.onUpdate!({ kind: "authorization", authorization: next });
  draw();
}
function loginQr() { return snapshot().filter(node => node.k === "image" && node.p?.alt?.includes("Telegram login QR code")); }
function assertQrImage(photo: Photo) {
  const images = loginQr();
  assert.equal(images.length, 1, "the native authorization frame contains one actual QR image node");
  const image = images[0]!;
  const bytes = Buffer.from(photo.data, "base64");
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  assert.equal(image.p?.blob, id, "native image identity matches the fixture's actual PNG bytes");
  assert.equal(image.p?.w, photo.width);
  assert.equal(image.p?.h, photo.height);
  const blobIndex = writes.findIndex(write => write.verb === "b" && write.params.id === id);
  const frameIndex = writes.findIndex(write => write.verb === "f" && write.body.includes(id));
  assert(blobIndex >= 0 && frameIndex > blobIndex, "QR PNG bytes precede their native referencing frame");
  assert.equal(writes[blobIndex]!.params.mime, photo.mime);
  assert.deepEqual(Buffer.from(writes[blobIndex]!.body, "base64"), bytes, "the native QR blob is the generated fixture, not a placeholder");
  return image;
}
function assertQrOnly() {
  const controls = snapshot().filter(node => node.k === "input" || node.k === "item");
  assert(!controls.some(node => /phone|number|sms|login.code|request.new.code/i.test(JSON.stringify(node.p))), "authorization exposes no phone-number or login-code controls");
  assert(!("phone" in app) && !("code" in app), "the app retains no legacy phone/code inputs");
}
async function waitForView(predicate: () => boolean) {
  const deadline = AbortSignal.timeout(5_000);
  const failure = new Error("Smoke view did not reach its expected state");
  for (;;) {
    draw();
    if (predicate()) return;
    try { await once(renders, "render", { signal: deadline }); }
    catch {
      const thread = app.selectedId === null ? undefined : app.thread(app.selectedId);
      failure.message += `; stage=${app.stage}, busy=${app.busy}, sending=${thread?.sending}, pending=${thread?.pendingSend?.status}, retries=${retries.length}, lastRPCs=${rpcCalls.slice(-5).map(call => call.method).join(",")}, status=${app.status}`;
      throw failure;
    }
  }
}
try {
  await assert.rejects(actualCall("save_state", []), error => error instanceof TelegramRequestError && error.method === "save_state" && /\[TypeError/.test(error.message));
  const diagnostic = JSON.parse(await readFile(join(directory, "tdlib", "last-error.json"), "utf8"));
  assert.equal(diagnostic.operation, "save_state");
  assert.equal(diagnostic.kind, "TypeError");
  app.cooldowns.block("chat_info", 1, 60, "method");
  await assert.rejects(actualCall("chat_info", [1]), error => error instanceof TelegramRequestError && error.method === "chat_info" && error.retryAfterSeconds > 0);
  app.cooldowns.clear();
  backend.start(); draw();
  await client.start(); draw();
  assert.equal(app.stage, "credentials");
  assert(snapshot().some(node => node.p?.text?.includes("unofficial Telegram client") && node.p.text.includes("API ID")), "first-run surface discloses third-party Telegram API use");
  assertQrOnly();
  authorize({ state: "qr", qr: qrFixtures[0] });
  assert.equal(app.stage, "qr");
  const firstQr = assertQrImage(qrFixtures[0]);
  assertQrOnly();
  assert(!snapshot().some(node => node.p?.actions?.click === "submit"), "idle QR login has no misleading manual-refresh control");
  const beforeRotation = frames.length;
  authorize({ state: "qr", qr: qrFixtures[1] });
  const rotatedQr = assertQrImage(qrFixtures[1]);
  assert.notEqual(rotatedQr.id, firstQr.id, "rotation replaces the native QR image node");
  assert.notEqual(rotatedQr.p?.blob, firstQr.p?.blob, "rotation publishes different PNG content");
  assert(!snapshot().some(node => node.id === firstQr.id), "the old QR is absent from the accepted document");
  assert(frames.length > beforeRotation, "QR rotation produces an accepted native frame");
  assertQrOnly();
  authorize({ state: "password", hint: "Offline fixture hint" });
  assert.equal(app.stage, "password");
  assert.equal(loginQr().length, 0, "2FA immediately removes the previous QR image");
  const passwordInput = snapshot().find(node => node.k === "input" && node.p?.placeholder === "Telegram two-step password");
  assert(passwordInput, "2FA uses an actual native input");
  assert(snapshot().some(node => node.p?.text?.includes("Offline fixture hint")));
  assertQrOnly();
  const fixturePassword = "offline-fixture-password";
  backend.handleInput(encodeTspJson("e", { ev: "edit", sf: frames.at(-1)!.sf, id: passwordInput.id, from: 0, to: 0, len: 0, text: fixturePassword, cursor: fixturePassword.length }));
  draw();
  assert(snapshot().some(node => node.k === "input" && node.p?.text === "•".repeat(fixturePassword.length)), "native edits render only masked password bullets");
  assert(!JSON.stringify(snapshot()).includes(fixturePassword), "the password never appears in native frames");
  const unlock = snapshot().find(node => node.p?.actions?.click === "submit")!;
  backend.handleInput(encodeTspJson("e", { ev: "action", sf: frames.at(-1)!.sf, id: unlock.id, act: "submit" }));
  await waitForView(() => app.stage === "chats" && !app.busy);
  assert.equal(app.account, "Smoke account", "ready bootstraps the normal account and dialogs RPCs");
  assert.equal(app.password.getValue(), "", "submitted 2FA password is cleared");
  assert.equal(loginQr().length, 0, "ready retains no stale QR image");
  app.telegram.onStatus!(true);
  await app.selectChat(1); draw();
  await app.activityChain;
  assert.deepEqual(rpcCalls.filter(call => call.method === "select_peer").at(-1)?.args, [1]);
  assert.equal(rpcCalls.filter(call => call.method === "typing").length, 0, "initial selection is not a composer edit");
  assert(snapshot().some(node => node.p?.text?.includes("ID 1") && node.p.text.includes("42 members")), "conversation status contains Telegram ID and server participant count");
  participantCount = 43;
  await app.refresh(); draw();
  assert(snapshot().some(node => node.p?.text?.includes("43 members")), "refresh updates participant count without losing selected chat");
  assert(!snapshot().some(node => node.k === "list"), "chat navigation must not occupy the persistent dock");
  const chatSurface = frames.at(-1)!.sf;
  const chatDocument = documents.get(chatSurface)!;
  const editorFocus = chatDocument.focus;
  assert(editorFocus && chatDocument.get(editorFocus)?.k === "editor");
  backend.handleInput(encodeTspJson("e", { ev: "visible", sf: chatSurface, visible: false }));
  // Model the host dropping native focus while the tab's surface is detached.
  assert.deepEqual(chatDocument.applyFrame({ sf: chatSurface, s: frames.at(-1)!.s, ops: [["focus", null]] }), []);
  backend.handleInput(encodeTspJson("e", { ev: "visible", sf: chatSurface, visible: true }));
  draw();
  assert.equal(chatDocument.focus, editorFocus, "returning to the tab restores the existing native editor focus");
  app.intercept("\x0b"); draw();
  assert(snapshot().some(node => node.k === "picker"), "Ctrl+K opens the native command palette");
  backend.handleInput(encodeTspJson("e", { ev: "visible", sf: chatSurface, visible: true }));
  draw();
  assert.equal(chatDocument.focus, null, "tab return with a palette open must not focus the underlying editor");
  assert.equal(focus, overlays.at(-1)!.component, "tab return retains palette keyboard ownership");
  overlays.at(-1)!.component.handleInput!("\x1b");
  assert.equal(focus, app.composer, "Escape restores editor focus");
  const typingCalls = () => rpcCalls.filter(call => call.method === "typing");
  const beforeRestoration = typingCalls().length;
  alice.draft = "Restored private draft";
  await app.selectChat(1); await app.activityChain; draw();
  assert.equal(app.composer.getText(), "Restored private draft");
  assert.equal(typingCalls().length, beforeRestoration, "restoring a saved draft does not advertise typing");
  app.composer.handleInput("\x15");
  app.composer.handleInput("Actual private composer edit");
  await app.activityChain; draw();
  assert.equal(alice.draft, "Actual private composer edit", "real editor input updates application draft state");
  assert(snapshot().some(node => node.k === "editor" && JSON.stringify(node.p).includes("Actual private composer edit")), "native accepted frame contains the actual composer edit");
  assert.deepEqual(typingCalls().at(-1)?.args, [1, true], "actual composer edits advertise typing without draft contents");
  assert(rpcCalls.some(call => call.method === "activity" && call.args.length === 0), "observed user input records payload-free activity");
  app.composer.handleInput("\x15"); await app.activityChain; draw();
  assert.equal(alice.draft, "");
  assert.deepEqual(typingCalls().at(-1)?.args, [1, false], "clearing the composer cancels typing");
  app.composer.handleInput("Switching private draft"); await app.activityChain;
  app.thread(2).draft = "Restored Bob draft";
  const beforeSwitch = rpcCalls.length;
  action("chat:2"); await app.activityChain; draw();
  assert.equal(app.composer.getText(), "Restored Bob draft");
  assert.deepEqual(rpcCalls.slice(beforeSwitch).filter(call => call.method === "typing" || call.method === "select_peer"), [
    { method: "typing", args: [1, false] }, { method: "select_peer", args: [2] },
  ], "chat switching cancels the old peer before selecting the new one, without advertising its restored draft");
  app.telegram.onUpdate!({ kind: "presence", chat_id: 2, presence: { state: "last_week" } }); draw();
  const coarseStatus = snapshot().find(node => node.p?.text?.includes("last seen within a week"))?.p?.text;
  assert(coarseStatus, "native status renders the server's coarse last-seen category");
  assert(!/\d{1,2}:\d{2}|\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(coarseStatus), "coarse presence does not invent an exact timestamp");
  {
    const realNow = Date.now, realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const scheduled = new Map<NodeJS.Timeout, { delay: number; run: () => void }>();
    const oldPresence = app.dialogs.find(dialog => dialog.id === 2)!.presence;
    const expiry = 2_147_483_647;
    realClearTimeout(app.transientTimer);
    let now = Date.UTC(2026, 0, 1);
    Date.now = () => now;
    globalThis.setTimeout = ((run: () => void, delay: number) => {
      assert(Number.isFinite(delay) && delay >= 1 && delay <= 2_147_483_647, "presence must never schedule an overflowing/immediate-loop timer");
      const handle = {} as NodeJS.Timeout;
      scheduled.set(handle, { delay, run });
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: NodeJS.Timeout | undefined) => {
      scheduled.delete(handle!);
    }) as typeof clearTimeout;
    const nextTimer = () => {
      assert.equal(scheduled.size, 1, "presence has exactly one pending wakeup");
      const [handle, timer] = scheduled.entries().next().value!;
      scheduled.delete(handle);
      return timer;
    };
    try {
      app.telegram.onUpdate!({ kind: "presence", chat_id: 2, presence: { state: "online", expires: expiry } });
      const first = nextTimer();
      assert.equal(first.delay, 2_147_483_647);
      now += first.delay; first.run();
      assert.deepEqual(app.dialogs.find(dialog => dialog.id === 2)!.presence, { state: "online", expires: expiry }, "timer chunk must not shorten the server's online deadline");
      const second = nextTimer();
      assert.equal(second.delay, 2_147_483_647);
      now = expiry * 1000 - 500; second.run();
      const last = nextTimer();
      assert.equal(last.delay, 500, "the final timer uses only the remaining interval");
      now += last.delay; last.run();
      assert.equal(app.dialogs.find(dialog => dialog.id === 2)!.presence?.state, "unknown");
      assert.equal(scheduled.size, 0, "expired presence does not rearm a timer");
    } finally {
      Date.now = realNow; globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
      app.transientTimer = undefined;
      app.dialogs.find(dialog => dialog.id === 2)!.presence = oldPresence;
    }
    draw();
  }
  app.thread(2).draft = ""; alice.draft = "";
  action("chat:1"); await app.activityChain; draw();
  const incomingTyping = { kind: "typing" as const, chat_id: 1, sender_id: 1002, sender: "Alice", action: "chatActionTyping", expires_in: 6 };
  const beforeTypingFrame = frames.length;
  app.telegram.onUpdate!(incomingTyping); draw();
  assert(frames.length > beforeTypingFrame, "incoming typing produces an accepted native update");
  assert(snapshot().some(node => node.p?.text?.includes("Alice · typing")), "incoming peer typing includes the sender");
  app.telegram.onUpdate!({ ...incomingTyping, action: "chatActionCancel" }); draw();
  assert(!snapshot().some(node => node.p?.text?.includes("Alice · typing")), "peer cancel removes the rendered typing indicator");
  app.composer.setText("First message");
  await app.activityChain;
  const sending = app.send("First message");
  await app.activityChain;
  assert.deepEqual(typingCalls().at(-1)?.args, [1, false], "sending cancels outgoing typing before delivery completes");
  assert.equal(alice.sending, true);
  assert.equal(app.busy, false);
  await waitForView(() => alice.pendingSend?.message_id === queuedMessageId);
  assert.equal(alice.pendingSend?.status, "queued", "a queued native message is not delivery confirmation");
  assert.equal(app.composer.getText(), "First message", "queued send keeps its text until real confirmation");
  assertCompactSendProgress();
  assert(deliveryHeader(queuedMessageId).includes("sending"), "queued message visibly remains pending");
  assert(!deliveryHeader(queuedMessageId).includes(" · sent"), "a queued message must not present a sent receipt");
  action("toggle-context-hints"); draw();
  assert(!snapshot().some(node => node.p?.role === "terngram.composer-context"));
  assertCompactSendProgress();
  action("toggle-context-hints"); draw();
  await app.persist();
  const queuedState = await app.telegram.call<ClientState>("load_state");
  const firstSendToken = queuedState.pending_sends["1"]!.token;
  assert.equal(firstSendToken, sendAttempts.at(-1)![3], "intent token is durably stored before the send reaches Telegram");
  assert.equal(queuedState.pending_sends["1"]!.message_id, queuedMessageId, "durable local TDLib message IDs retain int53 precision");
  assert.equal(queuedState.pending_sends["1"]!.status, "queued");
  action("chat:2");
  assert.equal(app.selectedId, 2, "navigation remains usable while sending");
  assert.equal(app.thread(2).loading, true);
  app.composer.setText("Bob draft");
  action("chat:1");
  app.composer.setText("Next Alice draft");
  const queuedCommandsDuringFlight = sendPalette();
  assert(queuedCommandsDuringFlight.p?.items?.some(item => item.id === "restore-send" && item.disabled), "active send flight guards recovery commands");
  assert(!queuedCommandsDuringFlight.p?.items?.some(item => ["retry-send", "abandon-send"].includes(item.id)), "queued delivery cannot be retried or abandoned");
  overlays.at(-1)!.component.handleInput!("\x1b");
  releaseSend({ ...message(queuedMessageId, 1, "First message", true), sending_state: "queued" }); await sending;
  assert.equal(alice.sending, false, "queued RPC completion is not an active send flight");
  await app.persist();
  alice.pendingSend = null;
  const queuedReconciliations = rpcCalls.filter(call => call.method === "reconcile_send" && call.args[1] === firstSendToken).length;
  await app.connected();
  await waitForView(() => !app.busy && !alice.sending && rpcCalls.filter(call => call.method === "reconcile_send" && call.args[1] === firstSendToken).length > queuedReconciliations);
  assert.equal(alice.pendingSend?.status, "queued", "bootstrap restores durable queued delivery");
  assert.equal(alice.sending, false, "restored queued progress requires no active RPC flight");
  action("toggle-context-hints"); draw();
  assertCompactSendProgress();
  action("toggle-context-hints"); draw();
  assertCompactSendProgress();
  assert(deliveryHeader(queuedMessageId).includes("sending"), "restored queued message still has a pending receipt");
  assert(!snapshot().some(node => node.k === "text" && node.p?.tone === "error"), "routine queued completion is not an error banner");
  const restoredCommands = sendPalette();
  assert(restoredCommands.p?.items?.some(item => item.id === "restore-send" && !item.disabled), "restored queued intent exposes guarded draft recovery");
  assert(!restoredCommands.p?.items?.some(item => ["retry-send", "abandon-send"].includes(item.id)), "restored queued intent still cannot be blindly retried or abandoned");
  overlays.at(-1)!.component.handleInput!("\x1b");
  action("retry-send");
  assert.equal(retries.length, 0, "guarded retry rejects a queued intent");
  app.scroll("page-up"); draw();
  app.telegram.onUpdate!(incomingTyping); draw();
  assert(snapshot().some(node => node.p?.text?.includes("Alice · typing")));
  const beforeIncoming = frames.length;
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: message(11, 1, "Live while send is pending") });
  draw();
  assert(snapshot().some(node => node.k === "text" && node.p?.spans?.map(span => span.t).join("") === "Live while send is pending"), "live event renders during pending send/history");
  assert(snapshot().some(node => JSON.stringify(node.p?.label ?? "").includes("1 new")));
  assert(!snapshot().some(node => node.p?.text?.includes("Alice · typing")), "a peer message clears that sender's typing indicator");
  assert(!frames.slice(beforeIncoming).flatMap(frame => frame.ops).some(op => op[0] === "scroll" || op[0] === "reveal"), "incoming event must not force a user out of history");
  const sent = message(12, 1, "First message", true);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: sent });
  assert.equal(alice.newMessages, 1, "own messages and duplicate events must not increment the incoming counter");
  app.telegram.onUpdate!({ kind: "send_state", chat_id: 1, token: firstSendToken, status: "sent", message_id: sent.id, message: sent });
  fixtureAdmissions.delete(firstSendToken); draw();
  assert.equal(alice.draft, "Next Alice draft", "send completion must preserve newly typed text");
  assert.equal(app.composer.getText(), "Next Alice draft", "confirmation does not replace the newer composer draft");
  assert(!nodes(snapshot().find(node => node.p?.role === "terngram.composer")!).some(node => node.k === "spinner"), "confirmation removes compact delivery progress");
  assert(!snapshot().some(node => node.p?.actions?.click === `message:${queuedMessageId}`), "confirmation replaces the queued local message");
  assert(deliveryHeader(12).includes(" · sent"), "only confirmation presents the sent receipt");
  assert.equal(alice.messages.filter(item => item.id === 12).length, 1);
  assert.equal(alice.newMessages, 0, "sending returns to the latest messages");
  assert.deepEqual(reads.at(-1), [1, 12], "sending reads the open chat");
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: message(90, 1, "Seen while following") });
  await Bun.sleep(0);
  assert.equal(alice.newMessages, 0, "a present user following the open chat sees incoming messages");
  assert.deepEqual(reads.at(-1), [1, 90], "followed incoming messages are read");
  app.scroll("page-up");
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: message(91, 1, "Unseen in history") });
  await Bun.sleep(0);
  assert.equal(alice.newMessages, 1, "paging away from the latest messages keeps incoming messages unread");
  assert.deepEqual(reads.at(-1), [1, 90]);
  app.telegram.onUpdate!({ kind: "read", chat_id: 1, max_id: 12, outbox: true });
  assert.equal(alice.messages.find(item => item.id === 12)?.read, true);
  assert.equal(alice.newMessages, 1, "an outgoing read receipt must not add incoming messages");
  assert(maxAvatarRequests <= 2);
  draw();
  const initialsAvatar = snapshot().find(node => node.k === "card" && node.p?.aria === "Alice")!;
  assert(initialsAvatar, "missing profile photo renders a card rather than a pill badge");
  assert.deepEqual(initialsAvatar.p?.min, { w: "4ch", h: "2lines" });
  assert.deepEqual(initialsAvatar.p?.max, initialsAvatar.p?.min, "initials keep a fixed square avatar slot");
  assert(nodes(initialsAvatar).some(node => node.k === "text" && node.p?.text === "A"), "initials remain visible in the avatar");
  for (const pending of pendingAvatars) pending.resolve({ data: png, mime: "image/png", width: 1, height: 1 });
  await Bun.sleep(0); draw();
  assert(snapshot().some(node => node.k === "image" && node.p?.alt === "Sender avatar"), "profile images replace initials before the message");
  assert.deepEqual(snapshot().find(node => node.k === "image" && node.p?.alt === "Sender avatar")!.p?.max, initialsAvatar.p?.max, "loaded photo uses the same bounds as the initials placeholder");
  const main = snapshot().find(node => node.id === "main")!;
  const dock = snapshot().find(node => node.id === "dock")!;
  assert(!nodes(main).some(node => node.p?.role === "terngram.navigation"));
  assert(!nodes(dock).some(node => node.p?.role === "terngram.navigation"));
  const dockContent = nodes(dock).find(node => node.p?.role === "terngram.dock")!;
  assert.equal(dockContent.c?.at(-1)?.p?.role, "terngram.composer", "the message editor is the last fixed-region block");
  assert(nodes(dockContent.c!.at(-1)!).some(node => node.k === "editor"), "the bottom block contains the real native editor");
  assert(!snapshot().some(node => node.p?.text?.startsWith("Markdown:")), "the explanatory Markdown hint is absent from the visible UI");
  app.intercept("\t");
  assert.notEqual(focus, app.composer);
  app.intercept("\x15"); draw();
  assert(frames.at(-1)!.ops.some(op => op[0] === "scroll" && op[2] === "page-up"), "Ctrl+U pages history while messages are focused");
  client.handleInput("\x1b[A"); draw();
  assert(frames.at(-1)!.ops.some(op => op[0] === "reveal" && op[2] === "nearest"), "keyboard selection reveals the newly selected message");
  app.intercept("\t");
  assert.equal(focus, app.composer, "Tab returns from messages to the editor");
  app.composer.setText("Line one");
  assert.equal(app.intercept("\x15"), undefined, "Ctrl+U is not captured while composing");
  app.composer.handleInput("\x15");
  assert.equal(app.composer.getText(), "", "Ctrl+U remains the editor's delete-to-line-start command");
  app.composer.setText("Next Alice draft");
  app.intercept("\x07"); draw();
  assert(snapshot().some(node => node.p?.text === "Keyboard shortcuts"));
  overlays.at(-1)!.component.handleInput!("\x1b");
  assert.equal(focus, app.composer);
  action("message:12"); draw();
  assert(nodes(snapshot().find(node => node.p?.role === "terngram.composer-context")!).some(node => node.p?.text?.includes("You")));
  client.handleInput("r"); draw();
  assert.equal(alice.replyTo, 12);
  assert.equal(focus, app.composer, "reply enters composer context");
  app.intercept("\x1b");
  assert.equal(alice.replyTo, null);
  assert.equal(app.composer.getText(), "Next Alice draft", "cancel reply preserves draft");
  action("message:12"); client.handleInput("e"); draw();
  assert.equal(app.composer.getText(), "First message");
  app.intercept("\x1b");
  assert.equal(app.composer.getText(), "Next Alice draft", "cancel edit restores previous draft");
  action("message:12"); client.handleInput("\x7f"); draw();
  assert(nodes(snapshot().find(node => node.p?.role === "terngram.composer-context")!).some(node => node.p?.text?.includes("Cannot be undone")));
  app.intercept("\x1b"); app.intercept("\x1b");
  action("message:12"); client.handleInput("f"); draw();
  assert(snapshot().some(node => node.k === "picker"), "F opens the native forward destination picker");
  const forwardPicker = overlays.at(-1)!.component;
  for (const key of ["B", "o", "b", "\r"]) forwardPicker.handleInput!(key);
  await Bun.sleep(0);
  assert.deepEqual(forwards.at(-1), [1, [12], 2], "forwarding sends the selected message to the filtered destination");
  assert.equal(focus, client, "closing the forward picker returns to messages");
  alice.more = true;
  action(`message:${alice.groups[0]![0]!.id}`);
  client.handleInput("\x1b[A");
  assert.deepEqual(historyRequests.at(-1)?.slice(0, 2), [1, alice.messages[0]!.id], "↑ at the first loaded message requests earlier history");
  await Bun.sleep(0);
  app.intercept("\x1b");
  releaseHistory([message(10, 2, "Bob history")]);
  await Bun.sleep(0);
  action("chat:2"); draw();
  assert.equal(app.composer.getText(), "Bob draft");
  assert(snapshot().some(node => node.k === "text" && node.p?.spans?.map(span => span.t).join("") === "Bob history"));
  action("bottom"); draw();
  action("chat:1"); draw();
  action(`message:${alice.messages[0]!.id}`); draw();
  assert(snapshot().some(node => node.p?.selected === true), "history selection is visible before jumping to latest");
  app.intercept("\x0c"); draw();
  assert(!snapshot().some(node => node.p?.selected === true), "Ctrl+L releases the old message selection instead of keeping its history anchor");
  assert(frames.at(-1)!.ops.some(op => op[0] === "scroll" && op[2] === "end"));
  const beforeRebuild = frames.length;
  backend.handleInput(encodeTspJson("e", { ev: "gone", ids: [frames.at(-1)!.sf] })); draw();
  const hiddenIds = new Set(snapshot().filter(node => node.p?.hidden === true).flatMap(node => nodes(node).map(child => child.id)));
  assert(frames.slice(beforeRebuild).every(frame => frame.ops.every(op => op[0] !== "reveal" || !hiddenIds.has(op[1]))), "rebuilding the surface must not reveal anchors inside inactive chats");
  const beforeDecoration = frames.length;
  const decorated = alice.messages[0]!;
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...decorated, time: `${decorated.time} · background update` } }); draw();
  assert(!snapshot().some(node => node.p?.selected === true), "a late message update must not restore the historical selection");
  assert(frames.slice(beforeDecoration).every(frame => frame.ops.every(op => op[0] !== "reveal" && op[0] !== "scroll")), "late decorations repaint without moving the viewport after Ctrl+L");
  action("bottom"); draw();
  assert(frames.at(-1)!.ops.some(op => op[0] === "scroll" && op[2] === "end"), "repeated bottom action scrolls again");
  app.scroll("page-up"); draw();
  assert(!frames.at(-1)!.ops.some(op => op[0] === "reveal" && op[2] === "end"), "paging up must not trigger a stale bottom reveal");
  const album = (id: number): ChatMessage => ({ ...message(id, 1, "[Photo]"), photo: true, media_id: String(id), grouped_id: "9223372036854775806" });
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: album(13) });
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: album(14) });
  draw();
  assert.equal(snapshot().filter(node => node.k === "card" && JSON.stringify(node.c).includes("Album · 2 media")).length, 1, "album is one card, not separate photos");
  await waitForView(() => snapshot().filter(node => node.k === "image" && node.p?.alt === "Photo preview").length === 2);
  const thumbnail = snapshot().find(node => node.k === "image" && node.p?.alt === "Photo preview")!;
  assert.equal(thumbnail.p?.actions?.click, "photo:13", "thumbnail opens its full-resolution album");
  action("photo:13");
  await waitForView(() => snapshot().some(node => node.p?.role === "terngram.gallery"));
  const gallery = snapshot().find(node => node.p?.role === "terngram.gallery")!;
  assert.equal(nodes(gallery).filter(node => node.k === "image").length, 1);
  overlays.at(-1)!.component.handleInput!("\x1b[C"); draw();
  assert(snapshot().some(node => node.p?.text?.includes("2/2")), "right arrow selects the next album photo");
  const blob = writes.findIndex(write => write.verb === "b");
  const imageFrame = writes.findIndex(write => write.verb === "f" && write.body.includes('"image"'));
  assert(blob >= 0 && imageFrame > blob, "photo bytes are published before their referencing frame");
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: album(15) });
  await waitForView(() => snapshot().some(node => node.p?.text?.includes("2/3")));
  assert.equal(nodes(snapshot().find(node => node.p?.role === "terngram.gallery")!).filter(node => node.k === "image").length, 1, "an open gallery retains its selected photo when album members arrive");
  const oldPhotoCalls = photoRequests.filter(args => args[1] === 14).length;
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...album(14), media_id: "140", edited: true, text: "Replaced image", markdown: "Replaced image" } });
  draw();
  assert(snapshot().some(node => node.p?.role === "terngram.gallery"), "replacing an album photo preserves the open gallery while refreshed media loads");
  await waitForView(() => {
    const updatedGallery = snapshot().find(node => node.p?.role === "terngram.gallery");
    return updatedGallery !== undefined && nodes(updatedGallery).some(node => node.k === "image")
      && nodes(updatedGallery).some(node => node.p?.text === "Replaced image");
  });
  assert.equal(photoRequests.filter(args => args[1] === 14).length, oldPhotoCalls + 2, "replaced media fetches both a new preview and new full image");
  app.closePhoto();
  action("dismiss-status");
  const racedPreview = { ...message(17, 1, "[Photo]"), photo: true, media_id: "17-current" };
  const previewChanged = Promise.withResolvers<Photo>();
  delayedPreviewPhotos.set(17, previewChanged);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: racedPreview }); draw();
  delayedPreviewPhotos.delete(17);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...racedPreview, edited: true } });
  previewChanged.reject(new TelegramRequestError("photo", "Expected media invalidation", 0, "MEDIA_CHANGED"));
  await waitForView(() => snapshot().some(node => node.k === "image" && node.p?.actions?.click === "photo:17"));
  assert.equal(photoRequests.filter(args => args[1] === 17 && args[2] === true).length, 2, "same-key expected cancellation loads current preview exactly once");
  assert.equal(app.error, false, "normal preview invalidation has no global error banner");
  const racedFull = { ...message(18, 1, "[Photo]"), photo: true, media_id: "18-old" };
  const fullChanged = Promise.withResolvers<Photo>();
  delayedPhotos.set(18, fullChanged);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: racedFull }); draw();
  action("photo:18");
  delayedPhotos.delete(18);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...racedFull, media_id: "18-new", text: "Replacement caption", markdown: "Replacement caption" } });
  fullChanged.reject(new TelegramRequestError("photo", "Expected media invalidation", 0, "MEDIA_CHANGED"));
  await waitForView(() => snapshot().some(node => node.p?.role === "terngram.gallery"));
  assert.equal(photoRequests.filter(args => args[1] === 18 && args[2] !== true).length, 2, "gallery retries only the current replacement resource");
  assert(snapshot().some(node => node.p?.text === "Replacement caption"), "gallery uses the authoritative replacement's caption");
  assert.equal(app.error, false, "normal full-photo replacement has no global error banner");
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...racedFull, photo: false, media_id: null, text: "Photo removed", markdown: "Photo removed" } }); draw();
  assert(!snapshot().some(node => node.p?.role === "terngram.gallery"), "removing the only photo closes the viewer instead of showing stale bytes");
  assert(!snapshot().some(node => node.p?.actions?.click === "photo:18"), "removed media has no preview/open action left in its message");
  assert.equal(app.error, false);
  const removedPreview = Promise.withResolvers<Photo>();
  delayedPreviewPhotos.set(19, removedPreview);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...message(19, 1, "[Photo]"), photo: true, media_id: "19-old" } }); draw();
  delayedPreviewPhotos.delete(19);
  app.telegram.onUpdate!({ kind: "delete", chat_id: 1, ids: [19] });
  removedPreview.reject(new TelegramRequestError("photo", "Expected media invalidation", 0, "MEDIA_CHANGED"));
  await Bun.sleep(0); draw();
  assert(!snapshot().some(node => node.p?.actions?.click === "photo:19" || node.p?.actions?.click === "message:19"), "deleted message and in-flight preview stay removed");
  assert.equal(app.error, false, "deletion during a preview load is not an error");
  const formatted = { ...message(16, 1, "Bold and code"), markdown: "**Bold** and `code`", entities: [
    { offset: 0, length: 4, type: { "@type": "textEntityTypeBold" } },
    { offset: 9, length: 4, type: { "@type": "textEntityTypeCode" } },
  ] };
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: formatted }); draw();
  assert(snapshot().some(node => node.k === "text" && node.p?.spans?.some(span => span.t === "Bold" && span.s === "strong")
    && node.p.spans.some(span => span.t === "code" && span.s === "code")), "Telegram entities preserve native bold and code without Markdown parsing");
  app.dialogCursor = { offset: 60 };
  await app.moreChats();
  assert.deepEqual(app.dialogs.map(item => item.id), [1, 2, 3]);
  const oldest = alice.messages[0]!;
  for (let id = 16; id < 80; id++) alice.receive(message(id, 1, `History ${id}`));
  await app.loadHistory(1, false, true);
  assert(alice.messages.some(item => item.id === oldest.id), "bounded latest-page refresh retains older loaded history");
  assert(historyLimits.every(limit => limit <= 50), "history requests never expand to the full loaded transcript");
  app.dialogs.push(...Array.from({ length: 100 }, (_, index) => dialog(5000 + index, `Chat ${index}`)));
  ui.setFocus(app.composer);
  app.intercept("\x06"); draw();
  const chatPalette = overlays.at(-1)!.component;
  for (let index = 0; index < 70; index++) chatPalette.handleInput!("\x1b[B");
  chatPalette.handleInput!("\r");
  await Bun.sleep(0);
  assert.equal(app.selectedId, app.dialogs[70]!.id, "palette navigation reaches chats beyond its viewport");
  await app.selectChat(1); draw();
  assert(snapshot().some(node => node.k === "text" && node.p?.spans?.map(span => span.t).join("") === oldest.text), "switching through palette preserves loaded transcript");
  app.composer.setText("Retry safely");
  const beforeFailedSave = sendAttempts.length;
  failNextSave = true;
  await app.send("Retry safely");
  assert.equal(sendAttempts.length, beforeFailedSave, "failed durable write must prevent a Telegram send");
  assert.equal(app.composer.getText(), "Retry safely");
  assert.equal(alice.pendingSend, null, "a rejected local write must not poison future draft persistence");
  app.composer.setText("Retry safely");
  failNextSend = true;
  await app.send("Retry safely");
  assert.equal(app.composer.getText(), "Retry safely", "ambiguous failure preserves the draft");
  await app.persist();
  const pendingState = await app.telegram.call<ClientState>("load_state");
  const attemptToken = pendingState.pending_sends["1"]!.token;
  assert.equal(sendAttempts.at(-1)![3], attemptToken, "send intent is durably committed before Telegram is called");
  assert.equal(pendingState.pending_sends["1"]!.status, "uncertain");
  const beforeBlockedResend = sendAttempts.length;
  await app.send("Retry safely");
  assert.equal(sendAttempts.length, beforeBlockedResend, "Enter cannot resubmit an ambiguous post-crash attempt");
  draw();
  assert(!snapshot().some(node => node.p?.actions?.click === "retry-send"), "uncertain delivery offers no unsafe retry control");
  assert(!snapshot().some(node => node.p?.actions?.click === "check-send"), "uncertain delivery has no manual checking control");
  await waitForView(() => !alice.sending && rpcCalls.some(call => call.method === "reconcile_send" && call.args[1] === attemptToken));
  assert(rpcCalls.some(call => call.method === "reconcile_send" && call.args[1] === attemptToken), "ambiguous send automatically reconciles the existing intent");
  assert.equal(alice.pendingSend?.status, "uncertain", "automatic reconciliation does not invent confirmation");
  const uncertainPalette = sendPalette();
  assert(!uncertainPalette.p?.items?.some(item => item.id === "retry-send"), "uncertain delivery has no unsafe palette retry");
  assert(uncertainPalette.p?.items?.some(item => item.id === "restore-send"));
  assert(uncertainPalette.p?.items?.some(item => item.id === "abandon-send"));
  overlays.at(-1)!.component.handleInput!("\x1b");
  action("retry-send");
  assert.equal(retries.length, 0, "the existing retry action rejects uncertain delivery");
  chooseSendCommand("abandon-send");
  const abandon = snapshot().find(node => node.p?.actions?.click === "confirm-abandon-send");
  assert(abandon, "stopping tracking requires explicit confirmation");
  assert.equal(alice.pendingSend?.token, attemptToken, "opening abandonment confirmation keeps the durable intent");
  assert.equal(rpcCalls.filter(call => call.method === "abandon_send").length, 0, "opening abandonment confirmation never abandons automatically");
  const cancelAbandon = snapshot().find(node => node.p?.actions?.click === "cancel-abandon-send")!;
  backend.handleInput(encodeTspJson("e", { ev: "action", sf: frames.at(-1)!.sf, id: cancelAbandon.id, act: "cancel-abandon-send" })); draw();
  assert.equal(alice.pendingSend?.token, attemptToken, "cancelling abandonment preserves tracking");
  assert.equal(sendAttempts.length, beforeBlockedResend);
  assert.equal(retries.length, 0, "reconciliation does not resend");
  assert.equal(app.composer.getText(), "Retry safely");
  chooseSendCommand("restore-send");
  assert.equal(app.composer.getText(), "Retry safely", "palette draft recovery preserves the unresolved text");
  assert.equal(alice.pendingSend?.token, attemptToken, "restoring text does not release or resend the intent");
  assert.equal(sendAttempts.length, beforeBlockedResend, "palette recovery does not create a new send");
  reconciliationStatus = "failed";
  const reconciliationsBeforeReconnect = rpcCalls.filter(call => call.method === "reconcile_send" && call.args[1] === attemptToken).length;
  await app.persist();
  app.telegram.onStatus!(false); app.telegram.onStatus!(true);
  await waitForView(() => !app.busy && !alice.sending && alice.pendingSend?.status === "failed");
  assert(rpcCalls.filter(call => call.method === "reconcile_send" && call.args[1] === attemptToken).length > reconciliationsBeforeReconnect, "reconnect automatically reconciles the same unresolved token");
  assert.equal(sendAttempts.length, beforeBlockedResend, "automatic reconnect recovery never submits a new send");
  await app.persist();
  const reconciledState = await app.telegram.call<ClientState>("load_state");
  assert.equal(reconciledState.pending_sends["1"]!.token, attemptToken);
  assert.equal(reconciledState.pending_sends["1"]!.message_id, failedMessageId);
  draw();
  const failedCard = snapshot().find(node => node.k === "card" && node.p?.actions?.click === `message:${failedMessageId}`)!;
  assert(failedCard, "a definite failure remains a message in the native transcript");
  assert.equal(failedCard.p?.tone, "error", "definite failure gives the original transcript card an error border");
  assert.equal(failedCard.p?.status, "error", "definite failure exposes native error status");
  const failedCardId = failedCard.id;
  const messageOrder = () => snapshot().filter(node => node.p?.role === "terngram.message").map(node => node.id);
  const failedOrder = messageOrder();
  assert.equal(snapshot().filter(node => node.p?.role === "terngram.message" && nodes(node).some(child => child.k === "text" && child.p?.spans?.map(span => span.t).join("") === "Retry safely")).length, 1, "failed delivery has no duplicate transcript card");
  action(`message:${failedMessageId}`); draw();
  assert(snapshot().some(node => node.p?.actions?.click === `retry-message:${failedMessageId}`), "selecting the failed message exposes explicit Retry");
  const failedPalette = sendPalette();
  assert(failedPalette.p?.items?.some(item => item.id === "retry-send" && !item.disabled), "only confirmed failure exposes explicit palette retry");
  overlays.at(-1)!.component.handleInput!("\x1b"); draw();
  assert.equal(focus, client, "closing recovery commands restores the selected failed message's focus");
  const retry = snapshot().find(node => node.p?.actions?.click === `retry-message:${failedMessageId}`);
  assert(retry && !retry.p?.disabled, "the restored selected failed message exposes an eligible native Retry control");
  backend.handleInput(encodeTspJson("e", { ev: "action", sf: backend.document()!.id, id: retry.id, act: `retry-message:${failedMessageId}` }));
  await waitForView(() => alice.sending && retries.length === 1);
  assert.equal(snapshot().find(node => node.p?.actions?.click === `message:${failedMessageId}`)?.id, failedCardId, "retry preserves the failed native message identity");
  assert.equal(snapshot().find(node => node.id === failedCardId)?.p?.tone, "error", "the error border persists while explicit retry is in flight");
  assert.equal(snapshot().find(node => node.id === failedCardId)?.p?.status, "error", "retry admission alone never clears failed styling");
  assert.deepEqual(messageOrder(), failedOrder, "retry does not relocate the failed message");
  const replacementFailedMessageId = failedMessageId + 1;
  const replacementFailed = { ...message(replacementFailedMessageId, 1, "Retry safely", true), sending_state: "failed" as const };
  nativeFailedMessages.delete(failedMessageId);
  nativeFailedMessages.set(replacementFailedMessageId, replacementFailed);
  app.telegram.onUpdate!({ kind: "send_state", chat_id: 1, token: attemptToken, status: "queued", message_id: replacementFailedMessageId, message: { ...replacementFailed, sending_state: "queued" } }); draw();
  app.telegram.onUpdate!({ kind: "delete", chat_id: 1, ids: [failedMessageId] }); draw();
  assert.equal(snapshot().find(node => node.id === failedCardId)?.p?.tone, "error", "native replacement and deletion never clear the stable failed card");
  assert.deepEqual(messageOrder(), failedOrder, "native retry replacement keeps one card in its original position");
  app.telegram.onUpdate!({ kind: "send_state", chat_id: 1, token: attemptToken, status: "failed", message_id: replacementFailedMessageId, message: replacementFailed });
  retryGate.reject(new TelegramRequestError("retry_send", "Offline retry failed"));
  await waitForView(() => !alice.sending && alice.pendingSend?.status === "failed");
  assert.equal(snapshot().find(node => node.p?.actions?.click === `message:${failedMessageId}`)?.id, failedCardId, "failed retry leaves the same native message in place");
  assert.equal(snapshot().find(node => node.id === failedCardId)?.p?.tone, "error", "a rejected retry keeps the original error border");
  assert.deepEqual(messageOrder(), failedOrder, "failed retry keeps transcript order");
  assert.equal(alice.pendingSend?.message_id, replacementFailedMessageId, "the retry intent tracks the current native failure instead of its visual anchor");
  assert.equal(alice.retryDisplayId, failedMessageId, "the original failed message remains the stable visual anchor");
  assert.equal(sendAttempts.length, beforeBlockedResend, "failed retry never becomes a new send");
  retryGate = Promise.withResolvers<void>();
  draw();
  const replacementRetry = snapshot().find(node => node.p?.actions?.click === `retry-message:${failedMessageId}`);
  assert(replacementRetry && !replacementRetry.p?.disabled, "the stable failed card retains an eligible Retry for its replacement native ID");
  client.handleInput("\r"); draw();
  await waitForView(() => alice.sending && retries.length === 2);
  assert.equal(snapshot().find(node => node.p?.actions?.click === `message:${failedMessageId}`)?.id, failedCardId, "successful retry starts from the original failed native message");
  retryGate.resolve();
  await waitForView(() => !alice.sending && alice.pendingSend === null);
  assert(!snapshot().some(node => node.id === failedCardId), "actual success replaces the failed local native message");
  assert.equal(snapshot().find(node => node.p?.actions?.click === "message:1000")?.p?.tone, "user", "only actual confirmation clears failed styling");
  assert.deepEqual(retries, [[1, attemptToken], [1, attemptToken]], "both explicit retries address the same durable failed intent across native message replacements");
  assert.deepEqual(retriedNativeIds, [failedMessageId, replacementFailedMessageId], "retries resend the exact current native message even when the visual anchor differs");
  assert.equal(sendAttempts.length, beforeBlockedResend, "failed-message retry never issues a second new send");
  assert.equal(alice.pendingSend, null, "confirmed delivery releases its retry record");
  app.composer.setText("Next Alice draft");
  await app.persist();
  const saved = JSON.parse(await readFile(join(directory, "tdlib", "state.json"), "utf8"));
  assert.deepEqual(saved, { drafts: { "1": "Next Alice draft", "2": "Bob draft" }, selected_id: 1, pending_sends: {} });
  assert.deepEqual(await actualCall("load_state"), saved);
  retryGate = Promise.withResolvers<void>();
  const beforeUntrackedSend = sendAttempts.length;
  const untrackedFailed = { ...message(failedMessageId, 1, "Untracked failed message", true), sending_state: "failed" as const };
  nativeFailedMessages.set(untrackedFailed.id, untrackedFailed);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: untrackedFailed }); draw();
  assert.equal(alice.pendingSend, null, "a history/native failed message begins without a client intent");
  const untrackedCard = snapshot().find(node => node.p?.actions?.click === `message:${failedMessageId}`)!;
  assert(untrackedCard && untrackedCard.p?.tone === "error", "untracked failed outgoing message has native error styling");
  const untrackedOrder = messageOrder();
  action(`message:${failedMessageId}`); draw();
  const adoptRetry = snapshot().find(node => node.p?.actions?.click === `retry-message:${failedMessageId}`)!;
  assert(adoptRetry, "selecting an untracked failed message exposes guarded Retry");
  assert(!adoptRetry.p?.disabled, "the untracked failed message's native Retry control is eligible");
  const adoptedRetryStarted = once(retryStarts, "start", { signal: AbortSignal.timeout(5_000) });
  backend.handleInput(encodeTspJson("e", { ev: "action", sf: backend.document()!.id, id: adoptRetry.id, act: `retry-message:${failedMessageId}` }));
  await adoptedRetryStarted; draw();
  assert(alice.sending && retries.length === 3, "adopted failed-message retry starts before delivery confirmation");
  const adopted = alice.pendingSend!;
  assert.equal(adopted.message_id, failedMessageId, "adoption retains the existing TDLib failed message");
  assert.equal(adopted.status, "failed", "adoption and retry admission do not invent success");
  assert.deepEqual(rpcCalls.filter(call => call.method === "adopt_failed_send").at(-1)?.args, [1, failedMessageId]);
  assert.deepEqual(retries.at(-1), [1, adopted.token], "adopted retry uses its durable token instead of a new send");
  const adoptionIndex = rpcCalls.findLastIndex(call => call.method === "adopt_failed_send");
  const adoptedRetryIndex = rpcCalls.findLastIndex(call => call.method === "retry_send");
  assert(rpcCalls.slice(adoptionIndex + 1, adoptedRetryIndex).some(call => call.method === "save_state"), "frontend persists the adopted intent before retrying");
  assert.deepEqual(messageOrder(), untrackedOrder, "adoption never moves or duplicates the failed transcript message");
  assert.equal(snapshot().find(node => node.p?.actions?.click === `message:${failedMessageId}`)?.id, untrackedCard.id, "adoption retains native failed card identity");
  assert.equal(snapshot().find(node => node.id === untrackedCard.id)?.p?.tone, "error", "adopted retry retains its error border until confirmation");
  assert.equal(app.composer.getText(), "Next Alice draft", "adoption preserves the newer composer draft");
  assert.equal(sendAttempts.length, beforeUntrackedSend, "adopting a failed TDLib message never submits a new send");
  retryGate.resolve();
  await waitForView(() => !alice.sending && alice.pendingSend === null);
  assert(!snapshot().some(node => node.id === untrackedCard.id), "confirmed adopted retry replaces the failed local message");
  assert.equal(app.composer.getText(), "Next Alice draft", "adopted retry confirmation keeps the newer draft");
  assert.equal(alice.getMessage(1000)?.text, untrackedFailed.text, "confirmation contains the existing native failed content, not the newer composer draft");
  assert.deepEqual(retriedNativeIds, [failedMessageId, replacementFailedMessageId, failedMessageId], "untracked adoption also retries the exact native history ID");
  assert.equal(sendAttempts.length, beforeUntrackedSend);
  await app.persist();
  const pageResult = Promise.withResolvers<DialogPage>();
  const oldPage = app.dialogs.map(item => ({ ...item }));
  dialogPageGate = pageResult.promise;
  const refreshingPage = app.refreshDialogs();
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...message(1000, 1, "Edited during dialog refresh", true), edited: true } });
  pageResult.resolve({ dialogs: oldPage, cursor: null }); await refreshingPage;
  dialogPageGate = undefined;
  assert.equal(app.dialogs.find(item => item.id === 1)!.preview, "Edited during dialog refresh");
  const singleResult = Promise.withResolvers<Dialog | null>();
  const oldDialog = { ...app.dialogs.find(item => item.id === 1)! };
  dialogGate = singleResult.promise;
  const refreshingDialog = app.refreshDialog(1);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: { ...message(1000, 1, "Edited during single refresh", true), edited: true } });
  singleResult.resolve(oldDialog); await refreshingDialog;
  dialogGate = undefined;
  assert.equal(app.dialogs.find(item => item.id === 1)!.preview, "Edited during single refresh");
  await app.selectChat(2); await app.selectChat(1);
  app.intercept("\x1b[D"); app.intercept("\x1b[D");
  assert.equal(app.selectedId, 1, "double arrows do not hijack a nonempty editor");
  ui.setFocus(client);
  setKittyProtocolActive(true);
  app.intercept("\x1b[D"); app.intercept("\x1b[1;1:3D"); app.intercept("\x1b[D");
  assert.equal(app.selectedId, 2, "double-left follows visit history, ignoring key releases");
  assert.equal(app.composer.getText(), "Bob draft");
  app.intercept("\x1b[C"); app.intercept("\x1b[C");
  assert.equal(app.selectedId, 1, "double-right follows the forward branch");
  assert.equal(app.composer.getText(), "Next Alice draft");
  setKittyProtocolActive(false);
  for (const id of [1, 2, 3, 5000, 5001, 5002]) await app.selectChat(id);
  app.intercept("\x0b"); draw();
  const historyPicker = snapshot().find(node => node.k === "picker")!;
  assert.deepEqual(historyPicker.p?.items?.slice(0, 5).map(item => item.id), ["chat:5002", "chat:5001", "chat:5000", "chat:3", "chat:2"], "palette lists the five most recently visited chats first");
  assert.deepEqual(historyPicker.p?.order?.filter(item => typeof item !== "string").map(group => group.group), ["recent", "other"]);
  for (const key of "Chat") overlays.at(-1)!.component.handleInput!(key);
  draw();
  assert.equal(snapshot().find(node => node.k === "picker")!.p?.order, undefined, "native search removes recent group headings");
  overlays.at(-1)!.component.handleNativeEvent!({ type: "edit", key: "", from: 0, to: 4, text: "", len: 4, cursor: 0 });
  overlays.at(-1)!.component.handleNativeEvent!({ type: "activate", key: "", item: "history-back" });
  assert.equal(app.selectedId, 5001, "palette back uses the same navigation history");
  app.intercept("\x0b");
  overlays.at(-1)!.component.handleNativeEvent!({ type: "activate", key: "", item: "history-forward" });
  assert.equal(app.selectedId, 5002, "palette forward uses the same navigation history");
  await app.selectChat(1);
  app.intercept("\x0b");
  overlays.at(-1)!.component.handleNativeEvent!({ type: "activate", key: "", item: "toggle-context-hints" });
  draw();
  assert(!snapshot().some(node => node.k === "item" && ["chats", "help"].includes(String(node.p?.actions?.click))), "hidden hints remove Commands / Keys controls");
  assert(snapshot().some(node => node.p?.role === "terngram.conversation-status"), "conversation information stays visible");
  assert(!snapshot().some(node => node.p?.role === "terngram.composer-context"), "idle editor hint row collapses");
  action("message:12"); client.handleInput("r"); draw();
  assert(snapshot().some(node => node.p?.role === "terngram.composer-context"), "reply context is still visible with hints hidden");
  app.intercept("\x1b");
  const albumRequests = rpcCalls.filter(call => call.method === "album").length;
  await app.viewPhoto(alice.getMessage(14)!); draw();
  assert.equal(rpcCalls.filter(call => call.method === "album").length, albumRequests + 1, "reconnect refresh invalidates the old resolved album membership");
  app.closePhoto();
  await app.viewPhoto(alice.getMessage(14)!); draw();
  assert.equal(rpcCalls.filter(call => call.method === "album").length, albumRequests + 1, "reopening an album resolved after reconnect reuses its membership");
  assert(nodes(snapshot().find(node => node.p?.role === "terngram.gallery")!).some(node => node.p?.text === "Replaced image"), "the clicked album member opens, not always the first photo");
  assert(!snapshot().some(node => node.k === "item" && node.p?.actions?.click === "close-photo"), "compact gallery hides Esc Close");
  overlays.at(-1)!.component.handleInput!("\x1b");
  assert.equal(overlays.length, 0, "Escape still closes the compact gallery");
  app.intercept("\x0b");
  overlays.at(-1)!.component.handleNativeEvent!({ type: "activate", key: "", item: "toggle-context-hints" });
  draw();
  assert(snapshot().some(node => node.k === "item" && node.p?.actions?.click === "chats"), "palette command restores the hints");
  const reading = app.thread(77);
  reading.receive(message(1, 77, "Seen first"));
  const firstRead = app.markRead(77);
  reading.receive(message(2, 77, "Seen while acknowledgement was pending"));
  void app.markRead(77);
  reading.receive(message(3, 77, "Not seen after leaving this chat"));
  receiptGate.resolve(); await firstRead;
  assert.deepEqual(reads.filter(args => args[0] === 77), [[77, 1], [77, 2]], "queued receipt must not include messages that arrived after the read decision");
  action("message:12");
  // Exercise the real selection debounce; wait for its render signal, never a guessed sleep.
  await waitForView(() => snapshot().some(node => node.k === "card" && JSON.stringify(node.p?.head).includes("read 3")));
  const readerCalls = rpcCalls.filter(call => call.method === "message_readers" && call.args[1] === 12).length;
  action("message:12"); action("message:12");
  assert.equal(rpcCalls.filter(call => call.method === "message_readers" && call.args[1] === 12).length, readerCalls, "reselecting the same message does not refetch its reader list");
  const metadataCalls = rpcCalls.filter(call => call.method === "dialog").length;
  app.telegram.onUpdate!({ kind: "dialog_changed", chat_id: 1, title: "Renamed Alice" }); draw();
  assert.equal(app.dialogs.find(item => item.id === 1)!.title, "Renamed Alice");
  assert.equal(rpcCalls.filter(call => call.method === "dialog").length, metadataCalls, "authoritative title update needs no refetch");
  const namesBefore = rpcCalls.filter(call => ["dialogs", "dialog", "search_dialogs"].includes(call.method)).length;
  for (let pass = 0; pass < 5; pass++) {
    app.intercept("\x0b");
    for (const key of "Renamed") overlays.at(-1)!.component.handleInput!(key);
    draw();
    assert.deepEqual(snapshot().find(node => node.k === "picker")!.p?.items?.map(item => item.id), ["chat:1"], "cached title invalidation immediately changes local search results");
    overlays.at(-1)!.component.handleInput!("\x1b");
  }
  assert.equal(rpcCalls.filter(call => ["dialogs", "dialog", "search_dialogs"].includes(call.method)).length, namesBefore, "reopening and typing cached names sends no search RPC");
  participantCount = 44;
  app.telegram.onUpdate!({ kind: "dialog_changed", chat_id: 1, participants_changed: true });
  await waitForView(() => snapshot().some(node => node.p?.text?.includes("44 members")));
  const pendingPage = Promise.withResolvers<DialogPage>();
  const nextCursor = { offset: 120 };
  app.dialogCursor = nextCursor;
  dialogPageGate = pendingPage.promise;
  const pageCalls = rpcCalls.filter(call => call.method === "dialogs").length;
  app.intercept("\x06");
  for (const key of "Hidden") overlays.at(-1)!.component.handleInput!(key);
  overlays.at(-1)!.component.handleInput!("\x1b");
  app.intercept("\x0b");
  for (const key of "contextual hints") overlays.at(-1)!.component.handleInput!(key);
  draw();
  const settingsDuringLoad = snapshot().find(node => node.k === "picker")!;
  assert.equal(settingsDuringLoad.p?.state, "ready", "background chat loading must not replace settings results with a skeleton");
  assert.deepEqual(settingsDuringLoad.p?.items?.map(item => item.id), ["toggle-context-hints"]);
  overlays.at(-1)!.component.handleInput!("\r");
  draw();
  assert(!snapshot().some(node => node.k === "item" && node.p?.actions?.click === "chats"), "unprefixed settings search remains actionable while a chat page is pending");
  app.intercept("\x06");
  for (const key of "Hidden") overlays.at(-1)!.component.handleInput!(key);
  assert.equal(rpcCalls.filter(call => call.method === "dialogs").length, pageCalls + 1, "concurrent searches share one outstanding page request");
  pendingPage.resolve({ dialogs: [dialog(9999, "Hidden chat")], cursor: null });
  await waitForView(() => snapshot().find(node => node.k === "picker")!.p?.items?.some(item => item.id === "chat:9999") === true);
  overlays.at(-1)!.component.handleInput!("\x1b");
  dialogPageGate = Promise.resolve({ dialogs: app.dialogs.slice(0, 60), cursor: nextCursor });
  await app.refreshDialogs();
  assert.equal(app.dialogCursor, null, "refreshing the first page cannot restart an exhausted catalogue");
  dialogPageGate = undefined;
  assert.equal(rpcCalls.filter(call => call.method === "search_dialogs").length, 0);
  const firstPhoto = { ...message(2000, 1, "First choice"), photo: true, media_id: "2000" };
  const latestPhoto = { ...message(2001, 1, "Latest choice"), photo: true, media_id: "2001" };
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: firstPhoto });
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: latestPhoto });
  const firstPhotoGate = Promise.withResolvers<Photo>();
  delayedPhotos.set(2000, firstPhotoGate);
  const firstOpen = app.viewPhoto(firstPhoto);
  await app.viewPhoto(latestPhoto);
  firstPhotoGate.resolve({ data: png, mime: "image/png", width: 1, height: 1 });
  await firstOpen; draw();
  assert(nodes(snapshot().find(node => node.p?.role === "terngram.gallery")!).some(node => node.p?.text === "Latest choice"), "a slow earlier photo request cannot replace the latest chosen photo");
  app.closePhoto();
  action("message:12"); client.handleInput("r");
  const cancelledPhoto = { ...message(2002, 1, "Cancelled photo"), photo: true, media_id: "2002" };
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: cancelledPhoto });
  const cancelledPhotoGate = Promise.withResolvers<Photo>();
  delayedPhotos.set(2002, cancelledPhotoGate);
  const cancelledOpen = app.viewPhoto(cancelledPhoto);
  app.intercept("\x1b");
  assert.equal(alice.replyTo, 12, "Escape cancels the pending photo before touching reply context");
  cancelledPhotoGate.resolve({ data: png, mime: "image/png", width: 1, height: 1 });
  await cancelledOpen; draw();
  assert.equal(overlays.length, 0, "a cancelled download must not open a late gallery");
  app.intercept("\x1b");
  app.composer.setText("Cursor stays here");
  app.composer.handleInput("\x1b[D"); app.composer.handleInput("\x1b[D");
  const cursorBeforeDelete = app.composer.getCursor();
  app.telegram.onUpdate!({ kind: "delete", chat_id: 2, ids: [987654] });
  assert.deepEqual(app.composer.getCursor(), cursorBeforeDelete, "a background chat deletion must not move the active editor caret");
  app.intercept("\x1b");
  assert.deepEqual(app.composer.getCursor(), cursorBeforeDelete, "Escape without a compose mode must not reset the caret");
  const writableDialog = { ...app.dialogs.find(item => item.id === 1)! };
  dialogGate = Promise.resolve({ ...writableDialog, writable: false });
  app.telegram.onUpdate!({ kind: "dialog_changed", chat_id: 1, permissions_changed: true });
  await waitForView(() => app.dialogs.find(item => item.id === 1)?.writable === false);
  assert.equal(focus, client, "revoked write permission moves focus out of the hidden editor");
  const writesBeforeReadonly = sendAttempts.length;
  await app.send("Must not be sent");
  assert.equal(sendAttempts.length, writesBeforeReadonly);
  assert.equal(app.composer.getText(), "Cursor stays here");
  dialogGate = Promise.resolve(writableDialog);
  app.telegram.onUpdate!({ kind: "dialog_changed", chat_id: 1, permissions_changed: true });
  await waitForView(() => app.dialogs.find(item => item.id === 1)?.writable === true);
  dialogGate = undefined;
  app.composer.setText("Next Alice draft");
  ui.setFocus(app.composer);
  setKittyProtocolActive(true);
  app.intercept("\x1b[13;1:2u");
  assert.equal(alice.sending, false, "a held Enter repeat must not submit a restored draft");
  assert.equal(app.composer.getText(), "Next Alice draft");
  setKittyProtocolActive(false);
  dialogGate = Promise.resolve({ ...dialog(-9, "New group"), kind: "group" });
  app.telegram.onUpdate!({ kind: "dialog_changed", chat_id: -9, title: "New group", permissions_changed: true });
  app.intercept("\x0b");
  await waitForView(() => app.dialogs.some(item => item.id === -9));
  overlays.at(-1)!.component.handleInput!("\x1b");
  dialogGate = Promise.resolve(null);
  app.telegram.onUpdate!({ kind: "dialog_changed", chat_id: -9, permissions_changed: true });
  app.intercept("\x0b");
  await waitForView(() => !app.dialogs.some(item => item.id === -9));
  overlays.at(-1)!.component.handleInput!("\x1b");
  const unavailableLookups = rpcCalls.filter(call => call.method === "dialog" && call.args[0] === -9).length;
  app.intercept("\x0b"); overlays.at(-1)!.component.handleInput!("\x1b");
  assert.equal(rpcCalls.filter(call => call.method === "dialog" && call.args[0] === -9).length, unavailableLookups, "unavailable dialogs do not cause repeated lookups on every palette open");
  dialogGate = undefined;
  realSendPreparation = true;
  const rejectedText = "Rejected before native admission";
  app.composer.setText(rejectedText);
  const beforeRejectedAdmission = sendAttempts.length;
  await app.send(rejectedText);
  assert.equal(sendAttempts.length, beforeRejectedAdmission + 1, "the offline worker rejects this attempt during native preflight");
  assert.equal(alice.pendingSend, null, "an abandoned-before-admission event cannot be overwritten by the later send RPC rejection");
  assert.equal(app.composer.getText(), rejectedText, "pre-admission rejection recovers the original draft");
  await app.persist();
  assert.deepEqual((await actualCall<ClientState>("load_state")).pending_sends, {});
  draw();
  assert(!snapshot().some(node => ["check-send", "retry-send"].includes(String(node.p?.actions?.click))), "never-submitted intent releases native pending-send controls");
  realSendPreparation = false;
  confirmNextSend = true;
  await app.send(rejectedText);
  assert.equal(sendAttempts.length, beforeRejectedAdmission + 2, "a recovered draft permits a new deliberate send");
  assert.equal(alice.pendingSend, null);
  assert.equal(app.composer.getText(), "");
  const unsubmitted = await actualCall<PendingSend>("prepare_send", [1, "Reconnect unsubmitted text", null]);
  alice.pendingSend = unsubmitted;
  app.composer.setText("Newer reconnect draft");
  await app.persist();
  const beforeReconnectSend = sendAttempts.length;
  await app.connected(); draw();
  assert.equal(alice.pendingSend, null, "same-process load_state must clear an existing never-submitted pending intent");
  assert.equal(app.composer.getText(), "Newer reconnect draft\n\nReconnect unsubmitted text", "reconnect merges recovered text into an existing thread's newer draft exactly once");
  assert.equal(sendAttempts.length, beforeReconnectSend, "recovery never submits prepared text automatically");
  await app.persist();
  const recoveredState = await actualCall<ClientState>("load_state");
  assert.deepEqual(recoveredState.pending_sends, {});
  assert.equal(recoveredState.drafts["1"], app.composer.getText());
  confirmNextSend = true;
  await app.send(app.composer.getText());
  assert.equal(sendAttempts.length, beforeReconnectSend + 1, "reconnect recovery releases the chat for a new deliberate send");
  assert.equal(alice.pendingSend, null);
  await app.activityChain;
  assert(rpcCalls.filter(call => call.method === "typing").every(call => call.args.length === 2 && typeof call.args[0] === "number" && typeof call.args[1] === "boolean"), "typing RPCs contain only peer IDs and activity flags, never drafts");
  assert(rpcCalls.filter(call => call.method === "activity").every(call => call.args.length === 0), "activity RPCs never contain account input or message contents");
  app.telegram.onUpdate!(incomingTyping); draw();
  assert(snapshot().some(node => node.p?.text?.includes("Alice · typing")));
  app.telegram.onStatus!(false); await app.activityChain; draw();
  assert(!snapshot().some(node => node.p?.text?.includes("Alice · typing")), "disconnect clears transient peer typing without waiting for expiration");
  app.online = true;
  const scale = new ChatState();
  const start = performance.now();
  for (let id = 1; id <= 10000; id++) scale.receive(message(id, 99, `Message ${id}`));
  for (let id = 1; id <= 10000; id += 7) scale.receive(message(id, 99, `Edit ${id}`));
  const elapsed = performance.now() - start;
  assert.equal(scale.messages.length, 10000);
  assert(scale.messages.every((item, index) => item.id === index + 1));
  console.log(`SMOKE PASS: QR-only native authorization image/rotation/2FA/ready frames; compact dock; palette navigation across 103 chats; keyboard help; context focus; laptop paging/latest/delete; reply/edit draft restoration; TDLib typing edit/cancel/switch/send and coarse peer presence; forwarding; history edge loading; send/follow read acknowledgements without reading detached history; inline photo previews opening full gallery; album/avatar updates; isolated worker persistence; pre-admission rejection and same-process reconnect draft recovery without resending uncertain sends. 10,000 messages + 1,429 edits: ${elapsed.toFixed(1)}ms. Offline fixture QR payloads only: no account, network, scan, Telegram token expiry, host pixel geometry, or full TOS proof.`);
} finally {
  backend.stop(false);
  await app.quit();
  await rm(directory, { recursive: true, force: true });
}
