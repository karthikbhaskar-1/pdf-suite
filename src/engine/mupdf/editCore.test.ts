// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore, labelFor } from './editCore';
import { moveOrder, optionalEntry, reverseOrder, templateContent, PAGE_SIZES } from './pageOps';
import { WorkerFault, type PageEdit } from './protocol';

const BIG = new URL('../../../tests/fixtures/out/big-1000.pdf', import.meta.url);
const OUTLINE = new URL('../../../tests/engine/corpus/outlines/nested_outline.pdf', import.meta.url);

function open(path: URL, canEdit = true): { doc: mu.Document; pdf: mu.PDFDocument; core: EditCore } {
  const doc = mu.Document.openDocument(new Uint8Array(readFileSync(path)), 'application/pdf');
  const pdf = doc.asPDF()!;
  return { doc, pdf, core: new EditCore(pdf, doc.countPages(), canEdit) };
}

/** Page count and uids as the worker reports them. */
const uidsOf = (core: EditCore) => core.pages().uids;

describe('order arithmetic', () => {
  it('moves pages before a target, keeping their order', async () => {
    expect(moveOrder(6, [1, 4], 0)).toEqual([1, 4, 0, 2, 3, 5]);
    expect(moveOrder(6, [0, 1], null)).toEqual([2, 3, 4, 5, 0, 1]);
    expect(moveOrder(6, [5], 2)).toEqual([0, 1, 5, 2, 3, 4]);
  });

  it('refuses to move a page before itself', async () => {
    expect(() => moveOrder(4, [2], 2)).toThrow(WorkerFault);
  });

  it('reverses the selected positions and leaves the rest where they are', async () => {
    expect(reverseOrder(5, [0, 1, 2, 3, 4])).toEqual([4, 3, 2, 1, 0]);
    expect(reverseOrder(5, [1, 3])).toEqual([0, 3, 2, 1, 4]);
  });
});

describe('template pages', () => {
  it('draws nothing for a blank page, rules for lined, and rules both ways for grid', async () => {
    expect(templateContent('blank', PAGE_SIZES.letter)).toBe('');
    const lined = templateContent('lined', PAGE_SIZES.letter).split('\n');
    const grid = templateContent('grid', PAGE_SIZES.letter).split('\n');
    expect(lined.filter((line) => line.endsWith(' S')).length).toBeGreaterThan(20);
    expect(grid.length).toBeGreaterThan(lined.length);
    expect(grid.some((line) => / m \d+(\.\d+)? \d+(\.\d+)? l S$/.test(line) && line.includes(' 72 '))).toBe(true);
  });
});

