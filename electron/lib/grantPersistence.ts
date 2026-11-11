import { saveAtomic } from './atomicWrite';

/**
 * Saves the granted paths to disk. A change schedules one write after `delayMs`, so a burst of grants (a
 * multi-file open, or a recent list) costs one write. The write is asynchronous and atomic (see saveAtomic), so a
 * crash mid-write leaves the previous file. Writes never overlap: a change made during a write waits for it and is
 * then written. `flush` writes at once, for quitting.
 */
export class GrantPersistence {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly file: string,
    private readonly snapshot: () => string[],
    private readonly delayMs = 250,
    private readonly write: (target: string, bytes: Uint8Array) => Promise<void> = saveAtomic,
  ) {}

  /** True when a change has not been written yet. */
  get pending(): boolean {
    return this.dirty;
  }

  /** Marks the grants changed and schedules a write. */
  schedule(): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(() => undefined);
    }, this.delayMs);
  }

  /** Writes any pending change now, and resolves when the file on disk is current. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.drain();
  }

  /** Stops the scheduled write. Nothing is written after a call to this. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
  }

  private async drain(): Promise<void> {
    // A write in progress is waited for, so writes never overlap. A change made meanwhile is then written.
    // A loop, not an if: two drains can wait for the same write, and the one that resumes second must see the write the first one
    // started and wait for that too, or the two writes overlap and flush resolves while one is still in flight.
    while (this.writing) await this.writing;
    if (!this.dirty) return;
    this.dirty = false;
    const bytes = new TextEncoder().encode(JSON.stringify(this.snapshot()));
    // A failed write leaves the change pending. The next schedule or flush tries again, so nothing loops here.
    const attempt = this.write(this.file, bytes).then(undefined, () => {
      this.dirty = true;
    });
    this.writing = attempt;
    try {
      await attempt;
    } finally {
      if (this.writing === attempt) this.writing = null;
    }
  }
}
