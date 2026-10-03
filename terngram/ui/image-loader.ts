import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

type ImageEntry = { requested: boolean; node?: NativeNode | null };

/**
 * Background image loading for one account session: deduplicated, bounded, newest request first.
 * `null` records unavailable media. Failed requests can be retried by the next explicit data refresh.
 */
export class ImageLoader {
  private entries = new Map<string, ImageEntry>();
  private queue: { key: string; entry: ImageEntry; load: () => Promise<NativeNode | null> }[] = [];
  private active = 0;

  constructor(private concurrency: number, private loaded: () => void, private failed: (error: unknown) => void) {}

  get(key: string): NativeNode | null | undefined { return this.entries.get(key)?.node; }

  request(key: string, load: () => Promise<NativeNode | null>): void {
    if (this.entries.get(key)?.requested) return;
    const entry: ImageEntry = { requested: true };
    this.entries.set(key, entry); this.queue.push({ key, entry, load }); this.pump();
  }

  /** Drops cached media; queued or in-flight results for this entry are no longer publishable. */
  invalidate(key: string): void { this.entries.delete(key); }

  /** Navigation abandons queued decoration for the old chat, but keeps completed and active cache entries. */
  cancelQueued(): void {
    for (const { key, entry } of this.queue) if (this.entries.get(key) === entry) this.entries.delete(key);
    this.queue.length = 0;
  }

  clear(): void {
    this.entries.clear(); this.queue.length = 0;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const { key, entry, load } = this.queue.pop()!;
      if (this.entries.get(key) !== entry) continue;
      this.active++;
      void load().then(
        node => { if (this.entries.get(key) === entry) entry.node = node; },
        error => { if (this.entries.get(key) === entry) { entry.requested = false; this.failed(error); } },
      ).finally(() => {
        this.active--;
        if (this.entries.get(key) === entry) this.loaded();
        this.pump();
      });
    }
  }
}
