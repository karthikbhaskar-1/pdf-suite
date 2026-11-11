// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { decideSave, encryptionKept, saveOptions, type SaveFacts } from './saveCore';
import { WorkerFault } from './protocol';

const BIG = new URL('../../../tests/fixtures/out/big-1000.pdf', import.meta.url);
const LOCKED = new URL('../../../tests/fixtures/out/locked.pdf', import.meta.url);
const LOCK_PASSWORD = 'test123';

const clean: SaveFacts = {
  samePath: true,
  canBeSavedIncrementally: true,
  wasRepaired: false,
  diskUnchanged: true,
  removesPages: false,
};

/** A MupdfCore over the real MuPDF module, with the bytes of a file opened in it. */
function openCore(path: URL | Uint8Array, password?: string): { core: MupdfCore; bytes: Uint8Array } {
  const bytes = path instanceof Uint8Array ? path : new Uint8Array(readFileSync(path));
  const core = new MupdfCore(mu as never, {});
  core.open(bytes, password);
  return { core, bytes };
}

describe('decideSave', () => {
  it('saves incrementally only when every condition holds', async () => {
    expect(decideSave(clean)).toEqual({ mode: 'incremental', reason: null });
  });

  it.each<[string, Partial<SaveFacts>, string]>([
    ['a different path', { samePath: false }, 'different path'],
    ['MuPDF cannot save incrementally', { canBeSavedIncrementally: false }, 'MuPDF cannot save incrementally'],
    ['the file was repaired', { wasRepaired: true }, 'file was repaired'],
    ['the file changed on disk', { diskUnchanged: false }, 'file changed on disk'],
    ['pages were deleted', { removesPages: true }, 'pages were deleted or replaced'],
  ])('saves in full when %s', (_label, change, reason) => {
    expect(decideSave({ ...clean, ...change })).toEqual({ mode: 'full', reason });
  });
});

describe('saveOptions', () => {
  it('compacts a full save, and keeps encryption only for an encrypted file', async () => {
    expect(saveOptions('full', false)).toBe('garbage=compact');
    expect(saveOptions('full', true)).toBe('garbage=compact,encrypt=keep');
    expect(saveOptions('incremental', true)).toBe('incremental');
  });
});

describe('MupdfCore.save', () => {
  it('writes an incremental save as the original bytes followed by the changes', async () => {
    const { core, bytes } = openCore(BIG);
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    const saved = core.save(true, true);
    expect(saved.mode).toBe('incremental');
    const out = new Uint8Array(saved.bytes);
    expect(out.length).toBeGreaterThan(bytes.length);
    expect(out.slice(0, bytes.length).every((b, i) => b === bytes[i])).toBe(true);
  });

  it('writes a full save, compacted, after pages are deleted', async () => {
    const { core, bytes } = openCore(BIG);
    await core.applyEdits([{ op: 'delete', uids: ['0', '1', '2'] }]);
    const saved = core.save(true, true);
    expect(saved.mode).toBe('full');
    const reopened = mu.Document.openDocument(new Uint8Array(saved.bytes), 'application/pdf');
    expect(reopened.countPages()).toBe(997);
    expect(saved.bytes.byteLength).toBeLessThan(bytes.length);
  });

  it('writes a full save when the target is another path', async () => {
    const { core } = openCore(BIG);
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    expect(core.save(false, true).mode).toBe('full');
  });

  it('keeps an encrypted file encrypted, whichever way it is saved', async () => {
    const { core } = openCore(LOCKED, LOCK_PASSWORD);
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    for (const samePath of [true, false]) {
      const saved = core.save(samePath, true);
      expect(encryptionKept(mu, new Uint8Array(saved.bytes))).toBe(true);
    }
  });

  it('keeps the rotation of an encrypted save when it is reopened with the password', async () => {
    const { core } = openCore(LOCKED, LOCK_PASSWORD);
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    const saved = core.save(false, true);
    const reopened = new MupdfCore(mu as never, {});
    reopened.open(new Uint8Array(saved.bytes), LOCK_PASSWORD);
    expect(reopened.pageCount).toBe(1);
    expect(reopened.sizes(0, 1)[2]).toBe(90);
  });

  it('writes a repaired file in full, even when the edit is only a rotation', async () => {
    const { core } = openCore(broken(BIG));
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    const saved = core.save(true, true);
    expect(saved.mode).toBe('full');
  });

  it('refuses to save when no document is open', async () => {
    const core = new MupdfCore(mu as never, {});
    expect(() => core.save(true, true)).toThrow(WorkerFault);
  });
});

/**
 * The bytes of a file with its last startxref keyword misspelled. MuPDF repairs the xref when it opens the file, so the
 * document is marked as repaired, and it is otherwise an ordinary editable document.
 */
function broken(path: URL): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  const word = new TextEncoder().encode('startxref');
  for (let at = bytes.length - word.length; at >= 0; at--) {
    if (word.every((b, i) => bytes[at + i] === b)) {
      bytes[at + word.length - 1] = 'X'.charCodeAt(0);
      break;
    }
  }
  return bytes;
}
