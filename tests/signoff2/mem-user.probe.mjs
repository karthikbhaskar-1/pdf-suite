// Sign-off probe: renderer(Tab)+GPU memory on the 1,000-page file under user input only (wheel flings, scrollbar drags).
// Run: node tests/signoff2/mem-user.probe.mjs [mupdf|pdfjs] [file]
import { launchTracked, check, summary, waitForPage, closeAll, cleanupProfile, fixture, engineState } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const file = process.argv[3] ?? fixture('big-1000.pdf');
const s = await launchTracked();
const row = async (label) => {
  const by = {};
  for (const m of await s.metrics()) by[m.type] = (by[m.type] ?? 0) + Math.round(m.memKB / 1024);
  return { label, tabPlusGpu: (by.Tab ?? 0) + (by.GPU ?? 0), GPU: by.GPU, Tab: by.Tab };
};
try {
  await s.win.waitForSelector('.empty-state');
  if (engine === 'pdfjs') {
    await s.win.evaluate(() => localStorage.setItem('pdfsuite.engine', 'pdfjs'));
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
  }
  await s.setDialogAnswer([file]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  await s.win.waitForTimeout(1000);
  const rows = [await row('open')];
  const g = await s.win.locator('.viewer').first().evaluate((v) => { const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, sw: v.offsetWidth - v.clientWidth }; });
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
      await s.win.waitForTimeout(1500);
    }
    await s.win.waitForTimeout(2000);
    rows.push(await row(`round ${round}`));
  }
  const eng = await engineState(s.win);
  console.log(JSON.stringify({ engine, eng, rows }));
  check(`[${engine}] user scrolling: renderer(Tab)+GPU < 800 MB at every checkpoint`, rows.every((r) => r.tabPlusGpu < 800), rows);
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
