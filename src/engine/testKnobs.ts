/**
 * TEST MODE ONLY (milestone 1.5 measurement knob). The one list of design constants a test run may override, so the
 * 1.5 sweeps (L4, L6, P1, P2) can measure them. In a normal run nothing here changes: every knob has its shipped value
 * as the default, and overrides are read only when the app runs in test mode (PDFSUITE_E2E=1).
 *
 * Channel: the test sets PDFSUITE_TEST_KNOBS to a JSON object (e.g. {"bitmapBudgetBytes":33554432,"concurrency":1}).
 * The main process, in test mode only, passes it to the page as a window argument; the preload exposes the parsed
 * object as `window.__pdfSuiteKnobs` next to `__pdfSuiteTestMode`; this module reads it once at load.
 * `screenScale` is not a page constant: the main process turns it into Chromium's --force-device-scale-factor
 * (test mode only), and the page sees it as window.devicePixelRatio.
 */
export const KNOB_DEFAULTS = {
  /** A1 BITMAP_BUDGET_BYTES (bitmapCache.ts). */
  bitmapBudgetBytes: 48 * 1024 * 1024,
  /** A3 render concurrency (renderScheduler.ts). */
  concurrency: 2,
  /** A8 FAST_VIEWPORTS_PER_SECOND (scrollVelocity.ts). */
  fastViewportsPerSecond: 1.5,
  /** A9 SETTLE_MS (scrollVelocity.ts). */
  settleMs: 120,
  /** A11 LOW_SCALE_FACTOR (progressiveScale.ts). */
  lowScaleFactor: 0.5,
  /** A12 LOW_MAX_PIXELS (progressiveScale.ts). */
  lowMaxPixels: 2_000_000,
  /** A14 DRAG_PAUSE_MS (dragHold.ts), a "viewer is still" time. */
  dragPauseMs: 80,
  /** A29 LAYER_SETTLE_MS (mupdfDocument.ts), a "viewer is still" time. */
  layerSettleMs: 150,
  /** A15 OVERSCAN, pages each way (useViewerController.ts). */
  overscan: 2,
  /** A18 thumbnail OVERSCAN_PX (ThumbnailsPanel.tsx). */
  thumbOverscanPx: 320,
} as const;

const MB = 1024 * 1024;
/** Sane range of each knob [min, max, integer?]. A value outside it (after rounding an integer knob) falls back to the default. */
export const KNOB_RANGES: Record<keyof typeof KNOB_DEFAULTS, readonly [number, number, boolean]> = {
  bitmapBudgetBytes: [8 * MB, 512 * MB, true],
  concurrency: [1, 8, true],
  fastViewportsPerSecond: [0.1, 50, false],
  settleMs: [0, 2000, false],
  lowScaleFactor: [0.1, 1, false],
  lowMaxPixels: [100_000, 16_000_000, true],
  dragPauseMs: [0, 2000, false],
  layerSettleMs: [0, 2000, false],
  overscan: [0, 6, true],
  thumbOverscanPx: [0, 2000, true],
};
/** Screen scale range (Chromium --force-device-scale-factor). */
export const SCREEN_SCALE_RANGE = [0.5, 4] as const;

export type KnobName = keyof typeof KNOB_DEFAULTS;
export type Knobs = { -readonly [K in KnobName]: number };

/** Test-only launch flag: Chromium --force-device-scale-factor. Handled by the main process, not read by the page. */
export const SCREEN_SCALE_KNOB = 'screenScale';

function parseKnobJson(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The knob values for one run. Outside test mode, or for a missing, non-numeric or non-positive entry, the default. */
export function resolveKnobs(raw: unknown, testMode: boolean): Knobs {
  const out: Knobs = { ...KNOB_DEFAULTS };
  if (!testMode || !raw || typeof raw !== 'object') return out;
  const source = raw as Record<string, unknown>;
  for (const name of Object.keys(KNOB_DEFAULTS) as KnobName[]) {
    const raw = source[name];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const [min, max, integer] = KNOB_RANGES[name];
    const value = integer ? Math.round(raw) : raw;
    if (value >= min && value <= max) out[name] = value;
  }
  return out;
}

/** Main process: the window argument that carries the knobs to the preload. Empty outside test mode or with no knobs. */
export function knobWindowArguments(env: Record<string, string | undefined>): string[] {
  if (env.PDFSUITE_E2E !== '1' || !env.PDFSUITE_TEST_KNOBS) return [];
  return [`--pdfsuite-knobs=${JSON.stringify(parseKnobJson(env.PDFSUITE_TEST_KNOBS))}`];
}

/** Main process: the forced screen scale, or null (always null outside test mode). */
export function testScreenScale(env: Record<string, string | undefined>): number | null {
  if (env.PDFSUITE_E2E !== '1') return null;
  const value = parseKnobJson(env.PDFSUITE_TEST_KNOBS)[SCREEN_SCALE_KNOB];
  return typeof value === 'number' && Number.isFinite(value) && value >= SCREEN_SCALE_RANGE[0] && value <= SCREEN_SCALE_RANGE[1] ? value : null;
}

/** Preload: the knob object from the window arguments, only in test mode. */
export function knobsFromArgv(argv: readonly string[]): Record<string, unknown> | null {
  if (!argv.includes('--pdfsuite-test-mode')) return null;
  const arg = argv.find((a) => a.startsWith('--pdfsuite-knobs='));
  return arg ? parseKnobJson(arg.slice('--pdfsuite-knobs='.length)) : null;
}

type TestWindow = { __pdfSuiteTestMode?: boolean; __pdfSuiteKnobs?: Record<string, unknown> };
const testWindow = typeof window !== 'undefined' ? (window as unknown as TestWindow) : undefined;
const inTestMode = testWindow?.__pdfSuiteTestMode === true;

/** The values this page uses. Read once; in a normal run `window.__pdfSuiteKnobs` does not exist, so these are the defaults. */
export const knobs: Knobs = resolveKnobs(inTestMode ? testWindow?.__pdfSuiteKnobs : undefined, inTestMode);
