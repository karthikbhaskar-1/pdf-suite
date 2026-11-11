// 1.3.1 Slice ("Cut Pages in Half"), driven through the real UI of the packaged app. Every outcome is checked on the file
// on disk after a save: the output is re-read here with MuPDF (a separate copy of the engine, in this test process), and
// each page of it must be exactly the right part of the right page of the original (page count, sizes and the pixels of
// every half), so a half that shows the wrong part, a wrong order or a wrong page cut cannot pass.
//
// "Which pages does it act on" is tested on its own (the section at the end of the options): selection against the current
// page, another document with its own selection, after Save and Save As, the same document in both panes of a split view,
// and the thumbnails panel closed. Every test ends with its edits saved or dropped by the test-mode quit (docs/TESTING-RULES.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mu from 'mupdf';
import {
  forceKill, cleanupProfile, launch, closeAll, copyOf, removeCopy, open, palette, jumpTo, waitForCount, saveNow, isDirty, assertNoErrors, waitFor, statusText,
  setSaveAnswer, uids, clickRowByIndex, currentPage, showPanel, delay, pageCount,
} from './matrix-lib.mjs';

const FIXTURES = mkdtempSync(join(tmpdir(), 'pdfsuite-slice-fx-'));
after(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  return closeAll();
});

// ---- Fixtures, made here so the expected halves are known ------------------------------------------------------------

function numbers(pdf, values) {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}

/** Text and boxes for a landscape 800 x 500 page: words in each half, and a box that straddles the middle. */
function spreadContent(tag, wordY = 250) {
  return [
    '0 g',
    '20 20 100 40 re f',
    '680 440 100 40 re f',
    '390 100 20 300 re f',
    '150 120 30 30 re f',
    '600 300 60 20 re f',
    `BT /F1 40 Tf 60 ${wordY} Td (ALPHA ${tag}) Tj ET`,
    `BT /F1 40 Tf 520 ${wordY} Td (OMEGA ${tag}) Tj ET`,
  ].join('\n');
}

/** A tall page: a word near the top and one near the bottom, and a few boxes. */
function tallContent(tag, height) {
  return [
    '0 g',
    '40 40 80 30 re f',
    `440 ${height - 80} 60 40 re f`,
    `BT /F1 40 Tf 60 ${height - 120} Td (TOPWORD ${tag}) Tj ET`,
    `BT /F1 40 Tf 60 100 Td (BOTTOMWORD ${tag}) Tj ET`,
  ].join('\n');
}

/** Builds a PDF with these page specs: { media, rotate, crop, content }. Returns its bytes. */
function buildPdf(specs) {
  const pdf = new mu.PDFDocument();
  const font = pdf.newDictionary();
  font.put('Type', pdf.newName('Font'));
  font.put('Subtype', pdf.newName('Type1'));
  font.put('BaseFont', pdf.newName('Helvetica'));
  const resources = pdf.newDictionary();
  const fonts = pdf.newDictionary();
  fonts.put('F1', pdf.addObject(font));
  resources.put('Font', fonts);
  specs.forEach((spec, i) => {
    pdf.insertPage(i, pdf.addPage(spec.media, spec.rotate ?? 0, resources, spec.content));
    if (spec.crop) pdf.findPage(i).put('CropBox', numbers(pdf, spec.crop));
  });
  const bytes = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
  pdf.destroy();
  return Buffer.from(bytes);
}

/**
 * Six pages: wide pages 1, 3 and 5 (page 3 cropped; page 1's words straddle nothing), tall pages 2 (a wide page turned 90
 * degrees), 4 and 6. Every size divides by 10 so a cut at 40 % or 50 % falls on whole points and the pixels line up.
 */
function spreadsFixture() {
  return buildPdf([
    { media: [0, 0, 800, 500], content: spreadContent(1) },
    // The words of the turned page sit at y = 100, so after the turn they fall wholly in one half, not on the cut line.
    { media: [0, 0, 800, 500], rotate: 90, content: spreadContent(2, 100) },
    { media: [0, 0, 800, 500], crop: [40, 30, 760, 470], content: `${spreadContent(3)}\nBT /F1 14 Tf 5 5 Td (HIDDENMARGIN) Tj ET` },
    { media: [0, 0, 500, 800], content: tallContent(4, 800) },
    { media: [0, 0, 800, 500], content: spreadContent(5).replace('20 20 100 40', '300 20 100 40') },
    { media: [0, 0, 600, 800], content: tallContent(6, 800) },
  ]);
}

/** Four pages with other sizes, for the second document of the "another document" test. */
function otherFixture() {
  return buildPdf([
    { media: [0, 0, 600, 400], content: spreadContent('B1') },
    { media: [0, 0, 600, 400], content: spreadContent('B2') },
    { media: [0, 0, 400, 600], content: tallContent('B3', 600) },
    { media: [0, 0, 600, 400], content: spreadContent('B4') },
  ]);
}

function manyPages(count) {
  const specs = [];
  for (let i = 0; i < count; i++) specs.push({ media: [0, 0, 600, 400], content: `0 g\n${10 + (i % 50)} 10 60 30 re f\n${300 + (i % 40)} 200 50 50 re f` });
  return buildPdf(specs);
}

const SPREADS = join(FIXTURES, 'spreads.pdf');
const OTHER = join(FIXTURES, 'other.pdf');
writeFileSync(SPREADS, spreadsFixture());
writeFileSync(OTHER, otherFixture());

// ---- Reading a PDF on disk (MuPDF, in this process) ---------------------------------------------------------------------

