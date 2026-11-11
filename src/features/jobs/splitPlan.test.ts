// 1.3.2: planning and naming of Split into Files (pure), and the sheet model that the UI draws and sends.
import { describe, expect, it } from 'vitest';
import {
  BAD_NAME_MESSAGE,
  EMPTY_NAME_MESSAGE,
  bookmarkPartName,
  cleanSegment,
  countPartName,
  defaultBaseName,
  exampleLine,
  numberWidth,
  titleForName,
  validateBaseName,
} from './nameRules';
import {
  NO_BLANKS_MESSAGE,
  NO_BOOKMARKS_MESSAGE,
  ONE_PAGE_MESSAGE,
  parsePagesPerFile,
  parseSizeLimit,
  planByBlank,
  planByBookmarks,
  planByCount,
  sizeNameWidth,
} from './splitPlan';
import { deriveSheet, type SplitSettings } from './splitSheetModel';
import { isValidLeafName } from '../../platform/desktop/contract';

describe('nameRules', () => {
  it('the number is at least 2 digits and wide enough for the part count', () => {
    expect(numberWidth(1)).toBe(2);
    expect(numberWidth(12)).toBe(2);
    expect(numberWidth(99)).toBe(2);
    expect(numberWidth(100)).toBe(3);
    expect(numberWidth(2000)).toBe(4);
    expect(countPartName('Report', 5, 2)).toBe('Report - part 05.pdf');
    expect(countPartName('Report', 5, 3)).toBe('Report - part 005.pdf');
    expect(bookmarkPartName('Report', 1, 2, 'Introduction')).toBe('Report - 01 Introduction.pdf');
  });

  it('a bookmark title is cleaned to the leaf-name rule and cut to 80 characters; an empty one is Untitled', () => {
    expect(titleForName('A/B: C?')).toBe('A-B- C-');
    expect(titleForName('   ')).toBe('Untitled');
    expect(titleForName('...')).toBe('Untitled');
    expect(titleForName('x'.repeat(200))).toHaveLength(80);
    expect(titleForName('Chapter 1.  ')).toBe('Chapter 1');
    expect(cleanSegment('a\tb\nc', 80)).toBe('a b c');
    // Every produced name passes the rule main applies.
    for (const title of ['CON', 'a|b', 'tail. ', '\u0001ctl', 'x'.repeat(300), 'Résumé ☃']) {
      expect(isValidLeafName(bookmarkPartName('Doc', 3, 2, title)), title).toBe(true);
    }
  });

  it('the default name is the source name without .pdf, cleaned', () => {
    expect(defaultBaseName('Report.pdf')).toBe('Report');
    expect(defaultBaseName('a.b.PDF')).toBe('a.b');
    expect(defaultBaseName('.pdf')).toBe('Document');
  });

  it('validates the name the user types with the spec messages', () => {
    expect(validateBaseName('')).toBe(EMPTY_NAME_MESSAGE);
    expect(validateBaseName('   ')).toBe(EMPTY_NAME_MESSAGE);
    expect(EMPTY_NAME_MESSAGE).toBe('Enter a name for the new files.');
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) expect(validateBaseName(bad), bad).toBe(BAD_NAME_MESSAGE);
    expect(BAD_NAME_MESSAGE).toBe('A file name can\'t contain \\ / : * ? " < > |');
    expect(validateBaseName('Report 2024 - final')).toBeNull();
  });

  it('the example shows the first and last name', () => {
    expect(exampleLine(['A - part 01.pdf'])).toBe('A - part 01.pdf');
    expect(exampleLine(['A - part 01.pdf', 'A - part 02.pdf', 'A - part 12.pdf'])).toBe('A - part 01.pdf … A - part 12.pdf');
  });
});

