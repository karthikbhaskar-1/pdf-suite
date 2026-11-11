import { knobs } from '../../engine/testKnobs';

/** A fast-scroll bitmap is about half the on-screen device pixels, and never more than this many pixels. */
export const LOW_SCALE_FACTOR = knobs.lowScaleFactor;
export const LOW_MAX_PIXELS = knobs.lowMaxPixels;

/**
 * The render scale for a page while scrolling fast. `scale` is the full scale (zoom times device pixel ratio),
 * and `cssWidth` / `cssHeight` are the page's size on screen. Returns the smaller of half the full scale and
 * the scale that keeps the bitmap within LOW_MAX_PIXELS.
 */
export function fastScale(scale: number, cssWidth: number, cssHeight: number, dpr: number): number {
  const fullPixels = Math.max(1, cssWidth * dpr * cssHeight * dpr);
  return scale * Math.min(LOW_SCALE_FACTOR, Math.sqrt(LOW_MAX_PIXELS / fullPixels));
}

/**
 * A page is never rendered above this many pixels (8 MP, 32 MB as a bitmap, and a canvas of the same size). A page that
 * would need more renders at the capped scale and is stretched on screen: a brochure page reaches the cap at about
 * 430% zoom, a Letter page at about 405%. Sharp rendering above that is tiled rendering (Version 2). The engine keeps
 * its own, higher limit as a backstop (core.ts MAX_CANVAS_PIXELS).
 */
export const PAGE_MAX_PIXELS = 8_000_000;

/**
 * A page that does not intersect the viewport keeps its full-resolution bitmap only while that bitmap is no larger than this
 * (3 MP, 12 MB). A larger neighbour renders at the lower first-pass scale (see fastScale) and sharpens when it scrolls in.
 * Why 3 MP: a bitmap this large is a page taller than the viewport in practice (the ruling's rule "once a page is taller than
 * the viewport"; a 1,141 x 656 viewport at 1x shows 0.75 MP), while the smaller pages of normal reading (a Letter page at 100%
 * to 200% is 0.9 to 3 MP) keep their neighbours sharp, so scrolling at those zooms is unchanged. It is a pixel count, not a
 * viewport height, because the 100% page is taller than a laptop viewport and must not go soft.
 */
export const NEIGHBOUR_FULL_MAX_PIXELS = 3_000_000;

/** The full scale for a page: zoom times device pixel ratio, lowered so the bitmap stays within PAGE_MAX_PIXELS. */
export function cappedScale(scale: number, cssWidth: number, cssHeight: number, dpr: number): number {
  const fullPixels = Math.max(1, cssWidth * dpr * cssHeight * dpr);
  return scale * Math.min(1, Math.sqrt(PAGE_MAX_PIXELS / fullPixels));
}

export interface PageScales {
  /** The scale of the full-resolution bitmap (capped). */
  scale: number;
  /** The scale of the lower-resolution first pass. */
  lowScale: number;
  /** True when the page may hold its full-resolution bitmap now: it intersects the viewport, or the bitmap is small. */
  wantsFull: boolean;
}

/**
 * Which resolutions a page renders at. Only a page that intersects the viewport (`inView`) gets a full-resolution bitmap
 * above NEIGHBOUR_FULL_MAX_PIXELS; its neighbours (kept mounted as overscan) render at the lower first-pass scale.
 */
export function pageScales(scale: number, cssWidth: number, cssHeight: number, dpr: number, inView: boolean): PageScales {
  const capped = cappedScale(scale, cssWidth, cssHeight, dpr);
  const cappedPixels = cssWidth * dpr * cssHeight * dpr * (capped / scale) ** 2;
  return {
    scale: capped,
    lowScale: Math.min(capped, fastScale(scale, cssWidth, cssHeight, dpr)),
    wantsFull: inView || cappedPixels <= NEIGHBOUR_FULL_MAX_PIXELS,
  };
}
