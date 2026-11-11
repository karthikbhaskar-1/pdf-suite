// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  blockOf,
  buildCombineSpec,
  hasRange,
  moveBefore,
  moveRows,
  noticesFor,
  pagesOfRow,
  rangeTextOf,
  sortByName,
  togglePage,
  totals,
  type CombineRow,
} from './combinePlan';

const row = (name: string, extra: Partial<CombineRow> = {}): CombineRow => ({
  id: name,
  path: `C:\\in\\${name}`,
  name,
  size: 1000,
  modified: 1,
  kind: 'pdf',
  status: 'ready',
  pages: 10,
  rangeText: '',
  facts: { encrypted: false, fields: 0, layers: false, attachments: 0, unprintable: 0 },
  ...extra,
});
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id).join(',');

describe('sort by name', () => {
  it('A to Z with numbers in number order, ignoring case', () => {
    expect(ids(sortByName([row('file10.pdf'), row('File2.pdf'), row('b.pdf'), row('a.pdf'), row('file1.pdf')]))).toBe('a.pdf,b.pdf,file1.pdf,File2.pdf,file10.pdf');
  });
});

describe('moving rows', () => {
  const list = ['A', 'B', 'C', 'D', 'E'].map((n) => row(n));
  const set = (...n: string[]) => new Set(n);
  it('up and down by one, and stop at the ends', () => {
    expect(ids(moveRows(list, set('C'), 'up').rows)).toBe('A,C,B,D,E');
    expect(ids(moveRows(list, set('C'), 'down').rows)).toBe('A,B,D,C,E');
    expect(ids(moveRows(list, set('A'), 'up').rows)).toBe('A,B,C,D,E');
    expect(ids(moveRows(list, set('E'), 'down').rows)).toBe('A,B,C,D,E');
  });
  it('first and last', () => {
    expect(ids(moveRows(list, set('D'), 'first').rows)).toBe('D,A,B,C,E');
    expect(ids(moveRows(list, set('B'), 'last').rows)).toBe('A,C,D,E,B');
  });
  it('a selection moves as a block in its own order, and reports where it landed', () => {
    const moved = moveRows(list, set('B', 'D'), 'down');
    expect(ids(moved.rows)).toBe('A,C,E,B,D');
    expect(moved.index).toBe(3);
    expect(ids(moveRows(list, set('B', 'D'), 'up').rows)).toBe('B,D,A,C,E');
  });
  it('dragging drops before the row it is dropped on, or at the end', () => {
    expect(ids(moveBefore(list, set('A'), 3))).toBe('B,C,A,D,E');
    expect(ids(moveBefore(list, set('E'), 1))).toBe('A,E,B,C,D');
    expect(ids(moveBefore(list, set('B'), 5))).toBe('A,C,D,E,B');
    expect(ids(moveBefore(list, set('B', 'C'), 0))).toBe('B,C,A,D,E');
  });
});

describe('page ranges', () => {
  it('empty means all pages; a range is parsed with the existing messages', () => {
    expect(pagesOfRow(row('a.pdf'))).toEqual({ ok: true, pages: null, count: 10 });
    expect(pagesOfRow(row('a.pdf', { rangeText: '1-3, 8' }))).toEqual({ ok: true, pages: [1, 2, 3, 8], count: 4 });
    expect(pagesOfRow(row('a.pdf', { rangeText: '12' }))).toEqual({ ok: false, message: '12 is outside 1-10.' });
    expect(pagesOfRow(row('a.pdf', { rangeText: 'x' }))).toEqual({ ok: false, message: '"x" is not a page or a page range.' });
  });
  it('only PDFs and pictures with more than one page have a Pages field', () => {
    expect(hasRange(row('a.pdf'))).toBe(true);
    expect(hasRange(row('a.tif', { kind: 'image', pages: 6 }))).toBe(true);
    expect(hasRange(row('a.png', { kind: 'image', pages: 1 }))).toBe(false);
    expect(hasRange(row('a.txt', { kind: 'text', pages: 3 }))).toBe(false);
    expect(pagesOfRow(row('a.txt', { kind: 'text', pages: 3, rangeText: '1' })).ok && pagesOfRow(row('a.txt', { kind: 'text', pages: 3, rangeText: '1' }))).toMatchObject({ count: 3 });
  });
  it('writes a set of pages as the shortest range text', () => {
    expect(rangeTextOf(new Set([1, 2, 3, 5, 7, 8]), 10)).toBe('1-3, 5, 7-8');
    expect(rangeTextOf(new Set([1, 2, 3, 4]), 4)).toBe('');
  });
  it('clicking a preview page leaves it out or puts it back, and rewrites the field', () => {
    const r = row('a.pdf', { pages: 8 });
    const left = togglePage(r, 7)!;
    expect(left).toBe('1-6, 8');
    const again = togglePage({ ...r, rangeText: left }, 7);
    expect(again).toBe('');
    expect(togglePage({ ...r, rangeText: '3' }, 3)).toBeNull();
  });
});