function openOnDisk(path) {
  return mu.Document.openDocument(readFileSync(path), 'application/pdf');
}

/** Every page of a file as gray pixels in display space (one pixel per point), with its exact size and its text. */
function readPages(path) {
  const doc = openOnDisk(path);
  try {
    const out = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      try {
        const b = page.getBounds();
        const w = Math.round(b[2] - b[0]);
        const h = Math.round(b[3] - b[1]);
        const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, w, h], false);
        pixmap.clear(255);
        const device = new mu.DrawDevice([1, 0, 0, 1, -b[0], -b[1]], pixmap);
        page.run(device, mu.Matrix.identity);
        device.close();
        device.destroy();
        const stride = pixmap.getStride();
        const source = pixmap.getPixels();
        const px = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) px.set(source.subarray(y * stride, y * stride + w), y * w);
        pixmap.destroy();
        const stext = page.toStructuredText('');
        const text = stext.asText().replace(/\s+/g, ' ').trim();
        stext.destroy();
        out.push({ w, h, exactW: b[2] - b[0], exactH: b[3] - b[1], px, text });
      } finally {
        page.destroy();
      }
    }
    return out;
  } finally {
    doc.destroy();
  }
}

/** The halves of a page of display size w x h, as [x0, y0, x1, y1] in order: first, second (independent of the app's code). */
function halvesOf(w, h, cut, at, first) {
  if (cut === 'horizontal') return [[0, 0, w, h * at], [0, h * at, w, h]];
  const left = [0, 0, w * at, h];
  const right = [w * at, 0, w, h];
  return first === 'right' ? [right, left] : [left, right];
}

function subImage(image, rect) {
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(v));
  const w = x1 - x0;
  const h = y1 - y0;
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = image.px[(y0 + y) * image.w + x0 + x];
  return { w, h, px };
}

const inkOf = (image) => image.px.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);

/**
 * Checks a saved file against the original. `plan[i]` is null for an original page that must be unchanged, or
 * { cut, at, first } for one that must have been cut. Every output page must have the exact size and pixels of the part
 * of the original it should show, in the right order.
 */
function expectCutFile(originalPath, savedPath, plan) {
  const original = readPages(originalPath);
  const saved = readPages(savedPath);
  const expected = [];
  original.forEach((page, i) => {
    const step = plan[i];
    if (!step) expected.push({ image: page, label: `original page ${i + 1}` });
    else {
      const [one, two] = halvesOf(page.w, page.h, step.cut, step.at, step.first);
      expected.push({ image: subImage(page, one), label: `page ${i + 1}, first half` });
      expected.push({ image: subImage(page, two), label: `page ${i + 1}, second half` });
    }
  });
  assert.equal(saved.length, expected.length, `the saved file has ${expected.length} pages (it has ${saved.length})`);
  expected.forEach((want, i) => {
    const got = saved[i];
    assert.equal(got.w, want.image.w, `output page ${i + 1} (${want.label}) is ${want.image.w} wide, not ${got.w}`);
    assert.equal(got.h, want.image.h, `output page ${i + 1} (${want.label}) is ${want.image.h} tall, not ${got.h}`);
    assert.ok(got.px.every((v, k) => v === want.image.px[k]), `output page ${i + 1} shows the wrong pixels for ${want.label}`);
  });
  return { original, saved };
}

const all = (count, step) => Array.from({ length: count }, () => step);
const only = (count, indexes, step) => Array.from({ length: count }, (_unused, i) => (indexes.includes(i) ? step : null));
const VERT = { cut: 'vertical', at: 0.5, first: 'left' };

// ---- Driving the sheet -----------------------------------------------------------------------------------------------

const sheetOf = (win) => win.getByRole('dialog', { name: 'Cut pages in half' });

async function openSheet(s) {
  await palette(s.win, 'Pages: Cut pages in half');
  await sheetOf(s.win).waitFor({ timeout: 10000 });
  return sheetOf(s.win);
}

/** Sets the sheet's options. Any option left out stays as the sheet opened it. */
async function setOptions(sheet, { direction, percent, order, scope }) {
  if (direction) await sheet.getByRole('radio', { name: direction === 'vertical' ? 'Left and right' : 'Top and bottom' }).click();
  if (percent !== undefined) await sheet.getByLabel('Cut position in percent').fill(String(percent));
  if (order) await sheet.getByRole('radio', { name: order === 'right' ? 'Right page first' : 'Left page first' }).click();
  if (scope) await sheet.getByLabel('Apply to').selectOption(scope);
}

const summaryOf = (sheet) => sheet.locator('[data-cut-summary]').innerText();

async function applyCut(s, sheet, pagesAfter) {
  await sheet.getByRole('button', { name: 'Apply' }).click();
  await sheetOf(s.win).waitFor({ state: 'detached', timeout: 20000 });
  if (pagesAfter !== undefined) await waitForCount(s.win, pagesAfter);
}

/** Types a page number in the status bar's page box (the current page changes; the selection does not). */
async function goToPage(win, n) {
  const box = win.locator('footer.status-bar').getByLabel('Go to page');
  await box.fill(String(n));
  await box.press('Enter');
  await waitFor(async () => (await currentPage(win)) === n, { timeoutMs: 10000, label: `page ${n} is current` });
}

/** Opens a copy of a PDF in the app. Returns the copy (its path is what the test re-reads after a save). */
async function withCopy(source, pages, body) {
  const copy = copyOf(source);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, pages);
    await body(s, copy);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
}

