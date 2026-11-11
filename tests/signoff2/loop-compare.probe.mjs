// Re-audit probe: the memory-loop scenario (open big-1000, fast scroll, close tab) on either engine, recording
// renderer(Tab)+GPU after each close, then 30 s idle after the last close. Tells whether the after-close plateau is
// MuPDF-specific or Chromium/app retention common to both engines.
// Run: node tests/signoff2/loop-compare.probe.mjs [mupdf|pdfjs] [loops]
import { launchTracked, engineState, waitFor, waitForPage, closeAll, cleanupProfile, fixture } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const LOOPS = Number(process.argv[3] ?? 20);
const s = await launchTracked();
const tg = async () => {
  const by = {};
  for (const m of await s.metrics()) by[m.type] = (by[m.type] ?? 0) + Math.round(m.memKB / 1024);
  return { tg: (by.Tab ?? 0) + (by.GPU ?? 0), GPU: by.GPU, Tab: by.Tab };
};
try {
  await s.win.waitForSelector('.empty-state');
  if (engine === 'pdfjs') {
    await s.win.evaluate(() => localStorage.setItem('pdfsuite.engine', 'pdfjs'));
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
  }
  await waitFor(async () => (await engineState(s.win)).mupdfWorkersLive >= 1, { timeoutMs: 20000 });
  await s.win.waitForTimeout(1500);
  const base = await tg();
  const after = [];
  for (let loop = 1; loop <= LOOPS; loop++) {
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
    await s.win.evaluate(async () => {
      const v = document.querySelector('.viewer'); const max = v.scrollHeight - v.clientHeight;
      for (let i = 0; i <= 80; i++) { v.scrollTop = (max * i) / 80; await new Promise((r) => setTimeout(r, 12)); }
      for (let i = 80; i >= 0; i--) { v.scrollTop = (max * i) / 80; await new Promise((r) => setTimeout(r, 12)); }
    });
    await s.win.waitForTimeout(500);
    await s.win.locator('.tab-close').first().click();
    await waitFor(async () => (await s.win.locator('.page-canvas').count()) === 0, { timeoutMs: 15000 });
    await s.win.waitForTimeout(1500);
    after.push((await tg()).tg);
  }
  await s.win.waitForTimeout(30000);
  const idle = await tg();
  const eng = await engineState(s.win);
  console.log(JSON.stringify({ engine, base, afterClose: after, idle30s: idle, eng }));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
}