describe('split by page count', () => {
  it('validates with the spec messages', () => {
    expect(parsePagesPerFile('10', 120)).toEqual({ ok: true, value: 10 });
    expect(parsePagesPerFile('0', 120)).toEqual({ ok: false, message: 'Enter a whole number from 1 to 119.' });
    expect(parsePagesPerFile('120', 120)).toEqual({ ok: false, message: 'Enter a whole number from 1 to 119.' });
    expect(parsePagesPerFile('1.5', 120)).toEqual({ ok: false, message: 'Enter a whole number from 1 to 119.' });
    expect(parsePagesPerFile('abc', 120)).toEqual({ ok: false, message: 'Enter a whole number from 1 to 119.' });
    expect(parsePagesPerFile('', 120)).toEqual({ ok: false, message: 'Enter a whole number from 1 to 119.' });
    expect(parsePagesPerFile('1', 1)).toEqual({ ok: false, message: ONE_PAGE_MESSAGE });
    expect(parsePagesPerFile('1', 2400)).toEqual({ ok: false, message: 'This would make 2,400 files; the most at once is 2,000. Put more pages in each file.' });
    expect(parsePagesPerFile('2', 4000)).toEqual({ ok: true, value: 2 });
  });

  it('makes parts of N pages and a shorter last one, named part 01 ...', () => {
    const parts = planByCount(25, 10, 'Doc');
    expect(parts).toEqual([
      { from: 1, to: 10, leafName: 'Doc - part 01.pdf' },
      { from: 11, to: 20, leafName: 'Doc - part 02.pdf' },
      { from: 21, to: 25, leafName: 'Doc - part 03.pdf' },
    ]);
    // Every page is in exactly one part.
    expect(parts.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_u, i) => p.from + i))).toEqual(Array.from({ length: 25 }, (_u, i) => i + 1));
    const wide = planByCount(250, 2, 'Doc');
    expect(wide).toHaveLength(125);
    expect(wide[0]!.leafName).toBe('Doc - part 001.pdf');
  });
});

describe('split by blank pages', () => {
  // 10 pages; 0-based pages 3 and 4 are blank (one run), page 9 is blank (the last), page 7 has a small mark (a page number):
  // blank only at "Blank and nearly blank pages".
  const content = { ink: 0.1, mark: 500 };
  const ink = [content, content, content, { ink: 0, mark: 0 }, { ink: 0, mark: 0 }, content, content, { ink: 0.0003, mark: 14 }, content, { ink: 0.0001, mark: 3 }];
  const clean = (...flags: number[]) => flags.map((v) => (v === 0 ? { ink: 0, mark: 0 } : content));

  it('a run of blanks is one separator; the blanks are left out; no empty parts', () => {
    const normal = planByBlank(ink, 'normal', new Set(), 'drop', 'D');
    expect(normal.blanks).toEqual([3, 4, 9]);
    expect(normal.marked).toEqual([]);
    expect(normal.parts.map((p) => [p.from, p.to])).toEqual([[1, 3], [6, 9]]);
    const loose = planByBlank(ink, 'loose', new Set(), 'drop', 'D');
    expect(loose.blanks).toEqual([3, 4, 7, 9]);
    // The page with the small mark is the one that "has marks".
    expect(loose.marked).toEqual([7]);
    expect(loose.parts.map((p) => [p.from, p.to])).toEqual([[1, 3], [6, 7], [9, 9]]);
  });

  it('unticking a blank page keeps it as content, and the result changes', () => {
    const base = planByBlank(ink, 'loose', new Set(), 'drop', 'D').parts;
    const unticked = planByBlank(ink, 'loose', new Set([7]), 'drop', 'D').parts;
    expect(unticked.map((p) => [p.from, p.to])).toEqual([[1, 3], [6, 9]]);
    expect(unticked).not.toEqual(base);
  });

  it('keep puts the blank pages at the end of the file before; leading blanks go to the first part; nothing is lost', () => {
    const kept = planByBlank(ink, 'loose', new Set(), 'keepWithPrevious', 'D').parts;
    expect(kept.map((p) => [p.from, p.to])).toEqual([[1, 5], [6, 8], [9, 10]]);
    const leading = planByBlank(clean(0, 1, 1, 0, 1), 'normal', new Set(), 'keepWithPrevious', 'D').parts;
    expect(leading.map((p) => [p.from, p.to])).toEqual([[1, 4], [5, 5]]);
    const all = [...kept, ...leading.slice(0, 0)].flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_u, i) => p.from + i));
    expect(all).toEqual(Array.from({ length: 10 }, (_u, i) => i + 1));
  });

  it('a document of blank pages only has no parts', () => {
    expect(planByBlank(clean(0, 0, 0), 'normal', new Set(), 'drop', 'D').parts).toEqual([]);
  });
});

