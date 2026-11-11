/** Window size, position and maximized state, saved between launches. */
export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1200, height: 800, maximized: false };
const MIN_SIZE = 480;
const MAX_SIZE = 20000;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads a saved state. Missing or malformed fields fall back to defaults. Sizes are clamped to sane bounds. */
export function parseWindowState(value: unknown): WindowState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_WINDOW_STATE };
  const v = value as Record<string, unknown>;
  const size = (n: unknown, fallback: number) =>
    finite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n))) : fallback;
  const state: WindowState = {
    width: size(v.width, DEFAULT_WINDOW_STATE.width),
    height: size(v.height, DEFAULT_WINDOW_STATE.height),
    maximized: v.maximized === true,
  };
  if (finite(v.x) && finite(v.y)) {
    state.x = Math.round(v.x);
    state.y = Math.round(v.y);
  }
  return state;
}

/**
 * Drops the saved position when its top-left corner is not on any visible work area (for
 * example after a monitor was unplugged). The window then opens centred on the primary display.
 */
export function placeOnDisplays(state: WindowState, workAreas: readonly Rect[]): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  const { x, y } = state;
  const visible = workAreas.some(
    (a) => x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height,
  );
  if (visible) return state;
  return { width: state.width, height: state.height, maximized: state.maximized };
}

/**
 * Test mode only: the work area a test window opens on. It is the first display that is not the
 * primary one, or the primary when there is only one (or `forcePrimary`). This keeps the main monitor free.
 */
export function pickTestWorkArea<T extends { id: number; workArea: Rect }>(
  displays: readonly T[],
  primaryId: number,
  forcePrimary: boolean,
): Rect | undefined {
  const primary = displays.find((d) => d.id === primaryId) ?? displays[0];
  if (forcePrimary) return primary?.workArea;
  return (displays.find((d) => d.id !== primaryId) ?? primary)?.workArea;
}

/** The size, centred in the work area and shrunk to fit it. */
export function centreIn(area: Rect, width: number, height: number): Rect {
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  return { x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2), width: w, height: h };
}
