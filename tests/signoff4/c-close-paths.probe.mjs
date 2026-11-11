// Probe C (round-1 gap 2): every way of closing the app that can be driven, with one and with several unsaved documents,
// and each of the three answers. The real prompt is on (PDFSUITE_E2E_PROMPTS=1); every prompt is answered.
// Ways: File > Exit; the Alt+F4 key; a WM_CLOSE sent by Windows to the window (taskkill without /F: what the title-bar X,
// the taskbar "Close window" and a hardware Alt+F4 all end in); BrowserWindow.close(); app.quit(); window.close() in the page.
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, waitFor, delay, newProfileDir, cleanupProfile, closeAll,
  makeReport, HERE, watchToasts, toastAfter, menu, shot, inspect, brief, isDirty, showPanel,
  start, promptText, watchClose, answer, waitGone, endCleanly, statusText,
} from './lib.mjs';

const R = makeReport('c-close-paths');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
const profiles = [];
let x;
const recOf = (profile) => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : []);
async function freshApp(profile = newProfileDir()) {
  if (!profiles.includes(profile)) profiles.push(profile);
  x = await start({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
  return profile;
}
/** Windows posts a close message to the app's window (see post-close.ps1). Never forces. */
async function osClose(session, kind = 'syscommand') {
  const hwnd = await session.app.evaluate(({ BrowserWindow }) => {
    const b = BrowserWindow.getAllWindows()[0]?.getNativeWindowHandle();
    return b ? (b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0))) : null;
  }).catch(() => null);
  if (!hwnd) return 'no window handle';
  return new Promise((done) => {
    let out = '';
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'post-close.ps1'), '-Hwnd', hwnd, '-Kind', kind], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', () => done(out.trim().slice(0, 200)));
  });
}
const OS_X = 'Windows WM_SYSCOMMAND SC_CLOSE (title-bar X / Alt+F4)';
const WAYS = {
  'File > Exit': (s) => menu(s.win, 'File', 'Exit'),
  'Alt+F4 key': (s) => s.win.keyboard.press('Alt+F4'),
  [OS_X]: async (s) => R.info(`  post: ${await osClose(s, 'syscommand')}`),
  'Windows WM_CLOSE (taskbar Close window)': async (s) => R.info(`  post: ${await osClose(s, 'close')}`),
  'BrowserWindow.close()': (s) => s.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }),
  'app.quit()': (s) => s.app.evaluate(({ app }) => { app.quit(); }),
  'window.close() in the page': (s) => s.win.evaluate(() => { window.close(); }),
};
async function request(way) {
  void Promise.resolve().then(() => WAYS[way](x)).catch(() => undefined);
  return watchClose(x, 9000);
}
async function dirtyDoc(name = 'outline-6.pdf', pages = 6, tabsAfter = 1) {
  const c = mk(name);
  await x.setDialogAnswer([c.path]);
  await x.win.keyboard.press('Control+o');
  await waitFor(async () => (await x.win.getByRole('tab').count()) === tabsAfter && (await pageCount(x.win)) === pages, { timeoutMs: 30000, label: `tab ${tabsAfter}` });
  await showPanel(x.win, 'Thumbnails');
  await x.win.locator('.thumb').first().waitFor({ timeout: 20000 });
  await jumpTo(x.win, 0);
  await toastAfter(x.win, () => x.win.keyboard.press('Delete'));
  await waitFor(async () => (await pageCount(x.win)) === pages - 1, { timeoutMs: 10000, label: 'one page fewer' });
  return c;
}

