/** Server-directed cooldowns only: no guessed rate limit and no automatic retries. */
export class RequestCooldowns {
  private deadlines = new Map<string, number>();
  constructor(private now: () => number = () => performance.now()) {}

  block(method: string, peer: number | undefined, seconds: number, scope: "method" | "peer"): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const key = scope === "peer" && peer !== undefined ? `${method}:${peer}` : method;
    this.deadlines.set(key, Math.max(this.deadlines.get(key) ?? 0, this.now() + seconds * 1000));
  }
  remaining(method: string, peer?: number): number {
    const now = this.now();
    let remaining = 0;
    for (const key of peer === undefined ? [method] : [method, `${method}:${peer}`]) {
      const until = this.deadlines.get(key);
      if (until === undefined) continue;
      if (until <= now) this.deadlines.delete(key);
      else remaining = Math.max(remaining, Math.ceil((until - now) / 1000));
    }
    return remaining;
  }
  clear(): void { this.deadlines.clear(); }
}
