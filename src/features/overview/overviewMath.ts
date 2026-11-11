/**
 * Pan-and-zoom math. The overview shows one page. The rectangle on it is the part of that page
 * that the viewer currently shows. Dragging the rectangle scrolls the viewer, and scrolling the
 * viewer moves the rectangle.
 */

/** Scroll state of a viewer, in CSS pixels of its sheet. */
export interface ScrollGeometry {
  scrollLeft: number;
  scrollTop: number;
  viewWidth: number;
  viewHeight: number;
}

/** Where a page sits on the sheet, in CSS pixels. */
export interface PageBoxPx {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rectangle in page fractions (0..1). `w` and `h` may be 1 when the viewer shows the whole page. */
export interface PageRectFraction {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The part of the page that is inside the viewer, as fractions of the page. Empty when off-page. */
export function viewportOnPage(geometry: ScrollGeometry, page: PageBoxPx): PageRectFraction {
  if (page.width <= 0 || page.height <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = clamp01((geometry.scrollLeft - page.left) / page.width);
  const x1 = clamp01((geometry.scrollLeft + geometry.viewWidth - page.left) / page.width);
  const y0 = clamp01((geometry.scrollTop - page.top) / page.height);
  const y1 = clamp01((geometry.scrollTop + geometry.viewHeight - page.top) / page.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Scroll offsets that put the top-left of the viewer at fraction (x, y) of the page. An axis the
 * viewer can show in full is left alone (`null`), because it cannot scroll along that axis.
 */
export function scrollForPageFraction(
  page: PageBoxPx,
  fraction: { x: number; y: number },
  viewerFullyShowsWidth: boolean,
): { scrollLeft: number | null; scrollTop: number } {
  const scrollTop = page.top + clamp01(fraction.y) * page.height;
  const scrollLeft = viewerFullyShowsWidth ? null : page.left + clamp01(fraction.x) * page.width;
  return { scrollLeft, scrollTop };
}