try {
  // ---------- C1. One unsaved document: every way asks; Cancel keeps everything; asked again each time
  await R.step('C1 threw', async () => {
    const profile = await freshApp();
    await x.win.waitForSelector('.empty-state');
    await watchToasts(x.win);
    const c = await dirtyDoc();
    const original = readFileSync(c.path);
    await delay(800);
    for (const way of Object.keys(WAYS)) {
      const seen = await request(way);
      const ok = /Save changes to outline-6\.pdf before closing\?/.test(seen.prompt) && !seen.exited;
      R.check(`C1 ${way}: asks Save / Don't save / Cancel`, ok, JSON.stringify(seen));
      if (seen.exited) return;
      if (seen.prompt) await answer(x, 'Cancel');
      await delay(500);
      R.check(`C1 ${way}: Cancel keeps the app, the tab and the edit`, !x.gone && (await pageCount(x.win)) === 5 && (await isDirty(x.win)) && !(await promptText(x)));
    }
    // Two close requests while the prompt is up: still one prompt, still open.
    await request('Alt+F4 key');
    await x.win.keyboard.press('Alt+F4').catch(() => undefined);
    const out = await osClose(x);
    await delay(1500);
    const dialogs = x.gone ? 0 : await x.win.getByRole('alertdialog').count();
    R.check('C1 more close requests while the prompt is showing: one prompt, app still open', !x.gone && dialogs === 1, `gone=${x.gone} dialogs=${dialogs} taskkill: ${out}`);
    // Esc is Cancel; then the next request still asks (nothing is stuck).
    await x.win.keyboard.press('Escape');
    await delay(500);
    const again = await request('File > Exit');
    R.check('C1 after Esc, File > Exit asks again', !!again.prompt && !again.exited, JSON.stringify(again));
    await answer(x, "Don't save");
    const gone = await waitGone(x, 10000);
    R.check('C1 Don\'t save: the app exits, the file is untouched, the recovery log is removed', gone && readFileSync(c.path).equals(original) && recOf(profile).length === 0, `gone=${gone} rec=${recOf(profile)}`);
    // The next start: the tab comes back as the file is on disk, with nothing recovered.
    await freshApp(profile);
    await waitFor(async () => /Page \d+ of \d+/.test(await statusText(x.win)), { timeoutMs: 20000, label: 'a restored tab' });
    await delay(2000);
    const bars = await x.win.locator('.doc-bar').allInnerTexts();
    R.check('C1 next start: 6 pages, clean, nothing "recovered"', (await pageCount(x.win)) === 6 && !(await isDirty(x.win)) && bars.length === 0, `pages=${await pageCount(x.win)} bars=${JSON.stringify(bars)}`);
    const quiet = await request(OS_X);
    const gone2 = await waitGone(x, 10000);
    R.check('C1 with nothing unsaved, a WM_CLOSE from Windows quits without asking', !quiet.prompt && gone2, JSON.stringify(quiet));
  });
  await endCleanly(x);

  // ---------- C2. Three documents, two unsaved: each way asks about both; Save writes both and quits
  await R.step('C2 threw', async () => {
    const profile = await freshApp();
    await x.win.waitForSelector('.empty-state');
    await watchToasts(x.win);
    const a = await dirtyDoc('outline-6.pdf', 6, 1);
    const clean = mk('margins-white.pdf');
    await x.setDialogAnswer([clean.path]);
    await x.win.keyboard.press('Control+o');
    await waitFor(async () => (await x.win.getByRole('tab').count()) === 2 && (await pageCount(x.win)) === 2, { timeoutMs: 20000, label: 'clean tab' });
    const cleanBytes = readFileSync(clean.path);
    const b = await dirtyDoc('mixed-sizes-rotated.pdf', 8, 3);
    await delay(800);
    for (const way of Object.keys(WAYS)) {
      const seen = await request(way);
      R.check(`C2 ${way}: asks about the 2 unsaved files`, /Save changes to 2 files before closing\?/.test(seen.prompt) && !seen.exited, JSON.stringify(seen));
      if (seen.exited) return;
      if (seen.prompt) await answer(x, 'Cancel');
      await delay(400);
    }
    R.check('C2 after six cancelled attempts: three tabs, both edits still there', !x.gone && (await x.win.getByRole('tab').count()) === 3 && (await x.win.locator('.tab-dirty').count()) === 2, `tabs=${await x.win.getByRole('tab').count()} dots=${await x.win.locator('.tab-dirty').count()}`);
    const seen = await request(OS_X);
    R.check('C2 WM_CLOSE asks once more', !!seen.prompt && !seen.exited, JSON.stringify(seen));
    await answer(x, 'Save');
    const gone = await waitGone(x, 15000);
    const da = inspect(a.path);
    const db = inspect(b.path);
    R.check('C2 Save: both files written (5 and 7 pages), the clean one untouched, the app exits, no logs left', gone && brief(da) === '5p [o2,o3,o4,o5,o6]' && db.count === 7 && db.pages[0].text === 'Page 2: A4 portrait' && readFileSync(clean.path).equals(cleanBytes) && recOf(profile).length === 0, `gone=${gone} a ${brief(da)} b ${brief(db)} rec=${recOf(profile)}`);
  });
  await endCleanly(x);

  // ---------- C3. The prompt does not time out: 75 s with it showing (the acknowledgement timeout is 60 s)
  await R.step('C3 threw', async () => {
    const profile = await freshApp();
    await x.win.waitForSelector('.empty-state');
    await watchToasts(x.win);
    const c = await dirtyDoc();
    const original = readFileSync(c.path);
    await delay(800);
    const seen = await request(OS_X);
    R.check('C3 the prompt is up', !!seen.prompt && !seen.exited, JSON.stringify(seen));
    const t0 = Date.now();
    await delay(35000);
    await osClose(x); // a second request in the middle of the wait
    await delay(40000);
    const still = await promptText(x);
    R.check(`C3 after ${Math.round((Date.now() - t0) / 1000)} s the prompt is still showing and the app is open`, !x.gone && !!still, `gone=${x.gone} prompt="${still}"`);
    R.check('C3 the edit is still there behind it, file untouched, log kept', !x.gone && (await pageCount(x.win)) === 5 && readFileSync(c.path).equals(original) && recOf(profile).some((f) => f.endsWith('.json')), `rec=${recOf(profile)}`);
    await answer(x, 'Save');
    const gone = await waitGone(x, 15000);
    R.check('C3 Save after the long wait writes the file and quits', gone && brief(inspect(c.path)) === '5p [o2,o3,o4,o5,o6]', `gone=${gone} ${brief(inspect(c.path))}`);
  });
  await endCleanly(x);

  // ---------- C4. A tab's prompt is showing, then the window is asked to close
  await R.step('C4 threw', async () => {
    await freshApp();
    await x.win.waitForSelector('.empty-state');
    await watchToasts(x.win);
    const c = await dirtyDoc();
    const original = readFileSync(c.path);
    await x.win.keyboard.press('Control+w');
    await delay(600);
    R.check('C4 Ctrl+W asks', !!(await promptText(x)));
    await osClose(x);
    await delay(2000);
    const dialogs = x.gone ? 0 : await x.win.getByRole('alertdialog').count();
    R.check('C4 a window close while the tab prompt is up: app open, one prompt', !x.gone && dialogs === 1, `gone=${x.gone} dialogs=${dialogs}`);
    await answer(x, 'Cancel');
    await delay(500);
    R.check('C4 Cancel: tab and edit kept', !x.gone && (await pageCount(x.win)) === 5 && (await isDirty(x.win)));
    const seen = await request('Alt+F4 key');
    R.check('C4 the next Alt+F4 asks again (the earlier request did not stick)', !!seen.prompt && !seen.exited, JSON.stringify(seen));
    await answer(x, "Don't save");
    const gone = await waitGone(x, 10000);
    R.check('C4 Don\'t save: exits, file untouched', gone && readFileSync(c.path).equals(original), `gone=${gone}`);
  });
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (x && !x.gone) await shot(x.win, 'c-failure');
} finally {
  await endCleanly(x).catch(() => undefined);
  await closeAll();
  for (const p of profiles) cleanupProfile(p);
  for (const c of copies) removeCopy(c);
  process.exitCode = R.summary() ? 1 : 0;
}
