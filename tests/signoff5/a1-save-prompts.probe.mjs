// Probe A1: the save-time disk check through entry points and close paths the matrix does not walk:
// a file opened from the command line, Save As onto the document's own path, delete+recreate, rename, Ctrl+W > Save,
// Close All > Save with two unsaved documents, and window close > Save. The bytes on disk are re-read after every step.
import { renameSync, unlinkSync } from 'node:fs';
import {
  start, endCleanly, cleanupProfile, newProfileDir, waitFor, statusText, pageCount, delay, showPanel, setSaveAnswer, isDirty, inspect, openMore,
  watchToasts, toastCount, toastsSince, waitToast, BLOCKED, barShown, dup, mk, wipeWork, sha, sameBytes, outsideBytes, report, promptText, answer, watchClose, waitGone,
  readFileSync, writeFileSync, existsSync,
} from './lib.mjs';

const R = report('a1-save-prompts');
const profile = newProfileDir();
let x;
const pagesOn = (p) => { try { return inspect(p, undefined, { text: false }).count; } catch (e) { return `unreadable (${e.message})`; } };
const keep = async (win) => { await win.getByRole('button', { name: 'Keep my version', exact: true }).click(); await waitFor(async () => !(await barShown(win)), { timeoutMs: 8000, label: 'bar gone' }); };
/** Ctrl+S that must be blocked: the toast, the bar, and the other program's bytes still on disk 1.2 s later. */
async function expectBlocked(win, label, path, buf, press = () => win.keyboard.press('Control+s')) {
  const from = await toastCount(win);
  await press();
  const t = await waitToast(win, from, BLOCKED, 10000);
  await delay(1200);
  const same = sameBytes(path, buf);
  R.check(`${label}: nothing written, the other program's bytes are still on disk`, same, `disk sha ${existsSync(path) ? sha(path) : 'MISSING'} outside sha ${sha(buf)} pages on disk ${pagesOn(path)}`);
  R.check(`${label}: the user is told (toast) and the choice bar is up`, !!t && (await barShown(win)), `toast=${JSON.stringify(t)} bar=${await barShown(win)} toasts=${JSON.stringify(await toastsSince(win, from))}`);
  return same;
}
async function expectSaved(win, label, path, pages, press = () => win.keyboard.press('Control+s')) {
  const from = await toastCount(win);
  await press();
  const t = await waitToast(win, from, /^Saved /, 20000);
  await delay(400);
  R.check(`${label}: saved, disk has my ${pages} pages, document clean`, !!t && pagesOn(path) === pages && !(await isDirty(win)), `toast=${JSON.stringify(t)} pagesOnDisk=${pagesOn(path)} dirty=${await isDirty(win)} toasts=${JSON.stringify(await toastsSince(win, from))}`);
}

