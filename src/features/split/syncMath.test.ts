import { describe, expect, it } from 'vitest';
import { clampPagePosition, clampSplitRatio, splitKeyRatio, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from './syncMath';

describe('clampPagePosition', () => {
  it('keeps a position inside the document, from the top of page 1 to the bottom of the last page', () => {
    expect(clampPagePosition(4.25, 10)).toBe(4.25);
    expect(clampPagePosition(0, 10)).toBe(0);
    expect(clampPagePosition(10, 10)).toBe(10);
  });

  it('stops at both ends of the document, so the pane does not run past them', () => {
    expect(clampPagePosition(-3.5, 10)).toBe(0);
    expect(clampPagePosition(12.7, 10)).toBe(10);
  });

  it('returns 0 for an empty document or a position that is not a number', () => {
    expect(clampPagePosition(5, 0)).toBe(0);
    expect(clampPagePosition(Number.NaN, 10)).toBe(0);
  });
});

describe('relative sync keeps the gap between panes', () => {
  it('moves two panes by the same amount, so 285 pages apart stay 285 pages apart', () => {
    let a = 15;
    let b = 300;
    for (const step of [0.5, 2, -1.25, 7]) {
      a = clampPagePosition(a + step, 1000);
      b = clampPagePosition(b + step, 1000);
    }
    expect(b - a).toBeCloseTo(285, 9);
  });
});

describe('clampSplitRatio', () => {
  it('keeps the divider between the minimum and maximum shares', () => {
    expect(clampSplitRatio(0.01)).toBe(SPLIT_RATIO_MIN);
    expect(clampSplitRatio(0.99)).toBe(SPLIT_RATIO_MAX);
    expect(clampSplitRatio(0.4)).toBe(0.4);
  });

  it('falls back to the middle for values that are not numbers', () => {
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
  });
});

describe('splitKeyRatio', () => {
  it('moves 2% per arrow press and 10% with Shift', () => {
    expect(splitKeyRatio(0.5, 'ArrowRight', false, 'vertical')).toBeCloseTo(0.52);
    expect(splitKeyRatio(0.5, 'ArrowLeft', true, 'vertical')).toBeCloseTo(0.4);
  });

  it('uses the arrows that run across the divider for each orientation', () => {
    expect(splitKeyRatio(0.5, 'ArrowDown', false, 'horizontal')).toBeCloseTo(0.52);
    expect(splitKeyRatio(0.5, 'ArrowRight', false, 'horizontal')).toBeNull();
  });

  it('goes to the limits with Home and End', () => {
    expect(splitKeyRatio(0.5, 'Home', false, 'vertical')).toBe(SPLIT_RATIO_MIN);
    expect(splitKeyRatio(0.5, 'End', false, 'vertical')).toBe(SPLIT_RATIO_MAX);
  });

  it('stops at the limits', () => {
    expect(splitKeyRatio(SPLIT_RATIO_MAX, 'ArrowRight', true, 'vertical')).toBe(SPLIT_RATIO_MAX);
    expect(splitKeyRatio(SPLIT_RATIO_MIN, 'ArrowLeft', false, 'vertical')).toBe(SPLIT_RATIO_MIN);
  });
});
