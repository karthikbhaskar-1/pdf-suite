// @vitest-environment node
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRecent, parseRecentList, pruneMissing, RECENT_LIMIT } from './recentFiles';
import { RecentStore } from './recentStore';

const A = 'C:\\docs\\a.pdf';
const B = 'C:\\docs\\b.pdf';
const C = 'C:\\docs\\c.pdf';

describe('addRecent', () => {
  it('puts the newest file first', () => {
    expect(addRecent([A, B], C)).toEqual([C, A, B]);
  });

  it('moves a file that is already listed to the top instead of repeating it', () => {
    expect(addRecent([A, B, C], B)).toEqual([B, A, C]);
  });

  it('treats different letter case as the same Windows file', () => {
    expect(addRecent([A], 'c:\\docs\\A.PDF')).toEqual(['c:\\docs\\A.PDF']);
  });

  it('keeps at most the limit, dropping the oldest', () => {
    const full = Array.from({ length: RECENT_LIMIT }, (_, i) => `C:\\d\\f${i}.pdf`);
    const next = addRecent(full, 'C:\\d\\new.pdf');
    expect(next).toHaveLength(RECENT_LIMIT);
    expect(next[0]).toBe('C:\\d\\new.pdf');
    expect(next).not.toContain(`C:\\d\\f${RECENT_LIMIT - 1}.pdf`);
  });

  it('caps at 10 entries by default', () => {
    expect(RECENT_LIMIT).toBe(10);
  });
});

describe('pruneMissing', () => {
  it('removes paths whose file no longer exists and keeps the order of the rest', async () => {
    const present = new Set([A, C]);
    const pruned = await pruneMissing([A, B, C], async (p) => present.has(p));
    expect(pruned).toEqual([A, C]);
  });

  it('returns the same list when every file exists', async () => {
    expect(await pruneMissing([A, B], async () => true)).toEqual([A, B]);
  });

  it('returns an empty list when every file is gone', async () => {
    expect(await pruneMissing([A, B], async () => false)).toEqual([]);
  });
});

describe('parseRecentList', () => {
  it('keeps only valid, unique absolute file paths', () => {
    const parsed = parseRecentList([A, 'relative.pdf', 'C:\\x\\notes.txt', 42, A, B, null]);
    expect(parsed).toEqual([A, 'C:\\x\\notes.txt', B]);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(parseRecentList({ files: [A] })).toEqual([]);
    expect(parseRecentList(null)).toEqual([]);
  });

  it('applies the limit', () => {
    const many = Array.from({ length: 15 }, (_, i) => `C:\\d\\f${i}.pdf`);
    expect(parseRecentList(many)).toHaveLength(RECENT_LIMIT);
  });
});

describe('RecentStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pdfsuite-recent-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stores a file and lists it back', async () => {
    const real = join(dir, 'one.pdf');
    await fs.writeFile(real, 'x');
    const store = new RecentStore(join(dir, 'recent.json'));
    await store.add(real);
    expect(await store.list()).toEqual([real]);
  });

  it('prunes a file that was deleted and saves the pruned list', async () => {
    const keep = join(dir, 'keep.pdf');
    const gone = join(dir, 'gone.pdf');
    await fs.writeFile(keep, 'x');
    await fs.writeFile(gone, 'x');
    const storeFile = join(dir, 'recent.json');
    const store = new RecentStore(storeFile);
    await store.add(keep);
    await store.add(gone);
    await fs.rm(gone);

    expect(await store.list()).toEqual([keep]);
    expect(JSON.parse(await fs.readFile(storeFile, 'utf8'))).toEqual([keep]);
  });

  it('starts empty when the stored file is corrupt', async () => {
    const storeFile = join(dir, 'recent.json');
    await fs.writeFile(storeFile, '{not json');
    expect(await new RecentStore(storeFile).list()).toEqual([]);
  });
});
