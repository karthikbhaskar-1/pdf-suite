/**
 * Split by file size (blueprint B4). A part is accepted only when its SAVED bytes are measured and are at most the limit.
 * An estimate (ReachSet) only picks the first guess. Guarantee: every part is at most the limit, except a single page that
 * alone is over it (accepted and reported).
 *
 * `fitPart` is pure: it knows nothing about MuPDF. The caller builds a fresh part for a given page count, saves it once and
 * returns the saved size; a part document is never saved twice (a save with garbage collection renumbers objects under the
 * graft map).
 */
import type * as Mu from 'mupdf';

/** Bytes added to the estimate for every object a page reaches (dictionary text, xref entry). */
export const OBJECT_OVERHEAD_BYTES = 300;
/** Keys that lead away from a page's own data: the page tree, other pages, and actions. */
const SKIP_KEYS = new Set(['Parent', 'P', 'Dest', 'D', 'A', 'Next', 'Prev', 'StructParent', 'StructParents', 'Popup']);
/** A walk stops here, so a damaged file cannot make an estimate run away. */
const MAX_OBJECTS = 400_000;

/**
 * The bytes that adding a page to a part would add, counting each object once: the `/Length` of every stream reachable
 * through the page's Contents, Resources and annotation appearances, plus OBJECT_OVERHEAD_BYTES per object. Objects reached
 * by an earlier page of the part are not counted again, which is how shared fonts and images are counted once.
 */
export class ReachSet {
  private readonly seen = new Set<number>();

  constructor(private readonly pdf: Mu.PDFDocument) {}

  /** Adds page `index` and returns the estimated bytes it adds. */
  add(index: number): number {
    const page = this.pdf.findPage(index);
    let bytes = OBJECT_OVERHEAD_BYTES;
    const roots: Mu.PDFObject[] = [page.get('Contents'), page.getInheritable('Resources'), page.get('Annots')];
    for (const root of roots) bytes += this.walk(root);
    return bytes;
  }

  private walk(start: Mu.PDFObject): number {
    let bytes = 0;
    const stack: Mu.PDFObject[] = [start];
    while (stack.length > 0 && this.seen.size < MAX_OBJECTS) {
      const obj = stack.pop()!;
      if (obj.isNull()) continue;
      if (obj.isIndirect()) {
        const number = obj.asIndirect();
        if (this.seen.has(number)) continue;
        this.seen.add(number);
        bytes += OBJECT_OVERHEAD_BYTES;
        if (obj.isStream()) {
          const length = obj.get('Length');
          if (length.isNumber()) bytes += length.asNumber();
        }
      }
      const value = obj.resolve();
      if (value.isArray()) {
        for (let i = 0; i < value.length; i++) stack.push(value.get(i));
      } else if (value.isDictionary()) {
        value.forEach((child, key) => {
          if (!SKIP_KEYS.has(String(key))) stack.push(child);
        });
      }
    }
    return bytes;
  }
}

/** How many pages, counted from `from`, the estimate says fit in `maxBytes` (at least one). */
export function guessPageCount(reach: ReachSet, from: number, pages: number, maxBytes: number): number {
  let total = 0;
  let k = 0;
  while (from + k < pages) {
    total += reach.add(from + k);
    if (total > maxBytes) break;
    k += 1;
  }
  return Math.max(1, k);
}

export interface BuiltPart<T> {
  /** Saved size in bytes. */
  size: number;
  /** What the caller keeps for the accepted part (its bytes). */
  keep: T;
}

export interface FitResult<T> extends BuiltPart<T> {
  /** Pages in the part. */
  k: number;
  /** True for a single page that alone is over the limit. */
  oversize: boolean;
  /** Parts built to get here, for tests and the log. */
  builds: number;
}

/**
 * Finds the part that starts at `from`: the most pages, near the guess, whose saved size is at most `maxBytes`.
 *  1. Build `guess` pages and measure.
 *  2. Too big: remove ceil((size - limit) / average page) + 1 pages and try again; after 4 tries, binary search.
 *  3. Fits under 90% of the limit with pages left: one attempt to take more; kept only if it fits.
 *  4. One page and still too big: accept it as it is and say so.
 */
export async function fitPart<T>(options: {
  from: number;
  pages: number;
  maxBytes: number;
  guess: number;
  build: (from: number, k: number) => Promise<BuiltPart<T>>;
}): Promise<FitResult<T>> {
  const { from, pages, maxBytes } = options;
  const most = pages - from;
  let k = Math.min(most, Math.max(1, options.guess));
  let best: (BuiltPart<T> & { k: number }) | null = null;
  let tooBigAt = Infinity;
  let shrinkTries = 0;
  let builds = 0;
  let extended = false;
  for (;;) {
    const built = await options.build(from, k);
    builds += 1;
    if (built.size <= maxBytes) {
      if (extended) {
        // The one attempt to take more pages fitted: it is kept, and the search ends.
        return { ...built, k, oversize: false, builds };
      }
      if (best === null || k > best.k) best = { ...built, k };
      if (k >= most) break;
      if (tooBigAt === Infinity) {
        if (built.size >= 0.9 * maxBytes) break;
        // Fits with room: one attempt to take more pages, sized by the average page.
        const average = built.size / k;
        const more = Math.max(1, Math.floor((maxBytes - built.size) / average));
        extended = true;
        k = Math.min(most, k + more);
        continue;
      }
      if (tooBigAt - best.k <= 1) break;
      k = Math.floor((best.k + tooBigAt) / 2);
      continue;
    }
    // Too big.
    if (extended) break; // The attempt to take more did not fit: the earlier part stays.
    if (k === 1) return { ...built, k: 1, oversize: true, builds };
    tooBigAt = Math.min(tooBigAt, k);
    shrinkTries += 1;
    if (best !== null) {
      if (tooBigAt - best.k <= 1) break;
      k = Math.floor((best.k + tooBigAt) / 2);
    } else if (shrinkTries <= 4) {
      const average = built.size / k;
      k = Math.max(1, Math.min(k - 1, k - (Math.ceil((built.size - maxBytes) / average) + 1)));
    } else {
      // Binary search between one page (not yet known to fit) and the size that is too big.
      k = Math.max(1, Math.floor(tooBigAt / 2));
    }
  }
  if (best === null) throw new Error('fitPart: no part was built');
  return { size: best.size, keep: best.keep, k: best.k, oversize: false, builds };
}