try {
  const p1 = mk('outline-6.pdf', 'cmdline.pdf');
  x = await start({ profile, args: [p1.path], env: { PDFSUITE_E2E_PROMPTS: '1' } });
  const win = x.win;
  await waitFor(async () => (await statusText(win)).startsWith('Page 1 of 6'), { timeoutMs: 30000, label: 'command-line file open' });
  await watchToasts(win);
  await showPanel(win, 'Thumbnails');

  await R.step('1 command-line open', async () => {
    await dup(win);
    const out = outsideBytes('c1');
    writeFileSync(p1.path, out);
    await expectBlocked(win, '1 opened from the command line, outside change, Ctrl+S at once', p1.path, out);
    R.check('1 still unsaved after the blocked save', await isDirty(win));
    await keep(win);
    R.check('1 Keep my version alone writes nothing', sameBytes(p1.path, out));
    await expectSaved(win, '1 Keep my version then Ctrl+S', p1.path, 7);
  });

  await R.step('2 no false alarm', async () => {
    const from = await toastCount(win);
    let n = 7;
    for (let i = 0; i < 4; i++) {
      n = await dup(win);
      await expectSaved(win, `2 own save ${i + 1}`, p1.path, n);
      await delay(i === 1 ? 5600 : 900); // one pause long enough for the periodic check to run between saves
    }
    await delay(6000);
    const ts = await toastsSince(win, from);
    R.check('2 four edits each saved, with waits across the periodic check: no bar, no "Another program" toast, no "moved or deleted"', !(await barShown(win)) && !ts.some((t) => BLOCKED.test(t) || /moved or deleted/.test(t)), JSON.stringify(ts));
  });

  await R.step('3 Save As onto the same path', async () => {
    const n = await dup(win); // 12
    const out = outsideBytes('c3');
    writeFileSync(p1.path, out);
    await setSaveAnswer(x, p1.path);
    await expectBlocked(win, '3 outside change, Save As choosing the same file', p1.path, out, () => win.keyboard.press('Control+Shift+s'));
    // Reload: shows the other program's 8 pages, clean.
    await win.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitFor(async () => (await pageCount(win)) === 8, { timeoutMs: 15000, label: '8 pages after Reload' });
    await delay(500);
    R.check("3 Reload shows the other program's 8 pages, clean, and writes nothing", sameBytes(p1.path, out) && !(await isDirty(win)) && !(await barShown(win)), `dirty=${await isDirty(win)} bar=${await barShown(win)} n was ${n}`);
    await dup(win);
    await expectSaved(win, '3 edit after Reload, Ctrl+S', p1.path, 9);
  });

  await R.step('4 delete then recreate', async () => {
    await dup(win); // 10
    unlinkSync(p1.path);
    await delay(120);
    const out = outsideBytes('c4');
    writeFileSync(p1.path, out);
    await expectBlocked(win, '4 file deleted and written again by another program, Ctrl+S', p1.path, out);
    await keep(win);
    await expectSaved(win, '4 Keep my version then Ctrl+S', p1.path, 10);
  });

  await R.step('5 rename outside', async () => {
    await dup(win); // 11
    const moved = p1.path.replace(/cmdline\.pdf$/, 'renamed-by-other.pdf');
    const before = readFileSync(p1.path);
    renameSync(p1.path, moved);
    const from = await toastCount(win);
    await win.keyboard.press('Control+s');
    const t = await waitToast(win, from, /^Saved /, 20000);
    await delay(500);
    R.check('5 file renamed outside, Ctrl+S: created again with my 11 pages; the renamed file is untouched', !!t && pagesOn(p1.path) === 11 && sameBytes(moved, before), `toast=${JSON.stringify(t)} pages=${existsSync(p1.path) ? pagesOn(p1.path) : 'MISSING'} renamedSame=${sameBytes(moved, before)} toasts=${JSON.stringify(await toastsSince(win, from))}`);
    await delay(6000);
    R.check('5 no bar afterwards', !(await barShown(win)));
  });

  await R.step('6 Ctrl+W > Save', async () => {
    await dup(win); // 12
    const out = outsideBytes('c6');
    writeFileSync(p1.path, out);
    await win.keyboard.press('Control+w');
    await waitFor(async () => !!(await promptText(x)), { timeoutMs: 5000, label: 'close prompt' });
    const from = await toastCount(win);
    await answer(x, 'Save');
    const t = await waitToast(win, from, BLOCKED, 10000);
    await delay(1200);
    const tabs = await win.getByRole('tab').count();
    R.check('6 outside change, Ctrl+W > Save: nothing written, the tab stays open with my edits', sameBytes(p1.path, out) && tabs === 1 && (await pageCount(win)) === 12 && (await isDirty(win)), `same=${sameBytes(p1.path, out)} tabs=${tabs} pages=${await pageCount(win)} dirty=${await isDirty(win)} toast=${JSON.stringify(t)}`);
    R.check('6 the user is told and the bar is up', !!t && (await barShown(win)));
    await keep(win);
    await win.keyboard.press('Control+w');
    await waitFor(async () => !!(await promptText(x)), { timeoutMs: 5000, label: 'close prompt again' });
    await answer(x, 'Save');
    await waitFor(async () => (await win.getByRole('tab').count()) === 0, { timeoutMs: 20000, label: 'tab closed' });
    R.check('6 after Keep my version, Ctrl+W > Save writes my 12 pages and closes', pagesOn(p1.path) === 12, `pages=${pagesOn(p1.path)}`);
  });

  await R.step('7 Close All > Save, two unsaved documents', async () => {
    const a = mk('outline-6.pdf', 'first.pdf');
    const b = mk('outline-6.pdf', 'second.pdf');
    await openMore(x, a.path, 6, 1);
    await dup(win);
    await openMore(x, b.path, 6, 2);
    await dup(win);
    const out = outsideBytes('c7');
    writeFileSync(b.path, out); // the active (second) document's file is changed by another program
    await win.keyboard.press('Control+Shift+w');
    await waitFor(async () => !!(await promptText(x)), { timeoutMs: 5000, label: 'close prompt' });
    R.info(`7 prompt: ${await promptText(x)}`);
    const from = await toastCount(win);
    await answer(x, 'Save');
    const t = await waitToast(win, from, BLOCKED, 15000);
    await delay(1500);
    const tabs = await win.getByRole('tab').count();
    R.check('7 Close All > Save with one file changed outside: that file is not written', sameBytes(b.path, out), `second.pdf sha ${sha(b.path)} outside ${sha(out)}`);
    R.check('7 nothing is closed while one document could not be saved (both tabs stay)', tabs === 2, `tabs=${tabs} toast=${JSON.stringify(t)} toasts=${JSON.stringify(await toastsSince(win, from))}`);
    R.info(`7 first.pdf on disk now has ${pagesOn(a.path)} pages (6 or 7 are both fine here)`);
    // Decide, then Close All > Save again: everything is written and closed.
    await win.getByRole('tab').nth(1).click();
    await waitFor(() => barShown(win), { timeoutMs: 8000, label: 'bar on second.pdf' });
    await keep(win);
    await win.keyboard.press('Control+Shift+w');
    await delay(600);
    if (await promptText(x)) await answer(x, 'Save');
    await waitFor(async () => (await win.getByRole('tab').count()) === 0, { timeoutMs: 25000, label: 'all tabs closed' });
    R.check('7 after the choice, Close All > Save writes both (7 pages each)', pagesOn(a.path) === 7 && pagesOn(b.path) === 7, `first=${pagesOn(a.path)} second=${pagesOn(b.path)}`);
  });

  await R.step('8 window close > Save', async () => {
    const c = mk('outline-6.pdf', 'onclose.pdf');
    await openMore(x, c.path, 6, 1);
    await dup(win);
    const out = outsideBytes('c8');
    writeFileSync(c.path, out);
    void x.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
    const w = await watchClose(x, 6000);
    R.check('8 window close with unsaved edits asks', !!w.prompt && !w.exited, JSON.stringify(w));
    await answer(x, 'Save');
    await delay(2500);
    R.check('8 outside change, window close > Save: the app stays open, nothing written', !x.gone && sameBytes(c.path, out), `gone=${x.gone} same=${sameBytes(c.path, out)}`);
    if (!x.gone) {
      R.check('8 edits still there and the bar is up', (await pageCount(win)) === 7 && (await isDirty(win)) && (await barShown(win)), `pages=${await pageCount(win)} dirty=${await isDirty(win)} bar=${await barShown(win)}`);
      await keep(win);
      void x.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
      await watchClose(x, 6000);
      await answer(x, 'Save');
      const gone = await waitGone(x, 20000);
      R.check('8 after Keep my version, window close > Save writes my 7 pages and quits', gone && pagesOn(c.path) === 7, `gone=${gone} pages=${pagesOn(c.path)}`);
    }
  });
} catch (e) {
  R.check('probe ran to the end', false, String(e && e.stack ? e.stack : e).slice(0, 600));
} finally {
  await endCleanly(x);
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
