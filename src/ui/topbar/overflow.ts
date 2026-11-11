/**
 * The toolbar's overflow rules as a pure function (ticket 1.2.2): which buttons are visible at a given width.
 *
 * Items are listed in bar order. A **critical** item never collapses. When the bar is too narrow the steps are, in order:
 * the labels go (only when "Show Labels" is on), then the **normal** items collapse, then the **high** ones. An item
 * collapses together with the other items of its own group and priority (a "unit"), rightmost unit first. Collapsed items
 * move into the "…" menu. To keep the bar from flickering at a boundary, a step is only undone when there is a margin
 * (the hysteresis, 8 px) to spare.
 */

export type Priority = 'critical' | 'high' | 'normal';

export interface OverflowItem {
  id: string;
  /** The group the item belongs to. Items of one group and one priority collapse together. */
  group: string;
  priority: Priority;
  /** Width of the item with its icon only, in px. */
  icon: number;
  /** Extra width its label adds when labels show, in px. Zero for an item that has no label. */
  label: number;
}

export interface OverflowInput {
  /** Every item, in bar order. */
  items: readonly OverflowItem[];
  /** Width the bar has for its content, in px. */
  available: number;
  /** The user's Show Labels setting. */
  showLabels: boolean;
  /** Width of the "…" button, in px. It takes room only while something is collapsed. */
  overflowWidth: number;
  /** Space between items of a group, in px. */
  itemGap: number;
  /** Space a divider between two shown groups takes (its line and both margins), in px. */
  dividerWidth: number;
  /** Slack required before a step is undone. Defaults to HYSTERESIS_PX. */
  hysteresis?: number;
  /** The plan the bar had, so that a width inside the hysteresis band keeps it. */
  previous?: OverflowPlan | null;
}

export interface OverflowPlan {
  /** Whether labels show beside the icons (only critical and high items have them). */
  labels: boolean;
  /** Ids of the collapsed items, in bar order. */
  hidden: readonly string[];
  /** Number of steps taken from the roomiest layout. Kept so the next plan can apply the hysteresis. */
  step: number;
  /** The Show Labels setting this plan was made for (a change of it makes the step meaningless). */
  forLabels: boolean;
  /** True when the "…" button shows. */
  overflow: boolean;
}

export const HYSTERESIS_PX = 8;

/** Items that can carry a label: critical and high ones. Normal items show only an icon. */
export function showsLabel(priority: Priority): boolean {
  return priority !== 'normal';
}

/** The collapse order: normal units first, then high units, each from the rightmost group to the leftmost. */
export function collapseUnits(items: readonly OverflowItem[]): Array<{ group: string; priority: Priority; ids: string[] }> {
  const groups: string[] = [];
  for (const item of items) if (!groups.includes(item.group)) groups.push(item.group);
  const units: Array<{ group: string; priority: Priority; ids: string[] }> = [];
  for (const priority of ['normal', 'high'] as const) {
    for (const group of [...groups].reverse()) {
      const ids = items.filter((i) => i.group === group && i.priority === priority).map((i) => i.id);
      if (ids.length > 0) units.push({ group, priority, ids });
    }
  }
  return units;
}

/** The width the bar needs at one step. */
function widthAt(input: OverflowInput, labels: boolean, hidden: ReadonlySet<string>): number {
  let total = 0;
  let shownGroups = 0;
  let current: string | null = null;
  let inGroup = 0;
  for (const item of input.items) {
    if (hidden.has(item.id)) continue;
    if (item.group !== current) {
      current = item.group;
      inGroup = 0;
      shownGroups += 1;
    }
    total += item.icon + (labels && showsLabel(item.priority) ? item.label : 0);
    if (inGroup > 0) total += input.itemGap;
    inGroup += 1;
  }
  if (shownGroups > 1) total += (shownGroups - 1) * input.dividerWidth;
  if (hidden.size > 0) total += input.overflowWidth + input.itemGap;
  return total;
}

interface Step {
  labels: boolean;
  hidden: Set<string>;
}

/** The layouts from roomiest (step 0) to tightest. */
function stepsOf(input: OverflowInput): Step[] {
  const steps: Step[] = [];
  if (input.showLabels) steps.push({ labels: true, hidden: new Set() });
  steps.push({ labels: false, hidden: new Set() });
  const hidden = new Set<string>();
  for (const unit of collapseUnits(input.items)) {
    for (const id of unit.ids) hidden.add(id);
    steps.push({ labels: false, hidden: new Set(hidden) });
  }
  return steps;
}

/** The first step whose layout fits `room`, or the tightest step when none does. */
function firstFit(input: OverflowInput, steps: readonly Step[], room: number): number {
  for (let i = 0; i < steps.length; i++) {
    if (widthAt(input, steps[i]!.labels, steps[i]!.hidden) <= room) return i;
  }
  return steps.length - 1;
}

/**
 * Plans the bar for `available` px. The roomiest layout that fits wins. A layout is only given back (more shown than
 * before) when it still fits with the hysteresis to spare, so a width that wobbles by a few px does not flip the bar.
 */
export function planOverflow(input: OverflowInput): OverflowPlan {
  const steps = stepsOf(input);
  const margin = input.hysteresis ?? HYSTERESIS_PX;
  const needed = firstFit(input, steps, input.available);
  const relaxed = firstFit(input, steps, input.available - margin);
  const before = input.previous && input.previous.forLabels === input.showLabels ? Math.min(input.previous.step, steps.length - 1) : null;
  let step = needed;
  if (before !== null) {
    if (before < needed) step = needed;
    else if (before > relaxed) step = relaxed;
    else step = before;
  }
  const chosen = steps[step]!;
  const hiddenIds = input.items.filter((i) => chosen.hidden.has(i.id)).map((i) => i.id);
  return { labels: chosen.labels, hidden: hiddenIds, step, forLabels: input.showLabels, overflow: hiddenIds.length > 0 };
}

/** True when two plans show the same thing. */
export function samePlan(a: OverflowPlan, b: OverflowPlan): boolean {
  return a.labels === b.labels && a.step === b.step && a.forLabels === b.forLabels && a.hidden.length === b.hidden.length && a.hidden.every((id, i) => id === b.hidden[i]);
}
