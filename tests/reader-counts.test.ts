import { expect, test } from "bun:test";
import { ReaderCounts } from "../terngram/ui/reader-counts";
import { MessageView } from "../terngram/ui/message-view";
import { ChatState } from "../terngram/ui/chat-state";
import type { ChatMessage } from "../terngram/ui/telegram";

test("reader queries are demand-only, single-flight and throttled with a deterministic clock", async () => {
  let now = 0;
  let changes = 0;
  const pending = Promise.withResolvers<number | null>();
  const requests: [number, number][] = [];
  const readers = new ReaderCounts(async (chat, id) => {
    requests.push([chat, id]);
    return pending.promise;
  }, () => changes++, error => { throw error; }, () => now);
  expect(readers.get(1, 9)).toBeUndefined();
  expect(requests).toEqual([]);
  const first = readers.request(1, 9);
  expect(readers.request(1, 9)).toBe(first);
  await Promise.resolve();
  expect(requests).toEqual([[1, 9]]);
  pending.resolve(2);
  await first;
  expect(readers.get(1, 9)).toBe(2);
  expect(changes).toBe(1);
  now = 29_999;
  await readers.request(1, 9);
  expect(requests).toHaveLength(1);
  now = 30_000;
  // Merely reading or advancing the clock never schedules another request.
  expect(readers.get(1, 9)).toBe(2);
  expect(requests).toHaveLength(1);
  await readers.request(1, 9);
  expect(requests).toHaveLength(2);
  expect(changes).toBe(1);
});

test("known zero and unavailable null are distinct from missing and cached independently by chat", async () => {
  const requests: [number, number][] = [];
  const readers = new ReaderCounts(async (chat, id) => {
    requests.push([chat, id]);
    return chat === 1 ? 0 : null;
  }, () => {}, error => { throw error; }, () => 0);
  await readers.request(1, 9);
  await readers.request(2, 9);
  expect(readers.get(1, 9)).toBe(0);
  expect(readers.get(2, 9)).toBeNull();
  expect(readers.get(1, 10)).toBeUndefined();
  await readers.request(2, 9);
  expect(requests).toEqual([[1, 9], [2, 9]]);
});

test("failed RPCs do not invent zero and explicit retry is bounded, including FloodWait deadlines", async () => {
  let now = 0;
  const error = Object.assign(new Error("rate limited"), { retryAfterSeconds: 90 });
  const failures: unknown[] = [];
  let requests = 0;
  let fail = true;
  const readers = new ReaderCounts(async () => {
    requests++;
    if (fail) throw error;
    return 3;
  }, () => {}, error => failures.push(error), () => now);
  await readers.request(1, 9);
  expect(readers.get(1, 9)).toBeUndefined();
  expect(failures).toEqual([error]);
  fail = false;
  now = 30_000;
  await readers.request(1, 9);
  now = 89_999;
  await readers.request(1, 9);
  expect(requests).toBe(1);
  now = 90_000;
  await readers.request(1, 9);
  expect(readers.get(1, 9)).toBe(3);
  expect(requests).toBe(2);
});

test("a synchronous query throw cannot strand the single-flight cache", async () => {
  let now = 0;
  let fail = true;
  const failures: unknown[] = [];
  const readers = new ReaderCounts(() => {
    if (fail) throw new Error("offline");
    return Promise.resolve(4);
  }, () => {}, error => failures.push(error), () => now);
  await readers.request(1, 9);
  expect(failures).toHaveLength(1);
  fail = false;
  now = 30_000;
  await readers.request(1, 9);
  expect(readers.get(1, 9)).toBe(4);
});

