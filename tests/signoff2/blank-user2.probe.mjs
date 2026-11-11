// Re-audit probe: stuck-blank pages (no placeholder, canvas never painted) reached by user input only.
// Each try: real scrollbar-thumb sweep (down and up) + wheel flings, then one user navigation method. Checks the
// visible pages 3 s and 15 s later. Run: node tests/signoff2/blank-user2.probe.mjs [mupdf|pdfjs]
import { join } from 'node:path';
import { ROOT2, launchTracked, check, summary, waitForPage, closeAll, cleanupProfile, fixture, statusText } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const s = await launchTracked();
const win = s.win;
const blankNow = () => win.evaluate(() => {
  const v = document.querySelector('.viewer'); const vr = v.getBoundingClientRect();
  return [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; })
    .filter((p) => !p.querySelector('.page-placeholder') && p.querySelector('canvas').width === 300).map((p) => Number(p.dataset.pageIndex) + 1);
});
async function churn() {
  if (process.env.CHURN === 'keys') {
    await win.locator('.viewer').first().click({ position: { x: 30, y: 30 } });
    for (let i = 0; i < 120; i++) { await win.keyboard.press('PageDown'); await win.waitForTimeout(16); }
    for (let i = 0; i < 120; i++) { await win.keyboard.press('PageUp'); await win.waitForTimeout(16); }
    const b = await win.locator('.viewer').first().boundingBox();
    await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < 60; i++) { await win.mouse.wheel(0, 600); await win.waitForTimeout(25); }
    for (let i = 0; i < 40; i++) { await win.mouse.wheel(0, -600); await win.waitForTimeout(25); }
    await win.waitForTimeout(800);
    return;
  }
  const g = await win.locator('.viewer').first().evaluate((v) => { const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, sw: v.offsetWidth - v.clientWidth, f: v.scrollTop / (v.scrollHeight - v.clientHeight) }; });
  const tx = g.x + g.w - g.sw / 2, t0 = g.y + 20, t1 = g.y + g.h - 20;
  await win.mouse.move(tx, t0 + g.f * (t1 - t0));
  await win.mouse.down();
  await win.mouse.move(tx, t1, { steps: 30 });
  await win.mouse.move(tx, t0, { steps: 30 });
  await win.mouse.up();
  await win.waitForTimeout(600);
  await win.mouse.move(g.x + g.w / 2, g.y + g.h / 2);
  for (let i = 0; i < 60; i++) { await win.mouse.wheel(0, 600); await win.waitForTimeout(25); }
  for (let i = 0; i < 40; i++) { await win.mouse.wheel(0, -600); await win.waitForTimeout(25); }
  await win.waitForTimeout(800);
}
const goto = async (n) => { const box = win.getByLabel('Page number'); await box.click(); await box.fill(String(n)); await box.press('Enter'); };
const methods = {
  'go to page 137': () => goto(137),
  'go to page 512': () => goto(512),
  'Ctrl+End': () => win.keyboard.press('Control+End'),
  'Ctrl+Home': () => win.keyboard.press('Control+Home'),
  'bookmark Chapter 4': async () => {
    await win.getByRole('button', { name: 'Bookmarks', exact: true }).click();
    await win.getByRole('tree', { name: 'Bookmarks', exact: true }).getByRole('button', { name: /^Chapter 4/ }).first().click();
  },
  'thumbnail click': async () => {
    await win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
    await win.locator('.thumb[role="option"]').first().waitFor({ timeout: 5000 });
    await win.locator('.thumb-list').evaluate((e) => { e.scrollTop = e.scrollHeight * 0.37; });
    await win.waitForTimeout(500);
    await win.locator('.thumb[role="option"]').nth(3).click();
  },
  'scrollbar track click x3': async () => {
    const g = await win.locator('.viewer').first().boundingBox();
    const sw = await win.locator('.viewer').first().evaluate((v) => v.offsetWidth - v.clientWidth);
    for (let i = 0; i < 3; i++) { await win.mouse.click(g.x + g.width - sw / 2, g.y + g.height - 40); await win.waitForTimeout(150); }
  },
};
try {
  await win.waitForSelector('.empty-state');
  if (engine === 'pdfjs') {
    await win.evaluate(() => localStorage.setItem('pdfsuite.engine', 'pdfjs'));
    await win.reload();
    await win.waitForSelector('.empty-state');
  }
  await s.setDialogAnswer([fixture('big-1000.pdf')]);
  await win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  await win.waitForTimeout(800);
  const rows = [];
  for (const [name, act] of [...Object.entries(methods), ...Object.entries(methods)]) {
    await churn();
    await act();
    await win.waitForTimeout(3000);
    const b3 = await blankNow();
    let b15 = null;
    if (b3.length) {
      await win.waitForTimeout(12000);
      b15 = await blankNow();
      if (b15.length && !rows.some((r) => r.shot)) {
        const shot = join(ROOT2, 'tests', 'signoff2', `stuck-blank-${engine}.png`);
        await win.screenshot({ path: shot });
        rows.push({ shot });
      }
    }
    rows.push({ name, status: (await statusText(win)).split('·')[0].trim(), blank3s: b3, blank15s: b15 });
  }
  console.log(JSON.stringify(rows));
  const bad = rows.filter((r) => r.name && r.blank3s.length);
  check(`[${engine}${process.env.CHURN ? '/' + process.env.CHURN : ''}] user navigation after scroll churn never leaves a visible page blank for 3 s (14 tries)`, bad.length === 0, bad);
  check(`[${engine}] ...nor for 15 s`, rows.filter((r) => r.blank15s && r.blank15s.length).length === 0, rows.filter((r) => r.blank15s && r.blank15s.length));
  check(`[${engine}] no console errors`, [...s.errors].length === 0, [...s.errors].slice(0, 5));
} catch (e) {
  check('probe ran', false, String(e.stack ?? e).slice(0, 600));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
