// Probe I: a save that fails (the file is read-only, or another program has it open), then the user fixes that and
// saves again. Do the edits reach the disk? Variants: retry at once; more edits before the retry; Save As after the
// failure; an edit that deletes pages (a different save path).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFileSync, chmodSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitForCount, pageCount, waitFor, delay, setSaveAnswer, newProfileDir, cleanupProfile,
  makeReport, watchToasts, toastAfter, menuItems, shot, inspectMupdf, toasts, isDirty, statusText,
} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const R = makeReport('i-failed-save-retry');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
const describe = (path) => {
  const d = inspectMupdf(path);
  return `${d.count} pages [${d.pages.map((p) => `${p.text.replace('Outline page ', 'p')}${p.rotate ? `/r${p.rotate}` : ''}`).join(', ')}]`;
};
const closeTab = async (win) => {
  await win.keyboard.press('Control+w');
  await win.waitForSelector('.empty-state', { timeout: 10000 });
};

try {
  const profile = newProfileDir();
  s = await launch({ profile });
  const { win } = s;
  await win.waitForSelector('.empty-state');

  // ---------- A. Read-only file: duplicate, save fails, clear read-only, save again
  {
    const a = mk('outline-6.pdf');
    const original = readFileSync(a.path);
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    chmodSync(a.path, 0o444);
    const t1 = await toastAfter(win, () => win.keyboard.press('Control+s'));
    R.info(`A. step 4, save while read-only: "${t1}"; app shows ${await pageCount(win)} pages, unsaved=${await isDirty(win)}`);
    chmodSync(a.path, 0o666);
    const t2 = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(800);
    const appPages = await pageCount(win);
    const dirty = await isDirty(win);
    const undo = (await menuItems(win, 'Edit'))[0];
    const disk = inspectMupdf(a.path);
    const rec = existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : [];
    R.info(`A. step 6, save again: "${t2}"; disk: ${describe(a.path)}; app now shows ${appPages} pages, unsaved=${dirty}, Undo disabled=${undo.disabled}; recovery files left: ${rec.length}; file identical to the original: ${readFileSync(a.path).equals(original)}`);
    await shot(win, 'i-after-retry');
    R.check('A. after a failed save and a retry, the file on disk has the 7 pages the user saved', disk.count === 7, `disk has ${disk.count} pages`);
    R.check('A. after the retry the app still shows the 7 pages', appPages === 7, `app shows ${appPages}`);
    await closeTab(win);
  }

  // ---------- B. Another program holds the file open: rotate + duplicate, save fails, program closes, more edits, save
  {
    const b = mk('outline-6.pdf');
    const sentinel = join(b.dir, 'release.flag');
    await open(s, b.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'hold-lock.ps1'), '-Path', b.path, '-Sentinel', sentinel], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    holder.stdout.on('data', (d) => (out += d));
    const exited = new Promise((res) => holder.once('exit', res));
    await waitFor(async () => out.includes('LOCKED'), { timeoutMs: 20000, label: 'the other program has the file open' });
    const t1 = await toastAfter(win, () => win.keyboard.press('Control+s'));
    R.info(`B. save while another program has the file open: "${t1}"; app shows ${await pageCount(win)} pages, unsaved=${await isDirty(win)}`);
    writeFileSync(sentinel, 'go');
    await exited;
    // The user goes on working, then saves.
    await jumpTo(win, 6);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    const t2 = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(800);
    let diskText = 'unreadable';
    let disk = null;
    try {
      disk = inspectMupdf(b.path);
      diskText = describe(b.path);
    } catch (e) {
      diskText = `NOT READABLE: ${e.message}`;
    }
    R.info(`B. save after the other program closed: "${t2}"; disk: ${diskText}; app now shows ${await pageCount(win)} pages, unsaved=${await isDirty(win)}`);
    R.check('B. locked by another program, then saved: disk has 7 pages with both rotations', disk !== null && disk.count === 7 && disk.pages[0].rotate === 90 && disk.pages[6].rotate === 90, diskText);
    await closeTab(win);
  }

  // ---------- C. After a failed save, Save As to a new name
  {
    const c = mk('outline-6.pdf');
    await open(s, c.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    chmodSync(c.path, 0o444);
    await toastAfter(win, () => win.keyboard.press('Control+s'));
    const target = join(c.dir, 'saved-as.pdf');
    await setSaveAnswer(s, target);
    const t = await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    await delay(500);
    const disk = existsSync(target) ? inspectMupdf(target) : { count: -1 };
    R.info(`C. Save As after a failed save: "${t}"; new file: ${existsSync(target) ? describe(target) : 'missing'}; app shows ${await pageCount(win)} pages`);
    R.check('C. Save As after a failed save keeps the 7 pages', disk.count === 7, `count ${disk.count}`);
    chmodSync(c.path, 0o666);
    await closeTab(win);
  }

  // ---------- D. An edit that deletes a page (always a full rewrite): failed save, retry
  {
    const d = mk('outline-6.pdf');
    await open(s, d.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 5);
    chmodSync(d.path, 0o444);
    await toastAfter(win, () => win.keyboard.press('Control+s'));
    chmodSync(d.path, 0o666);
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(500);
    const disk = inspectMupdf(d.path);
    R.info(`D. delete, failed save, retry: "${t}"; disk: ${describe(d.path)}; app shows ${await pageCount(win)} pages`);
    R.check('D. delete + failed save + retry: disk has 5 pages', disk.count === 5, `count ${disk.count}`);
    await closeTab(win);
  }

  // ---------- E. Control: the same edit with no failed save in between
  {
    const e = mk('outline-6.pdf');
    await open(s, e.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(500);
    const disk = inspectMupdf(e.path);
    R.check('E. control (no failed save): disk has 7 pages', disk.count === 7, `count ${disk.count}`);
    // Two saves in a row with an edit between them (each save reopens the file, so each starts fresh).
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(500);
    const disk2 = inspectMupdf(e.path);
    R.check('E. control: a second edit and save also reaches the disk', disk2.count === 7 && disk2.pages[0].rotate === 90, describe(e.path));
    await closeTab(win);
  }
  R.info('all toasts: ' + (await toasts(win)).join(' | '));
  R.check('no console or page errors', s.errors.filter((x) => !/favicon/.test(x)).length === 0, s.errors.join(' || ').slice(0, 600));
  await s.close();
  cleanupProfile(profile);
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'i-failure');
} finally {
  await closeAll();
  for (const c of copies) {
    try {
      for (const f of readdirSync(c.dir)) chmodSync(join(c.dir, f), 0o666);
    } catch { /* already gone */ }
    removeCopy(c);
  }
  process.exitCode = R.summary() ? 1 : 0;
}
