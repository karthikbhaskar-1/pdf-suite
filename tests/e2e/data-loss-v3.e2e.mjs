// 1.5.8 review, V3 and V4 data-loss findings, driven through the real UI of the packaged app:
//  1. a split pane (picker or Ctrl+\) that would close a document with unsaved edits asks first (Save / Don't save / Cancel);
//  2. Close others from the tab menu asks once for all the unsaved tabs, and Cancel closes nothing;
//  3. an open From sheet forgets the PDF it was filled from when Ctrl+S replaces the worker (Compare session attached);
//  4. the second document of a restored split gets its crash recovery and its save-time disk check.
// Every test ends with its edits dropped through the prompt or by the test-mode quit (docs/TESTING-RULES.md); temporary files are removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mu from 'mupdf';
import {
  launch, closeAll, copyOf, removeCopy, open, palette, jumpTo, waitForCount, pageCount, saveNow, assertNoErrors, assertNoErrorsAfterKill, waitFor,
  fixture, forceKill, cleanupProfile, delay, showPanel, placeWindow,
} from './matrix-lib.mjs';

const FIXTURES = mkdtempSync(join(tmpdir(), 'pdfsuite-dataloss-fx-'));
after(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  return closeAll();
});

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
  await waitFor(async () => (await prompt(win).count()) === 0, { timeoutMs: 10000, label: 'prompt gone' });
}

/** Makes the pane's document the active one and deletes its current page. */
async function deleteInPane(s, index, expectedPages) {
  await panes(s.win).nth(index).locator('.pane-header').click({ position: { x: 2, y: 2 } });
  await palette(s.win, 'Pages: Delete');
  await waitForCount(s.win, expectedPages);
}

async function splitActive(s) {
  await s.win.keyboard.press('Control+\\');
  await waitFor(async () => (await panes(s.win).count()) === 2, { timeoutMs: 10000, label: 'two panes' });
}

async function pickInPane(s, index, name) {
  await s.win.locator('.pane-header select').nth(index).selectOption({ label: name });
}

// ---- 1. Split: the picker and Ctrl+\ ------------------------------------------------------------------------------------

test('split pickers: both panes switched to B would close A with its edits; the prompt asks, Cancel keeps the pane, Dont save closes it', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(OUTLINE);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await open(s, b.path, 6);
    await tabButton(s.win, MIXED).click();
    await waitFor(async () => (await pageCount(s.win)) === 8, { timeoutMs: 10000, label: 'A shown' });
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    assert.equal(await dots(s.win).count(), 1, 'A has unsaved edits');
    await splitActive(s);

    await pickInPane(s, 0, OUTLINE); // pane 2 still shows A
    await delay(500);
    assert.equal(await prompt(s.win).count(), 0, 'no prompt while pane 2 still shows A');
    await pickInPane(s, 1, OUTLINE); // pane 2 holds A's last reference
    await waitPrompt(s.win, /Save changes to mixed-sizes-rotated\.pdf before closing\?/);
    await answer(s.win, 'Cancel');
    await delay(500);
    assert.equal(await panes(s.win).count(), 2);
    assert.equal(await s.win.locator('.pane-header select').nth(1).locator('option').count(), 2, 'A is still open (it is in the picker)');

    // Pane 2 still shows A: its page count is the edited one.
    await panes(s.win).nth(1).locator('.pane-header').click({ position: { x: 2, y: 2 } });
    await waitFor(async () => (await pageCount(s.win)) === 7, { timeoutMs: 10000, label: 'pane 2 still shows A with 7 pages' });

    await pickInPane(s, 1, OUTLINE);
    await waitPrompt(s.win, /Save changes to mixed-sizes-rotated\.pdf before closing\?/);
    await answer(s.win, "Don't save");
    await waitFor(async () => (await s.win.locator('.pane-header select').nth(1).locator('option').count()) === 1, { timeoutMs: 10000, label: 'A closed' });
    assert.ok(sameBytes(a.path, fixture(MIXED)), "Don't save leaves A's file as it was");
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(a);
    removeCopy(b);
  }
});

