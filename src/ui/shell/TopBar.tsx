import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { topBar, type MenuEntry, type ToolbarItem } from '../../core/layout/topBarRegistry';
import { useUiStore } from '../../core/stores/uiStore';
import { MoreIcon } from '../icons';
import { planOverflow, samePlan, showsLabel, type OverflowItem, type OverflowPlan } from '../topbar/overflow';
import { ICON_PX, MenuButton } from '../topbar/toolbarControls';

/**
 * Top bar (40 px): icon buttons in 32 by 32 boxes, one group per registry entry, with a divider between groups. The bar
 * never wraps. When it is too narrow the labels go first (when Show Labels is on), then the normal items and then the high
 * items collapse into the trailing "…" menu (the rules are in topbar/overflow.ts). Critical items never collapse.
 *
 * Every item stays in the DOM so its width can be measured: a collapsed item is taken out of the flow and hidden (CSS
 * class tb-collapsed). Widths are cached in a layout effect after each render. A ResizeObserver on the bar only passes the
 * new width on; the plan is made in an animation frame, so a drag of the window edge makes one plan per frame.
 */

/** Spacing the CSS gives the bar. They are part of the width sums, so they must match shell.css. */
const ITEM_GAP_PX = 2;
const DIVIDER_PX = 13; // a 1 px line with 6 px margin on each side
const OVERFLOW_PX = 38; // the 32 px "…" button and its 6 px lead
/**
 * What a label adds to a button beyond its own text: padding 8 + 8, gap 4, minus the 32 px of an icon-only button's 18 px
 * icon, which is 6. One more px is added to each label, because the width of a label that is not showing is only an estimate
 * of the width it will have (text and sub-pixel widths), and it must never be too small: a bar that thinks labels fit when
 * they do not would take them on and off again.
 */
const LABEL_EXTRA_PX = 7;

interface Measured {
  icon: number;
  label: number;
}

/** The rows of the "…" menu: the collapsed items, with their group's heading, and a separator between groups. */
function overflowRows(groups: ReturnType<typeof topBar.list>, hidden: ReadonlySet<string>): MenuEntry[] {
  const rows: MenuEntry[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => hidden.has(item.id));
    if (items.length === 0) continue;
    if (rows.length > 0) rows.push({ kind: 'sep' });
    rows.push({ kind: 'heading', label: group.label });
    for (const item of items) {
      // The headings an item brings (the name of its submenu) sit one level under the group's heading.
      for (const row of item.menu()) rows.push(row.kind === 'heading' ? { ...row, sub: true } : row);
    }
  }
  return rows;
}

function Slot({ item, hidden, labels }: { item: ToolbarItem; hidden: boolean; labels: boolean }) {
  return (
    <div className={`tb-slot${hidden ? ' tb-collapsed' : ''}`} data-slot={item.id} data-priority={item.priority}>
      {item.render({ labels: labels && showsLabel(item.priority) })}
    </div>
  );
}

export function TopBar() {
  const groups = topBar.list();
  const showLabels = useUiStore((s) => s.toolbarLabels);
  const barRef = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<OverflowPlan | null>(null);
  const planRef = useRef<OverflowPlan | null>(null);
  const widths = useRef(new Map<string, Measured>());
  const available = useRef(0);
  const frame = useRef(0);
  /** Plan changes made at one width and label setting. A layout that keeps changing back is stopped (see recompute). */
  const settling = useRef({ key: '', changes: 0 });
  const labelsRef = useRef(showLabels);
  labelsRef.current = showLabels;
  const activeLabels = plan?.labels ?? showLabels;
  const hidden = new Set(plan?.hidden ?? []);

  /** Reads the width of each item. A label's width is read even while it is hidden, so it is known before it is needed. */
  const measure = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    for (const slot of bar.querySelectorAll<HTMLElement>('[data-slot]')) {
      const id = slot.dataset.slot!;
      const labelEls = [...slot.querySelectorAll<HTMLElement>('.tb-label')].filter((el) => el.textContent);
      const showing = labelEls.some((el) => !el.classList.contains('tb-label-off'));
      const label = labelEls.reduce((sum, el) => sum + el.getBoundingClientRect().width + LABEL_EXTRA_PX, 0);
      const width = slot.getBoundingClientRect().width;
      widths.current.set(id, { icon: showing ? width - label : width, label });
    }
  }, []);

  /** Makes the plan for the width the bar has, and shows it when it differs from the one on screen. */
  const recompute = useCallback(() => {
    // A bar that has no width yet (not laid out) says nothing about what fits.
    if (!(available.current > 0)) return;
    const items: OverflowItem[] = [];
    for (const group of groups) {
      for (const item of group.items) {
        const w = widths.current.get(item.id);
        if (!w) return;
        items.push({ id: item.id, group: group.id, priority: item.priority, icon: w.icon, label: w.label });
      }
    }
    const next = planOverflow({
      items,
      available: available.current,
      showLabels: labelsRef.current,
      overflowWidth: OVERFLOW_PX,
      itemGap: ITEM_GAP_PX,
      dividerWidth: DIVIDER_PX,
      previous: planRef.current,
    });
    if (planRef.current && samePlan(planRef.current, next)) return;
    // The widths of items whose labels are not showing are estimates. If an estimate says that more fits than really does, the
    // bar would loosen, measure the real widths, tighten again, and so on. After two changes at the same width and setting it
    // may still tighten, but no longer loosen, so the layout settles on the plan that fits.
    const key = `${available.current}|${labelsRef.current}`;
    if (settling.current.key !== key) settling.current = { key, changes: 0 };
    if (planRef.current && settling.current.changes >= 2 && next.step < planRef.current.step) return;
    settling.current.changes += 1;
    planRef.current = next;
    setPlan(next);
    // The groups come from a registry that does not change while the app runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After every render: cache the widths, then check the plan. The plan is set before the browser paints.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar && available.current === 0) {
      const style = getComputedStyle(bar);
      available.current = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    }
    measure();
    recompute();
  });

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      available.current = width;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        recompute();
      });
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [recompute]);

  const visibleGroups = groups.filter((group) => group.items.some((item) => !hidden.has(item.id)));
  const firstVisible = visibleGroups[0]?.id;

  return (
    <div className="top-bar" role="toolbar" aria-label="Toolbar" ref={barRef}>
      {groups.map((group) => {
        const shown = visibleGroups.includes(group);
        return (
          <Fragment key={group.id}>
            {shown && group.id !== firstVisible && <span className="tb-divider" aria-hidden="true" />}
            <div className="tb-group" role="group" aria-label={group.label}>
              {group.items.map((item) => (
                <Slot key={item.id} item={item} hidden={hidden.has(item.id)} labels={activeLabels} />
              ))}
            </div>
          </Fragment>
        );
      })}
      <div className={plan?.overflow ? 'tb-overflow' : 'tb-overflow tb-collapsed'}>
        {/* The key makes the button start again (closed) whenever the "…" menu appears or goes, so an open menu never outlives it. */}
        <MenuButton
          key={plan?.overflow ? 'open' : 'none'}
          label="More"
          name="More commands"
          icon={<MoreIcon size={ICON_PX} />}
          chevron={false}
          alignEnd
          entries={() => overflowRows(groups, new Set(planRef.current?.hidden ?? []))}
          tip="More commands"
        />
      </div>
    </div>
  );
}
