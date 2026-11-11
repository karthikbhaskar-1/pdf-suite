/**
 * DIAGNOSTICS ONLY (ticket 1.2.1 root-cause probe). A small ring buffer of trace events. It exists only in the app's test
 * mode (PDFSUITE_E2E=1): the main process passes a flag, the preload sets `window.__pdfSuiteTestMode`, and only then is
 * `window.__pdfSuiteDiag` exposed. Even then nothing is recorded until a probe calls `window.__pdfSuiteDiag.enable()`.
 * In a normal run there is no global and `diag()` returns at once. It changes no behaviour.
 */
interface DiagEvent {
  t: number;
  name: string;
  data?: unknown;
}

const MAX_EVENTS = 4000;
let enabled = false;
const events: DiagEvent[] = [];

export function diag(name: string, data?: unknown): void {
  if (!enabled) return;
  if (events.length >= MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS + 1);
  events.push({ t: Math.round(performance.now()), name, data });
}

/** Call sites that build a large payload check this first, so a normal run builds nothing. */
export function diagEnabled(): boolean {
  return enabled;
}

if (typeof window !== 'undefined' && window.__pdfSuiteTestMode === true) {
  (window as unknown as { __pdfSuiteDiag?: unknown }).__pdfSuiteDiag = {
    enable: () => {
      enabled = true;
    },
    /** The events recorded since `sinceT` (performance.now() ms). */
    events: (sinceT = 0) => events.filter((e) => e.t >= sinceT),
    now: () => Math.round(performance.now()),
    clear: () => {
      events.length = 0;
    },
  };
}
