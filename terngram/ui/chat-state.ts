import type { ChatMessage, PendingSend } from "./telegram";

/** Merge chronological pages in linear time; the newer page wins overlapping IDs. */
export function mergeHistory(current: readonly ChatMessage[], page: readonly ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  let left = 0, right = 0;
  while (left < current.length || right < page.length) {
    let message: ChatMessage;
    if (right === page.length || (left < current.length && current[left]!.id < page[right]!.id)) message = current[left++]!;
    else {
      message = page[right++]!;
      if (current[left]?.id === message.id) left++;
    }
    if (merged.at(-1)?.id === message.id) merged[merged.length - 1] = message;
    else merged.push(message);
  }
  return merged;
}

/** Telegram album IDs are 64-bit integers; keep them as strings across JSON. */
export function messageGroups(messages: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  const albums = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    if (message.grouped_id === null) { groups.push([message]); continue; }
    const key = `${message.chat_id}:${message.grouped_id}`;
    const album = albums.get(key);
    if (album) album.push(message);
    else { const group = [message]; albums.set(key, group); groups.push(group); }
  }
  return groups;
}

/** Per-chat state survives navigation; revisions keep slow history responses behind live events. */
export class ChatState {
  messages: ChatMessage[] = [];
  loaded = false;
  loading = false;
  more = true;
  draft = "";
  replyTo: number | null = null;
  editing: { id: number; draft: string; replyTo: number | null } | null = null;
  sending = false;
  pendingSend: PendingSend | null = null;
  retryDisplayId: number | null = null;
  private incoming = new Set<number>();
  revision = 0;
  private changes = new Map<number, number>();
  private readMax = 0;
  private grouped?: ChatMessage[][];

  get newMessages(): number { return this.incoming.size; }
  get groups(): readonly ChatMessage[][] { return this.grouped ??= messageGroups(this.messages); }

  private position(id: number): number {
    let low = 0, high = this.messages.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.messages[mid]!.id < id) low = mid + 1; else high = mid;
    }
    return low;
  }

  getMessage(id: number): ChatMessage | undefined {
    const index = this.position(id);
    return this.messages[index]?.id === id ? this.messages[index] : undefined;
  }

  acknowledgeNewMessages(maxId = Infinity): void {
    for (const id of this.incoming) if (id <= maxId) this.incoming.delete(id);
  }

  private displayedMessage(message: ChatMessage): ChatMessage {
    if (this.retryDisplayId !== null && message.id === this.pendingSend?.message_id && message.sending_state)
      return { ...message, id: this.retryDisplayId, sending_state: "failed" };
    if (this.getMessage(message.id)?.sending_state === "failed" && message.sending_state === "queued")
      return { ...message, sending_state: "failed" };
    return message;
  }

  receive(message: ChatMessage): boolean {
    message = this.displayedMessage(message);
    const low = this.position(message.id);
    this.grouped = undefined;
    const isNew = this.messages[low]?.id !== message.id;
    if (isNew && !message.outgoing && !message.edited && !message.read) this.incoming.add(message.id);
    this.changes.set(message.id, ++this.revision);
    if (message.outgoing && message.read) this.readMax = Math.max(this.readMax, message.id);
    const current = message.outgoing && !message.read && message.id <= this.readMax ? { ...message, read: true } : message;
    if (!isNew) this.messages[low] = current;
    else if (low === this.messages.length) this.messages.push(current);
    else this.messages.splice(low, 0, current);
    return isNew;
  }

  remove(ids: readonly number[]): void {
    if (this.retryDisplayId !== null && this.pendingSend) ids = ids.filter(id => id !== this.retryDisplayId);
    const removed = new Set(ids);
    for (const id of ids) { this.changes.set(id, ++this.revision); this.incoming.delete(id); }
    this.grouped = undefined;
    this.messages = this.messages.filter(message => !removed.has(message.id));
    if (this.editing && removed.has(this.editing.id)) this.cancelEdit();
    if (this.replyTo !== null && removed.has(this.replyTo)) this.replyTo = null;
    if (this.editing?.replyTo !== null && this.editing?.replyTo !== undefined && removed.has(this.editing.replyTo)) this.editing.replyTo = null;
  }

  markRead(maxId: number): void {
    this.readMax = Math.max(this.readMax, maxId);
    for (let index = 0; index < this.messages.length; index++) {
      const message = this.messages[index]!;
      if (message.id > this.readMax) break;
      if (message.outgoing && !message.read) { this.messages[index] = { ...message, read: true }; this.grouped = undefined; }
    }
  }

  applyPage(page: readonly ChatMessage[], started: number, replace = false): void {
    for (const message of page) if (message.outgoing && message.read) this.readMax = Math.max(this.readMax, message.id);
    this.grouped = undefined;
    const safe: ChatMessage[] = [];
    for (const item of page) {
      const message = this.displayedMessage(item);
      const changed = (this.changes.get(message.id) ?? 0) > started;
      const current = changed ? this.getMessage(message.id) : message;
      if (current) safe.push(current.outgoing && !current.read && current.id <= this.readMax ? { ...current, read: true } : current);
    }
    if (this.retryDisplayId !== null) safe.sort((left, right) => left.id - right.id);
    const first = safe[0]?.id ?? -Infinity;
    const retained = replace ? this.messages.filter(message => message.id < first || (this.changes.get(message.id) ?? 0) > started) : this.messages;
    this.messages = mergeHistory(retained, safe);
    this.loaded = true;
  }

  /** Recover outbox text without replacing a newer draft or the draft saved before editing. */
  restorePendingSend(): void {
    const pending = this.pendingSend;
    if (!pending?.text) return;
    this.cancelEdit();
    if (this.draft !== pending.text) this.draft = this.draft ? `${this.draft}\n\n${pending.text}` : pending.text;
    if (this.draft === pending.text) this.replyTo = pending.reply_to;
  }

  edit(message: ChatMessage): void {
    if (!this.editing) this.editing = { id: message.id, draft: this.draft, replyTo: this.replyTo };
    else this.editing.id = message.id;
    this.draft = message.markdown;
    this.replyTo = null;
  }

  cancelEdit(): void {
    if (!this.editing) return;
    this.draft = this.editing.draft;
    this.replyTo = this.editing.replyTo;
    this.editing = null;
  }
}
