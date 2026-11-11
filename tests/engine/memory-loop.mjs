// Memory loop (handoff item 2): open the 1,000-page fixture, fast-scroll it, close the tab, 20 times.
// After each loop records renderer+GPU memory (app.getAppMetrics) and the live MuPDF worker count.
// Worker count: an init script wraps the Worker constructor in the renderer and tracks terminate() calls.
// Run: node tests/engine/memory-loop.mjs   (writes JSON to the path in MEMORY_LOOP_OUT, default ./memory-loop.json, which is git-ignored)
// Exits non-zero when a gate fails: steady-state slope (loops 11-20) <= 2 MB/loop, memAfterClose <= 600 MB on the
// last 5 loops, workers back to baseline after every close, WASM peak <= 256 MB, no app errors.
import { writeFileSync } from 'node:fs';
import { launch, fixture, statusText, waitFor, waitForPage, closeAll, cleanupProfile } from '../e2e/helpers.mjs';

const LOOPS = Number(process.env.MEMORY_LOOPS ?? 20);
const OUT = process.env.MEMORY_LOOP_OUT ?? 'memory-loop.json';

// Runs in the renderer before the app's own scripts. Records every Worker and whether it was terminated.
const TRACK_WORKERS = `(() => {
  const RealWorker = window.Worker;
  const log = (window.__workerLog = []);
  function TrackedWorker(url, options) {
    const worker = new RealWorker(url, options);
    const record = { url: String(url), live: true };
    log.push(record);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { record.live = false; terminate(); };
    return worker;
  }
  TrackedWorker.prototype = RealWorker.prototype;
  window.Worker = TrackedWorker;
})();`;

const sumMB = (metrics, types) =>
  metrics.filter((m) => types.includes(m.type)).reduce((total, m) => total + m.memKB, 0) / 1024;

// MuPDF workers are the module workers from src/engine/mupdf/pool.ts. pdf.js has its own worker file name.
async function liveWorkers(win) {
  return win.evaluate(() => {
    const all = window.__workerLog ?? [];
    const mupdf = all.filter((w) => w.live && !/pdf\.?worker|pdfjs/i.test(w.url));
    return { live: all.filter((w) => w.live).length, mupdfLive: mupdf.length, mupdfUrls: mupdf.map((w) => w.url) };
  });
}

async function fastScroll(win) {
  return win.evaluate(async () => {
    const viewer = document.querySelector('.viewer');
    if (!viewer) return { error: 'no .viewer element' };
    const max = viewer.scrollHeight - viewer.clientHeight;
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      viewer.scrollTop = (max * i) / steps;
      await new Promise((r) => setTimeout(r, 12));
    }
    for (let i = steps; i >= 0; i--) {
      viewer.scrollTop = (max * i) / steps;
      await new Promise((r) => setTimeout(r, 12));
    }
    return { ok: true };
  });
}

function slopeMBPerLoop(points) {
  const n = points.length;
  const xs = points.map((_, i) => i + 1);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = points.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((sum, x, i) => sum + (x - mx) * (points[i] - my), 0);
  const den = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return num / den;
}

