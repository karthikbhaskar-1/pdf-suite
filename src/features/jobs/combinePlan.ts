/**
 * The list of Combine, as pure functions (UI spec section 1): sorting, moving, page ranges, totals, the notices before the run,
 * and the spec the worker gets. Nothing here touches a store, a file or the worker, so it is tested on its own.
 */
import type { CombineSpec, InputKind, PageDims } from '../../engine/mupdf/jobProtocol';
import { A4, LETTER } from '../../engine/mupdf/textLayout';
import { MAX_EDIT_BYTES } from '../../platform/desktop/contract';
import { parsePageRange } from '../organizer/pageRange';
import {
  combineAttachmentsNotice,
  combineFormsNotice,
  combineLayersNotice,
  combinePasswordNotice,
  combineTextNotice,
} from './jobMessages';

export const MAX_COMBINE_ITEMS = 500;
/** The inputs of one Combine, together: the same constant as an edit (platform/desktop/contract.ts). */
export const MAX_COMBINE_BYTES = MAX_EDIT_BYTES;
export const DEFAULT_OUTPUT_NAME = 'Combined.pdf';

export type PictureSize = 'image' | 'A4' | 'Letter';
export type TextSize = 'Letter' | 'A4';

export interface RowFacts {
  encrypted: boolean;
  fields: number;
  layers: boolean;
  attachments: number;
  unprintable: number;
}

export interface CombineRow {
  id: string;
  path: string;
  name: string;
  size: number;
  /** Modified time when the file was added; compared again before the run and when the worker reads it. */
  modified: number;
  kind: InputKind;
  status: 'reading' | 'ready';
  /** Pages of the file (frames of a TIFF, pages of a text file at the chosen size). 0 until read. */
  pages: number;
  /** What the user typed in Pages: empty means every page. */
  rangeText: string;
  facts: RowFacts | null;
  /** The file was found missing when the run was about to start: the row says so and Combine is off until it is removed. */
  gone?: boolean;
}

/** True when the row has a Pages field: PDFs, and pictures with more than one page (a multi-page TIFF). */
export function hasRange(row: CombineRow): boolean {
  return row.kind === 'pdf' || (row.kind === 'image' && row.pages > 1);
}

export type RowPages = { ok: true; pages: number[] | null; count: number } | { ok: false; message: string };

/** The pages a row contributes: null means all of them. `message` is the text under the field when the range is wrong. */
export function pagesOfRow(row: CombineRow): RowPages {
  if (row.status !== 'ready') return { ok: true, pages: null, count: 0 };
  if (!hasRange(row) || row.rangeText.trim() === '') return { ok: true, pages: null, count: row.pages };
  const parsed = parsePageRange(row.rangeText, row.pages);
  return parsed.ok ? { ok: true, pages: parsed.pages, count: parsed.pages.length } : { ok: false, message: parsed.message };
}

/** The selected pages of a row as a set (1-based), all of them when the range is empty. A wrong range counts as all. */
export function selectedSet(row: CombineRow): Set<number> {
  const result = pagesOfRow(row);
  if (result.ok && result.pages) return new Set(result.pages);
  return new Set(Array.from({ length: row.pages }, (_v, i) => i + 1));
}

