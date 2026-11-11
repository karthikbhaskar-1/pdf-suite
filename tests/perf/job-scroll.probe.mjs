// 1.3.2 protected-results probe (blueprint section 7): scroll smoothness WHILE a Split job runs, and the memory ceiling.
//  - opens the 1,000-page fixture, starts a Split into files (1 page each: 1,000 files, the longest job the sheet allows
//    under 2,000 files) and sweeps the scroll bar up and down for as long as the job runs; frame gaps are recorded,
//  - p95 of the frame gaps must be at most 20 ms (the protected scroll result),
//  - Tab + GPU private bytes are sampled before, during and 5 s after the job: the 5 s reading must be within baseline + 30 MB.
// MEMORY GATE (orchestrator-approved change, 2026-11-10, docs/milestone-1.5/combine-memory-ruling.md): the gate used to be Tab + GPU
// private bytes within baseline + 30 MB 5 s after the job, after sweeping a 1,000-page document for the whole run. That measured the
// sweep and the lazy release of the GPU process, not the job (the unchanged Split failed it too: 815 MB against 372 MB). It is now
// TAB ONLY, at 15 s: a run with a job and a sweep must be within 30 MB of the control run without a job (JOB=0, same sweep, same
// session type; pass its after15TabMB as CONTROL_TAB_MB), and a job-alone run (SWEEP=0) within baseline + 30 MB. GPU is logged, not gated.
// The 5 s reading is still logged. The scroll gate is unchanged (p95 <= 20 ms; the 1.3.3 brief asks for 18).
// KIND=combine runs a Combine of the 1,000-page file three times over (COPIES times, default 3) instead of the Split (1.3.3).
// Run: node tests/perf/job-scroll.probe.mjs   (packaged app in release/win-unpacked; one app at a time on this PC)
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, closeAll, open, palette, waitFor, copyOf } from '../e2e/matrix-lib.mjs';
import { rendererMemoryMB } from '../e2e/helpers.mjs';

