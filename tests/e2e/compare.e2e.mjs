// 1.3.4 Overlay to Compare, driven through the real UI of the packaged app. The view is checked on the page canvases the viewer
// really draws (pixels at known places), the result on the file on disk after a save: it is re-read here with MuPDF (a separate
// copy of the engine in this test process), so a wrong page, a wrong place or an overlay that was not saved cannot pass.
//
// "Which pages does it act on" and "which file is the overlay" are tests of their own: selection against the current page, a
// save that swaps the worker, the overlay file changed in the sheet, and Add after Save. Every test ends with its edits saved
// or dropped by the test-mode quit (docs/TESTING-RULES.md); the temporary files are deleted at the end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mu from 'mupdf';
import {
  forceKill, cleanupProfile, launch, closeAll, open, palette, waitForCount, saveNow, isDirty, assertNoErrors, waitFor, statusText,
  clickRowByIndex, delay, placeWindow, newProfileDir,
} from './matrix-lib.mjs';

const FIXTURES = mkdtempSync(join(tmpdir(), 'pdfsuite-compare-fx-'));
after(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  return closeAll();
});

// ---- Fixtures -----------------------------------------------------------------------------------------------------------

/** Pages of 600 x 400 with one black box each. Base page i has its box low on the left (x 40+60i, display y 330..380); overlay
 *  page i has its box high on the right (x 500-80i, display y 40..100), where the base pages are white. */
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

const baseBox = (i) => [40 + 60 * i, 20, 90 + 60 * i, 70];
const overBox = (i) => [500 - 80 * i, 300, 550 - 80 * i, 360];
// Centres as fractions of the page (x from the left, y from the top), for pixels on the screen and in the saved file.
const baseAt = (i) => [(65 + 60 * i) / 600, 355 / 400];
const overAt = (i) => [(525 - 80 * i) / 600, 70 / 400];

const BASE = join(FIXTURES, 'base.pdf');
const OVER = join(FIXTURES, 'overlay-a.pdf');
const OVER2 = join(FIXTURES, 'overlay-b.pdf');
writeFileSync(BASE, build(4, baseBox));
writeFileSync(OVER, build(4, overBox));
// A second overlay file with another look: its box is in the top-left corner on every page.
writeFileSync(OVER2, build(4, () => [20, 300, 80, 360]));
const OVER2_AT = [50 / 600, 70 / 400];

function copyOfBase() {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-compare-'));
  const path = join(dir, 'doc.pdf');
  copyFileSync(BASE, path);
  return { dir, path };
}

// ---- Pixels -------------------------------------------------------------------------------------------------------------

/** The gray pixel mix at a fraction of a page in a saved file (MuPDF, here), as [r, g, b]. */
function filePixel(path, pageIndex, fx, fy) {
  const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    const b = page.getBounds();
    const w = Math.round(b[2] - b[0]);
    const h = Math.round(b[3] - b[1]);
    const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, w, h], true);
    pixmap.clear(255);
    const device = new mu.DrawDevice([1, 0, 0, 1, -b[0], -b[1]], pixmap);
    page.run(device, mu.Matrix.identity);
    device.close();
    const stride = pixmap.getStride();
    const px = pixmap.getPixels();
    const x = Math.min(w - 1, Math.floor(fx * w));
    const y = Math.min(h - 1, Math.floor(fy * h));
    const out = [px[y * stride + x * 4], px[y * stride + x * 4 + 1], px[y * stride + x * 4 + 2]];
    pixmap.destroy();
    return out;
  } finally {
    doc.destroy();
  }
}

const pageCountOnDisk = (path) => {
  const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
};

const isDark = (c) => c[0] < 70 && c[1] < 70 && c[2] < 70;
const isWhite = (c) => c[0] > 235 && c[1] > 235 && c[2] > 235;

