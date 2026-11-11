// Sign-off probe: user-level reproduction of pages left blank. Only user input: mouse wheel flings, then
// Go to page (Ctrl+G) or the page box. A page is "blank" when it has no placeholder and its canvas was never painted.
// Run: node tests/signoff2/blank-user.probe.mjs [mupdf|pdfjs]
import { join } from 'node:path';
import { ROOT2, launchTracked, check, summary, waitForPage, closeAll, cleanupProfile, fixture, statusText } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const visState = (win) => win.evaluate(() => {
  const v = document.querySelector('.viewer'); const vr = v.getBoundingClientRect();
  return [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; })
    .map((p) => ({ n: Number(p.dataset.pageIndex) + 1, ph: !!p.querySelector('.page-placeholder'), w: p.querySelector('canvas').width }));
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
  const vb = await s.win.locator('.viewer').first().boundingBox();
  const events = [];
  for (const target of [137, 420, 650, 137, 803, 290]) {
    await s.win.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    for (let i = 0; i < 50; i++) { await s.win.mouse.wheel(0, 700); await s.win.waitForTimeout(20); }
    for (let i = 0; i < 30; i++) { await s.win.mouse.wheel(0, -700); await s.win.waitForTimeout(20); }
    await s.win.waitForTimeout(500);
    await s.win.keyboard.press('Control+g');
    await s.win.keyboard.type(String(target));
    await s.win.keyboard.press('Enter');
    await s.win.waitForTimeout(4000);
    const st = await visState(s.win);
    const blank = st.filter((p) => !p.ph && p.w === 300).map((p) => p.n);
    events.push({ target, status: (await statusText(s.win)).split('·')[0].trim(), blankAfter4s: blank });
    if (blank.length && !events.some((e) => e.shot)) {
      events[events.length - 1].shot = join(ROOT2, 'tests', 'signoff2', `blank-user-${engine}.png`);
      await s.win.screenshot({ path: events[events.length - 1].shot });
    }
  }
  console.log(JSON.stringify(events));
  check(`[${engine}] after wheel flings + Go to page, no visible page is left blank (6 tries)`, events.every((e) => e.blankAfter4s.length === 0), events);
  check(`[${engine}] no console errors`, s.errors.length === 0, s.errors.slice(0, 5));
} catch (e) {
  check('probe ran', false, String(e.stack ?? e).slice(0, 600));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
