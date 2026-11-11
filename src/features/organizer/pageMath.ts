import { pageIdForUid } from '../../core/model/pageList';
import type { CropScope, Margins } from '../../core/stores/sheetStore';

/**
 * Pure page-list arithmetic for the organizer: drop slots, move targets, insert anchors, crop boxes and the rules that
 * decide when a delete needs confirming. No store, no engine: every function takes the order it works on.
 */

/** The page's uid, read from its page id. Page ids are "<docId>:<uid>" (see pageIdForUid). */
export function pageUidFromId(docId: string, pageId: string): string | null {
  const prefix = `${docId}:`;
  return pageId.startsWith(prefix) ? pageId.slice(prefix.length) : null;
}

/** The page id of a uid. The inverse of pageUidFromId. */
export function pageIdFromUid(docId: string, uid: string): string {
  return pageIdForUid(docId, uid);
}

/**
 * The slot a drop lands in, for a pointer at `y` (in the list's own coordinates). Rows are given by their top edges and
 * heights. A drop in the upper half of a row goes before that row; the lower half goes after it. The result is 0..n.
 */
export function dropSlot(tops: readonly number[], heights: readonly number[], y: number): number {
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i] ?? 0;
    const height = heights[i] ?? 0;
    if (y < top + height / 2) return i;
  }
  return tops.length;
}

/**
 * The order the pages would have after moving `moving` before `beforeUid` (null: to the end). The moved pages keep their
 * relative order. A `beforeUid` that is itself moving, or unknown, leaves the order as it is.
 */
export function reorderedUids(order: readonly string[], moving: readonly string[], beforeUid: string | null): string[] {
  const movingSet = new Set(moving);
  const kept = order.filter((uid) => !movingSet.has(uid));
  const block = order.filter((uid) => movingSet.has(uid));
  const at = beforeUid === null ? kept.length : kept.indexOf(beforeUid);
  if (at < 0) return [...order];
  return [...kept.slice(0, at), ...block, ...kept.slice(at)];
}

/**
 * The `beforeUid` for a drop at `slot`. A slot inside the moving pages moves the drop to the first page after it that is
 * not moving. Null when there is none, which means the end.
 */
export function beforeUidFor(order: readonly string[], moving: ReadonlySet<string>, slot: number): string | null {
  for (let i = Math.max(0, slot); i < order.length; i++) {
    const uid = order[i]!;
    if (!moving.has(uid)) return uid;
  }
  return null;
}

export type KeyboardMoveAction = 'up' | 'down' | 'start' | 'end';

/**
 * Alt+Up, Alt+Down, Alt+Home and Alt+End: where the selected pages go, as a `beforeUid`. Null when they are already at the
 * edge, so the key does nothing.
 */
export function keyboardMove(
  order: readonly string[],
  selected: ReadonlySet<string>,
  action: KeyboardMoveAction,
): { beforeUid: string | null } | null {
  const indexes: number[] = [];
  order.forEach((uid, index) => {
    if (selected.has(uid)) indexes.push(index);
  });
  if (indexes.length === 0) return null;
  const first = indexes[0]!;
  const last = indexes[indexes.length - 1]!;
  const n = order.length;
  switch (action) {
    case 'up':
      return first === 0 ? null : { beforeUid: order[first - 1]! };
    case 'down':
      if (last >= n - 1) return null;
      return { beforeUid: last + 2 < n ? order[last + 2]! : null };
    case 'start':
      return first === 0 ? null : { beforeUid: order[0]! };
    case 'end':
      return last === n - 1 ? null : { beforeUid: null };
  }
}

export type InsertPosition = 'before' | 'after' | 'at';

/**
 * The page the new pages follow (their `afterUid`), for an insert. `pageIndex` is the page the sheet was opened on:
 * "before" puts the new pages in front of it, "after" behind it, and "at" starts them at 1-based position `at`.
 * Null means the start of the document.
 */
