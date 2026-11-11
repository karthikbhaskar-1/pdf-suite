// Probe H (re-check of the selection fix): a selection carried through Save As (the document id changes) and through a
// plain save (the page uids start again), then Delete; and split view with one document in both panes.
// The right pages must go, the thumbnails and page box must be right, undo must work, and the file on disk must match.
import { placeWindow } from '../e2e/helpers.mjs';
import { join } from 'node:path';
import {
  launch, closeAll, cleanupProfile, newProfileDir, delay, showPanel, inspect, brief, openMore, waitFor, pageCount, setSaveAnswer, isDirty, fixture,
  watchToasts, toastCount, toastsSince, waitToast, dup, mk, wipeWork, report, sameBytes, readFileSync,
} from './lib.mjs';

const R = report('h-saveas-selection');
const profile = newProfileDir();
let s;
let win;
/** Page box, tab title, and every thumbnail's label with its selected / current marks (the list is scrolled through). */
const state = () => win.evaluate(async () => {
  const list = document.querySelector('.thumb-list');
  const seen = new Map();
  if (list) {
    const sheet = list.querySelector('.thumb-sheet');
    const max = Math.max(0, (sheet ? sheet.offsetHeight : list.scrollHeight) - list.clientHeight);
    const ys = [];
    for (let y = 0; y < max; y += Math.max(100, list.clientHeight * 0.6)) ys.push(y);
    ys.push(max);
    for (const y of ys) {
      list.scrollTop = y;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 90)));
      for (const el of list.querySelectorAll('.thumb')) seen.set(Number(el.querySelector('.thumb-label')?.textContent), { sel: el.classList.contains('thumb-selected'), cur: el.classList.contains('thumb-current') });
    }
    list.scrollTop = 0;
  }
  const labels = [...seen.keys()].sort((a, b) => a - b);
  return {
    box: document.querySelector('#status-page-box')?.value, of: document.querySelector('.status-of')?.textContent,
    thumbs: labels.length, selected: labels.filter((l) => seen.get(l).sel), current: labels.filter((l) => seen.get(l).cur),
    tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), panes: document.querySelectorAll('.pane-frame').length,
  };
});
async function clickThumb(n, modifiers = []) {
  await win.evaluate(async (want) => {
    const list = document.querySelector('.thumb-list');
    const sheet = list.querySelector('.thumb-sheet');
    const max = Math.max(0, (sheet ? sheet.offsetHeight : list.scrollHeight) - list.clientHeight);
    const has = () => [...list.querySelectorAll('.thumb-label')].some((l) => l.textContent.trim() === String(want));
    list.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 90)));
    for (let y = 0; y <= max + 1 && !has(); y += Math.max(100, list.clientHeight * 0.6)) { list.scrollTop = Math.min(max, y); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 90))); }
  }, n);
  await win.locator('.thumb', { has: win.locator('.thumb-label', { hasText: new RegExp(`^${n}$`) }) }).click({ modifiers, timeout: 5000 });
  await delay(200);
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
const del = () => win.locator('.top-bar').getByRole('button', { name: 'Delete pages', exact: true });
async function save(press = 'Control+s') { const f = await toastCount(win); await win.keyboard.press(press); const t = await waitToast(win, f, /^Saved /, 20000); await delay(500); return t; }
const texts = async () => {
  // What the app holds, read by extracting nothing: the page texts are checked on disk after a save instead.
  return pageCount(win);
};