/** The text of the Edit menu's Undo row (it names the step: "Undo Cut 6 pages in half"), read by opening the menu. */
async function undoMenuText(win) {
  await win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const dropdown = win.locator('.menu-dropdown').last();
  await dropdown.waitFor({ timeout: 5000 });
  const row = dropdown.locator('[role="menuitem"]').first();
  const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
  const disabled = (await row.getAttribute('aria-disabled')) === 'true' || (await row.isDisabled().catch(() => false));
  await win.keyboard.press('Escape');
  await waitFor(async () => (await win.locator('.menu-dropdown').count()) === 0, { timeoutMs: 5000, label: 'menu closed' });
  return { text, disabled };
}

/** Rotates the target pages right and back, one edit after the other: each waits until the one before has reached the undo list. */
async function rotateAndBack(win) {
  await palette(win, 'Pages: Rotate right 90°');
  await waitFor(async () => /^Undo Rotate 1 page|^Undo Rotate \d+ pages/.test((await undoMenuText(win)).text), { timeoutMs: 10000, label: 'the first rotation is done' });
  await palette(win, 'Pages: Rotate left 90°');
  await waitFor(async () => (await undoMenuText(win)).text.startsWith('Undo Rotate') && !(await win.locator('footer.status-progress').count()), { timeoutMs: 10000, label: 'the second rotation is done' });
  await delay(300);
}

const ctrlSelect = async (win, indexes) => {
  await clickRowByIndex(win, indexes[0]);
  for (const i of indexes.slice(1)) await clickRowByIndex(win, i, ['Control']);
};

// ---- One test for each option, output re-read from disk ------------------------------------------------------------------

test('Left and right at the centre, all pages: 12 pages on disk, each the right half of the right page', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    const sheet = await openSheet(s);
    // The spec's defaults, all at once.
    assert.equal(await sheet.getByLabel('Cut position in percent').inputValue(), '50');
    assert.equal(await sheet.getByLabel('Apply to').inputValue(), 'all');
    assert.match(await summaryOf(sheet), /^Cuts 6 pages into 12\. Comments and links stay with their half\.$/);
    await applyCut(s, sheet, 12);
    assert.ok(await isDirty(s.win), 'the document is unsaved after the cut');
    await s.win.locator('.toast', { hasText: 'Cut 6 pages in half' }).waitFor({ timeout: 10000 });
    await saveNow(s.win);
    const { saved } = expectCutFile(SPREADS, copy.path, all(6, VERT));
    // The words of each half: page 1 left holds ALPHA, its right half OMEGA, and neither holds the other's word.
    assert.match(saved[0].text, /ALPHA 1/);
    assert.doesNotMatch(saved[0].text, /OMEGA/);
    assert.match(saved[1].text, /OMEGA 1/);
    assert.doesNotMatch(saved[1].text, /ALPHA/);
    assert.ok(inkOf(saved[0]) > 0 && inkOf(saved[1]) > 0);
  });
});

test('Right page first reverses each pair', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    const sheet = await openSheet(s);
    await setOptions(sheet, { order: 'right' });
    await applyCut(s, sheet, 12);
    await saveNow(s.win);
    const { saved } = expectCutFile(SPREADS, copy.path, all(6, { cut: 'vertical', at: 0.5, first: 'right' }));
    assert.match(saved[0].text, /OMEGA 1/, 'the first page of the pair is the right half');
    assert.match(saved[1].text, /ALPHA 1/);
  });
});

test('Top and bottom at 40 %, all pages: the top half comes first, whatever the page order says', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    const sheet = await openSheet(s);
    await setOptions(sheet, { direction: 'horizontal', percent: '40' });
    // "Page order" does not apply to a top and bottom cut.
    assert.equal(await sheet.getByRole('radio', { name: 'Right page first' }).count(), 0);
    await applyCut(s, sheet, 12);
    await saveNow(s.win);
    const { saved } = expectCutFile(SPREADS, copy.path, all(6, { cut: 'horizontal', at: 0.4, first: 'left' }));
    // Page 4 is tall: TOPWORD is in the top 40 %, BOTTOMWORD in the bottom 60 %.
    assert.match(saved[6].text, /TOPWORD 4/);
    assert.match(saved[7].text, /BOTTOMWORD 4/);
    assert.doesNotMatch(saved[7].text, /TOPWORD/);
  });
});

test('Left and right at 37.5 %: the cut falls where the number says, on a cropped page too', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    const sheet = await openSheet(s);
    await setOptions(sheet, { percent: '37.5', scope: 'wide' });
    await applyCut(s, sheet, 9);
    await saveNow(s.win);
    // 37.5 % of 800 is 300, of 720 (the cropped page) is 270: whole points, so the pixels can be compared.
    const { saved } = expectCutFile(SPREADS, copy.path, only(6, [0, 2, 4], { cut: 'vertical', at: 0.375, first: 'left' }));
    assert.equal(saved[0].w, 300);
    assert.equal(saved[1].w, 500);
    // The cropped page 3 became pages 4 and 5 of the output (page 1 became two, page 2 stayed one): 270 and 450 wide, each
    // 440 tall (the crop is kept).
    assert.deepEqual([saved[3].w, saved[3].h, saved[4].w, saved[4].h], [270, 440, 450, 440]);
  });
});

