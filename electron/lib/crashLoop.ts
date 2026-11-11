/**
 * Stops a reload loop after renderer crashes (1.5.1 M5, register D13). The main process reloads the window when its renderer
 * dies, so crash recovery can restore the tabs from the saved session. A file that crashes the page when it is restored would
 * make that a loop. After `limit` crashes within `windowMs` the next start comes up with no tabs and a notice; the recovery
 * logs are not touched, so each file's unsaved edits are offered when it is opened by hand.
 */
export class CrashLoopGuard {
  private readonly times: number[] = [];

  constructor(
    private readonly limit = 2,
    private readonly windowMs = 60_000,
  ) {}

  /**
   * Records a crash at `now` (ms). Returns true when the window may reload as usual, false when this crash is the one that
   * makes a loop: the caller then starts with no tabs and shows the notice (see `tripped`).
   */
  recordCrash(now: number): boolean {
    this.times.push(now);
    while (this.times.length > 0 && now - this.times[0]! > this.windowMs) this.times.shift();
    return this.times.length < this.limit;
  }

  /** True while `limit` or more crashes lie within the window ending at `now`. */
  tripped(now: number): boolean {
    return this.times.filter((time) => now - time <= this.windowMs).length >= this.limit;
  }

  /** Forgets the crashes (the window started cleanly with no tabs and stayed up). */
  reset(): void {
    this.times.length = 0;
  }
}

/** The notice after the guard tripped, in the words of docs/milestone-1.5/1.5.5-ui-spec.md section 6 ("offered, not asked for"). */
export const CRASH_LOOP_NOTICE =
  'PDF Suite closed unexpectedly twice, so it started without your files. Your unsaved edits are kept and will be offered when you open each file.';