/** The pixel of a page canvas on screen at a fraction of the page (an average of 3 x 3), or null when the page is not drawn. */
async function screenPixel(win, pageIndex, fx, fy) {
  return win.evaluate(({ index, x, y }) => {
    const canvas = document.querySelector(`.page[data-page-index="${index}"] .page-canvas`);
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) return null;
    const cx = Math.floor(x * canvas.width);
    const cy = Math.floor(y * canvas.height);
    const data = canvas.getContext('2d').getImageData(Math.max(0, cx - 1), Math.max(0, cy - 1), 3, 3).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < 9; i++) {
      r += data[i * 4];
      g += data[i * 4 + 1];
      b += data[i * 4 + 2];
    }
    return [Math.round(r / 9), Math.round(g / 9), Math.round(b / 9)];
  }, { index: pageIndex, x: fx, y: fy });
}

/** Waits until the pixel of a page on screen satisfies `ok`, and returns it. The page may still be rendering. */
async function expectScreen(win, pageIndex, [fx, fy], ok, label) {
  let last = null;
  await waitFor(async () => {
    last = await screenPixel(win, pageIndex, fx, fy);
    return last !== null && ok(last);
  }, { timeoutMs: 20000, label });
  return last;
}

// ---- Driving the sheet --------------------------------------------------------------------------------------------------

const sheetOf = (win) => win.getByRole('dialog', { name: 'Overlay to compare' });
const barOf = (win) => win.locator('[data-compare-bar]');

/** Opens the sheet through the palette (the spec's words), and returns it. */
async function openSheet(s) {
  await palette(s.win, 'Pages: Overlay to compare');
  await sheetOf(s.win).waitFor({ timeout: 10000 });
  return sheetOf(s.win);
}

/** Chooses an overlay file through the sheet's button and the stubbed Open dialog, and waits until it is attached. */
async function chooseFile(s, sheet, path, name, pages) {
  await s.setDialogAnswer([path]);
  await sheet.getByRole('button', { name: 'Choose a PDF…' }).click();
  await sheet.locator('[data-compare-file]').getByText(`${name} · ${pages} pages`).waitFor({ timeout: 20000 });
}

const toast = (win, text) => win.locator('.toast', { hasText: text });

async function undoMenuText(win) {
  await win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const dropdown = win.locator('.menu-dropdown').last();
  await dropdown.waitFor({ timeout: 5000 });
  const row = dropdown.locator('[role="menuitem"]').first();
  // The row ends with its shortcut (Ctrl+Z); the step's name is what comes before it.
  const text = (await row.innerText()).replace(/\s+/g, ' ').trim().replace(/\s*Ctrl\+\w+$/, '');
  await win.keyboard.press('Escape');
  await waitFor(async () => (await win.locator('.menu-dropdown').count()) === 0, { timeoutMs: 5000, label: 'menu closed' });
  return text;
}

async function withCopy(body, { launchOptions } = {}) {
  const copy = copyOfBase();
  const s = await launch(launchOptions);
  try {
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 4);
    await body(s, copy);
    assertNoErrors(s);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
}

/** Starts a compare on the open document with overlay-a.pdf, and waits until page 1 shows its mark on screen. */
async function startWithOverlay(s, file = OVER, name = 'overlay-a.pdf') {
  const sheet = await openSheet(s);
  await chooseFile(s, sheet, file, name, 4);
  return sheet;
}

// ---- The live view ------------------------------------------------------------------------------------------------------

