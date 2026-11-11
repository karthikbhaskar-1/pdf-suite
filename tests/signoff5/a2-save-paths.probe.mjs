// Probe A2: the save-time disk check after Save As, with one file under two spellings, after a session restore, for a file
// handed over by a second launch, and with the outside change landing while a save is running.
import { basename, dirname, join } from 'node:path';
import { runSecondInstance } from '../e2e/helpers.mjs';
import {
  launch, closeAll, cleanupProfile, newProfileDir, waitFor, statusText, pageCount, delay, showPanel, setSaveAnswer, isDirty, inspect, openMore, fixture,
  watchToasts, toastCount, toastsSince, waitToast, BLOCKED, barShown, dup, mk, wipeWork, sha, sameBytes, outsideBytes, report,
  readFileSync, writeFileSync, existsSync,
} from './lib.mjs';

const R = report('a2-save-paths');
const profile = newProfileDir();
let s;
let win;
const pagesOn = (p) => { try { return inspect(p, undefined, { text: false }).count; } catch (e) { return `unreadable (${e.message})`; } };
const keep = async () => { await win.getByRole('button', { name: 'Keep my version', exact: true }).click(); await waitFor(async () => !(await barShown(win)), { timeoutMs: 8000, label: 'bar gone' }); };
async function expectBlocked(label, path, buf, press = () => win.keyboard.press('Control+s')) {
  const from = await toastCount(win);
  await press();
  const t = await waitToast(win, from, BLOCKED, 10000);
  await delay(1200);
  R.check(`${label}: nothing written, the other program's bytes are still on disk`, sameBytes(path, buf), `disk sha ${existsSync(path) ? sha(path) : 'MISSING'} outside sha ${sha(buf)} pages on disk ${pagesOn(path)}`);
  R.check(`${label}: the user is told (toast) and the choice bar is up`, !!t && (await barShown(win)), `toast=${JSON.stringify(t)} bar=${await barShown(win)} toasts=${JSON.stringify(await toastsSince(win, from))}`);
}
async function expectSaved(label, path, pages, press = () => win.keyboard.press('Control+s')) {
  const from = await toastCount(win);
  await press();
  const t = await waitToast(win, from, /^Saved /, 30000);
  await delay(400);
  R.check(`${label}: saved, disk has my ${pages} pages, document clean`, !!t && pagesOn(path) === pages && !(await isDirty(win)), `toast=${JSON.stringify(t)} pagesOnDisk=${pagesOn(path)} dirty=${await isDirty(win)} toasts=${JSON.stringify(await toastsSince(win, from))}`);
}
async function closeEverything() {
  for (let i = 0; i < 8; i++) {
    if ((await win.getByRole('tab').count()) === 0) return;
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+Shift+w');
    await delay(500);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(500);
  }
}

