// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { soakCriteria } from './soak-criteria.mjs';

const series40 = [420, 449, 441, 426, 586, 570, 578, 582, 576, 584, 594, 582, 610, 611, 609, 607, 621, 601, 615, 599, 591, 595, 602, 592, 599, 601, 594, 596, 606, 607, 605, 612, 613, 607, 616, 616, 613, 614, 622, 606];
const flat = (n = 24, v = 600) => Array.from({ length: n }, (_, i) => v + (i % 3));

describe('soakCriteria', () => {
  it('passes a flat plateau', () => {
    const c = soakCriteria(flat(), 603);
    expect(c.pass).toBe(true);
    expect(c.window).toEqual([13, 24]);
  });
  it('ignores warm-up climb in passes 1-12', () => {
    const p = [...Array.from({ length: 12 }, (_, i) => 420 + i * 15), ...flat(12)];
    expect(soakCriteria(p, 600).pass).toBe(true);
  });
  it('fails steady 5 MB/pass growth on (a) and (b)', () => {
    const p = Array.from({ length: 24 }, (_, i) => 500 + i * 5);
    const c = soakCriteria(p, 620);
    expect(c.a).toBe(false);
    expect(c.b).toBe(false);
    expect(c.pass).toBe(false);
  });
  it('fails a single reading over 720 on (d)', () => {
    const p = flat();
    p[3] = 721;
    const c = soakCriteria(p, 603);
    expect(c.d).toBe(false);
    expect(c.a && c.b && c.c).toBe(true);
    expect(c.pass).toBe(false);
  });
  it('fails an idle reading 20 MB above on (c)', () => {
    const c = soakCriteria(flat(), 601 + 20);
    expect(c.c).toBe(false);
    expect(c.pass).toBe(false);
  });
  it('judges the last 12 passes of a longer run', () => {
    const c = soakCriteria(series40, 610);
    expect(c.window).toEqual([29, 40]);
  });
  it('passes the 40-pass series judged on passes 13-24', () => {
    const c = soakCriteria(series40.slice(0, 24), 610);
    expect(c.window).toEqual([13, 24]);
    expect(c.pass).toBe(true);
  });
  it('rejects fewer than 24 passes', () => {
    expect(() => soakCriteria(flat(10), 600)).toThrow();
  });
});
