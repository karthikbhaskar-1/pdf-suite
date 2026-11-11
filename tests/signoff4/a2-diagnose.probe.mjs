// Probe A2: follow-ups to probe A. (1) Is the recovery log on disk after a failed save? (2) Is the document clean after
// a good save that follows a failed one, with and without an outside change of the file? (3) Reload after an outside change.
// (4) 1000 pages: which page got the rotation.
import { join } from 'node:path';
import { readFileSync, chmodSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, waitFor, delay, newProfileDir, cleanupProfile, fixture,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspect, brief, toasts, isDirty, clickRowByIndex, currentPage,
} from './lib.mjs';

const R = makeReport('a2-diagnose');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
let win;
let profile;
const rec = () => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : []);
const recSteps = () => {
  const dir = join(profile, 'recovery');
  if (!existsSync(dir)) return 'no folder';
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return `${j.steps.length} steps [${j.steps.map((st) => st.map((e) => e.op).join('+')).join(', ')}]`;
    } catch (e) {
      return `unreadable ${e.message}`;
    }
  }).join(' ; ') || 'none';
};
const state = async (label) => {
  const u = (await menuItems(win, 'Edit')).slice(0, 2);
  R.info(`${label}: pages=${await pageCount(win)} dirty=${await isDirty(win)} title="${await win.title()}" undo="${u[0].label}"${u[0].disabled ? '(off)' : ''} redo="${u[1].label}"${u[1].disabled ? '(off)' : ''} log: ${recSteps()}`);
};
async function closeEverything() {
  for (let i = 0; i < 6; i++) {
    if ((await win.locator('.empty-state').count()) > 0) return;
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+Shift+w');
    await delay(500);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(500);
  }
}
const save = (ms = 20000) => toastAfter(win, () => win.keyboard.press('Control+s'), ms);

