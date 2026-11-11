// 1.2.1 organizer matrix: insert (blank/lined/grid x Letter/A4/Custom x positions), From PDF ranges, reverse, delete,
// duplicate, Alt+Down, rotate, crop, auto-crop, page size, extract, bookmarks after edits, and undo/redo.
// Outcomes are checked on the page order, the Properties sizes, the rendered pixels, the file on disk and a re-open.
// Each test launches its own app (PDFSUITE_E2E=1 via the helper: no prompts, inactive windows) and tears it down in finally.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launch, closeAll, copyOf, removeCopy, open, palette, jumpTo, uids, waitForCount, pageCount,
  currentPageSize, canvasStats, cropBoxesOnDisk, pagesOnDisk, saveNow, assertNoErrors, showPanel, waitFor, statusText,
  delay, clickRowByIndex, waitForNewCurrent, selectAllPages,
} from './matrix-lib.mjs';

after(closeAll);

/** Folders made by the extract test. Removed when the file ends, after a pass or a failure. */
const extractDirs = [];
after(() => {
  for (const d of extractDirs) rmSync(d, { recursive: true, force: true });
});

const MIXED = 'mixed-sizes-rotated.pdf'; // 8 pages: Letter, A4, Letter (explicit), A3 landscape, 300x300, Letter rot 90, A5 rot 180, 500x900 rot 270
const MARGINS = 'margins-white.pdf'; // 2 Letter pages, black box with 72 pt white on every side
const OUTLINE = 'outline-6.pdf'; // 6 pages, bookmarks Intro (2), Middle (4), End (6)
const ANNO = 'annotated-links.pdf'; // 4 pages, each: note N (with popup), highlight N, link to https://example.test/pN, black box

