import * as fs from 'node:fs/promises';
import { addRecent, parseRecentList, pruneMissing, RECENT_LIMIT } from './recentFiles';
import { saveAtomic } from './atomicWrite';

/** Whether a path exists as a file. Missing or unreadable paths count as absent. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The recent-files list, stored as JSON in the app's data folder. Missing files are pruned each
 * time the list is read, and the pruned list is saved back.
 */
export class RecentStore {
  constructor(
    private readonly file: string,
    private readonly exists: (path: string) => Promise<boolean> = fileExists,
    private readonly limit = RECENT_LIMIT,
  ) {}

  private async load(): Promise<string[]> {
    try {
      return parseRecentList(JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown, this.limit);
    } catch {
      return [];
    }
  }

  private async save(list: readonly string[]): Promise<void> {
    await saveAtomic(this.file, new TextEncoder().encode(JSON.stringify(list)));
  }

  /** Recent paths, newest first, with missing files removed. */
  async list(): Promise<string[]> {
    const stored = await this.load();
    const live = await pruneMissing(stored, this.exists);
    if (live.length !== stored.length) await this.save(live);
    return live;
  }

  /** Empties the list. */
  async clear(): Promise<void> {
    await this.save([]);
  }

  /** Records a file as just used. Returns the updated list. */
  async add(path: string): Promise<string[]> {
    const next = addRecent(await this.load(), path, this.limit);
    await this.save(next);
    return next;
  }
}
