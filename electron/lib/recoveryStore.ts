import * as fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { saveAtomic } from './atomicWrite';

/** The name every test profile folder starts with (tests/e2e/helpers.mjs makes them with mkdtemp in the system temp folder). */
export const TEST_PROFILE_PREFIX = 'pdfsuite-e2e-';

/**
 * True when `userData` is a temporary test profile: a folder named pdfsuite-e2e-* directly inside the system temp folder.
 * Test-mode close deletes EVERY recovery log in the profile it runs in, so it must do so only there. A probe that sets
 * PDFSUITE_E2E=1 without its own --user-data-dir would otherwise wipe the owner's real recovery copies (register M13).
 */
export function isTemporaryTestProfile(userData: string, tempDir: string): boolean {
  const folder = resolve(userData);
  const sameFolder = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  return basename(folder).startsWith(TEST_PROFILE_PREFIX) && sameFolder(dirname(folder), tempDir);
}

/**
 * The recovery folder for unsaved page edits. Every path is built here, in the main process, from a key and a stash
 * name the contract validates (see recoveryKeyArg and recoveryStashNameArg in src/platform/desktop/contract.ts). The
 * page never sends a path, so the path grants do not apply here.
 *
 * Layout: <root>/<key>.json is a document's edit log. <root>/<key>/stash-<n>.pdf holds the source PDFs an edit used.
 */
export class RecoveryStore {
  constructor(private readonly root: string) {}

  private logPath(key: string): string {
    return join(this.root, `${key}.json`);
  }

  private stashDir(key: string): string {
    return join(this.root, key);
  }

  /** Writes a document's log, atomically. */
  async write(key: string, text: string): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await saveAtomic(this.logPath(key), new TextEncoder().encode(text));
  }

  /** The log text of a document, or null when there is none. */
  async read(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.logPath(key), 'utf8');
    } catch {
      return null;
    }
  }

  /** Writes one source file of a document's log, atomically. */
  async writeStash(key: string, name: string, bytes: Uint8Array): Promise<void> {
    await fs.mkdir(this.stashDir(key), { recursive: true });
    await saveAtomic(join(this.stashDir(key), name), bytes);
  }

  /** One source file of a document's log, or null when it is missing. */
  async readStash(key: string, name: string): Promise<ArrayBuffer | null> {
    try {
      const data = await fs.readFile(join(this.stashDir(key), name));
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } catch {
      return null;
    }
  }

  /** The keys of the documents that have a log. */
  async list(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.root);
      return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  /** Removes the logs of several documents. One that cannot be removed does not stop the others; resolves with how many were removed. */
  async clearKeys(keys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      try {
        await this.clear(key);
        removed += 1;
      } catch {
        // The others are still removed.
      }
    }
    return removed;
  }

  /**
   * Moves a document's current log and its stashes aside as its one "previous" copy (<root>/previous/), replacing any
   * previous copy already there. Used when a restore was refused and a new edit is about to start a fresh log under the same
   * key: the old edits must not be overwritten. Nothing to move is not an error. clear() does NOT touch the previous copy: it
   * is removed only by clearPrevious (the document was saved, or the user chose Discard).
   */
  async setAside(key: string): Promise<void> {
    const logExists = await fs.stat(this.logPath(key)).then(() => true, () => false);
    const stashesExist = await fs.stat(this.stashDir(key)).then(() => true, () => false);
    if (!logExists && !stashesExist) return;
    await fs.mkdir(this.previousRoot, { recursive: true });
    await this.clearPrevious(key);
    if (logExists) await fs.rename(this.logPath(key), join(this.previousRoot, `${key}.json`));
    if (stashesExist) await fs.rename(this.stashDir(key), join(this.previousRoot, key));
  }

  /** Removes a document's previous copy (log and stashes). Missing files are not an error. */
  async clearPrevious(key: string): Promise<void> {
    await fs.rm(join(this.previousRoot, `${key}.json`), { force: true });
    await fs.rm(join(this.previousRoot, key), { recursive: true, force: true });
  }

  private get previousRoot(): string {
    return join(this.root, 'previous');
  }

  /** Removes a document's log and its source files. Missing files are not an error. */
  async clear(key: string): Promise<void> {
    await fs.rm(this.logPath(key), { force: true });
    await fs.rm(this.stashDir(key), { recursive: true, force: true });
  }
}
