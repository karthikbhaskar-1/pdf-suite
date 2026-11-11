import { describe, expect, it } from 'vitest';
import {
  createPageList,
  indexOfPage,
  movePage,
  pageIdFor,
  pageIdForUid,
  pageListFromPages,
  rekeyPageId,
  removePage,
  rotatePage,
} from './pageList';

const DOC = 'a'.repeat(64);

describe('PageList', () => {
  it('creates one ref per source page, in order, with stable ids', () => {
    const list = createPageList(DOC, 3);
    expect(list.map((p) => p.srcIndex)).toEqual([0, 1, 2]);
    expect(list[1]?.id).toBe(pageIdFor(DOC, 1));
    expect(new Set(list.map((p) => p.id)).size).toBe(3);
    expect(list[0]).toMatchObject({ docId: DOC, rotation: 0, crop: null });
  });

  it('finds pages by id and returns -1 for unknown ids', () => {
    const list = createPageList(DOC, 4);
    expect(indexOfPage(list, pageIdFor(DOC, 2))).toBe(2);
    expect(indexOfPage(list, 'missing')).toBe(-1);
  });

  it('rotates a page by 90 degrees and wraps at 360', () => {
    const list = createPageList(DOC, 2);
    const id = pageIdFor(DOC, 0);
    const once = rotatePage(list, id, 90);
    expect(once[0]?.rotation).toBe(90);
    expect(rotatePage(once, id, 270)[0]?.rotation).toBe(0);
    expect(rotatePage(list, id, -90)[0]?.rotation).toBe(270);
    // The original list is not modified.
    expect(list[0]?.rotation).toBe(0);
  });

  it('removes a page by id', () => {
    const list = createPageList(DOC, 3);
    const next = removePage(list, pageIdFor(DOC, 1));
    expect(next.map((p) => p.srcIndex)).toEqual([0, 2]);
  });

  it('moves a page and ignores out-of-range moves', () => {
    const list = createPageList(DOC, 4);
    expect(movePage(list, 0, 2).map((p) => p.srcIndex)).toEqual([1, 2, 0, 3]);
    expect(movePage(list, 3, 0).map((p) => p.srcIndex)).toEqual([3, 0, 1, 2]);
    expect(movePage(list, 1, 9)).toBe(list);
    expect(movePage(list, 2, 2)).toBe(list);
  });
});

describe('page ids across documents', () => {
  const A = 'path:C:\Docs\example\Documents\work\A.pdf';
  const B = 'path:C:\Docs\example\Documents\work\B.pdf';

  it('never collide for two documents whose ids share their first 16 characters', () => {
    expect(A.slice(0, 16)).toBe(B.slice(0, 16));
    const uids = ['0', '1', '2', '3'];
    const a = pageListFromPages(A, uids, [0, 0, 0, 0]).map((p) => p.id);
    const b = pageListFromPages(B, uids, [0, 0, 0, 0]).map((p) => p.id);
    expect(new Set([...a, ...b]).size).toBe(8);
    expect(createPageList(A, 3).some((p) => createPageList(B, 3).some((q) => q.id === p.id))).toBe(false);
    expect(pageIdFor(A, 1)).not.toBe(pageIdFor(B, 1));
  });

  it('follows a document to its new id on Save As, and leaves other ids alone', () => {
    expect(rekeyPageId(A, B, pageIdForUid(A, '7'))).toBe(pageIdForUid(B, '7'));
    expect(rekeyPageId(A, B, pageIdForUid('path:C:\other.pdf', '7'))).toBe(pageIdForUid('path:C:\other.pdf', '7'));
  });
});