test("B's own tab closed, then Ctrl+\\ (close split): B is held only by pane 2 and asks first", async () => {
  const a = copyOf(MIXED);
  const b = copyOf(OUTLINE);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await open(s, b.path, 6);
    await tabButton(s.win, MIXED).click();
    await splitActive(s);
    await pickInPane(s, 1, OUTLINE);
    await deleteInPane(s, 1, 5); // B has an unsaved edit, in pane 2
    // B's own tab closes without a prompt: the split still shows B.
    await s.win.getByRole('button', { name: `Close ${OUTLINE}` }).click();
    await delay(800);
    assert.equal(await prompt(s.win).count(), 0, 'closing the tab of B does not ask: pane 2 still shows it');
    assert.equal(await s.win.getByRole('tab').count(), 1);

    await panes(s.win).nth(0).locator('.pane-header').click({ position: { x: 2, y: 2 } });
    await s.win.keyboard.press('Control+\\');
    await waitPrompt(s.win, /Save changes to outline-6\.pdf before closing\?/);
    await answer(s.win, 'Cancel');
    await delay(500);
    assert.equal(await panes(s.win).count(), 2, 'Cancel keeps the split');

    await s.win.keyboard.press('Control+\\');
    await waitPrompt(s.win, /Save changes to outline-6\.pdf before closing\?/);
    await answer(s.win, "Don't save");
    await waitFor(async () => (await panes(s.win).count()) === 0, { timeoutMs: 10000, label: 'split closed (no pane frames)' });
    assert.ok(sameBytes(b.path, fixture(OUTLINE)), "Don't save leaves B's file as it was");
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(a);
    removeCopy(b);
  }
});

// ---- 2. Close others from the tab menu -----------------------------------------------------------------------------------

test('Close others from the right-click menu: one prompt for both unsaved tabs; Cancel keeps both with their edits', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(OUTLINE);
  const c = copyOf(MARGINS);
  const s = await launch();
  try {
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
    await s.win.getByRole('menuitem', { name: 'Close other tabs', exact: true }).click();
    await waitPrompt(s.win, /Save changes to 2 files before closing\?/);
    await answer(s.win, 'Cancel');
    await delay(500);
    assert.equal(await s.win.getByRole('tab').count(), 3, 'Cancel closes nothing');
    assert.equal(await dots(s.win).count(), 2, 'both tabs keep their edits');

    await tabButton(s.win, MIXED).click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Close other tabs', exact: true }).click();
    await waitPrompt(s.win, /Save changes to 2 files before closing\?/);
    await answer(s.win, "Don't save");
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 1, { timeoutMs: 10000, label: 'others closed' });
    assert.ok(sameBytes(b.path, fixture(OUTLINE)) && sameBytes(c.path, fixture(MARGINS)), "Don't save leaves both files as they were");
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(a);
    removeCopy(b);
    removeCopy(c);
  }
});

// ---- 3. From sheet across Save, with a Compare session --------------------------------------------------------------------

function build(count, box) {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < count; i++) {
    const [x0, y0, x1, y1] = box(i);
    pdf.insertPage(i, pdf.addPage([0, 0, 600, 400], 0, {}, `0 g ${x0} ${y0} ${x1 - x0} ${y1 - y0} re f`));
  }
  const bytes = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
  pdf.destroy();
  return Buffer.from(bytes);
}

const BASE = join(FIXTURES, 'base.pdf');
const OVER = join(FIXTURES, 'overlay-a.pdf');
const OTHER = join(FIXTURES, 'other-source.pdf');
writeFileSync(BASE, build(4, (i) => [40 + 60 * i, 20, 90 + 60 * i, 70]));
writeFileSync(OVER, build(4, (i) => [500 - 80 * i, 300, 550 - 80 * i, 360]));
// The From source: its box is in the top-left corner on every page, where neither the base pages nor the overlay have a mark.
writeFileSync(OTHER, build(4, () => [20, 300, 80, 360]));
const OTHER_AT = [50 / 600, 70 / 400];

async function screenPixel(win, pageIndex, fx, fy) {
  return win.evaluate(({ index, x, y }) => {
    const canvas = document.querySelector(`.page[data-page-index="${index}"] .page-canvas`);
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) return null;
    const cx = Math.floor(x * canvas.width);
    const cy = Math.floor(y * canvas.height);
    const data = canvas.getContext('2d').getImageData(Math.max(0, cx - 1), Math.max(0, cy - 1), 3, 3).data;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2];
    return sum / 27;
  }, { index: pageIndex, x: fx, y: fy });
}

