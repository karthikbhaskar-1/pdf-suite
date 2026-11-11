// L1 (1.5.3): open, scroll, edit and save one big file; time each step, peak private bytes per process, WASM heap, and whether the
// save check (reopen of the saved bytes in a second worker) fits. The result is one JSON file; nothing is asserted.
//   node tests/perf/limit-open.probe.mjs <path-to-big.pdf> [outJson]
// Take the machine lock first. The file is copied to a temp folder (a save writes over the copy) and removed at the end.
// Steps: open (to the first page, and to "Page 1 of N") -> fast scroll down and up, then time until the viewport has no placeholder
//        -> jump to the last page -> delete page 1 (a full save) -> Ctrl+S -> read the result (saved, or the message shown).
import { statSync, writeFileSync } from 'node:fs';
import { launch, closeAll, cleanupProfile, placeWindow, statusText, waitFor } from '../e2e/helpers.mjs';
import { copyOf, removeCopy, palette, showPanel, delay } from '../e2e/matrix-lib.mjs';

const src = process.argv[2];
const outJson = process.argv[3];
if (!src) throw new Error('usage: limit-open.probe.mjs <pdf> [out.json]');
const copy = copyOf(src);
const bytes = statSync(copy.path).size;
const s = await launch();
const res = { file: src, bytes, mb: +(bytes / 1048576).toFixed(1), steps: {}, peak: {}, errors: [], crashes: [] };
const sleep = delay;
let sampling = true;
const peakByType = {};
const peakByPid = {};
let peakTotal = 0;
let peakWasm = 0;
let wasmAtPeak = [];
const wasmSeries = [];
const t00 = Date.now();
s.app.process().on('exit', (code) => res.crashes.push(`app process exited, code ${code}, at ${Date.now() - t00} ms`));
s.win.on('crash', () => res.crashes.push(`renderer crashed at ${Date.now() - t00} ms`));
s.win.on('close', () => res.crashes.push(`window closed at ${Date.now() - t00} ms`));

const sampler = (async () => {
  let n = 0;
  while (sampling) {
    try {
      const rows = await s.metrics();
      let total = 0;
      const byType = {};
      for (const r of rows) {
        const mb = (r.privateKB ?? 0) / 1024;
        total += mb;
        byType[r.type] = (byType[r.type] ?? 0) + mb;
        const key = `${r.type}#${r.pid}`;
        peakByPid[key] = Math.max(peakByPid[key] ?? 0, mb);
      }
      for (const [t, v] of Object.entries(byType)) peakByType[t] = Math.max(peakByType[t] ?? 0, v);
      peakTotal = Math.max(peakTotal, total);
      if (n++ % 2 === 0) {
        const heaps = await s.win.evaluate(async () => (await window.__pdfSuiteEngine?.wasmHeapBytes?.()) ?? null).catch(() => null);
        if (heaps) {
          const mx = Math.max(0, ...heaps) / 1048576;
          wasmSeries.push({ t: Date.now() - t00, mb: heaps.map((b) => Math.round(b / 1048576)) });
          if (mx > peakWasm) { peakWasm = mx; wasmAtPeak = heaps.map((b) => Math.round(b / 1048576)); }
        }
      }
    } catch {
      // the app may be gone; the steps record that
    }
    await sleep(200);
  }
})();

const step = async (name, fn) => {
  const t0 = performance.now();
  try {
    const value = await fn();
    res.steps[name] = { ms: Math.round(performance.now() - t0), ...(value ?? {}) };
  } catch (error) {
    res.steps[name] = { ms: Math.round(performance.now() - t0), failed: String(error?.message ?? error).slice(0, 300) };
    return false;
  }
  console.log(name, JSON.stringify(res.steps[name]));
  return true;
};