test("invalidations drop counts and stale completions without defeating the refresh bound", async () => {
  let now = 0;
  let changes = 0;
  let requests = 0;
  const old = Promise.withResolvers<number | null>();
  const readers = new ReaderCounts(async () => {
    requests++;
    return requests === 1 ? old.promise : 5;
  }, () => changes++, error => { throw error; }, () => now);
  const pending = readers.request(1, 9);
  await Promise.resolve();
  readers.invalidateChat(1);
  expect(readers.request(1, 9)).toBe(pending);
  old.resolve(2);
  await pending;
  expect(readers.get(1, 9)).toBeUndefined();
  expect(changes).toBe(0);
  readers.invalidateChat(1);
  await readers.request(1, 9);
  expect(requests).toBe(1);
  now = 30_000;
  await readers.request(1, 9);
  expect(readers.get(1, 9)).toBe(5);
  readers.invalidateChat(2);
  expect(readers.get(1, 9)).toBe(5);
  readers.invalidateChat(1);
  expect(readers.get(1, 9)).toBeUndefined();
});

test("clearing an account ignores both late responses and late errors", async () => {
  const old = Promise.withResolvers<number | null>();
  const error = Promise.withResolvers<number | null>();
  let changes = 0;
  const failures: unknown[] = [];
  const readers = new ReaderCounts(async (_chat, id) => id === 9 ? old.promise : error.promise,
    () => changes++, error => failures.push(error));
  const first = readers.request(1, 9);
  const second = readers.request(1, 10);
  await Promise.resolve();
  readers.clear();
  old.resolve(2);
  error.reject(new Error("old account"));
  await Promise.all([first, second]);
  expect(readers.get(1, 9)).toBeUndefined();
  expect(changes).toBe(0);
  expect(failures).toEqual([]);
});

test("clearing before the queued request starts never sends an old-account query", async () => {
  let requests = 0;
  const readers = new ReaderCounts(async () => { requests++; return 1; },
    () => {}, error => { throw error; });
  const queued = readers.request(1, 9);
  readers.clear();
  await queued;
  expect(requests).toBe(0);
});

test("reader cache bounds retained messages without evicting requests in flight", async () => {
  const pending = Promise.withResolvers<number | null>();
  const readers = new ReaderCounts(async (_chat, id) => id === 0 ? pending.promise : id,
    () => {}, error => { throw error; }, () => 0);
  const first = readers.request(1, 0);
  for (let id = 1; id <= 256; id++) await readers.request(1, id);
  expect(readers.get(1, 1)).toBeUndefined();
  expect(readers.get(1, 256)).toBe(256);
  pending.resolve(0);
  await first;
  expect(readers.get(1, 0)).toBe(0);
});

function message(outgoing: boolean, read: boolean): ChatMessage {
  return { id: 9, chat_id: 1, sender: "Alice", sender_id: 42, text: "Hello", markdown: "Hello",
    time: "12:00", outgoing, read, reply_to: null, edited: false, photo: false, media_id: null,
    forwarded: null, grouped_id: null };
}

test("outgoing headers render actual counts including zero and count changes invalidate description cache", () => {
  const view = new MessageView();
  const members = [message(true, false)];
  const context = { thread: new ChatState(), selectedMessageId: 9, loading: false, avatar: null, previews: [] };
  const sent = view.describe(members, context);
  expect(JSON.stringify(sent)).toContain(" · sent");
  expect(JSON.stringify(sent)).not.toContain(" · read 0");
  const zero = view.describe(members, { ...context, readerCount: 0 });
  expect(zero).not.toBe(sent);
  expect(JSON.stringify(zero)).toContain(" · read 0");
  expect(view.describe(members, { ...context, readerCount: 0 })).toBe(zero);
  const two = view.describe(members, { ...context, readerCount: 2 });
  expect(two).not.toBe(zero);
  expect(JSON.stringify(two)).toContain(" · read 2");
  expect(JSON.stringify(view.describe(members, { ...context, readerCount: null }))).toContain(" · sent");
  expect(JSON.stringify(view.describe([message(true, true)], context))).toContain(" · read");
});

test("incoming headers and cached description identity ignore readerCount entirely", () => {
  const view = new MessageView();
  const members = [message(false, true)];
  const context = { thread: new ChatState(), selectedMessageId: 9, loading: false, avatar: null, previews: [] };
  const incoming = view.describe(members, context);
  expect(view.describe(members, { ...context, readerCount: 2 })).toBe(incoming);
  expect(JSON.stringify(incoming)).not.toContain(" · read");
  expect(JSON.stringify(incoming)).not.toContain(" · sent");
});
