// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_STATE, centreIn, parseWindowState, pickTestWorkArea, placeOnDisplays } from './windowState';

describe('parseWindowState', () => {
  it('falls back to defaults for anything that is not an object', () => {
    expect(parseWindowState(null)).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState('big')).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('keeps a valid saved state', () => {
    expect(parseWindowState({ x: 10, y: 20, width: 900, height: 700, maximized: true })).toEqual({
      x: 10,
      y: 20,
      width: 900,
      height: 700,
      maximized: true,
    });
  });

  it('clamps absurd sizes and ignores non-numeric fields', () => {
    const parsed = parseWindowState({ width: 1, height: 1e9, x: 'left', y: 5, maximized: 'yes' });
    expect(parsed.width).toBe(480);
    expect(parsed.height).toBe(20000);
    expect(parsed.x).toBeUndefined();
    expect(parsed.y).toBeUndefined();
    expect(parsed.maximized).toBe(false);
  });
});

describe('placeOnDisplays', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };

  it('keeps a position that is on a visible display', () => {
    const state = { x: 100, y: 100, width: 800, height: 600, maximized: false };
    expect(placeOnDisplays(state, [primary])).toEqual(state);
  });

  it('drops a position on a display that is no longer connected', () => {
    const state = { x: 3000, y: 100, width: 800, height: 600, maximized: false };
    expect(placeOnDisplays(state, [primary])).toEqual({ width: 800, height: 600, maximized: false });
  });

  it('leaves a state without a position unchanged', () => {
    const state = { width: 800, height: 600, maximized: true };
    expect(placeOnDisplays(state, [primary])).toBe(state);
  });
});

describe('pickTestWorkArea', () => {
  const a = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1392 } };
  const b = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1392 } };
  it('picks the first non-primary display', () => {
    expect(pickTestWorkArea([a, b], 1, false)).toBe(b.workArea);
    expect(pickTestWorkArea([b, a], 1, false)).toBe(b.workArea);
  });
  it('falls back to the primary when there is one display or when forced', () => {
    expect(pickTestWorkArea([a], 1, false)).toBe(a.workArea);
    expect(pickTestWorkArea([a, b], 1, true)).toBe(a.workArea);
  });
});

describe('centreIn', () => {
  it('centres and shrinks to fit', () => {
    const area = { x: 1920, y: 0, width: 1280, height: 1392 };
    expect(centreIn(area, 1200, 800)).toEqual({ x: 1960, y: 296, width: 1200, height: 800 });
    expect(centreIn(area, 5000, 5000)).toEqual(area);
  });
});
