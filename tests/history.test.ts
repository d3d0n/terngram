import { expect, test } from "bun:test";
import { ChatState, mergeHistory, messageGroups } from "../terngram/ui/chat-state";
import type { ChatMessage } from "../terngram/ui/telegram";

function message(id: number, text: string): ChatMessage {
  return { id, chat_id: 123, sender: "Alice", sender_id: 42, text, markdown: text, entities: [], time: "2026-10-03 12:00", outgoing: false, reply_to: null, edited: false, photo: false, media_id: null, forwarded: null, read: false, grouped_id: null };
}

test("overlapping history pages keep chronological order and replace edited messages", () => {
  const history = mergeHistory(
    [message(20, "Before edit"), message(30, "Latest")],
    [message(10, "Older"), message(20, "Edited")],
  );
  expect(history.map(item => [item.id, item.text])).toEqual([[10, "Older"], [20, "Edited"], [30, "Latest"]]);
});

test("a slow history response cannot overwrite a live edit or resurrect a deleted message", () => {
  const chat = new ChatState();
  chat.receive(message(20, "Before"));
  chat.receive(message(30, "Deleted"));
  const started = chat.revision;
  chat.receive(message(20, "Live edit"));
  chat.remove([30]);
  chat.receive(message(40, "Arrived while loading"));
  chat.applyPage([message(10, "Older"), message(20, "Stale edit"), message(30, "Stale deleted")], started, true);
  expect(chat.messages.map(item => [item.id, item.text])).toEqual([[10, "Older"], [20, "Live edit"], [40, "Arrived while loading"]]);
});

test("read receipts survive later history snapshots and duplicate message events", () => {
  const chat = new ChatState();
  chat.markRead(20);
  chat.applyPage([{ ...message(20, "Sent"), outgoing: true }, { ...message(30, "Unread"), outgoing: true }], 0);
  chat.receive({ ...message(20, "Edited"), outgoing: true });
  expect(chat.messages.map(item => [item.id, item.read])).toEqual([[20, true], [30, false]]);
});

test("editing and cancelling restores the unsent draft and its reply target", () => {
  const chat = new ChatState();
  chat.draft = "Unsent reply";
  chat.replyTo = 10;
  chat.edit(message(20, "Original"));
  chat.draft = "Proposed edit";
  chat.cancelEdit();
  expect([chat.draft, chat.replyTo, chat.editing]).toEqual(["Unsent reply", 10, null]);
});

test("album members from pagination and realtime form one ordered group without crossing chats", () => {
  const album = (id: number, chat_id = 123): ChatMessage => ({ ...message(id, "[Photo]"), chat_id, photo: true, grouped_id: "9223372036854775806" });
  const chat = new ChatState();
  chat.receive(album(21));
  chat.applyPage([message(19, "Before album"), album(20)], 0);
  chat.receive(album(22));
  const groups = messageGroups([...chat.messages, album(23, 456), message(24, "After album")]);
  expect(groups.map(group => group.map(item => [item.chat_id, item.id]))).toEqual([
    [[123, 19]], [[123, 20], [123, 21], [123, 22]], [[456, 23]], [[123, 24]],
  ]);
  chat.remove([21]);
  expect(messageGroups(chat.messages).map(group => group.map(item => item.id))).toEqual([[19], [20, 22]]);
});

test("own sends, duplicates, edits and already-read messages never become new unread messages", () => {
  const chat = new ChatState();
  const sent = { ...message(10, "My message"), outgoing: true };
  chat.receive(sent);
  chat.receive(sent);
  chat.markRead(10);
  expect([chat.newMessages, chat.messages[0]?.read]).toEqual([0, true]);
  chat.receive(message(11, "Incoming"));
  chat.receive(message(11, "Duplicate"));
  chat.receive({ ...message(12, "Edited old message"), edited: true });
  chat.receive({ ...message(13, "Read elsewhere"), read: true });
  expect(chat.newMessages).toBe(1);
  chat.remove([11]);
  expect(chat.newMessages).toBe(0);
});

test("an empty refreshed history removes stale messages but keeps an event that arrived during the request", () => {
  const chat = new ChatState();
  chat.applyPage([message(10, "Old history")], 0);
  const started = chat.revision;
  chat.receive(message(20, "Fresh event"));
  chat.applyPage([], started, true);
  expect(chat.messages.map(item => item.id)).toEqual([20]);
});
