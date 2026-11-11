// Probe K: leaving the app with unsaved changes, with the real close prompt on (PDFSUITE_E2E_PROMPTS=1).
// File ▸ Exit from the menu, Alt+F4 from the keyboard, and the window's own close button. Every prompt is answered.
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, pageCount, waitFor, delay, newProfileDir, cleanupProfile, forceKill,
  makeReport, watchToasts, toastAfter, menu, shot, isDirty, statusText, showPanel, bars,
} from './lib.mjs';

const R = makeReport('k-exit-unsaved');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
const exited = (x) => x.gone === true;
/** Launches with the prompt on, and tracks the process itself (the Playwright handle is unusable once the app is gone). */
async function start(profile) {
  const x = await launch({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
  x.proc = x.app.process();
  x.gone = false;
  x.proc.once('exit', () => { x.gone = true; });
  return x;
}
function kill(x) {
  return new Promise((done) => {
    if (x.gone) return done();
    const killer = spawn('taskkill', ['/PID', String(x.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', () => done());
  });
}

/** Watches for 4 s after a quit request: did the prompt show, did the process end? */
async function watchQuit(x) {
  const prompt = x.win.getByRole('alertdialog');
  let sawPrompt = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (exited(x)) break;
    try {
      if ((await prompt.count()) > 0) {
        sawPrompt = true;
        break;
      }
    } catch {
      break; // the page is gone
    }
    await delay(100);
  }
  await delay(300);
  return { sawPrompt, exited: exited(x) };
}
async function answer(x, name) {
  try {
    const p = x.win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name, exact: true }).click();
  } catch { /* the window is gone */ }
}
async function endCleanly(x) {
  if (exited(x)) return;
  try {
    void x.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
    await delay(800);
    await answer(x, "Don't save");
    await delay(1500);
  } catch { /* gone */ }
  if (!exited(x)) await kill(x);
  await delay(300);
}
/** Starts the app again on the same profile and reports what came back. */
async function relaunchAndReport(profile, label, pagesIfEdited, pagesOriginal) {
  const x = await start(profile);
  s = x;
  let state = 'no tab came back';
  try {
    await waitFor(async () => /Page \d+ of \d+/.test(await statusText(x.win)), { timeoutMs: 15000, label: 'a restored tab' });
    await delay(2500);
    const n = await pageCount(x.win);
    const recovered = (await x.win.locator('.doc-bar', { hasText: 'Recovered unsaved edits' }).count()) > 0;
    state = `tab restored with ${n} pages, recovered bar ${recovered ? 'shown' : 'not shown'}, unsaved=${await isDirty(x.win)}`;
    R.info(`${label}: next start: ${state}`);
    R.check(`${label}: the unsaved edit is still there at the next start`, n === pagesIfEdited && recovered, state);
  } catch (e) {
    R.info(`${label}: next start: ${state} (${String(e.message).split('\n')[0]})`);
    R.check(`${label}: the unsaved edit is still there at the next start`, false, state);
  }
  // Leave nothing behind: discard what was recovered, then close.
  try {
    const discard = x.win.locator('.doc-bar', { hasText: 'Recovered unsaved edits' }).getByRole('button', { name: 'Discard' });
    if ((await discard.count()) > 0) {
      await discard.click();
      await waitFor(async () => (await pageCount(x.win)) === pagesOriginal, { timeoutMs: 10000, label: 'discarded' });
    }
    await x.win.keyboard.press('Control+w');
    await delay(500);
    await answer(x, "Don't save");
    await delay(500);
  } catch { /* fine */ }
  await endCleanly(x);
}

async function scenario(label, quit, { waitBeforeQuitMs = 1500 } = {}) {
  const c = mk('outline-6.pdf');
  const original = readFileSync(c.path);
  const profile = newProfileDir();
  s = await start(profile);
  await s.win.waitForSelector('.empty-state');
  await open(s, c.path, 6);
  await watchToasts(s.win);
  await jumpTo(s.win, 0);
  await toastAfter(s.win, () => s.win.keyboard.press('Delete'));
  await waitFor(async () => (await pageCount(s.win)) === 5, { timeoutMs: 8000, label: '5 pages' });
  R.info(`${label}: 5 pages, unsaved=${await isDirty(s.win)}; now quitting`);
  await delay(waitBeforeQuitMs);
  await quit(s).catch(() => undefined);
  const seen = await watchQuit(s);
  R.info(`${label}: prompt shown=${seen.sawPrompt}, app exited=${seen.exited}`);
  R.check(`${label}: asks Save / Don't save / Cancel before quitting`, seen.sawPrompt && !seen.exited, `prompt shown=${seen.sawPrompt}, app exited=${seen.exited}`);
  if (seen.sawPrompt) {
    await answer(s, 'Cancel');
    await delay(500);
    R.check(`${label}: Cancel keeps the app open with the edit`, !exited(s) && (await pageCount(s.win)) === 5 && (await isDirty(s.win)));
    await endCleanly(s);
  } else {
    R.check(`${label}: file on disk untouched`, readFileSync(c.path).equals(original));
    const rec = existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : [];
    R.info(`${label}: recovery files after the quit: ${rec.length}`);
    if (!seen.exited) await endCleanly(s);
    await relaunchAndReport(profile, label, 5, 6);
  }
  cleanupProfile(profile);
}

try {
  await scenario('window close button', (x) => x.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }));
  await scenario('File ▸ Exit (menu)', (x) => menu(x.win, 'File', 'Exit'));
  await scenario('Alt+F4 (keyboard)', (x) => x.win.keyboard.press('Alt+F4'));
  await scenario('File ▸ Exit right after an edit (0.1 s)', (x) => menu(x.win, 'File', 'Exit'), { waitBeforeQuitMs: 0 });
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s && !exited(s)) await shot(s.win, 'k-failure');
} finally {
  if (s) await endCleanly(s).catch(() => undefined);
  await closeAll();
  for (const c of copies) removeCopy(c);
  process.exitCode = R.summary() ? 1 : 0;
}
