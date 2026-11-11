// Independent sign-off (ticket 1.2.0) helpers. Reuses the e2e launcher; adds engine identity, real pixel checks
// and a PASS/FAIL ledger. Every check records what was observed, so the output is evidence, not a verdict.
export * from '../e2e/helpers.mjs';
import { launch, waitForPage, waitFor } from '../e2e/helpers.mjs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT2 = resolve(here, '..', '..');
export const CORPUS = join(ROOT2, 'tests', 'engine', 'corpus');

export const TRACK_WORKERS = `(() => {
  const RealWorker = window.Worker;
  const log = (window.__workerLog = []);
  function TrackedWorker(url, options) {
    const worker = new RealWorker(url, options);
    const record = { url: String(url), live: true, at: performance.now() };
    log.push(record);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { record.live = false; terminate(); };
    return worker;
  }
  TrackedWorker.prototype = RealWorker.prototype;
  window.Worker = TrackedWorker;
})();`;

export const results = [];
export function check(name, ok, observed) {
  results.push({ name, ok: Boolean(ok), observed });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  return ok;
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} :: ${JSON.stringify(f.observed)}`);
  return failed.length;
}

export async function launchTracked(opts = {}) {
  const s = await launch(opts);
  await s.win.addInitScript(TRACK_WORKERS);
  await s.win.reload();
  await s.win.waitForLoadState('domcontentloaded');
  return s;
}

export async function openPath(s, path, statusPrefix, timeoutMs = 60000) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  if (statusPrefix) await waitForPage(s, statusPrefix, { timeoutMs });
}

/** Which engine holds what: open MuPDF documents (from the engine's own test hook) and live workers by kind. */
export function engineState(win) {
  return win.evaluate(async () => {
    const heaps = (await window.__pdfSuiteEngine?.wasmHeapBytes?.()) ?? null;
    const log = window.__workerLog ?? [];
    const isPdfjs = (w) => /pdf\.?worker|pdfjs/i.test(w.url);
    return {
      mupdfDocs: heaps ? heaps.length : null,
      wasmMB: heaps ? heaps.map((b) => Math.round(b / 1048576)) : null,
      mupdfWorkersLive: log.filter((w) => w.live && !isPdfjs(w)).length,
      pdfjsWorkersEver: log.filter(isPdfjs).length,
      workersEver: log.length,
    };
  });
}

/** Paint state and ink of one page canvas in the active viewer (or viewer n). Ink = fraction of pixels darker than 200. */
export function pageInk(win, pageIndex, viewer = 0) {
  return win.evaluate(({ pageIndex, viewer }) => {
    const v = document.querySelectorAll('.viewer')[viewer];
    const c = v?.querySelector(`.page[data-page-index="${pageIndex}"] canvas.page-canvas`);
    if (!c) return { found: false };
    const placeholder = !!c.parentElement.querySelector('.page-placeholder');
    const r = c.getBoundingClientRect();
    let ink = 0, n = 0, colored = 0;
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 7) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum < 200) ink++;
        if (Math.abs(d[i] - d[i + 1]) > 30 || Math.abs(d[i + 1] - d[i + 2]) > 30) colored++;
        n++;
      }
    } catch (e) { return { found: true, error: String(e) }; }
    return { found: true, placeholder, w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height), ink: Number((ink / n).toFixed(4)), colored: Number((colored / n).toFixed(4)) };
  }, { pageIndex, viewer });
}

export const sumMB = (metrics, types) => metrics.filter((m) => types.includes(m.type)).reduce((t, m) => t + m.memKB, 0) / 1024;

export async function waitPainted(win, pageIndex, timeoutMs = 30000, viewer = 0) {
  return waitFor(async () => {
    const p = await pageInk(win, pageIndex, viewer);
    return p.found && !p.placeholder && p.w !== 300 ? p : null;
  }, { timeoutMs, label: `page ${pageIndex + 1} painted` });
}
