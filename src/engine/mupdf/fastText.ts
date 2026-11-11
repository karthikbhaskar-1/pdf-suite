/**
 * Reads the text of a MuPDF structured-text page into runs, one run per line, with exact per-character boundaries taken from
 * each character's quad. The boundaries are packed in one Float32Array per page (see RunData in protocol.ts); no object is built
 * per character.
 *
 * The fast path reads the WASM accessors (`_wasm_stext_*`) directly. The public `walk()` API allocates
 * an object per character, which is too slow for a 1,000-page search. The accessors are not part of
 * mupdf's public API, so they are checked before use. If any is missing, the public walk() is used
 * instead and the fallback is logged once.
 *
 * Quad layout (from MuPDF, eight floats): upper-left, upper-right, lower-left, lower-right, in the page's
 * display space with the y axis pointing down.
 */
import type { StructuredText } from 'mupdf';
import type { RunData } from './protocol';

/** The accessors the fast path needs, plus the heap view they read through. */
export interface StextModule {
  HEAPF32: Float32Array;
  _wasm_stext_page_get_first_block(page: number): number;
  _wasm_stext_block_get_next(block: number): number;
  _wasm_stext_block_get_type(block: number): number;
  _wasm_stext_block_get_first_line(block: number): number;
  _wasm_stext_line_get_next(line: number): number;
  _wasm_stext_line_get_first_char(line: number): number;
  _wasm_stext_char_get_next(char: number): number;
  _wasm_stext_char_get_c(char: number): number;
  _wasm_stext_char_get_quad(char: number): number;
  _wasm_stext_char_get_size(char: number): number;
}

const REQUIRED_FUNCTIONS = [
  '_wasm_stext_page_get_first_block',
  '_wasm_stext_block_get_next',
  '_wasm_stext_block_get_type',
  '_wasm_stext_block_get_first_line',
  '_wasm_stext_line_get_next',
  '_wasm_stext_line_get_first_char',
  '_wasm_stext_char_get_next',
  '_wasm_stext_char_get_c',
  '_wasm_stext_char_get_quad',
  '_wasm_stext_char_get_size',
] as const;

/** The accessors of a loaded MuPDF module, or null when any of them is missing. */
export function findStextModule(candidate: unknown): StextModule | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof record[name] !== 'function') return null;
  }
  if (!(record.HEAPF32 instanceof Float32Array) && !ArrayBuffer.isView(record.HEAPF32)) return null;
  return candidate as StextModule;
}

let fallbackLogged = false;

function logFallbackOnce(reason: string): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.warn(`MuPDF text: using the public walk() API, the fast accessors are unavailable (${reason}).`);
}

/**
 * The characters of one line, read into flat arrays (no object per character). Quad layout per character: eight
 * numbers, upper-left, upper-right, lower-left, lower-right (x then y). Doubles, so a value read from the heap
 * (a float) or from the public API is kept exactly.
 */
class LineChars {
  count = 0;
  codes = new Int32Array(512);
  sizes = new Float64Array(512);
  quads = new Float64Array(512 * 8);
  /** Scratch for the gap test, the keep flags and the UTF-16 units of the line. */
  gaps = new Float64Array(512);
  keep = new Uint8Array(512);
  units = new Uint16Array(1024);

  reset(): void {
    this.count = 0;
  }

  /** Adds one character and returns the index in `quads` where its eight numbers go. */
  add(code: number, size: number): number {
    if (this.count >= this.codes.length) this.grow();
    this.codes[this.count] = code;
    this.sizes[this.count] = size;
    return this.count++ * 8;
  }

  private grow(): void {
    const cap = this.codes.length * 2;
    const codes = new Int32Array(cap);
    codes.set(this.codes);
    this.codes = codes;
    const sizes = new Float64Array(cap);
    sizes.set(this.sizes);
    this.sizes = sizes;
    const quads = new Float64Array(cap * 8);
    quads.set(this.quads);
    this.quads = quads;
    this.gaps = new Float64Array(cap);
    this.keep = new Uint8Array(cap);
    this.units = new Uint16Array(cap * 2);
  }
}

/** The page's packed boundaries while it is read. One scratch array, copied tight at the end. */
class BoundsWriter {
  buffer = new Float32Array(8192);
  length = 0;

  reset(): void {
    this.length = 0;
  }

  reserve(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buffer.length) return;
    let cap = this.buffer.length * 2;
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  /** A tight copy of what was written: its own buffer, so it can be transferred without taking the scratch. */
  finish(): Float32Array {
    return this.buffer.slice(0, this.length);
  }
}

const line = new LineChars();
const writer = new BoundsWriter();
const NO_BOUNDS = new Float32Array(0);

/**
 * Letter-spacing signature: a line counts as letter-spaced when the median gap between adjacent non-space
 * glyphs is at least this share of the font size. Glyph quads do not include character spacing, so the gap
 * is the spacing itself (1.5 pt at 12 pt is 0.125 em).
 *
 * Why a width threshold is not used: MuPDF's reported font size is the geometric mean of the text matrix,
 * so horizontal scaling (Tz) shrinks it while the glyphs keep their width. Word spacing (Tw) changes the
 * advance but not the quad. A space's width therefore cannot tell a real space from a synthetic one.
 */
