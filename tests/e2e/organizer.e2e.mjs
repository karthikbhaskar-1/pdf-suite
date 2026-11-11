// Page organizer (1.2.1), driven through the real UI of the packaged app. Each test opens a copy of a fixture in a
// temp folder, so saves never touch the fixtures. Outcomes are checked on what the user sees (thumbnail order, page
// count, page size in Properties, toasts, the tab dot, the info bars) and on the file on disk after a save.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mu from 'mupdf';
import { launch, fixture, statusText, waitFor, waitForPage, forceKill, closeAll, cleanupProfile, ROOT } from './helpers.mjs';

after(closeAll);

const MIXED = 'mixed-sizes-rotated.pdf'; // 8 pages: Letter, A4, Letter, A3, 300x300, Letter rotated 90, A5, 500x900
const XFA = join(ROOT, 'tests', 'engine', 'corpus', 'xfa', 'xfa_filled_imm1344e.pdf');

/** A fresh copy of a fixture in its own temp folder. */
function copyOf(name) {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-organizer-'));
  const path = join(dir, name);
  copyFileSync(name.startsWith('/') || name.includes(':') ? name : fixture(name), path);
  return { dir, path };
}

/** Page count from the status bar ("Page 1 of 8"). */
async function pageCount(win) {
  const match = /of (\d+)/.exec(await statusText(win));
  return match ? Number(match[1]) : -1;
}

/**
 * The uids of all the pages in list order. The thumbnail list draws only the rows near the view, so the list is scrolled
 * in steps and each row is kept by its position. A page added by an edit has a uid starting with "n".
 */
async function uids(win) {
  return win.evaluate(async () => {
    const list = document.querySelector('.thumb-list');
    if (!list) return [];
    const seen = new Map();
    const step = Math.max(120, list.clientHeight / 2);
    for (let y = 0; y <= list.scrollHeight; y += step) {
      list.scrollTop = y;
      await new Promise((resolve) => setTimeout(resolve, 40));
      for (const el of list.querySelectorAll('.thumb')) seen.set(Number.parseFloat(el.style.top), el.dataset.uid);
    }
    list.scrollTop = 0;
    return [...seen.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  });
}

/** Waits until the thumbnails show `count` pages. */
async function waitForCount(win, count) {
  await waitFor(async () => (await pageCount(win)) === count && (await uids(win)).length === count, {
    timeoutMs: 20000,
    label: `${count} pages`,
  });
}

/** Shows a rail panel (Thumbnails, Properties) if it is not already open. */
async function showPanel(win, name) {
  const button = win.getByRole('button', { name, exact: true }).first();
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
}

/**
 * Opens a file through Ctrl+O, the stubbed Open dialog, and waits for its first page. The Thumbnails panel is shown, since
 * the tests work on its rows.
 */
async function open(s, path, pages) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, `Page 1 of ${pages}`);
  await showPanel(s.win, 'Thumbnails');
  await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
}

/** The Pages group of the top bar. */
const pagesGroup = (win) => win.getByRole('group', { name: 'Pages' });

/** Opens a menu of the Pages group by its button's name and picks an item. (Since 1.2.2 these are icon buttons with a name, not a summary with text.) */
async function pickFromPages(win, buttonName, item) {
  await pagesGroup(win).getByRole('button', { name: buttonName }).first().click();
  await pagesGroup(win).getByRole('menuitem', { name: item }).click();
}

/**
 * Returns the page size shown in Properties for the current page, in points. Properties is moved to the right dock, so the
 * Thumbnails panel can stay open beside it.
 */
