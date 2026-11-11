// @vitest-environment node
// A save whose bytes never reached the disk (the write failed, or Save As was cancelled) must not cost the user any edit.
// MuPDF's second incremental save of one document returns the ORIGINAL file (tests/signoff3/engine-double-save.mjs), so a
// document that has produced one save is saved in full from then on. These tests run the real MuPDF and read the bytes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { EARLIER_CHANGES_REASON } from './editCore';
import { firstMismatch, pageFingerprints } from './pageFingerprint';

const OUTLINE = new URL('../../../tests/fixtures/out/outline-6.pdf', import.meta.url);
const MIXED = new URL('../../../tests/fixtures/out/mixed-sizes-rotated.pdf', import.meta.url);

function openCore(file: URL): { core: MupdfCore; original: Uint8Array } {
  const original = new Uint8Array(readFileSync(file));
  const core = new MupdfCore(mu as never, {});
  core.open(original.slice(), undefined);
  return { core, original };
}

/** The pages and fingerprints of saved bytes, read with a separate MuPDF document. */
function reopen(bytes: ArrayBuffer | Uint8Array): { count: number; prints: number[]; rotations: number[] } {
  const doc = mu.Document.openDocument(new Uint8Array(bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes), 'application/pdf');
  try {
    const pdf = doc.asPDF()!;
    const rotations = Array.from({ length: pdf.countPages() }, (_, i) => {
      const r = pdf.findPage(i).getInheritable('Rotate');
      return r.isNull() ? 0 : r.asNumber();
    });
    return { count: doc.countPages(), prints: pageFingerprints(pdf), rotations };
  } finally {
    doc.destroy();
  }
}

const uidAt = (core: MupdfCore, index: number): string => core.editState!.pages().uids[index]!;