describe('split by bookmarks', () => {
  it('boundaries are the distinct target pages, sorted; two bookmarks on one page give one part named after the first; pages before the first form "Start"', () => {
    const planned = planByBookmarks(
      [
        { title: 'Two', page: 5 },
        { title: 'One', page: 3 },
        { title: 'Also page five', page: 5 },
        { title: 'Three', page: 9 },
      ],
      12,
      'Doc',
    );
    expect(planned).toEqual({
      ok: true,
      value: [
        { from: 1, to: 2, leafName: 'Doc - 01 Start.pdf' },
        { from: 3, to: 4, leafName: 'Doc - 02 One.pdf' },
        { from: 5, to: 8, leafName: 'Doc - 03 Two.pdf' },
        { from: 9, to: 12, leafName: 'Doc - 04 Three.pdf' },
      ],
    });
  });

  it('a first bookmark on page 1 has no Start part; no bookmarks says so', () => {
    const planned = planByBookmarks([{ title: 'A', page: 1 }, { title: 'B', page: 3 }], 4, 'D');
    expect(planned.ok && planned.value.map((p) => p.leafName)).toEqual(['D - 01 A.pdf', 'D - 02 B.pdf']);
    expect(planByBookmarks([], 4, 'D')).toEqual({ ok: false, message: NO_BOOKMARKS_MESSAGE });
    expect(NO_BOOKMARKS_MESSAGE).toBe('This document has no bookmarks to split by.');
  });
});

describe('split by size', () => {
  it('validates the limit', () => {
    const big = 48 * 1024 * 1024;
    expect(parseSizeLimit('10', 'MB', big)).toEqual({ ok: true, value: 10 * 1024 * 1024 });
    expect(parseSizeLimit('512', 'KB', big)).toEqual({ ok: true, value: 512 * 1024 });
    expect(parseSizeLimit('99', 'KB', big)).toEqual({ ok: false, message: 'Enter a size of at least 100 KB.' });
    expect(parseSizeLimit('abc', 'MB', big)).toEqual({ ok: false, message: 'Enter a size of at least 100 KB.' });
    expect(parseSizeLimit('0.05', 'MB', big)).toEqual({ ok: false, message: 'Enter a size of at least 100 KB.' });
    expect(parseSizeLimit('100', 'MB', big)).toEqual({ ok: false, message: 'This document is already smaller than 100 MB, so there is nothing to split.' });
  });

  it('the part number is wide enough for twice the parts the sizes suggest, never more than the pages', () => {
    expect(sizeNameWidth(120, 48 * 1024 * 1024, 10 * 1024 * 1024)).toBe(2);
    expect(sizeNameWidth(5000, 900 * 1024 * 1024, 1024 * 1024)).toBe(4);
    expect(sizeNameWidth(30, 900 * 1024 * 1024, 1024 * 1024)).toBe(2);
  });
});