const s = await launch();
const rows = [];
let wasmPeakMB = 0;
try {
  // Install the worker tracker, then reload so it wraps Worker before the app's prewarm runs.
  await s.win.addInitScript(TRACK_WORKERS);
  await s.win.reload();
  await s.win.waitForLoadState('domcontentloaded');
  await s.win.waitForSelector('.empty-state');
  // Let the warm spare start, so the baseline includes it.
  await waitFor(async () => (await liveWorkers(s.win)).mupdfLive >= 1, { timeoutMs: 30000, label: 'warm spare worker' });
  const baseline = await liveWorkers(s.win);
  const baseMem = sumMB(await s.metrics(), ['Tab', 'GPU']);
  console.log(`baseline: renderer+GPU ${baseMem.toFixed(0)} MB, mupdf workers ${baseline.mupdfLive}`);
  console.log(`  worker urls seen at start: ${JSON.stringify(baseline.mupdfUrls)}`);

  for (let loop = 1; loop <= LOOPS; loop++) {
    const t0 = performance.now();
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
    const openMs = Math.round(performance.now() - t0);
    const scroll = await fastScroll(s.win);
    if (scroll.error) throw new Error(`loop ${loop}: ${scroll.error}`);
    await s.win.waitForTimeout(500);
    const during = await liveWorkers(s.win);
    const memAfterScroll = sumMB(await s.metrics(), ['Tab', 'GPU']);
    // WASM heap of every open MuPDF worker, read through the engine test hook while the document is open.
    const heaps = await s.win.evaluate(async () => (await window.__pdfSuiteEngine?.wasmHeapBytes()) ?? []);
    const wasmMB = Math.max(0, ...heaps) / 1048576;
    wasmPeakMB = Math.max(wasmPeakMB, wasmMB);
    if (wasmMB > 256) throw new Error(`loop ${loop}: WASM heap ${wasmMB.toFixed(1)} MB (limit 256 MB)`);

    // Close the tab and wait for the viewer to empty.
    await s.win.locator('.tab-close').first().click();
    await waitFor(async () => (await s.win.locator('.page-canvas').count()) === 0, { timeoutMs: 15000, label: 'tab closed' });
    await s.win.waitForTimeout(1500);
    const afterClose = await liveWorkers(s.win);
    const memAfterClose = sumMB(await s.metrics(), ['Tab', 'GPU']);
    const row = {
      loop,
      openMs,
      status: (await statusText(s.win)).slice(0, 40),
      memAfterScrollMB: Math.round(memAfterScroll),
      memAfterCloseMB: Math.round(memAfterClose),
      workersDuringDoc: during.mupdfLive,
      workersAfterClose: afterClose.mupdfLive,
      wasmHeapMB: Math.round(wasmMB),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const closeMem = rows.map((r) => r.memAfterCloseMB);
  // The first loops warm up (caches, the spare worker, font and code paths). The steady state is loops 11 to 20.
  const WARM_UP_LOOPS = 10;
  const steady = closeMem.slice(WARM_UP_LOOPS);
  const fullSlope = Number(slopeMBPerLoop(closeMem).toFixed(2));
  const steadySlope = steady.length >= 2 ? Number(slopeMBPerLoop(steady).toFixed(2)) : null;
  const lastFive = closeMem.slice(-5);
  const summary = {
    baselineMemMB: Math.round(baseMem),
    baselineWorkers: baseline.mupdfLive,
    endMemMB: closeMem.at(-1),
    slopeMBPerLoop: fullSlope,
    steadySlopeMBPerLoop: steadySlope,
    maxMemAfterCloseLast5MB: Math.max(...lastFive),
    maxWorkersAfterClose: Math.max(...rows.map((r) => r.workersAfterClose)),
    wasmPeakMB: Math.round(wasmPeakMB),
    errors: s.errors,
    rows,
  };
  // Gates. Each failure is listed, so a failing run says exactly which check broke.
  const failures = [];
  if (steadySlope === null || steadySlope > 2) failures.push(`steady-state slope ${steadySlope} MB/loop (limit 2)`);
  if (summary.maxMemAfterCloseLast5MB > 600) failures.push(`memAfterClose ${summary.maxMemAfterCloseLast5MB} MB on the last 5 loops (limit 600)`);
  const leaked = rows.filter((r) => r.workersAfterClose !== baseline.mupdfLive);
  if (leaked.length > 0) failures.push(`workers after close not at baseline (${baseline.mupdfLive}) on loops ${leaked.map((r) => r.loop).join(', ')}`);
  if (wasmPeakMB > 256) failures.push(`WASM peak ${Math.round(wasmPeakMB)} MB (limit 256)`);
  if (s.errors.length > 0) failures.push(`${s.errors.length} error(s) in the app`);
  summary.failures = failures;
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
  console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} memory loop: steady slope ${steadySlope} MB/loop (full ${fullSlope}), last-5 max ${summary.maxMemAfterCloseLast5MB} MB, workers at baseline ${leaked.length === 0}, WASM peak ${Math.round(wasmPeakMB)} MB, errors ${s.errors.length}${failures.length ? ' | ' + failures.join('; ') : ''}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await s.close();
  await closeAll();
  cleanupProfile(s.profile);
}