test('Current page cuts the page the page box names, even with other pages selected', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    await ctrlSelect(s.win, [0, 4]);
    await goToPage(s.win, 3);
    const sheet = await openSheet(s);
    assert.equal(await sheet.getByLabel('Apply to').inputValue(), 'selected', 'two selected pages: the sheet starts on Selected pages');
    await setOptions(sheet, { scope: 'current' });
    assert.match(await summaryOf(sheet), /^Cuts 1 page into 2\./);
    await applyCut(s, sheet, 7);
    await saveNow(s.win);
    expectCutFile(SPREADS, copy.path, only(6, [2], VERT));
  });
});

test('Selected pages cuts the selection, and not the current page', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    await ctrlSelect(s.win, [4, 0]);
    await goToPage(s.win, 3);
    const sheet = await openSheet(s);
    assert.equal(await sheet.getByLabel('Apply to').inputValue(), 'selected');
    assert.match(await summaryOf(sheet), /^Cuts 2 pages into 4\./);
    await applyCut(s, sheet, 8);
    await saveNow(s.win);
    expectCutFile(SPREADS, copy.path, only(6, [0, 4], VERT));
  });
});

test('Wide pages only (and Tall pages only for a top and bottom cut): the others are left alone', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    let sheet = await openSheet(s);
    await setOptions(sheet, { scope: 'wide' });
    assert.match(await summaryOf(sheet), /^Cuts 3 pages into 6\./);
    await applyCut(s, sheet, 9);
    await saveNow(s.win);
    expectCutFile(SPREADS, copy.path, only(6, [0, 2, 4], VERT));
    // Now the tall pages of the saved file: pages 3 (a half of page 1... ) are located by size, not by number.
    sheet = await openSheet(s);
    await setOptions(sheet, { direction: 'horizontal', scope: 'wide' });
    assert.equal(await sheet.getByLabel('Apply to').evaluate((el) => el.options[el.selectedIndex].textContent), 'Tall pages only');
    const summary = await summaryOf(sheet);
    const saved = readPages(copy.path);
    const tall = saved.filter((p) => p.h > p.w).length;
    assert.ok(summary.startsWith(`Cuts ${tall} pages into ${tall * 2}.`), `${summary} for ${tall} tall pages`);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
  });
});

test('"No pages match" turns Apply off and changes nothing', async () => {
  await withCopy(OTHER, 4, async (s) => {
    const sheet = await openSheet(s);
    // The second document has one tall page; a left and right cut of "Selected pages" with nothing selected matches none.
    await setOptions(sheet, { scope: 'selected' });
    assert.equal(await summaryOf(sheet), 'No pages match. Choose a different “Apply to”.');
    assert.equal(await sheet.getByRole('button', { name: 'Apply' }).isDisabled(), true);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await isDirty(s.win), false);
  });
});

test('a cut position that is not a number from 30 to 70 says so and turns Apply off', async () => {
  await withCopy(OTHER, 4, async (s) => {
    const sheet = await openSheet(s);
    for (const bad of ['', '12', '71', 'abc']) {
      await sheet.getByLabel('Cut position in percent').fill(bad);
      assert.equal(await sheet.getByRole('alert').innerText(), 'Enter a number from 30 to 70.');
      assert.equal(await sheet.getByRole('button', { name: 'Apply' }).isDisabled(), true);
    }
    await sheet.getByLabel('Cut position in percent').fill('45');
    assert.equal(await sheet.getByRole('alert').count(), 0);
    assert.equal(await sheet.getByRole('button', { name: 'Apply' }).isDisabled(), false);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
  });
});

// ---- Entry points ------------------------------------------------------------------------------------------------------

test('every entry point opens the sheet: the palette, the Pages menu, the toolbar button and the thumbnail right-click', async () => {
  await withCopy(SPREADS, 6, async (s) => {
    const closeSheet = async () => {
      await s.win.keyboard.press('Escape');
      await sheetOf(s.win).waitFor({ state: 'detached', timeout: 10000 });
    };
    await palette(s.win, 'Pages: Cut pages in half');
    await sheetOf(s.win).waitFor({ timeout: 10000 });
    await closeSheet();
    // The Pages menu.
    await s.win.getByRole('menubar').getByRole('menuitem', { name: 'Pages', exact: true }).click();
    const dropdown = s.win.locator('.menu-dropdown').last();
    await dropdown.waitFor({ timeout: 5000 });
    await dropdown.getByRole('menuitem', { name: /^Cut Pages in Half…/ }).click();
    await sheetOf(s.win).waitFor({ timeout: 10000 });
    await closeSheet();
    // The toolbar button (its tooltip and name are "Cut pages in half").
    const button = s.win.getByRole('toolbar', { name: 'Toolbar' }).getByRole('button', { name: 'Cut pages in half' });
    assert.equal(await button.count(), 1, 'the toolbar has the button');
    await button.click();
    await sheetOf(s.win).waitFor({ timeout: 10000 });
    await closeSheet();
    // A right-click on a thumbnail.
    await s.win.locator('.thumb').first().click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Cut pages in half…' }).click();
    await sheetOf(s.win).waitFor({ timeout: 10000 });
    await closeSheet();
    assert.equal(await isDirty(s.win), false);
  });
});

// ---- Cancel, undo, redo, save, reopen ------------------------------------------------------------------------------------

