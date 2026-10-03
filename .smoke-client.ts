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
import type { ChatMessage, ClientState, Dialog, DialogPage, Photo, Telegram } from "./terngram/ui/telegram";

interface SmokeClient extends Pick<TerngramApp, "stage" | "account" | "dialogs" | "selectedId" | "busy" | "handleNativeEvent" | "describeSurface" | "invalidate" | "quit"> {
  telegram: Telegram;
  cooldowns: RequestCooldowns;
  composer: Editor;
  online: boolean;
  activityChain: Promise<void>;
  refresh(): Promise<void>;
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
  dialogCursor: { date: number; id: number; peer_id: number } | null;
  intercept(data: string): { consume: true } | undefined;
}
const directory = await mkdtemp(join(tmpdir(), "terngram-smoke-"));
const python = Bun.spawnSync(["uv", "run", "python", "-c", "import sys; print(sys.executable)"]).stdout.toString().trim();
let focus: (Component & { focused?: boolean }) | null = null;
const renders = new EventEmitter();
const overlays: NativeOverlay[] = [];
const writes: { verb: string; body: string }[] = [];
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
      writes.push({ verb: decoded.verb, body });
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
  id, chat_id, text, markdown: text, sender_id: outgoing ? 1001 : 1002, outgoing, sender: outgoing ? "You" : "Alice", time: "2026-10-03 12:00", reply_to: null, edited: false, photo: false, media_id: null, forwarded: null, read: false, grouped_id: null,
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
let participantCount = 42;
const rpcCalls: { method: string; args: unknown[] }[] = [];
const delayedPhotos = new Map<number, ReturnType<typeof Promise.withResolvers<Photo>>>();
app.telegram.call = <T>(method: string, args: unknown[] = []): Promise<T> => {
  rpcCalls.push({ method, args });
  let result: Promise<unknown>;
  if (method === "send") {
    sendAttempts.push(args);
    if (failNextSend) { failNextSend = false; result = Promise.reject(new Error("Delivery uncertain")); }
    else result = args[1] === "Retry safely" ? Promise.resolve(message(1000, Number(args[0]), "Retry safely", true)) : sendResult;
  }
  else if (method === "history") {
    historyLimits.push(Number(args[2])); historyRequests.push(args);
    result = args[0] === 2 ? historyResult : Promise.resolve(args[0] === 1 ? app.thread(1).messages.slice(-50) : []);
  } else if (method === "mark_read") { reads.push(args); result = args[0] === 77 && args[1] === 1 ? receiptGate.promise : Promise.resolve(); }
  else if (method === "forward") { forwards.push(args); result = Promise.resolve([]); }
  else if (method === "dialogs") result = dialogPageGate ?? Promise.resolve({ dialogs: args.length ? [dialog(1, "Alice"), dialog(3, "Carol")] : app.dialogs.slice(0, 60), cursor: null });
  else if (method === "photo") {
    photoRequests.push(args);
    result = args[2] !== true && delayedPhotos.has(Number(args[1]))
      ? delayedPhotos.get(Number(args[1]))!.promise : Promise.resolve({ data: png, mime: "image/png", width: 1, height: 1 });
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
  else if (method === "activity" || method === "select_peer" || method === "typing") result = Promise.resolve();
  else result = actualCall(method, args);
  // These fixture results have the same method contracts as Telegram; requests that touch local state use the real worker.
  return result as Promise<T>;
};
app.stage = "chats"; app.account = "Smoke account"; app.online = true;
app.dialogs = [{ ...dialog(1, "Alice"), kind: "group" }, dialog(2, "Bob")];
const alice = app.thread(1); alice.applyPage([message(10, 1, "Initial")], 0);
const host: NativeHost = {
  terminal, describeSurface: () => app.describeSurface(), overlays: () => overlays,
  focused: () => focus, focusFromPointer: owners => { if (owners[0]) ui.setFocus(owners[0]); }, requestRender() {},
  appearanceChanged() {}, motionChanged() {}, invalidate: () => app.invalidate(),
};
const backend = new NativeBackend(host, { r: "hello", v: 1, term: "smoke", kinds: TSP_KINDS, features: ["scroll"], credits: 1000, cols: 110 }, { mirror: true, recordPath: "" });
function draw() {
  backend.render();
  for (const frame of frames) backend.handleInput(encodeTspJson("e", { ev: "ack", sf: frame.sf, s: frame.s }));
}
function nodes(node: TspNode): TspNode[] { return [node, ...(node.c ?? []).flatMap(nodes)]; }
function snapshot() { return nodes(backend.document()!); }
function action(act: string) { app.handleNativeEvent({ type: "action", key: "", act, mods: [] }); }
async function waitForView(predicate: () => boolean) {
  for (;;) {
    draw();
    if (predicate()) return;
    await once(renders, "render");
  }
}
try {
  await assert.rejects(actualCall("send", []), /send: \[TypeError/);
  const diagnostic = JSON.parse(await readFile(join(directory, "last-error.json"), "utf8"));
  assert.equal(diagnostic.operation, "send");
  assert.equal(diagnostic.kind, "TypeError");
  app.cooldowns.block("chat_info", 1, 60, "method");
  await assert.rejects(actualCall("chat_info", [1]), error => error instanceof TelegramRequestError && error.method === "chat_info" && error.retryAfterSeconds > 0);
  app.cooldowns.clear();
  await app.selectChat(1);
  backend.start(); draw();
  await app.activityChain;
  assert.deepEqual(rpcCalls.filter(call => call.method === "select_peer").at(-1)?.args, [1]);
  assert.equal(rpcCalls.filter(call => call.method === "typing").length, 0, "initial selection is not a composer edit");
  app.stage = "credentials"; app.invalidate(); draw();
  assert(snapshot().some(node => node.p?.text?.includes("unofficial client using the Telegram API")), "first-run surface discloses third-party Telegram API use");
  app.stage = "chats"; app.invalidate(); draw();
  assert(snapshot().some(node => node.p?.text?.includes("ID 1") && node.p.text.includes("42 members")), "conversation status contains Telegram ID and server participant count");
  participantCount = 43;
  await app.refresh(); draw();
  assert(snapshot().some(node => node.p?.text?.includes("43 members")), "refresh updates participant count without losing selected chat");
  assert(!snapshot().some(node => node.k === "list"), "chat navigation must not occupy the persistent dock");
  app.intercept("\x0b"); draw();
  assert(snapshot().some(node => node.k === "picker"), "Ctrl+K opens the native command palette");
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
  app.thread(2).draft = ""; alice.draft = "";
  action("chat:1"); await app.activityChain; draw();
  const incomingTyping = { kind: "typing" as const, chat_id: 1, sender_id: 1002, sender: "Alice", action: "SendMessageTypingAction", expires_in: 6 };
  const beforeTypingFrame = frames.length;
  app.telegram.onUpdate!(incomingTyping); draw();
  assert(frames.length > beforeTypingFrame, "incoming typing produces an accepted native update");
  assert(snapshot().some(node => node.p?.text?.includes("Alice · typing")), "incoming peer typing includes the sender");
  app.telegram.onUpdate!({ ...incomingTyping, action: "SendMessageCancelAction" }); draw();
  assert(!snapshot().some(node => node.p?.text?.includes("Alice · typing")), "peer cancel removes the rendered typing indicator");
  app.composer.setText("First message");
  await app.activityChain;
  const sending = app.send("First message");
  await app.activityChain;
  assert.deepEqual(typingCalls().at(-1)?.args, [1, false], "sending cancels outgoing typing before delivery completes");
  assert.equal(alice.sending, true);
  assert.equal(app.busy, false);
  action("chat:2");
  assert.equal(app.selectedId, 2, "navigation remains usable while sending");
  assert.equal(app.thread(2).loading, true);
  app.composer.setText("Bob draft");
  action("chat:1");
  app.composer.setText("Next Alice draft");
  app.scroll("page-up"); draw();
  app.telegram.onUpdate!(incomingTyping); draw();
  assert(snapshot().some(node => node.p?.text?.includes("Alice · typing")));
  const beforeIncoming = frames.length;
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: message(11, 1, "Live while send is pending") });
  draw();
  assert(snapshot().some(node => node.p?.text === "Live while send is pending"), "live event renders during pending send/history");
  assert(snapshot().some(node => JSON.stringify(node.p?.label ?? "").includes("1 new")));
  assert(!snapshot().some(node => node.p?.text?.includes("Alice · typing")), "a peer message clears that sender's typing indicator");
  assert(!frames.slice(beforeIncoming).flatMap(frame => frame.ops).some(op => op[0] === "scroll" || op[0] === "reveal"), "incoming event must not force a user out of history");
  const sent = message(12, 1, "First message", true);
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: sent });
  assert.equal(alice.newMessages, 1, "own messages and duplicate events must not increment the incoming counter");
  releaseSend(sent); await sending;
  assert.equal(alice.draft, "Next Alice draft", "send completion must preserve newly typed text");
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
  for (const pending of pendingAvatars) pending.resolve({ data: png, mime: "image/png", width: 1, height: 1 });
  await Bun.sleep(0); draw();
  assert(snapshot().some(node => node.k === "image" && node.p?.alt === "Sender avatar"), "profile images replace initials before the message");
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
  assert(snapshot().some(node => node.p?.text === "Bob history"));
  action("chat:1"); app.intercept("\x0c"); draw();
  assert(frames.at(-1)!.ops.some(op => op[0] === "scroll" && op[2] === "end"));
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
  await waitForView(() => nodes(snapshot().find(node => node.p?.role === "terngram.gallery")!).some(node => node.p?.text === "Replaced image"));
  assert.equal(photoRequests.filter(args => args[1] === 14).length, oldPhotoCalls + 2, "replaced media fetches both a new preview and new full image");
  app.closePhoto();
  const formatted = { ...message(16, 1, "Bold and code"), markdown: "**Bold** and `code`" };
  app.telegram.onUpdate!({ kind: "message", chat_id: 1, message: formatted }); draw();
  assert(snapshot().some(node => node.k === "md" && node.p?.text === formatted.markdown), "Telegram formatting uses native Markdown rendering");
  app.dialogCursor = { date: 1, id: 1, peer_id: 1 };
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
  assert(snapshot().some(node => node.k === "md" && node.p?.text === oldest.markdown), "switching through palette preserves loaded transcript");
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
  const pendingState = await actualCall<ClientState>("load_state");
  const attemptId = pendingState.pending_sends["1"]!.random_id;
  assert.equal(sendAttempts.at(-1)![3], attemptId, "send identity is durably committed before Telegram is called");
  await app.send("Retry safely");
  assert.equal(sendAttempts.at(-1)![3], attemptId, "manual retry reuses the same Telegram random ID");
  assert.equal(alice.pendingSend, null, "confirmed delivery releases its retry record");
  app.composer.setText("Next Alice draft");
  await app.persist();
  const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.deepEqual(saved, { drafts: { "1": "Next Alice draft", "2": "Bob draft" }, selected_id: 1, pending_sends: {} });
  assert.deepEqual(await actualCall("load_state"), saved);
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
  assert.equal(rpcCalls.filter(call => call.method === "album").length, albumRequests, "reopening a known album reuses resolved membership");
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
  const nextCursor = { date: 10, id: 2, peer_id: 2 };
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
  console.log(`SMOKE PASS: native frames; compact dock; palette navigation across 103 chats; keyboard help; context focus; laptop paging/latest/delete; reply/edit draft restoration; typing edit/cancel/switch/send and coarse peer presence; forwarding; history edge loading; send/follow read acknowledgements without reading detached history; inline photo previews opening full gallery; album/avatar updates; worker persistence. 10,000 messages + 1,429 edits: ${elapsed.toFixed(1)}ms. Protocol/model proof only, not host pixel geometry.`);
} finally {
  backend.stop(false);
  await app.quit();
  await rm(directory, { recursive: true, force: true });
}
