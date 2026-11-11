/**
 * TEST ORACLE (ticket 1.5.11): the text reader as it was before the packed text change, kept verbatim so tests can
 * prove the packed path gives the same hits and highlight rectangles. One object per character, one box object per
 * character. Not used by the app.
 */
import type { StructuredText } from 'mupdf';
import type { StextModule } from './fastText';
import { LETTER_GAP_EM } from './fastText';

type Point = { x: number; y: number };

/** A run as it was sent before packing: one box object per UTF-16 unit. */
export interface LegacyRun {
  text: string;
  origin: { x: number; y: number };
  along: { x: number; y: number };
  up: { x: number; y: number };
  charBoxes: Array<{ start: number; end: number }>;
}

/** One character as read from its quad. */
export interface CharQuad {
  code: number;
  /** Font size in points. Used to tell a real space from a synthetic one. */
  size: number;
  ul: Point;
  ur: Point;
  ll: Point;
  lr: Point;
}

const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;

const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

/** The gap between two neighbouring glyphs along the run, in points. Negative when they overlap. */
const gapBetween = (prev: CharQuad, next: CharQuad, dir: Point): number => dot(minus(next.ll, prev.lr), dir);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Drops the synthetic spaces MuPDF inserts inside letter-spaced words, and keeps every other space.
 *
 * A space is synthetic when both conditions hold:
 * - the line is letter-spaced: the median gap between adjacent non-space glyphs is at least LETTER_GAP_EM of
 *   the font size. Lines without character spacing never qualify, so their spaces are always kept. This is
 *   what protects condensed text and negative word spacing.
 * - the space sits flush against both neighbours (the gap on each side is under half the median gap). MuPDF
 *   places its synthetic spaces in the spacing between two glyphs, so both gaps are about zero. A real space
 *   keeps the character spacing on each side of it.
 */
export function dropSyntheticSpaces(all: readonly CharQuad[], dir: Point): readonly CharQuad[] {
  const gaps: number[] = [];
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1]!;
    const next = all[i]!;
    if (prev.code !== 32 && next.code !== 32) gaps.push(gapBetween(prev, next, dir));
  }
  const size = all.find((c) => c.code !== 32 && c.size > 0)?.size ?? 0;
  if (gaps.length === 0 || size <= 0) return all;
  const gap = median(gaps);
  if (gap < LETTER_GAP_EM * size) return all;
  const flush = gap / 2;
  return all.filter((c, i) => {
    const prev = all[i - 1];
    const next = all[i + 1];
    if (c.code !== 32 || !prev || !next) return true;
    return !(gapBetween(prev, c, dir) < flush && gapBetween(c, next, dir) < flush);
  });
}

/**
 * Builds one run from the characters of a line. The run starts at the first character's lower-left
 * corner and follows its advance direction. Each character's box runs from its start to the start of the
 * next, so the boxes are contiguous and cover the whole run.
 */
export function buildRun(allChars: readonly CharQuad[]): LegacyRun | null {
  const rawDir0 = allChars[0] ? minus(allChars[0].ur, allChars[0].ul) : { x: 1, y: 0 };
  const length0 = Math.hypot(rawDir0.x, rawDir0.y);
  const dir: Point = length0 > 0 ? { x: rawDir0.x / length0, y: rawDir0.y / length0 } : { x: 1, y: 0 };
  // Synthetic spaces are dropped (see dropSyntheticSpaces). The glyphs around one keep their boxes, because the
  // box of the glyph before a dropped space runs to the next glyph.
  const chars = dropSyntheticSpaces(allChars, dir);
  const first = chars[0];
  const last = chars[chars.length - 1];
  if (!first || !last) return null;
  const origin = first.ll;
  // Height vector: from the baseline corner up to the top of the glyph.
  const up = minus(first.ul, first.ll);

  // Boundaries along the run: one per character start, plus the end of the last character.
  const bounds: number[] = chars.map((c) => dot(minus(c.ll, origin), dir));
  bounds.push(dot(minus(last.lr, origin), dir));
  for (let i = 1; i < bounds.length; i++) {
    bounds[i] = Math.max(bounds[i] ?? 0, bounds[i - 1] ?? 0);
  }
  const total = bounds[bounds.length - 1] ?? 0;

  let text = '';
  const charBoxes: Array<{ start: number; end: number }> = [];
  chars.forEach((c, i) => {
    const start = bounds[i] ?? 0;
    const end = bounds[i + 1] ?? total;
    const symbol = c.code >= 0 && c.code <= 0x10ffff ? String.fromCodePoint(c.code) : '�';
    if (symbol.length === 1) {
      text += symbol;
      charBoxes.push({ start, end });
    } else {
      // A character outside the Basic Multilingual Plane is two UTF-16 units. They split its box evenly.
      const middle = (start + end) / 2;
      text += symbol;
      charBoxes.push({ start, end: middle }, { start: middle, end });
    }
  });

  return {
    text,
    origin: { x: origin.x, y: origin.y },
    along: { x: dir.x * total, y: dir.y * total },
    up: { x: up.x, y: up.y },
    charBoxes,
  };
}

/** Reads the runs of one stext page through the WASM accessors. `page` is the page's stext pointer. */
export function legacyReadRunsFast(page: number, m: StextModule): LegacyRun[] {
  const runs: LegacyRun[] = [];
  let block = m._wasm_stext_page_get_first_block(page);
  while (block) {
    // Block type 0 is text. Images and vectors have no text.
    if (m._wasm_stext_block_get_type(block) === 0) {
      let line = m._wasm_stext_block_get_first_line(block);
      while (line) {
        const chars: CharQuad[] = [];
        let ch = m._wasm_stext_line_get_first_char(line);
        while (ch) {
          const at = m._wasm_stext_char_get_quad(ch) >> 2;
          const f = m.HEAPF32;
          chars.push({
            code: m._wasm_stext_char_get_c(ch),
            size: m._wasm_stext_char_get_size(ch),
            ul: { x: f[at] ?? 0, y: f[at + 1] ?? 0 },
            ur: { x: f[at + 2] ?? 0, y: f[at + 3] ?? 0 },
            ll: { x: f[at + 4] ?? 0, y: f[at + 5] ?? 0 },
            lr: { x: f[at + 6] ?? 0, y: f[at + 7] ?? 0 },
          });
          ch = m._wasm_stext_char_get_next(ch);
        }
        const run = buildRun(chars);
        if (run) runs.push(run);
        line = m._wasm_stext_line_get_next(line);
      }
    }
    block = m._wasm_stext_block_get_next(block);
  }
  return runs;
}

/** Reads the runs through the public walk() API. Slower, but uses only the documented interface. */
export function legacyReadRunsWalk(stext: StructuredText): LegacyRun[] {
  const runs: LegacyRun[] = [];
  let chars: CharQuad[] = [];
  stext.walk({
    beginLine: () => {
      chars = [];
    },
    onChar: (symbol: string, _origin: unknown, _font: unknown, fontSize: number, quad: unknown) => {
      const q = quad as ArrayLike<number>;
      chars.push({
        code: symbol.codePointAt(0) ?? 0xfffd,
        size: fontSize,
        ul: { x: q[0] ?? 0, y: q[1] ?? 0 },
        ur: { x: q[2] ?? 0, y: q[3] ?? 0 },
        ll: { x: q[4] ?? 0, y: q[5] ?? 0 },
        lr: { x: q[6] ?? 0, y: q[7] ?? 0 },
      });
    },
    endLine: () => {
      const run = buildRun(chars);
      if (run) runs.push(run);
      chars = [];
    },
  } as Parameters<StructuredText['walk']>[0]);
  return runs;
}