export const LETTER_GAP_EM = 0.05;

/** The gap between glyph i - 1 and glyph i along the run direction (dx, dy), in points. Negative when they overlap. */
function gapBefore(q: Float64Array, i: number, dx: number, dy: number): number {
  const prev = (i - 1) * 8;
  const next = i * 8;
  // next.ll - prev.lr, dotted with the direction.
  return (q[next + 4]! - q[prev + 6]!) * dx + (q[next + 5]! - q[prev + 7]!) * dy;
}

/**
 * Marks the synthetic spaces MuPDF inserts inside letter-spaced words, and keeps every other space.
 * Returns true when some character is dropped (`keep` then holds a flag per character), false when every one is kept.
 *
 * A space is synthetic when both conditions hold:
 * - the line is letter-spaced: the median gap between adjacent non-space glyphs is at least LETTER_GAP_EM of
 *   the font size. Lines without character spacing never qualify, so their spaces are always kept. This is
 *   what protects condensed text and negative word spacing.
 * - the space sits flush against both neighbours (the gap on each side is under half the median gap). MuPDF
 *   places its synthetic spaces in the spacing between two glyphs, so both gaps are about zero. A real space
 *   keeps the character spacing on each side of it.
 */
function markSyntheticSpaces(l: LineChars, dx: number, dy: number): boolean {
  const n = l.count;
  const q = l.quads;
  const codes = l.codes;
  const gaps = l.gaps;
  let gapCount = 0;
  for (let i = 1; i < n; i++) {
    if (codes[i - 1] !== 32 && codes[i] !== 32) gaps[gapCount++] = gapBefore(q, i, dx, dy);
  }
  let size = 0;
  for (let i = 0; i < n; i++) {
    if (codes[i] !== 32 && l.sizes[i]! > 0) {
      size = l.sizes[i]!;
      break;
    }
  }
  if (gapCount === 0 || size <= 0) return false;
  const threshold = LETTER_GAP_EM * size;
  // The median reaches the threshold only if the upper middle gap does, which needs more than half of the gaps at or above it.
  // Almost every normal line fails that count, so it is not sorted.
  const upper = gapCount >> 1;
  let reaching = 0;
  for (let i = 0; i < gapCount; i++) if (gaps[i]! >= threshold) reaching++;
  if (reaching < gapCount - upper) return false;
  const sorted = gaps.slice(0, gapCount).sort();
  const median = gapCount % 2 === 1 ? sorted[upper]! : (sorted[upper - 1]! + sorted[upper]!) / 2;
  if (median < threshold) return false;
  const flush = median / 2;
  const keep = l.keep;
  let dropped = false;
  for (let i = 0; i < n; i++) {
    // The first and the last character are always kept.
    const synthetic =
      codes[i] === 32 && i > 0 && i < n - 1 && gapBefore(q, i, dx, dy) < flush && gapBefore(q, i + 1, dx, dy) < flush;
    keep[i] = synthetic ? 0 : 1;
    if (synthetic) dropped = true;
  }
  return dropped;
}

const UNITS_PER_CALL = 4096;

/**
 * Builds one run from the characters of the line buffer and appends its boundaries to the writer. The run starts at the
 * first character's lower-left corner and follows its advance direction. Each character's box runs from its start to
 * the start of the next, so the boxes are contiguous and cover the whole run. The run's `bounds` is filled in by finishPage.
 */
