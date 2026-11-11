import { describe, expect, it } from 'vitest';
import { effectiveRotation, nextRotation, rotateRect, swapsAxes } from './rotation';

describe('rotation helpers', () => {
  it('turns clockwise and wraps at 360', () => {
    expect(nextRotation(0)).toBe(90);
    expect(nextRotation(270)).toBe(0);
  });

  it('adds the page list rotation to the view rotation', () => {
    expect(effectiveRotation(90, 270)).toBe(0);
    expect(effectiveRotation(0, 90)).toBe(90);
  });

  it('reports which rotations swap width and height', () => {
    expect(swapsAxes(0)).toBe(false);
    expect(swapsAxes(90)).toBe(true);
    expect(swapsAxes(180)).toBe(false);
  });

  it('maps a rectangle clockwise by 90 degrees', () => {
    // Box 100 x 50. The top-left corner strip becomes the top-right strip of the 50 x 100 box.
    expect(rotateRect({ x: 0, y: 0, width: 10, height: 5 }, 100, 50, 90)).toEqual({
      x: 45,
      y: 0,
      width: 5,
      height: 10,
    });
  });

  it('maps a rectangle by 180 degrees to the opposite corner', () => {
    expect(rotateRect({ x: 0, y: 0, width: 10, height: 5 }, 100, 50, 180)).toEqual({
      x: 90,
      y: 45,
      width: 10,
      height: 5,
    });
  });

  it('four quarter turns return the rectangle to where it started', () => {
    const start = { x: 12, y: 7, width: 20, height: 3 };
    let rect = start;
    let w = 100;
    let h = 50;
    for (const r of [90, 90, 90, 90] as const) {
      rect = rotateRect(rect, w, h, r);
      [w, h] = [h, w];
    }
    expect(rect).toEqual(start);
  });
});
