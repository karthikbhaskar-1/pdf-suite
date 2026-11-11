import { describe, expect, it } from 'vitest';
import { parsePageRange } from './pageRange';
import { defaultUnitFor, describeSize, fromPoints, sizeInPoints, toPoints } from './units';

describe('parsePageRange', () => {
  it('reads "1-5, 8" as pages 1 to 5 and 8, ascending and without repeats', () => {
    expect(parsePageRange('1-5, 8', 10)).toEqual({ ok: true, pages: [1, 2, 3, 4, 5, 8] });
    expect(parsePageRange('8, 2-3, 3', 10)).toEqual({ ok: true, pages: [2, 3, 8] });
  });

  it('refuses empty, malformed and out-of-range input with a message', () => {
    expect(parsePageRange('', 10)).toMatchObject({ ok: false });
    expect(parsePageRange('1-x', 10)).toMatchObject({ ok: false });
    expect(parsePageRange('5-3', 10)).toMatchObject({ ok: false });
    expect(parsePageRange('11', 10)).toEqual({ ok: false, message: '11 is outside 1-10.' });
  });
});

describe('units and sizes', () => {
  it('converts inches and millimetres to points, and back', () => {
    expect(toPoints(1, 'in')).toBe(72);
    expect(fromPoints(toPoints(25.4, 'mm'), 'mm')).toBe(25.4);
    expect(fromPoints(612, 'in')).toBe(8.5);
    expect(toPoints(7, 'pt')).toBe(7);
  });

  it('A4 and Letter come from presets, custom values from their unit', () => {
    expect(sizeInPoints('letter', { width: 1, height: 1 }, 'in')).toEqual({ width: 612, height: 792 });
    expect(sizeInPoints('a4', { width: 1, height: 1 }, 'in')).toEqual({ width: 595.28, height: 841.89 });
    expect(sizeInPoints('custom', { width: 8.5, height: 11 }, 'in')).toEqual({ width: 612, height: 792 });
    expect(describeSize(612, 792, 'in')).toBe('8.5 × 11 in');
  });

  it('the default unit comes from the locale: inches in the US, millimetres elsewhere', () => {
    expect(defaultUnitFor('en-US')).toBe('in');
    expect(defaultUnitFor('en-GB')).toBe('mm');
    expect(defaultUnitFor('fr-FR')).toBe('mm');
    expect(defaultUnitFor(undefined)).toBe('mm');
  });
});
