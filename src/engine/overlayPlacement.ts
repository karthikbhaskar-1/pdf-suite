/**
 * Where an overlay page lies on a base page. One pure function serves the live view (the worker's render) and the applied
 * result (overlayPageAt), so the two cannot disagree: both take the same numbers and call `placementMatrix`.
 *
 * Both pages are measured in display space: the page as the viewer shows it (its CropBox, turned by its /Rotate), in points,
 * with y growing downward. The placement moves the overlay page's display space onto the base page's display space:
 * a point of the overlay page at (x, y) from its top-left corner lands at (dx + scale * x, dy + scale * y) from the base
 * page's top-left corner. `dx` is "Across" (to the right) and `dy` is "Down", the words of the Overlay sheet.
 *
 * No MuPDF and no DOM here, so everything is testable without the WASM.
 */

/** A rectangle [x0, y0, x1, y1] in points. */
export type PlaceRect = readonly [number, number, number, number];
/** A matrix [a, b, c, d, e, f] in PDF order (x' = a*x + c*y + e, y' = b*x + d*y + f). */
export type PlaceMatrix = [number, number, number, number, number, number];

/** The size range of the overlay, as a share of its own size. The sheet shows it as percent (25 to 400). */
export const OVERLAY_SCALE_MIN = 0.25;
export const OVERLAY_SCALE_MAX = 4;

/** The three numbers that place the overlay. Offsets are in points of the base page's display space. */
export interface Placement {
  dx: number;
  dy: number;
  scale: number;
}

/** The placement that leaves the overlay where it is: the corners of the two pages meet at 100 %. */
export const IDENTITY_PLACEMENT: Placement = { dx: 0, dy: 0, scale: 1 };

/** A page's size in points. */
export interface PlaceSize {
  width: number;
  height: number;
}

/** True when `value` is a usable scale (a finite number from 0.25 to 4). */
export function validScale(value: number): boolean {
  return Number.isFinite(value) && value >= OVERLAY_SCALE_MIN && value <= OVERLAY_SCALE_MAX;
}

/** Moves a scale into the allowed range. A value that is not a number gives 1. */
export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(OVERLAY_SCALE_MAX, Math.max(OVERLAY_SCALE_MIN, value));
}

/** The product of two matrices: first `a`, then `b` (a point goes through `a` and then `b`). */
export function concatMatrix(a: PlaceMatrix, b: PlaceMatrix): PlaceMatrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** The inverse of a matrix. Null when it cannot be inverted. */
export function invertMatrix(m: PlaceMatrix): PlaceMatrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

/** A point through a matrix. */
export function mapPoint(m: PlaceMatrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The bounding box of a rectangle through a matrix. */
export function mapRect(m: PlaceMatrix, r: PlaceRect): [number, number, number, number] {
  const corners = [mapPoint(m, r[0], r[1]), mapPoint(m, r[2], r[1]), mapPoint(m, r[2], r[3]), mapPoint(m, r[0], r[3])];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The matrix from the overlay page's display space to the base page's display space. `baseBounds` and `overlayBounds` are the
 * pages' display bounds as MuPDF reports them (their top-left corner is usually (0, 0), and the matrix does not assume it).
 */
export function placementMatrix(baseBounds: PlaceRect, overlayBounds: PlaceRect, placement: Placement): PlaceMatrix {
  const s = placement.scale;
  return [s, 0, 0, s, baseBounds[0] + placement.dx - s * overlayBounds[0], baseBounds[1] + placement.dy - s * overlayBounds[1]];
}

/** The part of the base page that the placed overlay page covers, in the base page's display space. Null when they do not meet. */
export function coveredArea(baseBounds: PlaceRect, overlayBounds: PlaceRect, placement: Placement): [number, number, number, number] | null {
  const placed = mapRect(placementMatrix(baseBounds, overlayBounds, placement), overlayBounds);
  const x0 = Math.max(placed[0], baseBounds[0]);
  const y0 = Math.max(placed[1], baseBounds[1]);
  const x1 = Math.min(placed[2], baseBounds[2]);
  const y1 = Math.min(placed[3], baseBounds[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/**
 * "Fit to page": the largest scale at which the whole overlay page lies inside the base page (kept within 25 % to 400 %),
 * centred on it.
 */
export function fitToPage(base: PlaceSize, overlay: PlaceSize): Placement {
  if (!(base.width > 0 && base.height > 0 && overlay.width > 0 && overlay.height > 0)) return IDENTITY_PLACEMENT;
  const scale = clampScale(Math.min(base.width / overlay.width, base.height / overlay.height));
  return { scale, dx: (base.width - overlay.width * scale) / 2, dy: (base.height - overlay.height * scale) / 2 };
}

/** True when two page sizes differ by more than half a point in either direction ("The overlay page is a different size."). */
export function sizesDiffer(a: PlaceSize, b: PlaceSize): boolean {
  return Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5;
}

/** The overlay modes: the view has three, the applied result two (Differences is for viewing only). */
export type OverlayMode = 'multiply' | 'blend' | 'difference';
export type AppliedMode = Exclude<OverlayMode, 'difference'>;

/** Opacity is a share from 0 to 1. A value that is not a number gives 0.5, the sheet's default. */
export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** Which overlay page goes with the base page at `position` (0-based), or null when there is none. */
export type PageMatch = { kind: 'sequential'; start: number } | { kind: 'fixed'; page: number };

/**
 * The 0-based overlay page for the base page at `position` (0-based), or null when the pairing leaves it without a partner.
 * Sequential: base page 1 gets overlay page `start`, base page 2 the next, and so on (`start` is 1-based, as the sheet shows
 * it). Fixed: every base page gets overlay page `page` (1-based).
 */
export function overlayPageFor(position: number, match: PageMatch, overlayPages: number): number | null {
  const one = match.kind === 'fixed' ? match.page : match.start + position;
  if (!Number.isInteger(one) || one < 1 || one > overlayPages) return null;
  return one - 1;
}
