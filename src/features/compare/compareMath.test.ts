// 1.3.4 Overlay to Compare: the pure rules of the page side. The wording is the UI spec's, word for word.
import { describe, expect, it } from 'vitest';
import { newSession, type CompareSession } from '../../core/stores/compareStore';
import {
  COMPARE_CHOOSE_FIRST,
  COMPARE_DIFFERENCES_LEGEND,
  COMPARE_DIFFERENCES_VIEW_ONLY,
  COMPARE_DIFFERENT_SIZE,
  COMPARE_GONE,
  COMPARE_NOT_COPIED,
  COMPARE_NO_FILE,
  COMPARE_NO_MATCH,
  COMPARE_NO_PARTNER,
  addProblem,
  addedText,
  clampOffset,
  clampPage,
  compareTargets,
  comparingWith,
  fileLine,
  modeOf,
  nudgeStep,
  openingText,
  overlayCacheId,
  overlayViewFor,
  parseSizePercent,
  partnerOf,
  thisPageLine,
  unsavedText,
  viewKeyOf,
  xfaText,
} from './compareMath';

const session = (patch: Partial<CompareSession> = {}): CompareSession => ({
  ...newSession('path:C:\\a.pdf', 'mm'),
  // A fixed key: a new session has a new one, which is itself part of the hash (see the test below).
  key: 1,
  phase: 'ready',
  file: { path: 'C:\\o.pdf', name: 'Plan-rev2.pdf', pages: 5 },
  sourceDocId: 'src1',
  attach: 1,
  ...patch,
});

describe('the words of the UI spec (section 4)', () => {
  it('are exact', () => {
    expect(COMPARE_NO_FILE).toBe('No PDF chosen yet.');
    expect(COMPARE_DIFFERENCES_LEGEND).toBe('Red: only in this document. Blue-green: only in the overlay. Black: in both.');
    expect(COMPARE_NO_PARTNER).toBe('This page has no overlay page.');
    expect(COMPARE_DIFFERENT_SIZE).toBe('The overlay page is a different size.');
    expect(COMPARE_DIFFERENCES_VIEW_ONLY).toBe('“Differences” is for viewing only. Choose Both or See-through to add the overlay to the pages.');
    expect(COMPARE_NOT_COPIED).toBe('Comments and form boxes in the overlay file are not copied.');
    expect(COMPARE_GONE).toBe('The overlay file has changed or can no longer be read, so comparing has stopped. Choose the PDF again to carry on.');
    expect(comparingWith('Plan-rev2.pdf')).toBe('Comparing with Plan-rev2.pdf. The overlay is only on screen.');
    expect(openingText('Plan-rev2.pdf')).toBe('Opening Plan-rev2.pdf…');
    expect(unsavedText('Plan-rev2.pdf')).toBe('Plan-rev2.pdf has unsaved changes. The overlay shows its last saved version.');
    expect(xfaText('f.pdf')).toBe("f.pdf is a kind of form that can't be used as an overlay.");
    expect(fileLine('Plan-rev2.pdf', 14)).toBe('Plan-rev2.pdf · 14 pages');
    expect(fileLine('a.pdf', 1)).toBe('a.pdf · 1 page');
    expect(thisPageLine(4)).toBe('This page: overlay page 5.');
    expect(thisPageLine(null)).toBe('This page has no overlay page.');
    expect(addedText(14)).toBe('Added the overlay to 14 pages');
    expect(addedText(1)).toBe('Added the overlay to 1 page');
  });
});