try {
  profile = newProfileDir();
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');

  await R.step('D1 threw', async () => {
    const a = mk('outline-6.pdf');
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    await delay(1000);
    await state('D1 after duplicate (+1 s)');
    R.check('D1 the recovery log is written after an edit', rec().some((f) => f.endsWith('.json')), rec().join(','));
    chmodSync(a.path, 0o444);
    await save();
    await delay(1000);
    await state('D1 after failed save (+1 s)');
    R.check('D1 the recovery log is still on disk after a failed save', rec().some((f) => f.endsWith('.json')), rec().join(','));
    await jumpTo(win, 2);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await delay(800);
    await state('D1 after rotate');
    await save();
    await jumpTo(win, 6);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 6);
    await save();
    await jumpTo(win, 0);
    await menu(win, 'Pages', 'Insert Blank Page…');
    await toastAfter(win, () => sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 7);
    await delay(600);
    await state('D1 after 3 failures + insert blank');
    R.check('D1 the log holds all four steps before the good save', /4 steps/.test(recSteps()), recSteps());
    await win.keyboard.press('Control+z');
    await waitForCount(win, 6);
    await state('D1 after Ctrl+Z');
    await win.keyboard.press('Control+z');
    await delay(800);
    const extra = (await toasts(win)).at(-1);
    R.check('D1 a second Ctrl+Z changes nothing and says why', (await pageCount(win)) === 6 && /can no longer be undone|Nothing to undo/.test(extra), extra);
    await win.keyboard.press('Control+y');
    await waitForCount(win, 7);
    chmodSync(a.path, 0o666);
    const ok = await save();
    await delay(800);
    await state('D1 after good save');
    const d = inspect(a.path);
    R.check('D1 disk has every edit: o1, blank, o1, o2 rotated 90, o3, o4, o5', brief(d) === '7p [o1,·,o1,o2/r90,o3,o4,o5]', `${ok} / ${brief(d)} outline ${JSON.stringify(d.outline)}`);
    R.check('D1 bookmarks follow their pages (Intro → page 4, Middle → page 6)', d.outline.find((o) => o.title === 'Intro')?.page === 4 && d.outline.find((o) => o.title === 'Middle')?.page === 6, JSON.stringify(d.outline));
    R.check('D1 after the good save: clean, log gone', !(await isDirty(win)) && rec().length === 0, `dirty=${await isDirty(win)} rec=${rec()}`);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await save();
    await delay(500);
    R.check('D1 a further edit and save reaches the disk', brief(inspect(a.path)) === '7p [o1/r90,·,o1,o2/r90,o3,o4,o5]', brief(inspect(a.path)));
  });
  await closeEverything();

  await R.step('D2 threw', async () => {
    // Outside change, immediate save.
    const a = mk('outline-6.pdf');
    await open(s, a.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    writeFileSync(a.path, readFileSync(fixture('mixed-sizes-rotated.pdf')));
    const t = await save();
    await delay(300);
    await state(`D2 right after "${t}"`);
    for (const wait of [1000, 3000, 4000]) {
      await delay(wait);
      const barsNow = await win.locator('.doc-bar').allInnerTexts();
      R.info(`D2 +${wait} ms: dirty=${await isDirty(win)} bars=${JSON.stringify(barsNow)} disk ${brief(inspect(a.path))}`);
    }
    R.check('D2 after saving over an outside change the document is clean and no "changed on disk" bar is left', !(await isDirty(win)) && (await win.locator('.doc-bar').count()) === 0, `dirty=${await isDirty(win)} bars=${JSON.stringify(await win.locator('.doc-bar').allInnerTexts())}`);
    await shot(win, 'd2-after-save-over-outside-change');
  });
  await closeEverything();

  await R.step('D3 threw', async () => {
    // Outside change, wait for the bar, Reload.
    const a = mk('outline-6.pdf');
    await open(s, a.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    writeFileSync(a.path, readFileSync(fixture('mixed-sizes-rotated.pdf')));
    const bar = win.locator('.doc-bar', { hasText: 'This file changed on disk' });
    await bar.waitFor({ timeout: 15000 });
    await bar.getByRole('button', { name: 'Reload' }).click();
    await waitForCount(win, 8);
    await delay(1500);
    await state('D3 after Reload (+1.5 s)');
    R.check('D3 Reload: 8 pages, clean, log gone, bar gone', (await pageCount(win)) === 8 && !(await isDirty(win)) && rec().length === 0 && (await win.locator('.doc-bar').count()) === 0, `dirty=${await isDirty(win)} rec=${rec()} bars=${JSON.stringify(await win.locator('.doc-bar').allInnerTexts())}`);
    await shot(win, 'd3-after-reload');
  });
  await closeEverything();

  await R.step('D4 threw', async () => {
    const big = mk('big-1000.pdf');
    const before = inspect(big.path);
    await open(s, big.path, 1000);
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 399, ['Shift']);
    await toastAfter(win, () => win.keyboard.press('Delete'), 60000);
    await waitFor(async () => (await pageCount(win)) === 600, { timeoutMs: 30000, label: '600 pages' });
    chmodSync(big.path, 0o444);
    await save(120000);
    await clickRowByIndex(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await clickRowByIndex(win, 599);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    chmodSync(big.path, 0o666);
    const ok = await save(120000);
    await delay(800);
    const d = inspect(big.path);
    const want = [...before.pages.slice(400).map((p) => p.text), before.pages[999].text];
    const rotated = d.pages.map((p, i) => (p.rotate ? `${i + 1}:r${p.rotate}` : null)).filter(Boolean);
    R.check('D4 1000 pages: delete 400, failed save, rotate page 1, duplicate the last, save: disk has 601 right pages', d.count === 601 && JSON.stringify(d.pages.map((p) => p.text)) === JSON.stringify(want) && rotated.join() === '1:r90' && !(await isDirty(win)), `${ok}; count ${d.count}; rotated ${rotated.join()}; dirty ${await isDirty(win)}`);
  });
  await closeEverything();
  R.check('no console or page errors', s.errors.filter((x) => !/favicon/.test(x)).length === 0, s.errors.join(' || ').slice(0, 900));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'a2-failure');
} finally {
  await closeAll();
  if (profile) cleanupProfile(profile);
  for (const c of copies) {
    try {
      for (const f of readdirSync(c.dir)) chmodSync(join(c.dir, f), 0o666);
    } catch { /* gone */ }
    removeCopy(c);
  }
  process.exitCode = R.summary() ? 1 : 0;
}
