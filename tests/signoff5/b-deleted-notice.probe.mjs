// Probe B: the bar "This file was moved, renamed or deleted. Save will create it again." (with Save, Save As… and Dismiss)
// after an open file is deleted, renamed or moved by another program, in the ways a person would do it: with and without
// unsaved edits, before and after a save, after Save As, Reload and Keep my version, in a background tab, in a restored tab,
// and with the window minimised. Since 1.5.5 D4 this is a bar under the tabs that stays, not a 4-second toast; the selectors
// are those of tests/e2e/save-recovery.e2e.mjs ("a file deleted by another program: a bar that stays").
import { renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  launch, closeAll, cleanupProfile, newProfileDir, waitFor, statusText, pageCount, delay, setSaveAnswer, isDirty, inspect, openMore,
  watchToasts, toastCount, toastsSince, waitToast, BLOCKED, barShown, dup, mk, wipeWork, sameBytes, outsideBytes, report,
  readFileSync, writeFileSync, existsSync,
} from './lib.mjs';

const R = report('b-deleted-notice');
const profile = newProfileDir();
let s;
let win;
// MISSING_FILE_MESSAGE in src/ui/documents/DocumentBars.tsx. The bar does not name the file; it is shown for the focused tab.
const MISSING_BAR = 'This file was moved, renamed or deleted. Save will create it again.';
const missingBar = () => win.locator('.doc-bar', { hasText: MISSING_BAR });
const barButton = (name) => missingBar().getByRole('button', { name, exact: true });
const missingShown = async () => (await missingBar().count()) > 0;
/** The bar's buttons that are there: Save, Save As… and Dismiss for a file that can be saved. */
async function barButtons() {
  const found = [];
  for (const name of ['Save', 'Save As…', 'Dismiss']) if ((await barButton(name).count()) === 1) found.push(name);
  return found;
}
/**
 * Runs `gone` (the outside delete/rename/move), then `show` (for example, switching to the tab whose file went), and waits for
 * the bar. Checks it is one status bar with its three buttons, that no toast says the same, and that the "changed on disk" bar
 * is not shown. Logs how long it took.
 */
async function expectNotice(label, name, gone, { timeoutMs = 14000, want = true, show = null } = {}) {
  const from = await toastCount(win);
  const t0 = Date.now();
  await gone();
  if (show) await show();
  let seen = null;
  try {
    await waitFor(missingShown, { timeoutMs, label: 'the bar' });
    seen = Date.now() - t0;
  } catch { /* not shown */ }
  await delay(600);
  const bars = await win.locator('.doc-bar[role="status"]', { hasText: MISSING_BAR }).count();
  const buttons = await barButtons();
  const toastsSeen = (await toastsSince(win, from)).filter((t) => t.includes('moved'));
  const changedBar = await barShown(win);
  const detail = `${name}: after ${seen} ms; bars=${bars}; buttons=${JSON.stringify(buttons)}; changed-on-disk bar=${changedBar}; toasts=${JSON.stringify(toastsSeen)}`;
  if (want) R.check(`${label}: the bar is shown, once, with Save, Save As… and Dismiss`, seen !== null && bars === 1 && buttons.length === 3 && toastsSeen.length === 0 && !changedBar, detail);
  else R.check(`${label}: no bar`, seen === null, detail);
  return seen;
}
const saved = async () => { const from = await toastCount(win); await win.keyboard.press('Control+s'); const t = await waitToast(win, from, /^Saved /, 20000); await delay(300); return t; };
async function closeEverything() {
  for (let i = 0; i < 8; i++) {
    if ((await win.getByRole('tab').count()) === 0) return;
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+Shift+w');
    await delay(400);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(400);
  }
}
let n = 0;
const fresh = async (pages = 6) => { const c = mk('outline-6.pdf', `doc${++n}.pdf`); await openMore(s, c.path, pages, 1); return c; };