test('the view puts the overlay on the pages, F8 hides it, each look changes it, thumbnails stay plain, and leaving restores the page', async () => {
  await withCopy(async (s) => {
    // Plain first: no overlay mark where the overlay's box will be.
    await expectScreen(s.win, 0, overAt(0), isWhite, 'page 1 is plain');
    const sheet = await startWithOverlay(s);
    assert.ok(await barOf(s.win).getByText('Comparing with overlay-a.pdf. The overlay is only on screen.').isVisible(), 'the bar says what is compared');
    // Both (Multiply): the overlay's box is black, and the document's own box is still there.
    await expectScreen(s.win, 0, overAt(0), isDark, 'overlay page 1 shows on page 1');
    await expectScreen(s.win, 0, baseAt(0), isDark, 'the page keeps its own box');
    // Page by page: page 2 gets overlay page 2, whose box is 80 points to the left.
    await expectScreen(s.win, 1, overAt(1), isDark, 'overlay page 2 shows on page 2');
    await expectScreen(s.win, 1, overAt(0), isWhite, 'and not overlay page 1');

    // F8 hides the overlay and brings it back, from anywhere (here the focus is in the sheet's button).
    await s.win.keyboard.press('F8');
    await expectScreen(s.win, 0, overAt(0), isWhite, 'F8 hides the overlay');
    assert.equal(await sheet.getByRole('checkbox', { name: 'Show overlay' }).isChecked(), false);
    await s.win.keyboard.press('F8');
    await expectScreen(s.win, 0, overAt(0), isDark, 'F8 shows it again');

    // The thumbnails never carry the overlay.
    const thumbHasOverlay = await s.win.evaluate(([fx, fy]) => {
      const canvas = document.querySelector('.thumb canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const data = canvas.getContext('2d').getImageData(Math.floor(fx * canvas.width), Math.floor(fy * canvas.height), 1, 1).data;
      return data[0] < 100;
    }, overAt(0));
    assert.equal(thumbHasOverlay, false, 'the thumbnail of page 1 has no overlay mark');

    // See-through at 50 %: a mid gray.
    await sheet.getByRole('radio', { name: 'See-through' }).click();
    const gray = await expectScreen(s.win, 0, overAt(0), (c) => c[0] > 90 && c[0] < 170 && Math.abs(c[0] - c[1]) < 12, 'See-through is a mid gray');
    assert.ok(gray[0] > 90 && gray[0] < 170);
    await sheet.getByLabel('Opacity in percent').fill('100');
    await expectScreen(s.win, 0, overAt(0), isDark, 'See-through at 100 % is black');
    await sheet.getByLabel('Opacity in percent').fill('0');
    await expectScreen(s.win, 0, overAt(0), isWhite, 'See-through at 0 % shows nothing');

    // Differences: overlay-only ink is blue-green, the document's own ink is red, and Add is off with the spec's words.
    await sheet.getByRole('radio', { name: 'Differences' }).click();
    await expectScreen(s.win, 0, overAt(0), (c) => c[0] < 60 && c[1] > 190 && c[2] > 190, 'overlay-only ink is cyan');
    await expectScreen(s.win, 0, baseAt(0), (c) => c[0] > 190 && c[1] < 60 && c[2] < 60, 'the page\'s own ink is red');
    await sheet.getByText('Red: only in this document. Blue-green: only in the overlay. Black: in both.').waitFor();
    assert.equal(await sheet.getByRole('button', { name: 'Add overlay to pages' }).isDisabled(), true);
    await sheet.getByText('“Differences” is for viewing only. Choose Both or See-through to add the overlay to the pages.').first().waitFor();
    await sheet.getByRole('radio', { name: 'Both' }).click();
    await expectScreen(s.win, 0, overAt(0), isDark, 'Both again');

    // Nudging moves it: 50 pt to the left puts the box off its spot.
    await sheet.getByLabel('Units').selectOption('pt');
    await sheet.getByLabel('Across').fill('-50');
    await expectScreen(s.win, 0, overAt(0), isWhite, 'moved away from its spot');
    await expectScreen(s.win, 0, [(525 - 50) / 600, 70 / 400], isDark, 'and it is 50 points to the left');
    await sheet.getByRole('button', { name: 'Reset' }).click();
    await expectScreen(s.win, 0, overAt(0), isDark, 'reset');

    // [»] hides the sheet and keeps comparing; Show settings brings it back; Leave compare restores the plain page.
    await sheet.getByRole('button', { name: 'Hide settings' }).click();
    await sheet.waitFor({ state: 'detached', timeout: 5000 });
    await expectScreen(s.win, 0, overAt(0), isDark, 'still comparing with the sheet hidden');
    await barOf(s.win).getByRole('button', { name: 'Show settings' }).click();
    await sheetOf(s.win).waitFor({ timeout: 5000 });
    await barOf(s.win).getByRole('button', { name: 'Leave compare' }).click();
    await barOf(s.win).waitFor({ state: 'detached', timeout: 5000 });
    await expectScreen(s.win, 0, overAt(0), isWhite, 'leaving restores the plain page');
    await expectScreen(s.win, 0, baseAt(0), isDark, 'with its own box');
    assert.equal(await isDirty(s.win), false, 'the view alone does not change the document');
    // Esc leaves too.
    await openSheet(s);
    await s.win.keyboard.press('Escape');
    await sheetOf(s.win).waitFor({ state: 'detached', timeout: 5000 });
    await barOf(s.win).waitFor({ state: 'detached', timeout: 5000 });
  });
});

test('the right file is the overlay after the user changes it in the sheet', async () => {
  await withCopy(async (s) => {
    const sheet = await startWithOverlay(s);
    await expectScreen(s.win, 0, overAt(0), isDark, 'the first file shows');
    await chooseFile(s, sheet, OVER2, 'overlay-b.pdf', 4);
    await expectScreen(s.win, 0, OVER2_AT, isDark, 'the second file shows');
    await expectScreen(s.win, 0, overAt(0), isWhite, 'and the first one no longer does');
    assert.ok(await barOf(s.win).getByText(/overlay-b\.pdf/).isVisible());
    await sheet.getByRole('button', { name: 'Leave compare' }).first().click();
  });
});

// ---- Add overlay to pages -----------------------------------------------------------------------------------------------

test('Add to all matched pages: one undo step, saved on disk on every page, undo, redo, save again', async () => {
  await withCopy(async (s, copy) => {
    const sheet = await startWithOverlay(s);
    await sheet.getByLabel('Add to').selectOption('all');
    await sheet.getByText('4 pages would get an overlay page.').waitFor();
    await sheet.getByRole('button', { name: 'Add overlay to pages' }).click();
    await toast(s.win, 'Added the overlay to 4 pages').waitFor({ timeout: 20000 });
    // The compare ends, the document is unsaved, and the Edit menu names the step.
    await barOf(s.win).waitFor({ state: 'detached', timeout: 5000 });
    assert.ok(await isDirty(s.win));
    assert.equal(await undoMenuText(s.win), 'Undo Add overlay to 4 pages');
    await expectScreen(s.win, 2, overAt(2), isDark, 'page 3 shows overlay page 3 for good');
    await saveNow(s.win);
    assert.equal(pageCountOnDisk(copy.path), 4);
    for (let i = 0; i < 4; i++) {
      assert.ok(isDark(filePixel(copy.path, i, ...overAt(i))), `saved page ${i + 1} holds overlay page ${i + 1}`);
      assert.ok(isDark(filePixel(copy.path, i, ...baseAt(i))), `saved page ${i + 1} keeps its own box`);
      if (i > 0) assert.ok(isWhite(filePixel(copy.path, i, ...overAt(i - 1))), `saved page ${i + 1} does not hold overlay page ${i}`);
    }
    // Undo is a step of its own after the save? The save spends the history (a saved document starts clean), so edit again.
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await undoMenuText(s.win)).startsWith('Undo Rotate'), { timeoutMs: 10000, label: 'rotate done' });
    await s.win.keyboard.press('Control+z');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 10000, label: 'undone' });
    await expectScreen(s.win, 0, overAt(0), isDark, 'the overlay stays after the undo of a later step');
    await saveNow(s.win).catch(() => undefined);
    for (let i = 0; i < 4; i++) assert.ok(isDark(filePixel(copy.path, i, ...overAt(i))), `page ${i + 1} still holds its overlay after a second save`);
  });
});

