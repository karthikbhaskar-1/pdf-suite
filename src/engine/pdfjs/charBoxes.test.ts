// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measureAdvances, proportionalBoxes } from './charBoxes';

describe('proportionalBoxes', () => {
  it('splits the length in proportion to the advances and ends exactly at the length', () => {
    const boxes = proportionalBoxes([2, 1, 1], 40);
    expect(boxes).toEqual([
      { start: 0, end: 20 },
      { start: 20, end: 30 },
      { start: 30, end: 40 },
    ]);
  });

  it('gives equal boxes when every advance is zero', () => {
    expect(proportionalBoxes([0, 0], 10)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ]);
  });

  it('returns nothing for an empty text', () => {
    expect(proportionalBoxes([], 10)).toEqual([]);
  });
});

describe('measureAdvances', () => {
  it('returns null without a canvas, so the caller uses equal shares', () => {
    expect(measureAdvances('abc', 'g_d0_f1', 'Helvetica')).toBeNull();
  });
});
