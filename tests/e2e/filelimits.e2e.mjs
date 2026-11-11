// 1.5.10 file-size limits (owner's delegate, 2026-11-10): a file over 500 MB opens view-only with a notice that stays; every editing
// command is off with that reason; search and scrolling work; the file on disk is never touched. A file over 1 GB is refused with the
// limit named. A file of exactly 500 MB is still edited. The big files are generated into %TEMP% and deleted after (the generator
// writes one unreferenced stream for the bulk, so a 520 MB file takes about a second). Needs free disk (checked first) and about 3 GB
// of free RAM: exclusive in the queue.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, closeAll, cleanupProfile, statusText, waitFor, waitForOutcome } from './helpers.mjs';
import { palette, showPanel } from './matrix-lib.mjs';
import { makeLargeFile, removeLargeFile } from '../lib/makeLargeFile.mjs';

after(closeAll);

const MB = 1024 * 1024;
const WORD = 'limitneedle';
const PAGES = 12;

const NOTICE = 'This file is over 500 MB, so it is open for viewing only. You can read and search it, but you cannot edit or save it.';
const REASON = 'This file is over 500 MB, so it can be viewed but not edited.';
const TOO_LARGE_TO_OPEN = 'This file is too large to open (the limit is 1 GB).';

const work = mkdtempSync(join(tmpdir(), 'pdfsuite-limits-1510-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** Free disk in the temp folder, in MB: a generated file is never made without room for it (and room to spare). */
function freeMB() {
  const fs = statfsSync(work);
  return Math.floor((fs.bavail * fs.bsize) / MB);
}

/** Makes a fixture of this many bytes after checking the disk. */
function fixtureOf(name, bytes) {
  assert.ok(freeMB() > bytes / MB + 2048, `not enough free disk for a ${Math.round(bytes / MB)} MB fixture (${freeMB()} MB free)`);
  return makeLargeFile({ path: join(work, name), bytes, pages: PAGES, word: WORD });
}

async function waitForToast(win, text) {
  await win.locator('.toast', { hasText: text }).first().waitFor({ timeout: 10000 });
}

test('a 520 MB file opens view-only: the notice stays, search and scrolling work, every editing command is off with the reason', async () => {
  const file = fixtureOf('over-500.pdf', 520 * MB);
  const before = statSync(file.path);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([file.path]);
    await s.win.keyboard.press('Control+o');
    const outcome = await waitForOutcome(s, { timeoutMs: 120000 });
    assert.equal(outcome.kind, 'page', `the file did not open: ${JSON.stringify(outcome)}`);
    await waitFor(async () => (await statusText(s.win)).startsWith(`Page 1 of ${PAGES}`), { timeoutMs: 60000, label: `Page 1 of ${PAGES}` });

    // The notice: why (over 500 MB), what still works, that the file is untouched. It has no button and stays.
    const bar = s.win.locator('.doc-bar[data-view-only="true"]');
    await bar.waitFor({ timeout: 10000 });
    assert.equal((await bar.innerText()).trim(), NOTICE);
    assert.equal(await bar.locator('button').count(), 0, 'the notice has no button: it cannot be dismissed');

    // Every editing control says why it is off: the toolbar buttons and the Pages group carry the reason as their tooltip.
    await showPanel(s.win, 'Thumbnails');
    await s.win.locator('.thumb').first().waitFor({ timeout: 30000 });
    const reasons = s.win.locator(`[data-tooltip="${REASON}"]`);
    await waitFor(async () => (await reasons.count()) >= 5, { timeoutMs: 15000, label: 'the reason as the tooltip of the editing buttons' });
    // The editing buttons are really disabled, not only labelled.
    const disabled = await s.win.evaluate((reason) => {
      const tipped = [...document.querySelectorAll(`[data-tooltip="${reason}"]`)];
      const buttons = tipped.flatMap((el) => (el.tagName === 'BUTTON' ? [el] : [...el.querySelectorAll('button')]));
      return { total: buttons.length, off: buttons.filter((b) => b.disabled).length };
    }, REASON);
    assert.ok(disabled.total >= 5 && disabled.off === disabled.total, `every button with the reason is disabled: ${JSON.stringify(disabled)}`);

    // A shortcut on an editing command says the reason in a toast (Ctrl+S, Save), and the file is not written.
    await s.win.keyboard.press('Control+s');
    await waitForToast(s.win, REASON);
    // A palette command does nothing and makes no unsaved dot.
    await palette(s.win, 'Pages: Rotate right 90°').catch(() => undefined);
    await s.win.keyboard.press('Escape');
    await s.win.waitForTimeout(500);
    assert.equal(await s.win.locator('.tab-dirty').count(), 0, 'nothing was changed');

    // Search works: every page has the word.
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.waitFor({ timeout: 5000 });
    await find.fill(WORD);
    await waitFor(async () => (await s.win.locator('.search-status').innerText()).trim() === `1 of ${PAGES}`, { timeoutMs: 60000, label: `search count 1 of ${PAGES}` });

    // Scrolling works: the viewer goes to the end and the status follows.
    await s.win.evaluate(() => {
      const viewer = document.querySelector('.viewer');
      viewer.scrollTop = viewer.scrollHeight;
    });
    await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${PAGES} of ${PAGES}`), { timeoutMs: 20000, label: `Page ${PAGES} of ${PAGES}` });

    // The notice is still there after all that.
    assert.equal((await bar.innerText()).trim(), NOTICE);
    // The file on disk is exactly as it was.
    const after = statSync(file.path);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeLargeFile(file);
  }
});

test('a file over 1 GB is refused, and the message names the limit', async () => {
  const file = fixtureOf('over-1gb.pdf', 1024 * MB + 1);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([file.path]);
    await s.win.keyboard.press('Control+o');
    const outcome = await waitForOutcome(s, { timeoutMs: 60000 });
    assert.deepEqual({ kind: outcome.kind, text: outcome.text }, { kind: 'message', text: TOO_LARGE_TO_OPEN });
    assert.equal(await s.win.locator('.doc-bar[data-view-only="true"]').count(), 0);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeLargeFile(file);
  }
});

test('a file of exactly 500 MB is still edited: no notice, and Rotate works (nothing is saved)', async () => {
  const file = fixtureOf('at-500.pdf', 500 * MB);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([file.path]);
    await s.win.keyboard.press('Control+o');
    const outcome = await waitForOutcome(s, { timeoutMs: 120000 });
    assert.equal(outcome.kind, 'page');
    await waitFor(async () => (await statusText(s.win)).startsWith(`Page 1 of ${PAGES}`), { timeoutMs: 60000, label: `Page 1 of ${PAGES}` });
    assert.equal(await s.win.locator('.doc-bar[data-view-only="true"]').count(), 0, 'no view-only notice at 500 MB');
    assert.equal(await s.win.locator(`[data-tooltip="${REASON}"]`).count(), 0, 'no editing command is off for size');
    await showPanel(s.win, 'Thumbnails');
    await s.win.locator('.thumb').first().waitFor({ timeout: 30000 });
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 20000, label: 'the unsaved dot after Rotate' });
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    // Test mode: the quit discards the edit silently, so no prompt is left behind.
    await s.close();
    cleanupProfile(s.profile);
    removeLargeFile(file);
  }
});
