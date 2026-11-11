// Repro probe for the intermittent "1000 rows not seen after undo" failure. One cycle = open the 1000-page fixture's
// state, delete 500 pages, undo, then run the full thumbnail scan. Classification per cycle:
//   clean       the scan completed and saw 1000 rows, no step waited more than 150 ms for rows
//   helper-late the scan completed and saw 1000 rows, but some step waited longer than 150 ms (worst wait reported)
//   APP         the scan threw "APP: thumbnail rows not rendered ..." (rows still missing after 2 s), or saw the wrong count
// Phase A: 10 cycles in one session. Phase B: 10 cycles, a fresh launch (and fresh file open) every 2 cycles.
// Run: node tests/perf/thumb-scan-repro.probe.mjs   (take the machine lock first)
//
// Diagnostics (ticket 1.2.1 root cause): every cycle logs Tab/GPU private MB, the WASM heap, the JS heap, live workers,
// the journal and the worker queue. A failed cycle logs the step it failed in, the app's trace (window.__pdfSuiteDiag),
// the UI state (status bar, sheet, toasts, selection) and the main process's render-process-gone line.
// Env: REPRO_A / REPRO_B (cycles per phase, default 10 / 10), REPRO_OUT (JSONL file), REPRO_MAX_MS (stop starting new
// cycles after this long; default 20 minutes, 0 = no limit), REPRO_MODE=fast (no full scans: rows are reached by a direct scroll).
//
// DO NOT run this under an external timeout (`timeout`, a killed shell, a kill by a wrapper). A killed run looks like a
// renderer crash and leaves the app and its temp profiles behind. The probe stops itself between cycles through
// REPRO_MAX_MS, closes the app and removes its profiles; set REPRO_MAX_MS to bound the run instead.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { launch, closeAll, copyOf, removeCopy, open, palette, uids, pageCount, waitFor, delay, clickRowByIndex, lastScan, statusText } from '../e2e/matrix-lib.mjs';
import { rendererMemoryMB } from '../e2e/helpers.mjs';

const CYCLES_A = Number(process.env.REPRO_A ?? 10);
const CYCLES_B = Number(process.env.REPRO_B ?? 10);
const OUT = process.env.REPRO_OUT ?? null;
const MAX_MS = Number(process.env.REPRO_MAX_MS ?? 20 * 60 * 1000);
const FAST = process.env.REPRO_MODE === 'fast';
const DIAG_LOG = OUT ? `${OUT}.main.log` : null;
const started = Date.now();
const out = (line) => {
  console.log(line);
  if (OUT) appendFileSync(OUT, `${line}\n`);
};
const mb = (b) => (b == null ? null : Math.round((b / 1048576) * 10) / 10);

/** Per-cycle memory and engine facts. Never throws: a field that cannot be read is null. */
async function sample(s) {
  const mem = await rendererMemoryMB(s).catch(() => null);
  const eng = await s.win.evaluate(() => window.__pdfSuiteEngine?.memory?.()).catch(() => null);
  const d = await s.win.evaluate(() => window.__pdfSuiteEngine?.diag?.()).catch(() => null);
  const doc = d?.docs?.[0]?.stats;
  return {
    privMB: mem && Math.round(mem.privateMB),
    wsMB: mem && Math.round(mem.workingSetMB),
    byType: mem?.byType ?? null,
    jsMB: mb(eng?.jsHeapBytes),
    wasmMB: eng?.wasmHeapBytes?.map(mb) ?? null,
    thumbs: eng ? `${eng.bitmaps.thumbCount}/${mb(eng.bitmaps.thumbBytes)}MB` : null,
    pagesBmp: eng ? `${eng.bitmaps.pageCount}/${mb(eng.bitmaps.pageBytes)}MB` : null,
    workers: d?.liveWorkers ?? null,
    journal: doc?.diag?.journal ?? null,
    xref: doc?.diag?.xrefObjects ?? null,
    wq: doc?.worker ? { queue: doc.worker.queue, abandoned: doc.worker.abandoned, longest: doc.worker.longestJob, cancels: doc.worker.cancelsSeen, marked: doc.worker.abandonedMarked } : null,
    sysFreeMB: Math.round(freemem() / 1048576),
    // Windows: swapFree is the commit charge still available (page file + RAM), the limit an allocation fails against.
    commitFreeMB: await s.app.evaluate(() => Math.round(process.getSystemMemoryInfo().swapFree / 1024)).catch(() => null),
  };
}