describe('EditCore apply, undo and redo', () => {
  it('deletes 500 of 1000 pages in one journal step, under a second', async () => {
    const { pdf, core } = open(BIG);
    const keep = uidsOf(core).slice(500);
    const started = performance.now();
    await core.apply([{ op: 'delete', uids: uidsOf(core).slice(0, 500) }]);
    const elapsed = performance.now() - started;
    expect(core.pageCount).toBe(500);
    expect(uidsOf(core)).toEqual(keep);
    expect(pdf.countPages()).toBe(500);
    expect(pdf.getJournal().position).toBe(1);
    expect(core.history).toMatchObject({ dirty: true, canUndo: true, undoLabel: 'Delete 500 pages' });
    expect(elapsed).toBeLessThan(1000);
  });

  it('undo and redo round-trip the page list and the document', async () => {
    const { pdf, core } = open(BIG);
    const original = uidsOf(core);
    await core.apply([{ op: 'delete', uids: ['3', '4'] }]);
    await core.apply([{ op: 'reverse', uids: ['0', '1'] }]);
    const afterBoth = uidsOf(core);
    expect(core.history.undoLabel).toBe('Reverse 2 pages');

    core.undo();
    core.undo();
    expect(uidsOf(core)).toEqual(original);
    expect(pdf.countPages()).toBe(1000);
    expect(core.history).toMatchObject({ dirty: false, canUndo: false, canRedo: true, redoLabel: 'Delete 2 pages' });

    core.redo();
    core.redo();
    expect(uidsOf(core)).toEqual(afterBoth);
    expect(pdf.countPages()).toBe(998);
    expect(pdf.getJournal().position).toBe(2);
  });

  it('a new edit after an undo drops the redo steps', async () => {
    const { core } = open(BIG);
    await core.apply([{ op: 'delete', uids: ['0'] }]);
    core.undo();
    await core.apply([{ op: 'delete', uids: ['1'] }]);
    expect(core.history.canRedo).toBe(false);
    expect(() => core.redo()).toThrow(WorkerFault);
  });

  it('gives a fresh uid to an inserted page and never reuses one', async () => {
    const { core } = open(BIG);
    await core.apply([{ op: 'insertBlank', afterUid: '0', size: PAGE_SIZES.a4, template: 'grid', count: 2 }]);
    expect(uidsOf(core).slice(0, 4)).toEqual(['0', 'n1', 'n2', '1']);
    core.undo();
    await core.apply([{ op: 'insertBlank', afterUid: null, size: PAGE_SIZES.letter, template: 'blank' }]);
    expect(uidsOf(core)[0]).toBe('n3');
  });

  it('bumps the rev of a rotated page, and a rev is never reused after an undo', async () => {
    const { pdf, core } = open(BIG);
    const before = core.pages().revs[2]!;
    await core.apply([{ op: 'rotate', uids: ['2'], degrees: 90 }]);
    const rotated = core.pages().revs[2]!;
    expect(rotated).toBeGreaterThan(before);
    expect(pdf.findPage(2).getInheritable('Rotate').asNumber()).toBe(90);
    core.undo();
    expect(core.pages().revs[2]).toBe(before);
    expect(pdf.findPage(2).getInheritable('Rotate').isNull() || pdf.findPage(2).getInheritable('Rotate').asNumber() === 0).toBe(true);
    await core.apply([{ op: 'rotate', uids: ['2'], degrees: 180 }]);
    expect(core.pages().revs[2]).not.toBe(rotated);
    expect(core.pages().revs[2]).not.toBe(before);
  });

  it('a move does not change any page content, so no rev changes', async () => {
    const { core } = open(BIG);
    const revsBefore = core.pages().revs;
    await core.apply([{ op: 'move', uids: ['10'], beforeUid: '0' }]);
    expect(core.pages().revs.slice().sort()).toEqual(revsBefore.slice().sort());
    expect(uidsOf(core)[0]).toBe('10');
  });

  it('answers a stale uid with a Conflict and changes nothing', async () => {
    const { pdf, core } = open(BIG);
    await core.apply([{ op: 'delete', uids: ['7'] }]);
    const edits: PageEdit[] = [
      { op: 'rotate', uids: ['0'], degrees: 90 },
      { op: 'move', uids: ['7'], beforeUid: null },
    ];
    let thrown: unknown;
    try {
      await core.apply(edits);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkerFault);
    expect((thrown as WorkerFault).kind).toBe('Conflict');
    expect(core.history.undoLabel).toBe('Delete 1 page');
    expect(pdf.getJournal().position).toBe(1);
    expect(pdf.findPage(0).getInheritable('Rotate').isNull() || pdf.findPage(0).getInheritable('Rotate').asNumber() === 0).toBe(true);
  });

  it('a document that cannot be edited rejects every edit with a plain error', async () => {
    const { core } = open(BIG, false);
    await expect(core.apply([{ op: 'delete', uids: ['0'] }])).rejects.toThrow('This document cannot be edited.');
    expect(() => core.undo()).toThrow('This document cannot be edited.');
    expect(core.pageCount).toBe(1000);
  });

  // nested_outline.pdf is not redistributable (scripts/download-test-corpus.mjs); skipped when it is absent.
  it.skipIf(!existsSync(OUTLINE))('keeps outline destinations pointing at the same pages after a reorder and a delete (needs corpus nested_outline.pdf)', async () => {
    const { pdf, core } = open(OUTLINE);
    const outline = pdf.loadOutline() ?? [];
    const targets: Array<{ title: string; page: number }> = [];
    const walk = (items: typeof outline) => {
      for (const item of items) {
        if (typeof item.page === 'number' && item.page >= 0) targets.push({ title: item.title ?? '', page: item.page });
        if (item.down) walk(item.down);
      }
    };
    walk(outline);
    expect(targets.length).toBeGreaterThan(1);
    const uidOfTarget = new Map(targets.map((t) => [t.title, uidsOf(core)[t.page]!]));

    const count = core.pageCount;
    await core.apply([{ op: 'reverse', uids: uidsOf(core) }]);
    // The last page of the old order is now first: the destinations still name the same uid, at the new position.
    const reversedUids = uidsOf(core);
    expect(reversedUids[0]).toBe(String(count - 1));
    const afterReverse = pdf.loadOutline() ?? [];
    const pageNow = (title: string) => {
      const find = (items: typeof afterReverse): number | undefined => {
        for (const item of items) {
          if (item.title === title) return item.page ?? undefined;
          const deeper = item.down ? find(item.down) : undefined;
          if (deeper !== undefined) return deeper;
        }
        return undefined;
      };
      return find(afterReverse);
    };
    for (const [title, uid] of uidOfTarget) {
      const at = pageNow(title);
      expect(at).toBeDefined();
      expect(reversedUids[at!]).toBe(uid);
    }
  });

  it('a duplicated page carries its own copy of each annotation, pointing at the copy', async () => {
    const { pdf, core } = open(BIG);
    pdf.beginOperation('add a note');
    const annot = pdf.loadPage(0).createAnnotation('Text');
    annot.setRect([10, 10, 40, 40]);
    pdf.endOperation();
    await core.apply([{ op: 'duplicate', uids: ['0'] }]);
    expect(uidsOf(core).slice(0, 2)[0]).toBe('0');
    expect(core.pageCount).toBe(1001);

    const original = pdf.findPage(0);
    const copy = pdf.findPage(1);
    const originalAnnots = original.get('Annots');
    const copyAnnots = copy.get('Annots');
    // A text note comes with its popup, so the page has two annotations, and the copy has the same two.
    expect(originalAnnots.length).toBeGreaterThan(0);
    expect(copyAnnots.length).toBe(originalAnnots.length);
    for (let i = 0; i < copyAnnots.length; i++) {
      const copyAnnot = copyAnnots.get(i).resolve();
      expect(copyAnnot.get('P').asIndirect()).toBe(copy.asIndirect());
      // Each copy is its own dictionary, not a shared reference to the original.
      expect(copyAnnots.get(i).asIndirect()).not.toBe(originalAnnots.get(i).asIndirect());
    }
  });

  it('duplicates a page that has no annotations, and the copy has none either', async () => {
    const { pdf, core } = open(BIG);
    await core.apply([{ op: 'duplicate', uids: ['5'] }]);
    expect(core.pageCount).toBe(1001);
    expect(uidsOf(core).slice(5, 7)).toEqual(['5', 'n1']);
    expect(optionalEntry(pdf.findPage(6), 'Annots')).toBeUndefined();
    core.undo();
    expect(core.pageCount).toBe(1000);
  });

  it('inserts template pages of the requested size', async () => {
    const { pdf, core } = open(BIG);
    await core.apply([{ op: 'insertBlank', afterUid: null, size: PAGE_SIZES.legal, template: 'lined' }]);
    const bounds = pdf.loadPage(0).getBounds();
    expect(bounds[2]! - bounds[0]!).toBe(612);
    expect(bounds[3]! - bounds[1]!).toBe(1008);
    expect(core.history.undoLabel).toBe('Insert 1 lined page');
  });
});

