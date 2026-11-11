import { win32 } from 'node:path';
import { MAX_PATH_LENGTH } from '../../src/platform/desktop/contract';

/**
 * The paths the main process will read, stat or write. A path is granted only from a source the
 * user chose: the open dialog, the command line or a second launch, a drop, the Save dialog, or a grant
 * the app recorded earlier (recent files, and the paths of the recovery snapshot, which were all granted
 * when they were first opened). The renderer cannot grant a path. There is no IPC call that takes a
 * path to grant from the page.
 *
 * Reading and writing are separate. A read grant is enough to read or stat a file, and is what the saved list
 * restores at startup and what the recent list adds. A file may be written (saveAtomic) only when
 *   (a) a document of it is open in a tab right now: the renderer reports the open and the close, and an open is
 *       accepted only for a path this process itself just read (noteRead) AND that was handed over through a user choice
 *       in this session: the Open dialog, the command line or a second launch, a drop, the Save dialog (grantChosen,
 *       grantWrite), or a Recent or session-restore open that the main process itself runs (allowOpen). A path that was
 *       only restored from the saved list, or shown in the Recent list, is read-only: the page cannot make it writable
 *       by reading it and reporting it open; or
 *   (b) the user picked it in a Save / Save As dialog in this session.
 * Neither is saved. Closing the document revokes both for that path. A saved grant for a file that is not open stays
 * read-only.
 *
 * Trust assumption: the preload sends a drop grant only from a trusted drop event (event.isTrusted),
 * and the page cannot reach that channel. The app runs on Windows, so keys are compared as Windows
 * paths: case-insensitive, with '..' and repeated separators resolved, and UNC paths kept whole.
 */

/**
 * Most paths kept at once. Far above the tabs one session can hold. The oldest grant is dropped first, but never a path
 * that is open in a tab or was picked in a Save dialog: dropping it would take its write right away from a document the
 * user is working on. Open paths can therefore keep the list above this number; they are few.
 */
export const MAX_GRANTS = 500;

/** The comparison key for a path. Two spellings of the same file give the same key. */
export function grantKey(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * A path that could be granted: an absolute Windows path with no NUL and bounded length. Any
 * extension qualifies, because the user chose the file; the engine decides whether it is a PDF.
 */
export function isGrantablePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    !path.includes('\0') &&
    win32.isAbsolute(path)
  );
}

/** The \\server\share root of a UNC path (lower case), or null when the path is not a plain UNC path. */
function uncRoot(path: string): string | null {
  const normalized = win32.normalize(path);
  if (!/^\\\\[^\\/?.][^\\/]*\\[^\\/]+/.test(normalized)) return null;
  return win32.parse(normalized).root.replace(/[\\/]+$/, '').toLowerCase();
}

export class PathGrants {
  /** Key to the normalized path, oldest first. */
  private readonly byKey = new Map<string, string>();
  /** Keys of documents open in a tab now (see markOpen). Session only, never saved. */
  private readonly open = new Set<string>();
  /** Keys the user picked in a Save dialog this session. Session only, never saved. */
  private readonly picked = new Set<string>();
  /** Keys this process read for the renderer and that are not yet reported open. An open is accepted only for these. */
  private readonly read = new Set<string>();
  /** Keys handed over through a user choice this session (see the header). Only these can be read for an open. Session only. */
  private readonly chosen = new Set<string>();

  constructor(private readonly limit = MAX_GRANTS) {}

  /** Grants a path the user chose. Returns false when the path is not one that can be granted. */
  grant(path: string): boolean {
    if (!isGrantablePath(path)) return false;
    const key = grantKey(path);
    // A path that is open keeps the spelling it was opened with: the document, its Save and its disk watch use it.
    const stored = this.open.has(key) ? (this.byKey.get(key) ?? win32.normalize(path)) : win32.normalize(path);
    this.byKey.delete(key);
    this.byKey.set(key, stored);
    while (this.byKey.size > this.limit) {
      // The oldest path that is not in use: an open document, a Save dialog pick and the grant just made keep their place.
      let evict: string | undefined;
      for (const candidate of this.byKey.keys()) {
        if (candidate !== key && !this.open.has(candidate) && !this.picked.has(candidate)) {
          evict = candidate;
          break;
        }
      }
      if (evict === undefined) break;
      this.byKey.delete(evict);
      this.chosen.delete(evict);
      this.read.delete(evict);
    }
    return true;
  }

  /**
   * Grants a path the user chose in this session (Open dialog, command line, second launch, drop): readable, and the page may
   * report a document open on it once it has been read. False for a bad path.
   */
  grantChosen(path: string): boolean {
    if (!this.grant(path)) return false;
    this.chosen.add(grantKey(path));
    return true;
  }

  /**
   * The main process itself opens a Recent or session-restore path for the user: a path already granted (read-only) may now be
   * read for an open and reported open. Returns false when the path is not granted. The caller must be a main-process
   * action, never a page request that names any path.
   */
  allowOpen(path: string): boolean {
    // Only an EXISTING grant is allowed, under the spelling it was granted with (findGranted gives it). A new spelling of the same
    // file is never granted here: a later save then writes to the directory entry the user chose, never to a hard link or to
    // another junction path of the file.
    if (this.canonical(path) === null) return false;
    this.chosen.add(grantKey(path));
    return true;
  }

