import { isOpenablePath } from '../../src/platform/desktop/contract';

/** How many recent files the app keeps. */
export const RECENT_LIMIT = 10;

/** Windows paths are case-insensitive, so two spellings of one file are one entry. */
const keyOf = (path: string) => path.toLowerCase();

/** Puts `path` first and drops any older entry for the same file. Keeps at most `limit` entries. */
export function addRecent(list: readonly string[], path: string, limit = RECENT_LIMIT): string[] {
  const key = keyOf(path);
  return [path, ...list.filter((p) => keyOf(p) !== key)].slice(0, limit);
}

/** Removes entries whose file no longer exists. Order is kept. `exists` is injected so this is testable. */
export async function pruneMissing(list: readonly string[], exists: (path: string) => Promise<boolean>): Promise<string[]> {
  const checks = await Promise.all(list.map((path) => exists(path)));
  return list.filter((_, index) => checks[index]);
}

/** Reads a stored list. Anything that is not a valid, unique PDF path is dropped. */
export function parseRecentList(value: unknown, limit = RECENT_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isOpenablePath(item)) continue;
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
