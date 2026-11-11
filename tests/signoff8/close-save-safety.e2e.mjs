// Sign-off 8 (Version 1, 1.5 audit): four sequences the e2e suite does not run, each read back from disk.
//  1. Another program changes the file, then the tab is closed at once and the prompt's Save is chosen: nothing is written
//     over the other program's file, and the tab stays open with its edit.
//  2. "Close tabs to the right" with two unsaved tabs, choice Save: both files are written, the left tab stays.
//  3. Window close while a document with edits is held only by the second split pane (its own tab is closed): the prompt asks;
//     Cancel keeps the window and the edit; Don't save leaves the file as it was.
//  4. Crash with an unsaved edit, the file is replaced by another program before the relaunch: the edit is NOT replayed onto
//     the other file, a bar says so, and the file on disk is untouched.
// Every test ends through a prompt choice or the test-mode quit (docs/TESTING-RULES.md). Temporary files are removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launch, closeAll, copyOf, removeCopy, open, palette, waitForCount, pageCount, pagesOnDisk, assertNoErrors, waitFor,
  fixture, forceKill, cleanupProfile, delay, placeWindow, jumpTo,
} from '../e2e/matrix-lib.mjs';

after(() => closeAll());

const MIXED = 'mixed-sizes-rotated.pdf'; // 8 pages
const OUTLINE = 'outline-6.pdf'; // 6 pages
const MARGINS = 'margins-white.pdf'; // 2 pages
const sameBytes = (a, b) => readFileSync(a).equals(readFileSync(b));
const prompt = (win) => win.getByRole('alertdialog');
const tabButton = (win, name) => win.getByRole('tab', { name, exact: true });
const dots = (win) => win.locator('.tab-dirty');
const panes = (win) => win.locator('.pane-frame');

async function waitPrompt(win, text) {
  await prompt(win).waitFor({ timeout: 10000 });
  assert.match(await prompt(win).innerText(), text);
}
async function answer(win, name) {
  await prompt(win).getByRole('button', { name, exact: true }).click();
  await waitFor(async () => (await prompt(win).count()) === 0, { timeoutMs: 20000, label: 'prompt gone' });
}
async function requestClose(s) {
  await s.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close();
  });
}

test('1. outside change, then tab close and Save from the prompt: the other file is not overwritten', async () => {
  const a = copyOf(MIXED);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1200, height: 850 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    // Another program replaces the file (different size), and the user closes the tab straight away.
    copyFileSync(fixture(OUTLINE), a.path);
    await s.win.getByRole('button', { name: `Close ${MIXED}` }).click();
    await waitPrompt(s.win, /Save changes to mixed-sizes-rotated\.pdf before closing\?/);
    await answer(s.win, 'Save');
    await delay(1500);
    assert.ok(sameBytes(a.path, fixture(OUTLINE)), 'the file on disk is still the version of the other program');
    assert.equal(await s.win.getByRole('tab').count(), 1, 'the tab stays open');
    assert.equal(await dots(s.win).count(), 1, 'the edit is still unsaved');
    assert.equal(await pageCount(s.win), 7, 'the edited document is still shown');
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).waitFor({ timeout: 10000 });
  } finally {
    await s.close();
    removeCopy(a);
  }
});

test('2. Close tabs to the right, choice Save: both unsaved files are written, the left tab stays', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(OUTLINE);
  const c = copyOf(MARGINS);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1200, height: 850 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await open(s, b.path, 6);
    await open(s, c.path, 2);
    await tabButton(s.win, OUTLINE).click();
    await waitFor(async () => (await pageCount(s.win)) === 6, { timeoutMs: 10000, label: 'B shown' });
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 5);
    await tabButton(s.win, MARGINS).click();
    await waitFor(async () => (await pageCount(s.win)) === 2, { timeoutMs: 10000, label: 'C shown' });
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 1);
    assert.equal(await dots(s.win).count(), 2);

    await tabButton(s.win, MIXED).click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Close tabs to the right', exact: true }).click();
    await waitPrompt(s.win, /Save changes to 2 files before closing\?/);
    await answer(s.win, 'Cancel');
    await delay(400);
    assert.equal(await s.win.getByRole('tab').count(), 3, 'Cancel closes nothing');
    assert.ok(sameBytes(b.path, fixture(OUTLINE)) && sameBytes(c.path, fixture(MARGINS)), 'Cancel writes nothing');

    await tabButton(s.win, MIXED).click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Close tabs to the right', exact: true }).click();
    await waitPrompt(s.win, /Save changes to 2 files before closing\?/);
    await answer(s.win, 'Save');
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 1, { timeoutMs: 20000, label: 'right tabs closed' });
    assert.equal(pagesOnDisk(b.path), 5, 'B was saved with its deleted page gone');
    assert.equal(pagesOnDisk(c.path), 1, 'C was saved with its deleted page gone');
    assert.ok(sameBytes(a.path, fixture(MIXED)), 'the left file is untouched');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(a);
    removeCopy(b);
    removeCopy(c);
  }
});

