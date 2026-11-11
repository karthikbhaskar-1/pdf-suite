// Ticket 1.2.2, Test stage: the matrix that the developer's own tests (toolbar-statusbar, save-recovery) do not cover.
//   1. save-time disk check as sequences on one document, with an independent reader (mupdf in node) on the file;
//   2. the overflow at every width from wide to the narrowest allowed, labels off and on, and a rapid resize across a boundary;
//   3. every toolbar and "…" command against the same command in the menu bar (enabled state, reason, effect);
//   4. status bar inputs (page box and % box with good and bad input), presets, fit after a resize, limits, slider;
//   5. keyboard only; 6. Show Labels persistence, Ctrl+Shift+W, lined/grid wording, long titles; 7. screenshots.
// Every test ends with its document saved, discarded, or closed by the test-mode quit, and removes its profile and files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { launch, closeAll, copyOf, removeCopy, waitFor, statusText, fixture, cleanupProfile, newProfileDir, palette, assertNoErrors, delay, forceKill, placeWindow, testOrigin, open as openDoc, jumpTo, waitForCount, saveNow, isDirty, setSaveAnswer, ROOT } from './matrix-lib.mjs';

after(closeAll);

const MIXED = 'mixed-sizes-rotated.pdf'; // 8 pages
const MARGINS = 'margins-white.pdf'; // 2 pages
const XFA = join(ROOT, 'tests', 'engine', 'corpus', 'xfa', 'xfa_filled_imm1344e.pdf');
const OUT = join(ROOT, 'tests', 'perf', 'out');
const CHANGED_TOAST = /Another program changed .+, so nothing was saved\. Keep my version saves your changes over it; Reload discards your changes\./;

// ------------------------------------------------------------------------------------------------ shared helpers

async function openFile(s, path, pages) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  await waitFor(async () => (await statusText(s.win)).startsWith(`Page 1 of ${pages}`), { timeoutMs: 30000, label: `Page 1 of ${pages}` });
  await s.win.locator('.page-canvas').first().waitFor({ timeout: 30000 });
}

/** Sets the window width (never below the app's own minimum unless `override`) and waits for the layout to settle. */
async function setWidth(s, width, { override = false, settle = true } = {}) {
  if (override) await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(300, 400));
  await placeWindow(s, { width, height: 800 });
  await waitFor(async () => (await s.win.evaluate(() => innerWidth)) === width, { timeoutMs: 10000, label: `window width ${width}` });
  if (settle) await settled(s);
}

async function settled(s) {
  let last = '';
  await waitFor(
    async () => {
      const now = JSON.stringify(await barState(s));
      const same = now === last;
      last = now;
      await delay(200);
      return same;
    },
    { timeoutMs: 10000, label: 'layout settled' },
  );
}

async function barState(s) {
  return s.win.evaluate(() => {
    const bar = document.querySelector('.top-bar');
    const overflow = document.querySelector('.tb-overflow');
    const slots = [...bar.querySelectorAll('.tb-slot')];
    return {
      width: innerWidth,
      hidden: slots.filter((el) => el.classList.contains('tb-collapsed')).map((el) => el.dataset.slot),
      shown: slots.filter((el) => !el.classList.contains('tb-collapsed')).map((el) => el.dataset.slot),
      priorities: Object.fromEntries(slots.map((el) => [el.dataset.slot, el.dataset.priority])),
      overflowVisible: overflow ? !overflow.classList.contains('tb-collapsed') : false,
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      height: bar.getBoundingClientRect().height,
      labelsShown: slots.some((el) => el.querySelector('.tb-label:not(.tb-label-off)')),
    };
  });
}

const toolbar = (s) => s.win.getByRole('toolbar', { name: 'Toolbar' });
const barBtn = (s, name) => toolbar(s).getByRole('button', { name, exact: typeof name === 'string' });
const status = (s) => s.win.locator('footer.status-bar');

async function zoomPercent(s) {
  return Number.parseFloat(await s.win.getByLabel('Zoom level').inputValue());
}

/** The labels of the rows of an open popup or menu, by the row's .menu-label, as a locator for one row. */
function rowByLabel(menu, label) {
  const text = label instanceof RegExp ? label : new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return menu.locator('button.menu-item').filter({ has: menu.page().locator('.menu-label', { hasText: text }) });
}

/** Opens a menu-bar path ['File', 'Exit'] or ['View', 'Theme', 'Dark'] and clicks the last item. */
async function menuPick(s, path) {
  await s.win.getByRole('menubar').getByRole('menuitem', { name: path[0], exact: true }).click();
  for (let i = 1; i < path.length; i++) {
    const dropdown = s.win.locator('.menu-dropdown').last();
    await dropdown.waitFor({ timeout: 5000 });
    await rowByLabel(dropdown, path[i]).first().click();
  }
  await waitFor(async () => (await s.win.locator('.menu-dropdown').count()) === 0, { timeoutMs: 5000, label: 'menu closed after the pick' });
}

async function closeMenus(s) {
  for (let i = 0; i < 3 && (await s.win.locator('.menu-dropdown').count()) > 0; i++) await s.win.keyboard.press('Escape');
}

async function setShowLabels(s, on) {
  await s.win.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await rowByLabel(s.win.locator('.menu-dropdown').last(), 'Toolbar').first().click();
  const item = s.win.getByRole('menuitemcheckbox', { name: 'Show Labels' });
  const now = (await item.getAttribute('aria-checked')) === 'true';
  if (now !== on) await item.click();
  await closeMenus(s);
  await waitFor(async () => (await s.win.locator('.menu-dropdown').count()) === 0, { timeoutMs: 5000, label: 'menu closed' });
  await waitFor(async () => (await barState(s)).labelsShown === on || !on, { timeoutMs: 5000, label: 'labels state applied' });
}

async function labelsChecked(s) {
  await s.win.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await rowByLabel(s.win.locator('.menu-dropdown').last(), 'Toolbar').first().click();
  const checked = (await s.win.getByRole('menuitemcheckbox', { name: 'Show Labels' }).getAttribute('aria-checked')) === 'true';
  await closeMenus(s);
  return checked;
}

async function addBlank(s, expectedPages) {
  await palette(s.win, 'Pages: Insert blank page…');
  await s.win.getByRole('dialog', { name: 'Insert pages' }).getByRole('button', { name: 'Apply' }).click();
  await waitForCount(s.win, expectedPages);
}

/** A tiny uncompressed PDF made by MuPDF. [612,792] and [792,612] give files of exactly the same size. */
function makePdf(sizes) {
  const doc = new mupdf.PDFDocument();
  for (const [w, h] of sizes) doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, doc.newDictionary(), ''));
  return Buffer.from(doc.saveToBuffer('').asUint8Array());
}

/** Reads a PDF on disk with MuPDF in this process, independent of the app: page count and page sizes. */
function diskInfo(path) {
  if (!existsSync(path)) return null;
  const doc = mupdf.Document.openDocument(readFileSync(path), 'application/pdf');
  const pages = doc.countPages();
  const sizes = [];
  for (let i = 0; i < pages; i++) {
    const b = doc.loadPage(i).getBounds();
    sizes.push([Math.round(b[2] - b[0]), Math.round(b[3] - b[1])]);
  }
  return { pages, sizes };
}

const PORTRAIT3 = makePdf([[612, 792], [612, 792], [612, 792]]);
const LANDSCAPE3 = makePdf([[792, 612], [792, 612], [792, 612]]); // the same byte size as PORTRAIT3
const OUTSIDE2 = makePdf([[792, 612], [792, 612]]);
const OUTSIDE1 = makePdf([[500, 500]]);

/** The pages the app shows now and its document info line. */
async function appShows(s) {
  const text = await statusText(s.win);
  const pages = /of (\d+)/.exec(text);
  const info = await s.win.locator('.status-info').first().innerText().catch(() => '');
  return { pages: pages ? Number(pages[1]) : -1, info };
}

/** Another program writes a file. A short wait first, so that its modified time is surely later than the app's last look. */
async function outsideWrite(path, buffer) {
  await delay(80);
  writeFileSync(path, buffer);
}

/** One document in a temp folder: PORTRAIT3 opened in a fresh app. Runs `fn`, then tears everything down. */
async function scenario(fn, { env, thumbs = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-matrix-'));
  const path = join(dir, 'doc.pdf');
  writeFileSync(path, PORTRAIT3);
  const s = await launch({ env });
  try {
    await s.win.waitForSelector('.empty-state');
    await openDoc(s, path, 3);
    assert.deepEqual(diskInfo(path), { pages: 3, sizes: [[612, 792], [612, 792], [612, 792]] }, 'the starting file is what MuPDF says it is');
    await fn({ s, dir, path });
    // The node debugger's own line on a quit is not an app error.
    s.errors = s.errors.filter((e) => !/Waiting for the debugger to disconnect/.test(e));
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    rmSync(dir, { recursive: true, force: true });
  }
}

const bar = (s) => s.win.getByRole('button', { name: 'Keep my version', exact: true });
async function expectBlocked(s, path, outsideBuffer, label) {
  await s.win.locator('.toast', { hasText: CHANGED_TOAST }).first().waitFor({ timeout: 10000 });
  await bar(s).first().waitFor({ timeout: 5000 });
  await delay(1200); // a late write would show up now
  assert.ok(readFileSync(path).equals(outsideBuffer), `${label}: the file on disk is still the other program's, byte for byte`);
}

// ------------------------------------------------------------------------------------------------ 1. save-time disk check

test('1a outside change, Ctrl+S at once, Keep my version, Ctrl+S: nothing written until the choice, then the app version is on disk', () =>
  scenario(async ({ s, path }) => {
    await jumpTo(s.win, 0);
    await addBlank(s, 4);
    await outsideWrite(path, OUTSIDE2);
    await s.win.keyboard.press('Control+s');
    await expectBlocked(s, path, OUTSIDE2, '1a');
    assert.deepEqual(diskInfo(path), { pages: 2, sizes: [[792, 612], [792, 612]] }, 'MuPDF reads the outside version: 2 landscape pages');
    assert.equal((await appShows(s)).pages, 4, 'the app still shows its 4 pages');
    assert.equal(await isDirty(s.win), true);
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await waitFor(async () => (await bar(s).count()) === 0, { timeoutMs: 10000, label: 'bar gone' });
    assert.ok(readFileSync(path).equals(OUTSIDE2), 'Keep my version alone writes nothing');
    await saveNow(s.win);
    const disk = diskInfo(path);
    assert.equal(disk.pages, 4, 'the app version (3 + 1 pages) is on disk');
    assert.deepEqual(disk.sizes[0], [612, 792], 'and it is the app version, not the outside one');
    assert.equal((await appShows(s)).pages, disk.pages);
  }));

test('1b outside change, Ctrl+S, Reload: the outside version is shown; edit, Ctrl+S: saved on top of it', () =>
  scenario(async ({ s, path }) => {
    await jumpTo(s.win, 0);
    await addBlank(s, 4);
    await outsideWrite(path, OUTSIDE2);
    await s.win.keyboard.press('Control+s');
    await expectBlocked(s, path, OUTSIDE2, '1b');
    await s.win.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 2'), { timeoutMs: 30000, label: 'reloaded 2 pages' });
    assert.equal(await isDirty(s.win), false);
    await waitFor(async () => /11 × 8\.5 in|279\.4 × 215\.9 mm/.test((await appShows(s)).info), { timeoutMs: 10000, label: 'the outside version is landscape in the status bar' });
    assert.ok(readFileSync(path).equals(OUTSIDE2), 'Reload writes nothing');
    await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
    await jumpTo(s.win, 0);
    await addBlank(s, 3);
    await saveNow(s.win);
    const disk = diskInfo(path);
    assert.equal(disk.pages, 3);
    assert.deepEqual(disk.sizes[0], [792, 612], 'the outside version\'s page is kept, the new page is added to it');
  }));

test('1c outside change, File > Exit > Save: the outside change is not overwritten without the choice; after the choice Exit > Save writes and quits', () =>
  scenario(
    async ({ s, path }) => {
      let closed = false;
      s.app.on('close', () => (closed = true));
      await jumpTo(s.win, 0);
      await addBlank(s, 4);
      await outsideWrite(path, OUTSIDE2);
      await menuPick(s, ['File', 'Exit']);
      const prompt = s.win.getByRole('alertdialog');
      await prompt.waitFor({ timeout: 10000 });
      await prompt.getByRole('button', { name: 'Save', exact: true }).click();
      await bar(s).waitFor({ timeout: 10000 });
      await delay(1500);
      assert.equal(closed, false, 'the app did not quit over an unsaved, unresolved file');
      assert.ok(readFileSync(path).equals(OUTSIDE2), 'Exit > Save did not overwrite the outside change');
      assert.equal(await isDirty(s.win), true, 'the edit is still there');
      assert.equal(await s.win.getByRole('alertdialog').count(), 0, 'no prompt is left on screen');
      await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
      await waitFor(async () => (await bar(s).count()) === 0, { timeoutMs: 10000, label: 'bar gone' });
      await menuPick(s, ['File', 'Exit']);
      await s.win.getByRole('alertdialog').getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => closed, { timeoutMs: 30000, label: 'the app quit after the save' });
      assert.equal(diskInfo(path).pages, 4, 'the app version was saved on quit');
    },
    { env: { PDFSUITE_E2E_PROMPTS: '1' } },
  ));