test('S8 and S9: compare, delete a page, Save (the worker swaps), the overlay is still shown, Add, undo, redo, Save, Save again, reopen', async () => {
  await withCopy(async (s, copy) => {
    const sheet = await startWithOverlay(s);
    await expectScreen(s.win, 0, overAt(0), isDark, 'compare is on');
    // Delete page 2 of the document (the sheet's current page is page 1: go to page 2 by the page box).
    const box = s.win.locator('footer.status-bar').getByLabel('Go to page');
    await box.fill('2');
    await box.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 2 of 4'), { timeoutMs: 10000, label: 'page 2' });
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 3);
    assert.ok(await barOf(s.win).isVisible(), 'deleting a page does not leave the compare');
    // Page 2 is now the old page 3: it gets overlay page 2 (page by page, by position).
    await expectScreen(s.win, 1, overAt(1), isDark, 'the overlay follows the pages by position');
    // Save: the worker is swapped. The overlay is attached again and is still shown.
    await saveNow(s.win);
    assert.equal(pageCountOnDisk(copy.path), 3);
    assert.ok(await barOf(s.win).isVisible(), 'the compare survives the save');
    await expectScreen(s.win, 0, overAt(0), isDark, 'the overlay is shown again after the save');
    await expectScreen(s.win, 1, overAt(1), isDark, 'on every page');
    // Add to the current page (page 2 is current after the delete moved the view), then undo, redo, save twice.
    await sheetOf(s.win).waitFor({ timeout: 5000 }).catch(async () => barOf(s.win).getByRole('button', { name: 'Show settings' }).click());
    const again = sheetOf(s.win);
    await again.waitFor({ timeout: 5000 });
    await again.getByLabel('Add to').selectOption('all');
    await again.getByRole('button', { name: 'Add overlay to pages' }).click();
    await toast(s.win, 'Added the overlay to 3 pages').waitFor({ timeout: 20000 });
    assert.equal(await undoMenuText(s.win), 'Undo Add overlay to 3 pages');
    await s.win.keyboard.press('Control+z');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 10000, label: 'undone' });
    await expectScreen(s.win, 0, overAt(0), isWhite, 'undo takes the overlay off');
    await s.win.keyboard.press('Control+y');
    await waitFor(async () => isDirty(s.win), { timeoutMs: 10000, label: 'redone' });
    await expectScreen(s.win, 0, overAt(0), isDark, 'redo puts it back');
    await saveNow(s.win);
    const first = readFileSync(copy.path);
    for (let i = 0; i < 3; i++) assert.ok(isDark(filePixel(copy.path, i, ...overAt(i))), `saved page ${i + 1} holds its overlay page`);
    // Save again with no change in between (nothing to save: the dot is off), then edit nothing and reopen.
    await saveNow(s.win).catch(() => undefined);
    assert.deepEqual(readFileSync(copy.path), first, 'a second save changes nothing');
    assert.equal(pageCountOnDisk(copy.path), 3);
  });
});

