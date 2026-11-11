// Probe F: does a page selection made in one document reach another document? Probe E saw page 1 of a newly opened file
// already selected after a thumbnail click in a different, closed file, and Rotate then turned page 1 while the page box
// said 7 and 8. This checks the case that can lose pages: Delete from the toolbar in a second document.
import { placeWindow } from '../e2e/helpers.mjs';
import {
  launch, closeAll, cleanupProfile, newProfileDir, delay, showPanel, inspect, brief, openMore, waitFor, pageCount,
  watchToasts, toastCount, toastsSince, waitToast, mk, wipeWork, report,
} from './lib.mjs';

const R = report('f-selection-leak');
const profile = newProfileDir();
let s;
let win;
const box = () => win.locator('footer.status-bar').getByLabel('Go to page');
const state = () => win.evaluate(() => ({
  box: document.querySelector('#status-page-box')?.value,
  of: document.querySelector('.status-of')?.textContent,
  selectedThumbs: [...document.querySelectorAll('.thumb-selected .thumb-label')].map((l) => l.textContent),
  thumbsPanel: document.querySelector('.thumb-list') !== null,
  tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
}));
async function typePage(n) { await box().fill(String(n)); await box().press('Enter'); await delay(900); }
async function hideThumbs() {
  const b = win.getByRole('button', { name: 'Thumbnails', exact: true }).first();
  if ((await b.getAttribute('aria-pressed')) === 'true') await b.click();
  await delay(300);
}
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
/** Clicks the toolbar's Delete, answers a confirmation if one shows, saves, and returns the pages now on disk. */
async function deleteAndSave(label, path, expectCount) {
  const from = await toastCount(win);
  await win.locator('.top-bar').getByRole('button', { name: 'Delete pages', exact: true }).click();
  await delay(700);
  const dlg = win.getByRole('dialog');
  if ((await dlg.count()) > 0) { R.info(`${label}: a dialog showed: ${(await dlg.first().innerText()).replace(/\s+/g, ' ').slice(0, 200)}`); const del = dlg.getByRole('button', { name: /^Delete/ }); if ((await del.count()) > 0) await del.first().click(); }
  await delay(900);
  R.info(`${label}: after Delete: ${JSON.stringify(await state())} toasts ${JSON.stringify(await toastsSince(win, from))}`);
  const f2 = await toastCount(win);
  await win.keyboard.press('Control+s');
  const t = await waitToast(win, f2, /^Saved /, 20000);
  await delay(400);
  const d = inspect(path);
  R.info(`${label}: saved (${JSON.stringify(t)}); on disk: ${brief(d)}`);
  return d;
}

try {
  s = await launch({ profile });
  win = s.win;
  await placeWindow(s, { width: 1400, height: 800 });
  await win.waitForSelector('.empty-state');
  await watchToasts(win);

  await R.step('1 select in A, open B, delete in B', async () => {
    const a = mk('mixed-sizes-rotated.pdf', 'A.pdf');
    const b = mk('outline-6.pdf', 'B.pdf');
    await openMore(s, a.path, 8, 1); await showPanel(win, 'Thumbnails');
    await win.locator('.thumb', { has: win.locator('.thumb-label', { hasText: /^3$/ }) }).click();
    await delay(300);
    R.info(`1: in A after clicking thumbnail 3: ${JSON.stringify(await state())}`);
    await openMore(s, b.path, 6, 2);
    await delay(500);
    R.info(`1: B just opened, nothing clicked in it: ${JSON.stringify(await state())}`);
    await hideThumbs();
    await typePage(5);
    R.info(`1: B, thumbnails panel closed, typed 5: ${JSON.stringify(await state())}`);
    const d = await deleteAndSave('1', b.path, 5);
    const texts = d.pages.map((p) => p.text);
    R.check('1: page 3 selected in A.pdf; in B.pdf (panel closed) go to page 5 and press Delete in the toolbar: page 5 of B is the one deleted', d.count === 5 && !texts.includes('Outline page 5') && texts.includes('Outline page 3'), `on disk: ${brief(d)}`);
  });
  await closeEverything();

  await R.step('2 select three in A, switch to tab B, delete in B', async () => {
    const b = mk('outline-6.pdf', 'B2.pdf');
    const a = mk('mixed-sizes-rotated.pdf', 'A2.pdf');
    await openMore(s, b.path, 6, 1);
    await openMore(s, a.path, 8, 2); await showPanel(win, 'Thumbnails');
    await win.locator('.thumb', { has: win.locator('.thumb-label', { hasText: /^2$/ }) }).click();
    await win.locator('.thumb', { has: win.locator('.thumb-label', { hasText: /^4$/ }) }).click({ modifiers: ['Shift'] });
    await delay(300);
    R.info(`2: in A2 after selecting 2-4: ${JSON.stringify(await state())}`);
    await win.getByRole('tab').nth(0).click();
    await waitFor(async () => (await pageCount(win)) === 6, { timeoutMs: 8000, label: 'tab B2' });
    await delay(400);
    R.info(`2: switched to B2, nothing clicked in it: ${JSON.stringify(await state())}`);
    await hideThumbs();
    await typePage(6);
    const d = await deleteAndSave('2', b.path, 5);
    const texts = d.pages.map((p) => p.text);
    R.check('2: pages 2-4 selected in A2.pdf; switch to the B2.pdf tab (panel closed), go to page 6, Delete: only page 6 of B2 is deleted', d.count === 5 && !texts.includes('Outline page 6') && texts.includes('Outline page 2'), `on disk: ${brief(d)}`);
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
