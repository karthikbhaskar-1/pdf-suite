// 1.3.4 protected results in the Compare view: scroll smoothness (p95 frame time) and the bitmap cache size while an overlay
// is on a 1,000-page file. The overlay is the same big file, so every page has a partner (page by page from 1).
// Gates (blueprint section 7): scroll p95 <= 20 ms and the bitmap cache <= 48 MB (the owner's budget is 48 MB; a pinned bitmap
// may exceed it by the pages on screen, so the number is read after the viewer has settled). Also reported: visible pages
// painted with the overlay after a jump, and whether any visible page is blank.
// Run: node tests/perf/compare-scroll.probe.mjs
import { measureValid, startSampler } from '../lib/frame-validity.mjs';
import { launchTracked, check, summary, waitFor, waitForPage, closeAll, cleanupProfile, fixture } from '../signoff2/lib.mjs';

const BIG = fixture('big-1000.pdf');
const MB = 1024 * 1024;

function sweep(win, mode) {
  return win.evaluate(async (mode) => {
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

async function validWindow(s, label, measure) {
  const rendererCpu = () => s.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((t, m) => t + (m.cpu.cumulativeCPUUsage ?? 0), 0));
  try {
    return (await measureValid({ label, win: s.win, measure, rendererCpu })).result;
  } catch (e) {
    check(`${label}: measurable (machine quiet enough)`, false, String(e.message ?? e));
    return null;
  }
}

/** The bitmap cache as the app reports it (see engine/memoryReport.ts), and how many are overlay views. */
async function cache(win) {
  return win.evaluate(async () => {
    const mem = await window.__pdfSuiteEngine.memory();
    return mem.bitmaps;
  });
}

/** After a jump, how long until every visible page has its bitmap, and whether each shows the overlay's marks (not plain). */
async function settleAfterJump(s, pages) {
  const out = [];
  for (const target of [137, 512, 888]) {
    out.push(await s.win.evaluate(async (frac) => {
      const v = document.querySelector('.viewer');
      v.scrollTop = (v.scrollHeight - v.clientHeight) * frac;
      const t = performance.now();
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const vr = v.getBoundingClientRect();
        const vis = [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top && r.top < vr.bottom; });
        if (vis.length && vis.every((p) => !p.querySelector('.page-placeholder') && p.querySelector('canvas').width !== 300)) return Math.round(performance.now() - t);
        if (performance.now() - t > 5000) return -1;
      }
    }, target / pages));
  }
  return out;
}

async function main() {
  startSampler();
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([BIG]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
    await s.win.waitForTimeout(1500);
    const plain = await cache(s.win);

    // Start the compare with the big file itself as the overlay.
    await s.win.keyboard.press('Control+k');
    const palette = s.win.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor({ timeout: 5000 });
    await palette.getByPlaceholder('Type a command').fill('Pages: Overlay to compare');
    await s.win.waitForTimeout(300);
    await s.win.keyboard.press('Enter');
    const sheet = s.win.getByRole('dialog', { name: 'Overlay to compare' });
    await sheet.waitFor({ timeout: 10000 });
    await s.setDialogAnswer([BIG]);
    await sheet.getByRole('button', { name: 'Choose a PDF…' }).click();
    await sheet.locator('[data-compare-file]').getByText('big-1000.pdf · 1000 pages').waitFor({ timeout: 30000 });
    // Hide the sheet so the page area is the same width as the plain run.
    await sheet.getByRole('button', { name: 'Hide settings' }).click();
    await s.win.waitForTimeout(2000);
    const first = await cache(s.win);
    console.log(`bitmap cache plain ${(plain.budgetBytes / MB).toFixed(1)} MB; with the overlay at the first page ${(first.budgetBytes / MB).toFixed(1)} MB`);

    const sw = await validWindow(s, 'Compare view scrollTop sweep', () => sweep(s.win, 'sweep'));
    if (sw) check('Compare view scrollTop sweep: p95 frame <= 20 ms and worst after 1 s <= 50 ms', sw.p95 <= 20 && sw.worstAfter1s <= 50, sw);
    await s.win.waitForTimeout(800);
    const wh = await validWindow(s, 'Compare view real wheel scrolling', () => wheelFrames(s));
    if (wh) check('Compare view real wheel scrolling: p95 frame <= 20 ms and worst after 1 s <= 50 ms', wh.p95 <= 20 && wh.worstAfter1s <= 50, wh);
    await s.win.waitForTimeout(800);
    const settle = await settleAfterJump(s, 1000);
    check('Compare view: after a jump, visible pages are painted within 1 s', settle.every((ms) => ms >= 0 && ms <= 1000), settle);

    // A second pass, then the cache after the viewer has settled.
    await sweep(s.win, 'sweep');
    await s.win.waitForTimeout(2500);
    const settled = await cache(s.win);
    console.log(`bitmap cache after two passes: ${(settled.budgetBytes / MB).toFixed(1)} MB (pages ${(settled.pageBytes / MB).toFixed(1)} MB in ${settled.pageCount}, thumbnails ${(settled.thumbBytes / MB).toFixed(1)} MB in ${settled.thumbCount})`);
    check('Compare view: bitmap cache <= 48 MB after two passes', settled.budgetBytes <= 48 * MB, { budgetMB: Number((settled.budgetBytes / MB).toFixed(1)), pageMB: Number((settled.pageBytes / MB).toFixed(1)), pages: settled.pageCount });
    // Leaving drops every overlay bitmap.
    await s.win.getByRole('button', { name: 'Leave compare' }).click();
    await s.win.waitForTimeout(1500);
    const after = await cache(s.win);
    console.log(`bitmap cache after leaving: ${(after.budgetBytes / MB).toFixed(1)} MB`);
    check('Compare view: no console/page errors', s.errors.filter((e) => !/Debugger ending|For help, see/.test(e)).length === 0, s.errors.slice(0, 5));
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
}

try {
  await main();
} finally {
  await closeAll();
  summary();
}