// ---- Which pages ------------------------------------------------------------------------------------------------------------

test('which pages does it act on: the selection, the current page, and the thumbnails panel closed', async () => {
  await withCopy(async (s, copy) => {
    const sheet = await startWithOverlay(s);
    // Current page (the default): page 1 only.
    await sheet.getByText('1 page would get an overlay page.').waitFor();
    // Select pages 2 and 3 in the thumbnails. "Selected pages" names them, not the current page.
    await clickRowByIndex(s.win, 1);
    await clickRowByIndex(s.win, 2, ['Control']);
    await sheet.getByLabel('Add to').selectOption('selected');
    await sheet.getByText('2 pages would get an overlay page.').waitFor();
    // Close the thumbnails panel: the selection is the document's, not the panel's, so the answer does not change.
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).first().click();
    await s.win.locator('.thumb').first().waitFor({ state: 'detached', timeout: 5000 });
    await sheet.getByText('2 pages would get an overlay page.').waitFor();
    await sheet.getByRole('button', { name: 'Add overlay to pages' }).click();
    await toast(s.win, 'Added the overlay to 2 pages').waitFor({ timeout: 20000 });
    await saveNow(s.win);
    // Pages 2 and 3 hold their overlay; pages 1 and 4 do not.
    assert.ok(isWhite(filePixel(copy.path, 0, ...overAt(0))), 'page 1 was not selected');
    assert.ok(isDark(filePixel(copy.path, 1, ...overAt(1))), 'page 2 holds overlay page 2');
    assert.ok(isDark(filePixel(copy.path, 2, ...overAt(2))), 'page 3 holds overlay page 3');
    assert.ok(isWhite(filePixel(copy.path, 3, ...overAt(3))), 'page 4 was not selected');
  });
});