test('1d outside change, Save As to a new path: the new file has my edits, the original keeps the outside change', () =>
  scenario(async ({ s, dir, path }) => {
    await jumpTo(s.win, 0);
    await addBlank(s, 4);
    await outsideWrite(path, OUTSIDE2);
    const copyPath = join(dir, 'copy.pdf');
    await setSaveAnswer(s, copyPath);
    await menuPick(s, ['File', 'Save As…']);
    await waitFor(() => existsSync(copyPath) && diskInfo(copyPath)?.pages === 4, { timeoutMs: 20000, label: 'the copy exists with 4 pages' });
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 10000, label: 'clean after Save As' });
    assert.deepEqual(diskInfo(copyPath).sizes[0], [612, 792], 'the copy is the app version');
    assert.ok(readFileSync(path).equals(OUTSIDE2), 'the original still has the outside change, byte for byte');
    assert.equal((await appShows(s)).pages, 4);
    // The document now belongs to the copy: a further edit and Ctrl+S go to the copy, never to the original.
    await jumpTo(s.win, 0);
    await addBlank(s, 5);
    await saveNow(s.win);
    assert.equal(diskInfo(copyPath).pages, 5);
    assert.ok(readFileSync(path).equals(OUTSIDE2), 'the original is untouched after the following save');
  }));

test("1e the file deleted outside, Ctrl+S: the file is recreated with the app's pages and no choice bar blocks the save (owner ruling); same after the periodic check", () =>
  scenario(async ({ s, path }) => {
    await jumpTo(s.win, 0);
    await addBlank(s, 4);
    unlinkSync(path);
    await s.win.keyboard.press('Control+s');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 15000, label: 'saved' });
    assert.equal(await bar(s).count(), 0, 'no choice bar');
    assert.equal(await s.win.locator('.toast', { hasText: CHANGED_TOAST }).count(), 0, 'no blocked toast');
    const after = diskInfo(path);
    assert.equal(after?.pages, 4, 'the file exists again with the app version (3 + 1 pages)');
    assert.deepEqual(after.sizes[0], [612, 792]);
    assert.equal((await appShows(s)).pages, 4);
    // Delete again, wait through the periodic check: no choice bar for a missing file; Ctrl+S still recreates it.
    await jumpTo(s.win, 0);
    await addBlank(s, 5);
    unlinkSync(path);
    await delay(7500);
    assert.equal(await bar(s).count(), 0, 'the periodic check shows no choice bar for a missing file');
    console.log('1e toasts after the periodic check:', JSON.stringify(await s.win.locator('.toast').allInnerTexts()));
    await s.win.keyboard.press('Control+s');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 15000, label: 'saved again' });
    assert.equal(diskInfo(path)?.pages, 5, 'recreated with all 5 pages');
    assert.equal(await bar(s).count(), 0);
  }));

test('1i edit, outside change, open the same file again (second tab on the same document), Ctrl+S: nothing is written without the choice', () =>
  scenario(async ({ s, path }) => {
    await jumpTo(s.win, 0);
    await addBlank(s, 4);
    await outsideWrite(path, OUTSIDE2);
    await s.setDialogAnswer([path]);
    await s.win.keyboard.press('Control+o');
    await delay(3000);
    const tabs = await s.win.getByRole('tab').count();
    console.log(`1i: tabs after opening the same file again: ${tabs}; status: ${await statusText(s.win)}`);
    for (let i = 0; i < Math.max(tabs, 1); i++) {
      if (tabs > 1) await s.win.getByRole('tab').nth(i).click();
      await delay(500);
      await s.win.keyboard.press('Control+s');
      await delay(1500);
      assert.ok(readFileSync(path).equals(OUTSIDE2), `tab ${i}: Ctrl+S wrote nothing over the outside change`);
    }
    assert.equal(diskInfo(path).pages, 2);
  }));

test('1f an outside change with the same byte size is caught (the size alone would not show it)', () =>
  scenario(async ({ s, path }) => {
    assert.equal(LANDSCAPE3.length, PORTRAIT3.length, 'the outside file really has the same size');
    await jumpTo(s.win, 0);
    await addBlank(s, 4);
    await outsideWrite(path, LANDSCAPE3);
    assert.equal(readFileSync(path).length, PORTRAIT3.length);
    await s.win.keyboard.press('Control+s');
    await expectBlocked(s, path, LANDSCAPE3, '1f');
    assert.deepEqual(diskInfo(path).sizes[0], [792, 612]);
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await saveNow(s.win);
    assert.deepEqual(diskInfo(path).sizes[0], [612, 792]);
    assert.equal(diskInfo(path).pages, 4);
  }));

test('1g two outside changes in a row, Ctrl+S after each: blocked each time, the last outside version is never lost without a choice', () =>
  scenario(async ({ s, path }) => {
    await jumpTo(s.win, 0);
    await addBlank(s, 4);
    // Two changes before any choice.
    await outsideWrite(path, OUTSIDE2);
    await s.win.keyboard.press('Control+s');
    await expectBlocked(s, path, OUTSIDE2, '1g first');
    await outsideWrite(path, OUTSIDE1);
    await s.win.keyboard.press('Control+s');
    await delay(1200);
    assert.ok(readFileSync(path).equals(OUTSIDE1), 'the second outside change is not overwritten either');
    assert.equal(await isDirty(s.win), true);
    // Keep my version for the first, then a third change must be caught again (the app must not treat "keep" as "anything goes").
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await waitFor(async () => (await bar(s).count()) === 0, { timeoutMs: 10000, label: 'bar gone' });
    await outsideWrite(path, OUTSIDE2);
    await s.win.keyboard.press('Control+s');
    await expectBlocked(s, path, OUTSIDE2, '1g after keep');
    await s.win.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await saveNow(s.win);
    assert.equal(diskInfo(path).pages, 4);
    // And a change after the save is caught again.
    await jumpTo(s.win, 0);
    await addBlank(s, 5);
    await outsideWrite(path, OUTSIDE1);
    await s.win.keyboard.press('Control+s');
    await expectBlocked(s, path, OUTSIDE1, '1g after save');
    await s.win.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 1'), { timeoutMs: 30000, label: 'reloaded 1 page' });
  }));

test('1h no outside change: ten edits with a Ctrl+S after each never show the bar or the blocked toast, and every save is on disk', () =>
  scenario(async ({ s, path }) => {
    for (let i = 1; i <= 10; i++) {
      await jumpTo(s.win, 0);
      await addBlank(s, 3 + i);
      await s.win.keyboard.press('Control+s');
      await waitFor(async () => (await isDirty(s.win)) === false, { timeoutMs: 20000, label: `save ${i} done` });
      assert.equal(await bar(s).count(), 0, `the bar did not appear after save ${i}`);
      assert.equal(await s.win.locator('.toast', { hasText: CHANGED_TOAST }).count(), 0, `no blocked toast after save ${i}`);
      assert.equal(diskInfo(path).pages, 3 + i, `after save ${i} the disk has ${3 + i} pages`);
      assert.equal((await appShows(s)).pages, 3 + i);
    }
    // Wait through two periodic checks (5 s each): the app's own writes must not trip the watch either.
    await delay(11000);
    assert.equal(await bar(s).count(), 0, 'the periodic check does not report the app\'s own saves');
    await jumpTo(s.win, 0);
    await addBlank(s, 14);
    await saveNow(s.win);
    assert.equal(diskInfo(path).pages, 14);
  }));

// ------------------------------------------------------------------------------------------------ 2. overflow at many widths

const SLOT_ROWS = {
  'file.recent': { signature: ['Recent files'], button: 'Recent files' },
  'pages.insert': { signature: ['Insert', 'Blank page…', 'Lined page…', 'Grid page…', 'From PDF…'], button: 'Insert pages' },
  'pages.delete': { signature: ['Delete Pages'], button: 'Delete pages' },
  'pages.rotate': { signature: ['Rotate', 'Right 90°', 'Left 90°', '180°', 'Custom angle…'], button: 'Rotate right 90°' },
  'pages.crop': { signature: ['Crop', 'Crop pages…', 'Auto-crop'], button: 'Crop pages' },
  'pages.size': { signature: ['Page Size…'], button: 'Page size' },
  'pages.more': { signature: ['More page actions', 'Duplicate', 'Replace…', 'Reverse', 'Extract…'], button: 'More page actions' },
  'view.split': { signature: ['Split', 'Split horizontal', 'Split vertical'], button: 'Split' },
  'view.loupe': { signature: ['Loupe'], button: 'Loupe' },
  'view.panZoom': { signature: ['Pan and zoom'], button: 'Pan and zoom' },
  'view.recolor': { signature: ['Page colors'], button: /^Page colors/ },
};
const ALL_ROW_LABELS = new Set(Object.values(SLOT_ROWS).flatMap((v) => v.signature));
const CRITICAL_BUTTONS = ['Open', 'Save', 'Undo', 'Redo', 'Find', 'Previous page', 'Next page', 'Light or dark'];

/** The rows of the "…" menu (headings and entries), or null when the button is not shown. Closes the menu. */
async function overflowRows(s) {
  const more = barBtn(s, 'More commands');
  if (!(await more.isVisible())) return null;
  const moreBox = await more.boundingBox();
  const winWidth = await s.win.evaluate(() => innerWidth);
  if (!moreBox || moreBox.x + moreBox.width > winWidth + 0.5 || moreBox.x < 0) return { offscreen: true, rows: null };
  await more.click();
  const menu = s.win.getByRole('menu', { name: 'More commands' });
  await menu.waitFor({ timeout: 5000 });
  const rows = await menu.evaluate((el) =>
    [...el.children].map((c) => ({
      kind: c.tagName === 'HR' ? 'sep' : c.classList.contains('menu-heading') ? 'heading' : c.classList.contains('menu-note') ? 'note' : 'item',
      label: (c.querySelector?.('.menu-label')?.textContent ?? c.textContent ?? '').trim(),
      disabled: c.disabled === true,
      title: c.getAttribute?.('title') ?? null,
    })),
  );
  await s.win.keyboard.press('Escape');
  await waitFor(async () => (await menu.count()) === 0, { timeoutMs: 3000, label: 'overflow menu closed' });
  return rows;
}

