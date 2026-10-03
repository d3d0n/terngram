import type { Editor } from "@oh-my-pi/pi-tui/components/editor";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { ChatState } from "./chat-state";
import type { ChatMessage, Dialog } from "./telegram";
import { button, line } from "./nodes";

interface DockState {
  dialog?: Dialog;
  participantsCount?: number | null;
  peerNames?: ReadonlyMap<number, string>;
  incomingActions?: string;
  thread?: ChatState;
  selected?: ChatMessage;
  messageFocus: boolean;
  showHints: boolean;
  deleting: boolean;
  operating: boolean;
  online: boolean;
  busy: boolean;
  status: string;
  error: boolean;
  editor: Editor;
}

const KIND_LABELS = { user: "Personal chat", bot: "Bot", group: "Group", channel: "Channel", saved: "Saved messages" };

export function describeChatDock(state: DockState): NativeNode {
  const { dialog, thread, selected, messageFocus, editor } = state;
  const writable = !!thread && dialog?.writable !== false;
  const senderName = (message: ChatMessage | undefined): string => !message ? "message" : !message.outgoing && message.sender_id !== null ? state.peerNames?.get(message.sender_id) ?? message.sender : message.sender;
  const presence = dialog?.kind === "user" ? dialog.presence : null;
  const presenceLabel = !presence ? "" : presence.state === "online"
    ? presence.expires && presence.expires * 1000 > Date.now() ? "online" : "last seen unknown"
    : presence.state === "offline" ? presence.was_online ? `last seen ${new Date(presence.was_online * 1000).toLocaleString()}` : "offline"
    : ({ recently: "last seen recently", last_week: "last seen within a week", last_month: "last seen within a month", unknown: "last seen unknown" } as const)[presence.state];
  const summary = dialog ? [
    dialog.title, KIND_LABELS[dialog.kind], `ID ${dialog.id}`,
    presenceLabel,
    typeof state.participantsCount === "number" ? `${state.participantsCount} ${dialog.kind === "channel" ? "subscribers" : "members"}` : "",
    dialog.unread_count ? `${dialog.unread_count} unread` : "",
    dialog.writable ? "" : "read-only", state.online ? "" : "Telegram disconnected",
  ].filter(Boolean).join(" · ") : `Terngram${state.online ? "" : " · Telegram disconnected"}`;
  const context: NativeNode[] = [];
  if (state.deleting && selected) {
    context.push(line("context", selected.grouped_id === null ? "Delete this message for everyone? Cannot be undone." : "Delete this entire album for everyone? Cannot be undone."), button("confirm-delete", "Delete · Enter", state.operating), button("cancel-delete", "Cancel · Esc"));
  } else if (messageFocus && selected) {
    context.push(line("context", `${senderName(selected)} · ${selected.time}${selected.edited ? " · edited" : ""}${selected.outgoing ? selected.read ? " · read" : " · sent" : ""} · ${selected.text.replace(/\s+/g, " ")}`));
    if (writable) context.push(button("reply", "Reply · Enter", !!thread?.sending));
    if (selected.outgoing && !selected.photo) context.push(button("edit", "Edit · E", !!thread?.sending));
    context.push(button("forward", "Forward · F", state.operating));
  } else if (thread?.editing || thread?.replyTo != null) {
    const target = thread.getMessage(thread.editing?.id ?? thread.replyTo!);
    context.push(line("context", `${thread.editing ? "Editing" : "Replying to"} ${senderName(target)} · ${target?.text.replace(/\s+/g, " ") ?? ""}`), button("cancel-compose", "Cancel · Esc", thread.sending));
  } else {
    context.push(line("context", !thread ? "Choose a conversation · Ctrl+K" : !writable ? "Read-only conversation · Tab to browse messages" : messageFocus ? "Messages · ↑ / ↓ select · Tab to write" : "Write a message · Enter sends · Shift+Enter new line"));
  }
  return { k: "col", key: "dock", p: { role: "terngram.dock", gap: "xs", min: { w: 0 } }, c: [
    { k: "row", key: "chat-info", p: { role: "terngram.conversation-status", gap: "sm", align: "center" }, c: [
      line("chat-title", summary),
      ...(thread?.newMessages ? [button("bottom", `${thread.newMessages} new · Ctrl+L`)] : []),
      ...(thread?.loading ? [{ k: "spinner" as const, key: "loading", p: { label: "Loading history" } }] : []),
      ...(thread?.sending ? [{ k: "spinner" as const, key: "sending", p: { label: thread.editing ? "Saving" : "Sending" } }] : []),
      ...(state.showHints ? [button("chats", "Commands · Ctrl+K"), button("help", "Keys · Ctrl+G")] : []),
    ] },
    ...(state.incomingActions ? [line("peer-action", state.incomingActions)] : []),
    ...(state.showHints || state.deleting || (messageFocus && selected) || thread?.editing || thread?.replyTo != null
      ? [{ k: "row", key: "composer-context", p: { role: "terngram.composer-context", gap: "sm", align: "center" }, c: context } satisfies NativeNode] : []),
    ...(state.status || state.busy ? [{ k: "row" as const, key: "notice", p: { gap: "sm" as const }, c: [
      ...(state.busy ? [{ k: "spinner" as const, key: "busy", p: { label: "Telegram" } }] : []),
      { k: "text" as const, key: "notice-text", p: { text: state.status, tone: state.error ? "error" as const : "muted" as const, wrap: "word" as const, grow: 1, min: { w: 0 } } },
      button("dismiss-status", "Dismiss"),
    ] }] : []),
    ...(writable ? [{ k: "row" as const, key: "composer-row", p: { role: "terngram.composer", align: "end" as const, gap: "sm" as const, min: { w: 0 }, max: { w: 1 } }, c: [
      { k: "col" as const, key: "editor-column", p: { grow: 1, shrink: 1, basis: 0, min: { w: 0 }, max: { w: 1 } }, c: [editor] },
      button("send", thread?.editing ? "Save" : "Send", !!thread?.sending || !thread?.draft.trim() || state.busy),
    ] }] : []),
  ] };
}
