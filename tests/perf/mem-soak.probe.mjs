// Memory soak probe (ticket 1.2.1). Opens the 1,000-page fixture, does the same edits as tests/e2e/stress-edit.e2e.mjs up to
// its `end` point (delete 500, move 50, rotate all, cancelled resize, three undos), then:
//   R1: 24 full thumbnail-list scans (the uids() logic of matrix-lib), 10 s idle after each. After each pass it records
//       Tab+GPU private MB, working-set MB and __pdfSuiteEngine.memory(). Passes 1-12 are warm-up (logged; only the 720 MB ceiling applies).
//       PASS judges the last 12 passes (13-24): (a) slope < 3 MB/pass, (b) median(last 4) - median(first 4 of the window) < 15 MB,
//       (c) the 60 s idle reading <= median(last 4) + 15 MB, (d) every reading in the run < 720 MB. See tests/lib/soak-criteria.mjs.
//   R2: 60 s idle, then both metrics again.
// WHY: the old 8-pass gate (slope over passes 2-8) failed on a healthy machine with 553, 578, 585, 592, 585, 593, 600 MB (slope 6.1): it measured the
// climb to the plateau. A 40-pass run right after (420 ... 586 at pass 5, 610 at pass 13, then 591-622 through pass 40; slope over 13-40 near zero,
// highest 622) showed memory climbs for about a dozen passes and then plateaus.
// `--passes=N` (N >= 24) is the long mode: same rule, the last 12 passes are the judged window (reported). `--floor` is unchanged.
// Run: node tests/perf/mem-soak.probe.mjs   (about 9 minutes; take the machine lock first)
import assert from 'node:assert/strict';
import { launch, closeAll, copyOf, removeCopy, open, palette, uids, waitForCount, pageCount, currentPageSize, canvasStats, assertNoErrors, waitFor, delay, clickRowByIndex, selectAllPages } from '../e2e/matrix-lib.mjs';
import { rendererMemoryMB } from '../e2e/helpers.mjs';
import { soakCriteria, median, slope } from '../lib/soak-criteria.mjs';

// Pass count: `--passes=N` or PASSES=N; the default 24 proves a plateau (judged on the last 12). Counts under 24 are not allowed except with --floor.
const PASSES = Number(process.argv.find((a) => a.startsWith('--passes='))?.slice(9) ?? process.env.PASSES ?? 24);
// `--floor` (with --passes=N): purge-floor mode. Purge, F0, N passes, purge, F1, then a three-condition verdict (see floorVerdict).
// `--purge-check`: throwaway check that the purge works (open, 10 scans, purge, print Tab/GPU before and after).
const FLOOR = process.argv.includes('--floor');
const PURGE_CHECK = process.argv.includes('--purge-check');
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
async function engineMemory(win) {
  const eng = await win.evaluate(() => window.__pdfSuiteEngine?.memory?.()).catch(() => null);
  const mb = (b) => (b == null ? null : Math.round(b / 1048576));
  return eng && { pageBitmapsMB: mb(eng.bitmaps.pageBytes), thumbBitmapsMB: mb(eng.bitmaps.thumbBytes), textMB: mb(eng.textCacheBytes), jsMB: mb(eng.jsHeapBytes), wasmMB: eng.wasmHeapBytes.map(mb) };
}
async function sample(s) {
  return { ...round(await rendererMemoryMB(s)), engine: await engineMemory(s.win) };
}

/** Evidence for a failed 1000-row scan: which uids are missing, and whether they are absent from the DOM or have a wrong top. */
async function scanEvidence(win) {
  return win.evaluate(async () => {
    const list = document.querySelector('.thumb-list');
    if (!list) return { error: 'no .thumb-list' };
    const seen = new Map();
    const step = Math.max(120, list.clientHeight / 2);
    for (let y = 0; y <= list.scrollHeight; y += step) {
      list.scrollTop = y;
      await new Promise((r) => setTimeout(r, 150));
      for (const el of list.querySelectorAll('.thumb')) seen.set(Number.parseFloat(el.style.top), el.dataset.uid);
    }
    const tops = [...seen.keys()].sort((a, b) => a - b);
    const rowH = tops.length > 1 ? tops[1] - tops[0] : null;
    const missingSlots = [];
    if (rowH) for (let i = 0; i < 1000 && missingSlots.length < 10; i++) if (!seen.has(tops[0] + i * rowH)) missingSlots.push(i);
    const probe = [];
    for (const slot of missingSlots.slice(0, 3)) {
      list.scrollTop = Math.max(0, tops[0] + slot * rowH - list.clientHeight / 2);
      await new Promise((r) => setTimeout(r, 500));
      probe.push({ slot, rowsDrawn: list.querySelectorAll('.thumb').length, drawnTops: [...list.querySelectorAll('.thumb')].map((e) => Number.parseFloat(e.style.top)).filter((t) => Math.abs(t - slot * rowH) < 600) });
    }
    return { distinctTops: tops.length, rowH, scrollHeight: list.scrollHeight, expectedHeight: rowH && rowH * 1000, missingSlots, probe, uniqueUids: new Set(seen.values()).size };
  });
}