try {
  await s.win.waitForSelector('.empty-state');
  await placeWindow(s, { width: 1400, height: 900 });
  res.baselinePrivateMB = Math.round((await s.metrics()).reduce((t, r) => t + (r.privateKB ?? 0) / 1024, 0));
  // 1. open
  await s.setDialogAnswer([copy.path]);
  const tOpen = performance.now();
  await s.win.keyboard.press('Control+o');
  let pages = 0;
  const opened = await step('open', async () => {
    for (;;) {
      const msg = s.win.locator('.tab-message[role="alert"]');
      if ((await msg.count()) > 0) return { outcome: 'message', text: (await msg.first().innerText()).trim() };
      if ((await s.win.locator('.page-canvas').count()) > 0) break;
      if (performance.now() - tOpen > 240000) throw new Error('no page or message after 240 s');
      await sleep(100);
    }
    const firstPageMs = Math.round(performance.now() - tOpen);
    await waitFor(async () => /^Page 1 of \d+/.test(await statusText(s.win)), { timeoutMs: 120000, label: 'status bar' });
    pages = Number(/of (\d+)/.exec(await statusText(s.win))[1]);
    return { outcome: 'page', firstPageMs, statusMs: Math.round(performance.now() - tOpen), pages };
  });
  res.pages = pages;
  const openedOk = opened && res.steps.open.outcome === 'page';
  if (openedOk) {
    await sleep(2000);
    res.afterOpenPrivateMB = Math.round((await s.metrics()).reduce((t, r) => t + (r.privateKB ?? 0) / 1024, 0));
    // 2. scroll: fast sweep down and up, then time to a painted viewport
    await step('scroll', async () => {
      const sweep = await s.win.evaluate(async () => {
        const v = document.querySelector('.viewer');
        const max = v.scrollHeight - v.clientHeight;
        const gaps = [];
        let last = performance.now();
        let run = true;
        const tick = () => { const n = performance.now(); gaps.push(n - last); last = n; if (run) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        const steps = 80;
        for (let i = 0; i <= steps; i++) { v.scrollTop = (max * i) / steps; await new Promise((r) => setTimeout(r, 12)); }
        for (let i = steps; i >= 0; i--) { v.scrollTop = (max * i) / steps; await new Promise((r) => setTimeout(r, 12)); }
        run = false;
        const sorted = [...gaps].sort((a, b) => a - b);
        return { frames: gaps.length, p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]), maxFrameMs: Math.round(sorted.at(-1)) };
      });
      const t = performance.now();
      await waitFor(
        () => s.win.evaluate(() => {
          const v = document.querySelector('.viewer');
          const vr = v.getBoundingClientRect();
          return [...v.querySelectorAll('.page-placeholder')].every((p) => { const r = p.getBoundingClientRect(); return r.bottom < vr.top || r.top > vr.bottom; });
        }),
        { timeoutMs: 120000, label: 'viewport painted' },
      );
      return { ...sweep, toPaintedMs: Math.round(performance.now() - t) };
    });
    // 3. jump to the last page
    await step('jumpLast', async () => {
      const box = s.win.getByLabel('Page number');
      await box.click();
      await box.fill(String(pages));
      await box.press('Enter');
      await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${pages} of ${pages}`), { timeoutMs: 120000, label: 'last page' });
      await waitFor(
        () => s.win.evaluate(() => {
          const v = document.querySelector('.viewer');
          const vr = v.getBoundingClientRect();
          return [...v.querySelectorAll('.page-placeholder')].every((p) => { const r = p.getBoundingClientRect(); return r.bottom < vr.top || r.top > vr.bottom; });
        }),
        { timeoutMs: 120000, label: 'last page painted' },
      );
    });
    // 4. edit: delete page 1 (makes the save a full save)
    const edited = await step('edit', async () => {
      await showPanel(s.win, 'Thumbnails');
      await s.win.locator('.thumb').first().waitFor({ timeout: 60000 });
      await s.win.evaluate(() => { document.querySelector('.thumb-list').scrollTop = 0; });
      await sleep(500);
      await s.win.locator('.thumb').first().click();
      await palette(s.win, 'Pages: Delete');
      await waitFor(async () => (await statusText(s.win)).includes(`of ${pages - 1}`) || (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 120000, label: 'edit applied' });
    });
    // 5. save (full): the document, then the check in a second worker, then the write
    if (edited) {
      const tSave = performance.now();
      await s.win.keyboard.press('Control+s');
      await step('save', async () => {
        for (;;) {
          if ((await s.win.locator('.tab-dirty').count()) === 0) return { outcome: 'saved' };
          const toast = await s.win.locator('.toast, [role="alert"]').allInnerTexts().catch(() => []);
          const bad = toast.find((t) => /could not|too large|failed|not be saved|did not match|memory/i.test(t));
          if (bad) return { outcome: 'message', text: bad.slice(0, 300) };
          if (performance.now() - tSave > 360000) throw new Error('save did not finish in 360 s');
          await sleep(200);
        }
      });
      try { res.bytesAfterSave = statSync(copy.path).size; } catch { res.bytesAfterSave = null; }
      res.pagesAfterSave = await statusText(s.win).catch(() => '');
    }
  }
} catch (error) {
  res.fatal = String(error?.stack ?? error).slice(0, 600);
} finally {
  sampling = false;
  await sampler;
  res.peak = {
    totalPrivateMB: Math.round(peakTotal),
    byTypeMB: Object.fromEntries(Object.entries(peakByType).map(([k, v]) => [k, Math.round(v)])),
    topProcessesMB: Object.entries(peakByPid).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}: ${Math.round(v)}`),
    wasmPeakMB: Math.round(peakWasm),
    wasmAtPeakMB: wasmAtPeak,
  };
  res.wasmSeries = wasmSeries.filter((_, i) => i % 3 === 0).slice(0, 60);
  res.errors = s.errors.filter((e) => !/favicon/.test(e)).slice(0, 10);
  await s.close().catch(() => undefined);
  cleanupProfile(s.profile);
  removeCopy(copy);
  await closeAll();
  console.log(JSON.stringify({ ...res, wasmSeries: undefined }));
  if (outJson) writeFileSync(outJson, JSON.stringify(res, null, 2));
}
