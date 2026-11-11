import type { CutDirection, CutScope } from '../../core/stores/sheetStore';
import { sliceFits } from '../../engine/mupdf/protocol';

export type { CutDirection, CutScope };

/**
 * Pure rules of the Cut Pages in Half sheet (the engine's `slice` edit): the cut position as typed, which pages "Apply to"
 * names, the summary line, and where the guide line and the numbers 1 and 2 are drawn on a page the viewer shows turned.
 * No store, no engine: every function takes what it works on.
 */

export const CUT_MIN_PERCENT = 30;
export const CUT_MAX_PERCENT = 70;
export const CUT_STEP_PERCENT = 0.5;
export const CUT_DEFAULT_PERCENT = 50;

export const CUT_PERCENT_MESSAGE = 'Enter a number from 30 to 70.';
export const CUT_NO_MATCH_MESSAGE = 'No pages match. Choose a different “Apply to”.';
export const CUT_MEASURING_MESSAGE = 'The pages are still being measured. Try again in a moment.';

/**
 * The cut position as typed ("45", "62.5", "50.25"), or null when it is not a number from 30 to 70. The box takes one decimal
 * place (1.5.5 C4): more decimals are rounded to one (50.25 becomes 50.3), so the value used is always the one the box shows
 * once it is tidied.
 */
export function parseCutPercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!(value >= CUT_MIN_PERCENT && value <= CUT_MAX_PERCENT)) return null;
  return Math.round(value * 10) / 10;
}

