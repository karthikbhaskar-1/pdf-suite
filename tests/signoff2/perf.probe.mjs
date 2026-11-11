// Independent sign-off probe, ticket 1.2.0: performance targets on 1,000-page files, measured in the renderer.
// First page = Ctrl+O keydown -> first page canvas actually holding the rendered bitmap (not just existing).
// Also: frames during a scrollTop sweep and during real wheel input, pages painting after a fast scroll stops,
// memory, WASM heap, search to "1 of 1000" while navigating.
// Run: node tests/signoff2/perf.probe.mjs [big|heavy|brochure]...
import { join } from 'node:path';
import { measureValid, measureSearchValid, startSampler, tally } from '../lib/frame-validity.mjs';
import { CORPUS, ROOT2, launchTracked, engineState, check, summary, statusText, waitFor, waitForPage, rendererMemoryMB, closeAll, cleanupProfile, fixture, sumMB } from './lib.mjs';

const which = process.argv.slice(2);
const FILES = {
  // Search limits per file (ORCHESTRATION-RULES §3; owner's delegate 2026-11-10): light text 800 ms; full text
  // (about 2,500 characters a page) interim 1,500 ms for a first search and 500 ms for a different word straight after.
  big: { path: fixture('big-1000.pdf'), pages: 1000, word: 'zephyrbloom', searchMs: 800 },
  heavy: { path: join(ROOT2, 'tests', 'signoff', 'out', 'heavy-1000.pdf'), pages: 1000, word: 'Heavy', searchMs: 1500, word2: 'page', word2Ms: 500 },
};