test('which pages: one overlay page on every page, and a page with no partner stays plain', async () => {
  await withCopy(async (s, copy) => {
    const sheet = await startWithOverlay(s);
    // Overlay page 3 on every page.
    await sheet.getByRole('radio', { name: 'Same overlay page on every page' }).click();
    await sheet.getByRole('textbox', { name: 'Overlay page on every page' }).fill('3');
    await expectScreen(s.win, 0, overAt(2), isDark, 'overlay page 3 is on page 1');
    await expectScreen(s.win, 3, overAt(2), isDark, 'and on page 4');
    await sheet.getByLabel('Add to').selectOption('all');
    await sheet.getByRole('button', { name: 'Add overlay to pages' }).click();
    await toast(s.win, 'Added the overlay to 4 pages').waitFor({ timeout: 20000 });
    await saveNow(s.win);
    for (let i = 0; i < 4; i++) assert.ok(isDark(filePixel(copy.path, i, ...overAt(2))), `saved page ${i + 1} holds overlay page 3`);
    // One copy of the overlay page's drawing: the file did not grow by four copies of it.
    const text = readFileSync(copy.path).toString('latin1');
    assert.equal((text.match(/\/Subtype\s*\/Form/g) ?? []).length, 1, 'the overlay page is stored once');
  });
});

// ---- Recovery ---------------------------------------------------------------------------------------------------------------

test('S10: an added overlay that was not saved comes back after the app is killed (replayed from its stash)', async () => {
  const copy = copyOfBase();
  const profile = newProfileDir();
  try {
    const s = await launch({ profile });
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 4);
    const sheet = await startWithOverlay(s);
    await sheet.getByLabel('Add to').selectOption('all');
    await sheet.getByRole('button', { name: 'Add overlay to pages' }).click();
    await toast(s.win, 'Added the overlay to 4 pages').waitFor({ timeout: 20000 });
    await delay(1500); // the recovery log is written a moment after the edit
    await forceKill(s.app);
    await waitFor(async () => s.app.process().exitCode !== null || s.app.process().signalCode !== null, { timeoutMs: 15000, label: 'app exit after kill' }).catch(() => undefined);

    const r = await launch({ profile });
    try {
      await placeWindow(r, { width: 1300, height: 900 });
      // The file is reopened by the session restore, and its edits are replayed from the log and the stash.
      await r.win.locator('.info-bar', { hasText: 'Recovered unsaved edits' }).waitFor({ timeout: 30000 });
      await expectScreen(r.win, 1, overAt(1), isDark, 'the recovered page 2 holds overlay page 2');
      await expectScreen(r.win, 1, baseAt(1), isDark, 'and its own box');
      await r.win.getByRole('button', { name: 'Keep', exact: true }).click();
      await saveNow(r.win);
      for (let i = 0; i < 4; i++) assert.ok(isDark(filePixel(copy.path, i, ...overAt(i))), `saved page ${i + 1} holds its overlay`);
      assertNoErrors(r);
    } finally {
      await r.close();
    }
  } finally {
    rmSync(copy.dir, { recursive: true, force: true });
    cleanupProfile(profile);
  }
});
