/** Session-local browser history plus a five-chat most-recently-visited list. */
export class ChatNavigation {
  private entries: number[] = [];
  private position = -1;
  private recentIds: number[] = [];
  private lastTap?: { direction: -1 | 1; at: number };

  visit(id: number): void {
    if (this.entries[this.position] !== id) {
      this.entries.splice(this.position + 1);
      this.entries.push(id);
      this.position = this.entries.length - 1;
    }
    this.touch(id);
    this.lastTap = undefined;
  }
  recent(): readonly number[] { return this.recentIds; }
  private touch(id: number): void { this.recentIds = [id, ...this.recentIds.filter(value => value !== id)].slice(0, 5); }

  private destination(direction: -1 | 1, available: (id: number) => boolean): number {
    for (let index = this.position + direction; index >= 0 && index < this.entries.length; index += direction) {
      if (available(this.entries[index]!)) return index;
    }
    return -1;
  }
  canMove(direction: -1 | 1, available: (id: number) => boolean): boolean { return this.destination(direction, available) >= 0; }
  move(direction: -1 | 1, available: (id: number) => boolean): number | null {
    const index = this.destination(direction, available);
    if (index < 0) return null;
    this.position = index;
    const id = this.entries[index]!;
    this.touch(id); this.lastTap = undefined;
    return id;
  }

  /** No timer or input delay: the first arrow passes through, the second matching arrow activates. */
  tap(direction: -1 | 1 | null, now = performance.now()): boolean {
    const previous = this.lastTap;
    this.lastTap = direction === null ? undefined : { direction, at: now };
    if (direction !== null && previous?.direction === direction && now >= previous.at && now - previous.at <= 350) {
      this.lastTap = undefined;
      return true;
    }
    return false;
  }
  clear(): void {
    this.entries = []; this.position = -1; this.recentIds = []; this.lastTap = undefined;
  }
}
