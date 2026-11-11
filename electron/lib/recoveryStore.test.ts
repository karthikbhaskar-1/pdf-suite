// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recoveryKeyOnlyArgs,
  recoveryStashArgs,
  recoveryStashNameArg,
  recoveryStashReadArgs,
  recoveryWriteArgs,
} from '../../src/platform/desktop/contract';
import { RecoveryStore, isTemporaryTestProfile } from './recoveryStore';

const KEY = 'b'.repeat(64);

let root: string;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdfsuite-recovery-'));
  root = join(dir, 'recovery');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('RecoveryStore', () => {
  it('writes, reads and lists a document log, and clears it with its stashes', async () => {
    const store = new RecoveryStore(root);
    expect(await store.read(KEY)).toBeNull();
    await store.write(KEY, '{"version":1}');
    expect(await store.read(KEY)).toBe('{"version":1}');
    expect(await store.list()).toEqual([KEY]);

    await store.writeStash(KEY, 'stash-1.pdf', new Uint8Array([1, 2, 3]));
    const back = await store.readStash(KEY, 'stash-1.pdf');
    expect(back && Array.from(new Uint8Array(back))).toEqual([1, 2, 3]);

    await store.clear(KEY);
    expect(await store.read(KEY)).toBeNull();
    expect(await store.readStash(KEY, 'stash-1.pdf')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('keeps every file inside its own folder, and leaves no temporary file behind', async () => {
    const store = new RecoveryStore(root);
    await store.write(KEY, 'x');
    await store.writeStash(KEY, 'stash-2.pdf', new Uint8Array([9]));
    const top = await readdir(root);
    expect(top.sort()).toEqual([`${KEY}`, `${KEY}.json`].sort());
    const inside = await readdir(join(root, KEY));
    expect(inside).toEqual(['stash-2.pdf']);
  });

  it('clearing a document that has no log is not an error', async () => {
    const store = new RecoveryStore(root);
    await expect(store.clear(KEY)).resolves.toBeUndefined();
  });
});

describe('recovery IPC arguments', () => {
  it('accepts a 64-hex document key and a stash name, and nothing else', () => {
    expect(recoveryKeyOnlyArgs([KEY])).toBe(KEY);
    expect(recoveryKeyOnlyArgs(['C:\\Docs\\example\\a.pdf'])).toBeNull();
    expect(recoveryKeyOnlyArgs(['../' + KEY])).toBeNull();
    expect(recoveryKeyOnlyArgs([KEY.toUpperCase()])).toBeNull();
    expect(recoveryKeyOnlyArgs([])).toBeNull();
    expect(recoveryStashNameArg('stash-12.pdf')).toBe('stash-12.pdf');
    expect(recoveryStashNameArg('../stash-1.pdf')).toBeNull();
    expect(recoveryStashNameArg('stash-1.exe')).toBeNull();
  });

  it('refuses a path where a key is expected, so the page cannot name a file outside the folder', () => {
    expect(recoveryWriteArgs(['C:\\Windows\\win.ini', 'x'])).toBeNull();
    expect(recoveryStashArgs([KEY, '..\\evil.pdf', new ArrayBuffer(1)])).toBeNull();
    expect(recoveryStashReadArgs([KEY, 'stash-1.pdf.exe'])).toBeNull();
  });

  it('accepts a well formed write and stash', () => {
    expect(recoveryWriteArgs([KEY, '{}'])).toEqual({ key: KEY, text: '{}' });
    expect(recoveryStashArgs([KEY, 'stash-1.pdf', new ArrayBuffer(4)])?.name).toBe('stash-1.pdf');
    expect(recoveryWriteArgs([KEY, 12])).toBeNull();
  });
});

describe('clearKeys (the close answer carries the keys, 1.5.1 M3)', () => {
  it('removes every listed log and its stashes, and one that cannot be removed does not stop the others', async () => {
    const store = new RecoveryStore(root);
    const other = 'c'.repeat(64);
    await store.write(KEY, '{}');
    await store.writeStash(KEY, 'stash-1.pdf', new Uint8Array([1]));
    await store.write(other, '{}');
    expect(await store.clearKeys([KEY, 'd'.repeat(64), other])).toBe(3);
    expect(await store.list()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });
});

describe('a write that fails leaves nothing half written (1.5.1 R3 on the main side)', () => {
  it('a recovery folder that cannot be created rejects the write, and the earlier log is not touched', async () => {
    const good = new RecoveryStore(root);
    await good.write(KEY, 'last good log');
    // A file where the folder should be: the next write cannot create its temp file there.
    const blocked = new RecoveryStore(join(root, `${KEY}.json`, 'inside'));
    await expect(blocked.write(KEY, 'new log')).rejects.toThrow();
    expect(await good.read(KEY)).toBe('last good log');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('test-mode close may delete logs only in a temporary test profile (1.5.1 M10, register M13)', () => {
  const temp = 'D:\\Example\\AppData\\Local\\Temp';
  it('accepts pdfsuite-e2e-* directly inside the temp folder, in any letter case or slash style', () => {
    expect(isTemporaryTestProfile(`${temp}\\pdfsuite-e2e-AbC123`, temp)).toBe(true);
    expect(isTemporaryTestProfile(`${temp.toLowerCase()}/pdfsuite-e2e-x`, temp)).toBe(true);
  });
  it('refuses the real profile, a profile elsewhere, a lookalike name, and a folder nested deeper', () => {
    expect(isTemporaryTestProfile('D:\\Example\\AppData\\Roaming\\PDF Suite', temp)).toBe(false);
    expect(isTemporaryTestProfile('D:\\work\\pdfsuite-e2e-x', temp)).toBe(false);
    expect(isTemporaryTestProfile(`${temp}\\my-pdfsuite-e2e-x`, temp)).toBe(false);
    expect(isTemporaryTestProfile(`${temp}\\other\\pdfsuite-e2e-x`, temp)).toBe(false);
    expect(isTemporaryTestProfile(`${temp}\\pdfsuite-e2e-x\\..\\..`, temp)).toBe(false);
  });
});

describe('the previous copy (a refused restore must not lose the old edits)', () => {
  const exists = (path: string) => stat(path).then(() => true, () => false);

  it('setAside moves the log and its stashes to previous/, and the list no longer shows the key', async () => {
    const store = new RecoveryStore(root);
    await store.write(KEY, 'old log');
    await store.writeStash(KEY, 'stash-1.pdf', new Uint8Array([1, 2]));
    await store.setAside(KEY);
    expect(await store.read(KEY)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await readFile(join(root, 'previous', `${KEY}.json`), 'utf8')).toBe('old log');
    expect(await exists(join(root, 'previous', KEY, 'stash-1.pdf'))).toBe(true);
    // A fresh log can now be written under the same key without touching it.
    await store.write(KEY, 'new log');
    expect(await readFile(join(root, 'previous', `${KEY}.json`), 'utf8')).toBe('old log');
  });

  it('only one previous copy is kept: a newer one replaces it, stashes included', async () => {
    const store = new RecoveryStore(root);
    await store.write(KEY, 'first');
    await store.writeStash(KEY, 'stash-1.pdf', new Uint8Array([1]));
    await store.setAside(KEY);
    await store.write(KEY, 'second');
    await store.setAside(KEY);
    expect(await readFile(join(root, 'previous', `${KEY}.json`), 'utf8')).toBe('second');
    expect(await exists(join(root, 'previous', KEY, 'stash-1.pdf'))).toBe(false);
  });

  it('clear() leaves the previous copy; only clearPrevious removes it', async () => {
    const store = new RecoveryStore(root);
    await store.write(KEY, 'old');
    await store.setAside(KEY);
    await store.write(KEY, 'current');
    await store.clear(KEY);
    expect(await exists(join(root, 'previous', `${KEY}.json`))).toBe(true);
    await store.clearPrevious(KEY);
    expect(await exists(join(root, 'previous', `${KEY}.json`))).toBe(false);
  });

  it('setAside with nothing to move, and clearPrevious with no previous copy, are not errors', async () => {
    const store = new RecoveryStore(root);
    await expect(store.setAside(KEY)).resolves.toBeUndefined();
    await expect(store.clearPrevious(KEY)).resolves.toBeUndefined();
  });
});
