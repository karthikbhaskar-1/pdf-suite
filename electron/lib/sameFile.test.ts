import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripLongPathPrefix } from './sameFile';
import { JobOutputs } from './jobOutputs';

// Real files in a real temp folder: a junction, the long-path spelling and other letter case reach the same file, and only a real
// file-system check can tell. (Windows only: the app is.) The file identity itself is canonicalSpelling's job (its own test).
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pdfsuite-samefile-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const real = join(root, 'Real Folder With A Long Name');
mkdirSync(real);
const a = join(real, 'a.pdf');
const b = join(real, 'b.pdf');
writeFileSync(a, 'A');
writeFileSync(b, 'B');
const alias = join(root, 'alias');
let junction = false;
try {
  symlinkSync(real, alias, 'junction');
  junction = true;
} catch {
  junction = false;
}

describe('stripLongPathPrefix', () => {
  it('removes the long-path and UNC long-path prefixes and leaves other paths alone', () => {
    expect(stripLongPathPrefix('\\\\?\\C:\\x\\a.pdf')).toBe('C:\\x\\a.pdf');
    expect(stripLongPathPrefix('\\\\?\\UNC\\server\\share\\a.pdf')).toBe('\\\\server\\share\\a.pdf');
    expect(stripLongPathPrefix('C:\\x\\a.pdf')).toBe('C:\\x\\a.pdf');
    expect(stripLongPathPrefix('\\\\server\\share\\a.pdf')).toBe('\\\\server\\share\\a.pdf');
  });
});

describe('JobOutputs.begin refuses an output that is an input or an open file by another path', () => {
  const makeOutputs = (openPaths: string[]) =>
    new JobOutputs({
      journalFile: join(root, 'journal.json'),
      canonicalForWrite: (p) => p,
      isOpenDocument: () => false,
      openPaths: () => openPaths,
    });

  it.skipIf(!junction)('through a folder junction (the auditor\'s case): the output is one of the inputs', async () => {
    const outputs = makeOutputs([]);
    expect(await outputs.begin({ pickedPath: join(alias, 'a.pdf') }, [a, b])).toEqual({ ok: false, reason: 'target-is-input' });
  });

  it.skipIf(!junction)('through a folder junction: the output is a file open in a tab', async () => {
    const outputs = makeOutputs([b]);
    expect(await outputs.begin({ pickedPath: join(alias, 'b.pdf') }, [a])).toEqual({ ok: false, reason: 'target-open' });
  });

  it('the long-path spelling and a different case: refused too', async () => {
    const outputs = makeOutputs([b]);
    expect(await outputs.begin({ pickedPath: `\\\\?\\${a}` }, [a, b])).toEqual({ ok: false, reason: 'target-is-input' });
    expect(await outputs.begin({ pickedPath: a.toUpperCase() }, [a, b])).toEqual({ ok: false, reason: 'target-is-input' });
    expect(await outputs.begin({ pickedPath: `\\\\?\\${b}` }, [a])).toEqual({ ok: false, reason: 'target-open' });
  });

  it('a different file is accepted', async () => {
    const outputs = makeOutputs([b]);
    const begun = await outputs.begin({ pickedPath: join(real, 'result.pdf') }, [a]);
    expect(begun.ok).toBe(true);
    await outputs.abortAll();
  });
});

describe('JobOutputs.begin never blocks the main thread on a slow file system (1.5.1 review)', () => {
  const slowOutputs = (ms: number, resolved: (p: string) => string) =>
    new JobOutputs({
      journalFile: join(root, 'journal-slow.json'),
      canonicalForWrite: (p) => p,
      isOpenDocument: () => false,
      openPaths: () => [],
      resolve: (p) => new Promise((done) => setTimeout(() => done(resolved(p)), ms)),
    });

  it('while the target is resolved on a slow share the event loop keeps ticking, and the refusal still comes', async () => {
    const outputs = slowOutputs(300, () => a);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    const answer = await outputs.begin({ pickedPath: 'C:\\nas\\alias\\x.pdf' }, [a]);
    clearInterval(timer);
    expect(answer).toEqual({ ok: false, reason: 'target-is-input' });
    expect(ticks).toBeGreaterThan(10);
  });

  it('a target that matches an input or an open document by text is refused without any resolution', async () => {
    const resolve = vi.fn(async (p: string) => p);
    const outputs = new JobOutputs({ journalFile: join(root, 'journal-text.json'), canonicalForWrite: (p) => p, openPaths: () => [b], resolve });
    expect(await outputs.begin({ pickedPath: a.toUpperCase() }, [a])).toEqual({ ok: false, reason: 'target-is-input' });
    expect(await outputs.begin({ pickedPath: b }, [a])).toEqual({ ok: false, reason: 'target-open' });
    expect(resolve).not.toHaveBeenCalled();
  });
});