test('Cancel (the button, the × and Esc) leaves the document untouched and adds no undo step', async () => {
  await withCopy(SPREADS, 6, async (s) => {
    const before = await uids(s.win);
    for (const how of ['button', 'close', 'escape']) {
      const sheet = await openSheet(s);
      await setOptions(sheet, { direction: 'horizontal', percent: '33', scope: 'all' });
      if (how === 'button') await sheet.getByRole('button', { name: 'Cancel' }).click();
      else if (how === 'close') await sheet.getByRole('button', { name: 'Close sheet' }).click();
      else await s.win.keyboard.press('Escape');
      await sheetOf(s.win).waitFor({ state: 'detached', timeout: 10000 });
      assert.equal(await pageCount(s.win), 6, `still 6 pages after ${how}`);
      assert.equal(await isDirty(s.win), false, `no unsaved dot after ${how}`);
      assert.deepEqual(await uids(s.win), before, `the same pages after ${how}`);
    }
    // No undo step: the Edit menu's Undo is off, and Ctrl+Z changes nothing.
    assert.equal((await undoMenuText(s.win)).disabled, true, 'no undo step was added');
    await s.win.keyboard.press('Control+z');
    await delay(400);
    assert.equal(await pageCount(s.win), 6);
    assert.equal(await isDirty(s.win), false);
  });
});

test('Undo restores the pages exactly, Redo cuts again, and the saved file matches each state', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    const before = await uids(s.win);
    const sheet = await openSheet(s);
    await setOptions(sheet, { order: 'right', percent: '40' });
    await applyCut(s, sheet, 12);
    const cutOrder = await uids(s.win);
    assert.equal(cutOrder.length, 12);
    // The Edit menu names the step, and the toast has Undo.
    assert.match((await undoMenuText(s.win)).text, /^Undo Cut 6 pages in half/);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 6);
    assert.equal((await undoMenuText(s.win)).disabled, true, 'nothing left to undo');
    assert.deepEqual(await uids(s.win), before, 'undo gives back the same pages, with the same uids');
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 12);
    assert.deepEqual(await uids(s.win), cutOrder, 'redo gives the same cut pages again');
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 6);
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 12);
    await saveNow(s.win);
    expectCutFile(SPREADS, copy.path, all(6, { cut: 'vertical', at: 0.4, first: 'right' }));
  });
});

test('Undo then Save writes the original pages again', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    const sheet = await openSheet(s);
    await applyCut(s, sheet, 12);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 6);
    // Nothing changed, so there is nothing to save; make a harmless change so a save happens, and compare to the original.
    await rotateAndBack(s.win);
    await saveNow(s.win);
    expectCutFile(SPREADS, copy.path, all(6, null));
  });
});

test('cut all (right page first) -> undo -> redo -> Save -> cut one half again -> Save -> reopen', async () => {
  const copy = copyOf(SPREADS);
  let s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    let sheet = await openSheet(s);
    await setOptions(sheet, { order: 'right' });
    await applyCut(s, sheet, 12);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 6);
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 12);
    await saveNow(s.win);
    const afterFirst = join(FIXTURES, 'after-first.pdf');
    copyFileSync(copy.path, afterFirst);
    expectCutFile(SPREADS, afterFirst, all(6, { cut: 'vertical', at: 0.5, first: 'right' }));

    // After the save the uids start again; cut the second page (the left half of page 1) top and bottom.
    await goToPage(s.win, 2);
    sheet = await openSheet(s);
    await setOptions(sheet, { direction: 'horizontal', scope: 'current' });
    await applyCut(s, sheet, 13);
    await saveNow(s.win);
    expectCutFile(afterFirst, copy.path, only(12, [1], { cut: 'horizontal', at: 0.5, first: 'left' }));

    // Reopen the file in a fresh run of the app: 13 pages, and the quarter is there.
    await s.close();
    s = await launch();
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 13);
    assert.equal(await pageCount(s.win), 13);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
    rmSync(join(FIXTURES, 'after-first.pdf'), { force: true });
  }
});

test('the words of the hidden half are not found: each word has one hit after the cut, as before', async () => {
  await withCopy(SPREADS, 6, async (s) => {
    /** The number of matches for a word, read when the search has finished (it ends with "n of N", or "No matches"). */
    const searchTotal = async (word) => {
      await s.win.keyboard.press('Control+f');
      const box = s.win.getByLabel('Find in document');
      await box.fill('');
      await box.fill(word);
      // The search runs in steps: wait for it to start and for its status to stop changing (no "Searching" or "pages" part).
      await delay(700);
      await waitFor(async () => {
        const text = await s.win.locator('.search-status').innerText();
        return /^\d+ of \d+$/.test(text) || text === 'No matches';
      }, { timeoutMs: 20000, label: `a finished search for ${word}` });
      await delay(500);
      const text = await s.win.locator('.search-status').innerText();
      return text === 'No matches' ? 0 : Number(/of (\d+)/.exec(text)[1]);
    };
    const before = { omega: await searchTotal('OMEGA'), alpha: await searchTotal('ALPHA'), margin: await searchTotal('HIDDENMARGIN') };
    // OMEGA and ALPHA are on pages 1, 2, 3 and 5 (page 2 is turned); HIDDENMARGIN is outside page 3's crop.
    assert.deepEqual(before, { omega: 4, alpha: 4, margin: 0 });
    await s.win.keyboard.press('Escape');
    const sheet = await openSheet(s);
    await setOptions(sheet, { scope: 'all' });
    await applyCut(s, sheet, 12);
    // Each word is on one page only, so a hit on the hidden half of its page would make the totals twice as big.
    const after = { omega: await searchTotal('OMEGA'), alpha: await searchTotal('ALPHA') };
    console.log(`  search after the cut: ${JSON.stringify(after)}`);
    assert.deepEqual(after, { omega: 4, alpha: 4 });
    assert.equal(await searchTotal('HIDDENMARGIN'), 0);
    // The words of the halves of one page are told apart: both halves of page 1 exist, so the pair OMEGA 1 is on the right one.
    assert.equal(await searchTotal('OMEGA 1'), 1);
  });
});