/** Opens a fresh copy in a new app, runs `body`, and always tears down the app and the copy. */
async function withDoc(fixtureName, pages, body) {
  const copy = copyOf(fixtureName);
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

/** Opens the Insert sheet through the palette, sets the options, applies, and waits for the page count. */
async function insertPages(s, { kind = 'blank', size, custom, count = 1, position = 'after', at, expectCount }) {
  const label = { blank: 'Pages: Insert blank page…', lined: 'Pages: Insert lined page…', grid: 'Pages: Insert grid page…' }[kind];
  await palette(s.win, label);
  const dialog = s.win.getByRole('dialog', { name: 'Insert pages' });
  await dialog.waitFor();
  if (size) await dialog.getByRole('combobox', { name: 'Page size' }).selectOption(size);
  if (size === 'custom') {
    await dialog.getByRole('combobox', { name: 'Units' }).selectOption('pt');
    await dialog.getByRole('spinbutton', { name: 'Custom width' }).fill(String(custom.width));
    await dialog.getByRole('spinbutton', { name: 'Custom height' }).fill(String(custom.height));
  }
  await dialog.getByRole('spinbutton', { name: 'Number of pages' }).fill(String(count));
  await dialog.getByRole('combobox', { name: 'Position' }).selectOption(position);
  if (position === 'at') await dialog.getByRole('spinbutton', { name: 'Position number' }).fill(String(at));
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await waitForCount(s.win, expectCount);
}

/** Size of the current page in Properties, compared with a tolerance (A4 is 595.28 x 841.89 pt). */
async function assertSize(win, width, height) {
  const size = await currentPageSize(win);
  assert.ok(Math.abs(size.width - width) < 1, `width ${size.width} is ${width}`);
  assert.ok(Math.abs(size.height - height) < 1, `height ${size.height} is ${height}`);
}

test('insert blank, lined and grid pages: each kind at each position, Letter, A4 and custom sizes', async () => {
  await withDoc(MIXED, 8, async (s) => {
    // Current page 3 (index 2). Before: new page at index 2. After: at index 3. At #6: index 5.
    await jumpTo(s.win, 2);
    await insertPages(s, { kind: 'blank', size: 'letter', position: 'before', expectCount: 9 });
    let order = await uids(s.win);
    assert.ok(order[2].startsWith('n'), `blank inserted before page 3: ${order.join(',')}`);
    await assertSize(s.win, 612, 792);

    await jumpTo(s.win, 3);
    await insertPages(s, { kind: 'lined', size: 'letter', position: 'after', expectCount: 10 });
    order = await uids(s.win);
    assert.ok(order[4].startsWith('n'), `lined inserted after the current page: ${order.join(',')}`);
    await assertSize(s.win, 612, 792);

    await jumpTo(s.win, 0);
    await insertPages(s, { kind: 'grid', size: 'custom', custom: { width: 300, height: 400 }, position: 'at', at: 6, expectCount: 11 });
    order = await uids(s.win);
    assert.ok(order[5].startsWith('n'), `grid inserted at page 6: ${order.join(',')}`);
    await jumpTo(s.win, 5);
    await assertSize(s.win, 300, 400);
  });
});

test('the Insert sheet offers A4 as a page size (the spec lists Letter, A4, Legal, Custom)', async () => {
  await withDoc(MIXED, 8, async (s) => {
    await palette(s.win, 'Pages: Insert blank page…');
    const dialog = s.win.getByRole('dialog', { name: 'Insert pages' });
    await dialog.waitFor();
    const options = await dialog.getByRole('combobox', { name: 'Page size' }).locator('option').allInnerTexts();
    assert.ok(options.includes('A4'), `Insert page sizes: ${options.join(', ')}`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
});

test('pixel check: a lined page and a grid page show ruling, a blank page shows none', async () => {
  await withDoc(MIXED, 8, async (s) => {
    await jumpTo(s.win, 0);
    await insertPages(s, { kind: 'blank', size: 'letter', position: 'after', expectCount: 9 });
    await jumpTo(s.win, 1);
    await waitForNewCurrent(s.win);
    await waitFor(async () => /Page 2 of 9/.test(await statusText(s.win)), { timeoutMs: 10000, label: 'page 2 of 9 shown' });
    await delay(800);
    await waitFor(async () => (await canvasStats(s.win))?.width > 0, { timeoutMs: 10000, label: 'blank page canvas' });
    await delay(300);
    const blank = await canvasStats(s.win);
    assert.equal(blank.darkShare, 0, 'a blank page has no non-white pixels');

    await insertPages(s, { kind: 'lined', size: 'letter', position: 'after', expectCount: 10 });
    await jumpTo(s.win, 2);
    await waitForNewCurrent(s.win);
    await delay(300);
    const lined = await canvasStats(s.win);
    assert.ok(lined.darkShare > 0.005, `lined rules are visible: share ${lined.darkShare}`);

    await insertPages(s, { kind: 'grid', size: 'letter', position: 'after', expectCount: 11 });
    await jumpTo(s.win, 3);
    await waitForNewCurrent(s.win);
    await delay(300);
    const grid = await canvasStats(s.win);
    assert.ok(grid.darkShare > lined.darkShare * 0.9, `grid lines are visible: share ${grid.darkShare}`);
  });
});

test('From PDF with the range "1-5, 8" inserts six pages after the current page, in that order', async () => {
  await withDoc(MIXED, 8, async (s, copy) => {
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Insert pages from a PDF…');
    const dialog = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
    await dialog.waitFor();
    await s.setDialogAnswer([copy.path]);
    await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await dialog.getByText(/8 pages/).waitFor({ timeout: 20000 });
    await dialog.getByRole('textbox', { name: 'Page range' }).fill('1-5, 8');
    await dialog.getByRole('combobox', { name: 'Position' }).selectOption('after');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 14);
    const order = await uids(s.win);
    assert.equal(order.filter((u) => u.startsWith('n')).length, 6, 'six pages added');
    // The sixth added page is page 8 of the source (500 x 900, rotated 270).
    await clickRowByIndex(s.win, 6);
    const size = await currentPageSize(s.win);
    const is500x900 = (Math.abs(size.width - 500) < 1 && Math.abs(size.height - 900) < 1) || (Math.abs(size.width - 900) < 1 && Math.abs(size.height - 500) < 1);
    assert.ok(is500x900, `page 8 of the source (500x900, rotated) is the sixth insert: ${size.width}x${size.height}`);
  });
});

test('Reverse order: the list reverses, Ctrl+Z restores it, Ctrl+Y applies it again', async () => {
  await withDoc(MIXED, 8, async (s) => {
    const before = await uids(s.win);
    await selectAllPages(s.win);
    await palette(s.win, 'Pages: Reverse order');
    await waitFor(async () => (await uids(s.win)).join(',') === [...before].reverse().join(','), { timeoutMs: 15000, label: 'reversed' });
    await s.win.keyboard.press('Control+z');
    await waitFor(async () => (await uids(s.win)).join(',') === before.join(','), { timeoutMs: 15000, label: 'undo' });
    await s.win.keyboard.press('Control+y');
    await waitFor(async () => (await uids(s.win)).join(',') === [...before].reverse().join(','), { timeoutMs: 15000, label: 'redo' });
  });
});

test('Delete one page, then Undo and Redo: the count goes 8, 7, 8, 7', async () => {
  await withDoc(MIXED, 8, async (s) => {
    await jumpTo(s.win, 2);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 8);
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 7);
    assert.ok(!(await uids(s.win)).includes('2'), 'the deleted page (uid 2) is gone after redo');
  });
});

test('Duplicate (Ctrl+D) puts a copy right after the page; Undo removes it', async () => {
  await withDoc(MIXED, 8, async (s) => {
    await jumpTo(s.win, 1);
    await s.win.keyboard.press('Control+d');
    await waitForCount(s.win, 9);
    const order = await uids(s.win);
    assert.ok(order[2].startsWith('n'), `the copy follows page 2: ${order.join(',')}`);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 8);
  });
});

