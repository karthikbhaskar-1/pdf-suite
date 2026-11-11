// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from './editCore';
import { optionalEntry } from './pageOps';
import { WorkerFault } from './protocol';

/** A document of `pages` letter pages, each with its own content. */
function makeDoc(pages: number): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < pages; i++) {
    pdf.insertPage(pdf.countPages(), pdf.addPage([0, 0, 612, 792], 0, {}, `0 g\n${10 + i} 10 20 20 re\nf`));
  }
  return pdf;
}

/** The Rotate value a page has of its own, or 0. */
function rotateOf(pdf: mu.PDFDocument, index: number): number {
  const rotate = optionalEntry(pdf.findPage(index), 'Rotate');
  return rotate ? rotate.asNumber() : 0;
}

describe('a long edit reports progress and can be cancelled', () => {
  it('calls the tick once per page with the pages done and the total', async () => {
    const pdf = makeDoc(150);
    const core = new EditCore(pdf, 150, true, { mu });
    const seen: Array<[number, number]> = [];
    const uids = core.pages().uids;
    await core.apply([{ op: 'rotate', uids, degrees: 90 }], async (done, total) => {
      seen.push([done, total]);
    });
    expect(seen.length).toBe(150);
    expect(seen[0]).toEqual([0, 150]);
    expect(seen[149]).toEqual([149, 150]);
    expect(rotateOf(pdf, 0)).toBe(90);
  });

  it('a cancel part way through rolls the whole edit back, with no journal step left', async () => {
    const pdf = makeDoc(150);
    const core = new EditCore(pdf, 150, true, { mu });
    const uids = core.pages().uids;
    const revsBefore = core.pages().revs;
    const cancelAt = 10;
    await expect(
      core.apply([{ op: 'rotate', uids, degrees: 90 }], async (done) => {
        if (done === cancelAt) throw new WorkerFault('Cancelled', 'The operation was cancelled');
      }),
    ).rejects.toMatchObject({ kind: 'Cancelled' });

    // The pages turned before the cancel are back as they were.
    expect(rotateOf(pdf, 0)).toBe(0);
    expect(rotateOf(pdf, cancelAt - 1)).toBe(0);
    // The page list, the revs and the undo state are unchanged.
    expect(core.pages().revs).toEqual(revsBefore);
    expect(core.history.canUndo).toBe(false);
    expect(core.history.dirty).toBe(false);
    expect(pdf.canUndo()).toBe(false);

    // The document still takes a new edit, and its one undo step is that edit alone.
    await core.apply([{ op: 'rotate', uids: [uids[0]!], degrees: 180 }]);
    expect(rotateOf(pdf, 0)).toBe(180);
    expect(core.history.undoLabel).toBe('Rotate 1 page');
    core.undo();
    expect(rotateOf(pdf, 0)).toBe(0);
    expect(core.history.canUndo).toBe(false);
  });

  it('a cancelled insert adds no pages', async () => {
    const pdf = makeDoc(120);
    const core = new EditCore(pdf, 120, true, { mu });
    await expect(
      core.apply([{ op: 'insertBlank', afterUid: null, size: { width: 612, height: 792 }, template: 'blank', count: 300 }], async (done) => {
        if (done === 5) throw new WorkerFault('Cancelled', 'The operation was cancelled');
      }),
    ).rejects.toMatchObject({ kind: 'Cancelled' });
    expect(core.pageCount).toBe(120);
    expect(pdf.countPages()).toBe(120);
  });
});