async function currentPageSize(win) {
  const properties = win.locator('aside.dock', { hasText: 'Properties' });
  if ((await properties.count()) === 0) {
    await showPanel(win, 'Properties');
    await win.locator('aside.dock', { hasText: 'Properties' }).getByRole('button', { name: 'Dock right' }).click();
    await showPanel(win, 'Thumbnails');
  }
  // The "Size" row of the Current page section. Its label is exactly "Size"; the Document section has "File size".
  const handle = await win.waitForFunction(
    () => {
      const row = [...document.querySelectorAll('.props-row')].find((r) => r.innerText.trim().split('\n')[0].trim() === 'Size');
      return row ? row.innerText : null;
    },
    undefined,
    { timeout: 10000 },
  );
  const text = await handle.jsonValue();
  const match = /([\d.]+) × ([\d.]+) pt/.exec(text);
  assert.ok(match, `no size in "${text}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** A sheet of the side panel, by its title. */
const sheet = (win, title) => win.getByRole('dialog', { name: title });

/** Makes the thumbnail `index` the current page by a plain click. */
async function jumpTo(win, index) {
  await win.locator('.thumb').nth(index).click();
  await waitFor(async () => (await win.locator('.thumb-current').count()) === 1, { timeoutMs: 10000, label: 'current page' });
}

/** Counts the pages in a PDF file on disk, from its page objects. */
function pagesOnDisk(path) {
  const text = readFileSync(path).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

test('drag reorders three selected pages as one block, and the list follows', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    assert.deepEqual(await uids(s.win), ['0', '1', '2', '3', '4', '5', '6', '7']);

    // Select pages 1 to 3 with Shift-click, then drag the first of them onto the upper half of page 5 (the rows near the
    // top of the list are drawn, so both ends of the drag are on screen).
    await s.win.locator('.thumb').nth(0).click();
    await s.win.locator('.thumb').nth(2).click({ modifiers: ['Shift'] });
    assert.equal(await s.win.locator('.thumb-selected').count(), 3);
    await s.win.locator('.thumb').nth(0).dragTo(s.win.locator('.thumb').nth(4), { targetPosition: { x: 60, y: 4 } });

    await waitFor(async () => (await uids(s.win)).join(',') === '3,0,1,2,4,5,6,7', { timeoutMs: 15000, label: 'new order' });
    assert.deepEqual(await uids(s.win), ['3', '0', '1', '2', '4', '5', '6', '7']);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('Insert sheet: two blank pages after page 1, with a live preview and the Undo toast', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await pickFromPages(s.win, 'Insert', 'Blank page…');
    const dialog = sheet(s.win, 'Insert pages');
    await dialog.waitFor();
    await dialog.getByRole('spinbutton', { name: 'Number of pages' }).fill('2');
    assert.match(await dialog.innerText(), /Adds 2 blank pages after page 1/);
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 10);
    const order = await uids(s.win);
    assert.deepEqual(order.slice(0, 1), ['0']);
    assert.ok(order[1].startsWith('n') && order[2].startsWith('n'), `new pages in place: ${order.join(',')}`);
    assert.equal(await dialog.count(), 0, 'the sheet closes after Apply');
    await s.win.locator('.toast', { hasText: 'Inserted 2 blank pages' }).first().waitFor({ timeout: 5000 });
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('From PDF sheet: pages 1-2 of another PDF are inserted after the current page', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.setDialogAnswer([copy.path]);
    await pickFromPages(s.win, 'Insert', 'From PDF…');
    const dialog = sheet(s.win, 'Insert from a PDF');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await dialog.getByText(/8 pages/).waitFor({ timeout: 20000 });
    await dialog.getByRole('textbox', { name: 'Page range' }).fill('1-2');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(s.win, 10);
    assert.equal((await uids(s.win)).filter((u) => u.startsWith('n')).length, 2);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('Replace sheet: page 1 takes the size of page 2 of another PDF', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    assert.deepEqual(await currentPageSize(s.win), { width: 612, height: 792 });
    await s.setDialogAnswer([copy.path]);
    await pagesGroup(s.win).getByRole('button', { name: 'More page actions' }).click();
    await pagesGroup(s.win).getByRole('menuitem', { name: 'Replace…' }).click();
    const dialog = sheet(s.win, 'Replace page');
    await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await dialog.getByText(/8 pages/).waitFor({ timeout: 20000 });
    await dialog.getByRole('spinbutton', { name: 'Page in the PDF' }).fill('2');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await s.win.locator('.toast', { hasText: 'Replaced the page' }).first().waitFor({ timeout: 10000 });
    await waitFor(async () => (await currentPageSize(s.win)).width > 595 && (await currentPageSize(s.win)).width < 596, {
      timeoutMs: 15000,
      label: 'A4 width',
    });
    assert.equal(await pageCount(s.win), 8);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('Rotate sheet: a custom angle of 12.5 degrees turns the page (its size grows)', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await pagesGroup(s.win).getByRole('button', { name: 'More rotation options' }).click();
    await pagesGroup(s.win).getByRole('menuitem', { name: 'Custom angle…' }).click();
    const dialog = sheet(s.win, 'Rotate pages');
    await dialog.getByRole('spinbutton', { name: 'Angle in degrees' }).fill('12.5');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await s.win.locator('.toast', { hasText: 'Rotated 1 page' }).first().waitFor({ timeout: 10000 });
    await waitFor(async () => (await currentPageSize(s.win)).width > 700, { timeoutMs: 15000, label: 'rotated page size' });
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('Crop sheet by numbers (36 pt on each side), then Auto-crop with Cancel to undo it', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await pickFromPages(s.win, 'Crop', 'Crop pages…');
    const dialog = sheet(s.win, 'Crop pages');
    await dialog.waitFor();
    await dialog.getByRole('combobox', { name: 'Units' }).selectOption('pt');
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) {
      await dialog.getByRole('spinbutton', { name: `${edge} margin` }).fill('36');
    }
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await waitFor(async () => (await currentPageSize(s.win)).width === 540, { timeoutMs: 15000, label: 'cropped width' });
    assert.deepEqual(await currentPageSize(s.win), { width: 540, height: 720 });

    // Auto-crop: applied at once, with the page shown trimmed; Cancel undoes it.
    await jumpTo(s.win, 0);
    await pickFromPages(s.win, 'Crop', 'Crop pages…');
    const again = sheet(s.win, 'Crop pages');
    await again.getByRole('button', { name: 'Auto-crop' }).click();
    await again.getByText('Auto-crop applied. Cancel undoes it.').waitFor({ timeout: 15000 });
    const trimmed = await currentPageSize(s.win);
    assert.ok(trimmed.width < 540 || trimmed.height < 720, `auto-crop trimmed the page: ${trimmed.width} x ${trimmed.height}`);
    await again.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await currentPageSize(s.win)).width === 540, { timeoutMs: 15000, label: 'auto-crop undone' });
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('Page size sheet: A4 for all pages, scaled to fit', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await jumpTo(s.win, 0);
    await pagesGroup(s.win).getByRole('button', { name: 'Page size' }).click();
    const dialog = sheet(s.win, 'Page size');
    await dialog.getByRole('radio', { name: 'A4' }).click();
    await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await waitFor(async () => (await currentPageSize(s.win)).width === 595.3, { timeoutMs: 15000, label: 'A4 width' });
    assert.deepEqual(await currentPageSize(s.win), { width: 595.3, height: 841.9 });
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('Extract: the Save dialog proposes "<name>-extract.pdf" and the selected pages go to that file', async () => {
  const copy = copyOf(MIXED);
  const target = join(copy.dir, 'mixed-sizes-rotated-extract.pdf');
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.app.evaluate(({ dialog }, out) => {
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.__suggestedName = options.defaultPath;
        return { canceled: false, filePath: out };
      };
    }, target);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.locator('.thumb').nth(1).click({ modifiers: ['Control'] });
    await s.win.getByRole('toolbar', { name: 'Page actions' }).getByRole('button', { name: 'Extract pages to a new PDF' }).click();
    await s.win.locator('.toast', { hasText: 'Extracted 2 pages' }).first().waitFor({ timeout: 15000 });
    const suggested = await s.app.evaluate(() => globalThis.__suggestedName);
    assert.equal(suggested, 'mixed-sizes-rotated-extract.pdf');
    assert.ok(existsSync(target), 'the extract file exists');
    assert.equal(pagesOnDisk(target), 2);
    assert.equal(await pageCount(s.win), 8, 'the open document is unchanged');
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('Delete of more than half the pages asks inline in the sheet first; Ctrl+Z and Ctrl+Y redo and undo it', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.win.locator('.thumb').nth(0).click();
    for (let i = 1; i <= 5; i++) await s.win.locator('.thumb').nth(i).click({ modifiers: ['Control'] });
    await s.win.keyboard.press('Delete');
    const confirm = sheet(s.win, 'Delete pages?');
    await confirm.getByText('This removes 6 of 8 pages').waitFor({ timeout: 5000 });
    assert.equal(await pageCount(s.win), 8, 'nothing is deleted before the confirmation');
    await confirm.getByRole('button', { name: 'Delete 6 pages' }).click();
    await waitForCount(s.win, 2);

    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 8);
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 2);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 8);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('the unsaved dot shows on the tab and in the title, and closing asks Save / Don\'t save / Cancel', async () => {
  const copy = copyOf(MIXED);
  const before = statSync(copy.path).size;
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } }); // this test checks the prompt itself
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    assert.equal(await s.win.locator('.tab-dirty').count(), 0);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    await s.win.locator('.tab-dirty').first().waitFor({ timeout: 5000 });
    await waitFor(async () => (await s.win.title()).includes(' •'), { timeoutMs: 5000, label: 'title bullet' });

    // Cancel keeps the window open.
    const closing = async () => s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await closing();
    const prompt = s.win.getByRole('alertdialog');
    await prompt.waitFor({ timeout: 10000 });
    assert.match(await prompt.innerText(), /Save changes to mixed-sizes-rotated\.pdf before closing\?/);
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await prompt.waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(s.app.windows().length, 1, 'Cancel keeps the window');
    assert.equal(await pageCount(s.win), 7);

    // Don't save closes the app and leaves the file as it was.
    await closing();
    await s.win.getByRole('alertdialog').getByRole('button', { name: "Don't save" }).click();
    await waitFor(async () => s.app.process().exitCode !== null || s.app.windows().length === 0, { timeoutMs: 20000, label: 'window closed' });
    assert.equal(statSync(copy.path).size, before, 'Don\'t save leaves the file unchanged');
    assert.equal(pagesOnDisk(copy.path), 8);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('the close prompt\'s Save writes the edits to the file', async () => {
  const copy = copyOf(MIXED);
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } }); // this test checks the prompt itself
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await s.win.getByRole('alertdialog').getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(async () => s.app.process().exitCode !== null || s.app.windows().length === 0, { timeoutMs: 30000, label: 'window closed' });
    assert.equal(pagesOnDisk(copy.path), 7, 'the saved file has the 7 pages');
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('the changed-on-disk bar offers Reload and Keep my version', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    // Another program writes the file: a different PDF takes its place.
    writeFileSync(copy.path, readFileSync(fixture('big-1000.pdf')));
    await s.win.getByRole('status').filter({ hasText: 'This file changed on disk.' }).waitFor({ timeout: 20000 });
    await s.win.getByRole('button', { name: 'Keep my version' }).click();
    await waitFor(async () => (await s.win.getByText('This file changed on disk.').count()) === 0, { timeoutMs: 5000, label: 'bar gone' });
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('the recovery bar appears after a crash with unsaved edits; Discard reloads the file', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  const profile = s.profile;
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    await s.win.waitForTimeout(1500);
    await forceKill(s.app);
    await waitFor(async () => s.app.process().exitCode !== null || s.app.process().signalCode !== null, { timeoutMs: 15000, label: 'kill' }).catch(() => undefined);

    const r = await launch({ profile });
    try {
      const bar = r.win.getByRole('status').filter({ hasText: 'Recovered unsaved edits' });
      await bar.waitFor({ timeout: 30000 });
      await r.win.getByRole('button', { name: 'Discard' }).click();
      await waitFor(async () => (await pageCount(r.win)) === 8, { timeoutMs: 20000, label: 'file reloaded from disk' });
      assert.equal(await r.win.getByRole('status').filter({ hasText: 'Recovered unsaved edits' }).count(), 0);
      assert.equal(pagesOnDisk(copy.path), 8, 'the file itself was never changed');
    } finally {
      await r.close();
    }
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(profile);
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('an XFA form shows the organizer disabled, with the spec tooltip', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([XFA]);
    await s.win.keyboard.press('Control+o');
    await waitForPages(s);
    const group = pagesGroup(s.win);
    const del = group.getByRole('button', { name: 'Delete pages' });
    await del.waitFor();
    assert.equal(await del.isDisabled(), true);
    // The tooltip text is in data-tooltip since 1.2.2 (the toolbar has its own tooltip, shown after 500 ms).
    assert.equal(await del.getAttribute('data-tooltip'), 'This form can be viewed but not edited yet.');
    const undo = s.win.getByRole('button', { name: 'Undo' }).first();
    assert.equal(await undo.isDisabled(), true);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
  }
});

/** The page count of a file that opens in the viewer, read from the status bar once it is there. */
async function waitForPages(s) {
  await s.win.waitForSelector('.status-bar');
  await waitFor(async () => /of \d+/.test(await statusText(s.win)), { timeoutMs: 60000, label: 'status' });
  return Number(/of (\d+)/.exec(await statusText(s.win))[1]);
}

/** The menu bar: File, Edit, View, Pages, Window and Help (1.2.1 add-on). */
const dropdown = (win) => win.locator('.menu-dropdown').first();

test('the menu bar opens each top-level menu by mouse and by Alt+mnemonic', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.menu-row');
    const bar = s.win.getByRole('menubar');
    for (const [name, key] of [['File', 'f'], ['Edit', 'e'], ['View', 'v'], ['Pages', 'p'], ['Window', 'w'], ['Help', 'h']]) {
      await bar.getByRole('menuitem', { name, exact: true }).click();
      await dropdown(s.win).waitFor({ timeout: 5000 });
      await s.win.keyboard.press('Escape');
      await dropdown(s.win).waitFor({ state: 'detached', timeout: 5000 });
      await s.win.keyboard.press(`Alt+${key}`);
      await dropdown(s.win).waitFor({ timeout: 5000 });
      assert.equal(await bar.getByRole('menuitem', { name, exact: true }).getAttribute('aria-expanded'), 'true', `${name} opens with Alt+${key}`);
      await s.win.keyboard.press('Escape');
      await dropdown(s.win).waitFor({ state: 'detached', timeout: 5000 });
    }
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
  }
});

test('with no document open, a disabled menu item does nothing when clicked', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const undo = s.win.locator('.menu-dropdown').getByRole('menuitem', { name: /^Undo/ });
    assert.equal(await undo.isDisabled(), true);
    await undo.click({ force: true });
    assert.equal(await s.win.locator('.toast').count(), 0, 'no toast: the command did not run');
    await s.win.keyboard.press('Escape');
  } finally {
    await s.close();
  }
});

test('File > Save As writes the edited document to the new file and leaves the original alone', async () => {
  const copy = copyOf(MIXED);
  const target = join(copy.dir, 'saved-as.pdf');
  const originalSize = statSync(copy.path).size;
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    await s.app.evaluate(({ dialog }, out) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
    }, target);
    await s.win.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
    await dropdown(s.win).getByRole('menuitem', { name: 'Save As…' }).click();
    await waitFor(() => existsSync(target), { timeoutMs: 20000, label: 'saved file' });
    assert.equal(pagesOnDisk(target), 7, 'the new file has the edited pages');
    assert.equal(statSync(copy.path).size, originalSize, 'the original file is unchanged');
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('the Edit menu names the undo step, and View > Toolbar hides the top bar and keeps it hidden after a restart', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  const profile = s.profile;
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    await s.win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await dropdown(s.win).getByRole('menuitem', { name: 'Undo Delete 1 page' }).waitFor({ timeout: 5000 });
    await s.win.keyboard.press('Escape');

    await s.win.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
    // View > Toolbar is a submenu since 1.2.2: Show Toolbar and Show Labels.
    await dropdown(s.win).getByRole('menuitem', { name: 'Toolbar' }).click();
    await s.win.getByRole('menuitemcheckbox', { name: 'Show Toolbar' }).click();
    await waitFor(async () => (await s.win.locator('.top-bar').count()) === 0, { timeoutMs: 5000, label: 'toolbar hidden' });
    await s.app.close().catch(() => undefined);

    const r = await launch({ profile });
    try {
      await r.win.waitForSelector('.menu-row');
      await r.win.waitForTimeout(500);
      assert.equal(await r.win.locator('.top-bar').count(), 0, 'the toolbar stays hidden after a restart');
    } finally {
      await r.close();
    }
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(profile);
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

/** True once the app process has exited. Playwright stops answering for the process after it exits, which counts as exited. */
function appExited(s) {
  try {
    const p = s.app.process();
    return p.exitCode !== null || p.signalCode !== null;
  } catch {
    return true;
  }
}

test('a plain close with unsaved edits exits within 5 s and leaves no window (test mode, no prompt)', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    const started = Date.now();
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    // Done when the process has exited, or when no window is left (the process may still be finishing).
    await waitFor(async () => {
      if (appExited(s)) return true;
      try {
        return (await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0;
      } catch {
        return true;
      }
    }, { timeoutMs: 5000, label: 'window closed' });
    console.log('  window gone after ' + (Date.now() - started) + ' ms');
    await waitFor(async () => appExited(s), { timeoutMs: 5000, label: 'app exit after a plain close' });
    console.log('  app exited after ' + (Date.now() - started) + ' ms');
    assert.ok(Date.now() - started <= 5000, 'the app exits within 5 s');
    assert.ok(appExited(s), 'the app process has exited');
    assert.equal(pagesOnDisk(copy.path), 8, 'the file was not changed');
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('a page selection made in one document never reaches another: Delete from the toolbar in B deletes only B\'s current page', async () => {
  // Two files in one folder, so their document ids share a long prefix (the old page ids collided).
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-organizer-'));
  const a = join(dir, 'A.pdf');
  const b = join(dir, 'B.pdf');
  copyFileSync(fixture(MIXED), a);
  copyFileSync(fixture(MIXED), b);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a, 8);
    // Select pages 1-3 in A.
    await s.win.locator('.thumb').nth(0).click();
    await s.win.locator('.thumb').nth(2).click({ modifiers: ['Shift'] });
    await waitFor(async () => (await s.win.locator('.thumb-selected').count()) === 3, { timeoutMs: 10000, label: 'three pages selected in A' });
    await open(s, b, 8);
    // B is active with its panel open: nothing of A's selection shows in B.
    assert.equal(await s.win.locator('.thumb-selected').count(), 0, 'no page of B looks selected');
    // Close the Thumbnails panel, so the toolbar is the only way the Delete is aimed.
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).first().click();
    await s.win.locator('.thumb-list').waitFor({ state: 'detached', timeout: 10000 });
    await s.win.locator('.top-bar').getByRole('button', { name: 'Delete pages', exact: true }).click();
    await waitFor(async () => (await pageCount(s.win)) === 7, { timeoutMs: 20000, label: 'B has 7 pages' });
    await showPanel(s.win, 'Thumbnails');
    await waitForCount(s.win, 7);
    // Only B's current page (the first) is gone: uid 0 was deleted, uids 1-7 stay.
    assert.deepEqual(await uids(s.win), ['1', '2', '3', '4', '5', '6', '7']);
    // A, the other tab, still has all its pages.
    await s.win.getByRole('tab').nth(0).click();
    await waitFor(async () => (await pageCount(s.win)) === 8, { timeoutMs: 20000, label: 'A still has 8 pages' });
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
    // Teardown discards the edit (test-mode quit): nothing is saved.
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The display sizes (rounded) of the pages of a PDF file on disk, read with MuPDF. */
function pageSizesOnDisk(path) {
  const pdf = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  const sizes = [];
  for (let i = 0; i < pdf.countPages(); i++) {
    const page = pdf.loadPage(i);
    const b = page.getBounds();
    sizes.push(`${Math.round(b[2] - b[0])}x${Math.round(b[3] - b[1])}`);
    page.destroy();
  }
  return sizes;
}

/** Clicks the thumbnail of the page at `index` (0-based, list order), scrolling the list until its row is drawn. */
async function clickRow(win, index, modifiers = []) {
  const uid = (await uids(win))[index];
  assert.ok(uid !== undefined, `row ${index} exists`);
  const drawn = await win.evaluate(async (target) => {
    const list = document.querySelector('.thumb-list');
    const step = Math.max(120, list.clientHeight / 2);
    for (let y = 0; y <= list.scrollHeight; y += step) {
      list.scrollTop = y;
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (list.querySelector(`.thumb[data-uid="${target}"]`)) return true;
    }
    return false;
  }, uid);
  assert.ok(drawn, `row ${index} (uid ${uid}) is drawn after scrolling`);
  await win.locator(`.thumb[data-uid="${uid}"]`).click({ modifiers });
}

test('a Delete confirmation left open across Ctrl+S still deletes the pages that were selected (the uids restart at the save)', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    const original = pageSizesOnDisk(copy.path);
    assert.equal(original.length, 8);
    // Duplicate page 1: nine pages, the uids are 0, n1, 1, 2 ... 7 (positions and uids no longer agree).
    await jumpTo(s.win, 0);
    await s.win.keyboard.press('Control+d');
    await waitForCount(s.win, 9);
    // Select pages 5-9 (five of nine: more than half, so the Delete asks in the sheet). The sheet stores their uids.
    await clickRow(s.win, 4);
    await clickRow(s.win, 8, ['Shift']);
    await waitFor(async () => (await s.win.locator('.thumb-selected').count()) === 5, { timeoutMs: 10000, label: 'five pages selected' });
    await s.win.keyboard.press('Delete');
    const confirm = sheet(s.win, 'Delete pages?');
    await confirm.getByText('This removes 5 of 9 pages').waitFor({ timeout: 5000 });
    // Save with the sheet still open: the saved document is new and its uids start again at 0.
    await s.win.keyboard.press('Control+s');
    await waitFor(() => pagesOnDisk(copy.path) === 9, { timeoutMs: 20000, label: 'the 9-page file is saved' });
    await waitFor(async () => (await uids(s.win)).join(',') === '0,1,2,3,4,5,6,7,8', { timeoutMs: 15000, label: 'the uids restarted' });
    // A save keeps the same pages, so the sheet stays open and follows its pages by position.
    await confirm.getByRole('button', { name: 'Delete 5 pages' }).click();
    await waitForCount(s.win, 4);
    // The result as the file on disk holds it: pages 1-4 stay (Letter, Letter (the copy), A4, Letter), pages 5-9 are gone.
    await s.win.keyboard.press('Control+s');
    await waitFor(() => pagesOnDisk(copy.path) === 4, { timeoutMs: 20000, label: 'the 4-page file is saved' });
    assert.deepEqual(pageSizesOnDisk(copy.path), [original[0], original[0], original[1], original[2]]);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await s.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
});