describe('looks and values', () => {
  it('Both is Multiply, See-through is Blend, Differences is the view-only look', () => {
    expect(modeOf('both')).toBe('multiply');
    expect(modeOf('seethrough')).toBe('blend');
    expect(modeOf('differences')).toBe('difference');
  });

  it('Size takes 25 to 400', () => {
    expect(parseSizePercent('100')).toBe(100);
    expect(parseSizePercent('25')).toBe(25);
    expect(parseSizePercent('400')).toBe(400);
    expect(parseSizePercent('24.9')).toBeNull();
    expect(parseSizePercent('401')).toBeNull();
    expect(parseSizePercent('')).toBeNull();
    expect(parseSizePercent('5e1')).toBeNull();
  });

  it('an offset stays within the page size, either way', () => {
    expect(clampOffset(50, 600)).toBe(50);
    expect(clampOffset(700, 600)).toBe(600);
    expect(clampOffset(-700, 600)).toBe(-600);
    expect(clampOffset(Number.NaN, 600)).toBe(0);
  });

  it('an arrow button moves 1 pt, and 10 with Shift', () => {
    expect(nudgeStep(false)).toBe(1);
    expect(nudgeStep(true)).toBe(10);
  });

  it('a page number is moved into the overlay file', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(2.4, 5)).toBe(2);
  });
});

describe('which overlay page goes with a page', () => {
  it('page by page from the start page: page 1 gets the start page, the next page the next, and so on to the end of the file', () => {
    const s = session({ startPage: 2, file: { path: 'x', name: 'o.pdf', pages: 4 } });
    expect([0, 1, 2, 3].map((i) => partnerOf(s, i))).toEqual([1, 2, 3, null]);
  });

  it('the same overlay page on every page', () => {
    const s = session({ match: 'fixed', fixedPage: 3 });
    expect([0, 1, 9].map((i) => partnerOf(s, i))).toEqual([2, 2, 2]);
  });

  it('no file attached: no partner', () => {
    expect(partnerOf(session({ file: null }), 0)).toBeNull();
  });
});

describe('the view the viewer asks for', () => {
  it('a page with a partner gets the engine arguments of the session, in the placement the sheet shows', () => {
    const s = session({ look: 'seethrough', opacity: 40, dx: 12.5, dy: -3, size: 150, startPage: 2 });
    const view = overlayViewFor(s, 1)!;
    expect(view.args).toEqual({ sourceDocId: 'src1', sourcePage: 2, dx: 12.5, dy: -3, scale: 1.5, mode: 'blend', opacity: 0.4 });
  });

  it('is plain (undefined) when the overlay is hidden, nothing is attached yet, the file is being read again, or the page has no partner', () => {
    expect(overlayViewFor(session({ show: false }), 0)).toBeUndefined();
    expect(overlayViewFor(session({ sourceDocId: null }), 0)).toBeUndefined();
    expect(overlayViewFor(session({ phase: 'reattaching', sourceDocId: null }), 0)).toBeUndefined();
    expect(overlayViewFor(session({ phase: 'opening' }), 0)).toBeUndefined();
    expect(overlayViewFor(session({ file: { path: 'x', name: 'o.pdf', pages: 2 } }), 2)).toBeUndefined();
    expect(overlayViewFor(null, 0)).toBeUndefined();
  });

  it('gives the same object for the same session, so a page of the viewer is not drawn again for nothing', () => {
    const s = session();
    expect(overlayViewFor(s, 0)).toBe(overlayViewFor(s, 0));
    expect(overlayViewFor(session(), 0)).not.toBe(overlayViewFor(s, 0));
  });

  it('every change to the picture changes the hash, and one that does not show does not', () => {
    const base = overlayViewFor(session(), 0)!.hash;
    const different = (patch: Partial<CompareSession>) => overlayViewFor(session(patch), 0)!.hash !== base;
    expect(different({ attach: 2 })).toBe(true);
    // Another compare (a new session key) never finds the bitmaps of this one.
    expect(different({ key: 2 })).toBe(true);
    // Another compare (a new session key) never finds the bitmaps of this one.
    expect(different({ key: 2 })).toBe(true);
    expect(different({ look: 'differences' })).toBe(true);
    expect(different({ dx: 1 })).toBe(true);
    expect(different({ dy: 1 })).toBe(true);
    expect(different({ size: 101 })).toBe(true);
    expect(different({ startPage: 2 })).toBe(true);
    expect(different({ match: 'fixed', fixedPage: 3 })).toBe(true);
    // Opacity only counts in See-through.
    expect(different({ opacity: 10 })).toBe(false);
    expect(overlayViewFor(session({ look: 'seethrough', opacity: 10 }), 0)!.hash).not.toBe(overlayViewFor(session({ look: 'seethrough', opacity: 20 }), 0)!.hash);
    // The sheet's own settings (the units, Add to) do not change the picture.
    expect(different({ unit: 'in', addTo: 'all', show: true })).toBe(false);
  });

  it('the cache id is a pseudo document that the plain id can never match, and the view key is a prefix of every hash', () => {
    expect(overlayCacheId('path:C:\\a.pdf', 'h')).toBe('path:C:\\a.pdf#ov:h');
    expect(overlayCacheId('path:C:\\a.pdf', 'h').startsWith('path:C:\\a.pdf|')).toBe(false);
    const s = session({ dx: 7 });
    expect(overlayViewFor(s, 0)!.hash.startsWith(`${viewKeyOf(s)}.`)).toBe(true);
  });
});