/** The cut position text for a number, to one decimal place and no trailing zero ("50", "62.5", "50.3"). */
export function formatCutPercent(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** A cut position in percent as the share the engine takes (50.3 gives 0.503), free of floating-point dust. */
export function cutShare(percent: number): number {
  return Math.round(percent * 10) / 1000;
}

/** Moves a slider value to the nearest step and keeps it from 30 to 70. Dragging the slider or the guide uses this. */
export function snapCutPercent(value: number): number {
  const snapped = Math.round(value / CUT_STEP_PERCENT) * CUT_STEP_PERCENT;
  return Math.min(CUT_MAX_PERCENT, Math.max(CUT_MIN_PERCENT, snapped));
}

/**
 * An arrow key on the slider: the next multiple of 0.5 in that direction (50.3 and Right give 50.5, 50.3 and Left give 50;
 * 50 and Right give 50.5), kept from 30 to 70.
 */
export function stepCutPercent(value: number, direction: 1 | -1): number {
  const tenths = Math.round(value * 10);
  const step = CUT_STEP_PERCENT * 10;
  const next = direction === 1 ? (Math.floor(tenths / step) + 1) * step : (Math.ceil(tenths / step) - 1) * step;
  return Math.min(CUT_MAX_PERCENT, Math.max(CUT_MIN_PERCENT, next / 10));
}

/** "Apply to" starts at the selected pages when two or more are selected, else at all pages. */
export function defaultCutScope(selectedCount: number): CutScope {
  return selectedCount >= 2 ? 'selected' : 'all';
}

/** The words of the "wide pages" choice: tall pages for a horizontal cut. */
export function wideChoiceLabel(direction: CutDirection): string {
  return direction === 'horizontal' ? 'Tall pages only' : 'Wide pages only';
}

/** A page's display size, as the viewer shows it (its CropBox, turned by /Rotate). */
export interface DisplaySize {
  width: number;
  height: number;
}

/** What the scope rules read: the page list and each page's size by position, the selection and the current page. */
export interface CutInputs {
  /** The uids of the document's pages, in page order. */
  order: readonly string[];
  /** Sizes by position, undefined while a page is not measured yet. */
  sizes: ReadonlyArray<DisplaySize | undefined>;
  /** The selected uids (any order; only those in `order` count). */
  selected: readonly string[];
  /** The focused pane's current page, or null. */
  current: string | null;
}

export interface CutTargets {
  /** The pages the scope names, in page order. */
  uids: string[];
  /** True when the scope depends on page sizes and some page has not been measured, so the list may be incomplete. */
  unmeasured: boolean;
}

/**
 * The pages "Apply to" names. Always read from the live page list, selection and current page (never kept from when the
 * sheet opened), so a save that restarts the uids, a selection changed while the sheet is open, or another pane cannot make
 * the sheet act on other pages than the ones it shows.
 */
export function cutScopeUids(inputs: CutInputs, scope: CutScope, direction: CutDirection): CutTargets {
  const { order } = inputs;
  switch (scope) {
    case 'all':
      return { uids: [...order], unmeasured: false };
    case 'selected': {
      const picked = new Set(inputs.selected);
      return { uids: order.filter((uid) => picked.has(uid)), unmeasured: false };
    }
    case 'current':
      return { uids: inputs.current !== null && order.includes(inputs.current) ? [inputs.current] : [], unmeasured: false };
    case 'wide': {
      const uids: string[] = [];
      let unmeasured = false;
      order.forEach((uid, index) => {
        const size = inputs.sizes[index];
        if (!size || !(size.width > 0 && size.height > 0)) {
          unmeasured = true;
          return;
        }
        if (sliceFits(size, direction)) uids.push(uid);
      });
      return { uids, unmeasured };
    }
  }
}

/** "Cuts 12 pages into 24. Comments and links stay with their half." */
export function cutSummary(count: number): string {
  const noun = count === 1 ? 'page' : 'pages';
  return `Cuts ${count} ${noun} into ${count * 2}. Comments and links stay with their half.`;
}

/** The toast after a cut: "Cut 12 pages in half". */
export function cutDoneText(count: number): string {
  return `Cut ${count} ${count === 1 ? 'page' : 'pages'} in half`;
}

// ---- The guide on the page ---------------------------------------------------------------------------------------------

/** A point as a share of the page shown: x from the left, y from the top, both 0 to 1. */
export interface Fraction {
  x: number;
  y: number;
}

/**
 * A point of the page in its own display space (before the pane turns the view) as the point of the page as shown, when the
 * pane's view is turned clockwise by `rotation` degrees (0, 90, 180 or 270).
 */
export function toShown(point: Fraction, rotation: number): Fraction {
  switch (((Math.round(rotation / 90) % 4) + 4) % 4) {
    case 1:
      return { x: 1 - point.y, y: point.x };
    case 2:
      return { x: 1 - point.x, y: 1 - point.y };
    case 3:
      return { x: point.y, y: 1 - point.x };
    default:
      return point;
  }
}

/** The inverse of toShown: a point of the page as shown, as the point of the page's own display space. */
export function fromShown(point: Fraction, rotation: number): Fraction {
  switch (((Math.round(rotation / 90) % 4) + 4) % 4) {
    case 1:
      return { x: point.y, y: 1 - point.x };
    case 2:
      return { x: 1 - point.x, y: 1 - point.y };
    case 3:
      return { x: 1 - point.y, y: point.x };
    default:
      return point;
  }
}

/** Where the cut line, and the centres of the first and second half, are on the page as shown. */
export interface GuideShape {
  line: [Fraction, Fraction];
  /** The centre of the half that comes first (marked 1) and of the second (marked 2). */
  first: Fraction;
  second: Fraction;
}

/**
 * The guide of a cut at `at` (0.3 to 0.7, a share of the width for a vertical cut and of the height for a horizontal one)
 * on a page shown turned by `rotation`. A vertical cut marks the left half 1 unless the right page is first; a horizontal
 * cut always marks the top half 1.
 */
export function guideShape(direction: CutDirection, at: number, first: 'left' | 'right', rotation: number): GuideShape {
  let line: [Fraction, Fraction];
  let low: Fraction;
  let high: Fraction;
  if (direction === 'horizontal') {
    line = [{ x: 0, y: at }, { x: 1, y: at }];
    low = { x: 0.5, y: at / 2 };
    high = { x: 0.5, y: (1 + at) / 2 };
  } else {
    line = [{ x: at, y: 0 }, { x: at, y: 1 }];
    low = { x: at / 2, y: 0.5 };
    high = { x: (1 + at) / 2, y: 0.5 };
  }
  const lowFirst = direction === 'horizontal' || first === 'left';
  return {
    line: [toShown(line[0], rotation), toShown(line[1], rotation)],
    first: toShown(lowFirst ? low : high, rotation),
    second: toShown(lowFirst ? high : low, rotation),
  };
}

/** The cut position (0 to 1) a pointer at `shown` on the page as shown means, for a page shown turned by `rotation`. */
export function cutFromPointer(direction: CutDirection, shown: Fraction, rotation: number): number {
  const own = fromShown(shown, rotation);
  return direction === 'horizontal' ? own.y : own.x;
}