test('3. window close with edits in a document held only by split pane 2: the prompt asks; Cancel keeps it', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(OUTLINE);
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } });
  try {
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await open(s, b.path, 6);
    await tabButton(s.win, MIXED).click();
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await panes(s.win).count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    await s.win.locator('.pane-header select').nth(1).selectOption({ label: OUTLINE });
    await panes(s.win).nth(1).locator('.pane-header').click({ position: { x: 2, y: 2 } });
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 5);
    await s.win.getByRole('button', { name: `Close ${OUTLINE}` }).click();
    await delay(800);
    assert.equal(await s.win.getByRole('tab').count(), 1, 'B has no tab of its own now');

    await requestClose(s);
    await waitPrompt(s.win, /Save changes to outline-6\.pdf before closing\?/);
    await answer(s.win, 'Cancel');
    await delay(500);
    assert.equal(await panes(s.win).count(), 2, 'the window and the split stay');
    assert.ok(sameBytes(b.path, fixture(OUTLINE)), 'nothing was written');

    // Leave nothing behind: choose Don't save ourselves.
    await requestClose(s);
    await prompt(s.win).waitFor({ timeout: 10000 });
    await prompt(s.win).getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(1500);
    assert.ok(sameBytes(b.path, fixture(OUTLINE)), "Don't save leaves the file of B as it was");
  } finally {
    await s.close();
    removeCopy(a);
    removeCopy(b);
  }
});

test('4. crash with an edit, file replaced before the relaunch: the edit is not replayed onto the other file', async () => {
  const a = copyOf(MIXED);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-so8-'));
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await delay(1500);
    await forceKill(s.app);
    copyFileSync(fixture(OUTLINE), a.path); // another program replaces the file while the app is down
    s = await launch({ profile });
    await waitFor(async () => (await pageCount(s.win)) === 6, { timeoutMs: 40000, label: 'the replaced file (6 pages) restored in its tab' });
    await delay(2500);
    assert.equal(await pageCount(s.win), 6, 'no page was deleted from the other file');
    assert.equal(await s.win.getByText(/Recovered unsaved edits/).count(), 0, 'the old edit is not offered as recovered');
    const bar = s.win.locator('.info-bar.doc-bar[role="alert"]');
    assert.ok((await bar.count()) > 0, 'a bar says the edits were not restored');
    console.log('bar text:', await bar.first().innerText());
    assert.equal(await dots(s.win).count(), 0, 'the document is clean');
    assert.ok(sameBytes(a.path, fixture(OUTLINE)), 'the file on disk is untouched');
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(a);
  }
});

test('5. an edit shortcut pressed while the close prompt is up does not change a document the prompt is not about', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(OUTLINE);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1200, height: 850 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await open(s, b.path, 6); // B is clean and active
    await s.win.keyboard.press('Control+Shift+W'); // Close All: the prompt is about A only
    await waitPrompt(s.win, /Save changes to mixed-sizes-rotated\.pdf before closing\?/);
    await s.win.keyboard.press('Control+d'); // Duplicate page
    await delay(1200);
    await answer(s.win, 'Cancel');
    await delay(500);
    const pagesOfB = await pageCount(s.win);
    console.log('pages of B after Ctrl+D under the prompt:', pagesOfB, 'dirty dots:', await dots(s.win).count());
    assert.equal(pagesOfB, 6, 'B was not edited behind the prompt');
    assert.equal(await dots(s.win).count(), 1, 'only A is unsaved');
  } finally {
    await s.close();
    removeCopy(a);
    removeCopy(b);
  }
});

test('6. the Delete key pressed while the close prompt is up, then Save: the saved file has only the edits made before the prompt', async () => {
  const a = copyOf(MIXED);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1200, height: 850 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await s.win.getByRole('button', { name: `Close ${MIXED}` }).click();
    await waitPrompt(s.win, /Save changes to mixed-sizes-rotated\.pdf before closing\?/);
    await s.win.keyboard.press('Delete');
    await delay(1200);
    await answer(s.win, 'Save');
    await waitFor(() => pagesOnDisk(a.path) < 8, { timeoutMs: 20000, label: 'saved on close' });
    console.log('pages on disk after Delete under the prompt, then Save:', pagesOnDisk(a.path));
    assert.equal(pagesOnDisk(a.path), 7, 'the key pressed behind the prompt deleted no further page');
  } finally {
    await s.close();
    removeCopy(a);
  }
});
