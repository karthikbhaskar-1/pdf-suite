// Sign-off probe: blank pages after dragging the viewer's scrollbar thumb (real mouse input on the native scrollbar),
// mixed with wheel flings. Run: node tests/signoff2/blank-scrollbar.probe.mjs [mupdf|pdfjs]
import { join } from 'node:path';
import { ROOT2, launchTracked, check, summary, waitForPage, closeAll, cleanupProfile, fixture, statusText } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const visState = (win) => win.evaluate(() => {
  const v = document.querySelector('.viewer'); const vr = v.getBoundingClientRect();
  return [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; })
    .map((p) => ({ n: Number(p.dataset.pageIndex) + 1, ph: !!p.querySelector('.page-placeholder'), w: p.querySelector('canvas').width }));
});
const geom = (win) => win.locator('.viewer').first().evaluate((v) => {
  const r = v.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, sw: v.offsetWidth - v.clientWidth, top: v.scrollTop, sh: v.scrollHeight, ch: v.clientHeight };
});
const s = await launchTracked();
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
  await s.win.waitForTimeout(800);
  const events = [];
  for (const stopFrac of [0.137, 0.512, 0.888, 0.3, 0.7, 0.137]) {
    const g = await geom(s.win);
    const thumbX = g.x + g.w - g.sw / 2;
    const track0 = g.y + 20, track1 = g.y + g.h - 20; // inside arrow buttons
    const thumbY = track0 + (g.top / (g.sh - g.ch)) * (track1 - track0);
    // Wheel fling first (as a user flicks), then grab the thumb and sweep down, up, and stop at stopFrac.
    await s.win.mouse.move(g.x + g.w / 2, g.y + g.h / 2);
    for (let i = 0; i < 40; i++) { await s.win.mouse.wheel(0, 700); await s.win.waitForTimeout(20); }
    await s.win.waitForTimeout(300);
    const g2 = await geom(s.win);
    const ty = track0 + (g2.top / (g2.sh - g2.ch)) * (track1 - track0);
    await s.win.mouse.move(thumbX, ty);
    await s.win.mouse.down();
    await s.win.mouse.move(thumbX, track1, { steps: 40 });
    await s.win.mouse.move(thumbX, track0, { steps: 40 });
    await s.win.mouse.move(thumbX, track0 + stopFrac * (track1 - track0), { steps: 15 });
    await s.win.mouse.up();
    const paintMs = await s.win.evaluate(async () => {
      const v = document.querySelector('.viewer'); const t = performance.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 50));
        const vr = v.getBoundingClientRect();
        const vis = [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; });
        if (vis.length && vis.every((p) => p.querySelector('canvas').width !== 300)) return Math.round(performance.now() - t);
        if (performance.now() - t > 15000) return null;
      }
    });
    const blank = (await visState(s.win)).filter((p) => !p.ph && p.w === 300).map((p) => p.n);
    const row = { paintMs, stopFrac, status: (await statusText(s.win)).split('·')[0].trim(), blankAfter4s: blank };
    if (blank.length) {
      await s.win.waitForTimeout(6000);
      row.blankAfter10s = (await visState(s.win)).filter((p) => !p.ph && p.w === 300).map((p) => p.n);
      if (!events.some((e) => e.shot)) { row.shot = join(ROOT2, 'tests', 'signoff2', `blank-scrollbar-${engine}.png`); await s.win.screenshot({ path: row.shot }); }
    }
    events.push(row);
    void thumbY;
  }
  console.log(JSON.stringify(events));
  check(`[${engine}] after scrollbar-thumb drags (real mouse), no visible page is left blank (6 tries)`, events.every((e) => e.blankAfter4s.length === 0), events);
  check(`[${engine}] no console errors`, s.errors.length === 0, s.errors.slice(0, 5));
} catch (e) {
  check('probe ran', false, String(e.stack ?? e).slice(0, 600));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