export function insertAnchor(order: readonly string[], pageIndex: number, position: InsertPosition, at: number): string | null {
  if (order.length === 0) return null;
  if (position === 'after') return order[Math.min(Math.max(pageIndex, 0), order.length - 1)] ?? null;
  if (position === 'before') {
    const index = Math.min(Math.max(pageIndex, 0), order.length);
    return index > 0 ? (order[index - 1] ?? null) : null;
  }
  const start = Math.min(Math.max(Math.trunc(at), 1), order.length + 1);
  return start > 1 ? (order[start - 2] ?? null) : null;
}

/** The uids a crop scope applies to. Odd and even count pages from 1, as a reader does. */
export function cropScopeUids(order: readonly string[], scope: CropScope, currentUid: string, selected: readonly string[]): string[] {
  switch (scope) {
    case 'current':
      return [currentUid];
    case 'selected': {
      const picked = new Set(selected);
      const chosen = order.filter((uid) => picked.has(uid));
      return chosen.length > 0 ? chosen : [currentUid];
    }
    case 'all':
      return [...order];
    case 'odd':
      return order.filter((_uid, index) => index % 2 === 0);
    case 'even':
      return order.filter((_uid, index) => index % 2 === 1);
  }
}

/** The narrowest a crop may leave a page, in points. A margin cannot push the other edge past it. */
export const MIN_CROP_PT = 12;

/**
 * The crop box for margins, on a page of `width` × `height` points. Null when all margins are zero (the crop is removed).
 * Returns a message instead when the margins leave less than MIN_CROP_PT.
 */
export function cropBoxFor(
  margins: Margins,
  width: number,
  height: number,
): { ok: true; box: { x: number; y: number; width: number; height: number } | null } | { ok: false; message: string } {
  const { top, bottom, left, right } = margins;
  if (top === 0 && bottom === 0 && left === 0 && right === 0) return { ok: true, box: null };
  const boxWidth = width - left - right;
  const boxHeight = height - top - bottom;
  if (boxWidth < MIN_CROP_PT || boxHeight < MIN_CROP_PT) {
    return { ok: false, message: 'The margins leave too little of the page. Make them smaller.' };
  }
  return { ok: true, box: { x: left, y: top, width: boxWidth, height: boxHeight } };
}

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * Moves one or two edges of a crop by a drag of (dx, dy) points, keeping every margin at least zero and the box at least
 * MIN_CROP_PT wide and high.
 */
export function moveCropHandle(margins: Margins, handle: CropHandle, dx: number, dy: number, width: number, height: number): Margins {
  const next = { ...margins };
  if (handle.includes('w')) next.left = clamp(margins.left + dx, 0, width - margins.right - MIN_CROP_PT);
  if (handle.includes('e')) next.right = clamp(margins.right - dx, 0, width - margins.left - MIN_CROP_PT);
  if (handle.includes('n')) next.top = clamp(margins.top + dy, 0, height - margins.bottom - MIN_CROP_PT);
  if (handle.includes('s')) next.bottom = clamp(margins.bottom - dy, 0, height - margins.top - MIN_CROP_PT);
  return next;
}

/** Rotation from the slider: 0.1 degree steps, between -45 and +45. */
export const ROTATE_LIMIT = 45;
export function clampRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.round(value * 10) / 10, -ROTATE_LIMIT, ROTATE_LIMIT);
}

/**
 * True when deleting `count` of `total` pages removes more than half of them. Such a delete asks for confirmation inline in
 * the sheet first.
 */
export function deleteNeedsConfirm(total: number, count: number): boolean {
  return count * 2 > total;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** True when deleting `uids` would leave the document with no page: every page of `order` is among them. */
export function wouldEmptyDocument(order: readonly string[], uids: readonly string[]): boolean {
  if (order.length === 0) return false;
  const doomed = new Set(uids);
  return order.every((uid) => doomed.has(uid));
}

/**
 * The pages Reverse works on: the selected pages in page order, or every page when nothing is selected. `all` tells the
 * caller to say so (the toast names every page).
 */
export function reverseScopeOf(order: readonly string[], selected: ReadonlySet<string>): { uids: string[]; all: boolean } {
  const picked = order.filter((uid) => selected.has(uid));
  if (picked.length > 0) return { uids: picked, all: false };
  return { uids: [...order], all: true };
}