describe('totals, notices and what blocks Combine', () => {
  it('counts files, pages by range, and bytes', () => {
    expect(totals([row('a.pdf', { rangeText: '1-3' }), row('b.pdf')])).toEqual({ files: 2, pages: 13, bytes: 2000 });
  });
  it('the blocks: empty, still reading, a wrong range, over 500 MB, and none', () => {
    expect(blockOf([])).toBe('empty');
    expect(blockOf([row('a.pdf', { status: 'reading', pages: 0 })])).toBe('reading');
    expect(blockOf([row('a.pdf', { rangeText: '99' })])).toBe('range');
    expect(blockOf([row('a.pdf', { size: 600 * 1024 * 1024 })])).toBe('too-large');
    expect(blockOf([row('a.pdf')])).toBeNull();
  });
  it('the limit is the edit constant, by total size: 500 MB is allowed, one byte more is not, and the total counts every file', () => {
    const MB = 1024 * 1024;
    expect(blockOf([row('a.pdf', { size: 500 * MB })])).toBeNull();
    expect(blockOf([row('a.pdf', { size: 500 * MB + 1 })])).toBe('too-large');
    expect(blockOf([row('a.pdf', { size: 300 * MB }), row('b.pdf', { size: 200 * MB })])).toBeNull();
    expect(blockOf([row('a.pdf', { size: 300 * MB }), row('b.pdf', { size: 200 * MB + 1 })])).toBe('too-large');
  });
  it('each notice names the right files, once each', () => {
    const facts = (extra: Partial<NonNullable<CombineRow['facts']>>) => ({ encrypted: false, fields: 0, layers: false, attachments: 0, unprintable: 0, ...extra });
    const notices = noticesFor([
      row('a.pdf', { facts: facts({ fields: 3 }) }),
      row('b.pdf', { facts: facts({ fields: 1, encrypted: true }) }),
      row('c.pdf', { facts: facts({ layers: true, attachments: 2 }) }),
      row('a.pdf', { id: 'again', facts: facts({ fields: 3 }) }),
      row('t.txt', { kind: 'text', facts: facts({ unprintable: 14 }) }),
      row('plain.pdf'),
    ]);
    expect(notices).toEqual([
      'Fillable forms in a.pdf, b.pdf: what is filled in stays visible, but the boxes can no longer be typed in, and signatures can no longer be checked. Your original files are not changed.',
      'The new file will not have a password, although b.pdf does.',
      'c.pdf has layers that can be shown and hidden. In the new file they become part of the page, and hidden ones become visible.',
      'Files attached inside c.pdf are not copied to the new file.',
      't.txt has 14 characters PDF Suite can\'t print yet (it prints Latin, Greek and Cyrillic letters). Each will appear as “?”. The text file itself is not changed.',
    ]);
  });
});

describe('the spec for the worker', () => {
  it('lists the files in order with ranges, counts and passwords, and the options', () => {
    const spec = buildCombineSpec(
      [row('b.pdf', { rangeText: '2-3', path: 'C:\\in\\b.pdf' }), row('s.png', { kind: 'image', pages: 1 }), row('t.txt', { kind: 'text', pages: 2 })],
      { fileBookmarks: false, pictureSize: 'Letter', textSize: 'A4' },
      'Out.pdf',
      new Map([['C:\\in\\b.pdf', 'pw']]),
    );
    expect(spec.items).toEqual([
      { kind: 'pdf', name: 'b.pdf', pages: [2, 3], count: 2, password: 'pw' },
      { kind: 'image', name: 's.png', count: 1 },
      { kind: 'text', name: 't.txt', count: 2 },
    ]);
    expect(spec).toMatchObject({ kind: 'combine', fileBookmarks: false, leafName: 'Out.pdf', imagePage: { width: 612, height: 792 }, textPage: { width: 595.28 } });
    expect(buildCombineSpec([row('a.pdf')], { fileBookmarks: true, pictureSize: 'image', textSize: 'Letter' }, 'x.pdf', new Map()).imagePage).toBe('image');
  });
});
