import { describe, expect, it } from 'vitest';
import {
  CUT_DEFAULT_PERCENT,
  cutDoneText,
  cutFromPointer,
  cutScopeUids,
  cutSummary,
  defaultCutScope,
  cutShare,
  formatCutPercent,
  stepCutPercent,
  fromShown,
  guideShape,
  parseCutPercent,
  snapCutPercent,
  toShown,
  wideChoiceLabel,
  type CutInputs,
} from './cutMath';

describe('the cut position as typed', () => {
  it('accepts numbers from 30 to 70, with or without a decimal part', () => {
    expect(parseCutPercent('50')).toBe(50);
    expect(parseCutPercent(' 30 ')).toBe(30);
    expect(parseCutPercent('70')).toBe(70);
    expect(parseCutPercent('62.5')).toBe(62.5);
    // One decimal place (1.5.5 C4): 45.25 becomes 45.3, and 50.25 becomes 50.3.
    expect(parseCutPercent('45.25')).toBe(45.3);
    expect(parseCutPercent('50.25')).toBe(50.3);
    expect(parseCutPercent('50.34')).toBe(50.3);
  });

  it('refuses anything else, so the sheet shows "Enter a number from 30 to 70."', () => {
    for (const text of ['', ' ', 'abc', '29.9', '70.1', '0', '100', '-50', '5e1', '50%', '50,5', '1e2', '.5', '5 0']) {
      expect(parseCutPercent(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('formats a number without trailing zeros', () => {
    expect(formatCutPercent(50)).toBe('50');
    expect(formatCutPercent(62.5)).toBe('62.5');
    expect(formatCutPercent(33.333333)).toBe('33.3');
    expect(formatCutPercent(50.3)).toBe('50.3');
  });

  it('shares the position without floating-point dust', () => {
    expect(cutShare(50.3)).toBe(0.503);
    expect(cutShare(50)).toBe(0.5);
  });

  it('an arrow key goes to the next multiple of 0.5 in its direction (1.5.5 C4)', () => {
    expect(stepCutPercent(50.3, 1)).toBe(50.5);
    expect(stepCutPercent(50.3, -1)).toBe(50);
    expect(stepCutPercent(50, 1)).toBe(50.5);
    expect(stepCutPercent(50, -1)).toBe(49.5);
    expect(stepCutPercent(70, 1)).toBe(70);
    expect(stepCutPercent(30, -1)).toBe(30);
  });

  it('snaps a slider value to steps of 0.5 and keeps it from 30 to 70', () => {
    expect(snapCutPercent(50.2)).toBe(50);
    expect(snapCutPercent(50.3)).toBe(50.5);
    expect(snapCutPercent(12)).toBe(30);
    expect(snapCutPercent(99)).toBe(70);
    expect(CUT_DEFAULT_PERCENT).toBe(50);
  });
});

describe('Apply to: the pages a scope names', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];
  const wide = { width: 800, height: 600 };
  const tall = { width: 600, height: 800 };
  const base: CutInputs = { order, sizes: [wide, tall, wide, tall, { width: 500, height: 500 }, wide], selected: [], current: 'c' };

  it('starts at the selected pages when two or more are selected, else at all pages', () => {
    expect(defaultCutScope(0)).toBe('all');
    expect(defaultCutScope(1)).toBe('all');
    expect(defaultCutScope(2)).toBe('selected');
    expect(defaultCutScope(40)).toBe('selected');
  });

  it('All pages: every page, in order', () => {
    expect(cutScopeUids(base, 'all', 'vertical').uids).toEqual(order);
  });

  it('Current page: the current page, or nothing when there is none or it is not in the list', () => {
    expect(cutScopeUids(base, 'current', 'vertical').uids).toEqual(['c']);
    expect(cutScopeUids({ ...base, current: null }, 'current', 'vertical').uids).toEqual([]);
    expect(cutScopeUids({ ...base, current: 'zzz' }, 'current', 'vertical').uids).toEqual([]);
  });

  it('Selected pages: the selected ones in page order, ignoring ids that are not pages of this list', () => {
    expect(cutScopeUids({ ...base, selected: ['e', 'b', 'gone'] }, 'selected', 'vertical').uids).toEqual(['b', 'e']);
    expect(cutScopeUids(base, 'selected', 'vertical').uids).toEqual([]);
  });

  it('Wide pages only for a left and right cut, tall pages only for a top and bottom cut; a square page is neither', () => {
    expect(cutScopeUids(base, 'wide', 'vertical')).toEqual({ uids: ['a', 'c', 'f'], unmeasured: false });
    expect(cutScopeUids(base, 'wide', 'horizontal')).toEqual({ uids: ['b', 'd'], unmeasured: false });
  });

  it('a page not measured yet is not guessed: it is left out and the answer says sizes are missing', () => {
    const partial = { ...base, sizes: [wide, undefined, wide, tall, wide, wide] };
    const result = cutScopeUids(partial, 'wide', 'vertical');
    expect(result.uids).toEqual(['a', 'c', 'e', 'f']);
    expect(result.unmeasured).toBe(true);
    // Scopes that do not depend on sizes are not held up by missing sizes.
    expect(cutScopeUids(partial, 'all', 'vertical').unmeasured).toBe(false);
  });

  it('names the wide choice by direction', () => {
    expect(wideChoiceLabel('vertical')).toBe('Wide pages only');
    expect(wideChoiceLabel('horizontal')).toBe('Tall pages only');
  });
});

describe('the sentences', () => {
  it('summary and toast say the page counts the spec gives', () => {
    expect(cutSummary(12)).toBe('Cuts 12 pages into 24. Comments and links stay with their half.');
    expect(cutSummary(1)).toBe('Cuts 1 page into 2. Comments and links stay with their half.');
    expect(cutDoneText(12)).toBe('Cut 12 pages in half');
    expect(cutDoneText(1)).toBe('Cut 1 page in half');
  });
});

describe('the guide on a page shown turned', () => {
  it('a point turned and turned back is the same point, for every view rotation', () => {
    for (const rotation of [0, 90, 180, 270]) {
      for (const point of [{ x: 0.2, y: 0.7 }, { x: 0, y: 0 }, { x: 1, y: 0.5 }]) {
        const back = fromShown(toShown(point, rotation), rotation);
        expect(back.x).toBeCloseTo(point.x);
        expect(back.y).toBeCloseTo(point.y);
      }
    }
  });

  it('a corner goes where a clockwise turn puts it', () => {
    expect(toShown({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 });
    expect(toShown({ x: 1, y: 0 }, 90)).toEqual({ x: 1, y: 1 });
    expect(toShown({ x: 0, y: 0 }, 180)).toEqual({ x: 1, y: 1 });
    expect(toShown({ x: 0, y: 0 }, 270)).toEqual({ x: 0, y: 1 });
  });

  it('a left and right cut is a vertical line, marking the left half 1 (or the right half when it is first)', () => {
    const left = guideShape('vertical', 0.4, 'left', 0);
    expect(left.line).toEqual([{ x: 0.4, y: 0 }, { x: 0.4, y: 1 }]);
    expect(left.first.x).toBeCloseTo(0.2);
    expect(left.second.x).toBeCloseTo(0.7);
    const right = guideShape('vertical', 0.4, 'right', 0);
    expect(right.first.x).toBeCloseTo(0.7);
    expect(right.second.x).toBeCloseTo(0.2);
  });

  it('a top and bottom cut is a horizontal line, always marking the top half 1', () => {
    for (const first of ['left', 'right'] as const) {
      const g = guideShape('horizontal', 0.6, first, 0);
      expect(g.line).toEqual([{ x: 0, y: 0.6 }, { x: 1, y: 0.6 }]);
      expect(g.first.y).toBeCloseTo(0.3);
      expect(g.second.y).toBeCloseTo(0.8);
    }
  });

  it('on a page shown turned 90 degrees, a left and right cut shows as a horizontal line, with the left half at the top', () => {
    const g = guideShape('vertical', 0.4, 'left', 90);
    expect(g.line[0].y).toBeCloseTo(0.4);
    expect(g.line[1].y).toBeCloseTo(0.4);
    expect(g.line[0].x).not.toBeCloseTo(g.line[1].x);
    // The page's left edge is at the top when it is turned clockwise a quarter.
    expect(g.first.y).toBeLessThan(g.second.y);
  });

  it('a pointer on the page as shown gives the cut position of the page, for every view rotation', () => {
    for (const rotation of [0, 90, 180, 270]) {
      for (const direction of ['vertical', 'horizontal'] as const) {
        for (const at of [0.3, 0.5, 0.7]) {
          const shape = guideShape(direction, at, 'left', rotation);
          // The midpoint of the drawn line, read back as a pointer position, is the cut that was drawn.
          const mid = { x: (shape.line[0].x + shape.line[1].x) / 2, y: (shape.line[0].y + shape.line[1].y) / 2 };
          expect(cutFromPointer(direction, mid, rotation)).toBeCloseTo(at);
        }
      }
    }
  });
});
