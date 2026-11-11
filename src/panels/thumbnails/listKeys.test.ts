// The thumbnail list's key table (1.5.5 B1), on the pure key handler.
import { describe, expect, it } from 'vitest';
import { activeAfterDelete, applyListKey, revealScrollTop, type ListKeyState } from './selection';

const order = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
const none = { ctrl: false, shift: false, alt: false, meta: false };
const state = (over: Partial<ListKeyState> = {}): ListKeyState => ({
  order,
  selected: [],
  anchorId: null,
  activeId: 'p0',
  currentId: 'p0',
  pageRows: 3,
  ...over,
});

describe('applyListKey', () => {
  it('Down three times from page 1 selects page 4 alone and jumps to it', () => {
    let s = state();
    let last = applyListKey(s, 'ArrowDown', none);
    for (let i = 0; i < 2; i++) {
      s = state({ activeId: last.activeId, selected: last.pageIds, anchorId: last.anchorId });
      last = applyListKey(s, 'ArrowDown', none);
    }
    expect(last).toMatchObject({ activeId: 'p3', pageIds: ['p3'], anchorId: 'p3', jump: true, selectionChanged: true });
  });

  it('Shift+Down extends from the anchor and does not jump', () => {
    const r = applyListKey(state({ activeId: 'p3', selected: ['p3'], anchorId: 'p3' }), 'ArrowDown', { ...none, shift: true });
    expect(r).toMatchObject({ activeId: 'p4', pageIds: ['p3', 'p4'], anchorId: 'p3', jump: false });
  });

  it('Shift+Up shrinks the range again, and starts from the active row when there is no anchor', () => {
    const r = applyListKey(state({ activeId: 'p4', selected: ['p3', 'p4'], anchorId: 'p3' }), 'ArrowUp', { ...none, shift: true });
    expect(r.pageIds).toEqual(['p3']);
    const fresh = applyListKey(state({ activeId: 'p2' }), 'ArrowDown', { ...none, shift: true });
    expect(fresh.pageIds).toEqual(['p2', 'p3']);
  });

  it('Ctrl+Up and Ctrl+Down move the active row only', () => {
    const r = applyListKey(state({ activeId: 'p1', selected: ['p1'], anchorId: 'p1' }), 'ArrowDown', { ...none, ctrl: true });
    expect(r).toMatchObject({ activeId: 'p2', pageIds: ['p1'], anchorId: 'p1', selectionChanged: false, jump: false });
  });

  it('Space toggles the active row, as Ctrl+click does', () => {
    const on = applyListKey(state({ activeId: 'p2', selected: ['p0'], anchorId: 'p0' }), ' ', none);
    expect(on).toMatchObject({ pageIds: ['p0', 'p2'], anchorId: 'p2', jump: false });
    const off = applyListKey(state({ activeId: 'p2', selected: ['p0', 'p2'], anchorId: 'p2' }), ' ', none);
    expect(off.pageIds).toEqual(['p0']);
  });

  it('Enter jumps and changes nothing else', () => {
    const r = applyListKey(state({ activeId: 'p2', selected: ['p0'], anchorId: 'p0' }), 'Enter', none);
    expect(r).toMatchObject({ jump: true, selectionChanged: false, pageIds: ['p0'], activeId: 'p2' });
  });

  it('Home and End go to the first and last page; with Shift they extend', () => {
    expect(applyListKey(state({ activeId: 'p2' }), 'End', none)).toMatchObject({ activeId: 'p5', pageIds: ['p5'], jump: true });
    expect(applyListKey(state({ activeId: 'p2' }), 'Home', none)).toMatchObject({ activeId: 'p0', pageIds: ['p0'] });
    const extend = applyListKey(state({ activeId: 'p2', selected: ['p2'], anchorId: 'p2' }), 'End', { ...none, shift: true });
    expect(extend).toMatchObject({ activeId: 'p5', pageIds: ['p2', 'p3', 'p4', 'p5'], jump: false });
  });

  it('Page Up and Page Down move by the whole rows shown, at least one, and stop at the ends', () => {
    expect(applyListKey(state({ activeId: 'p1', pageRows: 3 }), 'PageDown', none).activeId).toBe('p4');
    expect(applyListKey(state({ activeId: 'p4', pageRows: 3 }), 'PageDown', none).activeId).toBe('p5');
    expect(applyListKey(state({ activeId: 'p4', pageRows: 0 }), 'PageUp', none).activeId).toBe('p3');
  });

  it('Shift+F10 and the Menu key open the menu; an unselected active row becomes the selection first', () => {
    const unselected = applyListKey(state({ activeId: 'p2', selected: ['p0', 'p1'], anchorId: 'p0' }), 'ContextMenu', none);
    expect(unselected).toMatchObject({ openMenu: true, pageIds: ['p2'], anchorId: 'p2' });
    const selected = applyListKey(state({ activeId: 'p1', selected: ['p0', 'p1'], anchorId: 'p0' }), 'F10', { ...none, shift: true });
    expect(selected).toMatchObject({ openMenu: true, pageIds: ['p0', 'p1'], selectionChanged: false });
    expect(applyListKey(state(), 'F10', none).handled).toBe(false);
  });

  it('Esc leaves the list and keeps the selection; Left and Right do nothing', () => {
    const esc = applyListKey(state({ selected: ['p0', 'p1'], anchorId: 'p0' }), 'Escape', none);
    expect(esc).toMatchObject({ leave: true, selectionChanged: false, pageIds: ['p0', 'p1'] });
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      expect(applyListKey(state({ selected: ['p1'] }), key, none)).toMatchObject({ handled: true, selectionChanged: false, jump: false, activeId: 'p0' });
    }
  });

  it('leaves Ctrl+A, Alt+arrows, Delete and Ctrl+D alone', () => {
    expect(applyListKey(state(), 'a', { ...none, ctrl: true }).handled).toBe(false);
    expect(applyListKey(state(), 'ArrowDown', { ...none, alt: true }).handled).toBe(false);
    expect(applyListKey(state(), 'Home', { ...none, alt: true }).handled).toBe(false);
    expect(applyListKey(state(), 'Delete', none).handled).toBe(false);
    expect(applyListKey(state(), 'd', { ...none, ctrl: true }).handled).toBe(false);
  });

  it('with no active row yet it starts from the current page, and drops stale ids', () => {
    const r = applyListKey(state({ activeId: null, currentId: 'p3', selected: ['other:1', 'p1'], anchorId: 'gone' }), 'ArrowDown', none);
    expect(r.activeId).toBe('p4');
    const keep = applyListKey(state({ activeId: 'stale', currentId: 'p3', selected: ['other:1', 'p1'], anchorId: 'gone' }), ' ', none);
    expect(keep.pageIds).toEqual(['p1', 'p3']);
    expect(keep.anchorId).toBe('p3');
  });

  it('never returns an id that is not in the list', () => {
    const r = applyListKey(state({ activeId: 'p5', selected: ['x:9', 'p5'], anchorId: 'x:9' }), 'ArrowUp', { ...none, shift: true });
    for (const id of [...r.pageIds, r.activeId, r.anchorId]) expect(id === null || order.includes(id)).toBe(true);
  });
});

describe('revealScrollTop', () => {
  it('leaves the list alone when the row is already whole in view', () => {
    expect(revealScrollTop(100, 300, 150, 100, 10, 2000)).toBe(100);
  });
  it('moves by the smallest distance, with a 10 px gap, in either direction', () => {
    expect(revealScrollTop(0, 300, 400, 100, 10, 2000)).toBe(210);
    expect(revealScrollTop(500, 300, 300, 100, 10, 2000)).toBe(290);
  });
  it('stays inside the list', () => {
    expect(revealScrollTop(0, 300, 0, 100, 10, 2000)).toBe(0);
    expect(revealScrollTop(1500, 300, 1950, 100, 10, 2000)).toBe(1700);
  });
});

describe('activeAfterDelete', () => {
  it('is the page now in the first deleted place', () => {
    expect(activeAfterDelete(order, ['p0', 'p1', 'p4', 'p5'])).toBe('p4');
  });
  it('is the last page when the deleted pages were at the end', () => {
    expect(activeAfterDelete(order, ['p0', 'p1'])).toBe('p1');
  });
  it('is null when nothing was deleted or nothing is left', () => {
    expect(activeAfterDelete(order, order)).toBeNull();
    expect(activeAfterDelete(order, [])).toBeNull();
  });
});
