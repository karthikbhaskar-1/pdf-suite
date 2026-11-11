import * as nodeFs from 'node:fs';
import { basename, dirname, win32 } from 'node:path';
import { stripLongPathPrefix } from './sameFile';

/**
 * The one spelling the main process hands the page for a path the user chose (Open dialog, drop, command line, Save dialog, a
 * file a job made). A folder junction, a link, the long-path prefix (backslash, backslash, question mark, backslash), an 8.3 short
 * name and a different letter case all reach one file; the page's registry, its recovery key and the Recent list work on path
 * text, so they see one document and one key per file only when every spelling of it arrives as one text. The resolution is the
 * file system's real path.
 *
 * ASYNCHRONOUS ON PURPOSE. A real-path lookup on a network share that sleeps or is offline can take tens of seconds. Run on the
 * main thread it would freeze the whole app (every window, the close prompt, the other tabs), so it runs on the libuv thread pool
 * and the main thread only waits for its answer. It also has a time limit: a path that cannot be resolved in time keeps the
 * spelling the user chose, so one dead share cannot hold up an open for ever.
 *
 * The user's own names are kept where the file system gives the same file on the same volume: only what resolves differently
 * changes (a junction becomes its target folder, a short name its long name, the letter case the one on disk). A path that
 * resolves to ANOTHER volume (a mapped network drive, a SUBST drive) is left as the user chose it. A file that does not exist yet
 * (a Save As target) resolves through its folder.
 */
export interface AsyncRealpath {
  realpath(path: string): Promise<string>;
}

export const realAsyncRealpath: AsyncRealpath = {
  realpath: (path) =>
    new Promise((resolve, reject) => {
      nodeFs.realpath.native(path, (error, resolved) => (error ? reject(error) : resolve(resolved)));
    }),
};

/** How long a resolution may take before the path keeps the spelling the user chose. */
export const RESOLVE_TIMEOUT_MS = 5000;

async function resolveOnce(plain: string, fs: AsyncRealpath): Promise<string> {
  let resolved: string;
  try {
    resolved = stripLongPathPrefix(await fs.realpath(plain));
  } catch {
    try {
      resolved = win32.join(stripLongPathPrefix(await fs.realpath(dirname(plain))), basename(plain));
    } catch {
      return plain;
    }
  }
  const root = (p: string) => win32.parse(p).root.toLowerCase();
  return root(resolved) === root(plain) ? resolved : plain;
}

export async function canonicalSpelling(path: string, fs: AsyncRealpath = realAsyncRealpath, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<string> {
  const plain = win32.normalize(stripLongPathPrefix(path));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(plain), timeoutMs);
  });
  try {
    return await Promise.race([resolveOnce(plain, fs), giveUp]);
  } finally {
    clearTimeout(timer);
  }
}
