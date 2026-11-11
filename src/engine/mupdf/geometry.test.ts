// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { displayTransform, normalizeRotation, readXfaFacts } from './core';
import { rotateRun } from './textLayer';
import type { RunData } from './protocol';

/** Applies a mupdf-style matrix [a, b, c, d, e, f] to a point. */
function apply(m: readonly number[], p: { x: number; y: number }) {
  return { x: m[0]! * p.x + m[2]! * p.y + m[4]!, y: m[1]! * p.x + m[3]! * p.y + m[5]! };
}

describe('normalizeRotation', () => {
  it('rounds to the nearest quarter turn, in 0 to 270', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-360)).toBe(0);
  });
});

describe('displayTransform', () => {
  const page = { x0: 0, y0: 0, x1: 612, y1: 792 };

  it('keeps an unrotated page where it is', () => {
    const t = displayTransform(page, 0);
    expect(t.width).toBe(612);
    expect(t.height).toBe(792);
    expect(apply(t.matrix, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('turns clockwise: the top-left corner goes to the top-right after 90 degrees', () => {
    const t = displayTransform(page, 90);
    expect(t.width).toBe(792);
    expect(t.height).toBe(612);
    const corner = apply(t.matrix, { x: 0, y: 0 });
    expect(corner.x).toBeCloseTo(792, 6);
    expect(corner.y).toBeCloseTo(0, 6);
  });

  it('maps the page into the positive quadrant for every turn', () => {
    for (const turn of [0, 90, 180, 270] as const) {
      const t = displayTransform(page, turn);
      for (const corner of [
        { x: 0, y: 0 },
        { x: 612, y: 0 },
        { x: 0, y: 792 },
        { x: 612, y: 792 },
      ]) {
        const p = apply(t.matrix, corner);
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(t.width + 1e-6);
        expect(p.y).toBeLessThanOrEqual(t.height + 1e-6);
      }
    }
  });
});

describe('rotateRun agrees with the bitmap transform', () => {
  // The same point must land on the same place whether a text run or the rendered bitmap is rotated.
  const run: RunData = {
    text: 'A',
    origin: { x: 100, y: 200 },
    along: { x: 10, y: 0 },
    up: { x: 0, y: -12 },
    bounds: new Float32Array([0, 10]),
    boundsAt: 0,
  };
  const page = { x0: 0, y0: 0, x1: 612, y1: 792 };

  for (const turn of [90, 180, 270] as const) {
    it(`matches at ${turn} degrees`, () => {
      const t = displayTransform(page, turn);
      const rotated = rotateRun(run, 612, 792, turn);
      const fromBitmap = apply(t.matrix, run.origin);
      expect(rotated.origin.x).toBeCloseTo(fromBitmap.x, 6);
      expect(rotated.origin.y).toBeCloseTo(fromBitmap.y, 6);
      // The advance vector is rotated the same way as the points.
      const alongEnd = apply(t.matrix, { x: run.origin.x + run.along.x, y: run.origin.y + run.along.y });
      expect(rotated.origin.x + rotated.along.x).toBeCloseTo(alongEnd.x, 6);
      expect(rotated.origin.y + rotated.along.y).toBeCloseTo(alongEnd.y, 6);
    });
  }

  it('leaves a run alone at zero degrees', () => {
    expect(rotateRun(run, 612, 792, 0)).toBe(run);
  });
});

describe('readXfaFacts', () => {
  it('reports no XFA for a missing document', () => {
    expect(readXfaFacts(null)).toEqual({ needsRendering: false, xfaPresent: false, fieldCount: 0 });
  });
});
