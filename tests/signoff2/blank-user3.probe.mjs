// Re-audit probe: stuck-blank pages via app paths that set scrollTop programmatically: split sync (follower pane)
// and Pan-and-Zoom overview clicks, plus search F3 across distant matches. User input only.
// Run: node tests/signoff2/blank-user3.probe.mjs [mupdf|pdfjs]
import { launchTracked, check, summary, waitForPage, waitFor, closeAll, cleanupProfile, fixture } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const s = await launchTracked();
const win = s.win;
const blankIn = (i) => win.evaluate((i) => {
  const v = document.querySelectorAll('.viewer')[i]; const vr = v.getBoundingClientRect();
  return [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; })
    .filter((p) => !p.querySelector('.page-placeholder') && p.querySelector('canvas').width === 300).map((p) => Number(p.dataset.pageIndex) + 1);
}, i);
const fling = async (i, down = 60, up = 40) => {
  const b = await win.locator('.viewer').nth(i).boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let k = 0; k < down; k++) { await win.mouse.wheel(0, 600); await win.waitForTimeout(25); }
  for (let k = 0; k < up; k++) { await win.mouse.wheel(0, -600); await win.waitForTimeout(25); }
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
  // A. Pan-and-zoom clicks.
  for (let i = 0; i < 2; i++) await win.keyboard.press('Control+=');
  await win.getByRole('button', { name: 'Pan and zoom', exact: true }).click();
  const pz = win.locator('.floating[aria-label="Pan and zoom"]');
  await pz.waitFor({ timeout: 5000 });
  await waitFor(async () => (await pz.locator('.overview-rect').count()) === 1, { timeoutMs: 10000 });
  for (const [fx, fy] of [[0.3, 0.2], [0.7, 0.9], [0.5, 0.5], [0.2, 0.8]]) {
    await fling(0);
    const ob = await pz.locator('.overview-frame').boundingBox();
    await win.mouse.click(ob.x + ob.width * fx, ob.y + ob.height * fy);
    await win.waitForTimeout(3000);
    rows.push({ path: 'pan-zoom click', b3: await blankIn(0) });
  }
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+0');
  // B. Split sync: fling one pane, watch the follower.
  await win.keyboard.press('Control+\\');
  await waitFor(async () => (await win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000 });
  await win.waitForTimeout(800);
  for (let t = 0; t < 4; t++) {
    const leader = t % 2;
    await fling(leader, 50 + t * 10, 30);
    await win.waitForTimeout(3000);
    rows.push({ path: `split sync, fling pane ${leader + 1}`, leader: await blankIn(leader), follower: await blankIn(1 - leader) });
  }
  // C. Search F3 jumps.
  await win.keyboard.press('Control+f');
  await win.getByLabel('Find in document').fill('zephyrbloom');
  await waitFor(async () => /^\d+ of 1000$/.test((await win.locator('.search-status').innerText()).trim()), { timeoutMs: 30000 });
  for (let t = 0; t < 3; t++) {
    await fling(0);
    for (let k = 0; k < 5; k++) await win.keyboard.press('Shift+F3');
    await win.waitForTimeout(3000);
    rows.push({ path: 'search Shift+F3 x5', b3: [...(await blankIn(0)), ...(await blankIn(1))] });
  }
  console.log(JSON.stringify(rows));
  const bad = rows.filter((r) => (r.b3 && r.b3.length) || (r.leader && r.leader.length) || (r.follower && r.follower.length));
  check(`[${engine}] pan-zoom / split-sync / search jumps after flings never leave a visible page blank at 3 s (${rows.length} tries)`, bad.length === 0, bad);
  if (bad.length) {
    await win.waitForTimeout(12000);
    const still = [await blankIn(0), (await win.locator('.viewer').count()) > 1 ? await blankIn(1) : []];
    check(`[${engine}] ...and none still blank 15 s later`, still.every((x) => x.length === 0), still);
  }
  check(`[${engine}] no console errors`, [...s.errors].length === 0, [...s.errors].slice(0, 5));
} catch (e) {
  check('probe ran', false, String(e.stack ?? e).slice(0, 600));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