  /**
   * The existing grant for the file the page names, or null: the path's own grant when its text matches one (no file-system call
   * at all), else ONE asynchronous resolution of the requested path (`resolve`: canonicalSpelling, which never blocks the main
   * thread) compared by text with the stored grants. Stored grants are never resolved again. A path that is only another spelling
   * of a granted file (a junction, the long-path prefix, a short name) finds that grant; a file that was never granted finds nothing.
   * It changes nothing.
   *
   * Only a path whose resolution cannot reach a host the user never named is resolved: a path with a drive letter, or a UNC path whose
   * \\server\share already appears in a grant. A page that names \\any-host\share\x would otherwise make this process open an SMB
   * connection to that host (sending the user's credentials) and tie up the thread pool on a host that never answers. Device paths
   * (the device prefix, and the extended-length prefix with anything but a drive letter) and every other form get null without a file-system call.
   */
  async findGranted(path: string, resolve: (path: string) => Promise<string>): Promise<string | null> {
    const direct = this.canonical(path);
    if (direct !== null) return direct;
    if (!isGrantablePath(path) || !this.mayResolve(path)) return null;
    let resolved: string;
    try {
      resolved = await resolve(path);
    } catch {
      return null;
    }
    return this.canonical(resolved);
  }

  /** Whether resolving this path stays on a drive or on a share the user already granted (see findGranted). */
  private mayResolve(path: string): boolean {
    // The long-path spelling of a drive path (extended-length prefix, then the drive letter) is that drive path and nothing else.
    if (/^(?:\\\\\?\\)?[A-Za-z]:[\\/]/.test(path)) return true;
    const root = uncRoot(path);
    if (root === null) return false;
    for (const granted of this.byKey.values()) if (uncRoot(granted) === root) return true;
    return false;
  }

  /** Grants a path the user picked in a Save dialog: readable and writable for this session. False for a bad path. */
  grantWrite(path: string): boolean {
    if (!this.grantChosen(path)) return false;
    this.picked.add(grantKey(path));
    return true;
  }

  /**
   * Records that this process read a granted path for the renderer. The renderer may then report a document open on it, but
   * only when the path was handed over through a user choice (grantChosen, grantWrite, allowOpen): a read of a restored or
   * Recent grant records nothing.
   */
  noteRead(path: string): void {
    if (this.canonical(path) === null) return;
    const key = grantKey(path);
    if (!this.chosen.has(key)) return;
    this.read.delete(key);
    this.read.add(key);
    while (this.read.size > this.limit) {
      const oldest = this.read.values().next().value;
      if (oldest === undefined) break;
      this.read.delete(oldest);
    }
  }

  /**
   * The renderer reports a document open on a path. Accepted (and the path becomes writable) only when the path is granted
   * and this process read it for that open, or it is already open, or the user picked it in a Save dialog (Save As
   * re-keys the open document to that path). Returns whether it was accepted.
   */
  markOpen(path: string): boolean {
    if (this.canonical(path) === null) return false;
    const key = grantKey(path);
    if (this.read.delete(key) || this.open.has(key) || this.picked.has(key)) {
      this.open.add(key);
      return true;
    }
    return false;
  }

  /** The renderer reports the document closed: the path loses its write right, whichever way it was earned. */
  markClosed(path: string): void {
    if (!isGrantablePath(path)) return;
    const key = grantKey(path);
    this.open.delete(key);
    this.picked.delete(key);
    this.read.delete(key);
    this.chosen.delete(key);
  }

  /** True when a document of this path is open in a tab now (the renderer reported it). */
  isOpen(path: string): boolean {
    return isGrantablePath(path) && this.open.has(grantKey(path));
  }

  /** The normalized form of a path that may be written now, or null (read-only, or not granted). */
  canonicalForWrite(path: string): string | null {
    const canonical = this.canonical(path);
    if (canonical === null) return null;
    const key = grantKey(path);
    return this.open.has(key) || this.picked.has(key) ? canonical : null;
  }

  /**
   * The normalized form of a granted path, to use for the file operation. Null when the path was not
   * granted. A path that only reaches a granted file through '..' or a different case is granted too.
   */
  canonical(path: string): string | null {
    if (!isGrantablePath(path)) return null;
    return this.byKey.get(grantKey(path)) ?? null;
  }

  /** Granted paths (for reading), oldest first. Saved between launches. Write grants are not saved. */
  list(): string[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }
}

/**
 * Restores the grants saved by an earlier run. They are read grants only: a path saved earlier can be reopened and read, but
 * not written until the user opens it again, or picks it in a Save dialog, in this session. Returns how many were restored.
 */
export function restorePersistedGrants(grants: PathGrants, saved: unknown): number {
  if (!Array.isArray(saved)) return 0;
  let restored = 0;
  for (const path of saved) if (typeof path === 'string' && grants.grant(path)) restored += 1;
  return restored;
}