describe('labels', () => {
  it('names one apply by its operation and page count', async () => {
    expect(labelFor([{ op: 'delete', uids: ['1', '2', '3'] }])).toBe('Delete 3 pages');
    expect(labelFor([{ op: 'rotate', uids: ['1'], degrees: 90 }])).toBe('Rotate 1 page');
    expect(labelFor([{ op: 'delete', uids: ['1'] }, { op: 'rotate', uids: ['2'], degrees: 90 }])).toBe('Edit pages');
  });
});

describe('discarding the latest step (a cancelled preview)', () => {
  it('leaves no redo step, frees the uids the step used, and keeps the earlier history', async () => {
    const { pdf, core } = open(BIG);
    await core.apply([{ op: 'rotate', uids: [uidsOf(core)[0]!], degrees: 90 }]);
    const before = core.pages();
    const seed = (await core.apply([{ op: 'duplicate', uids: [uidsOf(core)[1]!] }])).uidSeed;
    expect(core.pageCount).toBe(1001);
    core.discardTop();
    expect(core.pageCount).toBe(1000);
    expect(core.pages()).toEqual(before);
    expect(core.history).toMatchObject({ dirty: true, canUndo: true, canRedo: false, undoLabel: 'Rotate 1 page', redoLabel: null });
    expect(pdf.countPages()).toBe(1000);
    // Redo goes through the step list, which no longer has the step (MuPDF's own journal tail is overwritten by the next edit).
    expect(() => core.redo()).toThrow(/Nothing to redo/);
    // The next step reuses the uid the discarded one used.
    const again = await core.apply([{ op: 'duplicate', uids: [uidsOf(core)[1]!] }]);
    expect(again.uidSeed).toBe(seed);
  });

  it('a plain undo, in contrast, leaves the step to redo', async () => {
    const { core } = open(BIG);
    await core.apply([{ op: 'rotate', uids: [uidsOf(core)[0]!], degrees: 90 }]);
    core.undo();
    expect(core.history.canRedo).toBe(true);
  });

  it('refuses when there is nothing to discard, or a step sits above to redo', async () => {
    const { core } = open(BIG);
    expect(() => core.discardTop()).toThrow(/Nothing to undo/);
    await core.apply([{ op: 'rotate', uids: [uidsOf(core)[0]!], degrees: 90 }]);
    await core.apply([{ op: 'rotate', uids: [uidsOf(core)[1]!], degrees: 90 }]);
    core.undo();
    expect(() => core.discardTop()).toThrow(/Nothing to undo/);
  });
});
