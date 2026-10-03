interface ReadState {
  confirmed: number;
  requested: number;
  flight?: Promise<void>;
}

/** Monotonic, single-flight acknowledgements. Never derive a later boundary from newly arrived messages. */
export class ReadReceipts {
  private states = new Map<number, ReadState>();

  constructor(
    private send: (chatId: number, maxId: number) => Promise<void>,
    private acknowledged: (chatId: number, maxId: number) => void,
    private failed: (error: unknown) => void,
  ) {}

  read(chatId: number, maxId: number): Promise<void> {
    let state = this.states.get(chatId);
    if (!state) {
      state = { confirmed: 0, requested: 0 };
      this.states.set(chatId, state);
    }
    if (maxId <= state.confirmed) {
      this.acknowledged(chatId, state.confirmed);
      return Promise.resolve();
    }
    state.requested = Math.max(state.requested, maxId);
    return state.flight ??= this.flush(chatId, state);
  }

  clear(): void { this.states.clear(); }

  private async flush(chatId: number, state: ReadState): Promise<void> {
    try {
      while (this.states.get(chatId) === state && state.requested > state.confirmed) {
        const maxId = state.requested;
        await this.send(chatId, maxId);
        if (this.states.get(chatId) !== state) return;
        state.confirmed = maxId;
        this.acknowledged(chatId, maxId);
      }
    } catch (error) {
      if (this.states.get(chatId) === state) {
        state.requested = state.confirmed; // A later explicit read can retry; failed RPCs never advance confirmed state.
        this.failed(error);
      }
    } finally {
      state.flight = undefined;
    }
  }
}