/** What the app shows and traced, for a failed cycle. */
async function evidence(s, sinceT) {
  const ui = await s.win
    .evaluate((since) => {
      const text = (sel) => [...document.querySelectorAll(sel)].map((el) => el.innerText.trim().slice(0, 200));
      return {
        status: text('.status-bar, footer')[0] ?? null,
        sheet: document.querySelector('.side-sheet')?.getAttribute('data-sheet') ?? null,
        sheetFoot: text('.side-sheet-foot button'),
        toasts: text('.toast, [role="status"], [role="alert"]'),
        palette: document.querySelector('.palette') !== null,
        paletteInput: document.querySelector('.palette-input')?.value ?? null,
        paletteTop: text('.palette-list [role="option"]').slice(0, 4),
        paletteCount: document.querySelectorAll('.palette-list [role="option"]').length,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label')),
        hasFocus: document.hasFocus(),
        visibility: document.visibilityState,
        selectedRowsDrawn: document.querySelectorAll('.thumb-selected').length,
        active: document.activeElement?.className ?? null,
        trace: window.__pdfSuiteDiag?.events?.(since) ?? null,
      };
    }, sinceT)
    .catch((e) => ({ evaluateFailed: String(e.message).slice(0, 200) }));
  const engine = await s.win.evaluate(() => window.__pdfSuiteEngine?.diag?.()).catch((e) => ({ evaluateFailed: String(e.message).slice(0, 200) }));
  return { ui, engine, errors: s.errors.slice(-12), mainLog: DIAG_LOG && existsSync(DIAG_LOG) ? readFileSync(DIAG_LOG, 'utf8').trim().split('\n').slice(-6) : null };
}

/** Reaches a row without the full scan (fast mode): scrolls to where the row is, waits for it, clicks it. */
async function clickRowFast(win, index, modifiers = []) {
  const uid = await win.evaluate(async (i) => {
    const list = document.querySelector('.thumb-list');
    const rows = () => [...list.querySelectorAll('.thumb')].sort((a, b) => Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top));
    list.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 60));
    const first = rows();
    const pitch = Number.parseFloat(first[1].style.top) - Number.parseFloat(first[0].style.top);
    list.scrollTop = Math.max(0, i * pitch - list.clientHeight / 2);
    const start = performance.now();
    for (;;) {
      const hit = rows().find((el) => Math.abs(Number.parseFloat(el.style.top) - i * pitch) < 1);
      if (hit) return hit.dataset.uid;
      if (performance.now() - start > 2000) return null;
      await new Promise((r) => setTimeout(r, 20));
    }
  }, index);
  if (uid == null) throw new Error(`APP: row ${index} not drawn after a direct scroll`);
  await win.locator(`.thumb[data-uid="${uid}"]`).click({ modifiers });
}

/**
 * REPRO_PALETTE=guard: the palette helper, with one extra wait. A reopened palette first shows its previous query, and
 * clears it a moment later. This waits for the cleared input before typing, to show that the stale first frame is the
 * whole cause of the lost delete (the app fix removes the stale frame; this guard is only the experiment).
 */
async function paletteGuarded(win, label) {
  await win.keyboard.press('Control+k');
  const dialog = win.getByRole('dialog', { name: 'Command palette' });
  await dialog.waitFor({ timeout: 5000 });
  const input = dialog.getByPlaceholder('Type a command');
  await waitFor(async () => (await input.inputValue()) === '', { timeoutMs: 5000, label: 'palette input cleared' });
  await input.fill(label);
  await waitFor(async () => (await dialog.getByRole('option').first().innerText().catch(() => '')).includes(label), { timeoutMs: 5000, label: `palette lists "${label}"` });
  await input.press('Enter');
  await waitFor(async () => (await win.getByRole('dialog', { name: 'Command palette' }).count()) === 0, { timeoutMs: 5000, label: 'palette closed' });
}
const runPalette = process.env.REPRO_PALETTE === 'guard' ? paletteGuarded : palette;

async function cycle(s, at) {
  const click = FAST ? clickRowFast : clickRowByIndex;
  at.step = 'click row 0';
  await click(s.win, 0);
  at.step = 'shift-click row 499';
  await click(s.win, 499, ['Shift']);
  at.step = 'palette delete';
  at.selected = await s.win.evaluate(() => document.querySelectorAll('.thumb-selected').length).catch(() => null);
  const t0 = Date.now();
  await runPalette(s.win, 'Pages: Delete');
  at.step = 'wait 500 pages';
  await waitFor(async () => (await pageCount(s.win)) === 500, { timeoutMs: 30000, label: '500 pages' });
  at.deleteMs = Date.now() - t0;
  at.step = 'escape + undo';
  await s.win.keyboard.press('Escape');
  await s.win.evaluate(() => document.activeElement?.blur?.());
  const t1 = Date.now();
  await s.win.keyboard.press('Control+z');
  at.step = 'wait 1000 pages';
  await waitFor(async () => (await pageCount(s.win)) === 1000, { timeoutMs: 30000, label: '1000 pages after undo' });
  at.undoMs = Date.now() - t1;
  // Fast mode soaks delete/undo alone: no full scan.
  if (FAST) return { kind: 'clean', worstWaitMs: 0, scanMs: 0 };
  at.step = 'final scan';
  const t = Date.now();
  try {
    const ids = await uids(s.win);
    if (ids.length !== 1000) return { kind: 'APP', detail: `scan saw ${ids.length} rows`, scanMs: Date.now() - t };
    return { kind: lastScan.maxLateMs > 150 ? 'helper-late' : 'clean', worstWaitMs: Math.round(lastScan.maxLateMs), scanMs: Date.now() - t };
  } catch (e) {
    if (/crash/i.test(String(e.message))) throw e;
    return { kind: 'APP', detail: String(e.message).slice(0, 700), scanMs: Date.now() - t };
  }
}