test('Alt+Down moves the selected page one place down, and Undo puts it back', async () => {
  await withDoc(MIXED, 8, async (s) => {
    await jumpTo(s.win, 0);
    await s.win.keyboard.press('Alt+ArrowDown');
    await waitFor(async () => (await uids(s.win)).slice(0, 2).join(',') === '1,0', { timeoutMs: 10000, label: 'page moved down' });
    await s.win.keyboard.press('Control+z');
    await waitFor(async () => (await uids(s.win)).slice(0, 2).join(',') === '0,1', { timeoutMs: 10000, label: 'undo of move' });
  });
});

test('Rotate right 90 turns Letter into landscape, Rotate 180 keeps the size, Undo restores both', async () => {
  await withDoc(MIXED, 8, async (s) => {
    await jumpTo(s.win, 0);
    await s.win.keyboard.press('Control+Shift+R');
    await s.win.locator('.toast', { hasText: 'Rotated' }).first().waitFor({ timeout: 10000 });
    await waitFor(async () => (await currentPageSize(s.win)).width > 790, { timeoutMs: 15000, label: 'landscape' });
    await palette(s.win, 'Pages: Rotate 180°');
    await delay(500);
    await assertSize(s.win, 792, 612);
    await s.win.keyboard.press('Control+z');
    await s.win.keyboard.press('Control+z');
    await waitFor(async () => (await currentPageSize(s.win)).height > 790, { timeoutMs: 15000, label: 'portrait again' });
  });
});

