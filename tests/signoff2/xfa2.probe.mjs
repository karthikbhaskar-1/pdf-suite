// Re-audit probe: XFA form (IMM1344) on every page — HTML layer present with text, on-screen pixels not blank,
// layer follows zoom, and the current search highlight sits over a word containing the query.
import { join } from 'node:path';
import { CORPUS, ROOT2, launchTracked, openPath, check, summary, statusText, waitFor, closeAll, cleanupProfile } from './lib.mjs';
import { pixels } from '../signoff/common.mjs';

const s = await launchTracked();
try {
  await s.win.waitForSelector('.empty-state');
  await openPath(s, join(CORPUS, 'xfa', 'xfa_filled_imm1344e.pdf'), 'Page 1 of 7', 60000);
  await s.win.waitForTimeout(2500);
  const rows = [];
  for (let n = 1; n <= 7; n++) {
    const box = s.win.getByLabel('Page number');
    await box.click(); await box.fill(String(n)); await box.press('Enter');
    await s.win.waitForTimeout(1500);
    const info = await s.win.evaluate((idx) => {
      const p = document.querySelector(`.viewer .page[data-page-index="${idx}"]`);
      if (!p) return null;
      const pr = p.getBoundingClientRect();
      const layer = [...p.children].find((c) => !c.matches('canvas, .textLayer, .page-placeholder, .search-layer') && c.innerText && c.innerText.length > 20);
      const lr = layer?.getBoundingClientRect();
      return { textLen: layer ? layer.innerText.length : 0, cls: layer?.className ?? null, pageW: Math.round(pr.width), layerW: lr ? Math.round(lr.width) : null, top: Math.round(pr.top) };
    }, n - 1);
    const vb = await s.win.locator('.viewer').first().boundingBox();
    const shot = await pixels(s.app, { x: vb.x + 40, y: vb.y + 40, width: vb.width - 80, height: vb.height - 80 });
    rows.push({ n, status: (await statusText(s.win)).split('·')[0].trim(), ...info, topColor: shot.top[0] });
    if (n === 4) await s.win.screenshot({ path: join(ROOT2, 'tests', 'signoff2', 'xfa-page4.png') });
  }
  console.log(JSON.stringify(rows));
  check('every XFA page 1-7 has an HTML form layer with text, the full page width', rows.every((r) => r.textLen > 100 && r.layerW && Math.abs(r.layerW - r.pageW) <= 2), rows);
  check('no XFA page looks blank on screen (white below 97%)', rows.every((r) => !/^24[08],24[08],24[08]:(9[7-9]|100)/.test(r.topColor)), rows.map((r) => r.topColor));
  // Zoom: the layer follows.
  await s.win.keyboard.press('Control+g'); await s.win.keyboard.type('1'); await s.win.keyboard.press('Enter');
  for (let i = 0; i < 3; i++) await s.win.keyboard.press('Control+-');
  await s.win.waitForTimeout(1200);
  const z = await s.win.evaluate(() => {
    const p = document.querySelector('.viewer .page[data-page-index="0"]');
    const layer = [...p.children].find((c) => !c.matches('canvas, .textLayer, .page-placeholder, .search-layer') && c.innerText && c.innerText.length > 20);
    return { pageW: Math.round(p.getBoundingClientRect().width), layerW: Math.round(layer.getBoundingClientRect().width) };
  });
  check('after zooming out the XFA layer still matches the page width', Math.abs(z.pageW - z.layerW) <= 2, { ...z, status: await statusText(s.win) });
  // Search highlight placement on the HTML layer.
  await s.win.keyboard.press('Control+f');
  await s.win.getByLabel('Find in document').fill('Grandparent');
  await waitFor(async () => /^\d+ of \d+$/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 20000 });
  await s.win.waitForTimeout(1000);
  const hit = await s.win.evaluate(() => {
    const h = document.querySelector('.search-hit-current');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    h.parentElement.style.pointerEvents = 'none';
    const under = document.elementsFromPoint(cx, cy).map((e) => (e.value || e.innerText || '').slice(0, 60)).filter(Boolean);
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], under: under.slice(0, 4) };
  });
  check('XFA search: current "Grandparent" highlight sits over text containing it', hit && hit.under.some((t) => /grandparent/i.test(t)), { status: (await s.win.locator('.search-status').innerText()).trim(), hit });
  await s.win.screenshot({ path: join(ROOT2, 'tests', 'signoff2', 'xfa-search.png') });
  check('no console/page errors', [...s.errors].length === 0, [...s.errors].slice(0, 5));
} catch (e) {
  check('probe ran', false, String(e.stack ?? e).slice(0, 600));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
