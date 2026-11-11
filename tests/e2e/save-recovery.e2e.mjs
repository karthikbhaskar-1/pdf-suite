// 1.2.1 save, recovery and document state: persistence after reopen, incremental vs full save, encrypted files keep
// their password, Save As leaves the original alone, the dirty dot, the close prompt (3 choices), crash recovery
// (Keep and Discard), disk-change detection, and the XFA tooltip. Every test ends with its edits saved, discarded
// through the close prompt, or dropped by the test-mode quit. No prompt is left for the owner.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  showPanel, launch, closeAll, copyOf, removeCopy, open, palette, jumpTo, waitForCount, pageCount, currentPage, currentPageSize,
  saveNow, isDirty, assertNoErrors, assertNoErrorsAfterKill, waitFor, statusText, fixture, forceKill, cleanupProfile, delay, setSaveAnswer,
  pagesOnDisk, ROOT,
} from './matrix-lib.mjs';

after(closeAll);

const MIXED = 'mixed-sizes-rotated.pdf';
const MARGINS = 'margins-white.pdf';
const LOCKED = 'locked.pdf'; // password test123
const LOCK_PASSWORD = 'test123';
const XFA = join(ROOT, 'tests', 'engine', 'corpus', 'xfa', 'xfa_filled_imm1344e.pdf');

const sameBytes = (a, b) => readFileSync(a).equals(readFileSync(b));

/** The close prompt: the alertdialog with Save, Don't save and Cancel. */
const closePrompt = (win) => win.getByRole('alertdialog');

/** Asks the app to close its window, the same as the close button. The prompt (or the test-mode quit) follows. */
async function requestClose(s) {
  await s.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close();
  });
}

