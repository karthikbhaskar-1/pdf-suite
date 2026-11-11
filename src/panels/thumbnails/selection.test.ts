import { describe, expect, it } from 'vitest';
import { applySelectionClick, selectAllIds } from './selection';

const order = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };

describe('applySelectionClick', () => {
  it('a plain click selects only the clicked page and makes it the anchor', () => {
    expect(applySelectionClick(['p0', 'p1'], order, 'p0', 'p3', plain)).toEqual({ pageIds: ['p3'], anchorId: 'p3' });
  });

  it('Ctrl adds an unselected page and keeps the others', () => {
    expect(applySelectionClick(['p1'], order, 'p1', 'p4', ctrl)).toEqual({ pageIds: ['p1', 'p4'], anchorId: 'p4' });
  });

  it('Ctrl removes a page that is already selected', () => {
    expect(applySelectionClick(['p1', 'p4'], order, 'p4', 'p1', ctrl)).toEqual({ pageIds: ['p4'], anchorId: 'p1' });
  });

  it('Shift selects the range from the anchor to the clicked page, in either direction', () => {
    expect(applySelectionClick(['p1'], order, 'p1', 'p3', shift).pageIds).toEqual(['p1', 'p2', 'p3']);
    expect(applySelectionClick(['p4'], order, 'p4', 'p2', shift).pageIds).toEqual(['p2', 'p3', 'p4']);
  });

  it('Shift keeps the existing anchor, so repeated Shift clicks extend from the same place', () => {
    const first = applySelectionClick([], order, 'p1', 'p2', shift);
    expect(first).toEqual({ pageIds: ['p1', 'p2'], anchorId: 'p1' });
    expect(applySelectionClick(first.pageIds, order, first.anchorId, 'p4', shift).pageIds).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
  });

  it('Shift without an anchor starts the range at the clicked page', () => {
    expect(applySelectionClick([], order, null, 'p5', shift)).toEqual({ pageIds: ['p5'], anchorId: 'p5' });
  });

  it('ignores ids that are not in the page order', () => {
    expect(applySelectionClick(['p0'], order, 'p0', 'gone', plain)).toEqual({ pageIds: ['p0'], anchorId: 'p0' });
  });
});

describe('selectAllIds (Ctrl+A in the thumbnails panel)', () => {
  it('selects every page in list order, anchored at the first', () => {
    expect(selectAllIds(['p1', 'p2', 'p3'])).toEqual({ pageIds: ['p1', 'p2', 'p3'], anchorId: 'p1' });
  });

  it('selects nothing for an empty list', () => {
    expect(selectAllIds([])).toEqual({ pageIds: [], anchorId: null });
  });
});
