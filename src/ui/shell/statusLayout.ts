/**
 * What the status bar shows at a given width (tickets 1.2.2 and 1.5.5 A4). As the bar narrows it leaves out, in this order:
 * the zoom slider (under 640 px), the document info (under 520 px; the selection chip then shortens to "n selected"), then
 * Fit page and Fit width (under 420 px; they move into the zoom presets menu) and the word "Page" before the page box. Down
 * to 320 px nothing more goes: the page box, "of n", Zoom out, the zoom box, the presets and Zoom in stay on one row.
 */
export interface StatusLayout {
  slider: boolean;
  info: boolean;
  fit: boolean;
  /** The word "Page" before the page box. */
  pageWord: boolean;
  /** The selection chip says "n selected" instead of "n pages selected". */
  shortChip: boolean;
}

/** The widths (the bar's content width, in px) below which a part is left out. */
export const STATUS_BREAKPOINTS = { slider: 640, info: 520, fit: 420 } as const;

export function statusLayout(width: number): StatusLayout {
  return {
    slider: width >= STATUS_BREAKPOINTS.slider,
    info: width >= STATUS_BREAKPOINTS.info,
    fit: width >= STATUS_BREAKPOINTS.fit,
    pageWord: width >= STATUS_BREAKPOINTS.fit,
    shortChip: width < STATUS_BREAKPOINTS.info,
  };
}

/** The same layout for a comparison: true when nothing about it changed (so a resize within one layout draws nothing). */
export function sameLayout(a: StatusLayout, b: StatusLayout): boolean {
  return a.slider === b.slider && a.info === b.info && a.fit === b.fit && a.pageWord === b.pageWord && a.shortChip === b.shortChip;
}
