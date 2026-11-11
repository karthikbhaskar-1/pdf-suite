/**
 * Sync-scroll math for split view. Sync is relative: a pane reports how far it moved, in page units
 * (one page is 1, measured as the page index plus the fraction of that page above the top edge), and
 * the other pane moves by the same amount. The gap between the two panes is kept, so two panes
 * 285 pages apart stay 285 pages apart while they scroll.
 */

/**
 * A page position, clamped to a document of `pageCount` pages. The range runs from the top of the
 * first page to the bottom of the last one. Positions past either end stop there, so a pane at the end of
 * its document does not move, and the other pane keeps moving by the same amounts.
 */
export function clampPagePosition(position: number, pageCount: number): number {
  if (!Number.isFinite(position) || pageCount <= 0) return 0;
  return Math.min(Math.max(0, position), pageCount);
}

/** Divider position as a share of the split container, kept between 15% and 85%. */
export const SPLIT_RATIO_MIN = 0.15;
export const SPLIT_RATIO_MAX = 0.85;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

/** Keyboard steps for the divider: 2% per arrow press, 10% with Shift. */
export const SPLIT_KEY_STEP = 0.02;
export const SPLIT_KEY_STEP_LARGE = 0.1;

/**
 * New divider position for a key press, or null when the key does not move the divider. Side by
 * side splits use Left and Right; stacked splits use Up and Down. Home and End go to the limits.
 */
export function splitKeyRatio(
  ratio: number,
  key: string,
  shift: boolean,
  orientation: 'horizontal' | 'vertical',
): number | null {
  const step = shift ? SPLIT_KEY_STEP_LARGE : SPLIT_KEY_STEP;
  const [back, forward] = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  if (key === 'Home') return SPLIT_RATIO_MIN;
  if (key === 'End') return SPLIT_RATIO_MAX;
  if (key === back) return clampSplitRatio(Math.round((ratio - step) * 1000) / 1000);
  if (key === forward) return clampSplitRatio(Math.round((ratio + step) * 1000) / 1000);
  return null;
}