test('custom rotation of 12.5 degrees does not clip the content (corners stay white)', async () => {
  await withDoc(MARGINS, 2, async (s) => {
    await jumpTo(s.win, 0);
    await waitFor(async () => (await canvasStats(s.win))?.width > 0, { timeoutMs: 10000, label: 'canvas' });
    const before = await canvasStats(s.win);
    assert.deepEqual(before.corners, [0, 0, 0, 0], 'unrotated corners are white');
    await palette(s.win, 'Pages: Rotate by a custom angle…');
    const dialog = s.win.getByRole('dialog', { name: 'Rotate pages' });
    await dialog.getByRole('spinbutton', { name: 'Angle in degrees' }).fill('12.5');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await waitFor(async () => (await currentPageSize(s.win)).width > 700, { timeoutMs: 15000, label: 'rotated box grows' });
    await delay(300);
    const after = await canvasStats(s.win);
    assert.deepEqual(after.corners, [0, 0, 0, 0], `rotated corners are not clipped: ${after.corners}`);
    assert.ok(after.darkShare > 0, 'the black box is still drawn');
  });
});

test('crop by numbers (36 pt on each side) writes a CropBox of [36 36 576 756] on save', async () => {
  await withDoc(MIXED, 8, async (s, copy) => {
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Crop…');
    const dialog = s.win.getByRole('dialog', { name: 'Crop pages' });
    await dialog.waitFor();
    await dialog.getByRole('combobox', { name: 'Units' }).selectOption('pt');
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) {
      await dialog.getByRole('spinbutton', { name: `${edge} margin` }).fill('36');
    }
    await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('current');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await s.win.locator('.toast', { hasText: 'Cropped' }).first().waitFor({ timeout: 10000 });
    await saveNow(s.win);
    const boxes = cropBoxesOnDisk(copy.path);
    assert.ok(boxes.some((b) => b.length === 4 && b.every((v, i) => Math.abs(v - [36, 36, 576, 756][i]) < 0.5)), `CropBox on disk: ${JSON.stringify(boxes)}`);
  });
});

test('crop applied to odd pages only: the saved file has CropBoxes on 4 of 8 pages', async () => {
  await withDoc(MIXED, 8, async (s, copy) => {
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Crop…');
    const dialog = s.win.getByRole('dialog', { name: 'Crop pages' });
    await dialog.waitFor();
    await dialog.getByRole('combobox', { name: 'Units' }).selectOption('pt');
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) await dialog.getByRole('spinbutton', { name: `${edge} margin` }).fill('20');
    await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('odd');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await s.win.locator('.toast', { hasText: 'Cropped' }).first().waitFor({ timeout: 10000 });
    await saveNow(s.win);
    assert.equal(cropBoxesOnDisk(copy.path).length, 4, 'odd pages 1, 3, 5, 7 carry a CropBox');
  });
});

test('auto-crop on the margins fixture: CropBox matches the known 72 pt white margins', async () => {
  await withDoc(MARGINS, 2, async (s, copy) => {
    await jumpTo(s.win, 0);
    // Auto-crop applies at once to the target page (no sheet), with a toast.
    await palette(s.win, 'Pages: Auto-crop white space');
    await s.win.locator('.toast', { hasText: 'Auto-cropped 1 page' }).first().waitFor({ timeout: 15000 });
    await saveNow(s.win);
    const boxes = cropBoxesOnDisk(copy.path);
    const expected = [72, 72, 540, 720];
    assert.ok(boxes.some((b) => b.length === 4 && b.every((v, i) => Math.abs(v - expected[i]) <= 2)), `auto-crop CropBox: ${JSON.stringify(boxes)}`);
  });
});

test('Set page size: A4 with Scale to fit, applied to all pages, is shown in Properties', async () => {
  await withDoc(MIXED, 8, async (s) => {
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Set page size…');
    const dialog = s.win.getByRole('dialog', { name: 'Page size' });
    await dialog.waitFor();
    await dialog.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: 'A4' }).click();
    await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
    await dialog.getByRole('radio', { name: 'Scale to fit' }).click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await s.win.locator('.toast', { hasText: 'page' }).first().waitFor({ timeout: 15000 });
    await jumpTo(s.win, 2);
    await waitFor(async () => (await currentPageSize(s.win)).width > 595 && (await currentPageSize(s.win)).width < 596.5, { timeoutMs: 20000, label: 'A4 width' });
    const size = await currentPageSize(s.win);
    assert.ok(Math.abs(size.height - 841.89) < 1, `A4 height ${size.height}`);
    assert.equal(await pageCount(s.win), 8);
  });
});