/** Chrome DevTools Protocol memory-pressure purge, then 10 s wait. Tries the page session first, then a browser-level one. */
let cdpSession = null;
async function purge(s) {
  const attempts = [];
  for (const kind of ['page', 'browser']) {
    try {
      if (kind === 'page') cdpSession ??= await s.app.context().newCDPSession(s.win);
      else {
        const browser = s.app.context().browser();
        if (!browser) throw new Error('no browser-level session available');
        cdpSession = await browser.newBrowserCDPSession();
      }
      await cdpSession.send('Memory.simulatePressureNotification', { level: 'critical' });
      await delay(10000);
      return kind;
    } catch (e) {
      attempts.push(`${kind}: ${e.message}`);
      cdpSession = null;
    }
  }
  throw new Error(`Memory.simulatePressureNotification refused: ${attempts.join(' | ')}`);
}
/** F = median of 3 samples 2 s apart of Tab + GPU private MB, with Tab and GPU separately. */
async function floorSample(s) {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    if (i) await delay(2000);
    const m = round(await rendererMemoryMB(s));
    rows.push({ total: m.private, tab: m.byType.Tab ?? 0, gpu: m.byType.GPU ?? 0 });
  }
  return { total: median(rows.map((r) => r.total)), tab: median(rows.map((r) => r.tab)), gpu: median(rows.map((r) => r.gpu)), raw: rows };
}

