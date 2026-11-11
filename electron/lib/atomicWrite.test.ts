// @vitest-environment node
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangedOnDiskError, saveAtomic } from './atomicWrite';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pdfsuite-atomic-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe('saveAtomic', () => {
  it('saves a file whose name is 250 characters long (the temp name does not depend on the target name)', async () => {
    const target = join(dir, `${'n'.repeat(246)}.pdf`);
    expect(target.length - dir.length - 1).toBe(250);
    await saveAtomic(target, bytesOf('long name'));
    expect(await fs.readFile(target, 'utf8')).toBe('long name');
    expect((await fs.readdir(dir)).length).toBe(1);
  });

  it('the temp file has a short fixed name of the form .~pdfs-<8 hex>.tmp', async () => {
    const target = join(dir, 'out.pdf');
    let seen = '';
    await saveAtomic(target, bytesOf('x'), {
      rename: async (from, to) => {
        seen = from;
        await fs.rename(from, to);
      },
    });
    expect(seen.slice(dir.length + 1)).toMatch(/^\.~pdfs-[0-9a-f]{8}\.tmp$/);
  });

  it('tries the rename again when another program holds the target for a moment (EPERM, EBUSY, EACCES)', async () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const target = join(dir, `${code}.pdf`);
      await fs.writeFile(target, 'old');
      let calls = 0;
      await saveAtomic(target, bytesOf('new'), {
        retryDelayMs: 1,
        rename: async (from, to) => {
          calls += 1;
          if (calls < 5) throw Object.assign(new Error('locked'), { code });
          await fs.rename(from, to);
        },
      });
      expect(calls).toBe(5);
      expect(await fs.readFile(target, 'utf8')).toBe('new');
    }
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('gives up after 5 attempts, removes the temp file and leaves the original untouched', async () => {
    const target = join(dir, 'out.pdf');
    await fs.writeFile(target, 'old');
    let calls = 0;
    await expect(
      saveAtomic(target, bytesOf('new'), {
        retryDelayMs: 1,
        rename: async () => {
          calls += 1;
          throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        },
      }),
    ).rejects.toThrow('locked');
    expect(calls).toBe(5);
    expect(await fs.readdir(dir)).toEqual(['out.pdf']);
    expect(await fs.readFile(target, 'utf8')).toBe('old');
  });

  it('does not retry an error that is not a lock (ENOENT, ENOSPC)', async () => {
    const target = join(dir, 'out.pdf');
    let calls = 0;
    await expect(
      saveAtomic(target, bytesOf('new'), {
        retryDelayMs: 1,
        rename: async () => {
          calls += 1;
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        },
      }),
    ).rejects.toThrow('full');
    expect(calls).toBe(1);
  });

  it('writes a new file with the exact bytes', async () => {
    const target = join(dir, 'out.pdf');
    await saveAtomic(target, bytesOf('hello pdf'));
    expect(await fs.readFile(target, 'utf8')).toBe('hello pdf');
  });

  it('replaces an existing file in one step', async () => {
    const target = join(dir, 'out.pdf');
    await fs.writeFile(target, 'old contents that are longer than the new ones');
    await saveAtomic(target, bytesOf('new'));
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });

  it('leaves no temp file behind after a successful save', async () => {
    const target = join(dir, 'out.pdf');
    await saveAtomic(target, bytesOf('x'));
    expect(await fs.readdir(dir)).toEqual(['out.pdf']);
  });

  it('fails without creating the target when the folder does not exist', async () => {
    const target = join(dir, 'missing', 'out.pdf');
    await expect(saveAtomic(target, bytesOf('x'))).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('removes the temp file when the final rename fails', async () => {
    const target = join(dir, 'blocked.pdf');
    // A directory at the target path makes the final rename fail.
    await fs.mkdir(target);
    await expect(saveAtomic(target, bytesOf('new'))).rejects.toThrow();
    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('saveAtomic with an expected stamp (1.5.1 M8)', () => {
  const stampOf = async (path: string) => {
    const info = await fs.stat(path);
    return { size: info.size, modified: info.mtimeMs };
  };

  it('replaces the file when it is still the one the caller saw', async () => {
    const target = join(dir, 'out.pdf');
    await fs.writeFile(target, 'seen');
    await saveAtomic(target, bytesOf('new'), { expected: await stampOf(target) });
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });

  it('the target changes between the temp write and the rename: nothing is replaced and the temp file is gone', async () => {
    const target = join(dir, 'out.pdf');
    await fs.writeFile(target, 'seen');
    const expected = await stampOf(target);
    await expect(
      saveAtomic(target, bytesOf('mine'), {
        expected,
        // Another program writes the file in the gap.
        beforeCheck: async () => {
          await fs.writeFile(target, 'another program, longer');
        },
      }),
    ).rejects.toMatchObject({ name: 'ChangedOnDiskError' });
    expect(await fs.readFile(target, 'utf8')).toBe('another program, longer');
    expect(await fs.readdir(dir)).toEqual(['out.pdf']);
  });

  it('a change of modified time alone (same size) is also refused', async () => {
    const target = join(dir, 'out.pdf');
    await fs.writeFile(target, 'same size');
    const expected = await stampOf(target);
    const later = new Date(expected.modified + 5000);
    await expect(saveAtomic(target, bytesOf('mine'), { expected, beforeCheck: () => fs.utimes(target, later, later) })).rejects.toBeInstanceOf(ChangedOnDiskError);
    expect(await fs.readFile(target, 'utf8')).toBe('same size');
  });

  it('a target that was deleted is written again (a missing file is not a change to protect)', async () => {
    const target = join(dir, 'out.pdf');
    await saveAtomic(target, bytesOf('back'), { expected: { size: 4, modified: 1 } });
    expect(await fs.readFile(target, 'utf8')).toBe('back');
  });

  it('without an expected stamp it overwrites as before', async () => {
    const target = join(dir, 'out.pdf');
    await fs.writeFile(target, 'anything');
    await saveAtomic(target, bytesOf('new'), { beforeCheck: async () => void (await fs.writeFile(target, 'changed')) });
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });
});
