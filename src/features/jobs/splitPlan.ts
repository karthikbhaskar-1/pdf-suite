/**
 * Planning of Split into Files on the page (blueprint A2: "Count, blank and bookmark splits are planned on the page and sent as
 * `ranges`. Only `size` is planned in the worker"). Pure: no document, no worker. Page numbers are 1-based and inclusive.
 *
 * Every function returns the parts with their leaf names, or the validation message the UI spec gives.
 */
import { BLANK_PRESETS, blankPages, isBlankAt, type BlankMeasure, type BlankSensitivity } from '../../engine/mupdf/blankDetect';
import { MAX_JOB_FILES } from '../../engine/mupdf/jobProtocol';
import { bookmarkPartName, countPartName, numberWidth } from './nameRules';

export { BLANK_PRESETS, type BlankMeasure, type BlankSensitivity };

export interface PlannedPart {
  from: number;
  to: number;
  leafName: string;
}

export type Planned<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
const formatCount = (n: number) => n.toLocaleString('en-US');

export const NO_BOOKMARKS_MESSAGE = 'This document has no bookmarks to split by.';
export const NO_BLANKS_MESSAGE = 'No blank pages were found. Try “Blank and nearly blank pages”, or split another way.';
export const ONE_PAGE_MESSAGE = 'This document has only one page, so there is nothing to split.';

/** The pages-per-file box: a whole number from 1 to pages - 1, and not more than 2,000 files. */
export function parsePagesPerFile(text: string, pages: number): Planned<number> {
  if (pages < 2) return fail(ONE_PAGE_MESSAGE);
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return fail(`Enter a whole number from 1 to ${pages - 1}.`);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > pages - 1) return fail(`Enter a whole number from 1 to ${pages - 1}.`);
  const files = Math.ceil(pages / n);
  if (files > MAX_JOB_FILES) return fail(`This would make ${formatCount(files)} files; the most at once is ${formatCount(MAX_JOB_FILES)}. Put more pages in each file.`);
  return { ok: true, value: n };
}

/** N pages in each part; the last part holds what is left. */
export function planByCount(pages: number, perFile: number, baseName: string): PlannedPart[] {
  const count = Math.ceil(pages / perFile);
  const width = numberWidth(count);
  const parts: PlannedPart[] = [];
  for (let i = 0; i < count; i++) {
    const from = i * perFile + 1;
    parts.push({ from, to: Math.min(pages, from + perFile - 1), leafName: countPartName(baseName, i + 1, width) });
  }
  return parts;
}

/**
 * Blank-page separators. `measures` are each page's ink share and largest mark (one analysis), `sensitivity` picks the preset and `unticked` holds the
 * 0-based pages the user took off the list. A run of blank pages is one separator. `keep` 'drop' leaves the blank pages out;
 * 'keepWithPrevious' puts them at the end of the part before (blank pages at the very start go to the first part, so no page is
 * lost). No empty parts. Returns the blank pages found (0-based) with the parts.
 */
export function planByBlank(
  ink: readonly BlankMeasure[],
  sensitivity: BlankSensitivity,
  unticked: ReadonlySet<number>,
  keep: 'drop' | 'keepWithPrevious',
  baseName: string,
): { blanks: number[]; marked: number[]; parts: PlannedPart[] } {
  const blanks = blankPages(ink, sensitivity);
  // The pages that are blank only at the wider preset: they hold something (a page number, a short line, a streak).
  const marked = blanks.filter((b) => !isBlankAt(ink[b]!, 'normal'));
  const separators = new Set(blanks.filter((b) => !unticked.has(b)));
  const runs: Array<{ from: number; to: number }> = [];
  let start = -1;
  for (let i = 0; i < ink.length; i++) {
    if (!separators.has(i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push({ from: start, to: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ from: start, to: ink.length - 1 });
  const width = numberWidth(runs.length);
  const parts: PlannedPart[] = runs.map((run, i) => {
    let from = run.from;
    let to = run.to;
    if (keep === 'keepWithPrevious') {
      // The blank pages after the run belong to it; the ones before the first run go to the first part.
      if (i === 0) from = 0;
      const next = runs[i + 1];
      to = next ? next.from - 1 : ink.length - 1;
    }
    return { from: from + 1, to: to + 1, leafName: countPartName(baseName, i + 1, width) };
  });
  return { blanks, marked, parts };
}

/**
 * Bookmarks. The boundaries are the distinct target pages of the top-level bookmarks, sorted; two bookmarks on one page give
 * one part named after the first (in document order). Pages before the first boundary form a part called "Start".
 */
export function planByBookmarks(entries: ReadonlyArray<{ title: string; page: number }>, pages: number, baseName: string): Planned<PlannedPart[]> {
  const valid = entries.filter((e) => e.page >= 1 && e.page <= pages);
  if (valid.length === 0) return fail(NO_BOOKMARKS_MESSAGE);
  const firstTitle = new Map<number, string>();
  for (const entry of valid) if (!firstTitle.has(entry.page)) firstTitle.set(entry.page, entry.title);
  const starts = [...firstTitle.keys()].sort((a, b) => a - b);
  const bounds: Array<{ from: number; title: string }> = [];
  if (starts[0]! > 1) bounds.push({ from: 1, title: 'Start' });
  for (const page of starts) bounds.push({ from: page, title: firstTitle.get(page)! });
  if (bounds.length > MAX_JOB_FILES) {
    return fail(`This would make ${formatCount(bounds.length)} files; the most at once is ${formatCount(MAX_JOB_FILES)}.`);
  }
  const width = numberWidth(bounds.length);
  return {
    ok: true,
    value: bounds.map((b, i) => ({
      from: b.from,
      to: (bounds[i + 1]?.from ?? pages + 1) - 1,
      leafName: bookmarkPartName(baseName, i + 1, width, b.title),
    })),
  };
}

// ---- Size ------------------------------------------------------------------------------------------------------------------

export type SizeUnit = 'MB' | 'KB';
/** The smallest limit the sheet accepts: 100 KB. */
export const MIN_SIZE_BYTES = 100 * 1024;
export const SIZE_MESSAGE = 'Enter a size of at least 100 KB.';

/** The largest-file box: a number and a unit. Returns bytes. */
export function parseSizeLimit(text: string, unit: SizeUnit, sourceBytes: number): Planned<number> {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return fail(SIZE_MESSAGE);
  const value = Number(trimmed);
  const bytes = Math.floor(value * (unit === 'MB' ? 1024 * 1024 : 1024));
  if (!Number.isFinite(bytes) || bytes < MIN_SIZE_BYTES) return fail(SIZE_MESSAGE);
  if (sourceBytes <= bytes) return fail(`This document is already smaller than ${text.trim()} ${unit}, so there is nothing to split.`);
  return { ok: true, value: bytes };
}

/**
 * The digits of "part 01" for a size split, which cannot know its part count in advance: enough for twice the number of parts
 * the sizes suggest, and never more than the page count.
 */
export function sizeNameWidth(pages: number, sourceBytes: number, maxBytes: number): number {
  const guess = Math.ceil((2 * sourceBytes) / maxBytes) + 2;
  return numberWidth(Math.min(pages, guess));
}

/** The example of a size split: its first name and the shape of the last. */
export function sizeExample(baseName: string, width: number): string {
  return countPartName(baseName, 1, width);
}
