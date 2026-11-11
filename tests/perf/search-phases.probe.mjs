// Measurement only (perf-heavy ruling, 2026-11-10): where the time of a full search of heavy-1000.pdf goes, and what
// holds memory when the 73 MB image brochure is zoomed in. It asserts nothing and changes no app code.
//   node tests/perf/search-phases.probe.mjs [search] [brochure]     (through the test queue; exclusive)
// Search phases, per scenario: total (typing -> "n of 1000"), the worker round trips of the `text` requests (posted ->
// reply event), the time the page spends unpacking each reply (first read of event.data), the worker's own time inside
// MuPDF's text extraction (_wasm_new_stext_page_from_page) and inside postMessage (packing the reply), and the main
// thread's task/script/layout time from the DevTools Performance metrics.
// Brochure: per zoom step, the page canvases (count, megapixels), the engine's bitmap report, the WASM heap and the
// private bytes per process; then close, wait, a second open/zoom/close cycle (leak or plateau), and a purge.
import { join } from 'node:path';
import { launch, closeAll, cleanupProfile, statusText, waitFor, waitForPage, rendererMemoryMB } from '../e2e/helpers.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const HEAVY = join(ROOT, 'tests', 'signoff', 'out', 'heavy-1000.pdf');
const BROCHURE = join(ROOT, 'tests', 'engine', 'corpus', 'brochure-images', 'brochure.pdf');
const which = process.argv.slice(2);
const want = (k) => which.length === 0 || which.includes(k);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (label, value) => console.log(`${label} ${JSON.stringify(value)}`);

const INIT = `(() => {
  const Real = window.Worker;
  const log = (window.__workerLog = []);
  const T = (window.__wt = { sent: new Map(), done: [] });
  function Tracked(url, options) {
    const worker = new Real(url, options);
    const record = { url: String(url), live: true };
    log.push(record);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { record.live = false; terminate(); };
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (msg, transfer) => {
      if (msg && typeof msg.id === 'number' && msg.id > 0) T.sent.set(msg.id, { op: msg.op, t: performance.now() });
      return post(msg, transfer);
    };
    worker.addEventListener('message', (e) => {
      const t0 = performance.now();
      const d = e.data;
      const t1 = performance.now();
      const rec = d && typeof d.id === 'number' ? T.sent.get(d.id) : null;
      if (rec) { T.sent.delete(d.id); T.done.push({ op: rec.op, sent: rec.t, recv: t0, unpack: t1 - t0 }); }
    });
    return worker;
  }
  Tracked.prototype = Real.prototype;
  window.Worker = Tracked;
  window.__watchSearch = () => new Promise((resolve) => {
    const t0 = performance.now();
    let runAt = null; let firstHitAt = null;
    const tick = () => {
      const t = (document.querySelector('.search-status')?.textContent ?? '').trim();
      const running = /Searching|pages$/.test(t);
      const now = performance.now();
      if (running && runAt === null) runAt = now;
      if (runAt !== null && firstHitAt === null && /^\\d+ of \\d+/.test(t)) firstHitAt = now;
      if (runAt !== null && !running && (/^\\d+ of \\d+$/.test(t) || t === 'No matches')) return resolve({ status: t, totalMs: Math.round(now - t0), untilRunMs: Math.round(runAt - t0), firstHitMs: firstHitAt === null ? null : Math.round(firstHitAt - t0), t0 });
      if (now - t0 > 120000) return resolve({ timeout: true, status: t });
      setTimeout(tick, 3);
    };
    tick();
  });
})();`;

/** Inside each MuPDF worker: time in the text extraction call and in postMessage. Returns how many workers were patched. */
async function patchWorkers(win) {
  let patched = 0;
  for (const w of win.workers()) {
    const ok = await w.evaluate(() => {
      const M = globalThis.$libmupdf_wasm_Module;
      if (!M || typeof M._wasm_new_stext_page_from_page !== 'function') return false;
      if (globalThis.__wk) return true;
      const K = (globalThis.__wk = { stextMs: 0, stextN: 0, postMs: 0, postN: 0, postTextMs: 0, postTextN: 0 });
      const real = M._wasm_new_stext_page_from_page;
      M._wasm_new_stext_page_from_page = function (...a) { const t = performance.now(); try { return real.apply(this, a); } finally { K.stextMs += performance.now() - t; K.stextN += 1; } };
      const post = self.postMessage.bind(self);
      self.postMessage = (msg, transfer) => {
        const t = performance.now();
        try { return post(msg, transfer); } finally {
          const d = performance.now() - t; K.postMs += d; K.postN += 1;
          if (msg && Array.isArray(msg.result) && msg.result[0] && Array.isArray(msg.result[0].runs)) { K.postTextMs += d; K.postTextN += 1; }
        }
      };
      return true;
    }).catch(() => false);
    if (ok) patched += 1;
  }
  return patched;
}
async function workerCounters(win, reset) {
  const rows = [];
  for (const w of win.workers()) {
    const k = await w.evaluate((reset) => { const k = globalThis.__wk ? { ...globalThis.__wk } : null; if (reset && globalThis.__wk) for (const key of Object.keys(globalThis.__wk)) globalThis.__wk[key] = 0; return k; }, reset).catch(() => null);
    if (k && (k.stextN > 0 || k.postN > 0)) rows.push(k);
  }
  const sum = { stextMs: 0, stextN: 0, postMs: 0, postN: 0, postTextMs: 0, postTextN: 0 };
  for (const r of rows) for (const key of Object.keys(sum)) sum[key] += r[key];
  return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v)]));
}
async function perfMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const pick = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
  return { task: pick('TaskDuration'), script: pick('ScriptDuration'), layout: pick('LayoutDuration'), style: pick('RecalcStyleDuration') };
}

