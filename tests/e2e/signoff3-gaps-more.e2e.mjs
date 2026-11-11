// Round 4 additions for ticket 1.2.1 (kept beside signoff3-gaps.e2e.mjs):
//  - the close prompt has no timeout once the page has acknowledged the request;
//  - recovery and a password-protected source: no stale log after edit, undo, protected insert and a crash; recovery
//    resumes after a save.
// Every test ends with its edits saved, discarded through a prompt, or dropped by the test-mode quit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, isDirty, assertNoErrors, assertNoErrorsAfterKill, waitFor,
  statusText, showPanel, forceKill, cleanupProfile, delay, palette, newProfileDir,
} from './matrix-lib.mjs';

after(closeAll);

const OUTLINE = 'outline-6.pdf';
const MARGINS = 'margins-white.pdf';
const LOCKED = 'locked.pdf'; // password test123
const LOCK_PASSWORD = 'test123';

async function watchToasts(win) {
  await win.evaluate(() => {
    if (window.__more) return;
    window.__more = { toasts: [] };
    const seen = new WeakSet();
    const scan = () => {
      for (const el of document.querySelectorAll('.toast')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__more.toasts.push(el.querySelector('span')?.textContent ?? el.textContent ?? '');
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  });
}
const toasts = (win) => win.evaluate(() => [...(window.__more?.toasts ?? [])]);
async function toastAfter(win, action, timeoutMs = 20000) {
  const before = (await toasts(win)).length;
  await action();
  const r = await waitFor(async () => {
    const all = await toasts(win);
    return all.length > before ? all.slice(before) : null;
  }, { timeoutMs, label: 'a new toast' });
  return r.value.join(' | ');
}
async function menu(win, top, item) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  const exact = new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const row = win
    .locator('.menu-top > .menu-dropdown > .menu-item, .menu-top > .menu-dropdown > .menu-sub-wrap > .menu-item')
    .filter({ has: win.locator('.menu-label', { hasText: exact }) });
  await row.first().waitFor({ timeout: 5000 });
  await row.first().click();
}
const recoveryFiles = (profile) => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : []);
const recoveryLogs = (profile) => recoveryFiles(profile).filter((name) => name.endsWith('.json'));
const prompt = (win) => win.getByRole('alertdialog');
const exited = (x) => x.gone === true;
async function killTree(x) {
  if (x.gone) return;
  await new Promise((done) => {
    const killer = spawn('taskkill', ['/PID', String(x.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', () => done());
  });
}

test('close prompt: it stays up past the acknowledgement timeout (a shortened, test-only value) until the user answers', async () => {
  const copy = copyOf(OUTLINE);
  const original = readFileSync(copy.path);
  const profile = newProfileDir();
  const x = await launch({ profile, env: { PDFSUITE_E2E_PROMPTS: '1', PDFSUITE_E2E_CLOSE_ACK_TIMEOUT_MS: '1500' } });
  x.proc = x.app.process();
  x.gone = false;
  x.proc.once('exit', () => {
    x.gone = true;
  });
  try {
    await x.win.waitForSelector('.empty-state');
    await open(x, copy.path, 6);
    await jumpTo(x.win, 0);
    await x.win.keyboard.press('Delete');
    await waitForCount(x.win, 5);
    void menu(x.win, 'File', 'Exit').catch(() => undefined);
    await prompt(x.win).waitFor({ timeout: 10000 });
    // Four times the timeout later, the prompt is still there and the app is still open.
    await delay(6000);
    assert.equal(exited(x), false, 'the window did not close itself under the prompt');
    assert.equal(await prompt(x.win).count(), 1, 'the prompt is still showing');
    assert.equal(await pageCount(x.win), 5);
    await prompt(x.win).getByRole('button', { name: 'Cancel', exact: true }).click();
    await delay(500);
    assert.equal(exited(x), false);
    assert.ok(readFileSync(copy.path).equals(original));
    // End through the prompt.
    void menu(x.win, 'File', 'Exit').catch(() => undefined);
    await prompt(x.win).waitFor({ timeout: 10000 });
    await prompt(x.win).getByRole('button', { name: "Don't save", exact: true }).click();
    await waitFor(async () => exited(x), { timeoutMs: 15000, label: 'the app to exit' });
  } finally {
    await killTree(x);
    await x.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

/** Browse for the locked file, give the password, and apply "page 1" after the current page. */
async function insertFromLocked(s, lockedPath) {
  await s.setDialogAnswer([lockedPath]);
  await palette(s.win, 'Pages: Insert pages from a PDF…');
  const sheet = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'Browse for a PDF…' }).click();
  const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
  await dialog.waitFor({ timeout: 20000 });
  await dialog.getByLabel('Password').fill(LOCK_PASSWORD);
  await dialog.getByRole('button', { name: 'Use password' }).click();
  await sheet.getByText(/locked\.pdf, \d+ pages?/).waitFor({ timeout: 10000 });
  await sheet.getByLabel('Page range').fill('1');
  await sheet.getByRole('button', { name: 'Apply' }).click();
}

test('recovery and a protected source: no stale log after edit, undo, protected insert and a crash; recovery resumes after a save', async () => {
  const copy = copyOf(MARGINS);
  const locked = copyOf(LOCKED);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-protected-'));
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
    await waitFor(async () => recoveryFiles(profile).length > 0, { timeoutMs: 10000, label: 'the recovery log of the rotation' });
    await s.win.keyboard.press('Control+z');
    await delay(800);
    await insertFromLocked(s, locked.path);
    await waitFor(async () => (await pageCount(s.win)) > 2, { timeoutMs: 20000, label: 'the protected page' });
    // 1.5.1 R5: a bar that stays, not a 4-second toast.
    const bar = s.win.getByText(/^Crash recovery is off/);
    await waitFor(async () => (await bar.count()) === 1, { timeoutMs: 10000, label: 'the recovery-off bar' });
    const told = (await toasts(s.win)).filter((t) => /^Crash recovery is off/.test(t));
    assert.equal(told.length, 0, `a bar, not a toast: ${told.join(' | ')}`);
    await delay(800);
    // 1.5.1 R4: the log is KEPT, marked "logging stopped here". It holds no steps (the one edit was undone), so a crash
    // replays nothing, and no stale step can be replayed on a changed document.
    const [logName] = recoveryLogs(profile);
    assert.ok(logName, 'the log file is kept');
    const kept = JSON.parse(readFileSync(join(profile, 'recovery', logName), 'utf8'));
    assert.equal(kept.steps.length, 0, 'no steps');
    assert.equal(kept.loggingStopped, true, 'marked as stopped');
    // A crash now restores nothing: the tab comes back as the file on disk, with no "Recovered unsaved edits".
    await forceKill(s.app);
    s = await launch({ profile });
    await waitFor(async () => /Page \d+ of 2/.test(await statusText(s.win)), { timeoutMs: 30000, label: 'the restored tab' });
    await delay(1500);
    assert.equal(await s.win.getByText(/Recovered unsaved edits/).count(), 0, 'nothing is recovered');
    assert.equal(await pageCount(s.win), 2);
    assert.equal(await isDirty(s.win), false);
    // Recovery works as normal again once the document is saved: insert again, save, then an ordinary edit is logged.
    await watchToasts(s.win);
    await insertFromLocked(s, locked.path);
    await waitFor(async () => (await pageCount(s.win)) > 2, { timeoutMs: 20000, label: 'the protected page again' });
    await toastAfter(s.win, () => s.win.keyboard.press('Control+s'));
    await waitFor(async () => !(await isDirty(s.win)), { label: 'saved' });
    // The save clears the kept log and the bar.
    await waitFor(async () => recoveryLogs(profile).length === 0, { timeoutMs: 10000, label: 'the kept log is cleared by the save' });
    assert.equal(await s.win.getByText(/^Crash recovery is off/).count(), 0, 'the bar is gone after the save');
    await showPanel(s.win, 'Thumbnails');
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
    await waitFor(async () => recoveryLogs(profile).length > 0, { timeoutMs: 10000, label: 'recovery is on again after the save' });
    assertNoErrorsAfterKill(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
    removeCopy(locked);
  }
});
