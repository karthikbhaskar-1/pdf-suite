/**
 * Overlay, the live view (1.3.4): how one page of the overlay file is blended into the bitmap the worker already makes for a
 * base page. The result is one bitmap, so the bitmap budget and the cache sizes do not change.
 *
 * Both functions work in the base page's display space and take the placement matrix of overlayPlacement.ts (overlay display
 * space to base display space); the draw device's own matrix then takes it to pixels, as for the plain page.
 *
 * - Multiply and Blend ("Both" and "See-through"): the overlay is run into an isolated device group over the page, with the
 *   blend mode of the applied result (Multiply, or Normal at the chosen opacity). It is the same compositing MuPDF does for the
 *   page the edit writes (a /BM and /ca around a Form XObject with a transparency group), so the view and the result agree.
 *   No second pixmap is needed.
 * - Differences (view only): the overlay is drawn on white into a second pixmap, and each pixel becomes
 *   R = luma(overlay), G = B = luma(base). Ink only in the base is red, ink only in the overlay is cyan, ink in both is black.
 *
 * The overlay's annotations are not drawn (only its page contents), because "Add overlay" does not copy them either.
 */
import type * as Mu from 'mupdf';
import type { PlaceMatrix } from '../overlayPlacement';

export type ComposeMu = Pick<typeof Mu, 'Pixmap' | 'ColorSpace' | 'DrawDevice'>;

/** The overlay page's contents, into an isolated group of `device` over `area` (base display space). Call before closing the device. */
export function drawOverlayGroup(
  mu: Pick<typeof Mu, 'ColorSpace'>,
  device: Mu.Device,
  overlayPage: Mu.Page,
  placement: PlaceMatrix,
  area: [number, number, number, number],
  mode: 'multiply' | 'blend',
  opacity: number,
): void {
  device.beginGroup(area, mu.ColorSpace.DeviceRGB, true, false, mode === 'multiply' ? 'Multiply' : 'Normal', mode === 'multiply' ? 1 : opacity);
  try {
    overlayPage.runPageContents(device, placement);
  } finally {
    device.endGroup();
  }
}

/** Integer luma of an RGB pixel, 0 to 255. */
export function luma(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * Turns the base render in `pixmap` into the Differences picture. `matrix` is the device matrix the base page was drawn with
 * (display space to pixels) and `placement` the overlay's placement. `pixmap` is RGBA, as the worker makes it.
 */
export function differenceInto(
  mu: ComposeMu,
  pixmap: Mu.Pixmap,
  width: number,
  height: number,
  overlayPage: Mu.Page,
  matrix: PlaceMatrix,
  placement: PlaceMatrix,
): void {
  const other = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, width, height], true);
  try {
    other.clear(255);
    const device = new mu.DrawDevice(matrix, other);
    try {
      overlayPage.runPageContents(device, placement);
    } finally {
      device.close();
      device.destroy();
    }
    const base = pixmap.getPixels();
    const over = other.getPixels();
    const baseStride = pixmap.getStride();
    const overStride = other.getStride();
    for (let y = 0; y < height; y++) {
      let bi = y * baseStride;
      let oi = y * overStride;
      for (let x = 0; x < width; x++, bi += 4, oi += 4) {
        const a = luma(base[bi]!, base[bi + 1]!, base[bi + 2]!);
        const b = luma(over[oi]!, over[oi + 1]!, over[oi + 2]!);
        base[bi] = b;
        base[bi + 1] = a;
        base[bi + 2] = a;
      }
    }
  } finally {
    other.destroy();
  }
}