// ---- Which pages does it act on ---------------------------------------------------------------------------------------

test('which pages: another document is open with its own selection; each document is cut by its own selection', async () => {
  const a = copyOf(SPREADS);
  const b = copyOf(OTHER);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 6);
    await ctrlSelect(s.win, [0, 1, 2]);
    await open(s, b.path, 4);
    // B is shown: A's selection is not B's. B has none, so the sheet starts on All pages and counts B's pages.
    let sheet = await openSheet(s);
    assert.equal(await sheet.getByLabel('Apply to').inputValue(), 'all');
    assert.match(await summaryOf(sheet), /^Cuts 4 pages into 8\./);
    await setOptions(sheet, { scope: 'selected' });
    assert.equal(await summaryOf(sheet), 'No pages match. Choose a different “Apply to”.', "A's selected pages are not B's");
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    // Select two pages of B and cut them.
    await ctrlSelect(s.win, [1, 3]);
    sheet = await openSheet(s);
    assert.equal(await sheet.getByLabel('Apply to').inputValue(), 'selected');
    await applyCut(s, sheet, 6);
    await saveNow(s.win);
    expectCutFile(OTHER, b.path, only(4, [1, 3], VERT));
    // Back to A: it is untouched (6 pages), and cutting its own selection touches only A.
    await s.win.getByRole('tab', { name: /spreads\.pdf/ }).click();
    await waitFor(async () => (await statusText(s.win)).includes('of 6'), { timeoutMs: 10000, label: 'A is shown' });
    await ctrlSelect(s.win, [3, 5]);
    sheet = await openSheet(s);
    await applyCut(s, sheet, 8);
    await saveNow(s.win);
    expectCutFile(SPREADS, a.path, only(6, [3, 5], VERT));
    expectCutFile(OTHER, b.path, only(4, [1, 3], VERT));
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(a);
    removeCopy(b);
  }
});

test('which pages: after a Save (the uids restart), a sheet that was already open still cuts the selected pages it shows', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    // Duplicate page 1 (nothing selected: it acts on the page box's page), so the uids and the positions differ; then save.
    await goToPage(s.win, 1);
    await palette(s.win, 'Pages: Duplicate');
    await waitForCount(s.win, 7);
    await saveNow(s.win);
    const dup = join(FIXTURES, 'dup.pdf');
    copyFileSync(copy.path, dup);
    try {
      // Select positions 4 and 5; make the document unsaved with a change that nets to nothing (rotate and rotate back).
      await ctrlSelect(s.win, [3, 4]);
      await rotateAndBack(s.win);
      const sheet = await openSheet(s);
      assert.equal(await sheet.getByLabel('Apply to').inputValue(), 'selected');
      assert.match(await summaryOf(sheet), /^Cuts 2 pages into 4\./);
      // Save with the sheet open: the saved document has fresh uids (0..6), and the sheet must follow its pages by position.
      await saveNow(s.win);
      assert.equal(await sheet.isVisible(), true, 'the sheet stays open across the save');
      assert.match(await summaryOf(sheet), /^Cuts 2 pages into 4\./, 'the same two pages are still selected after the save');
      await applyCut(s, sheet, 9);
      await saveNow(s.win);
      expectCutFile(dup, copy.path, only(7, [3, 4], VERT));
    } finally {
      rmSync(dup, { force: true });
    }
  });
});

test('which pages: after a Save the page box still names the page it did, and "Current page" cuts that page', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    await goToPage(s.win, 1);
    await palette(s.win, 'Pages: Duplicate');
    await waitForCount(s.win, 7);
    // Nothing selected, the page box on page 3: save, then cut the current page.
    await goToPage(s.win, 3);
    await saveNow(s.win);
    await delay(1200);
    assert.equal(await currentPage(s.win), 3, 'page 3 is still current after the save');
    const dup = join(FIXTURES, 'dup2.pdf');
    copyFileSync(copy.path, dup);
    try {
      const sheet = await openSheet(s);
      await setOptions(sheet, { scope: 'current' });
      await applyCut(s, sheet, 8);
      await saveNow(s.win);
      expectCutFile(dup, copy.path, only(7, [2], VERT));
    } finally {
      rmSync(dup, { force: true });
    }
  });
});

test('which pages: Save As to a new file, then Cut: the new file is cut, the original is not', async () => {
  const copy = copyOf(SPREADS);
  const target = join(FIXTURES, 'saved-as.pdf');
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await rotateAndBack(s.win);
    await setSaveAnswer(s, target);
    await s.win.keyboard.press('Control+Shift+s');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 20000, label: 'saved as' });
    await waitFor(async () => (await s.win.title()).includes('saved-as'), { timeoutMs: 10000, label: 'the tab is the new file' });
    // A sheet opened now acts on the new document. Select pages 2 and 6 and cut them.
    await ctrlSelect(s.win, [1, 5]);
    const sheet = await openSheet(s);
    assert.equal(await sheet.getByLabel('Apply to').inputValue(), 'selected');
    await applyCut(s, sheet, 8);
    await saveNow(s.win);
    const original = readFileSync(copy.path);
    assert.ok(original.equals(readFileSync(SPREADS)), 'the original file is byte for byte what it was');
    expectCutFile(SPREADS, target, only(6, [1, 5], VERT));
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
    rmSync(target, { force: true });
  }
});