async function phase(name, cycles, relaunchEvery) {
  const results = [];
  let s = null;
  let copy = null;
  let crashed = false;
  try {
    for (let i = 1; i <= cycles; i++) {
      if (MAX_MS && Date.now() - started > MAX_MS) {
        out(`${name} stopped before cycle ${i}: REPRO_MAX_MS reached`);
        break;
      }
      if (!s || crashed || (relaunchEvery && (i - 1) % relaunchEvery === 0)) {
        if (s) { await s.close(); removeCopy(copy); }
        crashed = false;
        copy = copyOf('big-1000.pdf');
        // ELECTRON_ENABLE_LOGGING sends Chromium's own log (a renderer's FATAL line, an out-of-memory note) to stderr, which launch() records.
        s = await launch({ env: { ELECTRON_ENABLE_LOGGING: '1', ...(DIAG_LOG ? { PDFSUITE_DIAG_LOG: DIAG_LOG } : {}) } });
        const session = s;
        s.win.on('crash', () => {
          crashed = true;
          out(`${name} RENDERER-CRASH-EVENT ${JSON.stringify({ cycle: i, at: new Date().toISOString(), sysFreeMB: Math.round(freemem() / 1048576), stderr: session.errors.filter((e) => /^\[stderr\]/.test(e)).slice(-25) })}`);
          // The main process logs render-process-gone a moment after the crash event.
          setTimeout(() => out(`${name} AFTER-CRASH-STDERR ${JSON.stringify(session.errors.filter((e) => /^\[stderr\]/.test(e)).slice(-25))}`), 1500);
        });
        await s.win.waitForSelector('.empty-state');
        await open(s, copy.path, 1000);
        await s.win.evaluate(() => window.__pdfSuiteDiag?.enable?.());
      }
      const at = { step: 'start' };
      const sinceT = await s.win.evaluate(() => window.__pdfSuiteDiag?.now?.() ?? 0).catch(() => 0);
      const r = { cycle: i, ...(await cycle(s, at).catch((e) => ({ kind: 'error', detail: String(e.message).slice(0, 300) }))) };
      r.deleteMs = at.deleteMs;
      r.undoMs = at.undoMs;
      r.selected = at.selected;
      if (r.kind === 'error' || r.kind === 'APP') {
        r.failedStep = at.step;
        await delay(1500);
        r.evidence = await evidence(s, sinceT);
        r.metricsAfter = await s.metrics().catch((e) => String(e.message).slice(0, 120));
        // Leave the app usable for the next cycle: close a palette, sheet or dialog the failed step left open.
        await s.win.keyboard.press('Escape').catch(() => undefined);
        await s.win.keyboard.press('Escape').catch(() => undefined);
      }
      // The palette's own trace for the first two cycles, as the reference a failed cycle is compared with.
      if (i <= 2 && !crashed) {
        r.paletteTrace = await s.win
          .evaluate((since) => (window.__pdfSuiteDiag?.events?.(since) ?? []).filter((e) => e.name.startsWith('palette')).map((e) => `${e.name}:${e.data?.value ?? e.data?.inputValue ?? e.data?.id ?? ''}`), sinceT)
          .catch(() => null);
      }
      r.mem = crashed ? null : await sample(s);
      r.t = new Date().toISOString().slice(11, 19);
      out(`${name} ${JSON.stringify(r)}`);
      results.push(r);
      await delay(500);
    }
  } finally {
    if (s) { await s.close(); removeCopy(copy); }
  }
  return results;
}
const count = (rs, k) => rs.filter((r) => r.kind === k).length;
const summarize = (rs) => ({ cycles: rs.length, clean: count(rs, 'clean'), helperLate: count(rs, 'helper-late'), worstLateMs: Math.max(0, ...rs.map((r) => r.worstWaitMs ?? 0)), app: count(rs, 'APP'), error: count(rs, 'error') });
let a = [];
let b = [];
try {
  if (CYCLES_A > 0) a = await phase('A(one session)', CYCLES_A, 0);
  if (CYCLES_B > 0) b = await phase('B(fresh launch every 2)', CYCLES_B, 2);
} finally {
  await closeAll();
}
out(JSON.stringify({ phaseA: summarize(a), phaseB: summarize(b), appFailures: [...a, ...b].filter((r) => r.kind === 'APP').map((r) => ({ cycle: r.cycle, detail: r.detail })) }));
