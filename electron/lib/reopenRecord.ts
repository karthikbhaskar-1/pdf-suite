import { grantKey, isGrantablePath } from './pathGrants';

/**
 * What the main process lets a Recent or session-restore open (files:openKnown) make writable without a user choice. Ruling 8
 * allows exactly two sources, nothing more:
 *   1. the tabs that were open when the last session ended, and
 *   2. the entries of the Recent list (at most 10, and recent:add takes only a path that is open at that moment).
 * Each such path may be used ONCE per session, so one click cannot be repeated by a page into many opens. Every other path,
 * including one the user opened and closed in an earlier session, needs a user choice (Open dialog, drop, command line).
 *
 * "Once per session" and "is one of those paths" are decided on path TEXT only (grantKey), never with a file-system call: every
 * stored path is already in the main process's canonical spelling (it was handed over by canonicalSpelling and reported back by
 * markOpen), and the caller resolves the REQUESTED path once, asynchronously, to the existing grant before it asks here
 * (PathGrants.findGranted). So a once-allowed file is found under any spelling of it, and a sleeping network share can never block
 * the main thread from in here.
 *
 * The record is written by the main process alone: it follows its own acceptance of an open (noteOpen after
 * PathGrants.markOpen) and of a close (noteClosed), and the main process saves `list()` in its own file as it changes. The
 * page's storage plays no part.
 */
export class ReopenRecord {
  /** Paths open now: key to path. This is what is saved. */
  private readonly openNow = new Map<string, string>();
  /** The tabs open when the previous session ended (loaded by restore), by key. */
  private readonly lastSession = new Set<string>();
  /** Paths already used by openKnown in this session, by key. */
  private readonly used = new Set<string>();
  private quitting = false;

  /** @param recent the Recent list now (the main process's own; at most 10 entries) */
  constructor(private readonly recent: () => readonly string[] = () => []) {}

  /** The main process accepted a document open on this path (PathGrants.markOpen returned true). */
  noteOpen(path: string): void {
    if (isGrantablePath(path)) this.openNow.set(grantKey(path), path);
  }

  /** The main process accepted a close. Ignored once quitting began, so the tabs that close at quit stay in the saved list. */
  noteClosed(path: string): void {
    if (this.quitting || !isGrantablePath(path)) return;
    this.openNow.delete(grantKey(path));
  }

  /** Quitting began: the saved list is now what was open at this moment, whatever closes after. Call it before closing tabs. */
  freeze(): void {
    this.quitting = true;
  }

  /** The paths open now (or at the start of quitting). The main process saves this, and only this. */
  list(): string[] {
    return [...this.openNow.values()];
  }

  /** Loads what the previous run saved: the tabs open when it ended. Entries that are not paths are skipped. Returns how many. */
  restore(saved: unknown): number {
    if (!Array.isArray(saved)) return 0;
    let restored = 0;
    for (const path of saved) {
      if (typeof path === 'string' && isGrantablePath(path)) {
        this.lastSession.add(grantKey(path));
        restored += 1;
      }
    }
    return restored;
  }

  /**
   * True once per session for a path of the last session's tabs or of the Recent list; false for any other path, and for a
   * second use. The caller then grants the open (PathGrants.allowOpen).
   */
  allowOnce(path: string): boolean {
    if (!isGrantablePath(path)) return false;
    const key = grantKey(path);
    if (this.used.has(key)) return false;
    const known = this.lastSession.has(key) || this.recent().slice(0, 10).some((entry) => isGrantablePath(entry) && grantKey(entry) === key);
    if (!known) return false;
    this.used.add(key);
    return true;
  }
}
