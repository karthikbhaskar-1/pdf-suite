// Shared helpers for the milestone 1.5 knob sweeps (L4, L6, P1, P2). The app runs in test mode with
// PDFSUITE_TEST_KNOBS set (src/engine/testKnobs.ts); each run is a fresh launch with its own temporary profile.
// Nothing here changes a default: a sweep passes the knob it measures and the app reads it only in test mode.
import { launch, closeAll, cleanupProfile, waitForPage, waitFor, placeWindow, rendererMemoryMB, statusText } from '../e2e/helpers.mjs';

export { closeAll, cleanupProfile, waitForPage, waitFor, rendererMemoryMB, statusText };
export const MB = 1024 * 1024;

/** Counts render requests posted to the MuPDF workers (thumbnail = scale 160 * dpr / 612, else page) and repeats of (page, scale). */
const RENDER_COUNTER = `(() => {
  const orig = Worker.prototype.postMessage;
  const st = (window.__rc = { page: 0, pageRepeat: 0, thumb: 0, thumbRepeat: 0, seenP: new Set(), seenT: new Set(), jobs: 0 });
  Worker.prototype.postMessage = function (m, t) {
    try {
      if (m && m.op === 'render') {
        const a = m.args || {};
        const key = a.page + '|' + a.scale + '|' + a.rotation;
        // Thumbnails render at scale 160 * dpr / 612 (Letter) and are posted at the same priority as pages, so tell them by scale.
        const dpr = window.devicePixelRatio || 1;
        if (Math.abs(a.scale - (160 * dpr) / 612) < 0.002) { st.thumb++; if (st.seenT.has(key)) st.thumbRepeat++; else st.seenT.add(key); }
        else { st.page++; if (st.seenP.has(key)) st.pageRepeat++; else st.seenP.add(key); }
      }
    } catch (e) { /* counting must never break a post */ }
    return orig.call(this, m, t);
  };
  window.__rcSnap = () => ({ page: st.page, pageRepeat: st.pageRepeat, thumb: st.thumb, thumbRepeat: st.thumbRepeat });
})();`;

/** Launches the app with knobs (a plain object, see KNOB_DEFAULTS) and an optional window size. Returns the launch object plus `dpr`. */
export async function launchKnob({ knobs = {}, size = null } = {}) {
  const env = Object.keys(knobs).length ? { PDFSUITE_TEST_KNOBS: JSON.stringify(knobs) } : {};
  const s = await launch({ env });
  await s.win.addInitScript(RENDER_COUNTER);
  await s.win.reload();
  await s.win.waitForSelector('.empty-state');
  if (size) await placeWindow(s, size);
  await s.win.waitForTimeout(800);
  s.dpr = await s.win.evaluate(() => window.devicePixelRatio);
  s.knobsApplied = await s.win.evaluate(() => window.__pdfSuiteKnobs ?? null);
  return s;
}

export async function endRun(s) {
  if (!s) return;
  await s.close();
  cleanupProfile(s.profile);
}

export async function openFile(s, path, pages) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, `Page 1 of ${pages}`, { timeoutMs: 60000 });
  await s.win.locator('.page-canvas').first().waitFor({ timeout: 30000 });
  await s.win.waitForTimeout(1000);
}

export async function setZoomPercent(s, percent) {
  const box = s.win.getByLabel('Zoom level');
  await box.fill(String(percent));
  await box.press('Enter');
  await waitFor(async () => (await statusText(s.win)).includes(`${percent}%`), { timeoutMs: 8000, label: `zoom ${percent}%` });
  await s.win.waitForTimeout(800);
}

export async function openThumbnails(s) {
  const rail = s.win.getByRole('button', { name: 'Thumbnails', exact: true }).first();
  if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click();
  await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
}

export const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
export const median = (values) => {
  const v = values.filter((x) => typeof x === 'number');
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * In the page: scroll `el` by `pxPerSec` (negative = up) for `ms`, one step per animation frame, and record the frame gaps.
 * Returns the gaps (ms) of the frames during the scroll.
 */
export function scrollAt(win, selector, pxPerSec, ms) {
  return win.evaluate(
    async ({ selector, pxPerSec, ms }) => {
      const el = document.querySelector(selector);
      const gaps = [];
      let last = performance.now();
      const started = last;
      while (performance.now() - started < ms) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        gaps.push(now - last);
        el.scrollTop += (pxPerSec * (now - last)) / 1000;
        last = now;
      }
      return gaps;
    },
    { selector, pxPerSec, ms },
  );
}