describe('an edit that changes nothing makes no undo step (ticket 1.2.1 review, item 1)', () => {
  it('auto-crop of a blank page reports unchanged and leaves the history and the undo of the earlier edit alone', async () => {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 3; i++) pdf.insertPage(pdf.countPages(), pdf.addPage([0, 0, 612, 792], 0, {}, ''));
    const core = new EditCore(pdf, 3, true, { mu });
    const first = await core.apply([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    expect(first.changed).toBe(true);
    const revs = core.pages().revs;
    const result = await core.apply([{ op: 'crop', uids: ['1'], box: 'auto', margin: 0 }]);
    expect(result.changed).toBe(false);
    expect(core.pages().revs).toEqual(revs);
    expect(pdf.getJournal().position).toBe(1);
    expect(core.history).toMatchObject({ canUndo: true, undoLabel: 'Rotate 1 page', canRedo: false });
    core.undo();
    expect(rotateOf(pdf, 0)).toBe(0);
    expect(core.history.canUndo).toBe(false);
    expect(core.pages().uids).toEqual(['0', '1', '2']);
  });
});

describe('a cancelled edit leaves no undo step (ticket 1.2.1 item 10)', () => {
  for (const cancelAt of [0, 75, 149]) {
    it(`cancel at page ${cancelAt} of 150 rolls back: same pages, same journal, and the earlier step is the next undo`, async () => {
      const pdf = makeDoc(150);
      const core = new EditCore(pdf, 150, true, { mu });
      const uids = core.pages().uids;
      await core.apply([{ op: 'rotate', uids: uids.slice(0, 3), degrees: 90 }]);
      const pagesBefore = core.pages();
      await expect(
        core.apply([{ op: 'resize', uids, size: { width: 300, height: 300 }, fit: 'scale' }], async (done) => {
          if (done === cancelAt) throw new WorkerFault('Cancelled', 'The operation was cancelled');
        }),
      ).rejects.toMatchObject({ kind: 'Cancelled' });
      expect(core.pages()).toEqual(pagesBefore);
      expect(pdf.getJournal().position).toBe(1);
      expect(core.history).toMatchObject({ canUndo: true, undoLabel: 'Rotate 3 pages', canRedo: false });
      expect(pdf.loadPage(100).getBounds()).toEqual([0, 0, 612, 792]);
      core.undo();
      expect(core.history.canUndo).toBe(false);
      expect(rotateOf(pdf, 0)).toBe(0);
    });
  }

  it('a cancel that only arrives after the edit is complete cannot be rolled back by the core: the step is whole and undoable', async () => {
    const pdf = makeDoc(10);
    const core = new EditCore(pdf, 10, true, { mu });
    const result = await core.apply([{ op: 'rotate', uids: core.pages().uids, degrees: 90 }]);
    expect(result.changed).toBe(true);
    expect(pdf.getJournal().position).toBe(1);
    expect(core.history.undoLabel).toBe('Rotate 10 pages');
    core.undo();
    expect(rotateOf(pdf, 9)).toBe(0);
  });
});

describe('a Cancel that arrives after the apply finished (ticket 1.2.1 review round 2)', () => {
  it('discardLastStep takes the step back with no redo, the same pages, free uids, and a log that still replays', async () => {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 3; i++) pdf.insertPage(pdf.countPages(), pdf.addPage([0, 0, 612, 792], 0, {}, ''));
    const core = new EditCore(pdf, 3, true, { mu });
    const size = { width: 300, height: 300 };
    const first = await core.apply([{ op: 'insertBlank', afterUid: '2', size, template: 'blank', count: 1 }]);
    const before = core.pages();
    const late = await core.apply([{ op: 'insertBlank', afterUid: '2', size, template: 'blank', count: 1 }]);
    expect(late.changed).toBe(true);
    core.discardLastStep(late.uidSeed);
    expect(core.pages()).toEqual(before);
    expect(pdf.countPages()).toBe(4);
    expect(core.history).toMatchObject({ canUndo: true, canRedo: false });
    // The uid the dropped step used is free again, so the next edit (the one the log records) gets it.
    const next = await core.apply([{ op: 'insertBlank', afterUid: '2', size, template: 'blank', count: 1 }]);
    expect(next.uidSeed).toBe(late.uidSeed);
    expect(first.uidSeed).toBe(0);
    expect(core.pages().uids).toEqual(['0', '1', '2', 'n2', 'n1']);
    // Undo, redo: only the two steps the log knows.
    core.undo();
    core.undo();
    expect(core.history.canUndo).toBe(false);
    core.redo();
    core.redo();
    expect(core.history.canRedo).toBe(false);
  });
});