try {
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');
  await watchToasts(win);

  await R.step('b1', async () => { const c = await fresh(); await expectNotice('b1 open, no edits, delete', c.name, () => unlinkSync(c.path)); });
  await closeEverything();
  await R.step('b2', async () => {
    const c = await fresh();
    await dup(win);
    await expectNotice('b2 open, unsaved edit, delete', c.name, () => unlinkSync(c.path));
    R.check('b2 the unsaved edit is still there', (await pageCount(win)) === 7 && (await isDirty(win)));
    // Dismiss hides the bar; it stays hidden while the file stays gone, and the edit stays open.
    await barButton('Dismiss').click();
    await delay(7000);
    R.check('b2 Dismiss hides the bar, and it stays hidden while the file is gone', !(await missingShown()) && (await isDirty(win)) && !existsSync(c.path));
  });
  await closeEverything();
  await R.step('b3', async () => { const c = await fresh(); await dup(win); await saved(); await expectNotice('b3 open, edit, save, delete right away', c.name, () => unlinkSync(c.path)); });
  await closeEverything();
  await R.step('b4', async () => { const c = await fresh(); await expectNotice('b4 open, rename outside', c.name, () => renameSync(c.path, join(c.dir, 'renamed.pdf'))); });
  await closeEverything();
  await R.step('b5', async () => { const c = await fresh(); const to = join(c.dir, 'elsewhere'); mkdirSync(to); await expectNotice('b5 open, move to another folder', c.name, () => renameSync(c.path, join(to, c.name))); });
  await closeEverything();
  await R.step('b6', async () => {
    const c = await fresh();
    await dup(win); await saved(); await dup(win);
    await expectNotice('b6 edit, save, edit again, rename outside', c.name, () => renameSync(c.path, join(c.dir, 'renamed.pdf')));
    const t = await saved();
    R.check('b6 Ctrl+S creates the file again with my 8 pages', !!t && existsSync(c.path) && inspect(c.path, undefined, { text: false }).count === 8, `toast=${JSON.stringify(t)}`);
    R.check('b6 the bar goes after that save', !(await missingShown()));
    await delay(5600);
    await expectNotice('b6 deleted a second time after that save', c.name, () => unlinkSync(c.path));
  });
  await closeEverything();
  await R.step('b7', async () => { const c = mk('outline-6.pdf', `doc${++n}.pdf`); await s.setDialogAnswer([c.path]); await win.keyboard.press('Control+o'); await waitFor(async () => (await statusText(win)).startsWith('Page 1 of 6'), { timeoutMs: 20000, label: 'open' }); await expectNotice('b7 deleted in the first moment after opening', c.name, () => unlinkSync(c.path)); });
  await closeEverything();
  await R.step('b8', async () => {
    const back = await fresh();
    const front = mk('mixed-sizes-rotated.pdf', 'front.pdf');
    await openMore(s, front.path, 8, 2);
    // The bar belongs to the focused tab: none on the front tab, and the bar on the background tab once it is chosen.
    unlinkSync(back.path);
    await delay(7000);
    R.check('b8 no bar on the front tab when the file of a background tab is deleted', !(await missingShown()));
    await expectNotice('b8 the file of a background tab is deleted, then its tab is chosen', back.name, async () => undefined, {
      show: () => win.getByRole('tab', { name: back.name, exact: true }).click(),
    });
  });
  await closeEverything();
  await R.step('b9', async () => {
    const c = await fresh();
    await dup(win);
    const b = join(c.dir, 'saved-as.pdf');
    await setSaveAnswer(s, b);
    const from = await toastCount(win);
    await win.keyboard.press('Control+Shift+s');
    await waitToast(win, from, /^Saved /, 20000);
    await expectNotice('b9 after Save As, the ORIGINAL file is deleted', c.name, () => unlinkSync(c.path), { want: false, timeoutMs: 7000 });
    await expectNotice('b9 after Save As, the new file is deleted', 'saved-as.pdf', () => unlinkSync(b));
  });
  await closeEverything();
  await R.step('b10', async () => {
    const c = await fresh();
    writeFileSync(c.path, outsideBytes('b10'));
    await waitFor(() => barShown(win), { timeoutMs: 15000, label: 'changed-on-disk bar' });
    await win.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitFor(async () => (await pageCount(win)) === 8, { timeoutMs: 15000, label: 'reloaded' });
    await delay(800);
    await expectNotice('b10 after Reload, delete', c.name, () => unlinkSync(c.path));
  });
  await closeEverything();
  await R.step('b11', async () => {
    const c = await fresh();
    await dup(win);
    writeFileSync(c.path, outsideBytes('b11'));
    await waitFor(() => barShown(win), { timeoutMs: 15000, label: 'changed-on-disk bar' });
    await win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await delay(800);
    await expectNotice('b11 after Keep my version, delete', c.name, () => unlinkSync(c.path));
    const t = await saved();
    R.check('b11 Ctrl+S then creates the file with my 7 pages', !!t && existsSync(c.path) && inspect(c.path, undefined, { text: false }).count === 7, `toast=${JSON.stringify(t)}`);
  });
  await closeEverything();
  await R.step('b12', async () => {
    const c = await fresh();
    const bytes = readFileSync(c.path);
    await expectNotice('b12 delete', c.name, () => unlinkSync(c.path));
    writeFileSync(c.path, bytes); // put back (a new modified time)
    await delay(6500);
    R.check('b12 the bar goes when the file is back in its place', !(await missingShown()));
    R.info(`b12 after the file was put back: "changed on disk" bar=${await barShown(win)}`);
    await expectNotice('b12 put back, then deleted again', c.name, () => unlinkSync(c.path));
  });
  await closeEverything();
  await R.step('b13', async () => { const c = await fresh(); await expectNotice('b13 the folder is renamed', c.name, () => renameSync(c.dir, `${c.dir}-moved`)); });
  await closeEverything();
  await R.step('b15', async () => {
    const c = await fresh();
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await delay(1000);
    const seen = await expectNotice('b15 window minimised, delete', c.name, () => unlinkSync(c.path), { timeoutMs: 20000 });
    await delay(Math.max(0, 9000 - (seen ?? 0)));
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.showInactive());
    await delay(2500);
    R.check('b15 window shown again about 9 s after the delete: the bar is still on screen', await missingShown());
  });
  await closeEverything();

  // ---- a tab restored from the last session
  const e = mk('outline-6.pdf', 'restored.pdf');
  await openMore(s, e.path, 6, 1);
  await delay(1500);
  await s.close();
  s = await launch({ profile });
  win = s.win;
  await R.step('b14', async () => {
    await waitFor(async () => (await statusText(win)).startsWith('Page 1 of 6'), { timeoutMs: 30000, label: 'restored tab' });
    await watchToasts(win);
    await expectNotice('b14 tab restored from the last session, delete', 'restored.pdf', () => unlinkSync(e.path));
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
