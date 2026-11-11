/**
 * Blank-page detection by rendered pixels (content analysis misses scanned blanks), as ruled in
 * docs/milestone-1.5/blank-calibration.md. The page is drawn in gray at 50 dpi. The top and bottom 3% and a band at the left and
 * right (18 mm, never more than 15% of the width: where punch holes are) are ignored. A pixel is ink when it differs from the
 * paper tone (the median gray of the measured area) by more than BLANK_PAPER_CONTRAST, and dark ink also needs to be darker than
 * INK_THRESHOLD. Two numbers come back for every page: `ink`, the share of ink pixels, and `mark`, the size in pixels of the
 * largest group of ink pixels that lie within BLANK_MARK_GAP pixels of each other. Annotations are drawn, so a page that holds
 * only a note is not blank. The page of the app applies a preset to the numbers without a second pass (see splitPlan.ts).
 */
import type * as Mu from 'mupdf';
import { INK_THRESHOLD, displayBounds } from './pageOps';

type RenderKit = Pick<typeof Mu, 'Matrix' | 'Pixmap' | 'ColorSpace' | 'DrawDevice'>;

export const BLANK_DPI = 50;
/** Share of the page's height that is ignored at the top and at the bottom. */
export const BLANK_BORDER = 0.03;
/** Ignored at the left and right: punch holes end 15.3 mm (ISO 838) and 16.7 mm (US three-hole) from the edge. */
export const BLANK_SIDE_BAND_MM = 18;
export const BLANK_SIDE_BAND_MAX = 0.15;
/** A pixel is ink when it differs from the paper tone (the median) by more than this; dark ink also needs < INK_THRESHOLD. */
export const BLANK_PAPER_CONTRAST = 40;
/** Ink pixels this close (px, both axes) belong to one mark. */
export const BLANK_MARK_GAP = 3;
/**
 * ink: the largest ink share; mark: the largest mark in pixels at 50 dpi. "normal" is "Blank pages" (the default), "loose" is
 * "Blank and nearly blank pages". Calibrated in docs/milestone-1.5/blank-calibration.md.
 */
export const BLANK_PRESETS = { normal: { ink: 0.0005, mark: 10 }, loose: { ink: 0.005, mark: Infinity } } as const;
export type BlankSensitivity = keyof typeof BLANK_PRESETS;

export interface BlankMeasure {
  ink: number;
  mark: number;
}

/** The ink share and the largest mark of page `index`. */
export function blankMeasure(mu: RenderKit, pdf: Mu.PDFDocument, index: number): BlankMeasure {
  const bounds = displayBounds(pdf, index);
  const scale = BLANK_DPI / 72;
  const width = Math.max(1, Math.ceil((bounds[2] - bounds[0]) * scale));
  const height = Math.max(1, Math.ceil((bounds[3] - bounds[1]) * scale));
  const loaded = pdf.loadPage(index);
  try {
    const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, width, height], false);
    try {
      pixmap.clear(255);
      const matrix: Mu.Matrix = [scale, 0, 0, scale, -bounds[0] * scale, -bounds[1] * scale];
      const device = new mu.DrawDevice(matrix, pixmap);
      try {
        loaded.run(device, mu.Matrix.identity);
      } finally {
        device.close();
        device.destroy();
      }
      return measurePixels(pixmap.getPixels(), pixmap.getStride(), width, height);
    } finally {
      pixmap.destroy();
    }
  } finally {
    loaded.destroy();
  }
}

/** The two numbers of a gray image of `width` x `height` pixels with rows `stride` bytes apart. Pure, so tests can feed pixels. */
export function measurePixels(pixels: Uint8Array, stride: number, width: number, height: number): BlankMeasure {
  const side = Math.min(Math.round((BLANK_SIDE_BAND_MM / 25.4) * BLANK_DPI), Math.floor(width * BLANK_SIDE_BAND_MAX));
  const bx = Math.max(Math.floor(width * BLANK_BORDER), side);
  const by = Math.floor(height * BLANK_BORDER);
  const iw = width - 2 * bx;
  const ih = height - 2 * by;
  if (iw <= 0 || ih <= 0) return { ink: 0, mark: 0 };
  const total = iw * ih;
  const hist = new Uint32Array(256);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) hist[pixels[(y + by) * stride + x + bx]!]!++;
  let paper = 255;
  for (let v = 0, seen = 0; v < 256; v++) {
    seen += hist[v]!;
    if (seen * 2 >= total) {
      paper = v;
      break;
    }
  }
  const low = Math.min(INK_THRESHOLD, paper - BLANK_PAPER_CONTRAST);
  const high = paper + BLANK_PAPER_CONTRAST;
  const mask = new Uint8Array(total);
  let ink = 0;
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const v = pixels[(y + by) * stride + x + bx]!;
      if (v < low || v > high) {
        mask[y * iw + x] = 1;
        ink += 1;
      }
    }
  }
  // Above the widest preset the page is not blank at any setting: the mark is not needed.
  if (ink === 0 || ink > total * BLANK_PRESETS.loose.ink) return { ink: ink / total, mark: ink };
  let mark = 0;
  const stack: number[] = [];
  for (let s = 0; s < total; s++) {
    if (mask[s] !== 1) continue;
    let n = 0;
    mask[s] = 2;
    stack.push(s);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % iw;
      const y = (i - x) / iw;
      n += 1;
      for (let ny = Math.max(0, y - BLANK_MARK_GAP); ny <= Math.min(ih - 1, y + BLANK_MARK_GAP); ny++) {
        for (let nx = Math.max(0, x - BLANK_MARK_GAP); nx <= Math.min(iw - 1, x + BLANK_MARK_GAP); nx++) {
          const j = ny * iw + nx;
          if (mask[j] === 1) {
            mask[j] = 2;
            stack.push(j);
          }
        }
      }
    }
    if (n > mark) mark = n;
  }
  return { ink: ink / total, mark };
}

/** True when a page's numbers are within a preset. */
export function isBlankAt(measure: BlankMeasure, sensitivity: BlankSensitivity): boolean {
  const limit = BLANK_PRESETS[sensitivity];
  return measure.ink <= limit.ink && measure.mark <= limit.mark;
}

/** The 0-based pages that count as blank at the preset. */
export function blankPages(pages: readonly BlankMeasure[], sensitivity: BlankSensitivity): number[] {
  const out: number[] = [];
  pages.forEach((p, index) => {
    if (isBlankAt(p, sensitivity)) out.push(index);
  });
  return out;
}