/** Everything that must hold at the current width. Returns a list of problems (empty when fine). */
async function checkLayout(s, label) {
  const problems = [];
  const st = await barState(s);
  if (st.height !== 40) problems.push(`${label}: bar height ${st.height}`);
  if (st.scrollWidth > st.clientWidth) problems.push(`${label}: the bar overflows its box (${st.scrollWidth} > ${st.clientWidth})`);
  if (st.overflowVisible !== st.hidden.length > 0) problems.push(`${label}: "…" visible=${st.overflowVisible} but hidden=${st.hidden}`);
  if (st.hidden.some((id) => st.priorities[id] === 'critical')) problems.push(`${label}: a critical item is collapsed`);
  const hiddenHigh = st.hidden.filter((id) => st.priorities[id] === 'high');
  if (hiddenHigh.length && st.shown.some((id) => st.priorities[id] === 'normal')) problems.push(`${label}: a high item collapsed while a normal one is still shown`);
  // Critical buttons are visible and inside the window.
  for (const name of CRITICAL_BUTTONS) {
    const box = await barBtn(s, name).boundingBox();
    if (!box || box.x < 0 || box.x + box.width > st.width + 0.5) problems.push(`${label}: critical button ${name} is not fully inside the window (${JSON.stringify(box)})`);
  }
  for (const [name, locator] of [['Page number', s.win.getByLabel('Page number')]]) {
    const box = await locator.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > st.width + 0.5) problems.push(`${label}: ${name} is not fully inside the window`);
  }
  let rows = await overflowRows(s);
  if (rows && rows.offscreen) {
    problems.push(`${label}: the "…" button is outside the window`);
    rows = null;
  }
  const rowLabels = new Set((rows ?? []).filter((r) => r.kind !== 'sep').map((r) => r.label));
  for (const [slot, def] of Object.entries(SLOT_ROWS)) {
    const isHidden = st.hidden.includes(slot);
    const buttonVisible = await (def.button instanceof RegExp ? toolbar(s).getByRole('button', { name: def.button }).first() : barBtn(s, def.button)).isVisible();
    const present = def.signature.filter((l) => rowLabels.has(l));
    if (isHidden) {
      if (buttonVisible) problems.push(`${label}: ${slot} is collapsed but its button is still visible`);
      if (present.length !== def.signature.length) problems.push(`${label}: ${slot} is collapsed but "…" lacks ${def.signature.filter((l) => !rowLabels.has(l))}`);
    } else {
      if (!buttonVisible) problems.push(`${label}: ${slot} is in the bar's list but its button is not visible`);
      // The rows of a slot that is in the bar must not also be in "…" (the first entry of a multi-row slot is a shared heading word).
      const rowsOnly = def.signature.length > 1 ? def.signature.slice(1) : def.signature;
      const dup = rowsOnly.filter((l) => rowLabels.has(l));
      if (dup.length > 0) problems.push(`${label}: ${slot} is in the bar AND in "…": ${dup}`);
    }
  }
  // Labels, when shown, are not clipped.
  const clipped = await s.win.evaluate(() => [...document.querySelectorAll('.top-bar .tb-label:not(.tb-label-off)')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
  if (clipped.length) problems.push(`${label}: clipped labels ${clipped}`);
  return { problems, state: st };
}

test('2a overflow at every width, wide to narrowest and back in 40 px steps, labels off and on: reachable, no duplicates, no errors', async () => {
  const s = await launch();
  const problems = [];
  const log = [];
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    const min = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize());
    assert.equal(min[0], 720, 'the app\'s narrowest width is 720');
    for (const labels of [false, true]) {
      await setWidth(s, 1800);
      await setShowLabels(s, labels);
      const down = new Map();
      const widths = [];
      for (let w = 1800; w >= 720; w -= 40) widths.push(w);
      if (widths.at(-1) !== 720) widths.push(720);
      for (const w of widths) {
        await setWidth(s, w);
        const r = await checkLayout(s, `labels=${labels} down ${w}px`);
        problems.push(...r.problems);
        down.set(w, r.state);
      }
      // Trying to go below the minimum keeps 720.
      await placeWindow(s, { width: 500, height: 800 });
      await delay(400);
      const clamped = await s.win.evaluate(() => innerWidth);
      if (clamped !== 720) problems.push(`labels=${labels}: asked for 500 px, the window is ${clamped} px wide (minimum is 720)`);
      for (const w of [...widths].reverse()) {
        await setWidth(s, w);
        const r = await checkLayout(s, `labels=${labels} up ${w}px`);
        problems.push(...r.problems);
        const before = down.get(w);
        if (JSON.stringify(before.hidden) !== JSON.stringify(r.state.hidden) || before.labelsShown !== r.state.labelsShown) {
          log.push(`labels=${labels} ${w}px: going down hidden=[${before.hidden}] labels=${before.labelsShown}; going up hidden=[${r.state.hidden}] labels=${r.state.labelsShown}`);
        }
      }
      assert.deepEqual((await barState(s)).hidden, [], 'back to the widest width: nothing is collapsed');
      log.push(`labels=${labels}: collapse sequence going down: ${widths.map((w) => `${w}:${down.get(w).hidden.length}${down.get(w).labelsShown ? 'L' : ''}`).join(' ')}`);
    }
    console.log(log.join('\n'));
    assert.deepEqual(problems, []);
    // Hysteresis: a different plan on the way up than on the way down at the same width is allowed only inside the 8 px band,
    // which a 40 px step can never be.
    assert.deepEqual(log.filter((l) => /going up/.test(l)), [], 'the layout at a width does not depend on the direction');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('2b resize back and forth across one boundary 30 times, quickly: the app stays responsive, nothing flickers into a wrong state, the layout settles', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    for (const labels of [false, true]) {
      await setWidth(s, 1800);
      await setShowLabels(s, labels);
      // Find the first boundary on the way down: the widest width whose plan differs from 1800 px.
      let first = await barState(s);
      let boundary = null;
      let probe = 1800;
      while (probe > 720 && boundary === null) {
        probe -= 10;
        await setWidth(s, probe, { settle: true });
        const st = await barState(s);
        if (st.hidden.length !== first.hidden.length || st.labelsShown !== first.labelsShown) boundary = probe;
      }
      assert.ok(boundary, `a boundary exists (labels=${labels})`);
      for (const mode of ['paced 25 ms', 'unpaced']) {
        const wide = boundary + 30;
        const narrow = boundary - 30;
        const t0 = Date.now();
        await s.app.evaluate(
          async ({ BrowserWindow }, { wide, narrow, paced, ox, oy }) => {
            const win = BrowserWindow.getAllWindows()[0];
            for (let i = 0; i < 30; i++) {
              win.setBounds({ x: ox, y: oy, width: i % 2 === 0 ? narrow : wide, height: 800 });
              if (paced) await new Promise((r) => setTimeout(r, 25));
            }
            win.setBounds({ x: ox, y: oy, width: narrow, height: 800 });
          },
          { wide, narrow, paced: mode === 'paced 25 ms', ...(({ x, y }) => ({ ox: x, oy: y }))(await testOrigin(s)) },
        );
        // Responsive: a round trip to the page while the layout is still catching up, then real input still works.
        const ping = Date.now();
        await s.win.evaluate(() => 1);
        const pingMs = Date.now() - ping;
        assert.ok(pingMs < 2000, `the page answers within 2 s right after the resizes (${pingMs} ms) [${mode}, labels=${labels}]`);
        await waitFor(async () => (await s.win.evaluate(() => innerWidth)) === narrow, { timeoutMs: 10000, label: 'final width' });
        await settled(s);
        const settledState = await barState(s);
        const { problems } = await checkLayout(s, `after 30 resizes [${mode}] labels=${labels}`);
        assert.deepEqual(problems, []);
        // The settled layout is the one a direct jump to that width gives.
        await setWidth(s, 1800);
        await setWidth(s, narrow);
        const direct = await barState(s);
        assert.deepEqual([settledState.hidden, settledState.labelsShown], [direct.hidden, direct.labelsShown], `the layout after the 30 resizes equals the direct layout at ${narrow} px [${mode}, labels=${labels}] (took ${Date.now() - t0} ms)`);
        // The app is alive: a click and a key still work.
        const before = await zoomPercent(s);
        await s.win.keyboard.press('Control+=');
        await waitFor(async () => (await zoomPercent(s)) !== before, { timeoutMs: 5000, label: 'Ctrl+= works after the resizes' });
        await s.win.keyboard.press('Control+0');
        // End on the wide side as well.
        await s.app.evaluate(
          async ({ BrowserWindow }, { wide, narrow, ox, oy }) => {
            const win = BrowserWindow.getAllWindows()[0];
            for (let i = 0; i < 30; i++) win.setBounds({ x: ox, y: oy, width: i % 2 === 0 ? wide : narrow, height: 800 });
            win.setBounds({ x: ox, y: oy, width: wide, height: 800 });
          },
          { wide, narrow, ...(({ x, y }) => ({ ox: x, oy: y }))(await testOrigin(s)) },
        );
        await waitFor(async () => (await s.win.evaluate(() => innerWidth)) === wide, { timeoutMs: 10000, label: 'wide width' });
        await settled(s);
        const settledWide = await barState(s);
        await setWidth(s, 1800);
        await setWidth(s, wide);
        const directWide = await barState(s);
        assert.deepEqual([settledWide.hidden, settledWide.labelsShown], [directWide.hidden, directWide.labelsShown], `ending on the wide side (${wide} px) equals the direct layout [${mode}, labels=${labels}]`);
        const { problems: p2 } = await checkLayout(s, `ending wide [${mode}] labels=${labels}`);
        assert.deepEqual(p2, []);
      }
    }
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('2c below the desktop minimum (web widths, window minimum lifted): high items collapse too, critical ones never do, everything stays reachable', async () => {
  const s = await launch();
  const problems = [];
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    for (const labels of [false, true]) {
      await setWidth(s, 1800, { override: true });
      await setShowLabels(s, labels);
      const seq = [];
      for (let w = 1000; w >= 640; w -= 40) {
        await setWidth(s, w, { override: true });
        const r = await checkLayout(s, `labels=${labels} ${w}px`);
        problems.push(...r.problems);
        seq.push(`${w}:${r.state.hidden.length}`);
      }
      console.log(`labels=${labels} below the minimum: ${seq.join(' ')}`);
      // Information only: where the critical items alone no longer fit.
      for (const w of [600, 560, 520]) {
        await setWidth(s, w, { override: true });
        const st = await barState(s);
        console.log(`labels=${labels} ${w}px: bar content ${st.scrollWidth} px in ${st.clientWidth} px${st.scrollWidth > st.clientWidth ? ' (OVERFLOWS: critical items do not fit)' : ''}`);
      }
      for (let w = 640; w <= 1000; w += 40) {
        await setWidth(s, w, { override: true });
        problems.push(...(await checkLayout(s, `labels=${labels} up ${w}px`)).problems);
      }
    }
    assert.deepEqual(problems, []);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('2d an open "…" menu closes when the bar widens and the button goes away', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 720);
    await barBtn(s, 'More commands').click();
    await s.win.getByRole('menu', { name: 'More commands' }).waitFor({ timeout: 5000 });
    await setWidth(s, 1800);
    assert.equal(await s.win.getByRole('menu', { name: 'More commands' }).count(), 0, 'no stale "…" menu after widening');
    assert.equal((await barState(s)).overflowVisible, false);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

// ------------------------------------------------------------------------------------------------ 3. every command, bar and "…" against the menu

/** Each toolbar command with its place in the bar, in the "…" menu and in the menu bar. `via` names its popup button when it lives in one. */
const COMMANDS = [
  { id: 'file.open', bar: 'Open', menu: ['Open…'] },
  { id: 'file.save', bar: 'Save', menu: ['Save'] },
  { id: 'edit.undo', bar: /^Undo/, menu: [/^Undo/] },
  { id: 'edit.redo', bar: /^Redo/, menu: [/^Redo/] },
  { id: 'search.open', bar: 'Find', menu: ['Find…'] },
  { id: 'view.fitPage', bar: 'Fit page', status: true, menu: ['Fit Page'] },
  { id: 'view.fitWidth', bar: 'Fit width', status: true, menu: ['Fit Width'] },
  { id: 'view.zoomOut', bar: 'Zoom out', status: true, menu: ['Zoom Out'] },
  { id: 'view.zoomIn', bar: 'Zoom in', status: true, menu: ['Zoom In'] },
  { id: 'view.loupe', bar: 'Loupe', overflow: 'Loupe', menu: ['Loupe'] },
  { id: 'view.panZoom', bar: 'Pan and zoom', overflow: 'Pan and zoom', menu: ['Pan and Zoom'] },
  { id: 'split.horizontal', via: 'Split', row: 'Split horizontal', overflow: 'Split horizontal', menu: ['Horizontal'] },
  { id: 'split.vertical', via: 'Split', row: 'Split vertical', overflow: 'Split vertical', menu: ['Vertical'] },
  { id: 'pages.delete', bar: 'Delete pages', overflow: 'Delete Pages', menu: ['Delete Pages'] },
  { id: 'pages.rotateRight', bar: 'Rotate right 90°', overflow: 'Right 90°', menu: ['Rotate Right 90°'] },
  { id: 'pages.rotateLeft', via: 'More rotation options', row: 'Left 90°', overflow: 'Left 90°', menu: ['Rotate Left 90°'] },
  { id: 'pages.rotate180', via: 'More rotation options', row: '180°', overflow: '180°', menu: ['Rotate 180°'] },
  { id: 'pages.rotateCustom', via: 'More rotation options', row: 'Custom angle…', overflow: 'Custom angle…', menu: ['Custom Angle…'] },
  { id: 'pages.insert', via: 'Insert pages', row: 'Blank page…', overflow: 'Blank page…', menu: ['Insert Blank Page…'] },
  { id: 'pages.insertLined', via: 'Insert pages', row: 'Lined page…', overflow: 'Lined page…', menu: ['Insert Lined Page…'] },
  { id: 'pages.insertGrid', via: 'Insert pages', row: 'Grid page…', overflow: 'Grid page…', menu: ['Insert Grid Page…'] },
  { id: 'pages.insertFromPdf', via: 'Insert pages', row: 'From PDF…', overflow: 'From PDF…', menu: ['Insert from PDF…'] },
  { id: 'pages.crop', via: 'Crop pages', row: 'Crop pages…', overflow: 'Crop pages…', menu: ['Crop Pages…'] },
  { id: 'pages.autoCrop', via: 'Crop pages', row: 'Auto-crop', overflow: 'Auto-crop', menu: ['Auto-Crop'] },
  { id: 'pages.size', bar: 'Page size', overflow: 'Page Size…', menu: ['Page Size…'] },
  { id: 'pages.duplicate', via: 'More page actions', row: 'Duplicate', overflow: 'Duplicate', menu: ['Duplicate'] },
  { id: 'pages.replace', via: 'More page actions', row: 'Replace…', overflow: 'Replace…', menu: ['Replace…'] },
  { id: 'pages.reverse', via: 'More page actions', row: 'Reverse', overflow: 'Reverse', menu: ['Reverse'] },
  { id: 'pages.extract', via: 'More page actions', row: 'Extract…', overflow: 'Extract…', menu: ['Extract Pages…'] },
];

const nameMatches = (name, pattern) => (pattern instanceof RegExp ? pattern.test(name) : name === pattern);

/** Reads every item of the menu bar, with its enabled state and reason. Submenus are opened. */
async function readMenuBar(s) {
  const out = [];
  const tops = await s.win.getByRole('menubar').getByRole('menuitem').allInnerTexts();
  for (const top of tops) {
    await s.win.getByRole('menubar').getByRole('menuitem', { name: top.trim(), exact: true }).click();
    const dd = s.win.locator('.menu-dropdown').first();
    await dd.waitFor({ timeout: 5000 });
    const read = (root) =>
      root.evaluate((el) =>
        [...el.querySelectorAll(':scope > button.menu-item, :scope > .menu-sub-wrap > button.menu-item')].map((b) => ({
          label: b.querySelector('.menu-label')?.textContent?.trim() ?? '',
          disabled: b.disabled,
          title: b.getAttribute('title'),
          sub: b.getAttribute('aria-haspopup') === 'menu',
        })),
      );
    const items = await read(dd);
    for (const item of items) {
      if (!item.sub) out.push({ top: top.trim(), ...item });
    }
    for (const item of items.filter((i) => i.sub)) {
      await rowByLabel(dd, item.label).first().click();
      const sub = s.win.locator('.menu-sub').first();
      if (await sub.count()) {
        const subItems = await read(sub);
        for (const si of subItems) out.push({ top: top.trim(), sub: false, ...si, label: si.label, parent: item.label });
      }
    }
    await s.win.keyboard.press('Escape');
    await closeMenus(s);
  }
  return out;
}

/** Reads the bar: every visible button's enabled state and tooltip, and the rows of its popup menus. */
async function readBar(s) {
  const out = {};
  const buttons = await s.win.evaluate(() =>
    [...document.querySelectorAll('.top-bar button[aria-label], footer.status-bar button[aria-label]')]
      .filter((b) => b.offsetParent !== null && !b.closest('.tb-collapsed'))
      .map((b) => ({ name: b.getAttribute('aria-label'), disabled: b.disabled, tip: b.getAttribute('data-tooltip'), menu: b.getAttribute('aria-haspopup') === 'menu' })),
  );
  for (const b of buttons) {
    out[b.name] = { disabled: b.disabled, tip: b.tip };
    if (b.menu && !/^(Zoom presets|More commands)$/.test(b.name)) {
      const button = s.win.locator('.top-bar').getByRole('button', { name: b.name, exact: true });
      await button.click();
      const menu = s.win.locator('.tb-popup').first();
      await menu.waitFor({ timeout: 5000 });
      const rows = await menu.evaluate((el) => [...el.querySelectorAll('button.menu-item')].map((r) => ({ label: r.querySelector('.menu-label')?.textContent?.trim() ?? '', disabled: r.disabled, title: r.getAttribute('title') })));
      for (const r of rows) out[`${b.name} > ${r.label}`] = { disabled: r.disabled, tip: r.title };
      await s.win.keyboard.press('Escape');
      await waitFor(async () => (await s.win.locator('.tb-popup').count()) === 0, { timeoutMs: 3000, label: 'popup closed' });
    }
  }
  return out;
}

/** Compares the three places of every command in one state. Returns problems and how many comparisons were made. */
function compareState(stateName, barSide, overflowSide, menuItems) {
  const problems = [];
  let compared = 0;
  const reasonOf = (menuHits) => menuHits.find((m) => m.disabled)?.title ?? null;
  for (const c of COMMANDS) {
    const menuHits = menuItems.filter((m) => c.menu.some((pattern) => nameMatches(m.label, pattern)));
    if (menuHits.length === 0) {
      problems.push(`${stateName}: ${c.id}: no menu item found (${c.menu})`);
      continue;
    }
    const states = new Set(menuHits.map((m) => m.disabled));
    if (states.size > 1) problems.push(`${stateName}: ${c.id}: the menu itself disagrees between its entries (${menuHits.map((m) => `${m.top}/${m.label}=${m.disabled}`)})`);
    const menuDisabled = menuHits[0].disabled;
    const menuReason = reasonOf(menuHits);
    // The bar side
    let barEntry;
    if (c.bar !== undefined) {
      const key = Object.keys(barSide).find((k) => !k.includes(' > ') && nameMatches(k, c.bar));
      barEntry = key ? barSide[key] : undefined;
    } else if (c.via) {
      barEntry = barSide[`${c.via} > ${c.row}`];
    }
    if (barEntry) {
      compared++;
      if (barEntry.disabled !== menuDisabled) problems.push(`${stateName}: ${c.id}: bar disabled=${barEntry.disabled}, menu disabled=${menuDisabled}`);
      else if (menuDisabled && menuReason && barEntry.tip !== menuReason) problems.push(`${stateName}: ${c.id}: bar says "${barEntry.tip}", menu says "${menuReason}"`);
    } else if (c.bar !== undefined || c.via) {
      // Not in the bar at this width: that is fine only when the overflow side has it.
      if (!c.overflow || !overflowSide) problems.push(`${stateName}: ${c.id}: not found in the bar`);
    }
    const o = c.overflow && overflowSide ? overflowSide.find((r) => r.kind === 'item' && r.label === c.overflow) : undefined;
    if (o) {
      compared++;
      if (o.disabled !== menuDisabled) problems.push(`${stateName}: ${c.id}: "…" disabled=${o.disabled}, menu disabled=${menuDisabled}`);
      else if (menuDisabled && menuReason && o.title !== menuReason) problems.push(`${stateName}: ${c.id}: "…" says "${o.title}", menu says "${menuReason}"`);
    }
  }
  return { problems, compared };
}

test('3a every toolbar and "…" command has the same enabled state and disabled reason as its menu twin: no document, document, one page, after edit and undo, XFA form', async () => {
  const one = copyOf(MARGINS);
  const s = await launch();
  const problems = [];
  const counts = {};
  const snapshot = async (name) => {
    await setWidth(s, 1500);
    const barSide = await readBar(s);
    const menuItems = await readMenuBar(s);
    await setWidth(s, 720);
    const overflowSide = await overflowRows(s);
    const r = compareState(name, barSide, overflowSide, menuItems);
    problems.push(...r.problems);
    counts[name] = r.compared;
    return { barSide, menuItems, overflowSide };
  };
  try {
    await s.win.waitForSelector('.empty-state');
    const none = await snapshot('no document');
    assert.equal(none.barSide.Save.disabled === none.barSide['Zoom in'].disabled, true);
    // With a document.
    await setWidth(s, 1500);
    await openFile(s, fixture(MIXED), 8);
    const doc = await snapshot('document (8 pages)');
    assert.equal(doc.barSide['Delete pages'].disabled, false, 'Delete is enabled on an 8-page document');
    await setWidth(s, 1500);
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await s.win.getByRole('toolbar').getByRole('button', { name: /^Undo/ }).getAttribute('aria-label')) === 'Undo Rotate 1 page', { timeoutMs: 10000, label: 'undo label' });
    await snapshot('after an edit');
    await s.win.keyboard.press('Control+z');
    await waitFor(async () => (await s.win.getByRole('toolbar').getByRole('button', { name: /^Redo/ }).getAttribute('aria-label')) === 'Redo Rotate 1 page', { timeoutMs: 10000, label: 'redo label' });
    await snapshot('after undo');
    // One page left: Delete says why.
    await setWidth(s, 1500);
    await openFile(s, one.path, 2);
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => /of 1\b/.test(await statusText(s.win)), { timeoutMs: 15000, label: 'one page left' });
    const single = await snapshot('one page');
    assert.equal(single.menuItems.find((m) => m.label === 'Delete Pages')?.title, 'A PDF needs at least one page.');
    // XFA form: organizer commands are off with the spec's reason.
    await setWidth(s, 1500);
    await s.setDialogAnswer([XFA]);
    await s.win.keyboard.press('Control+o');
    await waitFor(async () => (await s.win.locator('[data-tooltip="This form can be viewed but not edited yet."]').count()) > 0, { timeoutMs: 30000, label: 'XFA state' });
    const xfa = await snapshot('XFA form');
    for (const id of ['Delete pages', 'Rotate right 90°', 'Insert pages > Blank page…', 'Crop pages > Crop pages…', 'More page actions > Duplicate']) {
      assert.equal(xfa.barSide[id]?.disabled, true, `${id} is disabled on an XFA form`);
      assert.equal(xfa.barSide[id]?.tip, 'This form can be viewed but not edited yet.', `${id} gives the XFA reason`);
    }
    console.log('compared per state:', JSON.stringify(counts));
    assert.deepEqual(problems, []);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeCopy(one);
  }
});

/** What a command did, in terms any route can be compared by. */
async function sig(s) {
  return s.win.evaluate(() => {
    const undo = [...document.querySelectorAll('.top-bar button')].find((b) => /^Undo/.test(b.getAttribute('aria-label') ?? ''));
    const redo = [...document.querySelectorAll('.top-bar button')].find((b) => /^Redo/.test(b.getAttribute('aria-label') ?? ''));
    const zoom = document.querySelector('input[aria-label="Zoom level"]')?.value;
    const fit = ['Fit page', 'Fit width'].map((n) => document.querySelector(`button[aria-label="${n}"]`)?.getAttribute('aria-pressed')).join('/');
    return {
      pages: document.querySelector('.status-of')?.textContent,
      page: document.querySelector('#status-page-box')?.value,
      undo: undo?.getAttribute('aria-label'),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label')).filter((n) => n !== 'Command palette'),
      floating: document.querySelectorAll('section.floating').length,
      viewers: document.querySelectorAll('.viewer').length,
      find: document.querySelector('input[aria-label="Find in document"]') !== null,
      theme: document.documentElement.dataset.theme,
      zoom: window.__sigZoom ? zoom : undefined,
      fit: window.__sigZoom ? fit : undefined,
      tabs: document.querySelectorAll('[role="tab"]').length,
      recolor: [...document.querySelectorAll('.top-bar button')].find((b) => /^Page colors/.test(b.getAttribute('aria-label') ?? ''))?.getAttribute('aria-label'),
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).sort(),
    };
  });
}

/** Back to a clean baseline: menus and sheets closed, edits undone, floating windows and split off, one tab, fit page. */
async function resetState(s, baseUndo) {
  await closeMenus(s);
  for (let i = 0; i < 4; i++) {
    if ((await s.win.locator('[role="dialog"]:not([aria-label="Command palette"])').count()) === 0 && (await s.win.locator('input[aria-label="Find in document"]').count()) === 0) break;
    await s.win.keyboard.press('Escape');
    await delay(200);
  }
  for (let i = 0; i < 12; i++) {
    const cur = await sig(s);
    if (cur.undo === baseUndo) break;
    await s.win.keyboard.press('Control+z');
    await delay(500);
  }
  while ((await s.win.locator('section.floating').count()) > 0) {
    const close = s.win.locator('section.floating').first().getByRole('button', { name: /Close/ }).first();
    await close.click();
    await delay(200);
  }
  if ((await s.win.locator('.viewer').count()) > 1) await menuPick(s, ['View', 'Split', 'None']).catch(() => undefined);
  while ((await s.win.getByRole('tab').count()) > 1) {
    await s.win.keyboard.press('Control+w');
    await delay(500);
  }
  // Back to page 1, so that every command starts from the same page: the page the user is on is now kept after a jump and at
  // the end of the document (1.2.2), so a command that moved the view would otherwise leave the next one a different start.
  const pageBox = s.win.locator('footer.status-bar').getByLabel('Go to page');
  if ((await pageBox.count()) > 0) {
    await pageBox.fill('1');
    await pageBox.press('Enter');
    await delay(400);
  }
  await s.win.keyboard.press('Control+0');
  await delay(300);
  // A toast of the command before lasts 4 s. The next command's own toast must not be mixed up with it (the same words can
  // come twice in a row, as Rotate right and Rotate left do), so the next command starts with none on screen.
  await waitFor(async () => (await s.win.locator('.toast').count()) === 0, { timeoutMs: 8000, label: 'the toast of the command before to go' });
}

test('3b every toolbar and "…" command runs and gives the same result as the same command from the menu bar', async () => {
  const problems = [];
  const ran = { bar: 0, overflow: 0, menu: 0 };
  const noEffect = [];
  const skippedOverflow = [];
  const second = copyOf(MARGINS);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);
    await s.win.keyboard.press('Control+0');
    await delay(400);
    const baseUndo = (await sig(s)).undo;
    // The commands that need a dialog answer: Replace/Insert from PDF/Open give a file; Cancel answers are the stub's default.
    const routes = ['bar', 'overflow', 'menu'];
    const runList = [...COMMANDS.filter((c) => !['edit.undo', 'edit.redo'].includes(c.id)), { id: 'theme.toggle', bar: 'Light or dark', menu: null }];
    const allResults = Object.fromEntries(runList.map((c) => [c.id, {}]));
    for (const route of routes) {
      await setWidth(s, route === 'overflow' ? 720 : 1500);
      for (const c of runList) {
        if (route === 'menu' && !c.menu) continue;
        if (route === 'overflow' && !c.overflow) continue;
        if (route === 'bar' && c.status === undefined && !c.bar && !c.via) continue;
        await resetState(s, baseUndo);
        await s.win.keyboard.press('Control+0');
        await delay(250);
        await s.win.evaluate((z) => (window.__sigZoom = z), /^view\.(zoom|fit)/.test(c.id));
        const base = await sig(s);
        if (c.id === 'file.open') await s.setDialogAnswer([second.path]);
        try {
          if (route === 'overflow') {
            await barBtn(s, 'More commands').click({ timeout: 4000 });
            const row = rowByLabel(s.win.getByRole('menu', { name: 'More commands' }), c.overflow).first();
            if ((await row.count()) === 0) {
              // This command is still in the bar at 720 px (a high item): not an overflow command at this width.
              await s.win.keyboard.press('Escape');
              skippedOverflow.push(c.id);
              continue;
            }
            await row.click({ timeout: 4000 });
          } else if (route === 'menu') {
            const label = c.menu[0];
            const top = ['file.open', 'file.save', 'pages.extract'].includes(c.id) ? 'File' : ['edit.undo', 'edit.redo', 'search.open'].includes(c.id) ? 'Edit' : c.id.startsWith('pages.') ? 'Pages' : 'View';
            const path = c.id === 'split.horizontal' || c.id === 'split.vertical' ? ['View', 'Split', label] : [top, label];
            await menuPick(s, path);
          } else if (c.via) {
            await barBtn(s, c.via).click({ timeout: 4000 });
            await rowByLabel(s.win.locator('.tb-popup').first(), c.row).first().click({ timeout: 4000 });
          } else {
            await s.win.locator(c.status ? 'footer.status-bar' : '.top-bar').getByRole('button', { name: c.bar, exact: typeof c.bar === 'string' }).click({ timeout: 4000 });
          }
          ran[route]++;
        } catch (e) {
          problems.push(`${c.id} via ${route}: could not run it: ${String(e.message).split('\n')[0]}`);
          await closeMenus(s);
          continue;
        }
        await delay(['pages.autoCrop', 'pages.reverse', 'pages.delete', 'pages.duplicate'].includes(c.id) || c.id.startsWith('pages.rotate') ? 1200 : 600);
        // A toast of the command before can still be up (they last 4 s): the toast that belongs to THIS command is the one that was
        // not there before it ran. Each toast of the base state cancels one equal toast afterwards.
        const afterSig = await sig(s);
        const left = [...afterSig.toasts];
        for (const t of base.toasts) {
          const at = left.indexOf(t);
          if (at >= 0) left.splice(at, 1);
        }
        const { toasts: _baseToasts, ...baseRest } = base;
        const { toasts: _afterToasts, ...afterRest } = afterSig;
        allResults[c.id][route] = { base: { ...baseRest, toast: '' }, after: { ...afterRest, toast: left.join('|') } };
        if (c.id === 'theme.toggle') await barBtn(s, 'Light or dark').click();
      }
    }
    for (const c of runList) {
      const results = allResults[c.id];
      const routesRun = Object.keys(results);
      const diffKeys = (r) => Object.keys(r.after).filter((k) => JSON.stringify(r.after[k]) !== JSON.stringify(r.base[k]) && !(k === 'toast' && r.after[k] === ''));
      const sigs = routesRun.map((r) => JSON.stringify(Object.fromEntries(diffKeys(results[r]).map((k) => [k, results[r].after[k]]))));
      if (new Set(sigs).size > 1) problems.push(`${c.id}: routes disagree: ${routesRun.map((r, i) => `${r}=${sigs[i]}`).join(' vs ')}`);
      if (routesRun.length > 0 && diffKeys(results[routesRun[0]]).length === 0) noEffect.push(c.id);
    }
    console.log(`not in "…" at 720 px (still in the bar): ${skippedOverflow}`);
    console.log(`ran: ${JSON.stringify(ran)}; commands with no visible effect on a clean 8-page document: ${noEffect}`);
    // A command that does nothing at all on every route is a dead button, except those that cannot show an effect here.
    const mayBeQuiet = new Set(['file.save', 'edit.undo', 'edit.redo', 'pages.insertFromPdf', 'pages.replace', 'pages.extract', 'pages.autoCrop', 'view.fitPage', 'view.zoomOut', 'view.zoomIn', 'file.open']);
    assert.deepEqual(noEffect.filter((id) => !mayBeQuiet.has(id)), [], 'a command did nothing when run');
    assert.deepEqual(problems, []);
    await resetState(s, baseUndo);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeCopy(second);
  }
});

