import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { ChatState } from "./chat-state";
import type { ChatMessage } from "./telegram";
import { button, label, preview } from "./nodes";

export class MessageView {
  private descriptions = new Map<string, { members: readonly ChatMessage[]; reply?: ChatMessage; senderName: string; replyName?: string; selected: boolean; loading: boolean; readerCount?: number | null; avatar?: NativeNode | null; previews: readonly (NativeNode | null | undefined)[]; node: NativeNode }>();

  clear(): void { this.descriptions.clear(); }

  describe(members: readonly ChatMessage[], context: { thread: ChatState; selectedMessageId: number | null; loading: boolean; readerCount?: number | null; peerNames?: ReadonlyMap<number, string>; avatar: NativeNode | null | undefined; previews: readonly (NativeNode | null | undefined)[] }): NativeNode {
    const message = members[0]!;
    const key = message.grouped_id === null ? `message-${message.chat_id}-${message.id}` : `album-${message.chat_id}-${message.grouped_id}`;
    const reply = message.reply_to === null ? undefined : context.thread.getMessage(message.reply_to);
    const selected = members.some(item => item.id === context.selectedMessageId);
    const { loading, avatar, previews } = context;
    const readerCount = message.outgoing ? context.readerCount : undefined;
    const senderName = !message.outgoing && message.sender_id !== null ? context.peerNames?.get(message.sender_id) ?? message.sender : message.sender;
    const replyName = reply ? !reply.outgoing && reply.sender_id !== null ? context.peerNames?.get(reply.sender_id) ?? reply.sender : reply.sender : undefined;
    const cached = this.descriptions.get(key);
    if (cached && cached.reply === reply && cached.senderName === senderName && cached.replyName === replyName && cached.selected === selected && cached.loading === loading && cached.readerCount === readerCount && cached.avatar === avatar && cached.previews.length === previews.length && cached.previews.every((item, index) => item === previews[index]) && cached.members.length === members.length && cached.members.every((item, index) => item === members[index])) return cached.node;
    const photos = members.filter(item => item.photo);
    const captions = members.filter(item => !item.photo || item.text !== "[Photo]");
    const thumbnails = previews.filter((node): node is NativeNode => node != null);
    const card: NativeNode = { k: "card", key: "bubble", p: {
      role: "terngram.message", tone: message.outgoing ? "user" : "neutral", selected, grow: 1, shrink: 1, basis: 0, min: { w: 0 }, max: { w: 1 },
      head: [{ t: senderName, s: "strong" }, { t: `  ${message.time}${members.some(item => item.edited) ? " · edited" : ""}${message.outgoing ? readerCount != null ? ` · read ${readerCount}` : members.every(item => item.read) ? " · read" : " · sent" : ""}`, s: "muted" }],
      title: "Click for message actions · double-click to reply", actions: { click: `message:${message.id}`, dblclick: `reply-message:${message.id}` },
    }, c: [
      ...(message.forwarded ? [label(`Forwarded from ${message.forwarded}`, "forwarded")] : []),
      ...(message.reply_to !== null ? [label(reply ? `↳ ${replyName}: ${preview(reply.text)}` : `↳ Reply to message #${message.reply_to}`, "reply")] : []),
      ...(members.length > 1 ? [label(`Album · ${members.length} media`, "album-count")] : []),
      ...(thumbnails.length ? [{ k: "row", key: "photo-previews", p: { gap: "sm", wrap: true, min: { w: 0 } }, c: thumbnails } satisfies NativeNode] : []),
      ...captions.map(item => ({ k: "md", key: `text-${item.id}`, p: { text: item.markdown, min: { w: 0 }, max: { w: 1 } } } satisfies NativeNode)),
      ...(photos.length ? [button(`photo:${message.id}`, loading ? "Loading photos…" : photos.length > 1 ? `View ${photos.length} photos` : "View photo", loading)] : []),
    ] };
    const initials = senderName.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] ?? "").join("").toLocaleUpperCase() || "?";
    const tone = (["accent", "info", "warning", "muted"] as const)[Math.abs(message.sender_id ?? 0) % 4]!;
    const node: NativeNode = { k: "row", key, p: { align: "start", gap: "sm", shrink: 1, min: { w: 0 }, max: { w: 1 } }, c: [
      { k: "col", key: "portrait", p: { min: { w: "4ch", h: "2lines" }, max: { w: "4ch" }, grow: 0, shrink: 0 }, c: [
        avatar ?? { k: "badge", key: "initials", p: { text: initials, tone, aria: senderName, title: senderName } },
        // Added under the portrait on selection: reveals the message without replacing its stable identity or adding a blank line in the card.
        ...(selected ? [{ k: "text", key: "selection-anchor", reveal: "nearest", p: { text: "" } } satisfies NativeNode] : []),
      ] },
      card,
    ] };
    this.descriptions.set(key, { members, reply, senderName, replyName, selected, loading, readerCount, avatar, previews, node });
    return node;
  }
}
