// Diagnosis: (1) do visible pages stay blank (no placeholder, unpainted canvas) after heavy scrolling, and for how long;
// (2) renderer(Tab)+GPU memory per step, MuPDF vs the 1.1 engine (pdf.js override). Run: node tests/signoff2/diag-blank.probe.mjs [mupdf|pdfjs]
import { join } from 'node:path';
import { ROOT2, launchTracked, engineState, waitForPage, closeAll, cleanupProfile, fixture } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const s = await launchTracked();
const memRow = async () => {
  const m = await s.metrics();
  const by = {};
  for (const x of m) by[x.type] = (by[x.type] ?? 0) + Math.round(x.memKB / 1024);
  return { tabGpu: (by.Tab ?? 0) + (by.GPU ?? 0), GPU: by.GPU, Tab: by.Tab };
};
const visState = () => s.win.evaluate(() => {
  const v = document.querySelector('.viewer'); const vr = v.getBoundingClientRect();
  return [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top && r.top < vr.bottom; })
    .map((p) => ({ n: Number(p.dataset.pageIndex) + 1, ph: !!p.querySelector('.page-placeholder'), w: p.querySelector('canvas').width }));
});
const sweep = () => s.win.evaluate(async () => {
  const v = document.querySelector('.viewer'); const max = v.scrollHeight - v.clientHeight;
  for (let i = 0; i <= 120; i++) { v.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
  for (let i = 120; i >= 0; i--) { v.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
});
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
  console.log(`[${engine}] engine state ${JSON.stringify(await engineState(s.win))}`);
  const mem = [];
  mem.push(['open', await memRow()]);
  const vb = await s.win.locator('.viewer').first().boundingBox();
  let blankEvents = 0;
  for (let round = 1; round <= 4; round++) {
    await sweep();
    await s.win.waitForTimeout(800);
    await s.win.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    for (let i = 0; i < 60; i++) { await s.win.mouse.wheel(0, 600); await s.win.waitForTimeout(25); }
    for (let i = 0; i < 40; i++) { await s.win.mouse.wheel(0, -600); await s.win.waitForTimeout(25); }
    await s.win.waitForTimeout(800);
    for (const frac of [0.137, 0.512, 0.888]) {
      await s.win.evaluate((f) => { const v = document.querySelector('.viewer'); v.scrollTop = (v.scrollHeight - v.clientHeight) * f; }, frac);
      await s.win.waitForTimeout(3000);
      const st = await visState();
      const blank = st.filter((p) => !p.ph && p.w === 300);
      if (blank.length) {
        blankEvents++;
        await s.win.waitForTimeout(7000);
        const later = (await visState()).filter((p) => !p.ph && p.w === 300);
        const shot = join(ROOT2, 'tests', 'signoff2', `blank-${engine}-${round}-${frac}.png`);
        if (blankEvents <= 2) await s.win.screenshot({ path: shot });
        const stats = await s.win.evaluate(() => window.__pdfSuiteDrawStats ?? null);
        console.log(`[${engine}] round ${round} jump ${frac}: blank-without-placeholder after 3 s ${JSON.stringify(blank)}; after 10 s ${JSON.stringify(later)}; drawStats ${JSON.stringify(stats)}${blankEvents <= 2 ? ' shot ' + shot : ''}`);
      }
    }
    await s.win.waitForTimeout(1500);
    mem.push([`round ${round}`, await memRow()]);
  }
  console.log(`[${engine}] blank events: ${blankEvents} of 12 jumps`);
  // drawQueue counters: skippedClosed > 0 means a bitmap was evicted while it waited for its frame (the cause).
  console.log(`[${engine}] drawStats ${JSON.stringify(await s.win.evaluate(() => window.__pdfSuiteDrawStats ?? null))}`);
  console.log(`[${engine}] memory (working set MB): ${JSON.stringify(mem)}`);
  console.log(`[${engine}] errors ${JSON.stringify(s.errors)}`);
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
}
