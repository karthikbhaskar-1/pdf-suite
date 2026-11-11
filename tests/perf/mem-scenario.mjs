// One memory run: open the 1,000-page file, scroll aggressively with real input (wheel flings and scrollbar drags),
// sample renderer (Tab) + GPU private bytes (working set logged) every 300 ms while scrolling, then wait 10 s idle and sample again.
// Prints one JSON line. Run: node tests/perf/mem-scenario.mjs [mupdf|pdfjs]
import { rendererMemoryMB } from '../e2e/helpers.mjs';
import { launchTracked, closeAll, cleanupProfile, waitForPage, fixture } from '../signoff2/lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const s = await launchTracked();
let peak = 0;
const samples = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastWorkingSet = 0;
let peakWorkingSet = 0;
async function tabPlusGpu() {
  // Gate metric: private bytes (owner-approved 2026-11-09). The working set is tracked beside it.
  const m = await rendererMemoryMB(s);
  lastWorkingSet = Math.round(m.workingSetMB);
  peakWorkingSet = Math.max(peakWorkingSet, lastWorkingSet);
  return Math.round(m.privateMB);
}
try {
  await s.win.waitForSelector('.empty-state');
  if (engine === 'pdfjs') {
    await s.win.evaluate(() => localStorage.setItem('pdfsuite.engine', 'pdfjs'));
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
  }
  await s.setDialogAnswer([fixture('big-1000.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  await s.win.waitForTimeout(1000);
  let scrolling = true;
  const sampler = (async () => {
    while (scrolling) {
      const value = await tabPlusGpu();
      samples.push(value);
      peak = Math.max(peak, value);
      await sleep(300);
    }
  })();
  const g = await s.win.locator('.viewer').first().evaluate((v) => {
    const r = v.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, sw: v.offsetWidth - v.clientWidth };
  });
  for (let round = 1; round <= 3; round++) {
    await s.win.mouse.move(g.x + g.w / 2, g.y + g.h / 2);
    for (let i = 0; i < 80; i++) { await s.win.mouse.wheel(0, 700); await s.win.waitForTimeout(20); }
    for (let i = 0; i < 50; i++) { await s.win.mouse.wheel(0, -700); await s.win.waitForTimeout(20); }
    const tx = g.x + g.w - g.sw / 2;
    for (const f of [0.2, 0.6, 0.95, 0.4]) {
      const top = await s.win.locator('.viewer').first().evaluate((v) => v.scrollTop / (v.scrollHeight - v.clientHeight));
      await s.win.mouse.move(tx, g.y + 20 + top * (g.h - 40));
      await s.win.mouse.down();
      await s.win.mouse.move(tx, g.y + 20 + f * (g.h - 40), { steps: 25 });
      await s.win.mouse.up();
      await s.win.waitForTimeout(1000);
    }
  }
  scrolling = false;
  await sampler;
  await sleep(10000);
  const settled = await tabPlusGpu();
  const dpr = await s.win.evaluate(() => window.devicePixelRatio);
  console.log(JSON.stringify({ engine, dpr, peak, settled, peakWorkingSet, settledWorkingSet: lastWorkingSet, samples: samples.length }));
} catch (error) {
  console.log(JSON.stringify({ engine, error: String(error?.message ?? error).slice(0, 300) }));
  process.exitCode = 1;
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
}
