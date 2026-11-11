import type { PageList } from '../../core/model/pageList';
import { engineIndexOf } from '../../engine/pageRef';
import type { PageSize } from '../../engine/pageSizes';

/** Space between pages and around the sheet, in PDF points (scaled by zoom on screen). */
export const PAGE_GAP_PT = 12;
export const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 };
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
/** The % list of the zoom menu (1.2.2). */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
/** The steps of Zoom In / Zoom Out, the same going up and down (1.5.5 D2). */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const;
/** Margin between the sheet edge and the widest page, in CSS pixels. */
export const SHEET_MARGIN_PX = 12;

/** Left edge of a page on the sheet, in CSS px. Pages are centred, but never closer than the margin. */
export function pageLeftPx(sheetWidth: number, pageWidthPx: number): number {
  return Math.max(SHEET_MARGIN_PX, (sheetWidth - pageWidthPx) / 2);
}

export interface PageBox {
  pageId: string;
  srcIndex: number;
  /** Top edge in points, from the top of the sheet. */
  top: number;
  /** Size in points after the page's rotation is applied. */
  width: number;
  height: number;
}

export interface Layout {
  boxes: PageBox[];
  /** Total height in points, including gaps. */
  height: number;
  /** Widest page in points. */
  width: number;
}

/**
 * Lays pages out top to bottom in points. Pages whose size is still unknown use the first
 * measured size (or the default letter size), and get corrected when measurements arrive.
 */
export function buildLayout(
  pages: PageList,
  sizes: readonly (PageSize | undefined)[],
  viewRotation: number = 0,
): Layout {
  const fallback = sizes[0] ?? sizes.find((s): s is PageSize => s !== undefined) ?? DEFAULT_PAGE_SIZE;
  const boxes: PageBox[] = [];
  let top = PAGE_GAP_PT;
  let widest = 0;
  for (const ref of pages) {
    const engineIndex = engineIndexOf(ref);
    const size = sizes[engineIndex] ?? fallback;
    // Pages turn by their list rotation and by the pane's view rotation. Sizes already include the page's own rotation.
    const turned = (ref.rotation + viewRotation) % 180 !== 0;
    const width = turned ? size.height : size.width;
    const height = turned ? size.width : size.height;
    boxes.push({ pageId: ref.id, srcIndex: engineIndex, top, width, height });
    widest = Math.max(widest, width);
    top += height + PAGE_GAP_PT;
  }
  return { boxes, height: top, width: widest };
}

