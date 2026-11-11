// G1 (1.5.4): Chromium memory-infra traces at passes 1, 12, 24 and 40 of the thumbnail soak, to name the allocation that grows.
// Same document and edits as tests/perf/mem-soak.probe.mjs (open big-1000, delete 500, move 50, rotate all, cancelled resize, three undos),
// then PASSES full scans of the thumbnail list with 10 s idle after each. At TRACE_PASSES a detailed memory dump of every process is
// written to <outDir>/trace-pass<N>.json (git-ignored folder), and Tab/GPU private MB per pass go to <outDir>/soak.json.
//   node tests/perf/mem-trace-soak.probe.mjs [outDir]   (about 12 minutes; take the machine lock first)
//   node tests/perf/mem-trace-diff.mjs <outDir>          (which allocators grew)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, closeAll, copyOf, removeCopy, open, palette, uids, waitForCount, pageCount, currentPageSize, canvasStats, waitFor, delay, clickRowByIndex, selectAllPages, placeWindow } from '../e2e/matrix-lib.mjs';
import { rendererMemoryMB } from '../e2e/helpers.mjs';

const outDir = process.argv[2] ?? join('tests', 'perf', 'out', 'g1');
mkdirSync(outDir, { recursive: true });
const PASSES = Number(process.env.PASSES ?? 40);
const TRACE_PASSES = (process.env.TRACE_PASSES ?? '1,12,24,40').split(',').map(Number);
// Idle after each pass: 10 s in mem-soak.probe.mjs. The shell allows a foreground command 10 minutes, so this run uses 3 s unless IDLE_MS is set.
const IDLE_MS = Number(process.env.IDLE_MS ?? 3000);
const round = (m) => ({ private: Math.round(m.privateMB), ws: Math.round(m.workingSetMB), byType: m.byType });

async function scrollToUid(win, index) {
  return win.evaluate(async (target) => {
    const list = document.querySelector('.thumb-list');
    const rows = [...list.querySelectorAll('.thumb')];
    const rowH = rows.length > 1 ? Number.parseFloat(rows[1].style.top) - Number.parseFloat(rows[0].style.top) : 120;
    list.scrollTop = Math.max(0, target * rowH - list.clientHeight / 2);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 40));
      if (list.querySelector(`.thumb[data-uid="${target}"]`)) return true;
    }
    return false;
  }, index);
}
async function edgeUid(win, end) {
  return win.evaluate(async (which) => {
    const list = document.querySelector('.thumb-list');
    if (!list) return null;
    list.scrollTop = which === 'last' ? list.scrollHeight : 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rows = [...list.querySelectorAll('.thumb')];
    if (rows.length === 0) return null;
    const top = (el) => Number.parseFloat(el.style.top);
    return rows.reduce((a, b) => ((which === 'last' ? top(b) > top(a) : top(b) < top(a)) ? b : a)).dataset.uid ?? null;
  }, end);
}

/** One memory-infra dump of all processes (same CDP method as tests/e2e/stress-edit.e2e.mjs traceMemory). */
async function traceMemory(s, file) {
  const cdp = await s.app.context().newCDPSession(s.win);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  try {
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } },
    });
    await cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed', deterministic: false });
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    writeFileSync(file, JSON.stringify({ traceEvents: events }));
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

const copy = copyOf('big-1000.pdf');
const s = await launch();
const summary = { passes: [], traces: [], machine: null };
try {
  await s.win.waitForSelector('.empty-state');
  await placeWindow(s, { width: 1400, height: 900 });
  await open(s, copy.path, 1000);
  await clickRowByIndex(s.win, 0);
  await scrollToUid(s.win, 499);
  await s.win.locator('.thumb[data-uid="499"]').click({ modifiers: ['Shift'] });
  await palette(s.win, 'Pages: Delete');
  await waitFor(async () => (await pageCount(s.win)) === 500 && (await edgeUid(s.win, 'first')) === '500', { timeoutMs: 30000, label: '500 pages after delete' });
  await waitForCount(s.win, 500, '500 pages after the delete');
  await clickRowByIndex(s.win, 0);
  await clickRowByIndex(s.win, 49, ['Shift']);
  await palette(s.win, 'Pages: Move to the end');
  await waitFor(async () => (await edgeUid(s.win, 'last')) === '549', { timeoutMs: 30000, label: 'moved block at the end' });
  await selectAllPages(s.win);
  await palette(s.win, 'Pages: Rotate right 90°');
  await s.win.locator('.toast', { hasText: 'Rotated' }).first().waitFor({ timeout: 120000 });
  await waitFor(async () => (await currentPageSize(s.win)).width > 790, { timeoutMs: 60000, label: 'rotated page is landscape' });
  const beforeResize = await currentPageSize(s.win);
  await selectAllPages(s.win);
  await palette(s.win, 'Pages: Set page size…');
  const dialog = s.win.getByRole('dialog', { name: 'Page size' });
  await dialog.waitFor();
  await dialog.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: 'A4' }).click();
  await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  const cancel = s.win.getByRole('button', { name: 'Cancel', exact: true }).last();
  await waitFor(async () => (await cancel.count()) > 0 && (await s.win.locator('progress, [role="progressbar"]').count()) > 0, { timeoutMs: 60000, label: 'progress bar with Cancel' });
  await cancel.click();
  await waitFor(async () => (await s.win.locator('progress, [role="progressbar"]').count()) === 0, { timeoutMs: 60000, label: 'progress gone' });
  await delay(800);
  if ((await currentPageSize(s.win)).width !== beforeResize.width) throw new Error('Cancel did not roll the resize back');
  for (let i = 0; i < 3; i++) {
    await s.win.keyboard.press('Escape');
    await s.win.evaluate(() => document.activeElement?.blur?.());
    await s.win.keyboard.press('Control+z');
    await delay(1500);
  }
  await waitForCount(s.win, 1000, '1000 pages after undo');
  await s.win.locator('.thumb').first().click();
  await delay(400);
  const stats = await canvasStats(s.win);
  if (!(stats && stats.darkShare > 0)) throw new Error('page 1 does not render');
  summary.end = round(await rendererMemoryMB(s));
  for (let pass = 1; pass <= PASSES; pass++) {
    const t = Date.now();
    const n = (await uids(s.win)).length;
    if (n !== 1000) throw new Error(`pass ${pass}: scan saw ${n} rows`);
    const scanMs = Date.now() - t;
    await delay(IDLE_MS);
    const m = round(await rendererMemoryMB(s));
    summary.passes.push({ pass, scanMs, ...m });
    console.log(`pass ${pass}: private ${m.private} MB (Tab ${m.byType.Tab}, GPU ${m.byType.GPU}), scan ${scanMs} ms`);
    if (TRACE_PASSES.includes(pass)) {
      const file = join(outDir, `trace-pass${pass}.json`);
      await traceMemory(s, file);
      summary.traces.push(file);
      console.log(`  trace written: ${file}`);
    }
  }
  summary.ok = true;
} catch (error) {
  summary.error = String(error?.stack ?? error).slice(0, 800);
  console.log(summary.error);
} finally {
  writeFileSync(join(outDir, 'soak.json'), JSON.stringify(summary, null, 2));
  await s.close();
  removeCopy(copy);
  await closeAll();
}
