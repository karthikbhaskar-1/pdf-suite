// Probe D: crash and recover (Keep, a second crash, Discard), recovery refused after the file changed, a file changed on
// disk by another program while open (Keep my version / Reload), and the close prompt (Cancel / Don't save / Save).
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, utimesSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitForCount, pageCount, fixture, waitFor, delay, newProfileDir, forceKill, cleanupProfile,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspectMupdf, plainEnglish, toasts, bars, isDirty, snapshot, showPanel, statusText,
} from './lib.mjs';

const R = makeReport('d-crash-disk-close');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
const noErrors = (label) => R.check(`${label}: no console errors`, s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
const bar = (win, text) => win.locator('.doc-bar', { hasText: text });
async function restored(s, pages) {
  await waitFor(async () => (await statusText(s.win)).includes(`of ${pages}`), { timeoutMs: 30000, label: `restored tab with ${pages} pages` });
  await showPanel(s.win, 'Thumbnails');
  await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
  await watchToasts(s.win);
}

try {
  // ---------- Crash and recover
  const a = mk('outline-6.pdf');
  const original = readFileSync(a.path);
  const profile = newProfileDir();
  s = await launch({ profile });
  await s.win.waitForSelector('.empty-state');
  await open(s, a.path, 6);
  await watchToasts(s.win);
  const snap0 = await snapshot(s.win);
  await jumpTo(s.win, 0);
  await toastAfter(s.win, () => s.win.keyboard.press('Delete'));
  await jumpTo(s.win, 1);
  await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
  await menu(s.win, 'Pages', 'Insert from PDF…');
  let d = sheet(s.win, 'Insert from a PDF');
  const src = mk('mixed-sizes-rotated.pdf');
  await s.setDialogAnswer([src.path]);
  await d.getByRole('button', { name: 'Browse for a PDF…' }).click();
  await d.getByText('mixed-sizes-rotated.pdf, 8 pages').waitFor({ timeout: 15000 });
  await d.getByRole('textbox', { name: 'Page range' }).fill('4-5');
  await toastAfter(s.win, () => d.getByRole('button', { name: 'Apply' }).click());
  await waitForCount(s.win, 7);
  // One more edit, undone: an undone step must not come back after the crash.
  await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
  await waitForCount(s.win, 8);
  await s.win.keyboard.press('Control+z');
  await waitForCount(s.win, 7);
  const snapEdited = await snapshot(s.win);
  await delay(1500);
  await forceKill(s.app);
  // The source of the inserted pages disappears before the restart: recovery must not depend on it.
  removeCopy(src);
  R.check('crash: the file on disk is untouched', readFileSync(a.path).equals(original));

  s = await launch({ profile });
  await R.step('after a crash: tab restored with the 3 unsaved edits, marked unsaved, bar shown', async () => {
    await restored(s, 7);
    await bar(s.win, 'Recovered unsaved edits').waitFor({ timeout: 15000 });
    const text = await bar(s.win, 'Recovered unsaved edits').innerText();
    R.check('recovery bar text and buttons', /Recovered unsaved edits \(3\)\./.test(text) && /Keep/.test(text) && /Discard/.test(text), text);
    R.check('recovered state equals the state before the crash', (await snapshot(s.win)) === snapEdited, `\n have ${await snapshot(s.win)}\n want ${snapEdited}`);
    R.check('recovered document is marked unsaved', await isDirty(s.win));
    await shot(s.win, 'd-recovered');
  });
  await R.step('recovered edits can be undone one by one, and redone', async () => {
    for (let i = 0; i < 3; i++) await s.win.keyboard.press('Control+z'), await delay(500);
    await waitFor(async () => (await snapshot(s.win)) === snap0, { timeoutMs: 10000, label: 'undo back to the saved file' });
    R.check('undo x3 after recovery gives the file as saved', true);
    for (let i = 0; i < 3; i++) await s.win.keyboard.press('Control+y'), await delay(500);
    await waitFor(async () => (await snapshot(s.win)) === snapEdited, { timeoutMs: 10000, label: 'redo to the recovered state' });
    R.check('redo x3 returns to the recovered state', true);
  });
  await R.step('Keep, then a second crash: the edits are recovered again', async () => {
    await bar(s.win, 'Recovered unsaved edits').getByRole('button', { name: 'Keep' }).click();
    await waitFor(async () => (await bar(s.win, 'Recovered unsaved edits').count()) === 0, { timeoutMs: 5000, label: 'bar gone' });
    await delay(1200);
    await forceKill(s.app);
    s = await launch({ profile });
    await restored(s, 7);
    await bar(s.win, 'Recovered unsaved edits').waitFor({ timeout: 15000 });
    R.check('second crash: same state recovered', (await snapshot(s.win)) === snapEdited);
  });
  await R.step('Discard: back to the file as saved, clean, file untouched', async () => {
    await bar(s.win, 'Recovered unsaved edits').getByRole('button', { name: 'Discard' }).click();
    await waitFor(async () => (await pageCount(s.win)) === 6, { timeoutMs: 15000, label: '6 pages again' });
    await waitFor(async () => (await snapshot(s.win)) === snap0, { timeoutMs: 10000, label: 'original state' });
    R.check('after Discard: not marked unsaved, bar gone', !(await isDirty(s.win)) && (await bar(s.win, 'Recovered').count()) === 0);
    R.check('after Discard: file on disk still byte-identical', readFileSync(a.path).equals(original));
  });
  await R.step('crash after Discard: nothing comes back', async () => {
    await delay(800);
    await forceKill(s.app);
    s = await launch({ profile });
    await restored(s, 6);
    await delay(1500);
    R.check('no recovery bar after a discarded recovery', (await bar(s.win, 'Recovered').count()) === 0 && !(await isDirty(s.win)));
  });

  // ---------- Crash, then the file changes on disk before the restart
  await R.step('crash, file changed by another program, restart: edits not replayed, user is told', async () => {
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Delete'));
    await waitForCount(s.win, 5);
    await delay(1200);
    await forceKill(s.app);
    copyFileSync(fixture('annotated-links.pdf'), a.path); // another program replaces the file: 4 pages now
    s = await launch({ profile });
    await restored(s, 4);
    await delay(2500);
    const t = (await toasts(s.win)).join(' | ');
    R.check('told that the edits were not restored', /were not restored: the file changed on disk/.test(t), t);
    R.check('shows the file as it is on disk (4 pages), clean', (await pageCount(s.win)) === 4 && !(await isDirty(s.win)));
    R.check('messages are plain English', (await toasts(s.win)).every(plainEnglish));
  });
  noErrors('crash part');

  // ---------- File changed on disk while open
  await R.step('file changed on disk while open with unsaved edits: bar, Keep my version, save writes mine', async () => {
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    await waitForCount(s.win, 5);
    copyFileSync(fixture('outline-6.pdf'), a.path);
    await bar(s.win, 'This file changed on disk.').waitFor({ timeout: 15000 });
    const text = await bar(s.win, 'This file changed on disk.').innerText();
    R.check('changed-on-disk bar offers Reload and Keep my version', /Reload/.test(text) && /Keep my version/.test(text), text);
    R.check('my edits are still there while the bar shows', (await pageCount(s.win)) === 5 && (await isDirty(s.win)));
    await bar(s.win, 'This file changed on disk.').getByRole('button', { name: 'Keep my version' }).click();
    await waitFor(async () => (await bar(s.win, 'This file changed on disk.').count()) === 0, { timeoutMs: 5000, label: 'bar gone' });
    const t = await toastAfter(s.win, () => s.win.keyboard.press('Control+s'));
    const disk = inspectMupdf(a.path);
    R.check('save after Keep my version writes my 5 pages', /Saved/.test(t) && disk.ok && disk.count === 5 && /Annotated page 1/.test(disk.pages[0].text), `${t} count ${disk.count} first "${disk.pages[0]?.text}"`);
    R.check('annotations and links survived duplicate + save (4 per page: note, popup, highlight, link)', disk.pages.every((p) => p.annots === 4), JSON.stringify(disk.pages.map((p) => p.annots)));
  });
  await R.step('second outside change: bar again, Reload shows the new file and drops my edits', async () => {
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
    await delay(1100); // a later modified time
    copyFileSync(fixture('outline-6.pdf'), a.path);
    await bar(s.win, 'This file changed on disk.').waitFor({ timeout: 15000 });
    await bar(s.win, 'This file changed on disk.').getByRole('button', { name: 'Reload' }).click();
    await waitFor(async () => (await pageCount(s.win)) === 6, { timeoutMs: 15000, label: 'reloaded 6 pages' });
    await delay(500);
    R.check('after Reload: 6 pages, clean, bar gone', !(await isDirty(s.win)) && (await bar(s.win, 'This file changed').count()) === 0);
    R.check('after Reload: file on disk is the other program\'s version', readFileSync(a.path).equals(readFileSync(fixture('outline-6.pdf'))));
    const edits = await menuItems(s.win, 'Edit');
    R.check('after Reload: nothing to undo', edits[0].disabled, edits[0].label);
  });
  await R.step('outside change with NO unsaved edits, then an edit and Ctrl+S without answering the bar', async () => {
    await delay(1100);
    copyFileSync(fixture('annotated-links.pdf'), a.path);
    await bar(s.win, 'This file changed on disk.').waitFor({ timeout: 15000 });
    // The user ignores the bar, edits the stale 6-page view and saves. What lands on disk?
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    const t = await toastAfter(s.win, () => s.win.keyboard.press('Control+s'));
    const disk = inspectMupdf(a.path);
    R.info(`ignored bar + save: toast "${t}", disk count ${disk.count}, first "${disk.pages[0]?.text}", bar still shown: ${(await bar(s.win, 'This file changed').count()) > 0}`);
    R.check('ignored bar + save: the file on disk is a valid PDF', disk.ok && disk.eof);
  });
  noErrors('disk-change part');
  await s.close();
  cleanupProfile(profile);

  // ---------- Close prompt (prompts on; every prompt is answered before teardown)
  const c = mk('outline-6.pdf');
  const cOriginal = readFileSync(c.path);
  const profile2 = newProfileDir();
  s = await launch({ profile: profile2, env: { PDFSUITE_E2E_PROMPTS: '1' } });
  await s.win.waitForSelector('.empty-state');
  await open(s, c.path, 6);
  await watchToasts(s.win);
  const prompt = s.win.getByRole('alertdialog');
  await R.step('close tab with unsaved changes: prompt; Cancel keeps everything', async () => {
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Delete'));
    await s.win.keyboard.press('Control+w');
    await prompt.waitFor({ timeout: 5000 });
    const text = await prompt.innerText();
    R.check('prompt wording', /Save changes to outline-6\.pdf before closing\?/.test(text) && /Save/.test(text) && /Don't save/.test(text) && /Cancel/.test(text), text.replace(/\n/g, ' / '));
    await s.win.keyboard.press('Escape');
    await waitFor(async () => (await prompt.count()) === 0, { timeoutMs: 5000, label: 'prompt closed by Esc' });
    R.check('Esc = Cancel: tab still open with 5 pages, unsaved', (await pageCount(s.win)) === 5 && (await isDirty(s.win)));
  });
  await R.step('close tab ▸ Don\'t save: tab closes, file untouched, nothing recovered next time', async () => {
    await s.win.locator('.tab-close').first().click();
    await prompt.waitFor({ timeout: 5000 });
    await prompt.getByRole('button', { name: "Don't save" }).click();
    await s.win.waitForSelector('.empty-state', { timeout: 10000 });
    R.check('file untouched after Don\'t save', readFileSync(c.path).equals(cOriginal));
    await open(s, c.path, 6);
    await delay(1500);
    R.check('reopened: no recovery bar, clean, 6 pages', (await bar(s.win, 'Recovered').count()) === 0 && !(await isDirty(s.win)) && (await pageCount(s.win)) === 6);
  });
  await R.step('close tab ▸ Save: saved to disk, tab closes', async () => {
    await jumpTo(s.win, 5);
    await toastAfter(s.win, () => s.win.keyboard.press('Delete'));
    await s.win.keyboard.press('Control+w');
    await prompt.waitFor({ timeout: 5000 });
    await prompt.getByRole('button', { name: 'Save', exact: true }).click();
    await s.win.waitForSelector('.empty-state', { timeout: 15000 });
    const disk = inspectMupdf(c.path);
    R.check('Save in the prompt wrote 5 pages', disk.ok && disk.count === 5 && disk.pages.at(-1).text === 'Outline page 5', `count ${disk.count}`);
  });
  await R.step('window close with unsaved changes in two files: one prompt for both; Don\'t save quits', async () => {
    const c2 = mk('mixed-sizes-rotated.pdf');
    await open(s, c.path, 5);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    await open(s, c2.path, 8);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    const before1 = readFileSync(c.path);
    const before2 = readFileSync(c2.path);
    // Ask the window to close the way the X button does.
    void s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await prompt.waitFor({ timeout: 5000 });
    const text = await prompt.innerText();
    R.check('prompt names both files', /Save changes to 2 files before closing\?/.test(text), text.replace(/\n/g, ' / '));
    const exited = new Promise((res) => s.app.process().once('exit', res));
    await prompt.getByRole('button', { name: "Don't save" }).click();
    await Promise.race([exited, delay(15000)]);
    R.check('app quit after Don\'t save', s.app.process().exitCode !== null, `exitCode ${s.app.process().exitCode}`);
    R.check('both files untouched', readFileSync(c.path).equals(before1) && readFileSync(c2.path).equals(before2));
    const rec = join(profile2, 'recovery');
    const left = existsSync(rec) ? readdirSync(rec) : [];
    R.check('recovery logs removed after Don\'t save', left.length === 0, left.join(','));
  });
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'd-failure');
  // A prompt must never be left: answer one if it is up.
  try {
    const p = s.win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save" }).click();
  } catch { /* the window may be gone */ }
} finally {
  if (s) {
    try {
      await forceKill(s.app);
    } catch { /* already gone */ }
  }
  await closeAll();
  for (const c of copies) removeCopy(c);
  process.exitCode = R.summary() ? 1 : 0;
}
