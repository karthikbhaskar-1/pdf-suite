// Stress checks on the 1,000-page fixture: open time, jump, fast scroll, memory, search while navigating.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { measureValid, longFramesOf, startSampler } from '../lib/frame-validity.mjs';
import { launch, fixture, statusText, waitFor, waitForPage, closeAll, cleanupProfile, rendererMemoryMB } from './helpers.mjs';

after(closeAll);

const sumMB = (metrics, types) =>
  metrics.filter((m) => types.includes(m.type)).reduce((total, m) => total + m.memKB, 0) / 1024;

async function openBig(s) {
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([fixture('big-1000.pdf')]);
  const started = performance.now();
  await s.win.keyboard.press('Control+o');
  await s.win.locator('.page-canvas').first().waitFor({ timeout: 60000 });
  const firstPageMs = Math.round(performance.now() - started);
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  const statusMs = Math.round(performance.now() - started);
  return { firstPageMs, statusMs };
}

test('1000-page file: time to first page and "Page 1 of 1000", jump to 1000, fast scroll, memory', async () => {
  startSampler();
  const s = await launch();
  try {
    const before = await s.metrics();
    const { firstPageMs, statusMs } = await openBig(s);
    const afterOpen = await s.metrics();
    console.log(`  measured: first page canvas at ${firstPageMs} ms; "Page 1 of 1000" status at ${statusMs} ms`);
    // Hard limit: the first page of a 1,000-page file is on screen within 300 ms of Ctrl+O.
    assert.ok(firstPageMs <= 250, `first page took ${firstPageMs} ms (limit 250 ms)`);
    console.log(`  measured: renderer+GPU memory before open ${sumMB(before, ['Tab', 'GPU']).toFixed(0)} MB; after open ${sumMB(afterOpen, ['Tab', 'GPU']).toFixed(0)} MB`);

    // Jump to page 1000 through the page box.
    const jumpStart = performance.now();
    const box = s.win.getByLabel('Page number');
    await box.click();
    await box.fill('1000');
    await box.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1000 of 1000'), { timeoutMs: 30000, label: 'Page 1000 of 1000' });
    console.log(`  measured: jump to page 1000 in ${Math.round(performance.now() - jumpStart)} ms`);

    // Fast scroll the whole document in the page, sampling frame gaps with requestAnimationFrame.
    const rendererCpu = async () => s.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((t, m) => t + (m.cpu.cumulativeCPUUsage ?? 0), 0));
    // A long frame that is the machine's doing (no app work, another process saturating the CPU) is INVALID and measured again.
    const { result: scroll } = await measureValid({ label: 'bigfile fast scroll', win: s.win, rendererCpu, measure: async () => {
    const r = await s.win.evaluate(async () => {
      const viewer = document.querySelector('.viewer');
      if (!viewer) return { error: 'no .viewer element' };
      const gaps = [];
      let last = performance.now();
      let running = true;
      const started = performance.now();
      const timed = [];
      const sample = () => {
        const now = performance.now();
        gaps.push(now - last);
        timed.push({ at: now - started, gap: now - last });
        last = now;
        if (running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const max = viewer.scrollHeight - viewer.clientHeight;
      const t0 = performance.now();
      const steps = 120;
      for (let i = 0; i <= steps; i++) {
        viewer.scrollTop = (max * i) / steps;
        await new Promise((r) => setTimeout(r, 16));
      }
      for (let i = steps; i >= 0; i--) {
        viewer.scrollTop = (max * i) / steps;
        await new Promise((r) => setTimeout(r, 16));
      }
      running = false;
      const elapsed = performance.now() - t0;
      const sorted = [...gaps].sort((a, b) => a - b);
      return {
        elapsed,
        frames: gaps.length,
        worstFrameMs: Math.max(...gaps),
        worstAfterFirstSecondMs: Math.max(...timed.filter((f) => f.at > 1000).map((f) => f.gap)),
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
        pageNodes: document.querySelectorAll('.page').length,
        pageCanvases: document.querySelectorAll('.page-canvas').length,
        scrollMax: max,
        timed,
        startedAbs: started,
      };
    });
    if (r.error) throw new Error(r.error);
    r.longFrames = longFramesOf(r.timed, r.startedAbs);
    return r;
    } });
    console.log(`  measured: fast scroll down and back up in ${Math.round(scroll.elapsed)} ms; frames ${scroll.frames}, p95 frame ${scroll.p95FrameMs.toFixed(0)} ms, worst frame ${scroll.worstFrameMs.toFixed(0)} ms; .page nodes in DOM ${scroll.pageNodes}, canvases ${scroll.pageCanvases}`);
    console.log(`  measured: worst frame after the first second ${scroll.worstAfterFirstSecondMs.toFixed(0)} ms`);
    // Hard limits: p95 frame of 18 ms or less during fast scroll, and no frame over 50 ms after the first second.
    assert.ok(scroll.p95FrameMs <= 18, `p95 frame ${scroll.p95FrameMs} ms during fast scroll (limit 18 ms)`);
    assert.ok(scroll.worstAfterFirstSecondMs <= 50, `worst frame ${scroll.worstAfterFirstSecondMs} ms after the first second (limit 50 ms)`);
    const bottomStatus = await statusText(s.win);
    console.log(`  status after scrolling back to top: ${JSON.stringify(bottomStatus)}`);
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 1000'), { timeoutMs: 10000, label: 'back at page 1' });

    // Hard limit (owner-approved gate, 2026-11-09): renderer and GPU private bytes stay under 720 MB after a full pass.
    const privateAfterFirst = await rendererMemoryMB(s);
    console.log(`  memory after first full pass: private ${privateAfterFirst.privateMB.toFixed(0)} MB, working set ${privateAfterFirst.workingSetMB.toFixed(0)} MB`);
    assert.ok(privateAfterFirst.privateMB < 720, `renderer+GPU private ${privateAfterFirst.privateMB.toFixed(0)} MB after a full pass (limit 720 MB)`);
    // Second full pass: if memory keeps climbing the cache is not bounded; a plateau means it is.
    await s.win.evaluate(async () => {
      const viewer = document.querySelector('.viewer');
      const max = viewer.scrollHeight - viewer.clientHeight;
      for (let i = 0; i <= 120; i++) {
        viewer.scrollTop = (max * i) / 120;
        await new Promise((r) => setTimeout(r, 16));
      }
      for (let i = 120; i >= 0; i--) {
        viewer.scrollTop = (max * i) / 120;
        await new Promise((r) => setTimeout(r, 16));
      }
    });
    await s.win.waitForTimeout(1000);
    const privateAfterSecond = await rendererMemoryMB(s);
    console.log(`  memory after second full pass: private ${privateAfterSecond.privateMB.toFixed(0)} MB, working set ${privateAfterSecond.workingSetMB.toFixed(0)} MB`);
    assert.ok(privateAfterSecond.privateMB < 720, `renderer+GPU private ${privateAfterSecond.privateMB.toFixed(0)} MB after a second pass (limit 720 MB)`);
    const afterScroll = await s.metrics();
    console.log(`  measured: renderer+GPU memory after scroll ${sumMB(afterScroll, ['Tab', 'GPU']).toFixed(0)} MB; total app ${sumMB(afterScroll, ['Browser', 'Tab', 'GPU', 'Utility']).toFixed(0)} MB`);
    console.log(`  workarounds used: ${s.workarounds.length}`);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('search for a word on all 1000 pages: UI stays responsive while matches stream in, final count is 1000', async () => {
  const s = await launch();
  try {
    await openBig(s);
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.waitFor({ timeout: 5000 });
    const typed = performance.now();
    await find.fill('zephyrbloom');
    let finalMs = null;

    // While the scan runs, page navigation must still react quickly.
    const samples = [];
    let scanning = true;
    let statusSeen = '';
    const box = s.win.getByLabel('Page number');
    for (let i = 0; i < 4 && scanning; i++) {
      const t = performance.now();
      await box.click();
      await box.fill(String(100 + i * 200));
      await box.press('Enter');
      await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${100 + i * 200} of 1000`), { timeoutMs: 10000, label: 'nav while searching' });
      samples.push(Math.round(performance.now() - t));
      statusSeen = await s.win.locator('.search-status').innerText().catch(() => '');
      if (/of 1000$/.test(statusSeen) && !/Searching|pages/.test(statusSeen)) scanning = false;
    }
    console.log(`  measured: page-nav reaction while searching (ms): ${samples.join(', ')}; search status during nav: ${JSON.stringify(statusSeen)}`);

    const finalStart = performance.now();
    await waitFor(async () => /^1 of 1000$/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 60000, label: 'final search count "1 of 1000"' });
    finalMs = Math.round(performance.now() - typed);
    console.log(`  measured: search final status "1 of 1000" after ${Math.round(performance.now() - finalStart)} ms more (total from typing ${finalMs} ms)`);
    // Hard limit: the full 1,000-page search finishes within 800 ms of typing, with navigation still responsive.
    assert.ok(finalMs <= 800, `search to "1 of 1000" took ${finalMs} ms (limit 800 ms)`);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('search with Match case finds nothing for the wrong case (whole word not covered)', async () => {
  const s = await launch();
  try {
    await openBig(s);
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.fill('ZEPHYRBLOOM');
    await waitFor(async () => /1 of 1000|of 1000/.test(await s.win.locator('.search-status').innerText()), { timeoutMs: 60000, label: 'case-insensitive results' });
    console.log(`  case-insensitive status: ${JSON.stringify((await s.win.locator('.search-status').innerText()).trim())}`);
    await s.win.getByRole('button', { name: 'Match case' }).or(s.win.getByTitle('Match case')).first().click();
    await find.click();
    await waitFor(async () => /(^|\s)0 |No /.test(await s.win.locator('.search-status').innerText()) || (await s.win.locator('.search-status').innerText()).trim() === '', { timeoutMs: 60000, label: 'zero matches with match case' });
    console.log(`  match-case status for "ZEPHYRBLOOM": ${JSON.stringify((await s.win.locator('.search-status').innerText()).trim())}`);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});