/** Select thumbnails `a`..`b`, run `saveStep`, then Delete / Undo / Redo / Save, checking each stage. */
async function scenario(label, { dupFirst, saveAs }) {
  const c = mk('outline-6.pdf', `${label}.pdf`);
  const original = readFileSync(c.path);
  await openMore(s, c.path, 6, 1); await showPanel(win, 'Thumbnails');
  let n = 6;
  if (dupFirst) n = await dup(win); // [o1,o1,o2,o3,o4,o5,o6]: page uids no longer equal page positions
  const [a, b] = dupFirst ? [3, 4] : [2, 3]; // the pages "Outline page 2" and "Outline page 3" either way
  await clickThumb(a); await clickThumb(b, ['Shift']);
  const before = await state();
  let target = c.path;
  if (saveAs) { target = join(c.dir, `${label}-copy.pdf`); await setSaveAnswer(s, target); }
  const t = await save(saveAs ? 'Control+Shift+s' : 'Control+s');
  const afterSave = await state();
  R.info(`${label}: before save ${JSON.stringify(before)}; after ${saveAs ? 'Save As' : 'Save'} (${JSON.stringify(t)}) ${JSON.stringify(afterSave)}`);
  R.check(`${label}: after the save the same thumbnails (${a}-${b}) are still the selected ones, or none is`, JSON.stringify(afterSave.selected) === JSON.stringify([a, b]) || afterSave.selected.length === 0, `selected ${JSON.stringify(afterSave.selected)}`);
  if (saveAs) R.check(`${label}: Save As left the original file untouched`, sameBytes(c.path, original));
  const from = await toastCount(win);
  const cur = Number(afterSave.box);
  await del().click(); await delay(1000);
  const afterDelete = await state();
  const ts = await toastsSince(win, from);
  // Expected: the selected pages when a selection is shown, else the current page.
  const full = dupFirst ? ['o1', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6'] : ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
  const gone = afterSave.selected.length > 0 ? afterSave.selected : [cur];
  const want = full.filter((_, i) => !gone.includes(i + 1));
  R.info(`${label}: after Delete ${JSON.stringify(afterDelete)} toasts ${JSON.stringify(ts)}`);
  await win.keyboard.press('Control+z'); await delay(1000);
  const afterUndo = await state();
  R.check(`${label}: Undo brings the pages back (${n} pages, ${n} thumbnails)`, afterUndo.of === `of ${n}` && afterUndo.thumbs === n, JSON.stringify(afterUndo));
  await win.locator('.top-bar').getByRole('button', { name: /^Redo/ }).first().click(); await delay(1000);
  const afterRedo = await state();
  const t2 = await save();
  const d = inspect(target);
  const onDisk = brief(d);
  R.check(`${label}: Delete removed exactly the pages shown as selected (or the current page when none is shown); thumbnails, page box and the saved file agree`, onDisk === `${want.length}p [${want.join(',')}]` && afterRedo.thumbs === want.length && afterRedo.of === `of ${want.length}` && Number(afterRedo.box) >= 1 && Number(afterRedo.box) <= want.length && afterDelete.thumbs === want.length && !(await isDirty(win)), `on disk ${onDisk} (want ${want.length}p [${want.join(',')}]); targets ${JSON.stringify(gone)}; after redo ${JSON.stringify(afterRedo)}; save ${JSON.stringify(t2)}`);
  if (saveAs) R.check(`${label}: the original file is still untouched at the end`, sameBytes(c.path, original));
}

try {
  s = await launch({ profile });
  win = s.win;
  await placeWindow(s, { width: 1400, height: 800 });
  await win.waitForSelector('.empty-state');
  await watchToasts(win);

  await R.step('H1', () => scenario('H1 select 2-3, Save As, Delete', { dupFirst: false, saveAs: true }));
  await closeEverything();
  await R.step('H2', () => scenario('H2 duplicate, select, Save As, Delete', { dupFirst: true, saveAs: true }));
  await closeEverything();
  await R.step('H3', () => scenario('H3 duplicate, select, Save, Delete', { dupFirst: true, saveAs: false }));
  await closeEverything();

  await R.step('H4 split view, one document in both panes', async () => {
    const c = mk('outline-6.pdf', 'H4.pdf');
    const other = mk('mixed-sizes-rotated.pdf', 'H4-other.pdf');
    await openMore(s, other.path, 8, 1);
    await openMore(s, c.path, 6, 2); await showPanel(win, 'Thumbnails');
    await win.locator('.top-bar').getByRole('button', { name: 'Split', exact: true }).click();
    await win.getByRole('menuitem', { name: 'Split vertical' }).click();
    await waitFor(async () => (await win.locator('.pane-frame').count()) === 2, { timeoutMs: 8000, label: 'two panes' });
    await delay(600);
    R.info(`H4: split on: ${JSON.stringify(await state())}; pane headers ${JSON.stringify(await win.locator('.pane-header').allInnerTexts())}`);
    await clickThumb(2); await clickThumb(3, ['Shift']);
    const sel = await state();
    const activeBefore = await win.evaluate(() => [...document.querySelectorAll('.pane-frame')].findIndex((p) => p.classList.contains('pane-active')));
    // Go to the other pane without clicking a page.
    await win.locator('.pane-frame:not(.pane-active) .pane-header').first().click({ position: { x: 8, y: 8 } });
    await delay(500);
    const activeAfter = await win.evaluate(() => [...document.querySelectorAll('.pane-frame')].findIndex((p) => p.classList.contains('pane-active')));
    const inOther = await state();
    R.info(`H4: selected in pane ${activeBefore}: ${JSON.stringify(sel)}; now in pane ${activeAfter}: ${JSON.stringify(inOther)}`);
    const cur = Number(inOther.box);
    await del().click(); await delay(1000);
    const after = await state();
    const t = await save();
    const d = inspect(c.path);
    const gone = inOther.selected.length > 0 ? inOther.selected : [cur];
    const want = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].filter((_, i) => !gone.includes(i + 1));
    R.check('H4: selection made in one pane, Delete pressed with the other pane active: the pages shown as selected (or, with none shown, the current page) are the ones deleted, in this document only', activeAfter !== activeBefore && brief(d) === `${want.length}p [${want.join(',')}]` && after.thumbs === want.length, `targets ${JSON.stringify(gone)}; on disk ${brief(d)}; after ${JSON.stringify(after)}; save ${JSON.stringify(t)}`);
    R.check('H4: the other open document was not touched', sameBytes(other.path, readFileSync(fixture('mixed-sizes-rotated.pdf'))));
  });
  await closeEverything();
  const errs = s.errors.filter((e) => !/favicon/.test(e));
  R.check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 400));
} catch (err) {
  R.check('probe ran to the end', false, String(err && err.stack ? err.stack : err).slice(0, 600));
} finally {
  await closeAll();
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
