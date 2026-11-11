import { describe, expect, it } from 'vitest';
import { collapseUnits, HYSTERESIS_PX, planOverflow, samePlan, type OverflowInput, type OverflowItem, type OverflowPlan, type Priority } from './overflow';

const GAP = 2;
const DIVIDER = 13;
const OVERFLOW = 38;

/** An item 32 px wide with an icon only; its label would add 40 px. */
const item = (id: string, group: string, priority: Priority, icon = 32, label = 40): OverflowItem => ({ id, group, priority, icon, label });

/**
 * A bar shaped like the real one, with each group's items in bar order:
 * file: open (critical), save (critical), recent (high)
 * view: split (high), loupe (normal), pan (normal)
 * pages: insert (high), delete (high), crop (normal), size (normal)
 * search: find (critical)
 */
const ITEMS: OverflowItem[] = [
  item('open', 'file', 'critical'),
  item('save', 'file', 'critical'),
  item('recent', 'file', 'high'),
  item('split', 'view', 'high'),
  item('loupe', 'view', 'normal'),
  item('pan', 'view', 'normal'),
  item('insert', 'pages', 'high'),
  item('delete', 'pages', 'high'),
  item('crop', 'pages', 'normal'),
  item('size', 'pages', 'normal'),
  item('find', 'search', 'critical'),
];

const plan = (available: number, extra: Partial<OverflowInput> = {}) =>
  planOverflow({ items: ITEMS, available, showLabels: false, overflowWidth: OVERFLOW, itemGap: GAP, dividerWidth: DIVIDER, ...extra });

/** The width of the whole bar with nothing collapsed and no labels: 11 items of 32 px, 7 gaps between items, 3 dividers. */
const FULL = 11 * 32 + 7 * GAP + 3 * DIVIDER;

describe('which items are visible', () => {
  it('shows everything when the bar is wide enough', () => {
    const p = plan(FULL);
    expect(p.hidden).toEqual([]);
    expect(p.overflow).toBe(false);
    expect(p.labels).toBe(false);
  });

  it('collapses the normal items before any high item, rightmost group first, each group together', () => {
    // Pages' normal items (crop, size) go first, then View's normal items (loupe, pan).
    const first = plan(FULL - 1);
    expect(first.hidden).toEqual(['crop', 'size']);
    expect(first.overflow).toBe(true);
    const second = plan(340);
    expect(second.hidden).toEqual(['loupe', 'pan', 'crop', 'size']);
    // No high item is hidden while a normal one is still shown.
    expect(second.hidden.some((id) => ['recent', 'split', 'insert', 'delete'].includes(id))).toBe(false);
  });

  it('then collapses the high items, rightmost group first', () => {
    const p = plan(150);
    expect(p.hidden).toEqual(expect.arrayContaining(['loupe', 'pan', 'crop', 'size', 'insert', 'delete']));
    // Pages' high items go before View's and File's.
    const order = collapseUnits(ITEMS).map((u) => `${u.group}:${u.priority}`);
    expect(order).toEqual(['pages:normal', 'view:normal', 'pages:high', 'view:high', 'file:high']);
  });

  it('never collapses a critical item, however narrow the bar is', () => {
    for (const width of [0, 50, 100, 200]) {
      const p = plan(width);
      expect(p.hidden).not.toContain('open');
      expect(p.hidden).not.toContain('save');
      expect(p.hidden).not.toContain('find');
    }
    // At the narrowest every non-critical item is collapsed.
    expect([...plan(0).hidden].sort()).toEqual(['crop', 'delete', 'insert', 'loupe', 'pan', 'recent', 'size', 'split']);
  });

  it('keeps the bar within its width at every width where the critical items fit', () => {
    const critical = 3 * 32 + 2 * GAP + OVERFLOW + GAP + DIVIDER;
    for (let width = critical + 20; width < FULL + 40; width += 7) {
      const p = plan(width);
      const hidden = new Set(p.hidden);
      let groups = 0;
      let last = '';
      let total = 0;
      let inGroup = 0;
      for (const it of ITEMS) {
        if (hidden.has(it.id)) continue;
        if (it.group !== last) {
          groups += 1;
          last = it.group;
          inGroup = 0;
        }
        total += it.icon + (inGroup > 0 ? GAP : 0);
        inGroup += 1;
      }
      total += (groups - 1) * DIVIDER + (p.overflow ? OVERFLOW + GAP : 0);
      expect(total, `width ${width}`).toBeLessThanOrEqual(width);
    }
  });
});

