// Probe B (gap 1 x gap 2): a failed save, then closing: the tab, all tabs, the window, File > Exit; each of Save / Don't save /
// Cancel; and a crash after a failed save, with Keep and with Discard. The real close prompt is on (PDFSUITE_E2E_PROMPTS=1)
// and every prompt is answered.
import { join } from 'node:path';
import { readFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import {
  copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, waitFor, delay, newProfileDir, cleanupProfile, closeAll,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspect, brief, toasts, isDirty, uids, plainEnglish,
  start, kill, promptText, watchClose, answer, waitGone, endCleanly, statusText, showPanel,
} from './lib.mjs';

const R = makeReport('b-failed-save-then-close');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
const profiles = [];
let x;
const recOf = (profile) => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : []);
const save = (win) => toastAfter(win, () => win.keyboard.press('Control+s'));
const tabs = (win) => win.getByRole('tab').count();
/** Duplicate page 1, then a save that fails because the file is read-only. Leaves the file read-only. */
async function editAndFail(win, path) {
  await jumpTo(win, 0);
  await toastAfter(win, () => win.keyboard.press('Control+d'));
  await waitForCount(win, 7);
  chmodSync(path, 0o444);
  return save(win);
}
async function freshApp() {
  const profile = newProfileDir();
  profiles.push(profile);
  x = await start({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
  await x.win.waitForSelector('.empty-state');
  return profile;
}

try {
  // ---------- B1..B3: tab closes, in one session
  let profile = await freshApp();
  let win = x.win;
  await R.step('B1 threw', async () => {
    const a = mk('outline-6.pdf');
    const original = readFileSync(a.path);
    await open(x, a.path, 6);
    await watchToasts(win);
    await editAndFail(win, a.path);
    await win.keyboard.press('Control+w');
    await delay(600);
    const p1 = await promptText(x);
    R.check('B1 Ctrl+W after a failed save asks Save / Don\'t save / Cancel', /Save changes to outline-6\.pdf before closing\?/.test(p1) && /Save Don't save Cancel/.test(p1), p1);
    const t = await toastAfter(win, () => answer(x, 'Save'));
    await delay(600);
    R.check('B1 Save in the prompt while the file is still read-only: plain failure, the tab stays open with the 7 pages, unsaved', /could not be saved/.test(t) && plainEnglish(t) && (await tabs(win)) === 1 && (await pageCount(win)) === 7 && (await isDirty(win)) && readFileSync(a.path).equals(original) && !(await promptText(x)), `${t} tabs=${await tabs(win)} pages=${await pageCount(win)} dirty=${await isDirty(win)}`);
    await win.keyboard.press('Control+w');
    await delay(600);
    R.check('B1 the prompt comes again on the next Ctrl+W', !!(await promptText(x)), await promptText(x));
    await answer(x, 'Cancel');
    await delay(400);
    R.check('B1 Cancel keeps the tab and the edit', (await tabs(win)) === 1 && (await pageCount(win)) === 7 && (await isDirty(win)));
    await win.keyboard.press('Control+w');
    await delay(600);
    await win.keyboard.press('Escape');
    await delay(400);
    R.check('B1 Esc on the prompt is Cancel', !(await promptText(x)) && (await tabs(win)) === 1 && (await isDirty(win)));
    chmodSync(a.path, 0o666);
    await win.keyboard.press('Control+w');
    await delay(600);
    await answer(x, 'Save');
    await win.waitForSelector('.empty-state', { timeout: 10000 });
    await delay(400);
    const d = inspect(a.path);
    R.check('B1 Save in the prompt once the file is writable: file has the 7 pages, tab closed, log gone', brief(d) === '7p [o1,o1,o2,o3,o4,o5,o6]' && recOf(profile).length === 0, `${brief(d)} rec=${recOf(profile)}`);
  });

  await R.step('B2 threw', async () => {
    // Three failures with edits between and an undo, then Close All > Don't save.
    const a = mk('outline-6.pdf');
    const original = readFileSync(a.path);
    await open(x, a.path, 6);
    await editAndFail(win, a.path);
    await jumpTo(win, 2);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await save(win);
    await jumpTo(win, 6);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 6);
    await save(win);
    await jumpTo(win, 0);
    await menu(win, 'Pages', 'Insert Blank Page…');
    await toastAfter(win, () => sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 7);
    await win.keyboard.press('Control+z');
    await waitForCount(win, 6);
    await delay(600);
    R.info(`B2 before closing: tabs=${await tabs(win)} pages=${await pageCount(win)} dirty=${await isDirty(win)} rec=${recOf(profile)}`);
    await menu(win, 'File', 'Close All');
    await delay(600);
    const p = await promptText(x);
    R.check('B2 Close All after failed saves asks', /Save changes to outline-6\.pdf/.test(p), p);
    await answer(x, "Don't save");
    await delay(1200);
    const closed = (await win.locator('.empty-state').count()) > 0;
    R.check('B2 Don\'t save: the tab closes, the file is untouched, the recovery log is removed', closed && readFileSync(a.path).equals(original) && recOf(profile).length === 0, `closed=${closed} tabs=${await tabs(win)} rec=${recOf(profile)}`);
    if (!closed) await shot(win, 'b2-not-closed');
    chmodSync(a.path, 0o666);
    // The same file again: it must open as it is on disk, with nothing "recovered", and work.
    await open(x, a.path, 6);
    await delay(800);
    const recovered = await win.locator('.doc-bar').allInnerTexts();
    R.check('B2 reopening the file: 6 pages, clean, no recovered bar', (await pageCount(win)) === 6 && !(await isDirty(win)) && recovered.length === 0, JSON.stringify(recovered));
    await jumpTo(win, 5);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+L'));
    const t = await save(win);
    await delay(500);
    const d = inspect(a.path);
    R.check('B2 an edit and save on the reopened file works first time', /^Saved/.test(t) && brief(d) === '6p [o1,o2,o3,o4,o5,o6/r270]' && !(await isDirty(win)), `${t} / ${brief(d)}`);
    await win.keyboard.press('Control+w');
    await win.waitForSelector('.empty-state', { timeout: 10000 });
  });

  await R.step('B3 threw', async () => {
    // Two documents with failed saves, one clean document: Close All > Save with one file still read-only.
    const a = mk('outline-6.pdf');
    const b = mk('outline-6.pdf');
    const c = mk('mixed-sizes-rotated.pdf');
    await open(x, a.path, 6);
    await editAndFail(win, a.path);
    await x.setDialogAnswer([b.path]);
    await win.keyboard.press('Control+o');
    await waitFor(async () => (await tabs(win)) === 2 && (await pageCount(win)) === 6, { timeoutMs: 20000, label: 'second tab' });
    await showPanel(win, 'Thumbnails');
    await editAndFail(win, b.path);
    await x.setDialogAnswer([c.path]);
    await win.keyboard.press('Control+o');
    await waitFor(async () => (await tabs(win)) === 3 && (await pageCount(win)) === 8, { timeoutMs: 20000, label: 'third tab' });
    chmodSync(a.path, 0o666); // a can be saved now, b cannot
    const bBytes = readFileSync(b.path);
    await menu(win, 'File', 'Close All');
    await delay(700);
    const p = await promptText(x);
    R.check('B3 Close All with two unsaved files asks about both', /Save changes to 2 files before closing\?/.test(p), p);
    const n = (await toasts(win)).length;
    await answer(x, 'Save');
    await delay(2500);
    const newToasts = (await toasts(win)).slice(n);
    const da = inspect(a.path);
    R.info(`B3 after Save: toasts ${JSON.stringify(newToasts)} tabs=${await tabs(win)} disk a ${brief(da)}`);
    R.check('B3 Save: the writable file is saved, the read-only one fails in plain words, and nothing is closed', brief(da) === '7p [o1,o1,o2,o3,o4,o5,o6]' && newToasts.some((t) => /could not be saved/.test(t)) && newToasts.every(plainEnglish) && (await tabs(win)) === 3 && readFileSync(b.path).equals(bBytes), `tabs=${await tabs(win)}`);
    // The unsaved one is still unsaved, and still there.
    await win.getByRole('tab').nth(1).click();
    await delay(500);
    R.check('B3 the file that could not be saved is still open with its 7 pages, unsaved', (await pageCount(win)) === 7 && (await isDirty(win)), `pages=${await pageCount(win)}`);
    chmodSync(b.path, 0o666);
    await menu(win, 'File', 'Close All');
    await delay(700);
    const p2 = await promptText(x);
    R.check('B3 Close All again asks about the one file left', /Save changes to outline-6\.pdf before closing\?/.test(p2), p2);
    await answer(x, 'Save');
    await win.waitForSelector('.empty-state', { timeout: 10000 });
    await delay(400);
    R.check('B3 second Save: file b has its 7 pages; all tabs closed; no logs left', brief(inspect(b.path)) === '7p [o1,o1,o2,o3,o4,o5,o6]' && recOf(profile).length === 0, `${brief(inspect(b.path))} rec=${recOf(profile)}`);
  });

  // ---------- B4: the window, same session
  await R.step('B4 threw', async () => {
    const a = mk('outline-6.pdf');
    const original = readFileSync(a.path);
    await open(x, a.path, 6);
    await editAndFail(win, a.path);
    void x.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }).catch(() => undefined);
    const seen = await watchClose(x);
    R.check('B4 closing the window after a failed save asks', !!seen.prompt && !seen.exited, JSON.stringify(seen));
    const t = await toastAfter(win, () => answer(x, 'Save'));
    await delay(1500);
    R.check('B4 Save while still read-only: the app stays open, the edit stays, the reason is said', !x.gone && /could not be saved/.test(t) && (await pageCount(win)) === 7 && (await isDirty(win)) && readFileSync(a.path).equals(original), t);
    await menu(win, 'File', 'Exit');
    const seen2 = await watchClose(x);
    R.check('B4 File > Exit afterwards asks again', !!seen2.prompt && !seen2.exited, JSON.stringify(seen2));
    chmodSync(a.path, 0o666);
    await answer(x, 'Save');
    const gone = await waitGone(x, 15000);
    const d = inspect(a.path);
    R.check('B4 Save once writable: the file has the 7 pages and the app exits', gone && brief(d) === '7p [o1,o1,o2,o3,o4,o5,o6]', `gone=${gone} ${brief(d)}`);
  });
  await endCleanly(x);

  // ---------- B5: failed save, more edits, an undo, then a crash; Keep; Save
  await R.step('B5 threw', async () => {
    profile = await freshApp();
    win = x.win;
    const a = mk('outline-6.pdf');
    const original = readFileSync(a.path);
    await open(x, a.path, 6);
    await watchToasts(win);
    await editAndFail(win, a.path); // 7: o1 o1 o2..o6
    await jumpTo(win, 2);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R')); // o2 r90
    await save(win); // fails again
    await jumpTo(win, 6);
    await toastAfter(win, () => win.keyboard.press('Delete')); // o6 gone -> 6
    await waitForCount(win, 6);
    await jumpTo(win, 3);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+L')); // o3 r270
    await win.keyboard.press('Control+z'); // undone
    await delay(1500);
    const before = await uids(win);
    chmodSync(a.path, 0o666);
    await kill(x);
    R.check('B5 crash after failed saves: the file is untouched and the log is on disk', readFileSync(a.path).equals(original) && recOf(profile).some((f) => f.endsWith('.json')), recOf(profile).join(','));
    x = await start({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
    win = x.win;
    await waitFor(async () => /Page \d+ of \d+/.test(await statusText(win)), { timeoutMs: 20000, label: 'a restored tab' });
    const bar = win.locator('.doc-bar', { hasText: 'Recovered unsaved edits' });
    await bar.waitFor({ timeout: 15000 });
    await showPanel(win, 'Thumbnails');
    await watchToasts(win);
    const after = await uids(win);
    R.info(`B5 restart: bar "${(await bar.innerText()).replace(/\s+/g, ' ')}" pages=${await pageCount(win)} uids ${after.join(',')} (before the crash ${before.join(',')}) dirty=${await isDirty(win)}`);
    R.check('B5 the restart brings back exactly the pages from before the crash (the undone step stays undone)', (await pageCount(win)) === 6 && after.join() === before.join() && (await isDirty(win)), `${after.join(',')} vs ${before.join(',')}`);
    await bar.getByRole('button', { name: 'Keep' }).click();
    const t = await save(win);
    await delay(600);
    const d = inspect(a.path);
    R.check('B5 Keep + Save writes them: o1, o1, o2 rotated, o3, o4, o5', /^Saved/.test(t) && brief(d) === '6p [o1,o1,o2/r90,o3,o4,o5]' && !(await isDirty(win)) && recOf(profile).length === 0, `${t} / ${brief(d)} rec=${recOf(profile)}`);
    await menu(win, 'File', 'Exit');
    R.check('B5 Exit with nothing unsaved quits at once', await waitGone(x, 10000));
  });
  await endCleanly(x);

  // ---------- B6: failed save, crash, Discard
  await R.step('B6 threw', async () => {
    profile = await freshApp();
    win = x.win;
    const a = mk('mixed-sizes-rotated.pdf');
    const original = readFileSync(a.path);
    await open(x, a.path, 8);
    await watchToasts(win);
    await jumpTo(win, 3);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 7);
    chmodSync(a.path, 0o444);
    await save(win);
    chmodSync(a.path, 0o666);
    await delay(1200);
    await kill(x);
    x = await start({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
    win = x.win;
    await waitFor(async () => /Page \d+ of \d+/.test(await statusText(win)), { timeoutMs: 20000, label: 'a restored tab' });
    const bar = win.locator('.doc-bar', { hasText: 'Recovered unsaved edits' });
    await bar.waitFor({ timeout: 15000 });
    R.check('B6 restart after fail + crash: 7 pages recovered', (await pageCount(win)) === 7 && (await isDirty(win)));
    await bar.getByRole('button', { name: 'Discard' }).click();
    await waitFor(async () => (await pageCount(win)) === 8, { timeoutMs: 10000, label: '8 pages' });
    await delay(800);
    R.check('B6 Discard: 8 pages, clean, file untouched, log gone', !(await isDirty(win)) && readFileSync(a.path).equals(original) && recOf(profile).length === 0, `dirty=${await isDirty(win)} rec=${recOf(profile)}`);
    await menu(win, 'File', 'Exit');
    R.check('B6 Exit after Discard quits without asking', await waitGone(x, 10000));
  });
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (x && !x.gone) await shot(x.win, 'b-failure');
} finally {
  await endCleanly(x).catch(() => undefined);
  await closeAll();
  for (const p of profiles) cleanupProfile(p);
  for (const c of copies) {
    try {
      for (const f of readdirSync(c.dir)) chmodSync(join(c.dir, f), 0o666);
    } catch { /* gone */ }
    removeCopy(c);
  }
  process.exitCode = R.summary() ? 1 : 0;
}
