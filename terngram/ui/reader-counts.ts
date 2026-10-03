interface ReaderState {
  chat: number;
  value?: number | null;
  nextRequest: number;
  revision: number;
  flight?: Promise<void>;
}

/** Only explicit requests refresh counts. Render/get never sends an RPC or starts a timer. */
export class ReaderCounts {
  private states = new Map<string, ReaderState>();

  constructor(
    private query: (chat: number, id: number) => Promise<number | null>,
    private changed: () => void,
    private failed: (error: unknown) => void,
    private now: () => number = () => performance.now(),
  ) {}

  get(chat: number, id: number): number | null | undefined {
    return this.states.get(`${chat}:${id}`)?.value;
  }

  request(chat: number, id: number): Promise<void> {
    const key = `${chat}:${id}`;
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= 256) {
        for (const [oldKey, entry] of this.states) {
          if (entry.flight) continue;
          this.states.delete(oldKey);
          break;
        }
        if (this.states.size >= 256) return Promise.resolve();
      }
      state = { chat, nextRequest: -Infinity, revision: 0 };
      this.states.set(key, state);
    }
    if (state.flight) return state.flight;
    if (this.now() < state.nextRequest) return Promise.resolve();
    state.nextRequest = this.now() + 30_000;
    return state.flight = this.fetch(key, id, state);
  }

  invalidateChat(chat: number): void {
    for (const state of this.states.values()) {
      if (state.chat !== chat) continue;
      state.value = undefined;
      state.revision++;
    }
  }

  clear(): void { this.states.clear(); }

  private async fetch(key: string, id: number, state: ReaderState): Promise<void> {
    const revision = state.revision;
    try {
      await Promise.resolve();
      if (this.states.get(key) !== state || state.revision !== revision) return;
      const value = await this.query(state.chat, id);
      if (this.states.get(key) !== state || state.revision !== revision) return;
      if (state.value !== value) {
        state.value = value;
        this.changed();
      }
    } catch (error) {
      if (this.states.get(key) !== state) return;
      const retryAfter = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
        state.nextRequest = Math.max(state.nextRequest, this.now() + retryAfter * 1000);
      }
      this.failed(error);
    } finally {
      state.nextRequest = Math.max(state.nextRequest, this.now() + 30_000);
      state.flight = undefined;
    }
  }
}