async function runSearch() {
  const s = await launch();
  try {
    await s.win.addInitScript(INIT);
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
    await delay(1500);
    await s.setDialogAnswer([HEAVY]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
    await delay(3000);
    const cdp = await s.app.context().newCDPSession(s.win);
    await cdp.send('Performance.enable');
    out('[search] workers patched', { patched: await patchWorkers(s.win), workers: s.win.workers().length });
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.waitFor({ timeout: 5000 });

    const scenario = async (label, query, { nav = false } = {}) => {
      await delay(700);
      await workerCounters(s.win, true);
      const before = await perfMetrics(cdp);
      const mark = await s.win.evaluate(() => { window.__wt.done.length = 0; return performance.now(); });
      const watch = s.win.evaluate(() => window.__watchSearch());
      const t0 = performance.now();
      await find.fill(query);
      const navMs = [];
      if (nav) {
        const box = s.win.getByLabel('Page number');
        for (const p of [250, 750]) {
          const t = performance.now();
          await box.click(); await box.fill(String(p)); await box.press('Enter');
          await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${p} of`), { timeoutMs: 10000, label: 'nav' });
          navMs.push(Math.round(performance.now() - t));
        }
      }
      const seen = await watch;
      const nodeMs = Math.round(performance.now() - t0);
      const after = await perfMetrics(cdp);
      const done = await s.win.evaluate((mark) => window.__wt.done.filter((d) => d.sent >= mark - 5), mark);
      const byOp = {};
      for (const d of done) {
        const o = (byOp[d.op] ??= { n: 0, roundTripMs: 0, unpackMs: 0, maxUnpackMs: 0 });
        o.n += 1; o.roundTripMs += d.recv - d.sent; o.unpackMs += d.unpack; o.maxUnpackMs = Math.max(o.maxUnpackMs, d.unpack);
      }
      for (const o of Object.values(byOp)) { o.roundTripMs = Math.round(o.roundTripMs); o.unpackMs = Math.round(o.unpackMs); o.maxUnpackMs = Math.round(o.maxUnpackMs); }
      const worker = await workerCounters(s.win, false);
      const engine = await s.win.evaluate(async () => { const m = await window.__pdfSuiteEngine.memory(); return { engineTextCacheMB: +(m.textCacheBytes / 1048576).toFixed(1), jsHeapMB: m.jsHeapBytes == null ? null : Math.round(m.jsHeapBytes / 1048576) }; });
      const ms = (a, b) => Math.round((b - a) * 1000);
      out(`[search] ${label}`, {
        query, status: seen.status, totalMs: seen.totalMs, nodeMs, untilRunMs: seen.untilRunMs, firstHitMs: seen.firstHitMs, navMs,
        requests: byOp, worker,
        mainThread: { taskMs: ms(before.task, after.task), scriptMs: ms(before.script, after.script), layoutMs: ms(before.layout, after.layout), styleMs: ms(before.style, after.style) },
        engine,
      });
    };
    await scenario('S1 cold, no navigation', 'Heavy');
    await scenario('S2 another word right after (every page was just read)', 'page');
    await scenario('S3 word that is not in the file', 'qqzzxxkk');
    await scenario('S4 as the perf probe: with jumps to pages 250 and 750', 'Heavy', { nav: true });
    await scenario('S5 same word again', 'Heavy');
    out('[search] errors', s.errors.slice(0, 5));
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(s.profile);
  }
}

async function runBrochure() {
  const s = await launch();
  try {
    await s.win.addInitScript(INIT);
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
    await delay(2500);
    const snap = async (label) => {
      const m = await rendererMemoryMB(s);
      const rows = await s.metrics();
      const ws = {};
      for (const r of rows) ws[r.type] = (ws[r.type] ?? 0) + Math.round(r.memKB / 1024);
      const page = await s.win.evaluate(async () => {
        const mp = (c) => (c.width * c.height) / 1e6;
        const all = [...document.querySelectorAll('canvas')];
        const pages = all.filter((c) => c.classList.contains('page-canvas'));
        const eng = window.__pdfSuiteEngine ? await window.__pdfSuiteEngine.memory() : null;
        const v = document.querySelector('.viewer');
        return {
          dpr: window.devicePixelRatio, viewer: v ? [v.clientWidth, v.clientHeight] : null,
          pagesInDom: document.querySelectorAll('.viewer .page').length,
          pageCanvases: pages.length, pageCanvasMP: +pages.reduce((t, c) => t + mp(c), 0).toFixed(1), pageCanvasSizes: pages.map((c) => `${c.width}x${c.height}`).slice(0, 12),
          otherCanvases: all.length - pages.length, otherCanvasMP: +all.filter((c) => !pages.includes(c)).reduce((t, c) => t + mp(c), 0).toFixed(1),
          bitmaps: eng ? eng.bitmaps : null, jsHeapMB: eng?.jsHeapBytes == null ? null : Math.round(eng.jsHeapBytes / 1048576), wasmMB: eng ? eng.wasmHeapBytes.map((b) => Math.round(b / 1048576)) : null,
          workersLive: window.__workerLog.filter((w) => w.live).length,
        };
      });
      const zoom = (await statusText(s.win).catch(() => '')).split('·')[1]?.trim() ?? null;
      out(`[brochure] ${label}`, { zoom, privateTabGpuMB: Math.round(m.privateMB), privateMB: m.byType, workingSetMB: ws, ...page });
    };
    const open = async () => {
      await s.setDialogAnswer([BROCHURE]);
      await s.win.keyboard.press('Control+o');
      await waitForPage(s, 'Page 1 of 12', { timeoutMs: 60000 });
      await waitFor(async () => s.win.evaluate(() => { const c = document.querySelector('.viewer .page[data-page-index="0"] canvas'); return c && c.width !== 300; }), { timeoutMs: 30000, label: 'brochure paint' });
    };
    const zoomPass = async (zoomIns, label) => {
      for (let i = 0; i < zoomIns; i++) await s.win.keyboard.press('Control+=');
      await delay(800);
      await s.win.evaluate(async () => {
        const v = document.querySelector('.viewer'); const max = v.scrollHeight - v.clientHeight;
        for (let i = 0; i <= 40; i++) { v.scrollTop = (max * i) / 40; await new Promise((r) => setTimeout(r, 120)); }
      });
      await delay(2500);
      await snap(label);
      await s.win.keyboard.press('Control+0');
    };
    const close = async () => {
      await s.win.locator('.tab-close').first().click();
      await s.win.waitForSelector('.empty-state', { timeout: 10000 });
    };
    await snap('base, nothing open');
    await open();
    for (const z of [0, 2, 4, 6, 8]) await zoomPass(z, `cycle 1, ${z} zoom-ins, after a full scroll`);
    await delay(1500);
    await snap('cycle 1, back at fit, before close');
    await close();
    await delay(2500); await snap('cycle 1, 2.5 s after close');
    await delay(7500); await snap('cycle 1, 10 s after close');
    await open();
    await zoomPass(8, 'cycle 2, 8 zoom-ins, after a full scroll');
    await close();
    await delay(2500); await snap('cycle 2, 2.5 s after close');
    await delay(7500); await snap('cycle 2, 10 s after close');
    await open();
    await zoomPass(8, 'cycle 3, 8 zoom-ins, after a full scroll');
    await close();
    await delay(10000); await snap('cycle 3, 10 s after close');
    await delay(20000); await snap('cycle 3, 30 s after close');
    let purged = 'failed';
    try {
      const cdp = await s.app.context().newCDPSession(s.win);
      await cdp.send('Memory.simulatePressureNotification', { level: 'critical' });
      purged = 'page session';
    } catch (e) { purged = `failed: ${String(e.message ?? e).slice(0, 120)}`; }
    await delay(10000);
    await snap(`10 s after a memory-pressure purge (${purged})`);
    out('[brochure] errors', s.errors.slice(0, 5));
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(s.profile);
  }
}

try {
  if (want('search')) await runSearch();
  if (want('brochure')) await runBrochure();
} catch (e) {
  console.log(`PROBE FAILED ${String(e.stack ?? e).slice(0, 900)}`);
  process.exitCode = 1;
} finally {
  await closeAll();
}