test('save, quit and reopen: two deleted pages are gone, and the page sizes match the saved order', async () => {
  const copy = copyOf(MIXED);
  let s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 1);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await jumpTo(s.win, 1);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 6);
    await saveNow(s.win);
    assert.equal(await isDirty(s.win), false, 'the dot clears after the save');
    assert.equal(pagesOnDisk(copy.path), 6, 'the file on disk has 6 pages');
    await s.close();
    s = await launch();
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    // Original order was 0,1,2,3,4,5,6,7. Deleting the pages at index 1 and then index 1 again removes pages 2 and 3.
    // The remaining page 2 is original page 4 (A3 landscape, 1190.55 x 841.89 pt).
    await jumpTo(s.win, 1);
    const size = await currentPageSize(s.win);
    assert.ok(Math.abs(size.width - 1190.55) < 1 && Math.abs(size.height - 841.89) < 1, `page 2 is A3 landscape: ${size.width}x${size.height}`);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('an incremental save (insert only) grows the file and keeps its original bytes as a prefix', async () => {
  const copy = copyOf(MIXED);
  const original = readFileSync(copy.path);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Insert blank page…');
    const dialog = s.win.getByRole('dialog', { name: 'Insert pages' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 9);
    await saveNow(s.win);
    const after = readFileSync(copy.path);
    assert.ok(after.length > original.length, `the file grows: ${original.length} to ${after.length}`);
    assert.ok(after.subarray(0, original.length).equals(original), 'the original bytes are kept as a prefix (appended update)');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('a full save after a delete compacts the file, and its page count on disk matches', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Insert blank page…');
    await s.win.getByRole('dialog', { name: 'Insert pages' }).getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 9);
    await saveNow(s.win);
    const grown = statSync(copy.path).size;
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 8);
    await saveNow(s.win);
    const compacted = statSync(copy.path).size;
    assert.ok(compacted < grown, `the full save compacts: ${grown} to ${compacted} bytes`);
    assert.equal(pagesOnDisk(copy.path), 8, 'the file on disk has 8 pages');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('an encrypted file keeps its password after an edit and save: reopening asks for it', async () => {
  const copy = copyOf(LOCKED);
  let s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([copy.path]);
    await s.win.keyboard.press('Control+o');
    const pw = s.win.getByLabel('Password', { exact: true }).first();
    await pw.waitFor({ timeout: 20000 });
    await pw.fill(LOCK_PASSWORD);
    await s.win.getByRole('dialog').getByRole('button', { name: 'Open', exact: true }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 1'), { timeoutMs: 30000, label: 'locked file open' });
    await showPanel(s.win, 'Thumbnails');
    await palette(s.win, 'Pages: Insert blank page…');
    await s.win.getByRole('dialog', { name: 'Insert pages' }).getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 2);
    await s.win.keyboard.press('Control+s');
    await delay(3000);
    const notes = await s.win.locator('[role="alert"], [role="status"]').allInnerTexts();
    // Expected: the save completes and the file keeps its password. The app shows the list below if it does not.
    assert.equal(await isDirty(s.win), false, `an encrypted file saves after an edit; the app shows ${JSON.stringify(notes)}`);
    await s.close();

    s = await launch();
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([copy.path]);
    await s.win.keyboard.press('Control+o');
    await s.win.getByLabel('Password', { exact: true }).first().waitFor({ timeout: 20000 });
    await delay(1000);
    assert.equal(await s.win.locator('.page-canvas').count(), 0, 'no page is shown before the password');
    assert.ok(readFileSync(copy.path).toString('latin1').includes('/Encrypt'), 'the saved file is still encrypted');
    await s.win.getByRole('button', { name: 'Cancel' }).click();
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('Save As writes the edited copy to the new path, and the original file is byte-identical', async () => {
  const copy = copyOf(MIXED);
  const original = readFileSync(copy.path);
  const target = join(copy.dir, 'as-saved.pdf');
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await setSaveAnswer(s, target);
    await s.win.keyboard.press('Control+Shift+s');
    await waitFor(() => statSync(target, { throwIfNoEntry: false })?.size > 0, { timeoutMs: 20000, label: 'Save As written' });
    assert.equal(pagesOnDisk(target), 7, 'the new file has the edited 7 pages');
    assert.ok(readFileSync(copy.path).equals(original), 'the original file is unchanged');
    assert.equal(pagesOnDisk(copy.path), 8, 'the original still has 8 pages');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('the dirty dot appears on the tab and in the window title with an edit, and clears on save', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    assert.equal(await isDirty(s.win), false, 'no dot on a clean file');
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => isDirty(s.win), { timeoutMs: 10000, label: 'dot after edit' });
    assert.match(await s.win.title(), /•/, 'the window title shows the unsaved dot');
    await saveNow(s.win);
    assert.equal(await isDirty(s.win), false);
    assert.doesNotMatch(await s.win.title(), /•/);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

/** The close prompt tests run with the prompt on (PDFSUITE_E2E_PROMPTS=1). Each one clicks a choice itself. */
test('close prompt, choice Cancel: the window stays and the edit stays', async () => {
  const copy = copyOf(MIXED);
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => isDirty(s.win), { timeoutMs: 10000, label: 'dirty' });
    await requestClose(s);
    await closePrompt(s.win).waitFor({ timeout: 10000 });
    await closePrompt(s.win).getByRole('button', { name: 'Cancel' }).click();
    await delay(500);
    assert.equal(await closePrompt(s.win).count(), 0, 'the prompt closes on Cancel');
    assert.equal(await isDirty(s.win), true, 'the edit is kept');
    // Leave nothing behind: choose Don't save ourselves.
    await requestClose(s);
    await closePrompt(s.win).getByRole('button', { name: "Don't save" }).click();
    assert.ok(sameBytes(copy.path, fixture(MIXED)), 'Cancel then Don\'t save leaves the file unchanged');
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test("close prompt, choice Don't save: the file on disk is unchanged", async () => {
  const copy = copyOf(MIXED);
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await requestClose(s);
    await closePrompt(s.win).getByRole('button', { name: "Don't save" }).click();
    await delay(1500);
    assert.ok(sameBytes(copy.path, fixture(MIXED)), "Don't save leaves the file exactly as it was");
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('close prompt, choice Save: the edit is written to the file', async () => {
  const copy = copyOf(MIXED);
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await requestClose(s);
    await closePrompt(s.win).getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(() => pagesOnDisk(copy.path) === 7, { timeoutMs: 20000, label: 'saved on close' });
    assert.equal(pagesOnDisk(copy.path), 7);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('crash recovery, Keep: after a force-kill the edit comes back with "Recovered unsaved edits"', async () => {
  const copy = copyOf(MIXED);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-recover-'));
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await delay(1500); // the edit log is written as the edit happens
    await forceKill(s.app);
    s = await launch({ profile });
    await s.win.waitForSelector('.empty-state', { timeout: 20000 }).catch(() => undefined);
    const bar = s.win.getByText(/Recovered unsaved edits/);
    // The restored tab shows the recovery bar by itself. If it does not, the file is opened once more.
    try {
      await bar.waitFor({ timeout: 20000 });
    } catch {
      await s.setDialogAnswer([copy.path]);
      await s.win.keyboard.press('Control+o');
      await bar.waitFor({ timeout: 30000 });
    }
    await showPanel(s.win, 'Thumbnails');
    await s.win.getByRole('button', { name: 'Keep', exact: true }).click();
    await waitForCount(s.win, 7);
    assert.equal(await isDirty(s.win), true, 'the recovered edit is unsaved again');
    assert.ok(sameBytes(copy.path, fixture(MIXED)), 'the file itself is not changed by recovery');
    assertNoErrorsAfterKill(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

test('a tab restored after a crash saves straight back to its file, with no Save dialog', async () => {
  const copy = copyOf(MIXED);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-restoresave-'));
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await delay(1500);
    await forceKill(s.app);
    s = await launch({ profile });
    const bar = s.win.getByText(/Recovered unsaved edits/);
    await bar.waitFor({ timeout: 30000 });
    await showPanel(s.win, 'Thumbnails');
    await s.win.getByRole('button', { name: 'Keep', exact: true }).click();
    await waitForCount(s.win, 7);
    await saveNow(s.win); // Ctrl+S on the restored tab: written in place, no dialog (the dialog stub is never set)
    assert.equal(pagesOnDisk(copy.path), 7, 'the restored tab saved its edit into the original file');
    assertNoErrorsAfterKill(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

test('crash recovery, Discard: after a force-kill, Discard reloads the original 8 pages', async () => {
  const copy = copyOf(MIXED);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-recover-'));
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await delay(1500);
    await forceKill(s.app);
    s = await launch({ profile });
    const bar = s.win.getByText(/Recovered unsaved edits/);
    // The restored tab shows the recovery bar by itself. If it does not, the file is opened once more.
    try {
      await bar.waitFor({ timeout: 20000 });
    } catch {
      await s.setDialogAnswer([copy.path]);
      await s.win.keyboard.press('Control+o');
      await bar.waitFor({ timeout: 30000 });
    }
    await showPanel(s.win, 'Thumbnails');
    await s.win.getByRole('button', { name: 'Discard', exact: true }).click();
    await waitForCount(s.win, 8);
    assert.equal(await isDirty(s.win), false, 'Discard leaves no unsaved edits');
    assertNoErrorsAfterKill(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

test('disk change: a file replaced outside the app shows the bar, and Reload shows the new file', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    copyFileSync(fixture(MARGINS), copy.path);
    const bar = s.win.getByText('This file changed on disk.');
    await bar.waitFor({ timeout: 30000 });
    await s.win.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 2'), { timeoutMs: 30000, label: 'reloaded 2 pages' });
    assert.equal(await bar.count(), 0, 'the bar goes after Reload');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('disk change: "Keep my version" keeps the 9 pages, and the next save writes them over the new file', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Insert blank page…');
    await s.win.getByRole('dialog', { name: 'Insert pages' }).getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 9);
    copyFileSync(fixture(MARGINS), copy.path);
    const bar = s.win.getByText('This file changed on disk.');
    await bar.waitFor({ timeout: 30000 });
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await waitFor(async () => (await bar.count()) === 0, { timeoutMs: 10000, label: 'bar gone' });
    assert.equal(await pageCount(s.win), 9, 'my 9 pages are still shown');
    await saveNow(s.win);
    assert.equal(pagesOnDisk(copy.path), 9, 'the save writes my 9 pages over the changed file');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('XFA form: the organizer commands are disabled with the spec tooltip', async () => {
  const copy = copyOf(XFA);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([copy.path]);
    await s.win.keyboard.press('Control+o');
    const tip = s.win.locator('[data-tooltip="This form can be viewed but not edited yet."]');
    await waitFor(async () => (await tip.count()) > 0, { timeoutMs: 20000, label: 'XFA tooltip' });
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Save checks the file on disk first (ticket 1.2.2, from the 1.2.1 sign-off). A Save pressed right after another program
// changed the file does not write over that change: the "changed on disk" choice comes first. Sequences on one document.

const CHANGED_TOAST = /Another program changed .+, so nothing was saved\. Keep my version saves your changes over it; Reload discards your changes\./;

/** Inserts a blank page through the palette and the Insert sheet, and waits for the page count. */
async function addBlankPage(s, expectedPages) {
  await palette(s.win, 'Pages: Insert blank page…');
  await s.win.getByRole('dialog', { name: 'Insert pages' }).getByRole('button', { name: 'Apply' }).click();
  await waitForCount(s.win, expectedPages);
}

test('save-time disk check, sequence 1: outside change, Ctrl+S at once, Keep my version, Ctrl+S', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await addBlankPage(s, 9);
    // Another program replaces the file, and Ctrl+S is pressed at once: well inside the 5 s between the periodic checks.
    copyFileSync(fixture(MARGINS), copy.path);
    const outside = readFileSync(copy.path);
    await s.win.keyboard.press('Control+s');
    await s.win.locator('.toast', { hasText: CHANGED_TOAST }).first().waitFor({ timeout: 10000 });
    await s.win.getByText('This file changed on disk.').waitFor({ timeout: 5000 });
    await delay(1500);
    assert.ok(readFileSync(copy.path).equals(outside), "the outside change was not overwritten: the file on disk is still the other program's");
    assert.equal(await isDirty(s.win), true, 'the document is still unsaved');
    assert.equal(await pageCount(s.win), 9, 'my 9 pages are still shown');
    // A second Ctrl+S asks again.
    await s.win.keyboard.press('Control+s');
    await delay(800);
    assert.ok(readFileSync(copy.path).equals(outside), 'a second Ctrl+S does not write either');
    // Keep my version, then Ctrl+S writes my pages over the file.
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await waitFor(async () => (await s.win.getByText('This file changed on disk.').count()) === 0, { timeoutMs: 10000, label: 'bar gone' });
    await saveNow(s.win);
    assert.equal(pagesOnDisk(copy.path), 9, 'now the save writes my 9 pages');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('save-time disk check, sequence 2: outside change, Ctrl+S, Reload, edit, Ctrl+S', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await addBlankPage(s, 9);
    copyFileSync(fixture(MARGINS), copy.path);
    const outside = readFileSync(copy.path);
    await s.win.keyboard.press('Control+s');
    await s.win.locator('.toast', { hasText: CHANGED_TOAST }).first().waitFor({ timeout: 10000 });
    assert.ok(readFileSync(copy.path).equals(outside), 'nothing written');
    // Reload shows the other program's file (2 pages) and drops my unsaved page.
    await s.win.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 2'), { timeoutMs: 30000, label: 'reloaded 2 pages' });
    assert.equal(await isDirty(s.win), false, 'the reloaded document is clean');
    // Edit the reloaded document, then save: it is the file that was loaded, so the save writes at once.
    await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
    await jumpTo(s.win, 0);
    await addBlankPage(s, 3);
    await saveNow(s.win);
    assert.equal(pagesOnDisk(copy.path), 3, 'the reloaded file plus my new page');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('save-time disk check, sequence 3: a failed save, then an outside change, then Ctrl+S', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await addBlankPage(s, 9);
    // The first save fails: the file is read-only.
    chmodSync(copy.path, 0o444);
    await s.win.keyboard.press('Control+s');
    await s.win.locator('.toast', { hasText: /could not be saved/ }).first().waitFor({ timeout: 15000 });
    assert.equal(await isDirty(s.win), true, 'a failed save leaves the document unsaved');
    // Then the file is writable again, and another program replaces it.
    chmodSync(copy.path, 0o666);
    copyFileSync(fixture(MARGINS), copy.path);
    const outside = readFileSync(copy.path);
    await s.win.keyboard.press('Control+s');
    await s.win.locator('.toast', { hasText: CHANGED_TOAST }).first().waitFor({ timeout: 10000 });
    await delay(1000);
    assert.ok(readFileSync(copy.path).equals(outside), "the other program's file was not overwritten after the failed save");
    assert.equal(await isDirty(s.win), true);
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await saveNow(s.win);
    assert.equal(pagesOnDisk(copy.path), 9, 'after Keep my version the save writes my pages');
    assertNoErrors(s);
  } finally {
    await s.close();
    try {
      chmodSync(copy.path, 0o666);
    } catch {
      // The file may already be gone.
    }
    removeCopy(copy);
  }
});

test('save-time disk check: opening the same file again must not hide an outside change (Ctrl+S writes nothing)', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await addBlankPage(s, 9);
    copyFileSync(fixture(MARGINS), copy.path);
    const outside = readFileSync(copy.path);
    // The same file is opened again (a second tab on the open document, as a double-click in Explorer does).
    await s.setDialogAnswer([copy.path]);
    await s.win.keyboard.press('Control+o');
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 2, { timeoutMs: 20000, label: 'second tab' });
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 9'), { timeoutMs: 20000, label: 'the shared document, 9 pages' });
    await s.win.keyboard.press('Control+s');
    await s.win.locator('.toast', { hasText: CHANGED_TOAST }).first().waitFor({ timeout: 10000 });
    await s.win.getByText('This file changed on disk.').waitFor({ timeout: 5000 });
    await delay(1000);
    assert.ok(readFileSync(copy.path).equals(outside), "the other program's file was not overwritten after opening the file again");
    // The bar's buttons say what they do.
    assert.match((await s.win.getByRole('button', { name: 'Reload', exact: true }).getAttribute('title')) ?? '', /discards your changes/);
    assert.match((await s.win.getByRole('button', { name: 'Keep my version', exact: true }).getAttribute('title')) ?? '', /saves your changes/);
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await saveNow(s.win);
    assert.equal(pagesOnDisk(copy.path), 9, 'after Keep my version the save writes my pages');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

const MISSING_BAR = 'This file was moved, renamed or deleted. Save will create it again.';

test('a file deleted by another program: a bar that stays (no toast, no "changed on disk" bar); Save, Dismiss and the return of the bar (1.5.5 D4)', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await addBlankPage(s, 9);
    // Collect every toast text from here on.
    await s.win.evaluate(() => {
      window.__toasts = [];
      new MutationObserver(() => {
        for (const t of document.querySelectorAll('.toast')) if (!window.__toasts.includes(t.textContent)) window.__toasts.push(t.textContent);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    rmSync(copy.path);
    await s.win.getByText(MISSING_BAR).waitFor({ timeout: 20000 });
    assert.equal(await s.win.locator('.doc-bar[role="status"]', { hasText: MISSING_BAR }).count(), 1, 'the bar is a status bar');
    // The bar stays (the watch looks every 5 s), and there is no toast with that text and no "changed on disk" bar.
    await delay(11000);
    assert.equal(await s.win.getByText(MISSING_BAR).count(), 1, 'the bar is still there');
    const toasts = await s.win.evaluate(() => window.__toasts);
    assert.equal(toasts.filter((t) => t.includes('moved')).length, 0, `no toast: ${JSON.stringify(toasts)}`);
    assert.equal(await s.win.getByText('This file changed on disk.').count(), 0, 'no "changed on disk" bar for a missing file');
    assert.equal(existsSync(copy.path), false, 'nothing brought the file back by itself');
    // The bar's Save creates it again, without asking, and the bar goes.
    await s.win.locator('.doc-bar', { hasText: MISSING_BAR }).getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(async () => existsSync(copy.path), { timeoutMs: 20000, label: 'Save created the file again' });
    assert.equal(pagesOnDisk(copy.path), 9, 'with my 9 pages');
    await waitFor(async () => (await s.win.getByText(MISSING_BAR).count()) === 0, { timeoutMs: 10000, label: 'the bar goes after the save' });
    // Delete again: the bar returns. Dismiss hides it; it stays hidden while the file stays gone.
    await delay(6000);
    rmSync(copy.path);
    await s.win.getByText(MISSING_BAR).waitFor({ timeout: 20000 });
    await s.win.locator('.doc-bar', { hasText: MISSING_BAR }).getByRole('button', { name: 'Dismiss', exact: true }).click();
    assert.equal(await s.win.getByText(MISSING_BAR).count(), 0, 'Dismiss hides the bar');
    await delay(11000);
    assert.equal(await s.win.getByText(MISSING_BAR).count(), 0, 'it stays hidden while the file stays gone');
    // Put the file back (seen again by the watch), then delete it again: the bar returns.
    copyFileSync(fixture(MARGINS), copy.path);
    await delay(7000);
    rmSync(copy.path);
    await s.win.getByText(MISSING_BAR).waitFor({ timeout: 20000 });
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('a file opened from the command line and deleted with no edits: the same bar', async () => {
  const copy = copyOf(MIXED);
  const s = await launch({ args: [copy.path] });
  try {
    await s.win.locator('.page-canvas').first().waitFor({ timeout: 30000 });
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 8'), { timeoutMs: 20000, label: 'opened' });
    rmSync(copy.path);
    await s.win.getByText(MISSING_BAR).waitFor({ timeout: 20000 });
    assert.equal(await s.win.getByText('This file changed on disk.').count(), 0, 'no "changed on disk" bar');
    // Save works here even with no unsaved changes.
    await s.win.locator('.doc-bar', { hasText: MISSING_BAR }).getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(async () => existsSync(copy.path), { timeoutMs: 20000, label: 'Save created the file again' });
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('a file changed and then deleted while the "changed on disk" bar is still up: the "moved or deleted" bar replaces it', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    copyFileSync(fixture(MARGINS), copy.path);
    await s.win.getByText('This file changed on disk.').waitFor({ timeout: 30000 });
    rmSync(copy.path);
    await s.win.getByText(MISSING_BAR).waitFor({ timeout: 20000 });
    assert.equal(await s.win.getByText('This file changed on disk.').count(), 0, 'the "changed on disk" bar is replaced (nothing left to reload)');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

// ---- 1.3.1 item 0: the current page after a save (carried from the 1.2.2 Sign-Off) ----------------------------------

/** The page number the thumbnail highlight is on, read from its label. The list is scrolled to show the row. */
async function highlightedThumbnail(win) {
  return win.evaluate(async () => {
    const list = document.querySelector('.thumb-list');
    const label = () => {
      const cur = list.querySelectorAll('.thumb-current');
      return cur.length === 1 ? Number.parseInt(cur[0].querySelector('.thumb-label')?.textContent ?? '', 10) : cur.length;
    };
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    for (let y = 0; y <= max + 1; y += Math.max(100, list.clientHeight * 0.7)) {
      list.scrollTop = Math.min(max, y);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
      const found = label();
      if (found !== 0) return found;
    }
    return 0;
  });
}

test('save after a duplicate, nothing selected: the page box and the thumbnail highlight stay on page 3', async () => {
  const copy = copyOf('outline-6.pdf');
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    // Nothing is selected: Duplicate acts on the current page (page 1), then the page box goes to page 3 by typing.
    await palette(s.win, 'Pages: Duplicate');
    await waitForCount(s.win, 7);
    const box = s.win.locator('footer.status-bar').getByLabel('Go to page');
    await box.fill('3');
    await box.press('Enter');
    await waitFor(async () => (await currentPage(s.win)) === 3, { timeoutMs: 10000, label: 'page 3 is current' });
    assert.equal(await s.win.locator('.thumb[aria-selected="true"]').count(), 0, 'nothing is selected');
    await saveNow(s.win);
    // Give the saved document time to show and the viewer time to settle: a late shift would show up here.
    await delay(1200);
    assert.equal(await currentPage(s.win), 3, 'the page box is still on page 3 after the save');
    assert.equal(await highlightedThumbnail(s.win), 3, 'the thumbnail highlight is still on page 3');
    // A second save changes nothing either (the uids restart each time).
    await palette(s.win, 'Pages: Duplicate');
    await waitForCount(s.win, 8);
    await saveNow(s.win);
    await delay(1200);
    assert.equal(await currentPage(s.win), 3, 'page 3 after a second duplicate and save too');
    assert.equal(await highlightedThumbnail(s.win), 3, 'the highlight is on page 3 after the second save');
    assert.equal(pagesOnDisk(copy.path), 8);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});