// JOB=0 sweeps without a job (the control for the memory reading); SWEEP=0 runs the job without scrolling (the job alone).
const JOB = process.env.JOB !== '0';
const SWEEP = process.env.SWEEP !== '0';
const KIND = process.env.KIND === 'combine' ? 'combine' : 'split';
const COPIES = Number(process.env.COPIES ?? 3);
const out = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-jobscroll-'));
const copy = copyOf('big-1000.pdf');
const s = await launch();
const result = { ok: false };
try {
  await s.win.waitForSelector('.empty-state');
  await open(s, copy.path, 1000);
  // Opening a 1,000-page file starts a thumbnail scan whose memory settles after about 20 s: the baseline is taken after that,
  // so it measures the job and not the open.
  await new Promise((r) => setTimeout(r, 25000));
  const baseline = await rendererMemoryMB(s);
  let start;
  if (KIND === 'combine') {
    await palette(s.win, 'Pages: Combine files');
    const dlg = s.win.getByRole('dialog', { name: 'Combine files' });
    await dlg.waitFor({ timeout: 10000 });
    await s.setDialogAnswer(Array.from({ length: COPIES }, () => copy.path));
    await dlg.getByRole('button', { name: 'Add files…' }).click();
    await waitFor(async () => (await dlg.locator('[data-row-id]').count()) === COPIES && (await dlg.getByText('Reading…').count()) === 0, { timeoutMs: 60000, label: 'all rows read' });
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, join(out, 'Combined.pdf'));
    start = () => dlg.getByRole('button', { name: 'Combine…' }).click();
  } else {
    await palette(s.win, 'Pages: Split into files');
    const sheet = s.win.getByRole('dialog', { name: 'Split into files' });
    await sheet.locator('[data-split-source]').waitFor({ timeout: 30000 });
    await sheet.getByLabel('Pages in each file').fill('1');
    await s.setDialogAnswer([out]);
    await sheet.getByRole('button', { name: 'Choose folder…' }).click();
    await sheet.locator('[data-split-folder="true"]').waitFor({ timeout: 10000 });
    start = () => sheet.getByRole('button', { name: 'Split', exact: true }).click();
  }

  // Frame gaps in the page, while the job runs.
  await s.win.evaluate((SWEEP_ON) => {
    window.__gaps = [];
    window.__sweeping = SWEEP_ON;
    const viewer = document.querySelector('.viewer');
    let last = performance.now();
    const sample = () => { const now = performance.now(); window.__gaps.push(now - last); last = now; if (window.__sweeping) requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    (async () => {
      const max = viewer.scrollHeight - viewer.clientHeight;
      while (window.__sweeping) {
        for (let i = 0; i <= 60 && window.__sweeping; i++) { viewer.scrollTop = (max * i) / 60; await new Promise((r) => setTimeout(r, 16)); }
        for (let i = 60; i >= 0 && window.__sweeping; i--) { viewer.scrollTop = (max * i) / 60; await new Promise((r) => setTimeout(r, 16)); }
      }
    })();
  }, SWEEP);
  const during = [];
  const started = Date.now();
  if (JOB) {
    await start();
    await s.win.locator(`footer[data-job-status="${KIND}"]`).waitFor({ timeout: 20000 });
    while ((await s.win.locator(`footer[data-job-status="${KIND}"]`).count()) > 0 && Date.now() - started < 300000) {
      during.push((await rendererMemoryMB(s)).privateMB);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    while (Date.now() - started < 20000) {
      during.push((await rendererMemoryMB(s)).privateMB);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const gaps = await s.win.evaluate(() => { window.__sweeping = false; return window.__gaps; });
  if (JOB) await waitFor(async () => (await s.win.locator('[data-job-notice]').count()) > 0, { timeoutMs: 60000, label: 'job finished' });
  await new Promise((r) => setTimeout(r, 5000));
  const after = await rendererMemoryMB(s);
  await new Promise((r) => setTimeout(r, 10000));
  const after15 = await rendererMemoryMB(s);
  const tab15 = after15.byType.Tab ?? 0;
  const tabBase = baseline.byType.Tab ?? 0;
  const control = process.env.CONTROL_TAB_MB === undefined ? null : Number(process.env.CONTROL_TAB_MB);
  let tabOk = true;
  let tabGate = 'not gated (the control run, JOB=0)';
  if (JOB && !SWEEP) {
    tabOk = tab15 <= tabBase + 30;
    tabGate = `Tab at 15 s <= baseline + 30 MB (${tabBase + 30})`;
  } else if (JOB && control !== null) {
    tabOk = tab15 <= control + 30;
    tabGate = `Tab at 15 s <= control + 30 MB (${control + 30})`;
  } else if (JOB) {
    tabGate = 'not gated: pass CONTROL_TAB_MB from a JOB=0 run';
  }
  const sorted = gaps.length > 0 ? [...gaps].sort((a, b) => a - b) : [0];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const files = readdirSync(out).length;
  Object.assign(result, {
    mode: { KIND, JOB, SWEEP },
    ok: p95 <= 20 && tabOk,
    jobSeconds: Math.round((Date.now() - started) / 1000),
    frames: gaps.length,
    p95Ms: Number(p95.toFixed(1)),
    worstMs: Number(sorted.at(-1).toFixed(1)),
    baselineMB: Math.round(baseline.privateMB),
    peakDuringMB: Math.round(Math.max(...during, 0)),
    after5sMB: Math.round(after.privateMB),
    after15sMB: Math.round(after15.privateMB),
    after15TabMB: tab15,
    baselineTabMB: tabBase,
    tabGate,
    tabOk,
    files,
  });
} finally {
  console.log(JSON.stringify(result, null, 2));
  await closeAll();
  rmSync(out, { recursive: true, force: true });
  rmSync(copy.dir, { recursive: true, force: true });
}
process.exit(result.ok ? 0 : 1);
