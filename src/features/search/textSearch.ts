import type { TextRun } from '../../engine/types';

/** A rectangle in PDF points, in the page's displayed orientation. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

/** One match on a page: a character range of the page text, and the rectangles that cover it. */
export interface TextMatch {
  start: number;
  end: number;
  rects: Rect[];
}

interface Span {
  start: number;
  end: number;
  run: TextRun;
}

/** A page's text joined into one string, with the character range each run occupies. */
export interface PageTextIndex {
  text: string;
  spans: Span[];
}

/**
 * Joins the runs of one page into a single string. A space separates runs, so words that
 * meet across two runs still break correctly, and a query can span run boundaries.
 */
export function indexRuns(runs: readonly TextRun[]): PageTextIndex {
  let text = '';
  const spans: Span[] = [];
  runs.forEach((run, i) => {
    if (i > 0) text += ' ';
    const start = text.length;
    text += run.text;
    spans.push({ start, end: text.length, run });
  });
  return { text, spans };
}

const WORD_CHAR = '[\\p{L}\\p{N}_]';

/**
 * Letter-spaced text: three or more single letters, each followed by one space, such as "z e p h y r".
 * Some PDFs space every letter, so their words only exist once those spaces are removed.
 */
const LETTER_SPACED = /(?<![\p{L}\p{N}])\p{L}(?: \p{L}){2,}(?![\p{L}\p{N}])/gu;

/**
 * The text with the spaces removed inside each letter-spaced run, and for each character of that text the
 * index of the character it came from. Matching runs on this text finds letter-spaced words.
 */
export function collapseLetterSpacing(text: string): { text: string; origins: number[] } {
  const origins: number[] = [];
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(LETTER_SPACED)) {
    const start = match.index ?? 0;
    for (; cursor < start; cursor++) {
      out += text.charAt(cursor);
      origins.push(cursor);
    }
    for (let i = 0; i < match[0].length; i++) {
      const ch = match[0].charAt(i);
      if (ch === ' ') continue;
      out += ch;
      origins.push(start + i);
    }
    cursor = start + match[0].length;
  }
  for (; cursor < text.length; cursor++) {
    out += text.charAt(cursor);
    origins.push(cursor);
  }
  return { text: out, origins };
}

/**
 * Positions of `query` in `text`, as indexes into `text`. The query is a literal string.
 */
function matchPositions(text: string, query: string, options: SearchOptions): Array<{ start: number; end: number }> {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = options.wholeWord ? `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})` : escaped;
  const pattern = new RegExp(body, options.matchCase ? 'gu' : 'giu');
  const found: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || match[0].length === 0) continue;
    found.push({ start: match.index, end: match.index + match[0].length });
  }
  return found;
}

/**
 * Finds every non-overlapping occurrence of `query` in `text`. Case-insensitive unless
 * `matchCase`. With `wholeWord`, the match must not touch a letter, digit or underscore.
 * Letter-spaced text matches too (see collapseLetterSpacing). Positions are in `text`.
 */
export function findMatches(text: string, query: string, options: SearchOptions): Array<{ start: number; end: number }> {
  if (query.length === 0) return [];
  // Pass 1: the query as typed, on the page's own text. A phrase the user can see and type ("B C" in "A B C D") is found here.
  const literal = matchPositions(text, query, options);
  // Pass 2: the letter-joined query on the letter-joined text, so "q w e r t" finds "qwert" and "ph" finds "z e p h y r".
  const normalized = collapseLetterSpacing(query).text;
  const { text: collapsed, origins } = collapseLetterSpacing(text);
  // Joining changes nothing: the second pass would only repeat the first.
  if (normalized.length === 0 || (normalized === query && collapsed === text)) return literal;
  const joined = matchPositions(collapsed, normalized, options).flatMap(({ start, end }) => {
    const first = origins[start];
    const last = origins[end - 1];
    return first === undefined || last === undefined ? [] : [{ start: first, end: last + 1 }];
  });
  // Merge: the literal hits come first and win; a joined hit that touches one of them is the same spot and is dropped.
  // Both lists are in order, so one walk over the literal hits is enough (not a rescan per hit).
  const merged = [...literal];
  let k = 0;
  for (const hit of joined) {
    while (k < literal.length && literal[k]!.end <= hit.start) k++;
    const l = literal[k];
    if (!(l && l.start < hit.end)) merged.push(hit);
  }
  return merged.sort((x, y) => x.start - y.start);
}