describe('labels', () => {
  it('shows labels on critical and high items only, and only while they fit', () => {
    // Seven items are critical or high (open, save, recent, split, insert, delete, find), so labels add 7 x 40 px.
    const wide = plan(10_000, { showLabels: true });
    expect(wide.labels).toBe(true);
    expect(wide.hidden).toEqual([]);
    const justEnough = plan(FULL + 7 * 40, { showLabels: true });
    expect(justEnough.labels).toBe(true);
    const tooNarrow = plan(FULL + 7 * 40 - 1, { showLabels: true });
    expect(tooNarrow.labels).toBe(false);
  });

  it('drops the labels before collapsing any item', () => {
    const p = plan(FULL, { showLabels: true });
    expect(p.labels).toBe(false);
    expect(p.hidden).toEqual([]);
    expect(p.overflow).toBe(false);
  });

  it('collapses items only after the labels are gone, and behaves like labels off from then on', () => {
    const on = plan(FULL - 1, { showLabels: true });
    const off = plan(FULL - 1, { showLabels: false });
    expect(on.labels).toBe(false);
    expect(on.hidden).toEqual(off.hidden);
  });
});

describe('hysteresis', () => {
  it('keeps a collapsed item collapsed until there are 8 px to spare', () => {
    const collapsed = plan(FULL - 1);
    expect(collapsed.hidden).toEqual(['crop', 'size']);
    // The width that would just fit everything: still collapsed, because the margin is not there yet.
    for (const width of [FULL, FULL + 3, FULL + HYSTERESIS_PX - 1]) {
      expect(plan(width, { previous: collapsed }).hidden, `width ${width}`).toEqual(['crop', 'size']);
    }
    // With the margin it opens again.
    expect(plan(FULL + HYSTERESIS_PX, { previous: collapsed }).hidden).toEqual([]);
  });

  it('collapses at once when the width is short, with no margin needed', () => {
    const open = plan(FULL);
    expect(open.hidden).toEqual([]);
    expect(plan(FULL - 1, { previous: open }).hidden).toEqual(['crop', 'size']);
  });

  it('does not flip when the width wobbles by a few px around the edge', () => {
    let previous: OverflowPlan | null = null;
    const seen: boolean[] = [];
    for (const width of [FULL - 1, FULL + 2, FULL - 3, FULL + 5, FULL - 1, FULL + 7, FULL - 2]) {
      previous = plan(width, { previous });
      seen.push(previous.overflow);
    }
    expect(seen.every((overflow) => overflow)).toBe(true);
  });

  it('applies to the labels too', () => {
    const needed = FULL + 7 * 40;
    const noLabels = plan(needed - 1, { showLabels: true });
    expect(noLabels.labels).toBe(false);
    expect(plan(needed, { showLabels: true, previous: noLabels }).labels).toBe(false);
    expect(plan(needed + HYSTERESIS_PX, { showLabels: true, previous: noLabels }).labels).toBe(true);
  });

  it('ignores a previous plan made for the other label setting', () => {
    const before = plan(FULL - 1);
    expect(plan(FULL - 1, { showLabels: true, previous: before }).hidden).toEqual(['crop', 'size']);
    expect(plan(10_000, { showLabels: true, previous: before }).labels).toBe(true);
  });

  it('can be set to another margin', () => {
    const collapsed = plan(FULL - 1);
    expect(plan(FULL + 2, { previous: collapsed, hysteresis: 2 }).hidden).toEqual([]);
  });
});

describe('plans', () => {
  it('compares plans by what they show', () => {
    expect(samePlan(plan(FULL), plan(FULL + 100))).toBe(true);
    expect(samePlan(plan(FULL), plan(FULL - 1))).toBe(false);
  });

  it('lists the collapsed items in bar order', () => {
    expect(plan(0).hidden).toEqual(['recent', 'split', 'loupe', 'pan', 'insert', 'delete', 'crop', 'size']);
  });
});
