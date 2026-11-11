import { describe, expect, it } from 'vitest';
import {
  beforeUidFor,
  clampRotation,
  cropBoxFor,
  cropScopeUids,
  deleteNeedsConfirm,
  dropSlot,
  insertAnchor,
  keyboardMove,
  moveCropHandle,
  pageIdFromUid,
  pageUidFromId,
  reorderedUids,
} from './pageMath';

const DOC = 'a1b2c3d4e5f6a7b8c9d0';
const ORDER = ['0', '1', '2', '3', '4', '5'];

describe('page ids and uids', () => {
  it('round-trips a uid through the page id, even when the document id contains colons', () => {
    const docId = 'path:C:\\docs\\a.pdf';
    const id = pageIdFromUid(docId, '7');
    expect(pageUidFromId(docId, id)).toBe('7');
    expect(pageUidFromId(docId, 'other:7')).toBeNull();
    expect(pageIdFromUid(DOC, '0')).toBe(`${DOC}:0`);
  });
});

describe('drag and drop slots', () => {
  const tops = [0, 100, 200];
  const heights = [100, 100, 100];

  it('drops before a row in its upper half and after it in its lower half', () => {
    expect(dropSlot(tops, heights, 10)).toBe(0);
    expect(dropSlot(tops, heights, 60)).toBe(1);
    expect(dropSlot(tops, heights, 160)).toBe(2);
    expect(dropSlot(tops, heights, 260)).toBe(3);
  });

  it('a drop inside the moving pages goes before the first page after them that is not moving', () => {
    expect(beforeUidFor(ORDER, new Set(['1', '2', '3']), 2)).toBe('4');
    expect(beforeUidFor(ORDER, new Set(['4', '5']), 4)).toBeNull();
    expect(beforeUidFor(ORDER, new Set(['0']), 0)).toBe('1');
  });

  it('reorders three selected pages as one block, keeping their order', () => {
    expect(reorderedUids(ORDER, ['1', '2', '3'], '5')).toEqual(['0', '4', '1', '2', '3', '5']);
    expect(reorderedUids(ORDER, ['1', '3'], null)).toEqual(['0', '2', '4', '5', '1', '3']);
  });

  it('a drop that leaves the order as it was gives the same order back', () => {
    expect(reorderedUids(ORDER, ['1', '2', '3'], '4')).toEqual(ORDER);
  });
});

describe('keyboard moves (Alt+Up, Alt+Down, Alt+Home, Alt+End)', () => {
  it('moves the selection one place up, placing it before the page above', () => {
    expect(keyboardMove(ORDER, new Set(['2']), 'up')).toEqual({ beforeUid: '1' });
    expect(keyboardMove(ORDER, new Set(['0']), 'up')).toBeNull();
  });

  it('moves the selection one place down, placing it after the page below', () => {
    expect(keyboardMove(ORDER, new Set(['2']), 'down')).toEqual({ beforeUid: '4' });
    expect(keyboardMove(ORDER, new Set(['4']), 'down')).toEqual({ beforeUid: null });
    expect(keyboardMove(ORDER, new Set(['5']), 'down')).toBeNull();
  });

  it('moves to the first and last page, and does nothing when already there', () => {
    expect(keyboardMove(ORDER, new Set(['3']), 'start')).toEqual({ beforeUid: '0' });
    expect(keyboardMove(ORDER, new Set(['0']), 'start')).toBeNull();
    expect(keyboardMove(ORDER, new Set(['3']), 'end')).toEqual({ beforeUid: null });
    expect(keyboardMove(ORDER, new Set(['5']), 'end')).toBeNull();
    expect(keyboardMove(ORDER, new Set(), 'end')).toBeNull();
  });
});

describe('insert position', () => {
  it('after the current page follows it; before follows the page above it; at a number starts there', () => {
    expect(insertAnchor(ORDER, 2, 'after', 0)).toBe('2');
    expect(insertAnchor(ORDER, 2, 'before', 0)).toBe('1');
    expect(insertAnchor(ORDER, 0, 'before', 0)).toBeNull();
    expect(insertAnchor(ORDER, 0, 'at', 1)).toBeNull();
    expect(insertAnchor(ORDER, 0, 'at', 4)).toBe('2');
    // A position past the end adds at the end of the document.
    expect(insertAnchor(ORDER, 0, 'at', 99)).toBe('5');
  });
});

describe('crop scopes', () => {
  it('applies to the current page, the selection (or the current page when none), all, odd or even pages', () => {
    expect(cropScopeUids(ORDER, 'current', '3', ['1', '2'])).toEqual(['3']);
    expect(cropScopeUids(ORDER, 'selected', '3', ['4', '1'])).toEqual(['1', '4']);
    expect(cropScopeUids(ORDER, 'selected', '3', [])).toEqual(['3']);
    expect(cropScopeUids(ORDER, 'all', '3', [])).toEqual(ORDER);
    // Odd and even count pages from 1: the first page is odd.
    expect(cropScopeUids(ORDER, 'odd', '0', [])).toEqual(['0', '2', '4']);
    expect(cropScopeUids(ORDER, 'even', '0', [])).toEqual(['1', '3', '5']);
  });
});

describe('crop boxes and handles', () => {
  it('turns margins into a box, and zero margins into no crop', () => {
    expect(cropBoxFor({ top: 0, bottom: 0, left: 0, right: 0 }, 612, 792)).toEqual({ ok: true, box: null });
    expect(cropBoxFor({ top: 36, bottom: 36, left: 18, right: 54 }, 612, 792)).toEqual({
      ok: true,
      box: { x: 18, y: 36, width: 540, height: 720 },
    });
  });

  it('refuses margins that leave too little of the page', () => {
    const result = cropBoxFor({ top: 400, bottom: 400, left: 0, right: 0 }, 612, 792);
    expect(result.ok).toBe(false);
  });

  it('a handle drag moves only its edges and never past the other edge', () => {
    const start = { top: 10, bottom: 10, left: 10, right: 10 };
    expect(moveCropHandle(start, 'w', 5, 0, 200, 200)).toEqual({ ...start, left: 15 });
    expect(moveCropHandle(start, 'se', 5, 5, 200, 200)).toEqual({ top: 10, left: 10, right: 5, bottom: 5 });
    // The left margin cannot push past the right margin.
    expect(moveCropHandle(start, 'w', 1000, 0, 200, 200).left).toBe(200 - 10 - 12);
    expect(moveCropHandle(start, 'n', 0, -1000, 200, 200).top).toBe(0);
  });
});

describe('deletes and rotation steps', () => {
  it('asks first when more than half of the pages would go', () => {
    expect(deleteNeedsConfirm(10, 5)).toBe(false);
    expect(deleteNeedsConfirm(10, 6)).toBe(true);
    expect(deleteNeedsConfirm(1, 1)).toBe(true);
  });

  it('rotation is clamped to plus or minus 45 degrees, in 0.1 degree steps', () => {
    expect(clampRotation(12.54)).toBe(12.5);
    expect(clampRotation(12.56)).toBe(12.6);
    expect(clampRotation(90)).toBe(45);
    expect(clampRotation(-90)).toBe(-45);
    expect(clampRotation(Number.NaN)).toBe(0);
  });
});