const copy = copyOf('big-1000.pdf');
const s = await launch();
const summary = { passes: [], pass: false };
let failure = null;
try {
  await s.win.waitForSelector('.empty-state');
  await open(s, copy.path, 1000);
  summary.afterOpen = await sample(s);

  if (PURGE_CHECK) {
    for (let i = 1; i <= 10; i++) {
      assert.equal((await uids(s.win)).length, 1000, `scan ${i}`);
      const m = round(await rendererMemoryMB(s));
      console.log(`purge-check scan ${i}: total ${m.private} (Tab ${m.byType.Tab}, GPU ${m.byType.GPU})`);
    }
    const before = await floorSample(s);
    summary.purgeCheck = { before: { total: before.total, tab: before.tab, gpu: before.gpu }, via: await purge(s), after: await floorSample(s) };
    summary.purgeCheck.dropMB = summary.purgeCheck.before.total - summary.purgeCheck.after.total;
    console.log(`purge-check: ${JSON.stringify(summary.purgeCheck)}`);
    summary.pass = true;
    throw Object.assign(new Error('purge-check done'), { done: true });
  }

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
  assert.deepEqual(await currentPageSize(s.win), beforeResize, 'Cancel rolls the resize back');

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
  assert.ok(stats && stats.darkShare > 0, 'page 1 renders with content');
  summary.end = await sample(s);
  if (FLOOR) {
    summary.purgeVia = await purge(s);
    summary.F0 = await floorSample(s);
    console.log(`F0: total ${summary.F0.total} (Tab ${summary.F0.tab}, GPU ${summary.F0.gpu}) via ${summary.purgeVia} session`);
  }

  // R1: five full scans of the thumbnail list, 10 s idle after each.
  for (let pass = 1; pass <= PASSES; pass++) {
    const t = Date.now();
    const n = (await uids(s.win)).length;
    assert.equal(n, 1000, `pass ${pass}: the scan sees 1000 rows`);
    const scanMs = Date.now() - t;
    await delay(10000);
    summary.passes.push({ pass, scanMs, ...(await sample(s)) });
    const last = summary.passes.at(-1);
    console.log(`R1 pass ${pass}: private ${last.private} MB (Tab ${last.byType.Tab}, GPU ${last.byType.GPU}), ws ${last.ws} MB, engine ${JSON.stringify(last.engine)}`);
  }
  if (FLOOR) {
    const p = summary.passes.map((x) => x.private);
    const lastPass = summary.passes.at(-1);
    await purge(s);
    summary.F1 = await floorSample(s);
    console.log(`F1: total ${summary.F1.total} (Tab ${summary.F1.tab}, GPU ${summary.F1.gpu})`);
    const xs = Array.from({ length: PASSES - 1 }, (_, i) => i + 2);
    const all = [summary.end.private, summary.F0.total, ...p, ...summary.F1.raw.map((r) => r.total), ...summary.F0.raw.map((r) => r.total)];
    const v = (summary.floor = {
      passes: PASSES,
      F0: summary.F0,
      F1: summary.F1,
      floorDeltaMB: summary.F1.total - summary.F0.total,
      tabDeltaMB: summary.F1.tab - summary.F0.tab,
      gpuDeltaMB: summary.F1.gpu - summary.F0.gpu,
      slopeTotal: Number(slope(xs, p.slice(1)).toFixed(3)),
      slopeTab: Number(slope(xs, summary.passes.slice(1).map((x) => x.byType.Tab ?? 0)).toFixed(3)),
      slopeGpu: Number(slope(xs, summary.passes.slice(1).map((x) => x.byType.GPU ?? 0)).toFixed(3)),
      maxSample: Math.max(...all),
      lastPass: lastPass.private,
      purge1DropMB: summary.end.private - summary.F0.total,
      purge2DropMB: lastPass.private - summary.F1.total,
    });
    v.condFloor = v.floorDeltaMB <= 15;
    v.condSlope = v.slopeTotal < 3;
    v.condMax = v.maxSample < 720;
    v.inconclusive = v.purge2DropMB < 30;
    v.verdict = v.inconclusive ? 'INCONCLUSIVE' : v.condFloor && v.condSlope && v.condMax ? 'PASS' : 'FAIL';
    console.log(`floor verdict: ${v.verdict} | F1-F0 ${v.floorDeltaMB} MB (<=15: ${v.condFloor}) | slope ${v.slopeTotal} MB/pass (<3: ${v.condSlope}) | max ${v.maxSample} MB (<720: ${v.condMax}) | purge2 drop ${v.purge2DropMB} MB (>=30 else inconclusive)`);
    console.log(`floor detail: ${JSON.stringify(v)}`);
    summary.pass = v.verdict === 'PASS';
    assertNoErrors(s);
    throw Object.assign(new Error('floor done'), { done: true });
  }
  // R2: 60 s idle, logged only.
  await delay(60000);
  summary.r2 = await sample(s);
  const p = summary.passes.map((x) => x.private); // p[0] is pass 1
  if (PASSES < 24) throw new Error('--passes must be at least 24 (or use --floor)');
  summary.criteria = soakCriteria(p, summary.r2.private);
  summary.pass = summary.criteria.pass;
  const c = summary.criteria;
  console.log(`soak window: passes ${c.window[0]}-${c.window[1]}: ${p.slice(c.window[0] - 1).join(', ')} | idle ${summary.r2.private}`);
  console.log(`soak criteria: (a) slope ${c.slopeMBPerPass} MB/pass <3: ${c.a} | (b) late-early ${c.lateMinusEarlyMB} MB <15: ${c.b} | (c) idle-late ${c.idleMinusLateMedianMB} MB <=15: ${c.c} | (d) max ${c.maxMB} MB <720: ${c.d} => ${summary.pass ? 'PASS' : 'FAIL'}`);
  if (PASSES > 24) {
    const w = summary.passes.slice(-12);
    const xs = w.map((x) => x.pass);
    summary.long = { passes: PASSES, window: c.window, slopeTab: Number(slope(xs, w.map((x) => x.byType.Tab ?? 0)).toFixed(3)), slopeGpu: Number(slope(xs, w.map((x) => x.byType.GPU ?? 0)).toFixed(3)) };
    console.log(`long soak: ${JSON.stringify(summary.long)}`);
  }
  assertNoErrors(s);
} catch (error) {
  if (!error?.done) failure = error;
  if (!error?.done) summary.scanEvidence = await scanEvidence(s.win).catch((e) => `error ${e.message}`);
  if (!error?.done) summary.error = String(error?.stack ?? error).slice(0, 800);
} finally {
  await s.close();
  removeCopy(copy);
  await closeAll();
}
console.log(JSON.stringify(summary));
process.exitCode = summary.pass && !failure ? 0 : 1;
