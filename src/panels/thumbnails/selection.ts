/**
 * Selection rules for the thumbnail list, the same as in a file manager:
 * plain click selects one page, Ctrl toggles a page, Shift selects the range from the anchor.
 */

export interface SelectionModifiers {
  ctrl: boolean;
  shift: boolean;
}

export interface SelectionResult {
  pageIds: string[];
  anchorId: string | null;
}

/**
 * Applies a click on `clickedId`. `order` lists every page id in list order, and `anchorId` is the
 * page where the last plain or Ctrl click happened. Ids that are not in `order` are ignored.
 */
export function applySelectionClick(
  current: readonly string[],
  order: readonly string[],
  anchorId: string | null,
  clickedId: string,
  modifiers: SelectionModifiers,
): SelectionResult {
  if (!order.includes(clickedId)) return { pageIds: [...current], anchorId };

  if (modifiers.shift) {
    const from = anchorId && order.includes(anchorId) ? order.indexOf(anchorId) : order.indexOf(clickedId);
    const to = order.indexOf(clickedId);
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return { pageIds: order.slice(lo, hi + 1), anchorId: anchorId ?? clickedId };
  }

  if (modifiers.ctrl) {
    const isSelected = current.includes(clickedId);
    const pageIds = isSelected ? current.filter((id) => id !== clickedId) : [...current, clickedId];
    return { pageIds, anchorId: clickedId };
  }

  return { pageIds: [clickedId], anchorId: clickedId };
}

/**
 * Ctrl+A in the thumbnails panel: every page of the list is selected, and the first one is the anchor, so a Shift-click
 * afterwards extends from the top.
 */
export function selectAllIds(order: readonly string[]): SelectionResult {
  return { pageIds: [...order], anchorId: order[0] ?? null };
}

/** What the thumbnail list knows when a key is pressed. All ids are pages of the list that is shown (`order`). */
export interface ListKeyState {
  /** Every page id of the shown document, in list order. */
  order: readonly string[];
  selected: readonly string[];
  anchorId: string | null;
  /** The active row (the one with the focus ring), or null when none is active yet. */
  activeId: string | null;
  /** The current page of the focused pane, used when no row is active yet. */
  currentId: string | null;
  /** How many whole rows the list shows (Page Up and Page Down move by this many, at least 1). */
  pageRows: number;
}

export interface ListKeyResult {
  /** False when the key is not a list key: the caller leaves it alone. */
  handled: boolean;
  activeId: string | null;
  pageIds: string[];
  anchorId: string | null;
  /** True when the selection changed. */
  selectionChanged: boolean;
  /** True when the view should jump to the active row's page (a plain move, Home or End, Enter). */
  jump: boolean;
  /** True for Shift+F10 and the Menu key: the right-click menu opens at the active row. */
  openMenu: boolean;
  /** True for Esc: focus goes back to the page and the selection stays. */
  leave: boolean;
}

export interface ListKeyModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * The thumbnail list's keys, the File Explorer rules. Pure: the panel applies the result. Ctrl+A, Alt+arrows, Delete and
 * Ctrl+D are not list keys here (they keep their own handlers). The selection never contains an id that is not in `order`,
 * so a key can never reach a page of another document.
 */
export function applyListKey(state: ListKeyState, key: string, mods: ListKeyModifiers): ListKeyResult {
  const { order } = state;
  const none: ListKeyResult = {
    handled: false,
    activeId: state.activeId,
    pageIds: [...state.selected],
    anchorId: state.anchorId,
    selectionChanged: false,
    jump: false,
    openMenu: false,
    leave: false,
  };
  if (mods.alt || mods.meta || order.length === 0) return none;
  const valid = (id: string | null): id is string => id !== null && order.includes(id);
  const selected = state.selected.filter((id) => order.includes(id));
  const anchorId = valid(state.anchorId) ? state.anchorId : null;
  const activeId = valid(state.activeId) ? state.activeId : valid(state.currentId) ? state.currentId : (order[0] ?? null);
  if (activeId === null) return none;
  const at = order.indexOf(activeId);
  const handled = { ...none, handled: true, activeId, pageIds: selected, anchorId };

  const move = (target: number): ListKeyResult => {
    const next = order[Math.max(0, Math.min(order.length - 1, target))]!;
    if (mods.ctrl) return { ...handled, activeId: next };
    if (mods.shift) {
      const result = applySelectionClick(selected, order, anchorId ?? activeId, next, { ctrl: false, shift: true });
      return { ...handled, activeId: next, pageIds: result.pageIds, anchorId: result.anchorId, selectionChanged: true };
    }
    return { ...handled, activeId: next, pageIds: [next], anchorId: next, selectionChanged: true, jump: true };
  };

  switch (key) {
    case 'ArrowUp':
      return move(at - 1);
    case 'ArrowDown':
      return move(at + 1);
    case 'Home':
      return move(0);
    case 'End':
      return move(order.length - 1);
    case 'PageUp':
      return move(at - Math.max(1, state.pageRows));
    case 'PageDown':
      return move(at + Math.max(1, state.pageRows));
    case ' ': {
      if (mods.shift) return handled;
      const result = applySelectionClick(selected, order, anchorId, activeId, { ctrl: true, shift: false });
      return { ...handled, pageIds: result.pageIds, anchorId: result.anchorId, selectionChanged: true };
    }
    case 'Enter':
      return mods.ctrl || mods.shift ? handled : { ...handled, jump: true };
    case 'ContextMenu':
    case 'F10': {
      if (key === 'F10' && !(mods.shift && !mods.ctrl)) return none;
      // An unselected active row becomes the selection first, as on right-click.
      if (selected.includes(activeId)) return { ...handled, openMenu: true };
      return { ...handled, pageIds: [activeId], anchorId: activeId, selectionChanged: true, openMenu: true };
    }
    case 'Escape':
      return { ...handled, leave: true };
    case 'ArrowLeft':
    case 'ArrowRight':
      return handled;
    default:
      return none;
  }
}

/**
 * The list's scroll position that shows the whole row with `gap` to spare, moving as little as possible. Returns
 * `scrollTop` itself when the row is already fully in view.
 */
export function revealScrollTop(scrollTop: number, viewHeight: number, rowTop: number, rowHeight: number, gap: number, total: number): number {
  const max = Math.max(0, total - viewHeight);
  let next = scrollTop;
  if (rowTop - gap < scrollTop) next = rowTop - gap;
  else if (rowTop + rowHeight + gap > scrollTop + viewHeight) next = rowTop + rowHeight + gap - viewHeight;
  return Math.max(0, Math.min(max, next));
}

/** The active row after pages were deleted: the page now in the first deleted place, or the last page. Null when none are left. */
export function activeAfterDelete(before: readonly string[], after: readonly string[]): string | null {
  const kept = new Set(after);
  const firstGone = before.findIndex((id) => !kept.has(id));
  if (firstGone < 0) return null;
  return after[Math.min(firstGone, after.length - 1)] ?? null;
}
