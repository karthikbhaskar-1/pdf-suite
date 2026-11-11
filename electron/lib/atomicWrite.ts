import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** The size and modified time (ms since the epoch, as fs.stat's mtimeMs) a file is expected to still have. */
export interface ExpectedStamp {
  size: number;
  modified: number;
}

/** Thrown, with nothing replaced, when the target is not the file the caller last saw. */
export class ChangedOnDiskError extends Error {
  constructor() {
    super('The file on disk changed since it was last seen.');
    this.name = 'ChangedOnDiskError';
  }
}

export interface SaveAtomicOptions {
  /**
   * The stamp the caller last saw. The target is checked against it just before the rename, and nothing is replaced when it
   * differs. A target that does not exist is fine (a deleted file is written again). A gap of microseconds between that
   * check and the rename remains: Windows has no rename that also compares the old file.
   */
  expected?: ExpectedStamp;
  /** TESTS ONLY: runs after the temp file is written and before the check, so a test can change the target in that gap. */
  beforeCheck?: () => Promise<void>;
  /** TESTS ONLY: replaces the rename, so a test can make it fail the way a scanner or indexer holding the file does. */
  rename?: (from: string, to: string) => Promise<void>;
  /** TESTS ONLY: the pause between rename attempts (default RENAME_RETRY_DELAY_MS). */
  retryDelayMs?: number;
}

/** A rename that fails because another program holds the target for a moment (a virus scanner, the indexer, a backup) is tried again. */
export const RENAME_ATTEMPTS = 5;
export const RENAME_RETRY_DELAY_MS = 100;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void>,
  delayMs: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Writes `bytes` to `target` without ever leaving a half-written file. The bytes go to a temp file
 * in the same folder (so the rename stays on one volume), are flushed to disk, then renamed over
 * the target. On failure the temp file is removed and the original file is untouched. With `options.expected` the target
 * is checked once more just before the rename (ChangedOnDiskError when it differs; the temp file is removed).
 */
export async function saveAtomic(target: string, bytes: Uint8Array, options: SaveAtomicOptions = {}): Promise<void> {
  const dir = path.dirname(target);
  // A short fixed name: the temp file must be creatable wherever the target is, and a target name near the 255-character limit
  // plus a prefix and a UUID would not be.
  const temp = path.join(dir, `.~pdfs-${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await options.beforeCheck?.();
    if (options.expected) {
      const now = await fs.stat(target).catch(() => null);
      if (now && (now.size !== options.expected.size || now.mtimeMs !== options.expected.modified)) throw new ChangedOnDiskError();
    }
    // On Windows, rename replaces an existing file (MoveFileEx with MOVEFILE_REPLACE_EXISTING).
    await renameWithRetry(temp, target, options.rename ?? fs.rename, options.retryDelayMs ?? RENAME_RETRY_DELAY_MS);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