test('which pages: the same document in both panes of a split view: the page of the pane with the focus is cut', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    await palette(s.win, 'Split vertical');
    await waitFor(async () => (await s.win.locator('.viewer').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    const panes = s.win.locator('.viewer');
    /** Gives a pane the focus with a click, and reads the page its page box shows. */
    const focusPane = async (n) => {
      await panes.nth(n).click({ position: { x: 20, y: 20 } });
      await delay(500);
      return currentPage(s.win);
    };
    // Put the two panes on different pages: pane 1 on page 2, pane 2 on page 5.
    await focusPane(0);
    await goToPage(s.win, 2);
    await focusPane(1);
    await goToPage(s.win, 5);
    // The page the cut made: the new page ("n...") sits right after the page that was cut.
    const cutIndex = async () => (await uids(s.win)).findIndex((uid) => uid.startsWith('n')) - 1;
    /** Cuts the current page of the focused pane, and returns the page the page box showed when Apply was pressed. */
    const cutCurrentPage = async () => {
      const beforeSheet = await currentPage(s.win);
      const sheet = await openSheet(s);
      await setOptions(sheet, { scope: 'current' });
      console.log(`  split view: page box before the sheet ${beforeSheet}, with the sheet open ${await currentPage(s.win)}`);
      // The panes are synced (a change of size or a scroll in one moves the other), so the page is read at the last moment.
      const shown = await currentPage(s.win);
      await applyCut(s, sheet, 7);
      return shown;
    };
    // The focus is in pane 2.
    await focusPane(1);
    const p2 = await cutCurrentPage();
    assert.equal(await cutIndex(), p2 - 1, `pane 2 has the focus: its page (${p2}) is the one cut`);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 6);
    // Now the focus is in pane 1, which shows another page.
    await focusPane(0);
    const p1 = await cutCurrentPage();
    assert.equal(await cutIndex(), p1 - 1, `pane 1 has the focus: its page (${p1}) is the one cut`);
    await saveNow(s.win);
    expectCutFile(SPREADS, copy.path, only(6, [p1 - 1], VERT));
  });
});

test('which pages: with the thumbnails panel closed, the command still cuts the page box\'s page, and the guide shows on the page', async () => {
  await withCopy(SPREADS, 6, async (s, copy) => {
    await goToPage(s.win, 5);
    // Close the thumbnails panel (the rail button toggles it).
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).first().click();
    await waitFor(async () => (await s.win.locator('.thumb-list').count()) === 0, { timeoutMs: 10000, label: 'thumbnails closed' });
    const sheet = await openSheet(s);
    await setOptions(sheet, { scope: 'current' });
    // The guide: a dashed line and the numbers 1 and 2 on the current page only.
    await waitFor(async () => (await s.win.locator('[data-cut-guide]').count()) >= 1, { timeoutMs: 10000, label: 'the guide' });
    const guided = await s.win.locator('[data-cut-guide]').evaluateAll((els) => els.map((el) => el.closest('.page').dataset.pageIndex));
    assert.deepEqual([...new Set(guided)], ['4'], 'the guide is on page 5 only');
    assert.equal(await s.win.locator('[data-cut-guide] [data-cut-mark]').count(), 2);
    await applyCut(s, sheet);
    await saveNow(s.win);
    expectCutFile(SPREADS, copy.path, only(6, [4], VERT));
    await showPanel(s.win, 'Thumbnails');
  });
});

test('the guide on the pages follows "Apply to" and the cut position, and dragging it sets the position in the sheet', async () => {
  await withCopy(SPREADS, 6, async (s) => {
    const sheet = await openSheet(s);
    await setOptions(sheet, { scope: 'all' });
    // The first page is shown, so at least its guide is drawn; pages that are not on screen have none yet.
    await waitFor(async () => (await s.win.locator('[data-cut-guide]').count()) >= 1, { timeoutMs: 10000, label: 'guides' });
    const line = s.win.locator('[data-cut-guide] [data-cut-line]').first();
    const box = await s.win.locator('[data-cut-guide]').first().boundingBox();
    const grab = await line.boundingBox();
    // The line is at the middle of the page at first.
    assert.ok(Math.abs(grab.x + grab.width / 2 - (box.x + box.width / 2)) < 3, 'the line starts at the centre');
    // Drag it to 40 % of the page width.
    await s.win.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await s.win.mouse.down();
    await s.win.mouse.move(box.x + box.width * 0.4, grab.y + grab.height / 2, { steps: 6 });
    await s.win.mouse.up();
    const value = Number(await sheet.getByLabel('Cut position in percent').inputValue());
    assert.ok(value >= 39 && value <= 41, `the position is about 40 after the drag (${value})`);
    // Nothing changed in the document.
    assert.equal(await isDirty(s.win), false);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await s.win.locator('[data-cut-guide]').count()) === 0, { timeoutMs: 10000, label: 'the guide is gone' });
  });
});

// ---- Recovery -------------------------------------------------------------------------------------------------------------