/** Index of the box that contains `pointY` (in points). Clamps to the first and last box. */
export function indexAtPoint(layout: Layout, pointY: number): number {
  const { boxes } = layout;
  if (boxes.length === 0) return -1;
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const box = boxes[mid];
    if (box && box.top <= pointY) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The page at the top of the viewport and how far into it the viewport top is. */
export function anchorAt(layout: Layout, pointY: number): { index: number; fraction: number } {
  const index = indexAtPoint(layout, pointY);
  const box = layout.boxes[index];
  if (!box || index < 0) return { index: 0, fraction: 0 };
  const fraction = box.height > 0 ? Math.min(1, Math.max(0, (pointY - box.top) / box.height)) : 0;
  return { index, fraction };
}

/**
 * The page the user is on. Normally that is the page at the top of the viewer (anchorAt). Two cases cannot be read from the
 * top: the last pages, which the viewer cannot scroll up to the top (a short last page never reaches it), so
 * - after an explicit jump to page n, the current page is n for as long as the viewer stays where the jump left it
 *   (`jumpIndex`), and
 * - scrolled to the very end (`atEnd`), the current page is the last page.
 */
export function currentAnchor(
  layout: Layout,
  pointY: number,
  options: { atEnd: boolean; jumpIndex?: number | null },
): { index: number; fraction: number } {
  const last = layout.boxes.length - 1;
  if (last < 0) return { index: 0, fraction: 0 };
  if (options.jumpIndex !== undefined && options.jumpIndex !== null) {
    return { index: Math.min(Math.max(options.jumpIndex, 0), last), fraction: 0 };
  }
  const top = anchorAt(layout, pointY);
  if (options.atEnd && top.index < last) return { index: last, fraction: 0 };
  return top;
}

/**
 * True when the viewer's measured size is the one the page last re-anchored for. When a pane changes size (a side sheet or an
 * info bar opens or closes, the window is resized) the browser may clamp the scroll position and send a scroll event BEFORE the
 * page has seen the new size (the resize observer runs after the scroll events of a frame). Such an event is not the user
 * scrolling: reading the current page from it would move the pane to another page, so the viewer waits for its re-anchor.
 */
export function viewportSettled(measured: { width: number; height: number }, seen: { width: number; height: number }): boolean {
  return measured.width === seen.width && measured.height === seen.height;
}

/**
 * What a scroll event does with the pane's size. A settled pane handles the scroll. An unsettled one does not (see
 * viewportSettled) and ADOPTS the measured size, so the pane re-anchors and settles: the guard must not fail closed. A pane that
 * moved or was resized without a resize-observer event (the browser snaps the size to fractional positions) would otherwise
 * ignore every later scroll, and the page box would stop following the user.
 */
export function onScrollViewport(
  measured: { width: number; height: number },
  seen: { width: number; height: number },
): { handle: boolean; adopt: { width: number; height: number } | null } {
  if (viewportSettled(measured, seen)) return { handle: true, adopt: null };
  return { handle: false, adopt: { width: measured.width, height: measured.height } };
}

/** Where an explicit jump left the viewer (see currentAnchor's `jumpIndex`). */
export interface JumpState {
  index: number;
  scrollTop: number;
}

/**
 * A jump is only good while the viewer stays where the jump left it. When the viewer itself moves the scroll position to keep
 * its anchor (the panes changed size: a side sheet opened or closed, the window was resized, a split was toggled, the fit
 * zoom changed), that is not the user moving away: the jump moves with the viewer, so the page jumped to stays the current
 * page. The scroll position before the move cannot be compared with the jump's (the browser has already clamped it when the
 * page height changed), so the viewer's anchor decides: a jump to the page the viewer is anchored on moves with it, and a jump
 * to any other page is dropped. (A user who scrolls away has already dropped the jump, see the viewer's scroll handler.)
 */
export function keepJump(jump: JumpState | null, anchorIndex: number, scrollTopAfter: number): JumpState | null {
  if (jump === null || jump.index !== anchorIndex) return null;
  return { index: jump.index, scrollTop: scrollTopAfter };
}

/**
 * Browsers round scrollTop to whole device pixels, so a position set exactly on a page's top edge
 * is read back a fraction of a pixel above it, which selects the page before. This is the
 * tolerance added when turning a scrollTop into a point, so it agrees with scrollForAnchor.
 */
export const SCROLL_SNAP_PX = 1;

/** The point (in points from the sheet top) at the top of the viewer, allowing for scroll rounding. */
export function topPointAt(scrollTop: number, zoom: number): number {
  return (scrollTop + SCROLL_SNAP_PX) / zoom;
}

/**
 * Scroll position (in CSS px) that puts `fraction` of box `index` at `screenY` px below the
 * top of the scroller.
 */
export function scrollForAnchor(layout: Layout, index: number, fraction: number, zoom: number, screenY: number): number {
  const box = layout.boxes[index];
  if (!box) return 0;
  return Math.max(0, (box.top + fraction * box.height) * zoom - screenY);
}

/** Inclusive index range of boxes intersecting the viewport, widened by `overscan` pages on each side. */
export function visibleRange(
  layout: Layout,
  scrollTop: number,
  viewportHeight: number,
  zoom: number,
  overscan: number,
): { first: number; last: number } {
  const { boxes } = layout;
  if (boxes.length === 0) return { first: 0, last: -1 };
  const topPt = scrollTop / zoom;
  const bottomPt = (scrollTop + viewportHeight) / zoom;
  let first = indexAtPoint(layout, topPt);
  let last = indexAtPoint(layout, bottomPt);
  first = Math.max(0, first - overscan);
  last = Math.min(boxes.length - 1, last + overscan);
  return { first, last };
}

/** Indexes of the boxes that intersect the viewport, without overscan. */
export function visibleIndexes(layout: Layout, scrollTop: number, viewportHeight: number, zoom: number): number[] {
  const { first, last } = visibleRange(layout, scrollTop, viewportHeight, zoom, 0);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/** The next step of ZOOM_STEPS above or below `zoom` (the nearest one in that direction); it stays at the ends (10% and 800%). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = ZOOM_STEPS.find((z) => z > zoom + 1e-6);
    return clampZoom(next ?? zoom);
  }
  const previous = [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6);
  return clampZoom(previous ?? zoom);
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** Zoom that fits a page of `box` (points) into a viewport of `viewportW` x `viewportH` px. */
export function fitZoom(mode: 'width' | 'page', box: PageSize, viewportW: number, viewportH: number): number {
  // The sheet's side margins are in screen pixels (SHEET_MARGIN_PX on each side).
  const byWidth = (viewportW - SHEET_MARGIN_PX * 2) / Math.max(1, box.width);
  if (mode === 'width') return clampZoom(byWidth);
  // Fit page: the page's height is the viewer's height. The sheet's top and bottom gaps are scrolled past when the page is
  // anchored (scrollForAnchor), so they do not reduce the fit. Subtracting them left the page short of the viewer's edge.
  const byHeight = viewportH / Math.max(1, box.height);
  return clampZoom(Math.min(byWidth, byHeight));
}
