// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LOW_MAX_PIXELS, NEIGHBOUR_FULL_MAX_PIXELS, PAGE_MAX_PIXELS, cappedScale, fastScale, pageScales } from './progressiveScale';

describe('fastScale', () => {
  it('renders a small page at half the full scale', () => {
    // 400 x 500 css px at 1x: well under 2 MP full size, so half the full scale.
    expect(fastScale(1, 400, 500, 1)).toBeCloseTo(0.5, 6);
  });

  it('keeps a large page within 2 MP', () => {
    // 2000 x 2000 css px at 2x: 16 MP at full scale, so the cap (not half the scale) decides.
    const full = 2;
    const low = fastScale(full, 2000, 2000, 2);
    const pixels = 4000 * 4000 * (low / full) ** 2;
    expect(pixels).toBeLessThanOrEqual(LOW_MAX_PIXELS * 1.0001);
    expect(low).toBeLessThan(full * 0.5);
  });

  it('never returns more than the full scale', () => {
    expect(fastScale(1, 10, 10, 1)).toBeLessThanOrEqual(1);
  });
});

describe('cappedScale (8 MP per page)', () => {
  it('leaves a page under the cap at its full scale', () => {
    // A brochure page (555 x 771 pt) at 400% and a device pixel ratio of 1: 2220 x 3084 = 6.8 MP.
    expect(cappedScale(4, 555 * 4, 771 * 4, 1)).toBe(4);
  });

  it('lowers a page over the cap so it holds exactly 8 MP', () => {
    // At 625% the page would be 16.5 MP.
    const scale = cappedScale(6.25, 555 * 6.25, 771 * 6.25, 1);
    expect(scale).toBeLessThan(6.25);
    const pixels = 555 * scale * (771 * scale);
    expect(pixels).toBeCloseTo(PAGE_MAX_PIXELS, -3);
  });

  it('reaches the cap at about 430% for the brochure page and 405% for a Letter page', () => {
    expect(cappedScale(4.3, 555 * 4.3, 771 * 4.3, 1)).toBeCloseTo(4.3, 1);
    expect(cappedScale(4.4, 555 * 4.4, 771 * 4.4, 1)).toBeLessThan(4.4);
    expect(cappedScale(4.05, 612 * 4.05, 792 * 4.05, 1)).toBeCloseTo(4.05, 1);
    expect(cappedScale(4.2, 612 * 4.2, 792 * 4.2, 1)).toBeLessThan(4.2);
  });

  it('counts device pixels, not css pixels', () => {
    const scale = cappedScale(2 * 3, 612 * 2, 792 * 2, 3);
    expect(612 * scale * (792 * scale)).toBeLessThanOrEqual(PAGE_MAX_PIXELS * 1.0001);
  });

  it('never raises the scale', () => {
    expect(cappedScale(0.25, 150, 200, 1)).toBe(0.25);
  });
});

describe('pageScales: which pages get full resolution', () => {
  const page = { w: 555, h: 771 };
  const at = (zoom: number, inView: boolean, dpr = 1) => pageScales(zoom * dpr, page.w * zoom, page.h * zoom, dpr, inView);

  it('a page in the viewport always wants full resolution', () => {
    for (const zoom of [0.87, 2, 4, 6.25, 8]) expect(at(zoom, true).wantsFull).toBe(true);
  });

  it('a neighbour keeps full resolution while its bitmap is small (3 MP or less)', () => {
    expect(at(0.87, false).wantsFull).toBe(true);
    expect(at(1.25, false).wantsFull).toBe(true);
    // 200%: 1110 x 1542 = 1.7 MP
    expect(at(2, false).wantsFull).toBe(true);
  });

  it('a neighbour of a large page renders at the low first pass instead', () => {
    // 400%: 6.8 MP; 625% and 800% are capped to 8 MP, still over 3 MP.
    for (const zoom of [4, 6.25, 8]) {
      const scales = at(zoom, false);
      expect(scales.wantsFull).toBe(false);
      const lowPixels = page.w * zoom * page.h * zoom * (scales.lowScale / zoom) ** 2;
      expect(lowPixels).toBeLessThanOrEqual(LOW_MAX_PIXELS * 1.0001);
    }
  });

  it('the threshold is the capped bitmap size: 3 MP is full, just over is not', () => {
    // A square page of side s css px at dpr 1 holds s * s pixels.
    const side = Math.sqrt(NEIGHBOUR_FULL_MAX_PIXELS);
    expect(pageScales(1, side, side, 1, false).wantsFull).toBe(true);
    expect(pageScales(1, side * 1.01, side * 1.01, 1, false).wantsFull).toBe(false);
  });

  it('the full scale is capped and the low scale never exceeds it', () => {
    const big = at(8, true);
    expect(big.scale).toBeLessThan(8);
    expect(big.lowScale).toBeLessThan(big.scale);
    const small = at(0.5, true);
    expect(small.scale).toBe(0.5);
    expect(small.lowScale).toBeLessThanOrEqual(small.scale);
  });

  it('a page holds at most 8 MP at any zoom up to 800%', () => {
    for (const zoom of [4.5, 5, 6.25, 8]) {
      const s = at(zoom, true);
      expect(page.w * zoom * page.h * zoom * (s.scale / zoom) ** 2).toBeLessThanOrEqual(PAGE_MAX_PIXELS * 1.0001);
    }
  });
});