function buildRunPacked(l: LineChars, w: BoundsWriter): RunData | null {
  const n = l.count;
  if (n === 0) return null;
  const q = l.quads;
  const rawX = q[2]! - q[0]!;
  const rawY = q[3]! - q[1]!;
  const length0 = Math.hypot(rawX, rawY);
  const dx = length0 > 0 ? rawX / length0 : 1;
  const dy = length0 > 0 ? rawY / length0 : 0;
  // Synthetic spaces are dropped (see markSyntheticSpaces). The glyphs around one keep their boxes, because the
  // box of the glyph before a dropped space runs to the next glyph.
  const filtered = markSyntheticSpaces(l, dx, dy);
  const keep = l.keep;
  // The first and the last character are never dropped, so the origin is the first character's lower-left corner.
  const ox = q[4]!;
  const oy = q[5]!;
  // Height vector: from the baseline corner up to the top of the glyph.
  const upX = q[0]! - ox;
  const upY = q[1]! - oy;

  // One boundary per UTF-16 unit, then the end of the last character. Never decreasing, so the boxes are contiguous.
  w.reserve(n * 2 + 1);
  const out = w.buffer;
  const at = w.length;
  const units = l.units;
  let u = 0;
  let previous = 0;
  // An astral character is two units and splits its box evenly. Its end is the next start, so its middle is set once that is known.
  let middleAt = -1;
  let middleFrom = 0;
  for (let i = 0; i < n; i++) {
    if (filtered && !keep[i]) continue;
    const raw = (q[i * 8 + 4]! - ox) * dx + (q[i * 8 + 5]! - oy) * dy;
    const start = raw > previous ? raw : previous;
    if (middleAt >= 0) {
      out[at + middleAt] = (middleFrom + start) / 2;
      middleAt = -1;
    }
    previous = start;
    out[at + u] = start;
    const code = l.codes[i]!;
    if (code >= 0 && code <= 0xffff) {
      units[u++] = code;
    } else if (code > 0xffff && code <= 0x10ffff) {
      const v = code - 0x10000;
      units[u] = 0xd800 + (v >> 10);
      units[u + 1] = 0xdc00 + (v & 0x3ff);
      middleFrom = start;
      middleAt = u + 1;
      u += 2;
    } else {
      units[u++] = 0xfffd;
    }
  }
  const lastAt = (n - 1) * 8;
  const rawTotal = (q[lastAt + 6]! - ox) * dx + (q[lastAt + 7]! - oy) * dy;
  const total = rawTotal > previous ? rawTotal : previous;
  if (middleAt >= 0) out[at + middleAt] = (middleFrom + total) / 2;
  out[at + u] = total;
  w.length = at + u + 1;

  let text = '';
  for (let from = 0; from < u; from += UNITS_PER_CALL) {
    text += String.fromCharCode.apply(null, units.subarray(from, Math.min(u, from + UNITS_PER_CALL)) as unknown as number[]);
  }
  return {
    text,
    origin: { x: ox, y: oy },
    along: { x: dx * total, y: dy * total },
    up: { x: upX, y: upY },
    bounds: NO_BOUNDS,
    boundsAt: at,
  };
}

/** Gives every run of the page its shared, tight bounds array. */
function finishPage(runs: RunData[], w: BoundsWriter): RunData[] {
  if (runs.length === 0) return runs;
  const bounds = w.finish();
  for (const run of runs) run.bounds = bounds;
  return runs;
}

/** The boxes of a run's characters, one per UTF-16 unit, built from its packed boundaries. For tests and code that needs objects. */
export function charBoxesOf(run: Pick<RunData, 'text' | 'bounds' | 'boundsAt'>): Array<{ start: number; end: number }> {
  const boxes: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < run.text.length; i++) {
    boxes.push({ start: run.bounds[run.boundsAt + i]!, end: run.bounds[run.boundsAt + i + 1]! });
  }
  return boxes;
}

/** Reads the runs of one stext page through the WASM accessors. `page` is the page's stext pointer. */
export function readRunsFast(page: number, m: StextModule): RunData[] {
  const runs: RunData[] = [];
  writer.reset();
  let block = m._wasm_stext_page_get_first_block(page);
  while (block) {
    // Block type 0 is text. Images and vectors have no text.
    if (m._wasm_stext_block_get_type(block) === 0) {
      let ln = m._wasm_stext_block_get_first_line(block);
      while (ln) {
        line.reset();
        let ch = m._wasm_stext_line_get_first_char(ln);
        while (ch) {
          const slot = line.add(m._wasm_stext_char_get_c(ch), m._wasm_stext_char_get_size(ch));
          const at = m._wasm_stext_char_get_quad(ch) >> 2;
          const f = m.HEAPF32;
          const quads = line.quads;
          for (let k = 0; k < 8; k++) quads[slot + k] = f[at + k] ?? 0;
          ch = m._wasm_stext_char_get_next(ch);
        }
        const run = buildRunPacked(line, writer);
        if (run) runs.push(run);
        ln = m._wasm_stext_line_get_next(ln);
      }
    }
    block = m._wasm_stext_block_get_next(block);
  }
  return finishPage(runs, writer);
}

/** Reads the runs through the public walk() API. Slower, but uses only the documented interface. */
export function readRunsWalk(stext: StructuredText): RunData[] {
  const runs: RunData[] = [];
  writer.reset();
  line.reset();
  stext.walk({
    beginLine: () => {
      line.reset();
    },
    onChar: (symbol: string, _origin: unknown, _font: unknown, fontSize: number, quad: unknown) => {
      const q = quad as ArrayLike<number>;
      const slot = line.add(symbol.codePointAt(0) ?? 0xfffd, fontSize);
      for (let k = 0; k < 8; k++) line.quads[slot + k] = q[k] ?? 0;
    },
    endLine: () => {
      const run = buildRunPacked(line, writer);
      if (run) runs.push(run);
      line.reset();
    },
  } as Parameters<StructuredText['walk']>[0]);
  return finishPage(runs, writer);
}

/**
 * Reads the runs of a page. Uses the fast accessors when the module has them, and the public walk() API
 * otherwise. `module` is the loaded mupdf WASM module (`globalThis.$libmupdf_wasm_Module`).
 */
export function readPageRuns(stext: StructuredText, module: unknown): RunData[] {
  const fast = findStextModule(module);
  if (fast) return readRunsFast(stext.pointer, fast);
  logFallbackOnce('module accessors not found');
  return readRunsWalk(stext);
}