const ARM_FIRST_PAINT = () => {
  window.__fp = { key: null, paint: null };
  window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'o' && window.__fp.key === null) window.__fp.key = performance.now(); }, true);
  const poll = () => {
    const c = document.querySelector('.viewer .page[data-page-index="0"] canvas.page-canvas');
    if (c && c.width !== 300 && !c.parentElement.querySelector('.page-placeholder')) {
      // Confirm real pixels arrived (not a cleared canvas).
      const d = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data;
      let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
      if (opaque > 0) { window.__fp.paint = performance.now(); return; }
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
};

/**
 * Waits until rendering has stopped, then returns the milliseconds since the last scroll event. The engine exposes no
 * queue state, so "stopped" is: the draw counters (window.__pdfSuiteDrawStats: queued, painted, replaced, skipped,
 * dropped) did not change over two consecutive animation frames and the viewer did not scroll. The memory reading is
 * taken after this, so it is not taken in the middle of a render.
 */
function settleBeforeMemory(win) {
  return win.evaluate(async () => {
    const frame = () => new Promise((r) => { let d = false; const f = () => { if (!d) { d = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 100); });
    const sig = () => JSON.stringify(window.__pdfSuiteDrawStats ?? {});
    const started = performance.now();
    let calm = 0;
    let last = sig();
    let lastScroll = window.__lastScrollAt;
    while (calm < 2 && performance.now() - started < 10000) {
      await frame();
      const now = sig();
      if (now === last && window.__lastScrollAt === lastScroll) calm += 1; else calm = 0;
      last = now; lastScroll = window.__lastScrollAt;
    }
    return { sinceLastScrollMs: Math.round(performance.now() - (window.__lastScrollAt || started)), waitedMs: Math.round(performance.now() - started), queueIdle: calm >= 2 };
  });
}

function sweep(win, mode) {
  return win.evaluate(async (mode) => {
    // Remember when the viewer last scrolled, for the memory reading's wait (see settleBeforeMemory).
    if (!window.__lastScrollAt) { window.__lastScrollAt = 0; document.addEventListener('scroll', () => { window.__lastScrollAt = performance.now(); }, true); }
    const viewer = document.querySelector('.viewer');
    const gaps = []; const timed = [];
    let last = performance.now(); let running = true; const started = performance.now();
    const sample = () => { const now = performance.now(); gaps.push(now - last); timed.push({ at: now - started, gap: now - last }); last = now; if (running) requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    const max = viewer.scrollHeight - viewer.clientHeight;
    if (mode === 'sweep') {
      for (let i = 0; i <= 120; i++) { viewer.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
      for (let i = 120; i >= 0; i--) { viewer.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
    } else {
      await new Promise((r) => setTimeout(r, 4000));
    }
    running = false;
    const sorted = [...gaps].sort((a, b) => a - b);
    return { longFrames: timed.filter((f) => f.at > 1000 && f.gap > 50).map((f) => ({ end: started + f.at, gap: f.gap })), frames: gaps.length, p95: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(1)), worst: Number(Math.max(...gaps).toFixed(1)), worstAfter1s: Number(Math.max(...timed.filter((f) => f.at > 1000).map((f) => f.gap)).toFixed(1)) };
  }, mode);
}

async function wheelFrames(s) {
  const vb = await s.win.locator('.viewer').first().boundingBox();
  await s.win.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  const measuring = sweep(s.win, 'wheel');
  for (let i = 0; i < 60; i++) { await s.win.mouse.wheel(0, 600); await s.win.waitForTimeout(25); }
  for (let i = 0; i < 40; i++) { await s.win.mouse.wheel(0, -600); await s.win.waitForTimeout(25); }
  return measuring;
}

/** After jumping to a spot, how long until every visible page has its bitmap. */
async function settleTimes(s, pages) {
  const out = [];
  for (const target of [137, 512, 888, Math.min(pages, 999)]) {
    const ms = await s.win.evaluate(async (frac) => {
      const v = document.querySelector('.viewer');
      v.scrollTop = (v.scrollHeight - v.clientHeight) * frac;
      const t = performance.now();
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const vr = v.getBoundingClientRect();
        const vis = [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top && r.top < vr.bottom; });
        if (vis.length && vis.every((p) => !p.querySelector('.page-placeholder') && p.querySelector('canvas').width !== 300)) return performance.now() - t;
        if (performance.now() - t > 5000) return vis.map((p) => `${Number(p.dataset.pageIndex) + 1}:${p.querySelector('.page-placeholder') ? 'PH' : 'ok'}:${p.querySelector('canvas').width}`).join(' ') + ` scrollTop=${Math.round(v.scrollTop)}`;
      }
    }, target / pages);
    out.push(typeof ms === 'number' ? Math.round(ms) : ms);
  }
  return out;
}

/** A frame-time window: a long frame caused by the machine (no app work, another process saturating the CPU) is INVALID and measured again, up to 3 attempts; all invalid fails the check. */
async function validWindow(s, label, measure) {
  const rendererCpu = () => s.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((t, m) => t + (m.cpu.cumulativeCPUUsage ?? 0), 0));
  try {
    return (await measureValid({ label, win: s.win, measure, rendererCpu })).result;
  } catch (e) {
    check(`${label}: measurable (machine quiet enough)`, false, String(e.message ?? e));
    return null;
  }
}

/** One search measurement on an app that has the file open: first word with jumps to pages 250 and 750, then (if any) a second word. */
async function searchBlock(s, f) {
  await s.win.keyboard.press('Control+Home').catch(() => undefined);
  await s.win.keyboard.press('Control+f');
  const find = s.win.getByLabel('Find in document');
  await find.waitFor({ timeout: 5000 });
  const done = new RegExp(`^\\d+ of ${f.pages}$`);
  const t0 = performance.now();
  await find.fill(f.word);
  const box = s.win.getByLabel('Page number');
  const nav = [];
  for (const p of [250, 750]) {
    const t = performance.now();
    await box.click(); await box.fill(String(p)); await box.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${p} of`), { timeoutMs: 10000, label: 'nav' });
    nav.push(Math.round(performance.now() - t));
  }
  await waitFor(async () => done.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 60000, label: 'search complete' });
  const searchMs = Math.round(performance.now() - t0);
  const status = (await s.win.locator('.search-status').innerText()).trim();
  const out = { searchMs, nav, status };
  if (f.word2) {
    // Clear first, so the previous word's final count cannot be read as the new word's.
    await find.fill('');
    await waitFor(async () => !done.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 5000, label: 'search cleared' });
    const t2 = performance.now();
    await find.fill(f.word2);
    await waitFor(async () => done.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 60000, label: 'second word complete' });
    out.word2Ms = Math.round(performance.now() - t2);
    out.status2 = (await s.win.locator('.search-status').innerText()).trim();
  }
  return out;
}

/** A fresh app with the file open and the state the search runs in at the end of runFile: two full scroll sweeps behind it. */
async function openAndWarm(s, f) {
  await s.win.waitForSelector('.empty-state');
  await waitFor(async () => (await engineState(s.win)).mupdfWorkersLive >= 1, { timeoutMs: 20000, label: 'spare' });
  await s.win.waitForTimeout(1500);
  await s.setDialogAnswer([f.path]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, `Page 1 of ${f.pages}`, { timeoutMs: 60000 });
  await s.win.waitForTimeout(1800);
  await sweep(s.win, 'sweep');
  await s.win.waitForTimeout(800);
  await sweep(s.win, 'sweep');
  await s.win.waitForTimeout(1500);
}

async function runFile(key) {
  startSampler();
  const f = FILES[key];
  const s = await launchTracked();
  try {
    await s.win.addInitScript(`(${ARM_FIRST_PAINT.toString()})()`);
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
    await waitFor(async () => (await engineState(s.win)).mupdfWorkersLive >= 1, { timeoutMs: 20000, label: 'spare' });
    await s.win.waitForTimeout(1500);
    const before = sumMB(await s.metrics(), ['Tab', 'Renderer', 'GPU']);
    await s.setDialogAnswer([f.path]);
    await s.win.keyboard.press('Control+o');
    await waitFor(async () => s.win.evaluate(() => window.__fp.paint), { timeoutMs: 60000, label: 'first paint' });
    const fp = await s.win.evaluate(() => window.__fp);
    const firstPaint = Math.round(fp.paint - fp.key);
    await waitForPage(s, `Page 1 of ${f.pages}`, { timeoutMs: 60000 });
    const eng = await engineState(s.win);
    check(`[${key}] opened by MuPDF`, eng.mupdfDocs === 1, eng);
    check(`[${key}] first page pixels on screen <= 250 ms after Ctrl+O`, firstPaint <= 250, `${firstPaint} ms`);

    await s.win.waitForTimeout(1000);
    const sw = await validWindow(s, `[${key}] scrollTop sweep`, () => sweep(s.win, 'sweep'));
    if (sw) check(`[${key}] scrollTop sweep: p95 frame <= 18 ms and worst after 1 s <= 50 ms`, sw.p95 <= 18 && sw.worstAfter1s <= 50, sw);
    await s.win.waitForTimeout(800);
    const wh = await validWindow(s, `[${key}] real wheel scrolling`, () => wheelFrames(s));
    if (wh) check(`[${key}] real wheel scrolling: p95 frame <= 18 ms and worst after 1 s <= 50 ms`, wh.p95 <= 18 && wh.worstAfter1s <= 50, wh);
    await s.win.waitForTimeout(800);
    const settle = await settleTimes(s, f.pages);
    check(`[${key}] after a jump, visible pages are painted within 1 s`, settle.every((ms) => typeof ms === 'number' && ms >= 0 && ms <= 1000), settle);
    // Second full sweep for memory plateau.
    await sweep(s.win, 'sweep');
    await s.win.waitForTimeout(1500);
    const settled = await settleBeforeMemory(s.win);
    console.log(`[${key}] memory reading taken ${settled.sinceLastScrollMs} ms after the last scroll event (queue idle: ${settled.queueIdle}, waited ${settled.waitedMs} ms)`);
    const mem = sumMB(await s.metrics(), ['Tab', 'Renderer', 'GPU']);
    const memPrivate = (await rendererMemoryMB(s)).privateMB;
    const heap = (await engineState(s.win)).wasmMB;
    check(`[${key}] Tab+GPU private bytes < 720 MB after two full passes (working set ${Math.round(mem)} MB logged)`, memPrivate < 720, { privateTotalMB: Math.round(memPrivate), workingSetTotalMB: Math.round(mem), byType: Object.fromEntries((await s.metrics()).map((m) => [m.type, Math.round(m.memKB / 1024)])), privateMB: Object.fromEntries((await s.metrics()).map((m) => [m.type, m.privateKB ? Math.round(m.privateKB / 1024) : null])), beforeOpenMB: Math.round(before), afterMB: Math.round(mem), wasmMB: heap });

    // Search while navigating (first search, then a different word). A search that is over its limit while the machine was saturated
    // (total CPU peak >= 75 %, tests/lib/frame-validity.mjs classifySearch) is INVALID and is measured again in a fresh app, up to 3
    // attempts; all invalid = fail. Attempt 1 runs here, in this app, after the sweeps; later attempts repeat open + two sweeps + search.
    const searchJudge = (r) => r.searchMs <= f.searchMs && r.nav.every((n) => n < 250) && (!f.word2 || r.word2Ms <= f.word2Ms);
    const sv = await measureSearchValid({
      label: key,
      judge: searchJudge,
      run: async (n) => {
        if (n === 1) return searchBlock(s, f);
        const fresh = await launchTracked();
        try {
          await openAndWarm(fresh, f);
          return await searchBlock(fresh, f);
        } finally {
          await fresh.close();
          cleanupProfile(fresh.profile);
        }
      },
    });
    const r = sv.result;
    const busiest = sv.machine?.busiest ? `${sv.machine.busiest.name} ${sv.machine.busiest.pct} %` : null;
    const validity = { attempts: sv.attempts.map((x) => ({ n: x.attempt, verdict: x.verdict, cpuPeakPct: x.cpuPeak, busiestOutside: x.busiestOutside ? `${x.busiestOutside.name} ${x.busiestOutside.pct} %` : null, searchMs: x.result.searchMs, word2Ms: x.result.word2Ms ?? null })) };
    if (sv.verdict === 'invalid-final') {
      check(`[${key}] search timings measurable (machine quiet enough in one of 3 attempts)`, false, { ...validity, message: 'machine too busy to measure: every attempt was over a limit while total CPU peaked at 75 % or more' });
    } else {
      check(`[${key}] search "${f.word}" reaches "n of ${f.pages}" <= ${f.searchMs} ms with navigation responsive (< 250 ms)`, r.searchMs <= f.searchMs && r.nav.every((n) => n < 250), { searchMs: r.searchMs, status: r.status, navMs: r.nav, cpuPeakPct: sv.machine?.cpuMax ?? null, busiestOutside: busiest, ...validity });
      if (f.word2) check(`[${key}] a different word straight after ("${f.word2}") reaches "n of ${f.pages}" <= ${f.word2Ms} ms`, r.word2Ms <= f.word2Ms, { word2Ms: r.word2Ms, status: r.status2, cpuPeakPct: sv.machine?.cpuMax ?? null, busiestOutside: busiest });
    }
    check(`[${key}] no console/page errors`, s.errors.filter((e) => !/Debugger ending|For help, see/.test(e)).length === 0, s.errors.slice(0, 5));
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
}

/** Image-heavy real file (73 MB brochure): WASM heap and memory stay bounded at high zoom; closing frees the worker. */
async function runBrochure() {
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    if (process.env.ENGINE === 'pdfjs') {
      await s.win.evaluate(() => localStorage.setItem('pdfsuite.engine', 'pdfjs'));
      await s.win.reload();
      await s.win.waitForSelector('.empty-state');
    }
    await waitFor(async () => (await engineState(s.win)).mupdfWorkersLive >= 1, { timeoutMs: 20000, label: 'spare' });
    const base = sumMB(await s.metrics(), ['Tab', 'Renderer', 'GPU']);
    await s.setDialogAnswer([join(CORPUS, 'brochure-images', 'brochure.pdf')]);
    const t0 = performance.now();
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 12', { timeoutMs: 60000 });
    await waitFor(async () => s.win.evaluate(() => { const c = document.querySelector('.viewer .page[data-page-index="0"] canvas'); return c && c.width !== 300; }), { timeoutMs: 30000, label: 'brochure paint' });
    const openMs = Math.round(performance.now() - t0);
    const rows = [];
    const reading = async (kind) => ({ kind, types: Object.fromEntries((await s.metrics()).map((m) => [m.type, Math.round(m.memKB / 1024)])), zoom: (await statusText(s.win)).split('·')[1]?.trim(), memMB: Math.round(sumMB(await s.metrics(), ['Tab', 'Renderer', 'GPU'])), privMB: Math.round((await rendererMemoryMB(s)).privateMB), wasmMB: (await engineState(s.win)).wasmMB });
    // From fit (87%) the zoom steps are 100, 125, 150, 200 (4 zoom-ins), 300, 400 (6), 600 and ZOOM_MAX = 800 (8; 1.5.5 D2 step list).
    for (const zoomIns of [0, 4, 6, 8]) {
      for (let i = 0; i < zoomIns; i++) await s.win.keyboard.press('Control+=');
      await s.win.waitForTimeout(800);
      await s.win.evaluate(async () => {
        const v = document.querySelector('.viewer'); const max = v.scrollHeight - v.clientHeight;
        for (let i = 0; i <= 40; i++) { v.scrollTop = (max * i) / 40; await new Promise((r) => setTimeout(r, 120)); }
      });
      await s.win.waitForTimeout(2500);
      rows.push(await reading('zoom'));
      await s.win.keyboard.press('Control+0');
    }
    // Back at fit after the highest zoom pass: the memory the document still holds (the GPU process and the WASM heap do not trim).
    await s.win.waitForTimeout(2500);
    rows.push(await reading('back-at-fit'));
    check('[brochure] 73 MB image PDF opens on MuPDF and paints', (await engineState(s.win)).mupdfDocs === 1, { openMs });
    // Limits (owner's delegate, 2026-11-11): up to 200% zoom Tab+GPU < 720 MB and WASM <= 256 MB; above 200%, and back at fit after a
    // high zoom, interim Tab+GPU < 1,200 MB and WASM <= 400 MB for the brochure (8 MP page cap; sharper needs tiles, Version 2).
    const zoomPct = (r) => Number.parseInt(r.zoom ?? '', 10);
    const high = (r) => r.kind === 'back-at-fit' || !(zoomPct(r) <= 200);
    check('[brochure] the zoom passes reach 800%', rows.some((r) => r.kind === 'zoom' && zoomPct(r) === 800), rows.map((r) => `${r.kind}:${r.zoom}`));
    check('[brochure] WASM heap <= 256 MB up to 200% zoom, <= 400 MB above 200% and back at fit after a high zoom', rows.every((r) => Math.max(...r.wasmMB) <= (high(r) ? 400 : 256)), rows);
    check('[brochure] Tab+GPU private bytes < 720 MB up to 200% zoom, < 1,200 MB above 200% and back at fit after a high zoom (working set logged in rows)', rows.every((r) => r.privMB < (high(r) ? 1200 : 720)), { baseMB: Math.round(base), rows });
    console.log(`[brochure] readings (zoom, Tab+GPU private MB, WASM MB): ${rows.map((r) => `${r.kind}/${r.zoom}: ${r.privMB}, ${Math.max(...r.wasmMB)}`).join(' | ')}`);
    await s.win.locator('.tab-close').first().click();
    await s.win.waitForSelector('.empty-state', { timeoutMs: 10000 });
    await s.win.waitForTimeout(2500);
    const after = await engineState(s.win);
    const memAfter = Math.round(sumMB(await s.metrics(), ['Tab', 'Renderer', 'GPU']));
    await s.win.waitForTimeout(8000);
    const memAfter10 = Object.fromEntries((await s.metrics()).map((m) => [m.type, Math.round(m.memKB / 1024)]));
    console.log(`[brochure ${process.env.ENGINE ?? 'mupdf'}] 10 s after close: ${JSON.stringify(memAfter10)}`);
    check('[brochure] closing frees the worker and its WASM memory', after.mupdfDocs === 0 && after.mupdfWorkersLive === 1, { ...after, memAfterCloseMB: memAfter, baseMB: Math.round(base) });
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
}

try {
  for (const key of which.length ? which : ['big', 'heavy', 'brochure']) {
    if (key === 'brochure') await runBrochure();
    else await runFile(key);
  }
} catch (e) {
  check('probe ran to completion', false, String(e.stack ?? e).slice(0, 800));
} finally {
  console.log(`FRAME-VALIDITY SUMMARY: windows passed ${tally.pass}, failed ${tally.fail}, invalid attempts ${tally.invalid}, windows invalid on all attempts ${tally.invalidFinal}`);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
