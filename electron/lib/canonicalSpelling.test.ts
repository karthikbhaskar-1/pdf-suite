// Windows only (the app is): a real folder junction and the long-path spelling in a real temp folder.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentRegistry } from '../../src/engine/documentRegistry';
import type { DocumentSource, EngineDocument, PdfEngine } from '../../src/engine/types';
import { canonicalRecoveryKey } from '../../src/features/recovery/recoveryKey';
import { canonicalSpelling, type AsyncRealpath } from './canonicalSpelling';

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pdfsuite-canon-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const real = join(root, 'Real Folder');
mkdirSync(real);
const a = join(real, 'a.pdf');
writeFileSync(a, 'A');
const alias = join(root, 'alias');
let junction = false;
try {
  symlinkSync(real, alias, 'junction');
  junction = true;
} catch {
  junction = false;
}
const viaJunction = join(alias, 'a.pdf');

describe('canonicalSpelling (1.5.1: one spelling per file from the main process)', () => {
  it.skipIf(!junction)('a junction, the long-path spelling, another letter case and a dot part all come out as the real path', async () => {
    for (const spelling of [viaJunction, `\\\\?\\${a}`, a.toUpperCase(), a.toLowerCase(), join(real, '.', 'a.pdf'), join(alias, '..', 'alias', 'a.pdf')]) {
      expect(await canonicalSpelling(spelling), spelling).toBe(a);
    }
  });

  it('the path the user chose is kept when the file system gives the same file on the same volume', async () => {
    expect(await canonicalSpelling(a)).toBe(a);
  });

  it.skipIf(!junction)('a Save As target that does not exist yet resolves through its folder', async () => {
    expect(await canonicalSpelling(join(alias, 'new file.pdf'))).toBe(join(real, 'new file.pdf'));
  });

  it('a path whose folder does not exist is left as given (normalised)', async () => {
    expect(await canonicalSpelling(`\\\\?\\${join(root, 'nowhere', 'x.pdf')}`)).toBe(join(root, 'nowhere', 'x.pdf'));
  });

  it('a path that resolves to another volume (a mapped or SUBST drive) keeps the spelling the user chose', async () => {
    const other: AsyncRealpath = { realpath: async () => '\\\\server\\share\\docs\\a.pdf' };
    expect(await canonicalSpelling('Z:\\docs\\a.pdf', other)).toBe('Z:\\docs\\a.pdf');
    const sameVolume: AsyncRealpath = { realpath: async () => 'C:\\Real\\Docs\\A.pdf' };
    expect(await canonicalSpelling('c:\\alias\\a.pdf', sameVolume)).toBe('C:\\Real\\Docs\\A.pdf');
  });
});

describe('canonicalSpelling never blocks the main thread, and gives up on a dead share', () => {
  it('while a slow file system answers, the event loop keeps ticking', async () => {
    const slow: AsyncRealpath = { realpath: (path) => new Promise((resolve) => setTimeout(() => resolve(path), 300)) };
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    const started = Date.now();
    const result = await canonicalSpelling('C:\\nas\\a.pdf', slow);
    clearInterval(timer);
    expect(result).toBe('C:\\nas\\a.pdf');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(ticks).toBeGreaterThan(10);
  });

  it('a path that cannot be resolved within the time limit keeps the spelling the user chose', async () => {
    const dead: AsyncRealpath = { realpath: () => new Promise(() => undefined) };
    const started = Date.now();
    expect(await canonicalSpelling('\\\\?\\C:\\nas\\Dead.pdf', dead, 60)).toBe('C:\\nas\\Dead.pdf');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('the same file via a junction and via its real path is one document and one recovery key', () => {
  const engine = (): { engine: PdfEngine; opens: () => number } => {
    let opens = 0;
    const open = vi.fn(async (): Promise<EngineDocument> => {
      opens += 1;
      return { pageCount: 1, destroy: async () => undefined } as unknown as EngineDocument;
    });
    return { engine: { open } as unknown as PdfEngine, opens: () => opens };
  };
  const source = (path: string): DocumentSource => ({ kind: 'path', name: 'a.pdf', path });

  it.skipIf(!junction)('what main hands the page for both spellings opens one document with one recovery key', async () => {
    const { engine: fake, opens } = engine();
    const registry = new DocumentRegistry(fake);
    const first = await registry.acquire(source(await canonicalSpelling(a)));
    const second = await registry.acquire(source(await canonicalSpelling(viaJunction)));
    expect(second).toBe(first);
    expect(opens()).toBe(1);
    expect(await canonicalRecoveryKey(await canonicalSpelling(viaJunction))).toBe(await canonicalRecoveryKey(await canonicalSpelling(a)));
    // Without the main process's resolution the page, which works on text, would have made two documents and two keys.
    const raw = new DocumentRegistry(engine().engine);
    const x = await raw.acquire(source(a));
    const y = await raw.acquire(source(viaJunction));
    expect(y).not.toBe(x);
    expect(await canonicalRecoveryKey(viaJunction)).not.toBe(await canonicalRecoveryKey(a));
  });
});
