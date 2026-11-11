import type { PageRef } from '../../core/model/types';
import { engineIndexOf } from '../../engine/pageRef';
import type { EngineDocument, TextRun } from '../../engine/types';
import { findMatches, indexRuns, searchRuns, type SearchOptions, type TextMatch } from './textSearch';

/**
 * Longest stretch of scanning before the runner gives the main thread back. Measured in time, not
 * pages, because a page with dense text can take far longer than a sparse one.
 */
export const SLICE_BUDGET_MS = 8;

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Byte cap of the search text cache. Measured: a full search of 1,000 dense pages held +173 MB of JS heap without a cap. */
export const TEXT_CACHE_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Bytes a page's text takes: UTF-16 text, the offsets of each run, the packed character boundaries when the run has them
 * (4 bytes for each character and one more), and the per-character boxes when the run has built them (32 bytes each).
 */
export function textBytes(runs: readonly TextRun[]): number {
  let bytes = 0;
  for (const run of runs) {
    bytes += run.text.length * 2 + 64;
    if (run.bounds) bytes += (run.text.length + 1) * 4;
    if (run.charBoxes) bytes += run.text.length * 32;
  }
  return bytes;
}

/**
 * The search text cache: a Map that holds at most `maxBytes` of page text. Reading or writing a page makes it the most
 * recent; when the cap is passed, the least recently used pages go first (the page just stored always stays).
 */
export class TextCache extends Map<string, TextRun[]> {
  private bytes = 0;
  private readonly sizes = new Map<string, number>();
  constructor(private readonly maxBytes: number = TEXT_CACHE_MAX_BYTES) {
    super();
  }
  get totalBytes(): number {
    return this.bytes;
  }
  override get(key: string): TextRun[] | undefined {
    const runs = super.get(key);
    if (runs) {
      super.delete(key);
      super.set(key, runs);
    }
    return runs;
  }
  override set(key: string, runs: TextRun[]): this {
    this.drop(key);
    const size = textBytes(runs);
    super.set(key, runs);
    this.sizes.set(key, size);
    this.bytes += size;
    for (const oldest of super.keys()) {
      if (this.bytes <= this.maxBytes || oldest === key) break;
      this.drop(oldest);
    }
    return this;
  }
  override delete(key: string): boolean {
    return this.drop(key);
  }
  override clear(): void {
    super.clear();
    this.sizes.clear();
    this.bytes = 0;
  }
  private drop(key: string): boolean {
    this.bytes -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    return super.delete(key);
  }
}

/** The text cache's key for a page: its content name (its index when it has none) and its rotation. */
export function textCacheKey(ref: PageRef): string {
  return `${ref.content ?? engineIndexOf(ref)}|${ref.rotation}`;
}

/** Drops the cached text of every page that is no longer in `pages` (an edit or a save gave it another content name). */
export function pruneTextCache(cache: Map<string, TextRun[]>, pages: readonly PageRef[]): void {
  const keep = new Set(pages.map(textCacheKey));
  for (const key of [...cache.keys()]) if (!keep.has(key)) cache.delete(key);
}

/** True for the error of a read that was cancelled (see engine/mupdf/client toError and renderScheduler abortError). */
function isCancelled(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || name === 'Cancelled';
}

export interface SearchRequest {
  doc: EngineDocument;
  pages: readonly PageRef[];
  query: string;
  options: SearchOptions;
  signal: AbortSignal;
  /** Text read so far, keyed by the page's content name (its index when it has none) and rotation. Reused across queries. */
  cache: Map<string, TextRun[]>;
  onPage: (page: { pageId: string; pageIndex: number; matches: TextMatch[] }) => void;
  onProgress: (scanned: number) => void;
}

/**
 * Searches a document one page at a time. Text is read in small slices and the main thread is
 * yielded between slices, so a 1,000-page file never blocks the UI. Stops as soon as `signal`
 * aborts, which happens when the query or options change. Resolves when the scan finishes or is cancelled.
 */
export async function searchDocument(request: SearchRequest): Promise<void> {
  const { doc, pages, query, options, signal, cache, onPage, onProgress } = request;
  let sliceStart = performance.now();
  for (let i = 0; i < pages.length; i++) {
    if (signal.aborted) return;
    const ref = pages[i];
    if (!ref) continue;

    const engineIndex = engineIndexOf(ref);
    // The cache names a page by its content ("uid@rev@generation"), not its position: an edit that moves, deletes, inserts or
    // cuts pages gives the same position to a different page, and the text read for the old one must not be reused for it.
    // (Documents without a content name, such as the pdf.js ones, never change their pages, so their index names them.)
    const key = textCacheKey(ref);
    let runs = cache.get(key);
    if (!runs) {
      let cacheable = true;
      try {
        runs = await doc.pageText(engineIndex, ref.rotation);
      } catch (error) {
        // A page whose text cannot be read simply has no matches. A read that was cancelled (the scan was aborted, or the page
        // changed under it) says nothing about the page, so its empty result is never kept: the page is read again next time.
        runs = [];
        cacheable = !isCancelled(error) && !(error instanceof RangeError);
      }
      if (signal.aborted) return;
      if (cacheable) cache.set(key, runs);
    }

    // Only a page with a match needs its fonts ready, because only matched glyphs are measured.
    const index = indexRuns(runs);
    const found = findMatches(index.text, query, options);
    if (doc.fontsReady && found.length > 0) {
      await doc.fontsReady(engineIndex).catch(() => undefined);
      if (signal.aborted) return;
    }
    const matches = searchRuns(runs, query, options, found, index);
    if (matches.length > 0) onPage({ pageId: ref.id, pageIndex: i, matches });
    onProgress(i + 1);

    if (performance.now() - sliceStart >= SLICE_BUDGET_MS) {
      await yieldToMain();
      sliceStart = performance.now();
    }
  }
}