/**
 * The run's advance boxes. A lazy run measures them the first time a match needs them, and keeps them.
 * Runs that no match touches are never measured.
 */
export function boxesOf(run: TextRun): TextRun['charBoxes'] {
  if (!run.charBoxes && run.measureCharBoxes) {
    const measure = run.measureCharBoxes;
    run.measureCharBoxes = undefined;
    run.charBoxes = measure();
  }
  return run.charBoxes;
}

/** The box that covers the part of one run between distances d0 and d1 (points) from its origin. */
function boxForRun(run: TextRun, d0: number, d1: number): Rect {
  const length = Math.hypot(run.along.x, run.along.y);
  const points: Array<{ x: number; y: number }> = [];
  for (const f of [length > 0 ? d0 / length : 0, length > 0 ? d1 / length : 0]) {
    const x = run.origin.x + run.along.x * f;
    const y = run.origin.y + run.along.y * f;
    points.push({ x, y }, { x: x + run.up.x, y: y + run.up.y });
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Distances from the run origin (points) where the characters [from, to) of a run start and end.
 * Uses the run's advance boxes when it has them. Otherwise each character takes an equal share.
 */
function distancesFor(run: TextRun, from: number, to: number): [number, number] {
  const length = Math.hypot(run.along.x, run.along.y);
  // Packed boundaries: the two edges are read straight from the page's array, and no box object is built.
  const packed = run.bounds;
  if (packed && run.boundsAt !== undefined) {
    const n = run.text.length;
    const at = run.boundsAt;
    const start = from < n ? (packed[at + from] ?? 0) : length;
    const end = to > 0 ? (packed[at + to] ?? length) : 0;
    return [start, end];
  }
  const boxes = boxesOf(run);
  if (!boxes || boxes.length !== run.text.length) {
    const count = Math.max(1, run.text.length);
    return [(length * from) / count, (length * to) / count];
  }
  const start = from < boxes.length ? (boxes[from]?.start ?? 0) : length;
  const end = to > 0 ? (boxes[to - 1]?.end ?? length) : 0;
  return [start, end];
}

/**
 * Rectangles covering the character range [start, end) of the page text. A range that crosses
 * runs gets one rectangle per run. Inside a run the edges come from the run's advance boxes when
 * present, and otherwise each character is assumed to share the run's width equally.
 */
export function rectsForRange(index: PageTextIndex, start: number, end: number): Rect[] {
  const rects: Rect[] = [];
  for (const span of index.spans) {
    if (span.end <= start || span.start >= end) continue;
    if (span.end - span.start <= 0) continue;
    const from = Math.max(start, span.start) - span.start;
    const to = Math.min(end, span.end) - span.start;
    const [d0, d1] = distancesFor(span.run, from, to);
    rects.push(boxForRun(span.run, d0, d1));
  }
  return rects;
}

/** All matches of `query` on one page, with their rectangles. Matches with no visible text are dropped. */
export function searchRuns(
  runs: readonly TextRun[],
  query: string,
  options: SearchOptions,
  found?: Array<{ start: number; end: number }>,
  indexed?: PageTextIndex,
): TextMatch[] {
  const index = indexed ?? indexRuns(runs);
  const matches: TextMatch[] = [];
  for (const { start, end } of found ?? findMatches(index.text, query, options)) {
    const rects = rectsForRange(index, start, end);
    if (rects.length > 0) matches.push({ start, end, rects });
  }
  return matches;
}