/** "1-5, 8" from a set of pages; an empty text when every page of `total` is in it. */
export function rangeTextOf(pages: ReadonlySet<number>, total: number): string {
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  if (sorted.length === total) return '';
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * Clicking a page of the preview leaves it out or puts it back, and rewrites the Pages field. The last page of a file cannot be left
 * out (the file would add nothing: remove the row instead). Returns the new text, or null when nothing changes.
 */
export function togglePage(row: CombineRow, page: number): string | null {
  const set = selectedSet(row);
  if (set.has(page)) {
    if (set.size <= 1) return null;
    set.delete(page);
  } else {
    set.add(page);
  }
  return rangeTextOf(set, row.pages);
}

// ---- Order -------------------------------------------------------------------------------------------------------------------------

/** A to Z, with numbers in number order ("file2" before "file10"), ignoring case. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortByName<T extends { name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) => naturalCompare(x.name, y.name));
}

export type MoveWhere = 'up' | 'down' | 'first' | 'last';

/** Moves the rows with these ids as a block, keeping their order among themselves. Returns the new list and the first moved row's new 0-based index. */
export function moveRows<T extends { id: string }>(rows: readonly T[], ids: ReadonlySet<string>, where: MoveWhere): { rows: T[]; index: number } {
  const moving = rows.filter((r) => ids.has(r.id));
  if (moving.length === 0) return { rows: [...rows], index: -1 };
  const rest = rows.filter((r) => !ids.has(r.id));
  const firstAt = rows.findIndex((r) => ids.has(r.id));
  const lastAt = rows.length - 1 - [...rows].reverse().findIndex((r) => ids.has(r.id));
  // Position among the rest where the block goes.
  const before = rows.slice(0, firstAt).filter((r) => !ids.has(r.id)).length;
  const after = rows.slice(lastAt + 1).filter((r) => !ids.has(r.id)).length;
  let at: number;
  if (where === 'first') at = 0;
  else if (where === 'last') at = rest.length;
  else if (where === 'up') at = Math.max(0, before - 1);
  else at = Math.min(rest.length, rest.length - after + 1);
  const out = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return { rows: out, index: at };
}

/** Moves the rows with these ids to the place before row `beforeIndex` of the list as it is now (rows.length = the end). Used by dragging. */
export function moveBefore<T extends { id: string }>(rows: readonly T[], ids: ReadonlySet<string>, beforeIndex: number): T[] {
  const moving = rows.filter((r) => ids.has(r.id));
  if (moving.length === 0) return [...rows];
  const rest: T[] = [];
  let at = 0;
  rows.forEach((row, i) => {
    if (i === beforeIndex) at = rest.length;
    if (!ids.has(row.id)) rest.push(row);
  });
  if (beforeIndex >= rows.length) at = rest.length;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

// ---- Totals and notices ---------------------------------------------------------------------------------------------------------

export interface Totals {
  files: number;
  pages: number;
  bytes: number;
}

export function totals(rows: readonly CombineRow[]): Totals {
  let pages = 0;
  let bytes = 0;
  for (const row of rows) {
    bytes += row.size;
    const result = pagesOfRow(row);
    if (result.ok) pages += result.count;
  }
  return { files: rows.length, pages, bytes };
}

/** What the notices say, as separate lines (each shown as its own `status` paragraph), before the run. */
export function noticesFor(rows: readonly CombineRow[]): string[] {
  const unique = (pick: (row: CombineRow) => boolean): string[] => {
    const seen: string[] = [];
    for (const row of rows) if (row.status === 'ready' && pick(row) && !seen.includes(row.name)) seen.push(row.name);
    return seen;
  };
  const out: string[] = [];
  const forms = unique((r) => (r.facts?.fields ?? 0) > 0);
  if (forms.length > 0) out.push(combineFormsNotice(forms));
  const locked = unique((r) => r.facts?.encrypted === true);
  if (locked.length > 0) out.push(combinePasswordNotice(locked));
  const layers = unique((r) => r.facts?.layers === true);
  if (layers.length > 0) out.push(combineLayersNotice(layers));
  const attachments = unique((r) => (r.facts?.attachments ?? 0) > 0);
  if (attachments.length > 0) out.push(combineAttachmentsNotice(attachments));
  const done = new Set<string>();
  for (const row of rows) {
    if (row.status !== 'ready' || row.kind !== 'text' || (row.facts?.unprintable ?? 0) === 0 || done.has(row.name)) continue;
    done.add(row.name);
    out.push(combineTextNotice(row.name, row.facts!.unprintable));
  }
  return out;
}

export type CombineBlock = 'empty' | 'reading' | 'range' | 'too-large' | 'gone' | null;

/** Why Combine… is off, or null when it can run. */
export function blockOf(rows: readonly CombineRow[]): CombineBlock {
  if (rows.length === 0) return 'empty';
  if (rows.some((r) => r.status !== 'ready')) return 'reading';
  if (rows.some((r) => r.gone === true)) return 'gone';
  if (rows.some((r) => !pagesOfRow(r).ok)) return 'range';
  const t = totals(rows);
  if (t.bytes > MAX_COMBINE_BYTES) return 'too-large';
  if (t.pages < 1) return 'empty';
  return null;
}

// ---- The spec -----------------------------------------------------------------------------------------------------------------------

export const pageDimsOfText = (size: TextSize): PageDims => (size === 'A4' ? A4 : LETTER);
export const imagePageOf = (size: PictureSize): 'image' | PageDims => (size === 'image' ? 'image' : size === 'A4' ? A4 : LETTER);

export interface CombineOptions {
  fileBookmarks: boolean;
  pictureSize: PictureSize;
  textSize: TextSize;
}

/** The spec for the worker. `passwords` maps a path to the password the user gave for it. */
export function buildCombineSpec(rows: readonly CombineRow[], options: CombineOptions, leafName: string, passwords: ReadonlyMap<string, string>): CombineSpec {
  return {
    kind: 'combine',
    items: rows.map((row) => {
      const result = pagesOfRow(row);
      const password = passwords.get(row.path);
      return {
        kind: row.kind,
        name: row.name,
        ...(result.ok && result.pages ? { pages: result.pages } : {}),
        count: result.ok ? result.count : 0,
        ...(password !== undefined && row.kind === 'pdf' ? { password } : {}),
      };
    }),
    fileBookmarks: options.fileBookmarks,
    imagePage: imagePageOf(options.pictureSize),
    textPage: pageDimsOfText(options.textSize),
    leafName,
  };
}

/** The leaf of a path. */
export function leafOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
