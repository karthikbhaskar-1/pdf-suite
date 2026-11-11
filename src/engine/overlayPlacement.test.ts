// 1.3.4 Compare overlay: the placement maths. Pure, no MuPDF.
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_PLACEMENT,
  OVERLAY_SCALE_MAX,
  OVERLAY_SCALE_MIN,
  clampOpacity,
  clampScale,
  concatMatrix,
  coveredArea,
  fitToPage,
  invertMatrix,
  mapPoint,
  mapRect,
  overlayPageFor,
  placementMatrix,
  sizesDiffer,
  validScale,
  type PlaceMatrix,
} from './overlayPlacement';

describe('placementMatrix', () => {
  it('leaves the overlay where it is at 100 % with no offset (the corners meet)', () => {
    const m = placementMatrix([0, 0, 600, 400], [0, 0, 300, 200], IDENTITY_PLACEMENT);
    expect(mapPoint(m, 10, 20)).toEqual([10, 20]);
  });

  it('moves by Across and Down and scales about the overlay page corner', () => {
    const m = placementMatrix([0, 0, 600, 400], [0, 0, 300, 200], { dx: 50, dy: 20, scale: 2 });
    expect(mapPoint(m, 0, 0)).toEqual([50, 20]);
    expect(mapPoint(m, 10, 10)).toEqual([70, 40]);
    expect(mapPoint(m, 300, 200)).toEqual([650, 420]);
  });

  it('does not assume the bounds start at the origin', () => {
    const m = placementMatrix([10, 5, 610, 405], [100, 50, 400, 250], { dx: 0, dy: 0, scale: 1 });
    // The overlay's own corner (100, 50) lands on the base page's corner (10, 5).
    expect(mapPoint(m, 100, 50)).toEqual([10, 5]);
    expect(mapPoint(m, 130, 80)).toEqual([40, 35]);
  });
});

describe('matrices', () => {
  it('concat applies the first matrix and then the second', () => {
    const scale2: PlaceMatrix = [2, 0, 0, 2, 0, 0];
    const move: PlaceMatrix = [1, 0, 0, 1, 10, 0];
    expect(mapPoint(concatMatrix(scale2, move), 3, 4)).toEqual([16, 8]);
    expect(mapPoint(concatMatrix(move, scale2), 3, 4)).toEqual([26, 8]);
  });

  it('invert undoes a matrix, and refuses a flat one', () => {
    const m: PlaceMatrix = [0, 1, -1, 0, 30, 7];
    const inverse = invertMatrix(m)!;
    const [x, y] = mapPoint(m, 12, 34);
    const back = mapPoint(inverse, x, y);
    expect(back[0]).toBeCloseTo(12, 9);
    expect(back[1]).toBeCloseTo(34, 9);
    expect(invertMatrix([0, 0, 0, 0, 1, 1])).toBeNull();
  });

  it('mapRect gives the bounding box of a turned rectangle', () => {
    expect(mapRect([0, 1, -1, 0, 0, 0], [0, 0, 10, 20])).toEqual([-20, 0, 0, 10]);
  });
});

describe('fitToPage', () => {
  it('scales the overlay to the largest size that fits, centred', () => {
    const fit = fitToPage({ width: 600, height: 400 }, { width: 300, height: 100 });
    expect(fit.scale).toBe(2);
    expect(fit.dx).toBe(0);
    expect(fit.dy).toBe(100);
  });

  it('keeps the scale inside 25 % to 400 %', () => {
    expect(fitToPage({ width: 6000, height: 4000 }, { width: 10, height: 10 }).scale).toBe(OVERLAY_SCALE_MAX);
    expect(fitToPage({ width: 10, height: 10 }, { width: 6000, height: 4000 }).scale).toBe(OVERLAY_SCALE_MIN);
  });

  it('gives the identity for a page without a size', () => {
    expect(fitToPage({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual(IDENTITY_PLACEMENT);
  });

  it('puts the fitted overlay page inside the base page', () => {
    const base = { width: 612, height: 792 };
    const overlay = { width: 842, height: 595 };
    const fit = fitToPage(base, overlay);
    const placed = mapRect(placementMatrix([0, 0, base.width, base.height], [0, 0, overlay.width, overlay.height], fit), [0, 0, overlay.width, overlay.height]);
    expect(placed[0]).toBeGreaterThanOrEqual(-1e-9);
    expect(placed[1]).toBeGreaterThanOrEqual(-1e-9);
    expect(placed[2]).toBeLessThanOrEqual(base.width + 1e-9);
    expect(placed[3]).toBeLessThanOrEqual(base.height + 1e-9);
  });
});

describe('coveredArea', () => {
  it('is the part of the base page the placed overlay covers', () => {
    expect(coveredArea([0, 0, 600, 400], [0, 0, 300, 200], { dx: 400, dy: 300, scale: 1 })).toEqual([400, 300, 600, 400]);
  });

  it('is null when the overlay lies wholly off the page', () => {
    expect(coveredArea([0, 0, 600, 400], [0, 0, 300, 200], { dx: 700, dy: 0, scale: 1 })).toBeNull();
  });
});

describe('scale, opacity and size rules', () => {
  it('validScale accepts 0.25 to 4 only', () => {
    expect(validScale(0.25)).toBe(true);
    expect(validScale(4)).toBe(true);
    expect(validScale(0.2)).toBe(false);
    expect(validScale(4.01)).toBe(false);
    expect(validScale(Number.NaN)).toBe(false);
  });

  it('clamps', () => {
    expect(clampScale(10)).toBe(4);
    expect(clampScale(0)).toBe(0.25);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampOpacity(2)).toBe(1);
    expect(clampOpacity(-1)).toBe(0);
    expect(clampOpacity(Number.NaN)).toBe(0.5);
  });

  it('sizesDiffer ignores half a point', () => {
    expect(sizesDiffer({ width: 612, height: 792 }, { width: 612.4, height: 791.7 })).toBe(false);
    expect(sizesDiffer({ width: 612, height: 792 }, { width: 595, height: 842 })).toBe(true);
  });
});

describe('overlayPageFor (which overlay page goes with a page)', () => {
  it('sequential: the overlay starts at page `start` and goes on one page for each base page', () => {
    const match = { kind: 'sequential', start: 3 } as const;
    expect(overlayPageFor(0, match, 5)).toBe(2);
    expect(overlayPageFor(1, match, 5)).toBe(3);
    expect(overlayPageFor(2, match, 5)).toBe(4);
    // Past the end of the overlay file: no partner.
    expect(overlayPageFor(3, match, 5)).toBeNull();
  });

  it('sequential from 1 on equal files pairs page for page', () => {
    for (let i = 0; i < 4; i++) expect(overlayPageFor(i, { kind: 'sequential', start: 1 }, 4)).toBe(i);
  });

  it('fixed: every page gets the same overlay page', () => {
    for (let i = 0; i < 6; i++) expect(overlayPageFor(i, { kind: 'fixed', page: 2 }, 5)).toBe(1);
  });

  it('refuses a start or fixed page outside the overlay file', () => {
    expect(overlayPageFor(0, { kind: 'fixed', page: 0 }, 5)).toBeNull();
    expect(overlayPageFor(0, { kind: 'fixed', page: 6 }, 5)).toBeNull();
    expect(overlayPageFor(0, { kind: 'sequential', start: 0 }, 5)).toBeNull();
    expect(overlayPageFor(0, { kind: 'sequential', start: 1.5 }, 5)).toBeNull();
  });
});
