import type { FileStat } from '../../platform/desktop/contract';

/** How often an open document's file is checked while the window is open. */
export const DISK_WATCH_INTERVAL_MS = 5000;

/** True when the file on disk is not the one that was seen: its size or modified time differs, or it is gone. (The watch treats a gone file apart: see onMissing.) */
export function fileChanged(seen: FileStat, now: FileStat | null): boolean {
  if (!now) return true;
  return now.size !== seen.size || now.modified !== seen.modified;
}

export interface DiskWatchOptions {
  path: string;
  /** The file as it was when the document was opened or last saved. Undefined means there is nothing to compare. */
  seen: () => FileStat | undefined;
  /** Reads the file's current stat. Null when the file is gone. */
  stat: (path: string) => Promise<FileStat | null>;
  /** False once the document is closed. The watch then stops by itself. */
  isActive: () => boolean;
  /** True while the document is being saved, so the app's own write is not reported as a change. */
  isSaving?: () => boolean;
  /** Called once, when the file is seen changed. The watch then stops; a new one starts after the user decides. */
  onChanged: () => void;
  /**
   * Called once when the file is first seen missing (moved, renamed or deleted by another program). A missing file is not a
   * change to choose about: there is nothing to reload, and a save puts the file back. The watch goes on, quietly, and
   * reports again only after the file has been seen again.
   */
  onMissing?: () => void;
  /** Called when a file that was reported missing is seen in its place again. */
  onFound?: () => void;
  /** Where focus is listened for. Defaults to the global object (the window). */
  target?: EventTarget;
  intervalMs?: number;
}

/**
 * Checks the document's file on window focus and every few seconds. The first change reports once (onChanged) and
 * goes on only for a file that goes missing. Returns the function that stops it.
 */
export function startDiskWatch(options: DiskWatchOptions): () => void {
  const target = options.target ?? (globalThis as unknown as EventTarget);
  const interval = options.intervalMs ?? DISK_WATCH_INTERVAL_MS;
  let stopped = false;
  let checking = false;
  let missing = false;
  let reportedChange = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
    target.removeEventListener('focus', onFocus);
  };

  const check = async (): Promise<void> => {
    if (stopped || checking) return;
    if (!options.isActive()) {
      stop();
      return;
    }
    if (options.isSaving?.() || !options.seen()) return;
    checking = true;
    try {
      const now = await options.stat(options.path).catch(() => null);
      // A save may have finished while the stat ran: the stamp it left is the one to compare with.
      if (stopped || options.isSaving?.()) return;
      const seen = options.seen();
      if (!seen) return;
      if (now === null) {
        if (!missing) {
          missing = true;
          options.onMissing?.();
        }
        return;
      }
      // The file is there again (or was saved): the next disappearance is news again.
      if (missing) {
        missing = false;
        options.onFound?.();
      }
      // A change is reported once. The watch then goes on, only to notice a file that goes missing while the user is still
      // deciding (a bar that is up must not hide that). A new watch starts after the user decides, and replaces this one.
      if (!reportedChange && fileChanged(seen, now)) {
        reportedChange = true;
        options.onChanged();
      }
    } finally {
      checking = false;
    }
  };

  const onFocus = (): void => {
    void check();
  };

  target.addEventListener('focus', onFocus);
  timer = setInterval(() => void check(), interval);
  return stop;
}
