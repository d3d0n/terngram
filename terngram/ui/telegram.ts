import type { Subprocess } from "bun";
import { RequestCooldowns } from "./request-cooldowns";

export interface Dialog {
  id: number;
  title: string;
  unread_count: number;
  preview: string;
  writable: boolean;
  last_message_id: number | null;
  kind: "user" | "bot" | "group" | "channel" | "saved";
  presence?: PeerPresence | null;
}

export interface DialogCursor {
  date: number;
  id: number;
  peer_id: number;
}

export interface DialogPage {
  dialogs: Dialog[];
  cursor: DialogCursor | null;
}

export interface ChatMessage {
  id: number;
  chat_id: number;
  sender: string;
  text: string;
  time: string;
  outgoing: boolean;
  reply_to: number | null;
  edited: boolean;
  photo: boolean;
  media_id: string | null;
  forwarded: string | null;
  read: boolean;
  grouped_id: string | null;
  sender_id: number | null;
  markdown: string;
}

export interface PeerPresence {
  state: "online" | "offline" | "recently" | "last_week" | "last_month" | "unknown";
  expires?: number;
  was_online?: number;
}
export type TelegramUpdate =
  | { kind: "presence"; chat_id: number; presence: PeerPresence }
  | { kind: "typing"; chat_id: number; sender_id: number; sender: string; action: string; expires_in: number }
  | { kind: "message"; chat_id: number; message: ChatMessage }
  | { kind: "delete"; chat_id: number; ids: number[] }
  | { kind: "read"; chat_id: number; max_id: number; outbox: boolean }
  | { kind: "dialog_changed"; chat_id: number; title?: string; participants_changed?: boolean; avatar_changed?: boolean; permissions_changed?: boolean }
  | { kind: "refresh"; chat_id: number };

export interface PendingSend {
  text: string;
  reply_to: number | null;
  random_id: string;
}

export interface ClientState {
  drafts: Record<string, string>;
  selected_id: number | null;
  pending_sends: Record<string, PendingSend>;
}

export interface Photo {
  data: string;
  mime: string;
  width: number;
  height: number;
}

export class TelegramRequestError extends Error {
  constructor(readonly method: string, message: string, readonly retryAfterSeconds = 0) {
    super(`${method}: ${message}`);
    this.name = "TelegramRequestError";
  }
}

export class Telegram {
  onUpdate?: (update: TelegramUpdate) => void;
  onStatus?: (connected: boolean) => void;
  onFailure?: (message: string) => void;
  private process: Subprocess<"pipe", "pipe", "ignore">;
  private sequence = 0;
  private stopped = false;
  private pending = new Map<number, { method: string; peer?: number; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(python: string, dataDir: string, root: string, private cooldowns: RequestCooldowns) {
    this.process = Bun.spawn([python, "-m", "terngram.worker", "--data-dir", dataDir], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    void this.read();
    void this.process.exited.then(() => this.fail("The local Telegram process stopped. Reconnect to continue."));
  }

  call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.stopped) return Promise.reject(new TelegramRequestError(method, "The Telegram connection is closed. Reconnect to continue."));
    const peer = typeof args[0] === "number" ? args[0] : undefined;
    const remaining = this.cooldowns.remaining(method, peer);
    if (remaining) return Promise.reject(new TelegramRequestError(method, `Telegram cooldown: retry in ${remaining} seconds.`, remaining));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, peer, resolve: value => resolve(value as T), reject });
      try {
        this.process.stdin.write(JSON.stringify({ id, method, args }) + "\n");
      } catch {
        this.fail("The local Telegram connection is unavailable. Reconnect to continue.");
      }
    });
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const bytes of this.process.stdout) {
        buffered += decoder.decode(bytes, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const message = JSON.parse(line);
          if (message.event === "update") {
            const { event: _event, ...update } = message;
            this.onUpdate?.(update as TelegramUpdate);
            continue;
          }
          if (message.event === "connection") {
            this.onStatus?.(message.connected === true);
            continue;
          }
          const request = this.pending.get(message.id);
          if (!request) continue;
          this.pending.delete(message.id);
          if (typeof message.error === "string") {
            const retryAfter = typeof message.retry_after === "number" && Number.isFinite(message.retry_after) ? Math.max(0, message.retry_after) : 0;
            this.cooldowns.block(request.method, request.peer, retryAfter, message.retry_scope === "peer" ? "peer" : "method");
            request.reject(new TelegramRequestError(request.method, `${typeof message.error_code === "string" ? `[${message.error_code}] ` : ""}${message.error}`, retryAfter));
          }
          else request.resolve(message.result);
        }
      }
      if (!this.stopped) this.fail("The local Telegram connection ended. Reconnect to continue.");
    } catch {
      this.fail("The local Telegram connection failed. Reconnect to continue.");
    }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) request.reject(new Error(`${request.method}: ${message}`));
    this.pending.clear();
    this.onStatus?.(false);
    this.onFailure?.(message);
  }

  async close(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      for (const request of this.pending.values()) request.reject(new Error("Client closed."));
      this.pending.clear();
      this.onStatus?.(false);
    }
    this.process.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.process.exited,
      new Promise<void>(resolve => { timer = setTimeout(() => { this.process.kill(); resolve(); }, 2000); }),
    ]);
    clearTimeout(timer);
  }
}