describe('the sheet model', () => {
  const content = { ink: 0.1, mark: 500 };
  const clean = (...flags: number[]) => flags.map((v) => (v === 0 ? { ink: 0, mark: 0 } : content));
  const base: SplitSettings = {
    method: 'count',
    pages: 120,
    byteLength: 48 * 1024 * 1024,
    perFileText: '10',
    sizeText: '10',
    sizeUnit: 'MB',
    sensitivity: 'normal',
    measures: null,
    unticked: [],
    blankKeep: 'drop',
    entries: null,
    baseName: 'Report',
    hasFolder: true,
    encrypted: false,
    keepPassword: false,
  };

  it('count: example, summary and spec; Split needs a folder and a valid name', () => {
    const model = deriveSheet(base);
    expect(model.example).toBe('Report - part 01.pdf … Report - part 12.pdf');
    expect(model.summary).toBe('Makes 12 files.');
    expect(model.spec).toMatchObject({ kind: 'split', baseName: 'Report', plan: { by: 'ranges' } });
    expect(model.canSplit).toBe(true);
    expect(deriveSheet({ ...base, hasFolder: false }).canSplit).toBe(false);
    expect(deriveSheet({ ...base, baseName: 'a/b' }).canSplit).toBe(false);
    expect(deriveSheet({ ...base, perFileText: '0' })).toMatchObject({ canSplit: false, error: 'Enter a whole number from 1 to 119.' });
  });

  it('size: the summary names the limit and the spec is a size plan', () => {
    const model = deriveSheet({ ...base, method: 'size' });
    expect(model.summary).toBe('Each file will be 10 MB or smaller. The number of files depends on the pages.');
    expect(model.spec).toMatchObject({ plan: { by: 'size', maxBytes: 10 * 1024 * 1024 }, nameWidth: 2 });
    expect(model.example).toBe('Report - part 01.pdf');
    expect(deriveSheet({ ...base, method: 'size', sizeText: '60' }).error).toBe('This document is already smaller than 60 MB, so there is nothing to split.');
  });

  it('blank: no list until the search is done; none found says so; found pages make parts', () => {
    expect(deriveSheet({ ...base, method: 'blank' }).canSplit).toBe(false);
    const none = deriveSheet({ ...base, method: 'blank', pages: 3, measures: clean(1, 1, 1) });
    expect(none.error).toBe(NO_BLANKS_MESSAGE);
    expect(NO_BLANKS_MESSAGE).toBe('No blank pages were found. Try “Blank and nearly blank pages”, or split another way.');
    const found = deriveSheet({ ...base, method: 'blank', pages: 5, measures: clean(1, 0, 1, 0, 1) });
    expect(found.blanks).toEqual([1, 3]);
    // The safety net: the summary says how many pages will not be in any file.
    expect(found.summary).toBe('Makes 3 files. 2 pages will be left out.');
    expect(deriveSheet({ ...base, method: 'blank', pages: 5, measures: clean(1, 0, 1, 1, 1) }).summary).toBe('Makes 2 files. 1 page will be left out.');
    // Kept with the file before: nothing is left out.
    expect(deriveSheet({ ...base, method: 'blank', pages: 5, measures: clean(1, 0, 1, 0, 1), blankKeep: 'keepWithPrevious' }).summary).toBe('Makes 3 files.');
    expect(found.canSplit).toBe(true);
    // Changing the sensitivity changes the list without a new search.
    const nearly = [content, { ink: 0.004, mark: 300 }, content];
    expect(deriveSheet({ ...base, method: 'blank', pages: 3, measures: nearly, sensitivity: 'loose' })).toMatchObject({ blanks: [1], marked: [1] });
    expect(deriveSheet({ ...base, method: 'blank', pages: 3, measures: nearly, sensitivity: 'normal' }).blanks).toEqual([]);
  });

  it('bookmarks: example uses the first title; none gives the spec message', () => {
    expect(deriveSheet({ ...base, method: 'bookmarks', entries: [] }).error).toBe('This document has no bookmarks to split by.');
    const model = deriveSheet({ ...base, method: 'bookmarks', entries: [{ title: 'Introduction', page: 1 }, { title: 'End', page: 90 }] });
    expect(model.example).toBe('Report - 01 Introduction.pdf … Report - 02 End.pdf');
  });

  it('a locked file: kept by default; unticking the box sends dropEncryption', () => {
    expect(deriveSheet({ ...base, encrypted: true, keepPassword: true }).spec).not.toHaveProperty('dropEncryption');
    expect(deriveSheet({ ...base, encrypted: true, keepPassword: false }).spec).toMatchObject({ dropEncryption: true });
  });
});
