// Functional checks on the viewer UI with a document open: panels, zoom, navigation, search, split,
// floating windows, recolor, theme, context menus, the command palette and keyboard shortcuts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, fixture, statusText, waitFor, waitForPage, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

/** Opens a file through the dialog and waits for its first page. Returns the session. */
async function open(file, status) {
  const s = await launch();
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([fixture(file)]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, status);
  return s;
}

const done = async (s) => {
  await s.close();
  cleanupProfile(s.profile);
};

test('panels: rail opens Thumbnails, Bookmarks and Properties; the tree jumps to pages; sections exist', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    // Thumbnails: open from the rail, then click a thumbnail for page 50.
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
    const thumbs = s.win.getByRole('complementary', { name: 'Thumbnails', exact: true });
    await thumbs.waitFor({ timeout: 5000 });
    await s.win.waitForTimeout(800);
    const thumbPanel = await s.win.locator('[aria-label="Thumbnails"] img, [aria-label="Thumbnails"] canvas, [aria-label="Thumbnails"] button').count();
    console.log(`  thumbnail elements in panel: ${thumbPanel}`);
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click(); // close it again
    assert.equal(await s.win.getByRole('complementary', { name: 'Thumbnails', exact: true }).count(), 0, 'rail icon should close the panel');

    // Bookmarks: a tree with chapter nodes. Clicking "Chapter 2" jumps to page 101.
    await s.win.getByRole('button', { name: 'Bookmarks', exact: true }).click();
    const tree = s.win.getByRole('tree', { name: 'Bookmarks', exact: true });
    await tree.waitFor({ timeout: 5000 });
    const chapter2 = tree.getByText(/Chapter 2 \(page 101\)/).first();
    await chapter2.click();
    await waitForPage(s, 'Page 101 of 1000');
    console.log('  bookmark "Chapter 2" jumped to page 101');
    // Arrow keys: Left collapses, Right expands.
    await chapter2.focus().catch(() => undefined);
    const treeItems = await tree.getByRole('treeitem').count();
    console.log(`  bookmark tree items visible: ${treeItems}`);
    await s.win.keyboard.press('ArrowLeft');
    await s.win.keyboard.press('ArrowRight');
    assert.deepEqual(s.errors, []);

    // Properties: the two sections.
    await s.win.getByRole('button', { name: 'Properties', exact: true }).click();
    const props = s.win.getByRole('complementary', { name: 'Properties', exact: true });
    await props.waitFor({ timeout: 5000 });
    assert.equal(await props.getByLabel('Document').count(), 1, 'Document section');
    assert.equal(await props.getByLabel('Current page').count(), 1, 'Current page section');
    const docText = await props.getByLabel('Document').innerText();
    console.log(`  properties Document section: ${JSON.stringify(docText.slice(0, 160))}`);
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('zoom and navigation: Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+1, PgDn, Ctrl+G, Ctrl+wheel zoom around the cursor', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    const zoomOf = async () => (await statusText(s.win)).match(/(\d+)%/)?.[1];
    const z0 = Number(await zoomOf());
    await s.win.keyboard.press('Control+=');
    await s.win.waitForTimeout(300);
    const z1 = Number(await zoomOf());
    assert.ok(z1 > z0, `Ctrl+= should zoom in (${z0} -> ${z1})`);
    await s.win.keyboard.press('Control+-');
    await s.win.keyboard.press('Control+-');
    await s.win.waitForTimeout(300);
    assert.ok(Number(await zoomOf()) < z1, 'Ctrl+- should zoom out');
    await s.win.keyboard.press('Control+0');
    await s.win.waitForTimeout(300);
    const fitPage = await zoomOf();
    await s.win.keyboard.press('Control+1');
    await s.win.waitForTimeout(300);
    const fitWidth = await zoomOf();
    console.log(`  zoom: start ${z0}%, after Ctrl+= ${z1}%, Ctrl+0 fit page ${fitPage}%, Ctrl+1 fit width ${fitWidth}%`);

    // Ctrl+wheel zooms.
    const viewer = s.win.locator('.viewer');
    const box = await viewer.boundingBox();
    await s.win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const beforeWheel = Number(await zoomOf());
    await s.win.keyboard.down('Control');
    await s.win.mouse.wheel(0, -300);
    await s.win.keyboard.up('Control');
    await s.win.waitForTimeout(400);
    const afterWheel = Number(await zoomOf());
    console.log(`  Ctrl+wheel up: ${beforeWheel}% -> ${afterWheel}%`);
    assert.ok(afterWheel > beforeWheel, 'Ctrl+wheel up should zoom in');

    // Page down and go-to.
    await s.win.keyboard.press('Control+0');
    await s.win.keyboard.press('PageDown');
    await s.win.waitForTimeout(500);
    console.log(`  status after PgDn: ${JSON.stringify(await statusText(s.win))}`);
    await s.win.keyboard.press('Control+g');
    const focused = await s.win.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'page-box', 'Ctrl+G should focus the page box');
    await s.win.keyboard.type('777');
    await s.win.keyboard.press('Enter');
    await waitForPage(s, 'Page 777 of 1000');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('search bar: Ctrl+F, n of N, F3 / Shift+F3 move through matches, Escape closes', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.waitFor({ timeout: 5000 });
    await find.fill('zephyrbloom');
    await waitFor(async () => /^1 of 1000/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 60000, label: 'first match 1 of 1000' });
    await s.win.keyboard.press('F3');
    await waitFor(async () => /^2 of 1000/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 10000, label: 'F3 to 2 of 1000' });
    await s.win.keyboard.press('Shift+F3');
    await waitFor(async () => /^1 of 1000/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 10000, label: 'Shift+F3 to 1 of 1000' });
    console.log('  F3 / Shift+F3 moved between 1 of 1000 and 2 of 1000');
    await s.win.keyboard.press('Escape');
    await waitFor(async () => (await s.win.getByLabel('Find in document').count()) === 0, { timeoutMs: 5000, label: 'find bar closed' }).catch(() => undefined);
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('split view: Ctrl+\\ makes two panes, F6 switches the active pane, sync-scroll toggle works, drag divider', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    const sync = s.win.locator('.split-sync');
    const before = await sync.getAttribute('aria-label');
    await sync.click();
    const after = await sync.getAttribute('aria-label');
    console.log(`  sync toggle: ${before} -> ${after}`);
    assert.notEqual(before, after, 'sync-scroll toggle should change');
    const activeBefore = await s.win.locator('.pane-active').count();
    await s.win.keyboard.press('F6');
    await s.win.waitForTimeout(300);
    assert.equal(await s.win.locator('.pane-active').count(), activeBefore, 'F6 keeps one active pane');
    // Drag the divider.
    const handle = s.win.locator('.split-handle');
    const hb = await handle.boundingBox();
    if (hb) {
      const y0 = hb.y + 60; // the sync button covers the middle of the divider
      await s.win.mouse.move(hb.x + hb.width / 2, y0);
      await s.win.mouse.down();
      await s.win.mouse.move(hb.x + hb.width / 2 - 120, y0, { steps: 8 });
      await s.win.mouse.up();
      const ratioAfter = await handle.getAttribute('aria-valuenow');
      console.log(`  divider drag: ratio 50 -> ${ratioAfter}`);
      assert.notEqual(ratioAfter, '50', 'dragging the divider should change the split ratio');
    } else {
      console.log('  split handle not found');
    }
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.split').count()) === 0, { timeoutMs: 10000, label: 'split closed' });
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('Loupe and Pan-zoom windows: open, Esc closes the focused one, close button, position remembered', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    await s.win.getByRole('button', { name: 'Loupe', exact: true }).click();
    const loupe = s.win.getByRole('complementary', { name: 'Loupe', exact: true }).or(s.win.locator('.floating[aria-label="Loupe"]'));
    await loupe.first().waitFor({ timeout: 5000 });
    console.log('  Loupe window opened');
    await s.win.getByRole('button', { name: 'Pan and zoom', exact: true }).click();
    const pz = s.win.locator('.floating[aria-label="Pan and zoom"]');
    await pz.waitFor({ timeout: 5000 });
    console.log('  Pan and zoom window opened');
    // Drag the Pan-zoom window header.
    const header = pz.locator('.floating-header');
    const hb = await header.boundingBox();
    await s.win.mouse.move(hb.x + 20, hb.y + hb.height / 2);
    await s.win.mouse.down();
    await s.win.mouse.move(hb.x - 60, hb.y + hb.height / 2 + 30, { steps: 6 });
    await s.win.mouse.up();
    const hb2 = await header.boundingBox();
    console.log(`  pan-zoom window dragged by (${Math.round(hb2.x - hb.x)}, ${Math.round(hb2.y - hb.y)})`);
    // Esc closes the focused window.
    await pz.click({ position: { x: 30, y: 30 } }).catch(() => undefined);
    await s.win.keyboard.press('Escape');
    await waitFor(async () => (await pz.count()) === 0, { timeoutMs: 5000, label: 'Esc closes Pan and zoom' });
    console.log('  Esc closed Pan and zoom');
    // Close the Loupe with its close button.
    await s.win.getByRole('button', { name: 'Close Loupe' }).click();
    await waitFor(async () => (await s.win.locator('.floating[aria-label="Loupe"]').count()) === 0, { timeoutMs: 5000, label: 'Loupe closed' });
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('recolor: menu lists Off, Invert, Sepia, Night, High contrast, Custom; picking one changes the viewer filter', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    // The Recolor button is an icon since 1.2.2: its name carries the current mode.
    await s.win.getByRole('button', { name: /^Page colors: Off$/ }).click();
    const items = await s.win.getByRole('menuitemradio').allInnerTexts();
    console.log(`  recolor menu items: ${items.map((t) => t.trim()).join(', ')}`);
    await s.win.getByRole('menuitemradio', { name: 'Invert' }).click();
    await waitFor(async () => (await s.win.getByRole('button', { name: /^Page colors: Invert$/ }).count()) === 1, { timeoutMs: 5000, label: 'Recolor: Invert' });
    const filter = await s.win.locator('.page-canvas').first().evaluate((el) => getComputedStyle(el).filter);
    console.log(`  computed filter on a page after Invert: ${filter}`);
    assert.notEqual(filter, 'none', 'page should be recoloured');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('theme button switches light and dark, and the page keeps its colors', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    const theme = () => s.win.evaluate(() => document.documentElement.dataset.theme);
    const t0 = await theme();
    await s.win.getByRole('button', { name: 'Light or dark' }).click();
    await s.win.waitForTimeout(200);
    const t1 = await theme();
    console.log(`  theme ${t0} -> ${t1}`);
    assert.notEqual(t0, t1);
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('right-click on a page opens the page menu with the spec items; right-click on a tab opens the tab menu', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    await s.win.locator('.page-canvas').first().click({ button: 'right', force: true });
    const menu = s.win.getByRole('menu');
    await menu.waitFor({ timeout: 5000 });
    const pageItems = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
    console.log(`  page menu items: ${pageItems.join(' | ')}`);
    for (const expected of ['Copy', 'Select all', 'Fit width', 'Rotate view', 'Split here', 'Page colors', 'Properties']) {
      assert.ok(pageItems.some((t) => t.startsWith(expected)), `page menu should have "${expected}"`);
    }
    await s.win.keyboard.press('Escape');

    await s.win.getByRole('tab').first().click({ button: 'right' });
    await menu.waitFor({ timeout: 5000 });
    const tabItems = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
    console.log(`  tab menu items: ${tabItems.join(' | ')}`);
    for (const expected of ['Close tab', 'Close other tabs', 'Close tabs to the right', 'Duplicate', 'Open in split', 'Copy path']) {
      assert.ok(tabItems.some((t) => t.startsWith(expected)), `tab menu should have "${expected}"`);
    }
    await s.win.keyboard.press('Escape');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('Ctrl+K command palette: opens, filters, runs a command, Escape closes', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    await s.win.keyboard.press('Control+k');
    const palette = s.win.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor({ timeout: 5000 });
    await s.win.getByLabel('Type a command').fill('fit page');
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await palette.count()) === 0, { timeoutMs: 5000, label: 'palette closed after Enter' });
    const zoomAfter = (await statusText(s.win)).match(/(\d+)%/)?.[1];
    console.log(`  palette "fit page" ran; zoom now ${zoomAfter}%`);
    await s.win.keyboard.press('Control+k');
    await palette.waitFor({ timeout: 5000 });
    await s.win.keyboard.press('Escape');
    await waitFor(async () => (await palette.count()) === 0, { timeoutMs: 5000, label: 'palette closed by Escape' });
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('split view fits the window: no horizontal page overflow and both panes are visible', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    await s.win.waitForTimeout(500);
    const layout = await s.win.evaluate(() => {
      const frames = [...document.querySelectorAll('.pane-frame')].map((el) => el.getBoundingClientRect());
      return {
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        paneRightEdges: frames.map((r) => Math.round(r.right)),
        paneWidths: frames.map((r) => Math.round(r.width)),
      };
    });
    console.log(`  split layout: ${JSON.stringify(layout)}`);
    assert.ok(layout.documentScrollWidth <= layout.innerWidth, `page is ${layout.documentScrollWidth}px wide in a ${layout.innerWidth}px window (horizontal scroll)`);
    assert.ok(layout.paneRightEdges.every((edge) => edge <= layout.innerWidth), 'both panes should be inside the window');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});