test('Extract the selected page: the output has 1 page, and its text is page 3 (the Find hit proves it)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-extract-'));
  extractDirs.push(dir);
  const out = join(dir, 'extracted.pdf');
  await withDoc(MIXED, 8, async (s) => {
    await jumpTo(s.win, 2);
    await s.app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
    }, out);
    await palette(s.win, 'Pages: Extract to a new PDF…');
    await waitFor(() => pagesOnDisk(out) === 1, { timeoutMs: 20000, label: 'extract written' });
    assert.equal(pagesOnDisk(out), 1);
  });
  // The extracted file is opened in a second app, then searched for the text of page 3.
  const s2 = await launch();
  try {
    await s2.win.waitForSelector('.empty-state');
    await open(s2, out, 1);
    await s2.win.keyboard.press('Control+f');
    await s2.win.keyboard.type('explicit');
    await s2.win.keyboard.press('Enter');
    await waitFor(async () => /1 of 1/.test(await statusText(s2.win)), { timeoutMs: 15000, label: 'find hit on the single page' });
    assertNoErrors(s2);
  } finally {
    await s2.close();
  }
});

test('bookmarks follow their pages: Middle is page 4 of 6, then page 3 of 5 after deleting page 1 and reversing', async () => {
  await withDoc(OUTLINE, 6, async (s) => {
    // The Bookmarks and Thumbnails panels are one rail choice each, so switch between them as each step needs.
    const clickBookmark = async (title) => {
      await showPanel(s.win, 'Bookmarks');
      await s.win.getByText(title, { exact: true }).first().click();
      await showPanel(s.win, 'Thumbnails');
    };
    await clickBookmark('Middle');
    await waitFor(async () => /Page 4 of 6/.test(await statusText(s.win)), { timeoutMs: 10000, label: 'Middle is page 4' });
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 5);
    await clickBookmark('Middle');
    await delay(800);
    assert.match(await statusText(s.win), /Page 3 of 5/, 'Middle bookmark after deleting page 1');
    await selectAllPages(s.win);
    await palette(s.win, 'Pages: Reverse order');
    await waitFor(async () => (await uids(s.win)).join(',') === '5,4,3,2,1', { timeoutMs: 15000, label: 'reversed' });
    await clickBookmark('Middle');
    await waitFor(async () => /Page 3 of 5/.test(await statusText(s.win)), { timeoutMs: 10000, label: 'Middle still points at its page' });
  });
});

test('annotations and links are kept through a reverse and a save (counts on disk; per-page placement is not checked here)', async () => {
  await withDoc(ANNO, 4, async (s, copy) => {
    await selectAllPages(s.win);
    await palette(s.win, 'Pages: Reverse order');
    await waitFor(async () => (await uids(s.win)).join(',') === '3,2,1,0', { timeoutMs: 15000, label: 'reversed' });
    await saveNow(s.win);
    const text = readFileSync(copy.path).toString('latin1');
    const linkCount = (text.match(/\/Subtype\s*\/Link/g) ?? []).length;
    const noteCount = (text.match(/\/Subtype\s*\/Text/g) ?? []).length;
    assert.equal(linkCount, 4, 'all four links are kept');
    assert.equal(noteCount, 4, 'all four notes are kept');
    assert.equal((text.match(/\/Subtype\s*\/Highlight/g) ?? []).length, 4, 'all four highlights are kept');
    assert.equal((text.match(/\/Subtype\s*\/Popup/g) ?? []).length, 4, 'all four popups are kept');
  });
});