test('Compare session + From sheet + Ctrl+S: the sheet asks for its PDF again, and Insert takes the pages of the file chosen then', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-dataloss-'));
  const path = join(dir, 'doc.pdf');
  copyFileSync(BASE, path);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 4);

    // A Compare session: its overlay is attached to the worker.
    await palette(s.win, 'Pages: Overlay to compare');
    const compare = s.win.getByRole('dialog', { name: 'Overlay to compare' });
    await compare.waitFor({ timeout: 10000 });
    await s.setDialogAnswer([OVER]);
    await compare.getByRole('button', { name: 'Choose a PDF…' }).click();
    await compare.locator('[data-compare-file]').getByText('overlay-a.pdf · 4 pages').waitFor({ timeout: 20000 });

    // An edit, so that Ctrl+S replaces the worker; then the From sheet with a source.
    await jumpTo(s.win, 3);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 3);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Insert pages from a PDF…');
    const from = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
    await from.waitFor({ timeout: 10000 });
    await s.setDialogAnswer([OTHER]);
    await from.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await from.getByText(/other-source\.pdf, 4 pages/).waitFor({ timeout: 20000 });

    await s.win.keyboard.press('Control+s');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) === 0, { timeoutMs: 20000, label: 'saved' });

    // The sheet stays open but no longer holds the old worker's source id.
    await from.getByText('No PDF chosen yet.').waitFor({ timeout: 10000 });
    assert.equal(await from.getByText(/other-source\.pdf/).count(), 0, 'the sheet forgot the file');

    // Choose the file again and insert its page 2 after page 1: the page shown is the source file's, not the overlay's.
    await s.setDialogAnswer([OTHER]);
    await from.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await from.getByText(/other-source\.pdf, 4 pages/).waitFor({ timeout: 20000 });
    await from.getByRole('textbox', { name: 'Page range' }).fill('2');
    await from.getByRole('combobox', { name: 'Position' }).selectOption('after');
    await from.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 4);
    await waitFor(async () => {
      const v = await screenPixel(s.win, 1, OTHER_AT[0], OTHER_AT[1]);
      return v !== null && v < 70;
    }, { timeoutMs: 20000, label: "the inserted page 2 shows the source file's mark" });
    await saveNow(s.win);
    assertNoErrors(s);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 4. Crash recovery and the disk check of a split's second document ------------------------------------------------------

const CHANGED_TOAST = /Another program changed .+, so nothing was saved\./;

test("crash with unsaved edits in pane 2's document: recovery is offered after relaunch, and an outside change then Ctrl+S gives the changed-on-disk choice", async () => {
  const a = copyOf(MIXED);
  const b = copyOf(OUTLINE);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-splitrecover-'));
  let s = await launch({ profile });
  try {
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await open(s, b.path, 6);
    await tabButton(s.win, MIXED).click();
    await splitActive(s);
    await pickInPane(s, 1, OUTLINE);
    // B keeps its own tab (a split is restored only from a tab that shows its second file); the edit is made in pane 2.
    await deleteInPane(s, 1, 5);
    await delay(3000); // the edit log and the session snapshot are written
    await forceKill(s.app);

    s = await launch({ profile });
    await placeWindow(s, { width: 1300, height: 900 });
    await waitFor(async () => (await panes(s.win).count()) === 2, { timeoutMs: 30000, label: 'the split comes back' });
    await panes(s.win).nth(1).locator('.pane-header').click({ position: { x: 2, y: 2 } });
    await s.win.getByText(/Recovered unsaved edits/).waitFor({ timeout: 30000 });
    await showPanel(s.win, 'Thumbnails');
    await s.win.getByRole('button', { name: 'Keep', exact: true }).click();
    await waitForCount(s.win, 5);

    // Another program changes B's file; Ctrl+S in pane 2 must not write over it.
    copyFileSync(fixture(MARGINS), b.path);
    const outside = readFileSync(b.path);
    await s.win.keyboard.press('Control+s');
    await s.win.locator('.toast', { hasText: CHANGED_TOAST }).first().waitFor({ timeout: 10000 });
    await delay(1000);
    assert.ok(readFileSync(b.path).equals(outside), "the outside change was not overwritten by the save of pane 2's document");
    assertNoErrorsAfterKill(s);
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(profile);
    removeCopy(a);
    removeCopy(b);
  }
});
