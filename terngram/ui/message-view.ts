import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { ChatState } from "./chat-state";
import type { ChatMessage } from "./telegram";
import { button, label, preview } from "./nodes";

function messageContent(message: ChatMessage): NativeNode {
  const { text } = message;
  const boundary = (index: number) => index === 0 || index === text.length
    || !(text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff
      && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff);
  const entities = message.entities.filter(entity =>
    Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.offset >= 0
    && entity.length > 0 && entity.offset + entity.length <= text.length
    && boundary(entity.offset) && boundary(entity.offset + entity.length)
    && typeof entity.type?.["@type"] === "string");
  const blocks = entities.filter(entity => ["textEntityTypePre", "textEntityTypePreCode"].includes(entity.type["@type"]))
    .sort((left, right) => left.offset - right.offset);
  const nodes: NativeNode[] = [];
  const prose = (start: number, end: number) => {
    if (start >= end) return;
    const ranges = entities.filter(entity => entity.offset < end && entity.offset + entity.length > start);
    const boundaries = new Set([start, end]);
    for (const entity of ranges) {
      boundaries.add(Math.max(start, entity.offset));
      boundaries.add(Math.min(end, entity.offset + entity.length));
    }
    const positions = [...boundaries].sort((left, right) => left - right);
    const spans: TspSpan[] = [];
    for (let index = 0; index + 1 < positions.length; index++) {
      const from = positions[index]!, to = positions[index + 1]!;
      const active = ranges.filter(entity => entity.offset <= from && entity.offset + entity.length >= to);
      const styles: string[] = [];
      let href: string | undefined;
      if (active.some(entity => entity.type["@type"] === "textEntityTypeCode")) styles.push("code");
      else for (const entity of active) {
        switch (entity.type["@type"]) {
          case "textEntityTypeBold": styles.push("strong"); break;
          case "textEntityTypeItalic": styles.push("em"); break;
          case "textEntityTypeStrikethrough": styles.push("del"); break;
          case "textEntityTypeTextUrl": href = entity.type.url; break;
          case "textEntityTypeMentionName": href = `tg://user?id=${entity.type.user_id}`; break;
          case "textEntityTypeUrl": href = text.slice(entity.offset, entity.offset + entity.length); break;
        }
      }
      spans.push({ t: text.slice(from, to), ...(styles.length ? { s: styles.join(" ") } : {}), ...(href ? { href } : {}) });
    }
    nodes.push({ k: "text", key: `prose-${start}`, p: { spans, wrap: "word", min: { w: 0 }, max: { w: 1 } } });
  };
  let position = 0;
  for (const block of blocks) {
    if (block.offset < position) continue;
    prose(position, block.offset);
    const end = block.offset + block.length;
    nodes.push({ k: "code", key: `code-${block.offset}`, p: {
      text: text.slice(block.offset, end), lang: block.type.language, wrap: true,
      min: { w: 0 }, max: { w: 1 },
    } });
    position = end;
  }
  prose(position, text.length);
  return { k: "col", key: `text-${message.id}`, p: { min: { w: 0 }, max: { w: 1 } }, c: nodes };
}

export class MessageView {
  private descriptions = new Map<string, { members: readonly ChatMessage[]; reply?: ChatMessage; senderName: string; replyName?: string; selected: boolean; loading: boolean; readerCount?: number | null; avatar?: NativeNode | null; previews: readonly (NativeNode | null | undefined)[]; node: NativeNode }>();

  clear(): void { this.descriptions.clear(); }

  describe(members: readonly ChatMessage[], context: { thread: ChatState; selectedMessageId: number | null; loading: boolean; readerCount?: number | null; peerNames?: ReadonlyMap<number, string>; avatar: NativeNode | null | undefined; previews: readonly (NativeNode | null | undefined)[] }): NativeNode {
    const message = members[0]!;
    const failed = members.find(item => item.sending_state === "failed");
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
    const delivery = members.some(item => item.sending_state === "failed") ? " · not sent"
      : members.some(item => item.sending_state === "queued") ? " · sending…"
      : readerCount != null ? ` · read ${readerCount}` : members.every(item => item.read) ? " · read" : " · sent";
    const card: NativeNode = { k: "card", key: "bubble", p: {
      role: "terngram.message", tone: failed ? "error" : message.outgoing ? "user" : "neutral", status: failed ? "error" : undefined, selected, grow: 1, shrink: 1, basis: 0, min: { w: 0 }, max: { w: 1 },
      head: [{ t: senderName, s: "strong" }, { t: `  ${message.time}${members.some(item => item.edited) ? " · edited" : ""}${message.outgoing ? delivery : ""}`, s: "muted" }],
      title: failed ? "Message not sent · Click for Retry actions" : "Click for message actions · double-click to reply", actions: { click: `message:${failed?.id ?? message.id}`, dblclick: failed ? `retry-message:${failed.id}` : `reply-message:${message.id}` },
    }, c: [
      ...(message.forwarded ? [label(`Forwarded from ${message.forwarded}`, "forwarded")] : []),
      ...(message.reply_to !== null ? [label(reply ? `↳ ${replyName}: ${preview(reply.text)}` : `↳ Reply to message #${message.reply_to}`, "reply")] : []),
      ...(members.length > 1 ? [label(`Album · ${members.length} media`, "album-count")] : []),
      ...(thumbnails.length ? [{ k: "row", key: "photo-previews", p: { gap: "sm", wrap: true, min: { w: 0 } }, c: thumbnails } satisfies NativeNode] : []),
      ...captions.map(messageContent),
      ...(photos.length ? [button(`photo:${message.id}`, loading ? "Loading photos…" : photos.length > 1 ? `View ${photos.length} photos` : "View photo", loading)] : []),
    ] };
    const initials = senderName.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] ?? "").join("").toLocaleUpperCase() || "?";
    const tone = (["accent", "info", "warning", "muted"] as const)[Math.abs(message.sender_id ?? 0) % 4]!;
    const node: NativeNode = { k: "row", key, p: { align: "start", gap: "sm", shrink: 1, min: { w: 0 }, max: { w: 1 } }, c: [
      { k: "col", key: "portrait", p: { min: { w: "4ch", h: "2lines" }, max: { w: "4ch" }, grow: 0, shrink: 0 }, c: [
        avatar ?? { k: "card", key: "initials", p: { tone, aria: senderName, title: senderName, min: { w: "4ch", h: "2lines" }, max: { w: "4ch", h: "2lines" }, grow: 0, shrink: 0 }, c: [
          { k: "row", p: { align: "center", grow: 1 }, c: [
            { k: "spacer", p: { grow: 1 } },
            { k: "text", p: { text: initials, wrap: "none", shrink: 0 } },
            { k: "spacer", p: { grow: 1 } },
          ] },
        ] },
        // Added under the portrait on selection: reveals the message without replacing its stable identity or adding a blank line in the card.
        ...(selected ? [{ k: "text", key: "selection-anchor", reveal: "nearest", p: { text: "" } } satisfies NativeNode] : []),
      ] },
      card,
    ] };
    this.descriptions.set(key, { members, reply, senderName, replyName, selected, loading, readerCount, avatar, previews, node });
    return node;
  }
}