/** In the page: ms until every visible page of the first viewer is painted (any size) and until all are sharp (>= 90% of full width). */
export function timeToPaint(win, { limitMs = 8000, viewer = 0 } = {}) {
  return win.evaluate(
    async ({ limitMs, viewer }) => {
      const v = document.querySelectorAll('.viewer')[viewer];
      const dpr = window.devicePixelRatio || 1;
      const t0 = performance.now();
      let painted = null;
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const vr = v.getBoundingClientRect();
        const vis = [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; });
        const state = vis.map((p) => ({ w: p.querySelector('canvas').width, full: p.offsetWidth * dpr }));
        if (vis.length && painted === null && state.every((x) => x.w !== 300)) painted = Math.round(performance.now() - t0);
        if (vis.length && state.every((x) => x.w !== 300 && x.w >= 0.9 * x.full)) return { paintedMs: painted, sharpMs: Math.round(performance.now() - t0), visible: vis.length };
        if (performance.now() - t0 > limitMs) return { paintedMs: painted, sharpMs: null, visible: vis.length };
      }
    },
    { limitMs, viewer },
  );
}

export const frameStats = (gaps) => {
  const g = gaps.slice(1);
  return { frames: g.length, p95: Number(percentile(g, 0.95)?.toFixed(1) ?? NaN), worst: Number(Math.max(...g).toFixed(1)), over50: g.filter((x) => x > 50).length };
};

/** Real mouse drag of the scrollbar thumb of the first viewer to `stopFrac` (0..1) of the track, then release. Returns when released. */
export async function dragThumb(s, stopFrac) {
  const geom = () => s.win.locator('.viewer').first().evaluate((v) => {
    const r = v.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, sw: v.offsetWidth - v.clientWidth, top: v.scrollTop, sh: v.scrollHeight, ch: v.clientHeight };
  });
  const g = await geom();
  const x = g.x + g.w - g.sw / 2;
  const track0 = g.y + 20;
  const track1 = g.y + g.h - 20;
  const ty = track0 + (g.top / (g.sh - g.ch)) * (track1 - track0);
  await s.win.mouse.move(x, ty);
  await s.win.mouse.down();
  await s.win.mouse.move(x, track1, { steps: 30 });
  await s.win.mouse.move(x, track0 + stopFrac * (track1 - track0), { steps: 20 });
  await s.win.mouse.up();
}

/** Peak and settled Tab+GPU private MB, sampled while `work()` runs and once after. */
export async function withMemorySampling(s, work, { settleMs = 3000 } = {}) {
  let running = true;
  let peak = 0;
  const sampler = (async () => {
    while (running) {
      peak = Math.max(peak, Math.round((await rendererMemoryMB(s)).privateMB));
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  let out;
  try {
    out = await work();
  } finally {
    running = false;
    await sampler;
  }
  await s.win.waitForTimeout(settleMs);
  const end = await rendererMemoryMB(s);
  return { out, peakPrivateMB: peak, settledPrivateMB: Math.round(end.privateMB), byType: end.byType };
}

/** Runs `fn(rep)` and prints one JSON line `KNOB <sweep> {...}` per call; a failed run is printed as an error row and the sweep goes on. */
export async function runRow(sweep, meta, fn) {
  let s;
  try {
    s = await fn.launch();
    const result = await fn.run(s);
    const row = { sweep, ...meta, dpr: s.dpr, ...result };
    console.log(`KNOB ${JSON.stringify(row)}`);
    return row;
  } catch (error) {
    const row = { sweep, ...meta, error: String(error?.stack ?? error).slice(0, 400) };
    console.log(`KNOB ${JSON.stringify(row)}`);
    return row;
  } finally {
    await endRun(s).catch(() => undefined);
  }
}

export { closeAll as closeEverything };