describe('saving again after a save whose bytes were thrown away', () => {
  it('the second save writes the duplicated page, as the first did', async () => {
    const { core, original } = openCore(OUTLINE);
    await core.applyEdits([{ op: 'duplicate', uids: [uidAt(core, 0)] }]);
    const first = core.save(true, true);
    expect(first.mode).toBe('incremental');
    expect(reopen(first.bytes).count).toBe(7);
    // The write failed: the page keeps the document and saves again.
    const second = core.save(true, true);
    expect(second.mode).toBe('full');
    const saved = reopen(second.bytes);
    expect(saved.count).toBe(7);
    expect(saved.prints).toEqual(second.fingerprints);
    expect(Buffer.from(second.bytes).equals(Buffer.from(original))).toBe(false);
  });

  it('keeps a rotation and a duplicate together across two failed saves and a third', async () => {
    const { core } = openCore(OUTLINE);
    await core.applyEdits([{ op: 'rotate', uids: [uidAt(core, 0)], degrees: 90 }]);
    await core.applyEdits([{ op: 'duplicate', uids: [uidAt(core, 0)] }]);
    core.save(true, true);
    core.save(true, true);
    const third = core.save(true, true);
    const saved = reopen(third.bytes);
    expect(saved.count).toBe(7);
    expect(saved.rotations.slice(0, 2)).toEqual([90, 90]);
    expect(saved.prints).toEqual(pageFingerprints((core as unknown as { pdf: mu.PDFDocument }).pdf));
  });

  it('writes the earlier edits and the later ones when more edits are made after the failure', async () => {
    const { core } = openCore(OUTLINE);
    await core.applyEdits([{ op: 'duplicate', uids: [uidAt(core, 0)] }]);
    core.save(true, true);
    await core.applyEdits([{ op: 'rotate', uids: [uidAt(core, 6)], degrees: 90 }]);
    await core.applyEdits([{ op: 'move', uids: [uidAt(core, 2)], beforeUid: null }]);
    const retry = core.save(true, true);
    const saved = reopen(retry.bytes);
    expect(saved.count).toBe(7);
    expect(saved.rotations[6]).toBe(0); // the last page is the moved one now; the rotated copy is the one before it
    expect(saved.rotations[5]).toBe(90);
    expect(saved.prints).toEqual(retry.fingerprints);
  });

  it('after a failed save the saved steps stay unsaved and are not undone in the wrong place, and later steps still undo', async () => {
    const { core, original } = openCore(OUTLINE);
    await core.applyEdits([{ op: 'duplicate', uids: [uidAt(core, 0)] }]);
    core.save(true, true);
    // MuPDF cannot undo what a save serialized, so the step is not offered (offering it would make the page list and the
    // document disagree), but the document stays unsaved.
    expect(core.editState!.history).toMatchObject({ dirty: true, canUndo: false });
    expect(() => core.undo()).toThrow(/can no longer be undone/);
    // The reason travels with the history state, so the page can show it as the Undo command's disabled reason.
    expect(core.editState!.history.undoBlockedReason).toBe(EARLIER_CHANGES_REASON);
    expect(core.pageCount).toBe(7);
    // A step made after the failure can be undone, and the next save matches the page list.
    await core.applyEdits([{ op: 'rotate', uids: [uidAt(core, 0)], degrees: 90 }]);
    expect(core.editState!.history).toMatchObject({ dirty: true, canUndo: true, undoBlockedReason: null });
    core.undo();
    // Back at the saved step: earlier changes still cannot be undone, and the reason is given again.
    expect(core.editState!.history).toMatchObject({ canUndo: false, undoBlockedReason: EARLIER_CHANGES_REASON });
    const retry = core.save(true, true);
    const saved = reopen(retry.bytes);
    expect(saved.count).toBe(7);
    expect(saved.rotations[0]).toBe(0);
    expect(saved.prints).toEqual(retry.fingerprints);
    expect(saved.prints).not.toEqual(reopen(original).prints);
  });

  it('a failed Save As (a full save to another path) followed by a Save to the same path keeps the edits', async () => {
    const { core } = openCore(OUTLINE);
    await core.applyEdits([{ op: 'duplicate', uids: [uidAt(core, 0)] }]);
    const asNew = core.save(false, true);
    expect(asNew.mode).toBe('full');
    const same = core.save(true, true);
    expect(same.mode).toBe('full');
    expect(reopen(same.bytes).count).toBe(7);
  });

  it('a page deletion survives the same sequence', async () => {
    const { core } = openCore(OUTLINE);
    await core.applyEdits([{ op: 'delete', uids: [uidAt(core, 0)] }]);
    core.save(true, true);
    const retry = core.save(true, true);
    expect(reopen(retry.bytes).count).toBe(5);
  });

  it('a document with mixed sizes and rotations keeps every edit across a failed save', async () => {
    const { core } = openCore(MIXED);
    const before = core.pageCount;
    await core.applyEdits([{ op: 'delete', uids: [uidAt(core, 0)] }]);
    await core.applyEdits([{ op: 'rotate', uids: [uidAt(core, 1)], degrees: 90 }]);
    await core.applyEdits([{ op: 'duplicate', uids: [uidAt(core, 0)] }]);
    core.save(true, true);
    const retry = core.save(true, true);
    const saved = reopen(retry.bytes);
    expect(saved.count).toBe(before);
    expect(saved.prints).toEqual(retry.fingerprints);
  });
});

describe('page fingerprints', () => {
  it('tell the original bytes from the edited document, and a reordering from the original', async () => {
    const { core, original } = openCore(OUTLINE);
    const originalPrints = reopen(original).prints;
    expect(firstMismatch(originalPrints, originalPrints)).toBe(-1);
    await core.applyEdits([{ op: 'move', uids: [uidAt(core, 0)], beforeUid: null }]);
    const moved = core.fingerprints();
    expect(moved).toHaveLength(6);
    expect(firstMismatch(originalPrints, moved)).toBe(0);
    expect(moved.slice(0, 5)).toEqual(originalPrints.slice(1));
  });

  it('see a rotation and a different page count', async () => {
    const { core, original } = openCore(OUTLINE);
    const originalPrints = reopen(original).prints;
    await core.applyEdits([{ op: 'rotate', uids: [uidAt(core, 3)], degrees: 90 }]);
    expect(firstMismatch(originalPrints, core.fingerprints())).toBe(3);
    expect(firstMismatch([1, 2, 3], [1, 2])).toBe(2);
  });
});