try {
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');
  await watchToasts(win);

  await R.step('9 Save As, then outside changes to the old and the new file', async () => {
    const a = mk('outline-6.pdf', 'orig.pdf');
    const original = readFileSync(a.path);
    const b = join(a.dir, 'copy.pdf');
    await openMore(s, a.path, 6, 1);
    await dup(win);
    await setSaveAnswer(s, b);
    await expectSaved('9 Save As to a new file', b, 7, () => win.keyboard.press('Control+Shift+s'));
    R.check('9 the original file is untouched by Save As', sameBytes(a.path, original));
    const from = await toastCount(win);
    const outA = outsideBytes('a9');
    writeFileSync(a.path, outA);
    await delay(6500);
    R.check('9 another program changes the OLD file: no bar and no toast (the document is the new file now)', !(await barShown(win)) && (await toastsSince(win, from)).length === 0, JSON.stringify(await toastsSince(win, from)));
    await dup(win);
    await expectSaved('9 Ctrl+S after Save As goes to the new file', b, 8);
    R.check('9 the old file still holds the other program\'s bytes', sameBytes(a.path, outA));
    await dup(win);
    const outB = outsideBytes('b9');
    writeFileSync(b, outB);
    await expectBlocked('9 another program changes the NEW file, Ctrl+S at once', b, outB);
    await keep();
    await expectSaved('9 Keep my version then Ctrl+S', b, 9);
    await delay(6200);
    R.check('9 no bar after the app\'s own saves on the Save As file', !(await barShown(win)));
  });

  await R.step('10 Save As onto a file that is open in another tab', async () => {
    const c = mk('mixed-sizes-rotated.pdf', 'other.pdf');
    const cBytes = readFileSync(c.path);
    await openMore(s, c.path, 8, 2);
    await dup(win); // other.pdf now has unsaved work (9 pages)
    await win.getByRole('tab').nth(0).click();
    await waitFor(async () => (await pageCount(win)) === 9, { timeoutMs: 8000, label: 'back on copy.pdf' });
    await dup(win); // 10
    let from = await toastCount(win);
    await setSaveAnswer(s, c.path);
    await win.keyboard.press('Control+Shift+s');
    await delay(2500);
    R.check('10 Save As onto a file open in another tab is refused and that file is untouched', sameBytes(c.path, cBytes), `toasts=${JSON.stringify(await toastsSince(win, from))}`);
    R.info(`10 same spelling: toasts=${JSON.stringify(await toastsSince(win, from))}`);
    // The same file spelled differently (Windows paths ignore case).
    from = await toastCount(win);
    const other = join(dirname(c.path), basename(c.path).toUpperCase());
    await setSaveAnswer(s, other);
    await win.keyboard.press('Control+Shift+s');
    await delay(3000);
    const written = !sameBytes(c.path, cBytes);
    R.info(`10 other spelling (${basename(other)}): file ${written ? `WRITTEN, now ${pagesOn(c.path)} pages` : 'untouched'}; tabs=${JSON.stringify(await win.getByRole('tab').allInnerTexts())}; toasts=${JSON.stringify(await toastsSince(win, from))}`);
    if (written) {
      // The tab that had other.pdf open with unsaved work: its save must not silently replace what was just written, and its work must still be there.
      const tabs = win.getByRole('tab');
      const n = await tabs.count();
      let found = false;
      for (let i = 0; i < n; i++) {
        await tabs.nth(i).click();
        await delay(400);
        if ((await pageCount(win)) === 9) { found = true; break; }
      }
      R.check('10 the other tab still holds its unsaved 9 pages', found);
      if (found) {
        const now = readFileSync(c.path);
        const f2 = await toastCount(win);
        await win.keyboard.press('Control+s');
        await delay(3000);
        const ts = await toastsSince(win, f2);
        R.check('10 that tab\'s Ctrl+S does not silently write over the file the other tab just saved there', sameBytes(c.path, now) && ts.some((t) => BLOCKED.test(t)), `sameAsBefore=${sameBytes(c.path, now)} toasts=${JSON.stringify(ts)}`);
      }
    }
  });
  await closeEverything();

  await R.step('15 one file opened under two spellings', async () => {
    const d = mk('outline-6.pdf', 'twice.pdf');
    await openMore(s, d.path, 6, 1);
    const second = join(dirname(d.path), 'TWICE.PDF');
    await s.setDialogAnswer([second]);
    await win.keyboard.press('Control+o');
    await delay(3000);
    const tabs = await win.getByRole('tab').count();
    R.info(`15 tabs after opening the second spelling: ${tabs} ${JSON.stringify(await win.getByRole('tab').allInnerTexts())}`);
    if (tabs === 2) {
      await dup(win); // in the second tab
      const sharedDoc = await (async () => { await win.getByRole('tab').nth(0).click(); await delay(500); const n = await pageCount(win); await win.getByRole('tab').nth(1).click(); await delay(500); return n === 7; })();
      R.info(`15 the two tabs ${sharedDoc ? 'share one document' : 'are two separate documents on one file'}`);
      await expectSaved('15 save from the second tab', d.path, 7);
      if (!sharedDoc) {
        const after = readFileSync(d.path);
        await win.getByRole('tab').nth(0).click();
        await delay(500);
        await dup(win);
        await dup(win); // 8 pages here, different from the 7 just saved
        const from = await toastCount(win);
        await win.keyboard.press('Control+s');
        await delay(3000);
        const ts = await toastsSince(win, from);
        R.check('15 the first tab\'s Ctrl+S does not silently write over what the second tab saved', sameBytes(d.path, after) && ts.some((t) => BLOCKED.test(t)), `sameAsSecondTabSave=${sameBytes(d.path, after)} pagesOnDisk=${pagesOn(d.path)} toasts=${JSON.stringify(ts)}`);
      }
    }
  });
  await closeEverything();

  // ---- session restore
  const e = mk('outline-6.pdf', 'restore.pdf');
  await openMore(s, e.path, 6, 1);
  await delay(1500);
  await s.close();
  s = await launch({ profile });
  win = s.win;
  await R.step('3 restored tab', async () => {
    await waitFor(async () => (await statusText(win)).startsWith('Page 1 of 6'), { timeoutMs: 30000, label: 'restored tab' });
    await watchToasts(win);
    await dup(win);
    const out = outsideBytes('r3');
    writeFileSync(e.path, out);
    await expectBlocked('3 tab restored from the last session, outside change, Ctrl+S at once', e.path, out);
    await keep();
    const from = await toastCount(win);
    await win.keyboard.press('Control+s');
    await delay(3000);
    R.info(`3 after Keep my version + Ctrl+S on a restored tab: pagesOnDisk=${pagesOn(e.path)} dirty=${await isDirty(win)} toasts=${JSON.stringify(await toastsSince(win, from))}`);
  });
  await closeEverything();

  await R.step('2 file handed over by a second launch', async () => {
    const f = mk('outline-6.pdf', 'second-launch.pdf');
    const r = await runSecondInstance([f.path], profile);
    R.info(`2 second launch exit code ${r.code}`);
    await waitFor(async () => (await statusText(win)).startsWith('Page 1 of 6') && (await win.getByRole('tab').count()) === 1, { timeoutMs: 30000, label: 'file from the second launch' });
    await dup(win);
    const out = outsideBytes('s2');
    writeFileSync(f.path, out);
    await expectBlocked('2 opened by a second launch, outside change, Ctrl+S at once', f.path, out);
    await keep();
    await expectSaved('2 Keep my version then Ctrl+S', f.path, 7);
  });
  await closeEverything();

  await R.step('13 outside change while a save is running', async () => {
    const g = mk('big-1000.pdf', 'race.pdf');
    await openMore(s, g.path, 1000, 1);
    let n = await dup(win);
    let t0 = Date.now();
    await expectSaved('13 a plain save of the 1001-page file', g.path, n);
    const T = Date.now() - t0 - 400;
    R.info(`13 a save takes about ${T} ms (keypress to toast)`);
    const fractions = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.2];
    let violations = 0;
    for (const fr of fractions) {
      if (await barShown(win)) await keep();
      n = await dup(win);
      const out = outsideBytes(`race-${fr}`);
      const from = await toastCount(win);
      const wait = Math.round(T * fr);
      t0 = Date.now();
      await win.keyboard.press('Control+s');
      await delay(wait);
      let wrote = true;
      let at = 0;
      try { writeFileSync(g.path, out); at = Date.now() - t0; } catch (err) { wrote = false; R.info(`13 [${fr}] the outside write failed (${err.code}): skipped`); }
      await delay(7500);
      if (!wrote) continue;
      const ts = await toastsSince(win, from);
      const onDisk = sameBytes(g.path, out);
      const bar = await barShown(win);
      let verdict;
      if (!onDisk) { verdict = 'VIOLATION: the app wrote over the outside change'; violations++; }
      else if (bar) verdict = 'ok: outside bytes on disk and the bar is up';
      else {
        // No bar: does the app know? Its next save must be refused.
        if (!(await isDirty(win))) n = await dup(win);
        const f2 = await toastCount(win);
        await win.keyboard.press('Control+s');
        await delay(4000);
        const again = await toastsSince(win, f2);
        if (sameBytes(g.path, out) && again.some((t) => BLOCKED.test(t))) verdict = 'ok: no bar at first, but the next save was refused';
        else { verdict = `VIOLATION: the app did not notice the outside change; next save: ${JSON.stringify(again)} disk still outside=${sameBytes(g.path, out)}`; violations++; }
      }
      R.info(`13 [${fr}] outside write ${at} ms after Ctrl+S: ${verdict}; toasts=${JSON.stringify(ts)}`);
    }
    R.check(`13 ${fractions.length} outside writes timed across a running save: none silently lost`, violations === 0, `violations=${violations}`);
    if (await barShown(win)) await keep();
  });
  await closeEverything();
} catch (e) {
  R.check('probe ran to the end', false, String(e && e.stack ? e.stack : e).slice(0, 600));
} finally {
  await closeAll();
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