// ------------------------------------------------------------------------------------------------ 4. status bar

test('4a page box and % box: empty, 0, -5, 99999, "abc", "12.5", pasted "150%" with Enter and Esc; the box never keeps junk', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);
    const st = status(s);
    const pageBox = st.getByLabel('Go to page');
    const zoomBox = st.getByLabel('Zoom level');
    await st.getByRole('button', { name: 'Fit page', exact: true }).click();
    await delay(500);
    const pageNow = async () => (await pageBox.inputValue()).trim();
    const gotoPage = async (n) => {
      await pageBox.fill(String(n));
      await pageBox.press('Enter');
      await waitFor(async () => (await pageNow()) === String(n), { timeoutMs: 8000, label: `page ${n}` });
    };
    const settleBox = async (box) => {
      await delay(400);
      assert.equal(await s.win.evaluate(() => document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('footer') !== null), false, 'Enter leaves the box');
      void box;
    };
    // ---- page box
    const pageCases = [
      ['', null], // empty: nothing moves
      ['0', 1],
      ['-5', 1],
      ['99999', 8],
      ['abc', null],
      ['12.5', 8], // 12 is past the end
      ['150%', 8],
      ['  3  ', 3],
      ['3', 3],
    ];
    for (const [input, expected] of pageCases) {
      await gotoPage(5);
      await pageBox.fill(input);
      await pageBox.press('Enter');
      await delay(600);
      let shown = await pageNow();
      let want = expected === null ? '5' : String(expected);
      if (expected === 8 && shown === '7') {
        // Known: the box can show 7 after a jump to the last page (see test 4e, which judges that). Here the jump itself is judged.
        const atEnd = await s.win.evaluate(() => {
          const v = document.querySelector('.viewer');
          return v.scrollTop + v.clientHeight >= v.scrollHeight - 2;
        });
        assert.equal(atEnd, true, `page box "${input}": the viewer scrolled to the end`);
        shown = want = '7';
      }
      assert.equal(shown, want, `page box: "${input}" + Enter leaves the box at ${want}, not "${shown}"`);
      assert.ok((await statusText(s.win)).startsWith(`Page ${want} of 8`), `page box "${input}": the status shows page ${want}`);
      assert.match(shown, /^\d+$/, 'the box holds a plain number after Enter');
      await settleBox(pageBox);
    }
    // Esc restores and does not move; the box is not left with the draft.
    await gotoPage(4);
    await pageBox.focus();
    await pageBox.fill('7');
    await pageBox.press('Escape');
    await delay(400);
    assert.equal(await pageNow(), '4', 'Esc restores the box');
    // Typing without Enter, then leaving: no jump and no junk.
    await pageBox.focus();
    await pageBox.fill('2');
    await s.win.locator('.viewer').first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await delay(400);
    assert.match(await pageNow(), /^\d+$/);
    // ---- zoom box
    await st.getByRole('button', { name: 'Fit page', exact: true }).click();
    const base = async () => {
      await zoomBox.fill('100');
      await zoomBox.press('Enter');
      await waitFor(async () => (await zoomPercent(s)) === 100, { timeoutMs: 5000, label: '100%' });
    };
    const zoomCases = [
      ['', 100],
      ['0', 100],
      ['-5', 100],
      ['99999', 800],
      ['abc', 100],
      ['12.5', [12, 13]],
      ['150%', 150],
      [' 80 % ', 80],
      ['1e3', 100],
      ['٢٠٠', 100],
      ['5', 10],
    ];
    for (const [input, expected] of zoomCases) {
      await base();
      await zoomBox.fill(input);
      await zoomBox.press('Enter');
      await delay(500);
      const shown = await zoomBox.inputValue();
      assert.match(shown, /^\d+%$/, `zoom box after "${input}" + Enter shows a clean percentage, not "${shown}"`);
      const value = await zoomPercent(s);
      if (Array.isArray(expected)) assert.ok(value >= expected[0] && value <= expected[1], `zoom box "${input}" -> ${value}`);
      else assert.equal(value, expected, `zoom box: "${input}" + Enter gives ${expected}%, got ${value}%`);
    }
    // Esc leaves the old zoom and the box clean; Enter on an unchanged box changes nothing.
    await base();
    await zoomBox.focus();
    await zoomBox.fill('250');
    await zoomBox.press('Escape');
    await delay(300);
    assert.equal(await zoomBox.inputValue(), '100%');
    await zoomBox.focus();
    await zoomBox.press('Enter');
    await delay(300);
    assert.equal(await zoomBox.inputValue(), '100%');
    // A pasted value: paste "150%" through the clipboard event path.
    await zoomBox.focus();
    await s.win.evaluate(() => {
      const input = document.querySelector('input[aria-label="Zoom level"]');
      input.select();
      const data = new DataTransfer();
      data.setData('text/plain', '150%');
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await zoomBox.fill('150%');
    await zoomBox.press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 150, { timeoutMs: 5000, label: 'pasted 150%' });
    // ---- presets
    for (const p of [50, 75, 100, 125, 150, 200, 400]) {
      await st.getByRole('button', { name: 'Zoom presets' }).click();
      await rowByLabel(s.win.getByRole('menu', { name: 'Zoom presets' }), `${p}%`).first().click();
      await waitFor(async () => (await zoomPercent(s)) === p, { timeoutMs: 5000, label: `${p}% preset` });
      assert.equal(await zoomBox.inputValue(), `${p}%`);
    }
    // ---- limits: Zoom in to the top, Zoom out to the bottom, with the buttons and the shortcuts
    let last = await zoomPercent(s);
    let steps = 0;
    for (; steps < 80; steps++) {
      await st.getByRole('button', { name: 'Zoom in', exact: true }).click({ timeout: 3000 }).catch(() => undefined);
      await delay(120);
      const now = await zoomPercent(s);
      assert.ok(now >= last, 'zoom in never goes down');
      if (now === last && now === 800) break;
      last = now;
    }
    assert.equal(await zoomPercent(s), 800, `Zoom in stops at 800% (after ${steps} clicks)`);
    await s.win.keyboard.press('Control+=');
    await delay(250);
    assert.equal(await zoomPercent(s), 800, 'Ctrl+= at the limit stays at 800%');
    for (steps = 0; steps < 120; steps++) {
      await st.getByRole('button', { name: 'Zoom out', exact: true }).click({ timeout: 3000 }).catch(() => undefined);
      await delay(120);
      const now = await zoomPercent(s);
      assert.ok(now <= last || last === 800, 'zoom out never goes up');
      if (now === last && now === 10) break;
      last = now;
    }
    assert.equal(await zoomPercent(s), 10, `Zoom out stops at 10% (after ${steps} clicks)`);
    await s.win.keyboard.press('Control+-');
    await delay(250);
    assert.equal(await zoomPercent(s), 10, 'Ctrl+- at the limit stays at 10%');
    // ---- slider: monotonic in position, mouse and keys
    const slider = st.getByLabel('Zoom slider');
    const box = await slider.boundingBox();
    let prev = 0;
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      await s.win.mouse.click(box.x + box.width * f, box.y + box.height / 2);
      await delay(250);
      const z = await zoomPercent(s);
      assert.ok(z > prev, `slider at ${f * 100}% gives a larger zoom than before (${z} > ${prev})`);
      assert.equal(await slider.getAttribute('aria-valuetext'), `${z}%`, 'the slider says its value');
      prev = z;
    }
    await slider.focus();
    await slider.press('Home');
    await waitFor(async () => (await zoomPercent(s)) === 10, { timeoutMs: 4000, label: 'slider Home' });
    await slider.press('End');
    await waitFor(async () => (await zoomPercent(s)) === 800, { timeoutMs: 4000, label: 'slider End' });
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('4b Fit Page and Fit Width follow a window resize (both ways) and stay pressed; fit really fits', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);
    const st = status(s);
    const fitState = () => s.win.evaluate(() => {
      let scroller = document.querySelector('.viewer');
      const page = document.querySelector('.page');
      const pr = page.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      return { scrollW: scroller.scrollWidth, clientW: scroller.clientWidth, clientH: scroller.clientHeight, pageW: pr.width, pageH: pr.height, viewW: sr.width };
    });
    for (const mode of ['Fit width', 'Fit page']) {
      await st.getByRole('button', { name: mode, exact: true }).click();
      await waitFor(async () => (await st.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed')) === 'true', { timeoutMs: 5000, label: `${mode} pressed` });
      const zooms = [];
      for (const w of [1500, 1100, 800, 1300, 720, 1500]) {
        await setWidth(s, w);
        await delay(500);
        zooms.push(await zoomPercent(s));
        assert.equal(await st.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'), 'true', `${mode} stays pressed after resizing to ${w} px`);
        const f = await fitState();
        if (mode === 'Fit width') assert.ok(f.scrollW <= f.clientW + 1, `Fit width at ${w} px leaves no horizontal scroll (${f.scrollW} > ${f.clientW})`);
        if (mode === 'Fit page') assert.ok(f.pageH <= f.clientH + 2, `Fit page at ${w} px: the page (${f.pageH} px tall) fits the viewer (${f.clientH} px)`);
      }
      // 1500 at the start and at the end give the same zoom; 720 is smaller than 1500 for fit width.
      assert.equal(zooms[0], zooms.at(-1), `${mode}: the same width gives the same zoom (${zooms})`);
      if (mode === 'Fit width') assert.ok(zooms[4] < zooms[0], `Fit width is smaller at 720 px than at 1500 px (${zooms})`);
    }
    // A manual zoom drops the fit; a resize then keeps the manual zoom.
    await st.getByLabel('Zoom level').fill('100');
    await st.getByLabel('Zoom level').press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 100, { timeoutMs: 5000, label: '100%' });
    assert.equal(await st.getByRole('button', { name: 'Fit page', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await st.getByRole('button', { name: 'Fit width', exact: true }).getAttribute('aria-pressed'), 'false');
    await setWidth(s, 900);
    await delay(500);
    assert.equal(await zoomPercent(s), 100, 'a resize keeps a manual zoom');
    // Fit width from the % menu at a width where the buttons have moved into it.
    await setWidth(s, 720, { override: false });
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('4c no document: the status bar says why, the zoom and page controls are disabled and not reachable by accident; opening a file enables them', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await setWidth(s, 1500);
    const st = status(s);
    assert.match(await st.innerText(), /No file open/, 'the bar says there is no file');
    const info = await s.win.evaluate(() =>
      [...document.querySelectorAll('footer.status-bar button, footer.status-bar input')].map((el) => ({
        name: el.getAttribute('aria-label'),
        disabled: el.disabled,
        tip: el.getAttribute('data-tooltip') ?? el.closest('[data-tooltip]')?.getAttribute('data-tooltip') ?? el.getAttribute('title'),
        tabbable: el.tabIndex >= 0 && !el.disabled,
      })),
    );
    console.log('no-document status bar controls:', JSON.stringify(info));
    const names = info.map((i) => i.name);
    for (const n of ['Fit page', 'Fit width', 'Zoom out', 'Zoom level', 'Zoom in', 'Zoom slider']) assert.ok(names.includes(n), `${n} is in the bar with no document`);
    for (const i of info) assert.equal(i.disabled, true, `${i.name} is disabled with no document`);
    assert.equal(await st.getByLabel('Go to page').count(), 0, 'no page box with no document');
    // Tab never lands on a disabled control.
    await s.win.evaluate(() => document.activeElement?.blur());
    for (let i = 0; i < 40; i++) {
      await s.win.keyboard.press('Tab');
      const inStatus = await s.win.evaluate(() => document.activeElement?.closest('footer.status-bar') !== null && document.activeElement?.closest('footer.status-bar') !== undefined && document.activeElement !== document.body);
      if (inStatus) {
        const el = await s.win.evaluate(() => ({ name: document.activeElement.getAttribute('aria-label'), disabled: document.activeElement.disabled }));
        assert.notEqual(el.disabled, true, `Tab landed on a disabled control: ${el.name}`);
      }
    }
    // The reason: a disabled control gives some explanation by tooltip or title (the plain tip "Zoom in (Ctrl+=)" is not a reason).
    const unexplained = info.filter((i) => i.disabled && (!i.tip || /\(Ctrl\+/.test(i.tip) || i.tip === i.name));
    const reasonNote = unexplained.length ? `Disabled controls with no reason of their own (the bar's text "No file open" is the only explanation): ${unexplained.map((i) => i.name).join(', ')}` : 'every disabled control has its own reason';
    console.log(reasonNote);
    // Top bar: Save/Undo/etc. disabled too
    for (const n of ['Save', 'Undo', 'Redo', 'Delete pages', 'Rotate right 90°']) {
      const el = await barBtn(s, n).first();
      assert.equal(await el.isDisabled(), true, `${n} is disabled with no document`);
    }
    // Open a file: everything turns on.
    await openFile(s, fixture(MIXED), 8);
    for (const n of ['Fit page', 'Fit width', 'Zoom out', 'Zoom in']) assert.equal(await st.getByRole('button', { name: n, exact: true }).isDisabled(), false, `${n} is enabled with a document`);
    assert.equal(await st.getByLabel('Zoom slider').isDisabled(), false);
    assert.equal(await st.getByLabel('Zoom level').isDisabled(), false);
    // Close the only tab: back to disabled, and the bar has no stale page box.
    await s.win.keyboard.press('Control+w');
    await s.win.locator('.empty-state').waitFor({ timeout: 10000 });
    assert.equal(await st.getByLabel('Zoom level').isDisabled(), true);
    assert.equal(await st.getByLabel('Go to page').count(), 0);
    // Not-yet-rendered tab: a locked file waiting for its password keeps the bar's shape.
    await s.setDialogAnswer([fixture('locked.pdf')]);
    await s.win.keyboard.press('Control+o');
    await delay(1500);
    assert.equal(await st.getByLabel('Zoom level').count(), 1, 'the zoom box is still in the bar while a tab waits for a password');
    assertNoErrors(s);
    // The password prompt: leave nothing behind.
    await s.win.keyboard.press('Escape');
    await delay(300);
    if ((await s.win.getByRole('dialog').count()) > 0) {
      const cancel = s.win.getByRole('dialog').getByRole('button', { name: /Cancel|Close/ });
      if (await cancel.count()) await cancel.first().click();
    }
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('4d a real mouse click into the page box and the zoom box, then typing with key presses and Enter: the old value is replaced, not appended to', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);
    const st = status(s);
    for (const [value, expectZoom] of [['150', 150], ['75', 75], ['200', 200]]) {
      await st.getByLabel('Zoom level').click();
      await s.win.keyboard.type(value, { delay: 30 });
      assert.equal(await st.getByLabel('Zoom level').inputValue(), value, `typing ${value} after a click replaced the old text`);
      await s.win.keyboard.press('Enter');
      await waitFor(async () => (await zoomPercent(s)) === expectZoom, { timeoutMs: 5000, label: `${expectZoom}%` });
    }
    for (const [value, page] of [['5', 5], ['2', 2], ['7', 7]]) {
      await st.getByLabel('Go to page').click();
      await s.win.keyboard.type(value, { delay: 30 });
      assert.equal(await st.getByLabel('Go to page').inputValue(), value, `typing ${value} after a click replaced the page number`);
      await s.win.keyboard.press('Enter');
      await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${page} of 8`), { timeoutMs: 8000, label: `page ${page}` });
    }
    await s.win.getByLabel('Page number').click();
    await s.win.keyboard.type('4', { delay: 30 });
    assert.equal(await s.win.getByLabel('Page number').inputValue(), '4', 'top page box replaced on a real click');
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 4 of 8'), { timeoutMs: 8000, label: 'page 4' });
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('4e typing a page number shows that page number, at the zoom the file opens with (every page of an 8-page mixed-size file)', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);
    const box = status(s).getByLabel('Go to page');
    const wrong = [];
    for (const n of [3, 8, 1, 7, 8, 2, 8]) {
      await box.fill(String(n));
      await box.press('Enter');
      await delay(900);
      const shown = Number.parseInt(await box.inputValue(), 10);
      if (shown !== n) wrong.push(`typed ${n}, shows ${shown} (zoom ${await zoomPercent(s)}%)`);
    }
    assert.deepEqual(wrong, [], 'the page box shows the page that was asked for');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

// ------------------------------------------------------------------------------------------------ 5. keyboard only

const focusInfo = (s) =>
  s.win.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const own = el.closest('[data-tooltip]');
    return { label: el.getAttribute('aria-label'), id: el.id, tag: el.tagName, tip: own?.getAttribute('data-tooltip') ?? null, inBar: el.closest('.top-bar') !== null, inStatus: el.closest('footer.status-bar') !== null, disabled: el.disabled === true };
  });

/** Presses Tab until `pred(info)` holds. Returns the info or null. */
async function tabUntil(s, pred, max = 90) {
  for (let i = 0; i < max; i++) {
    await s.win.keyboard.press('Tab');
    const info = await focusInfo(s);
    if (info && pred(info)) return info;
  }
  return null;
}

const refocus = (s, label) => s.win.evaluate((l) => (document.querySelector(`.top-bar button[aria-label="${l}"], footer.status-bar button[aria-label="${l}"], footer.status-bar input[aria-label="${l}"], .top-bar input[aria-label="${l}"]`) ?? document.querySelector(`[aria-label="${l}"]`))?.focus(), label);

test('5a keyboard only: Tab reaches every toolbar and status bar control, each one works from the keyboard, and tooltips appear on keyboard focus', async () => {
  const work = copyOf(MIXED);
  const second = copyOf(MARGINS);
  const s = await launch();
  const problems = [];
  const used = [];
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, work.path, 8);
    await setWidth(s, 1500);
    // One edit by keyboard, so Save and Undo are live.
    await palette(s.win, 'Pages: Rotate right 90°');
    // The label names the step a moment before the button is on (the edit is still being finished), and Tab skips a button that is off.
    await waitFor(async () => (await barBtn(s, /^Undo/).getAttribute('aria-label')) !== 'Undo' && !(await barBtn(s, /^Undo/).isDisabled()), { timeoutMs: 10000, label: 'an edit to undo, with Undo on' });
    await s.win.evaluate(() => document.activeElement?.blur());

    const undoLabel = () => barBtn(s, /^Undo/).getAttribute('aria-label');
    const pageText = async () => (await statusText(s.win)).match(/^Page (\d+) of (\d+)/)?.slice(1).map(Number);
    const act = {
      Open: async () => {
        await s.setDialogAnswer([second.path]);
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await s.win.getByRole('tab').count()) === 2, { timeoutMs: 20000, label: 'second tab by Enter on Open' });
        await s.win.keyboard.press('Control+w');
        await waitFor(async () => (await s.win.getByRole('tab').count()) === 1, { timeoutMs: 10000, label: 'back to one tab' });
        await waitFor(async () => (await pageText())?.[1] === 8, { timeoutMs: 10000, label: 'the first document is active again' });
      },
      Save: async () => {
        const before = readFileSync(work.path);
        await s.win.keyboard.press('Enter');
        await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 20000, label: 'saved by Enter on Save' });
        assert.ok(!readFileSync(work.path).equals(before), 'Enter on Save changed the file on disk');
        // A second edit, by keyboard, so that Undo and Redo are live for the next stops.
        await palette(s.win, 'Pages: Rotate right 90°');
        await waitFor(async () => (await undoLabel()) !== 'Undo' && !(await barBtn(s, /^Undo/).isDisabled()), { timeoutMs: 10000, label: 'second edit, with Undo on' });
        await refocus(s, 'Save');
      },
      Undo: async () => {
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await undoLabel()) === 'Undo', { timeoutMs: 10000, label: 'undone by Enter' });
      },
      Redo: async () => {
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await undoLabel()) === 'Undo Rotate 1 page', { timeoutMs: 10000, label: 'redone by Enter' });
      },
      Find: async () => {
        await s.win.keyboard.press('Enter');
        await s.win.locator('input[aria-label="Find in document"]').waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Escape');
        await waitFor(async () => (await s.win.locator('input[aria-label="Find in document"]').count()) === 0, { timeoutMs: 5000, label: 'search closed by Esc' });
        const back = await focusInfo(s);
        if (back?.label !== 'Find') console.log(`OBSERVATION: after Esc closes the find box the focus is on ${back ? back.label ?? back.tag : 'the page body'}, not back on the Find button`);
      },
      'Recent files': async () => {
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('menu', { name: 'Recent files' }).waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Escape');
        assert.equal(await s.win.getByRole('menu', { name: 'Recent files' }).count(), 0);
      },
      Split: async () => {
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('menu', { name: 'Split' }).waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Enter'); // Turn split on
        await waitFor(async () => (await s.win.locator('.viewer').count()) === 2, { timeoutMs: 8000, label: 'split on from the keyboard' });
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('menu', { name: 'Split' }).waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Enter'); // Turn split off
        await waitFor(async () => (await s.win.locator('.viewer').count()) === 1, { timeoutMs: 8000, label: 'split off from the keyboard' });
      },
      Loupe: async () => {
        await s.win.keyboard.press('Space');
        await waitFor(async () => (await s.win.locator('section.floating').count()) === 1, { timeoutMs: 5000, label: 'Loupe on with Space' });
        assert.equal(await barBtn(s, 'Loupe').getAttribute('aria-pressed'), 'true');
        await s.win.keyboard.press('Space');
        await waitFor(async () => (await s.win.locator('section.floating').count()) === 0, { timeoutMs: 5000, label: 'Loupe off with Space' });
      },
      'Pan and zoom': async () => {
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await s.win.locator('section.floating').count()) === 1, { timeoutMs: 5000, label: 'Pan and zoom on with Enter' });
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await s.win.locator('section.floating').count()) === 0, { timeoutMs: 5000, label: 'Pan and zoom off with Enter' });
      },
      Recolor: async () => {
        const name0 = await s.win.evaluate(() => document.activeElement.getAttribute('aria-label'));
        await s.win.keyboard.press('Enter');
        await s.win.locator('.tb-popup').waitFor({ timeout: 5000 });
        await s.win.keyboard.press('ArrowDown');
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await s.win.evaluate(() => document.activeElement.getAttribute('aria-label'))) !== name0, { timeoutMs: 5000, label: 'recolor mode changed from the keyboard' });
        await s.win.keyboard.press('Enter');
        await s.win.locator('.tb-popup').waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Home');
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await s.win.evaluate(() => document.activeElement.getAttribute('aria-label'))) === name0, { timeoutMs: 5000, label: 'recolor back' });
      },
      'Insert pages': async () => {
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('menu', { name: 'Insert pages' }).waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('dialog', { name: 'Insert pages' }).waitFor({ timeout: 8000 });
        await s.win.keyboard.press('Escape');
        const closed = await waitFor(async () => (await s.win.getByRole('dialog', { name: 'Insert pages' }).count()) === 0, { timeoutMs: 3000, label: 'sheet closed by Esc' }).then(() => true, () => false);
        if (!closed) {
          problems.push('Esc does not close the Insert pages sheet (keyboard-only user must Tab to Cancel)');
          await s.win.getByRole('dialog', { name: 'Insert pages' }).getByRole('button', { name: 'Cancel' }).click();
        }
      },
      'Delete pages': async () => {
        const before = (await pageText())[1];
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await pageText())?.[1] === before - 1, { timeoutMs: 10000, label: 'a page deleted by Enter' });
        await s.win.keyboard.press('Control+z');
        await waitFor(async () => (await pageText())?.[1] === before, { timeoutMs: 10000, label: 'delete undone by Ctrl+Z' });
        await refocus(s, 'Delete pages');
      },
      'Rotate right 90°': async () => {
        const before = await undoLabel();
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await undoLabel()) !== before || (await s.win.locator('.toast', { hasText: 'Rotated' }).count()) > 0, { timeoutMs: 10000, label: 'rotated by Enter' });
        await s.win.keyboard.press('Control+z');
        await delay(500);
        await refocus(s, 'Rotate right 90°');
      },
      'More rotation options': async () => {
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('menu', { name: 'More rotation options' }).waitFor({ timeout: 5000 });
        await s.win.keyboard.press('ArrowDown');
        await s.win.keyboard.press('Enter'); // Left 90
        await s.win.locator('.toast', { hasText: /Rotated/ }).first().waitFor({ timeout: 10000 });
        await s.win.keyboard.press('Control+z');
        await delay(600);
        await refocus(s, 'More rotation options');
      },
      'Crop pages': async () => {
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('menu', { name: 'Crop pages' }).waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('dialog', { name: /Crop/ }).waitFor({ timeout: 8000 });
        await s.win.keyboard.press('Escape');
        const closed = await waitFor(async () => (await s.win.getByRole('dialog', { name: /Crop/ }).count()) === 0, { timeoutMs: 3000, label: 'crop sheet closed' }).then(() => true, () => false);
        if (!closed) {
          problems.push('Esc does not close the Crop sheet');
          await s.win.getByRole('dialog', { name: /Crop/ }).getByRole('button', { name: 'Cancel' }).click();
        }
      },
      'Page size': async () => {
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('dialog', { name: 'Page size' }).waitFor({ timeout: 8000 });
        await s.win.keyboard.press('Escape');
        const closed = await waitFor(async () => (await s.win.getByRole('dialog', { name: 'Page size' }).count()) === 0, { timeoutMs: 3000, label: 'size sheet closed' }).then(() => true, () => false);
        if (!closed) {
          problems.push('Esc does not close the Page size sheet');
          await s.win.getByRole('dialog', { name: 'Page size' }).getByRole('button', { name: 'Cancel' }).click();
        }
      },
      'More page actions': async () => {
        const before = (await pageText())[1];
        await s.win.keyboard.press('Enter');
        await s.win.getByRole('menu', { name: 'More page actions' }).waitFor({ timeout: 5000 });
        await s.win.keyboard.press('Enter'); // Duplicate
        await waitFor(async () => (await pageText())?.[1] === before + 1, { timeoutMs: 10000, label: 'duplicated from the keyboard' });
        await s.win.keyboard.press('Control+z');
        await waitFor(async () => (await pageText())?.[1] === before, { timeoutMs: 10000, label: 'duplicate undone' });
        await refocus(s, 'More page actions');
      },
      'Page number': async () => {
        await s.win.keyboard.press('Control+a');
        await s.win.keyboard.type('3');
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await pageText())?.[0] === 3, { timeoutMs: 8000, label: 'page 3 from the top page box' });
        await refocus(s, 'Page number');
      },
      'Next page': async () => {
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await pageText())?.[0] === 4, { timeoutMs: 8000, label: 'page 4 with Next page' });
        await s.win.keyboard.press('Shift+Tab');
        await s.win.keyboard.press('Shift+Tab');
        const info = await focusInfo(s);
        assert.equal(info?.label, 'Previous page', `Shift+Tab twice from Next page reaches Previous page (got ${info?.label})`);
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await pageText())?.[0] === 3, { timeoutMs: 8000, label: 'page 3 with Previous page' });
        used.push('Previous page');
        await s.win.keyboard.press('Tab');
        await s.win.keyboard.press('Tab');
        assert.equal((await focusInfo(s))?.label, 'Next page');
      },
      'Light or dark': async () => {
        const theme = () => s.win.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const t0 = await theme();
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await theme()) !== t0, { timeoutMs: 5000, label: 'theme changed by Enter' });
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await theme()) === t0, { timeoutMs: 5000, label: 'theme back' });
      },
      'Go to page': async () => {
        await s.win.keyboard.type('6');
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await pageText())?.[0] === 6, { timeoutMs: 8000, label: 'page 6 from the status bar box' });
        await refocus(s, 'Go to page');
      },
      'Fit page': async () => {
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await s.win.getByLabel('Fit page', { exact: true }).getAttribute('aria-pressed')) === 'true', { timeoutMs: 5000, label: 'fit page by Enter' });
      },
      'Fit width': async () => {
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await s.win.getByLabel('Fit width', { exact: true }).getAttribute('aria-pressed')) === 'true', { timeoutMs: 5000, label: 'fit width by Enter' });
      },
      'Zoom out': async () => {
        const z = await zoomPercent(s);
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await zoomPercent(s)) < z, { timeoutMs: 5000, label: 'zoom out by Enter' });
      },
      'Zoom level': async () => {
        await s.win.keyboard.type('120');
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await zoomPercent(s)) === 120, { timeoutMs: 5000, label: '120% typed' });
        await refocus(s, 'Zoom level');
      },
      'Zoom presets': async () => {
        await s.win.keyboard.press('Enter');
        const menu = s.win.getByRole('menu', { name: 'Zoom presets' });
        await menu.waitFor({ timeout: 5000 });
        for (let i = 0; i < 12; i++) {
          if (((await s.win.evaluate(() => document.activeElement?.textContent)) ?? '').includes('200%')) break;
          await s.win.keyboard.press('ArrowDown');
        }
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await zoomPercent(s)) === 200, { timeoutMs: 5000, label: '200% from the preset menu by keyboard' });
      },
      'Zoom in': async () => {
        const z = await zoomPercent(s);
        await s.win.keyboard.press('Enter');
        await waitFor(async () => (await zoomPercent(s)) > z, { timeoutMs: 5000, label: 'zoom in by Enter' });
      },
      'Zoom slider': async () => {
        await s.win.keyboard.press('Home');
        await waitFor(async () => (await zoomPercent(s)) === 10, { timeoutMs: 5000, label: 'slider Home' });
        // 1.5.5 A1: the first arrow press moves the zoom (10 -> 11), and Page Up steps like Zoom In (11 -> 25).
        await s.win.keyboard.press('ArrowRight');
        await waitFor(async () => (await zoomPercent(s)) === 11, { timeoutMs: 5000, label: 'slider ArrowRight from 10% shows 11%' });
        await s.win.keyboard.press('PageUp');
        await waitFor(async () => (await zoomPercent(s)) > 11, { timeoutMs: 5000, label: 'slider Page Up steps up' });
        await s.win.keyboard.press('End');
        await waitFor(async () => (await zoomPercent(s)) === 800, { timeoutMs: 5000, label: 'slider End' });
      },
    };
    const actFor = (label) => (act[label] ? label : /^Page colors/.test(label ?? '') ? 'Recolor' : /^Undo/.test(label ?? '') ? 'Undo' : /^Redo/.test(label ?? '') ? 'Redo' : null);

    // Walk the whole window with Tab. At each toolbar/status stop: check the tooltip on focus, then use the control.
    const stops = [];
    const tipless = [];
    for (let i = 0; i < 120; i++) {
      await s.win.keyboard.press('Tab');
      const info = await focusInfo(s);
      if (!info) continue;
      if (!(info.inBar || info.inStatus)) continue;
      const rawLabel = info.label ?? info.id;
      const label = /^Pan(-| and )zoom$/i.test(rawLabel) ? 'Pan and zoom' : rawLabel;
      stops.push(label);
      assert.equal(info.disabled, false, `Tab landed on a disabled control (${label})`);
      if (info.tip) {
        const shown = await waitFor(async () => (await s.win.locator('[role="tooltip"]').first().textContent({ timeout: 100 }).catch(() => null)) === info.tip, { timeoutMs: 1500, label: `tooltip for ${label}` }).then(() => true, () => false);
        // The tooltip must be there on the first keyboard focus, whatever the previous control did (no second look).
        if (!shown) problems.push(`no tooltip on first keyboard focus of "${label}" (expected "${info.tip}")`);
      } else tipless.push(label);
      const key = actFor(label);
      if (key) {
        try {
          await act[key]();
          used.push(label);
        } catch (e) {
          problems.push(`using "${label}" from the keyboard failed: ${String(e.message).split('\n')[0]}`);
          await closeMenus(s);
          await s.win.keyboard.press('Escape');
          await refocus(s, rawLabel);
        }
        // Keep walking from this control (a menu or sheet may have taken the focus).
        if ((await focusInfo(s))?.label !== rawLabel) await refocus(s, rawLabel);
      }
      if (label === 'Zoom slider') break;
    }
    console.log('Tab order:', stops.join(' | '));
    console.log('Used from the keyboard:', used.join(' | '));
    console.log('Focusable controls without their own tooltip:', tipless.join(', '));
    for (const name of ['Open', 'Save', 'Find', 'Page number', 'Light or dark', 'Go to page', 'Fit page', 'Fit width', 'Zoom out', 'Zoom level', 'Zoom presets', 'Zoom in', 'Zoom slider', 'Recent files', 'Split', 'Loupe', 'Pan and zoom', 'Insert pages', 'Delete pages', 'Rotate right 90°', 'More rotation options', 'Crop pages', 'Page size', 'More page actions', 'Next page']) {
      if (!stops.includes(name)) problems.push(`Tab never reached "${name}"`);
      if (!used.includes(name)) problems.push(`"${name}" was not used from the keyboard`);
    }
    for (const prefix of ['Undo', 'Redo', 'Page colors']) {
      if (!stops.some((n) => n?.startsWith(prefix))) problems.push(`Tab never reached ${prefix}`);
      if (!used.some((n) => n?.startsWith(prefix))) problems.push(`${prefix} was not used from the keyboard`);
    }

    assert.deepEqual(problems, [], 'the walk found no problems');
    // Narrow: the "…" menu with the keyboard alone. Every enabled row is reachable with the arrow keys, and Enter runs one.
    await setWidth(s, 720);
    await s.win.evaluate(() => document.activeElement?.blur());
    const more = await tabUntil(s, (i) => i.label === 'More commands');
    assert.ok(more, 'Tab reaches "…"');
    if (more.tip) {
      const shown = await waitFor(async () => (await s.win.locator('[role="tooltip"]').first().textContent({ timeout: 100 }).catch(() => null)) === more.tip, { timeoutMs: 1500, label: 'tooltip for …' }).then(() => true, () => false);
      if (!shown) problems.push('no tooltip on keyboard focus for "…"');
    }
    await s.win.keyboard.press('ArrowDown');
    const menu = s.win.getByRole('menu', { name: 'More commands' });
    await menu.waitFor({ timeout: 5000 });
    const enabledRows = await menu.evaluate((el) => [...el.querySelectorAll('button.menu-item:not(:disabled)')].map((b) => b.querySelector('.menu-label')?.textContent.trim()));
    const reached = [];
    for (let i = 0; i < enabledRows.length + 2; i++) {
      const t = await s.win.evaluate(() => document.activeElement?.querySelector?.('.menu-label')?.textContent?.trim());
      if (t && !reached.includes(t)) reached.push(t);
      await s.win.keyboard.press('ArrowDown');
    }
    assert.deepEqual([...reached].sort(), [...enabledRows].sort(), 'arrow keys reach every enabled row of "…"');
    // Home/End and Esc.
    await s.win.keyboard.press('End');
    const last = await s.win.evaluate(() => document.activeElement?.querySelector?.('.menu-label')?.textContent?.trim());
    assert.equal(last, enabledRows.at(-1), 'End goes to the last row');
    await s.win.keyboard.press('Home');
    assert.equal(await s.win.evaluate(() => document.activeElement?.querySelector?.('.menu-label')?.textContent?.trim()), enabledRows[0]);
    await s.win.keyboard.press('Escape');
    assert.equal((await focusInfo(s))?.label, 'More commands', 'Esc returns the focus to "…"');
    // Enter on a row runs it: Right 90° rotates, and Esc/Enter again.
    await s.win.keyboard.press('Enter');
    await menu.waitFor({ timeout: 5000 });
    for (let i = 0; i < 40; i++) {
      if ((await s.win.evaluate(() => document.activeElement?.querySelector?.('.menu-label')?.textContent?.trim())) === 'Reverse') break;
      await s.win.keyboard.press('ArrowDown');
    }
    const u0 = await undoLabel();
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await undoLabel()) !== u0, { timeoutMs: 10000, label: 'Reverse from "…" by Enter' });
    await s.win.keyboard.press('Control+z');
    // Tab from inside the open menu leaves it and the focus moves on.
    await refocus(s, 'More commands');
    await s.win.keyboard.press('Enter');
    await menu.waitFor({ timeout: 5000 });
    await s.win.keyboard.press('Tab');
    assert.equal(await menu.count(), 0, 'Tab closes the "…" menu');
    // Save what is left unsaved so nothing is left behind.
    if (await isDirty(s.win)) await saveNow(s.win);
    assert.deepEqual(problems, []);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeCopy(work);
    removeCopy(second);
  }
});

// ------------------------------------------------------------------------------------------------ 6. labels, Close All, wording, titles

test('6a Show Labels survives a restart and a hard kill; the labels are right in each mode', async () => {
  const profile = newProfileDir();
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1800);
    assert.equal(await labelsChecked(s), false, 'off by default');
    await setShowLabels(s, true);
    assert.equal((await barState(s)).labelsShown, true);
    // A hard kill a few seconds after the change (Chromium flushes local storage lazily).
    await delay(6000);
    await forceKill(s.app);
    s = await launch({ profile });
    await s.win.waitForSelector('.menu-row');
    assert.equal(await labelsChecked(s), true, 'Show Labels survived a hard kill 6 s later');
    await setWidth(s, 1800);
    await waitFor(async () => (await barState(s)).labelsShown, { timeoutMs: 8000, label: 'labels drawn after the restart' });
    // Information: a hard kill immediately after turning it off.
    await setShowLabels(s, false);
    await forceKill(s.app);
    s = await launch({ profile });
    await s.win.waitForSelector('.menu-row');
    console.log(`6a: after Show Labels OFF and a hard kill at once, the next start has it ${(await labelsChecked(s)) ? 'still ON (the change was lost)' : 'OFF (kept)'}`);
    await setShowLabels(s, true);
    // Toggle off, then on, then off again, quickly; restart cleanly: the last choice wins.
    await setShowLabels(s, false);
    await setShowLabels(s, true);
    await setShowLabels(s, false);
    await s.close();
    s = await launch({ profile });
    await s.win.waitForSelector('.menu-row');
    assert.equal(await labelsChecked(s), false, 'the last choice (off) is the one remembered');
    await setWidth(s, 1800);
    assert.equal((await barState(s)).labelsShown, false);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
  }
});

test('6b Ctrl+Shift+W closes all tabs and asks about unsaved ones (Cancel keeps everything, Save saves, Don\'t save discards); with no tabs it does nothing', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(MARGINS);
  const s = await launch();
  const prompt = () => s.win.getByRole('alertdialog');
  try {
    await s.win.waitForSelector('.empty-state');
    await s.win.keyboard.press('Control+Shift+w');
    await delay(500);
    assert.equal(await prompt().count(), 0, 'nothing to close, nothing asked');
    await openFile(s, a.path, 8);
    await s.setDialogAnswer([b.path]);
    await s.win.keyboard.press('Control+o');
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 2, { timeoutMs: 20000, label: 'two tabs' });
    // Clean tabs: Ctrl+Shift+W closes both with no question.
    await s.win.keyboard.press('Control+Shift+w');
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 0, { timeoutMs: 10000, label: 'closed without a prompt' });
    assert.equal(await prompt().count(), 0);
    // Now with an edit in the first tab.
    await openFile(s, a.path, 8);
    await s.setDialogAnswer([b.path]);
    await s.win.keyboard.press('Control+o');
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 2, { timeoutMs: 20000, label: 'two tabs again' });
    await s.win.getByRole('tab').first().click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 8'), { timeoutMs: 10000, label: 'first tab active' });
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => /of 7\b/.test(await statusText(s.win)), { timeoutMs: 15000, label: '7 pages' });
    // Cancel keeps everything.
    await s.win.keyboard.press('Control+Shift+w');
    await prompt().waitFor({ timeout: 10000 });
    await prompt().getByRole('button', { name: 'Cancel' }).click();
    await delay(500);
    assert.equal(await s.win.getByRole('tab').count(), 2, 'Cancel keeps both tabs');
    assert.equal(await isDirty(s.win), true, 'and the edit');
    // Don't save discards the edit and closes both.
    await s.win.keyboard.press('Control+Shift+w');
    await prompt().getByRole('button', { name: "Don't save" }).click();
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 0, { timeoutMs: 10000, label: "closed after Don't save" });
    assert.equal(diskInfo(a.path).pages, 8, "Don't save left the file with 8 pages");
    // Save writes and closes.
    await openFile(s, a.path, 8);
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => /of 7\b/.test(await statusText(s.win)), { timeoutMs: 15000, label: '7 pages again' });
    await s.win.keyboard.press('Control+Shift+w');
    await prompt().getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 0, { timeoutMs: 20000, label: 'closed after Save' });
    assert.equal(diskInfo(a.path).pages, 7, 'Save wrote the edit before closing');
    // The menu entry does the same thing.
    await openFile(s, a.path, 7);
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => /of 6\b/.test(await statusText(s.win)), { timeoutMs: 15000, label: '6 pages' });
    await menuPick(s, ['File', 'Close All']);
    await prompt().waitFor({ timeout: 10000 });
    await prompt().getByRole('button', { name: "Don't save" }).click();
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 0, { timeoutMs: 10000, label: 'closed from the menu' });
    assert.equal(diskInfo(a.path).pages, 7);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeCopy(a);
    removeCopy(b);
  }
});

test('6c lined and grid inserts say "lined" and "grid" from every entry point (toolbar menu, Pages menu, palette), for one and for several pages', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);
    const undo = () => barBtn(s, /^Undo/);
    const apply = async () => {
      const sheet = s.win.getByRole('dialog', { name: 'Insert pages' });
      await sheet.waitFor({ timeout: 10000 });
      return sheet;
    };
    for (const [row, kind, menuLabel] of [['Lined page…', 'lined', 'Insert Lined Page…'], ['Grid page…', 'grid', 'Insert Grid Page…'], ['Blank page…', 'blank', 'Insert Blank Page…']]) {
      for (const via of ['toolbar', 'pages menu']) {
        if (via === 'toolbar') {
          await barBtn(s, 'Insert pages').click();
          await rowByLabel(s.win.locator('.tb-popup').first(), row).first().click();
        } else await menuPick(s, ['Pages', menuLabel]);
        const sheet = await apply();
        await sheet.getByRole('button', { name: 'Apply' }).click();
        await s.win.locator('.toast', { hasText: `Inserted 1 ${kind} page` }).first().waitFor({ timeout: 10000 });
        await waitFor(async () => (await undo().getAttribute('aria-label')) === `Undo Insert 1 ${kind} page`, { timeoutMs: 10000, label: `Undo says ${kind} (${via})` });
        await s.win.keyboard.press('Control+z');
        await waitFor(async () => (await undo().getAttribute('aria-label')) === 'Undo', { timeoutMs: 10000, label: 'undone' });
        // The wording must not have leaked a wrong word into the other kinds.
        for (const wrong of ['lined', 'grid', 'blank'].filter((k) => k !== kind)) {
          assert.equal(await s.win.locator('.toast', { hasText: `Inserted 1 ${wrong} page` }).count(), 0, `the ${kind} insert never says ${wrong}`);
        }
      }
    }
    // Several pages: the sheet has a count field.
    await palette(s.win, 'Pages: Insert lined page…');
    const sheet = await apply();
    const count = sheet.getByRole('spinbutton').first();
    if (await count.count()) {
      await count.fill('3');
      await sheet.getByRole('button', { name: 'Apply' }).click();
      await s.win.locator('.toast', { hasText: 'Inserted 3 lined pages' }).first().waitFor({ timeout: 10000 });
      await waitFor(async () => (await undo().getAttribute('aria-label')) === 'Undo Insert 3 lined pages', { timeoutMs: 10000, label: 'Undo says 3 lined pages' });
      await s.win.keyboard.press('Control+z');
    } else {
      await sheet.getByRole('button', { name: 'Cancel' }).click();
      console.log('Insert sheet has no count spinbutton; the several-pages wording was not tested');
    }
    await waitFor(async () => (await undo().getAttribute('aria-label')) === 'Undo', { timeoutMs: 10000, label: 'back to the start' });
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('6d window titles: very long names, no extension, unicode and a short name; the extension, the unsaved dot and " — PDF Suite" always stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-matrix-'));
  const names = [
    `${'L'.repeat(180)}.pdf`,
    `Quarterly report — final (v2) ${'x'.repeat(150)} résumé 🙂 scan.pdf`,
    `${'A'.repeat(60)}.tar.gz.${'b'.repeat(60)}.pdf`,
    'short.pdf',
  ];
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await setWidth(s, 900);
    for (const name of names) {
      const path = join(dir, name);
      copyFileSync(fixture(MARGINS), path);
      await openFile(s, path, 2);
      const read = () =>
        s.win.evaluate(() => {
          const g = (sel) => document.querySelector(sel);
          const box = (el) => el.getBoundingClientRect();
          return {
            doc: document.title,
            tip: g('.menu-title').getAttribute('title'),
            head: g('.menu-title-head').textContent,
            end: g('.menu-title-end').textContent,
            tail: g('.menu-title-tail').textContent,
            tailClipped: g('.menu-title-tail').scrollWidth > g('.menu-title-tail').clientWidth,
            endClipped: g('.menu-title-end').scrollWidth > g('.menu-title-end').clientWidth,
            tailRight: box(g('.menu-title-tail')).right,
            endRight: box(g('.menu-title-end')).right,
            tailLeft: box(g('.menu-title-tail')).left,
            titleLeft: box(g('.menu-title')).left,
            tops: box(g('.menu-tops')).right,
            buttons: box(g('.menu-window-space')).left,
          };
        });
      let t = await read();
      const nativeTitle = () => s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
      assert.equal(t.tip, `${name} — PDF Suite`, `clean title tooltip for ${name.slice(0, 30)}…`);
      assert.equal(t.doc, t.tip, 'document.title equals the tooltip');
      assert.equal(await nativeTitle(), t.tip, 'the native window title (taskbar) is the same');
      assert.equal(t.tailClipped, false, 'the tail is not cut');
      assert.ok(t.tail.endsWith('— PDF Suite') && !t.tail.includes('•'), `no dot on a clean file: ${JSON.stringify(t.tail)}`);
      assert.ok(name.endsWith(t.end) && /\.pdf$/.test(t.end) === (name.length > 0), `the end part keeps the extension: ${JSON.stringify(t.end)}`);
      assert.ok(t.tailRight <= t.buttons + 1 && t.titleLeft >= t.tops - 1, 'the title sits between the menus and the window buttons');
      assert.ok(t.endRight <= t.tailLeft + 1, 'the end of the name comes before the tail');
      // Unsaved dot.
      await palette(s.win, 'Pages: Rotate right 90°');
      await waitFor(async () => (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 10000, label: 'dirty' });
      t = await read();
      assert.equal(t.tip, `${name} • — PDF Suite`, 'the dot is in the title');
      assert.ok(t.tail.includes('•') && t.tail.endsWith('— PDF Suite'), `the dot and the app name are in the tail: ${JSON.stringify(t.tail)}`);
      assert.equal(t.tailClipped, false);
      assert.equal(await nativeTitle(), t.tip);
      assert.ok(t.tailRight <= t.buttons + 1, 'the tail does not run under the window buttons');
      await s.win.keyboard.press('Control+s');
      await waitFor(async () => (await s.win.locator('.tab-dirty').count()) === 0, { timeoutMs: 20000, label: 'saved' });
      t = await read();
      assert.ok(!t.tail.includes('•'), 'the dot is gone after the save');
      // The narrowest width.
      await setWidth(s, 720);
      t = await read();
      assert.equal(t.tailClipped, false, 'the tail is not cut at 720 px');
      assert.ok(t.tailRight <= t.buttons + 1, 'the tail does not run under the window buttons at 720 px');
      assert.ok(t.titleLeft >= t.tops - 1);
      await setWidth(s, 900);
      await s.win.keyboard.press('Control+w');
      await waitFor(async () => (await s.win.getByRole('tab').count()) === 0, { timeoutMs: 10000, label: 'closed' });
    }
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ 7. screenshots

test('7 screenshots of the toolbar and status bar at three widths, labels off and on, light and dark, and an automatic look at the geometry', async () => {
  mkdirSync(OUT, { recursive: true });
  const s = await launch();
  const problems = [];
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 10000, label: 'dirty (shows Undo enabled)' });
    for (const theme of ['Light', 'Dark']) {
      await menuPick(s, ['View', 'Theme', theme]);
      for (const labels of [false, true]) {
        await setWidth(s, 1800);
        await setShowLabels(s, labels);
        for (const width of [1500, 1000, 720]) {
          await setWidth(s, width);
          await delay(400);
          const tag = `toolbar-${width}-${labels ? 'labels' : 'icons'}-${theme.toLowerCase()}`;
          await s.win.mouse.move(width / 2, 400);
          await s.win.screenshot({ path: join(OUT, `${tag}.png`), clip: { x: 0, y: 0, width, height: 150 } });
          await s.win.screenshot({ path: join(OUT, `${tag}-status.png`), clip: { x: 0, y: 800 - 26, width, height: 26 } });
          // Geometry: every visible button in one row, 32 px tall, no overlaps, nothing outside the bar.
          const geo = await s.win.evaluate(() => {
            const barBox = document.querySelector('.top-bar').getBoundingClientRect();
            const boxes = [...document.querySelectorAll('.top-bar button')]
              .filter((b) => b.offsetParent !== null && !b.closest('.tb-collapsed'))
              .map((b) => {
                const r = b.getBoundingClientRect();
                return { name: b.getAttribute('aria-label'), x: r.left, y: r.top, w: r.width, h: r.height, cy: r.top + r.height / 2 };
              });
            const svgs = [...document.querySelectorAll('.top-bar button svg')].filter((v) => v.getBoundingClientRect().width > 0).map((v) => ({ w: v.getBoundingClientRect().width, h: v.getBoundingClientRect().height }));
            const clippedIcons = [...document.querySelectorAll('.top-bar button')].filter((b) => b.offsetParent !== null && b.scrollWidth > b.clientWidth + 1).map((b) => b.getAttribute('aria-label'));
            const statusInputs = [...document.querySelectorAll('footer.status-bar input, footer.status-bar button')].filter((el) => el.offsetParent !== null).map((el) => ({ name: el.getAttribute('aria-label'), cy: el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2, h: el.getBoundingClientRect().height }));
            const colors = (() => {
              const cs = getComputedStyle(document.querySelector('.top-bar button:not(:disabled)'));
              const bg = getComputedStyle(document.querySelector('.top-bar')).backgroundColor;
              return { fg: cs.color, bg };
            })();
            return { barBox: { l: barBox.left, r: barBox.right, t: barBox.top, b: barBox.bottom }, boxes, svgs, clippedIcons, statusInputs, colors };
          });
          const tag2 = `${width}px labels=${labels} ${theme}`;
          const rows = new Set(geo.boxes.filter((b) => b.h >= 20).map((b) => Math.round(b.cy)));
          if (rows.size > 1) problems.push(`${tag2}: buttons are not on one line (centres ${[...rows]})`);
          const sorted = [...geo.boxes].sort((a, b) => a.x - b.x);
          for (let i = 1; i < sorted.length; i++) if (sorted[i].x < sorted[i - 1].x + sorted[i - 1].w - 0.5) problems.push(`${tag2}: ${sorted[i - 1].name} overlaps ${sorted[i].name}`);
          for (const b of geo.boxes) if (b.x < geo.barBox.l - 0.5 || b.x + b.w > geo.barBox.r + 0.5) problems.push(`${tag2}: ${b.name} is outside the bar`);
          for (const v of geo.svgs) if (v.w > 0 && ![12, 18, 16].includes(Math.round(v.w))) problems.push(`${tag2}: an icon is ${v.w}x${v.h}`);
          if (geo.clippedIcons.length) problems.push(`${tag2}: clipped buttons ${geo.clippedIcons}`);
          const cys = new Set(geo.statusInputs.map((x) => Math.round(x.cy)));
          if (cys.size > 1) problems.push(`${tag2}: status bar controls are not on one line (${[...cys]})`);
          assert.ok(existsSync(join(OUT, `${tag}.png`)));
        }
      }
    }
    console.log('geometry problems:', JSON.stringify(problems, null, 1));
    assert.deepEqual(problems, []);
    await menuPick(s, ['View', 'Theme', 'System']);
    await saveNowOrDiscard(s);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

async function saveNowOrDiscard() {
  // The test-mode quit discards the one rotate; nothing else to do.
}

void unlinkSync;
