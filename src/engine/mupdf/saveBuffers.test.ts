// @vitest-environment node
// Review 1.5.8, items 1 and 2: a save copies the bytes out of the WASM heap before anything else can grow it, marks the
// save only after the bytes exist, and gives the MuPDF buffer back.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { encryptionKept } from './saveCore';
import { WorkerFault } from './protocol';

const BIG = new URL('../../../tests/fixtures/out/big-1000.pdf', import.meta.url);
const LOCKED = new URL('../../../tests/fixtures/out/locked.pdf', import.meta.url);
const LOCK_PASSWORD = 'test123';

/** The size of the WASM heap, read through a tiny buffer's view of it (the view's ArrayBuffer is the heap). */
function heapBytes(): number {
  const probe = new mu.Buffer();
  try {
    probe.writeByte(1);
    return probe.asUint8Array().buffer.byteLength;
  } finally {
    probe.destroy();
  }
}

/** Makes the WASM heap grow, as reopening a large file does. Returns true when it did. */
function growHeap(): boolean {
  const before = heapBytes();
  const filler = new mu.Buffer();
  try {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < 40 && heapBytes() === before; i++) filler.writeBuffer(chunk);
  } finally {
    filler.destroy();
  }
  return heapBytes() > before;
}

/** A module whose Document.openDocument first grows the heap (when `grow.on`), so a view taken earlier is detached by the check. */
function growingModule(grow: { on: boolean; grew: boolean; lie?: boolean }): typeof mu {
  const real = mu.Document;
  const Document = Object.create(real) as typeof mu.Document;
  Document.openDocument = ((...args: Parameters<typeof real.openDocument>) => {
    if (grow.lie) return { needsPassword: () => false, getMetaData: () => 'None', destroy: () => undefined } as never;
    if (grow.on && growHeap()) grow.grew = true;
    return real.openDocument(...args);
  }) as typeof real.openDocument;
  return { ...mu, Document } as typeof mu;
}

function openCore(path: URL, password: string | undefined, module: typeof mu = mu): MupdfCore {
  const core = new MupdfCore(module as never, {});
  core.open(new Uint8Array(readFileSync(path)), password);
  return core;
}

describe('an encrypted save while the heap grows', () => {
  it('copies the bytes before the encryption check, so growth cannot detach them', async () => {
    const grow = { on: false, grew: false };
    const core = openCore(LOCKED, LOCK_PASSWORD, growingModule(grow));
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    grow.on = true;
    const saved = core.save(false, true);
    expect(grow.grew).toBe(true);
    expect(saved.bytes.byteLength).toBeGreaterThan(100);
    expect(encryptionKept(mu, new Uint8Array(saved.bytes))).toBe(true);
    const reopened = new MupdfCore(mu as never, {});
    reopened.open(new Uint8Array(saved.bytes), LOCK_PASSWORD);
    expect(reopened.sizes(0, 1)[2]).toBe(90);
  });
});

describe('what a save spends', () => {
  it('MuPDF itself cannot undo past a save, whatever becomes of the bytes', () => {
    const doc = mu.Document.openDocument(readFileSync(BIG), 'application/pdf').asPDF()!;
    doc.enableJournal();
    doc.beginOperation('rotate');
    doc.findPage(0).put('Rotate', 90);
    doc.endOperation();
    doc.saveToBuffer('garbage=compact').destroy();
    doc.undo();
    expect(doc.findPage(0).getInheritable('Rotate').asNumber()).toBe(90);
  });

  it('a save refused after its bytes were made leaves the document dirty and says that Undo is spent', async () => {
    // A module whose reopen says "not encrypted", as a save that lost its encryption would.
    const grow = { on: false, grew: false, lie: false };
    const lost = openCore(LOCKED, LOCK_PASSWORD, growingModule(grow));
    grow.lie = true;
    await lost.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    expect(lost.editState!.history.canUndo).toBe(true);
    expect(() => lost.save(true, true)).toThrow(WorkerFault);
    const history = lost.editState!.history;
    expect(history.dirty).toBe(true);
    expect(history.canUndo).toBe(false);
    expect(history.undoBlockedReason).not.toBeNull();
    expect(() => lost.undo()).toThrow(WorkerFault);
  });

  it('a good save spends the steps too', async () => {
    const core = openCore(BIG, undefined);
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    core.save(true, true);
    expect(core.editState!.history.canUndo).toBe(false);
    expect(core.editState!.history.dirty).toBe(true);
  });
});

/** A one-page file that carries `mb` megabytes of data that does not compress, so each save is about that big. */
function heavyFile(mb: number): Uint8Array {
  const doc = new mu.PDFDocument();
  const page = doc.addPage([0, 0, 200, 200], 0, doc.newDictionary(), '');
  doc.insertPage(-1, page);
  const data = new Uint8Array(mb * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
  const stream = doc.addRawStream(data, doc.newDictionary());
  doc.findPage(0).put('Contents', stream);
  const out = doc.saveToBuffer('garbage=compact');
  try {
    return out.asUint8Array().slice();
  } finally {
    out.destroy();
    doc.destroy();
  }
}

describe('MuPDF buffers from a save are given back', () => {
  const MB = 6;

  it('does not grow the heap save after save', async () => {
    const core = new MupdfCore(mu as never, {});
    core.open(heavyFile(MB), undefined);
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    for (let i = 0; i < 3; i++) expect(core.save(false, true).bytes.byteLength).toBeGreaterThan(MB * 1024 * 1024 * 0.9);
    const warm = heapBytes();
    for (let i = 0; i < 12; i++) core.save(false, true);
    // A buffer kept per save would add 12 x 6 MB.
    expect(heapBytes() - warm).toBeLessThan(MB * 1024 * 1024 * 2);
  });

  it('does not grow the heap extract after extract', async () => {
    const core = new MupdfCore(mu as never, {});
    core.open(heavyFile(MB), undefined);
    for (let i = 0; i < 3; i++) expect(core.extract(['0']).bytes.byteLength).toBeGreaterThan(1000);
    const warm = heapBytes();
    for (let i = 0; i < 12; i++) core.extract(['0']);
    expect(heapBytes() - warm).toBeLessThan(MB * 1024 * 1024 * 2);
  });
});