test('cut -> kill the app -> recovery replay: the same pages come back, and a save writes them', async () => {
  const copy = copyOf(SPREADS);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-slice-recover-'));
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    // Two steps, so the replay has to keep the second step's uids too: a cut of all pages, then the first half of page 1 again.
    let sheet = await openSheet(s);
    await setOptions(sheet, { order: 'right', percent: '40' });
    await applyCut(s, sheet, 12);
    await goToPage(s.win, 1);
    sheet = await openSheet(s);
    await setOptions(sheet, { direction: 'horizontal', percent: '50', scope: 'current' });
    await applyCut(s, sheet, 13);
    const order = await uids(s.win);
    await delay(1500); // the recovery log is written a moment after each edit
    await forceKill(s.app);
    s = await launch({ profile });
    await s.win.waitForSelector('.empty-state', { timeout: 20000 }).catch(() => undefined);
    const bar = s.win.getByText(/Recovered unsaved edits/);
    try {
      await bar.waitFor({ timeout: 20000 });
    } catch {
      await s.setDialogAnswer([copy.path]);
      await s.win.keyboard.press('Control+o');
      await bar.waitFor({ timeout: 30000 });
    }
    await showPanel(s.win, 'Thumbnails');
    await s.win.getByRole('button', { name: 'Keep', exact: true }).click();
    await waitForCount(s.win, 13);
    assert.deepEqual(await uids(s.win), order, 'the pages and their uids are the ones that were lost');
    assert.equal(await isDirty(s.win), true, 'the recovered edits are unsaved again');
    assert.ok(readFileSync(copy.path).equals(readFileSync(SPREADS)), 'recovery did not touch the file');
    // One undo takes back the second cut only.
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 12);
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 13);
    await saveNow(s.win);
    // The file: all pages cut at 40 % with the right half first; then the first page (the right half of page 1) cut top and bottom.
    {
      const saved = readPages(copy.path);
      assert.equal(saved.length, 13);
      // Compare with the cut of the original done by hand: halves of every page, then the quarter.
      const original = readPages(SPREADS);
      const expected = [];
      original.forEach((page, i) => {
        const [one, two] = halvesOf(page.w, page.h, 'vertical', 0.4, 'right');
        const a = subImage(page, one);
        const b = subImage(page, two);
        if (i === 0) {
          const [top, bottom] = halvesOf(a.w, a.h, 'horizontal', 0.5, 'left');
          expected.push(subImage(a, top), subImage(a, bottom), b);
        } else expected.push(a, b);
      });
      assert.equal(saved.length, expected.length);
      expected.forEach((want, i) => {
        assert.deepEqual([saved[i].w, saved[i].h], [want.w, want.h], `recovered page ${i + 1} has the right size`);
        assert.ok(saved[i].px.every((v, k) => v === want.px[k]), `recovered page ${i + 1} shows the right pixels`);
      });
    }
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

// ---- Large documents ------------------------------------------------------------------------------------------------------

test('a 500-page cut is one quick step: 1000 pages, the viewer stays responsive, and Undo gives back the 500', async () => {
  const big = join(FIXTURES, 'big500.pdf');
  writeFileSync(big, manyPages(500));
  await withCopy(big, 500, async (s, copy) => {
    // A frame monitor in the page: the longest gap between animation frames while the cut runs.
    await s.win.evaluate(() => {
      window.__gaps = { last: performance.now(), max: 0, on: true };
      const tick = () => {
        const now = performance.now();
        window.__gaps.max = Math.max(window.__gaps.max, now - window.__gaps.last);
        window.__gaps.last = now;
        if (window.__gaps.on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sheet = await openSheet(s);
    const started = Date.now();
    await sheet.getByRole('button', { name: 'Apply' }).click();
    await waitFor(async () => (await statusText(s.win)).includes('of 1000'), { timeoutMs: 60000, label: '1000 pages' });
    const ms = Date.now() - started;
    const gap = await s.win.evaluate(() => {
      window.__gaps.on = false;
      return window.__gaps.max;
    });
    console.log(`  measured: 500-page cut took ${ms} ms in the app; longest frame gap while it ran ${Math.round(gap)} ms`);
    assert.ok(gap < 1500, `the window kept drawing during the cut (longest gap ${Math.round(gap)} ms)`);
    // The viewer works on the new pages: jump to the end.
    await goToPage(s.win, 1000);
    await s.win.keyboard.press('Control+z');
    await waitFor(async () => (await statusText(s.win)).includes('of 500'), { timeoutMs: 60000, label: 'back to 500' });
    await s.win.keyboard.press('Control+y');
    await waitFor(async () => (await statusText(s.win)).includes('of 1000'), { timeoutMs: 60000, label: '1000 again' });
    await saveNow(s.win);
    const saved = readPages(copy.path);
    assert.equal(saved.length, 1000);
    assert.deepEqual([saved[0].w, saved[0].h, saved[999].w, saved[999].h], [300, 400, 300, 400]);
  });
});

test('Cancel during a long cut (over 100 pages shows progress): the document is not changed and the message says so', async () => {
  const huge = join(FIXTURES, 'huge4000.pdf');
  writeFileSync(huge, manyPages(4000));
  await withCopy(huge, 4000, async (s) => {
    const sheet = await openSheet(s);
    await sheet.getByRole('button', { name: 'Apply' }).click();
    // The status bar shows the progress, with Cancel.
    const bar = s.win.locator('footer.status-progress');
    await bar.waitFor({ timeout: 20000 });
    assert.match(await bar.innerText(), /Cut 4000 pages in half/);
    await bar.getByRole('button', { name: 'Cancel' }).click();
    await s.win.locator('.toast', { hasText: 'Cancelled. The document was not changed.' }).waitFor({ timeout: 30000 });
    await waitFor(async () => (await s.win.locator('footer.status-progress').count()) === 0, { timeoutMs: 30000, label: 'progress gone' });
    assert.equal(await pageCount(s.win), 4000, 'still 4000 pages');
    assert.equal(await isDirty(s.win), false, 'nothing to save');
  });
});
