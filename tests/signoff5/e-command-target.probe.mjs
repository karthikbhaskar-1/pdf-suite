// Probe E: which page does a page command act on after a typed jump? Probe C's second run saw three Rotate clicks land on
// page 1 after typed jumps to 7 and 8. This walks it step by step: (a) no thumbnail ever clicked, (b) a thumbnail clicked in
// another document that was then closed, (c) a thumbnail clicked in this document, then a typed jump.
import { placeWindow } from '../e2e/helpers.mjs';
import {
  launch, closeAll, cleanupProfile, newProfileDir, delay, showPanel, inspect, openMore,
  watchToasts, toastCount, toastsSince, waitToast, mk, wipeWork, report,
} from './lib.mjs';

const R = report('e-command-target');
const profile = newProfileDir();
let s;
let win;
const box = () => win.locator('footer.status-bar').getByLabel('Go to page');
const state = () => win.evaluate(() => ({
  box: document.querySelector('#status-page-box')?.value,
  current: [...document.querySelectorAll('.thumb-current .thumb-label')].map((l) => l.textContent),
  selected: [...document.querySelectorAll('.thumb-selected .thumb-label')].map((l) => l.textContent),
  focus: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}`.slice(0, 60) : null,
  zoom: document.querySelector('input[aria-label="Zoom level"]')?.value,
}));
async function typePage(n) { await box().fill(String(n)); await box().press('Enter'); await delay(900); }
async function setZoom(z) { const i = win.locator('footer.status-bar').getByLabel('Zoom level'); await i.fill(String(z)); await i.press('Enter'); await delay(700); }
async function closeEverything() {
  for (let i = 0; i < 6; i++) {
    if ((await win.getByRole('tab').count()) === 0) return;
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+Shift+w');
    await delay(400);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(400);
  }
}
const rotations = (path) => inspect(path, undefined, { text: false }).pages.map((p) => p.rotate);
/** Types 7, rotates once, types 8, rotates twice, saves. Returns which pages turned, and what the app showed on the way. */
async function run(label, c, { scrollThumbs = false } = {}) {
  const before = rotations(c.path);
  const rot = win.locator('.thumb-toolbar').getByRole('button', { name: 'Rotate right 90°' });
  const from = await toastCount(win);
  await setZoom(50);
  await typePage(7);
  if (scrollThumbs) await win.evaluate(() => { const l = document.querySelector('.thumb-list'); l.scrollTop = l.scrollHeight; });
  await delay(300);
  R.info(`${label}: after typed 7: ${JSON.stringify(await state())}`);
  await rot.click(); await delay(900);
  R.info(`${label}: after Rotate: ${JSON.stringify(await state())}`);
  await typePage(8);
  if (scrollThumbs) await win.evaluate(() => { const l = document.querySelector('.thumb-list'); l.scrollTop = l.scrollHeight; });
  await delay(300);
  R.info(`${label}: after typed 8: ${JSON.stringify(await state())}`);
  await rot.click(); await delay(900); await rot.click(); await delay(900);
  R.info(`${label}: after two more Rotates: ${JSON.stringify(await state())}`);
  const f2 = await toastCount(win);
  await win.keyboard.press('Control+s');
  await waitToast(win, f2, /^Saved /, 20000);
  await delay(400);
  const after = rotations(c.path);
  const delta = after.map((r, i) => (((r - before[i]) % 360) + 360) % 360);
  R.info(`${label}: turned on disk ${JSON.stringify(delta)}; toasts ${JSON.stringify(await toastsSince(win, from))}`);
  return delta;
}

try {
  s = await launch({ profile });
  win = s.win;
  await placeWindow(s, { width: 1400, height: 800 });
  await win.waitForSelector('.empty-state');
  await watchToasts(win);
  const want = JSON.stringify([0, 0, 0, 0, 0, 0, 90, 180]);

  await R.step('a', async () => {
    const c = mk('mixed-sizes-rotated.pdf', 'a.pdf');
    await openMore(s, c.path, 8, 1); await showPanel(win, 'Thumbnails');
    const d = await run('a no thumbnail clicked', c);
    R.check('a: no thumbnail ever clicked: typed 7 + Rotate, typed 8 + Rotate twice turn pages 7 and 8', JSON.stringify(d) === want, JSON.stringify(d));
  });
  await closeEverything();
  await R.step('a2', async () => {
    const c = mk('mixed-sizes-rotated.pdf', 'a2.pdf');
    await openMore(s, c.path, 8, 1); await showPanel(win, 'Thumbnails');
    const d = await run('a2 thumbnail list scrolled by hand, nothing clicked', c, { scrollThumbs: true });
    R.check('a2: the same with the thumbnail list scrolled (not clicked) before each Rotate', JSON.stringify(d) === want, JSON.stringify(d));
  });
  await closeEverything();
  await R.step('b', async () => {
    const other = mk('mixed-sizes-rotated.pdf', 'other.pdf');
    await openMore(s, other.path, 8, 1); await showPanel(win, 'Thumbnails');
    await win.locator('.thumb').first().click(); await delay(300);
    R.info(`b: other document after clicking thumbnail 1: ${JSON.stringify(await state())}`);
    await closeEverything();
    const c = mk('mixed-sizes-rotated.pdf', 'b.pdf');
    await openMore(s, c.path, 8, 1); await showPanel(win, 'Thumbnails');
    R.info(`b: new document just opened: ${JSON.stringify(await state())}`);
    const d = await run('b thumbnail clicked in another, closed document', c);
    R.check('b: a thumbnail clicked in another document (now closed) does not redirect the command', JSON.stringify(d) === want, JSON.stringify(d));
  });
  await closeEverything();
  await R.step('c', async () => {
    const c = mk('mixed-sizes-rotated.pdf', 'c.pdf');
    await openMore(s, c.path, 8, 1); await showPanel(win, 'Thumbnails');
    await win.locator('.thumb').first().click(); await delay(300);
    const d = await run('c thumbnail 1 clicked in this document first', c);
    R.info(`c: thumbnail 1 clicked, then typed 7/8 + Rotate: turned ${JSON.stringify(d)} (selection wins over the page box when ${JSON.stringify(d) === want ? 'NOT the case here' : 'a page is selected'})`);
  });
  await closeEverything();
} catch (err) {
  R.check('probe ran to the end', false, String(err && err.stack ? err.stack : err).slice(0, 600));
} finally {
  await closeAll();
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