describe('which pages "Add to" names (the scope rules)', () => {
  const order = ['0', '1', '2', '3', '4', '5'];
  const s = session({ startPage: 1, file: { path: 'x', name: 'o.pdf', pages: 4 } });

  it('Current page: the page of the page box, whatever is selected', () => {
    expect(compareTargets({ order, selected: ['0', '1'], current: '3' }, 'current', s)).toEqual({ pairs: [{ uid: '3', sourceIndex: 3 }], named: 1 });
  });

  it('Selected pages: the selection in page order, not the current page', () => {
    const t = compareTargets({ order, selected: ['2', '0'], current: '5' }, 'selected', s);
    expect(t.pairs).toEqual([
      { uid: '0', sourceIndex: 0 },
      { uid: '2', sourceIndex: 2 },
    ]);
  });

  it('All matched pages: every page that has an overlay page, and no other', () => {
    const t = compareTargets({ order, selected: [], current: null }, 'all', s);
    expect(t.pairs.map((p) => p.uid)).toEqual(['0', '1', '2', '3']);
    expect(t.named).toBe(6);
  });

  it('a selected page without a partner is named but not added', () => {
    const t = compareTargets({ order, selected: ['5'], current: null }, 'selected', s);
    expect(t).toEqual({ pairs: [], named: 1 });
  });

  it('one overlay page on every page pairs every named page with it', () => {
    const t = compareTargets({ order, selected: ['1', '4'], current: null }, 'selected', session({ match: 'fixed', fixedPage: 2 }));
    expect(t.pairs).toEqual([
      { uid: '1', sourceIndex: 1 },
      { uid: '4', sourceIndex: 1 },
    ]);
  });

  it('a uid that is not in the page list (a selection of another document) is ignored, and so is a current page that is not there', () => {
    expect(compareTargets({ order, selected: ['x9'], current: 'x9' }, 'selected', s).pairs).toEqual([]);
    expect(compareTargets({ order, selected: [], current: 'x9' }, 'current', s).pairs).toEqual([]);
  });
});

describe('why "Add overlay to pages" is off', () => {
  const targets = { pairs: [{ uid: '0', sourceIndex: 0 }], named: 1 };

  it('Differences is for viewing only', () => {
    expect(addProblem(session({ look: 'differences' }), targets)).toBe(COMPARE_DIFFERENCES_VIEW_ONLY);
  });

  it('no file, or the file is not attached yet', () => {
    expect(addProblem(session({ file: null, sourceDocId: null }), targets)).toBe(COMPARE_CHOOSE_FIRST);
    expect(addProblem(session({ phase: 'reattaching', sourceDocId: null }), targets)).toBe(COMPARE_CHOOSE_FIRST);
  });

  it('no page to add to', () => {
    expect(addProblem(session(), { pairs: [], named: 3 })).toBe(COMPARE_NO_MATCH);
  });

  it('otherwise it can run', () => {
    expect(addProblem(session(), targets)).toBeNull();
    expect(addProblem(session({ look: 'seethrough' }), targets)).toBeNull();
  });
});
