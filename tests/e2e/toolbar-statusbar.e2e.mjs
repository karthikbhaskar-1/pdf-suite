// Ticket 1.2.2, toolbar and status bar polish: the icon-only toolbar with tooltips, View > Toolbar > Show Labels (and that it
// is remembered after a restart), the "…" overflow menu at three window widths, the zoom controls and the page box in the
// status bar, and keyboard use of all of it. The last group checks the small items of the 1.2.1 sign-off that touch the
// menus and the title: Close All, "Open…", lined and grid insert wording, and the middle-truncated window title.
// Every test ends with its document saved, discarded or closed by the test-mode quit, and removes its profile and copies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, closeAll, copyOf, removeCopy, waitFor, statusText, fixture, cleanupProfile, newProfileDir, palette, assertNoErrors, delay, placeWindow } from './matrix-lib.mjs';

after(closeAll);

const MIXED = 'mixed-sizes-rotated.pdf'; // 8 pages
const MARGINS = 'margins-white.pdf'; // 2 pages

// ------------------------------------------------------------------------------------------------ helpers

/** Opens a file with Ctrl+O and the stubbed dialog, and waits for its first page and the status bar. */
async function openFile(s, path, pages) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  await waitFor(async () => (await statusText(s.win)).startsWith(`Page 1 of ${pages}`), { timeoutMs: 30000, label: `Page 1 of ${pages}` });
  await s.win.locator('.page-canvas').first().waitFor({ timeout: 30000 });
}

/** Sets the window width (the test window may be made narrower than the app's usual minimum) and waits for the layout to settle. */
async function setWidth(s, width) {
  await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(300, 400));
  await placeWindow(s, { width, height: 800 });
  await waitFor(async () => (await s.win.evaluate(() => innerWidth)) === width, { timeoutMs: 10000, label: `window width ${width}` });
  await settled(s);
}

/** Waits until the toolbar and the status bar show the same thing on two looks 250 ms apart (a resize is applied in a frame). */
async function settled(s) {
  let last = '';
  await waitFor(
    async () => {
      const now = JSON.stringify(await barState(s));
      const same = now === last;
      last = now;
      await delay(250);
      return same;
    },
    { timeoutMs: 10000, label: 'layout settled' },
  );
}

/** What the toolbar shows now: the collapsed items, whether the "…" button shows, whether the bar overflows its box, labels. */
async function barState(s) {
  return s.win.evaluate(() => {
    const bar = document.querySelector('.top-bar');
    if (!bar) throw new Error(`no top bar in the page; body starts: ${document.body.innerHTML.slice(0, 300)}`);
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

/** The zoom shown in the status bar, as a number (100 for "100%"). */
async function zoomPercent(s) {
  return Number.parseFloat(await s.win.getByLabel('Zoom level').inputValue());
}

/** The width in CSS px of the page on screen, to compare how the zoom really changed what is drawn. */
async function pageWidthPx(s) {
  return s.win.evaluate(() => document.querySelector('.page')?.getBoundingClientRect().width ?? 0);
}

/** Hovers an element and reports how long the tooltip took to appear, and its text. Null when none appeared within 3 s. */
async function tooltipAfterHover(s, locator) {
  await s.win.mouse.move(2, 2);
  await delay(150);
  await locator.hover();
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const text = await s.win.locator('[role="tooltip"]').first().textContent({ timeout: 100 }).catch(() => null);
    if (text !== null) return { ms: Date.now() - started, text: text.trim() };
    await delay(25);
  }
  return null;
}

/** The menu bar's View menu, down to Toolbar, with the item named. Opens it; the caller clicks the item. */
async function openToolbarMenu(s) {
  await s.win.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await s.win.locator('.menu-dropdown').first().getByRole('menuitem', { name: 'Toolbar' }).click();
}

async function setShowLabels(s, on) {
  await openToolbarMenu(s);
  const item = s.win.getByRole('menuitemcheckbox', { name: 'Show Labels' });
  const now = (await item.getAttribute('aria-checked')) === 'true';
  if (now === on) await s.win.keyboard.press('Escape');
  else await item.click();
  await s.win.keyboard.press('Escape').catch(() => undefined);
  await waitFor(async () => (await s.win.locator('.menu-dropdown').count()) === 0, { timeoutMs: 5000, label: 'menu closed' });
}

async function labelsChecked(s) {
  await openToolbarMenu(s);
  const checked = (await s.win.getByRole('menuitemcheckbox', { name: 'Show Labels' }).getAttribute('aria-checked')) === 'true';
  for (let i = 0; i < 3 && (await s.win.locator('.menu-dropdown').count()) > 0; i++) await s.win.keyboard.press('Escape');
  return checked;
}

const CRITICAL_NAMES = ['Open', 'Save', 'Undo', 'Redo', 'Find', 'Page number', 'Light or dark'];

// ------------------------------------------------------------------------------------------------ icons, tooltips, labels

test('the toolbar is icon-only: 18 px icons in 32 px buttons, named, with shortcuts, and tooltips after 500 ms', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);

    const bar = await barState(s);
    assert.equal(bar.height, 40, 'the top bar is 40 px tall');
    assert.deepEqual(bar.hidden, [], 'nothing collapsed at 1500 px');
    assert.equal(bar.overflowVisible, false, 'no "…" button when everything fits');
    assert.equal(bar.labelsShown, false, 'icon-only by default');
    assert.equal(await s.win.getByRole('toolbar', { name: 'Toolbar' }).count(), 1);

    // 18 px icons in 32 x 32 buttons, with a 2 px gap.
    for (const name of ['Open', 'Save', 'Find']) {
      const button = s.win.getByRole('toolbar').getByRole('button', { name, exact: true });
      const box = await button.boundingBox();
      assert.deepEqual([Math.round(box.width), Math.round(box.height)], [32, 32], `${name} is 32 x 32`);
      const icon = await button.locator('svg').boundingBox();
      assert.deepEqual([Math.round(icon.width), Math.round(icon.height)], [18, 18], `${name} has an 18 px icon`);
      assert.equal((await button.innerText()).trim(), '', `${name} shows no text`);
    }
    const open = await s.win.getByRole('toolbar').getByRole('button', { name: 'Open', exact: true }).boundingBox();
    const save = await s.win.getByRole('toolbar').getByRole('button', { name: 'Save', exact: true }).boundingBox();
    assert.equal(Math.round(save.x - (open.x + open.width)), 2, 'a 2 px gap between buttons');
    // Dividers are 1 px with 6 px margins.
    const divider = await s.win.locator('.top-bar .tb-divider').first().evaluate((el) => {
      const style = getComputedStyle(el);
      return { width: el.getBoundingClientRect().width, left: style.marginLeft, right: style.marginRight };
    });
    assert.deepEqual(divider, { width: 1, left: '6px', right: '6px' });

    // Every button has a name; the ones with a shortcut say so.
    const keys = await s.win.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll('.top-bar button')].map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-keyshortcuts')])),
    );
    const unnamed = await s.win.evaluate(() => [...document.querySelectorAll('.top-bar button')].filter((b) => !b.getAttribute('aria-label')).length);
    assert.equal(unnamed, 0, 'every toolbar button has an aria-label');
    assert.equal(keys.Open, 'Control+O');
    assert.equal(keys.Save, 'Control+S');
    assert.equal(keys.Undo, 'Control+Z');
    assert.equal(keys.Redo, 'Control+Y');
    assert.equal(keys.Find, 'Control+F');
    assert.equal(keys['Delete pages'], 'Delete');
    assert.equal(keys['Rotate right 90°'], 'Control+Shift+R');

    // The tooltip appears after 500 ms and reads "Label (Shortcut)".
    const saveTip = await tooltipAfterHover(s, s.win.getByRole('toolbar').getByRole('button', { name: 'Save', exact: true }));
    assert.ok(saveTip, 'a tooltip appears');
    assert.equal(saveTip.text, 'Save (Ctrl+S)');
    assert.ok(saveTip.ms >= 450 && saveTip.ms < 1500, `the tooltip waited about 500 ms, not ${saveTip.ms} ms`);
    const searchTip = await tooltipAfterHover(s, s.win.getByRole('toolbar').getByRole('button', { name: 'Find', exact: true }));
    assert.equal(searchTip?.text, 'Find (Ctrl+F)');
    // No tooltip is up after the pointer leaves.
    await s.win.mouse.move(600, 500);
    await waitFor(async () => (await s.win.locator('[role="tooltip"]').count()) === 0, { timeoutMs: 3000, label: 'tooltip gone' });

    // Undo and Redo tooltips name the action.
    const undo = s.win.getByRole('toolbar').getByRole('button', { name: /^Undo/ });
    assert.equal(await undo.isDisabled(), true, 'nothing to undo yet');
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await undo.getAttribute('aria-label')) === 'Undo Rotate 1 page', { timeoutMs: 10000, label: 'Undo names the step' });
    const undoTip = await tooltipAfterHover(s, undo);
    assert.equal(undoTip?.text, 'Undo Rotate 1 page (Ctrl+Z)');
    await s.win.keyboard.press('Control+z');
    const redo = s.win.getByRole('toolbar').getByRole('button', { name: /^Redo/ });
    await waitFor(async () => (await redo.getAttribute('aria-label')) === 'Redo Rotate 1 page', { timeoutMs: 10000, label: 'Redo names the step' });
    assert.equal((await tooltipAfterHover(s, redo))?.text, 'Redo Rotate 1 page (Ctrl+Y)');

    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('Show Labels puts labels beside the critical and high icons, goes before anything collapses, and is remembered after a restart', async () => {
  const profile = newProfileDir();
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1800);
    assert.equal(await labelsChecked(s), false, 'Show Labels is off by default');

    await setShowLabels(s, true);
    await waitFor(async () => (await barState(s)).labelsShown, { timeoutMs: 5000, label: 'labels shown' });
    let bar = await barState(s);
    assert.equal(bar.height, 40, 'the bar keeps its height with labels');
    assert.deepEqual(bar.hidden, [], 'nothing collapsed at 1800 px with labels');
    for (const [id, label] of [['file.open', 'Open'], ['file.save', 'Save'], ['file.recent', 'Recent'], ['view.split', 'Split'], ['pages.insert', 'Insert'], ['pages.delete', 'Delete'], ['pages.rotate', 'Rotate']]) {
      const text = await s.win.locator(`[data-slot="${id}"] .tb-label`).first().innerText();
      assert.equal(text, label, `${id} shows its label`);
      assert.equal(await s.win.locator(`[data-slot="${id}"] .tb-label`).first().isVisible(), true, `${id}'s label is visible`);
    }
    // Normal items stay icon-only.
    for (const id of ['view.loupe', 'view.panZoom', 'view.recolor', 'pages.crop', 'pages.size', 'pages.more']) {
      assert.equal(await s.win.locator(`[data-slot="${id}"] .tb-label`).count(), 0, `${id} has no label`);
    }
    // A labeled button is the 32 px icon plus its label: wider than 32 px, still 32 px tall.
    const openBox = await s.win.getByRole('toolbar').getByRole('button', { name: 'Open', exact: true }).boundingBox();
    assert.ok(openBox.width > 50 && Math.round(openBox.height) === 32, `Open with its label is ${openBox.width} x ${openBox.height}`);
    // The label is 12 px.
    assert.equal(await s.win.locator('[data-slot="file.open"] .tb-label').evaluate((el) => getComputedStyle(el).fontSize), '12px');

    // Narrowing the window: the labels go first, with nothing collapsed; only then do items collapse.
    let labelsGoneAt = null;
    let firstCollapseAt = null;
    for (let w = 1800; w >= 600 && firstCollapseAt === null; w -= 40) {
      await setWidth(s, w);
      bar = await barState(s);
      assert.ok(bar.scrollWidth <= bar.clientWidth, `no horizontal overflow at ${w} px (${bar.scrollWidth} > ${bar.clientWidth})`);
      if (!bar.labelsShown && labelsGoneAt === null) labelsGoneAt = w;
      if (bar.hidden.length > 0) firstCollapseAt = w;
      if (labelsGoneAt === null) assert.deepEqual(bar.hidden, [], `labels still show at ${w} px, so nothing is collapsed`);
    }
    assert.ok(labelsGoneAt !== null, 'the labels went as the window narrowed');
    assert.ok(firstCollapseAt !== null && firstCollapseAt <= labelsGoneAt, `labels went at ${labelsGoneAt} px, the first item collapsed at ${firstCollapseAt} px`);
    assert.equal((await barState(s)).labelsShown, false, 'labels stay off while items are collapsed');

    // Restart with the same profile: still on.
    await s.close();
    s = await launch({ profile });
    await s.win.waitForSelector('.menu-row'); // the session is restored, so the empty state may not show
    assert.equal(await labelsChecked(s), true, 'Show Labels is still on after a restart');
    await setWidth(s, 1800);
    assert.equal((await barState(s)).labelsShown, true, 'the labels show again after the restart');

    // Turn it off, restart: off.
    await setShowLabels(s, false);
    await waitFor(async () => !(await barState(s)).labelsShown, { timeoutMs: 5000, label: 'labels hidden' });
    await s.close();
    s = await launch({ profile });
    await s.win.waitForSelector('.menu-row');
    assert.equal(await labelsChecked(s), false, 'Show Labels stays off after a restart');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
  }
});

// ------------------------------------------------------------------------------------------------ overflow

test('the "…" menu at three window widths: critical buttons stay, items collapse by priority, and a collapsed command still runs from the menu and from its shortcut', async () => {
  const copy = copyOf(MARGINS);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, copy.path, 2);

    const states = {};
    for (const width of [1500, 800, 520]) {
      await setWidth(s, width);
      const bar = await barState(s);
      states[width] = bar;
      assert.equal(bar.height, 40, `the bar keeps its height at ${width} px`);
      assert.ok(bar.scrollWidth <= bar.clientWidth, `the bar does not overflow its box at ${width} px (${bar.scrollWidth} > ${bar.clientWidth})`);
      assert.equal(bar.overflowVisible, bar.hidden.length > 0, `the "…" button shows exactly when something is collapsed (${width} px)`);
      // Critical buttons are always visible and reachable.
      for (const name of CRITICAL_NAMES) {
        const target = name === 'Page number' ? s.win.getByLabel('Page number') : s.win.getByRole('toolbar').getByRole('button', { name, exact: true });
        assert.equal(await target.isVisible(), true, `${name} is visible at ${width} px`);
      }
      // Priority order: a high item collapses only when every normal item already has.
      const hiddenHigh = bar.hidden.filter((id) => bar.priorities[id] === 'high');
      const shownNormal = bar.shown.filter((id) => bar.priorities[id] === 'normal');
      if (hiddenHigh.length > 0) assert.deepEqual(shownNormal, [], `at ${width} px a high item is collapsed, so every normal item is too`);
      assert.deepEqual(bar.hidden.filter((id) => bar.priorities[id] === 'critical'), [], 'no critical item is ever collapsed');
    }
    assert.deepEqual(states[1500].hidden, [], 'wide: nothing collapsed');
    assert.ok(states[800].hidden.length > 0 && states[800].hidden.every((id) => states[800].priorities[id] === 'normal'), `middle: only normal items collapse (${states[800].hidden})`);
    assert.ok(states[520].hidden.some((id) => states[520].priorities[id] === 'high'), `narrow: high items collapse too (${states[520].hidden})`);
    // Whole groups together: the normal items of the Pages group collapse as one.
    for (const width of [800, 520]) {
      const pagesNormal = ['pages.crop', 'pages.size', 'pages.more'].map((id) => states[width].hidden.includes(id));
      assert.ok(pagesNormal.every(Boolean) || pagesNormal.every((x) => !x), `the Pages normal items collapse together at ${width} px`);
    }

    // At the narrowest width, Rotate is collapsed. Its shortcut still works.
    assert.ok(states[520].hidden.includes('pages.rotate'), 'Rotate is collapsed at 520 px');
    assert.equal(await s.win.getByRole('toolbar').getByRole('button', { name: 'Rotate right 90°' }).isVisible(), false, 'Rotate is not in the bar');
    await s.win.keyboard.press('Control+Shift+r');
    const undo = s.win.getByRole('toolbar').getByRole('button', { name: /^Undo/ });
    await waitFor(async () => (await undo.getAttribute('aria-label')) === 'Undo Rotate 1 page', { timeoutMs: 10000, label: 'rotated from its shortcut' });

    // And it runs from the "…" menu: the menu has group headings, the item's own entries, and its shortcut.
    await s.win.getByRole('toolbar').getByRole('button', { name: 'More commands' }).click();
    const menu = s.win.getByRole('menu', { name: 'More commands' });
    await menu.waitFor();
    const rows = await menu.evaluate((el) => [...el.children].map((c) => (c.classList.contains('menu-sep') ? '|' : (c.querySelector('.menu-label')?.textContent ?? c.textContent).trim())));
    assert.ok(rows.includes('Pages') && rows.includes('Rotate') && rows.includes('Right 90°'), `the menu lists the Pages group and the Rotate entries: ${rows}`);
    assert.ok(rows.includes('|'), 'groups are separated');
    const rotateRight = menu.getByRole('menuitem', { name: /Right 90°/ });
    assert.equal(await rotateRight.locator('.menu-accel').innerText(), 'Ctrl+Shift+R', 'the menu row keeps its shortcut');
    await rotateRight.click();
    await waitFor(async () => (await s.win.locator('.toast', { hasText: 'Rotated 1 page' }).count()) >= 1, { timeoutMs: 10000, label: 'rotated from the menu' });
    assert.equal(await s.win.getByRole('menu', { name: 'More commands' }).count(), 0, 'the menu closes after a command');

    // A collapsed command that opens a sheet: Page size.
    await s.win.getByRole('toolbar').getByRole('button', { name: 'More commands' }).click();
    await s.win.getByRole('menu', { name: 'More commands' }).getByRole('menuitem', { name: /Page Size/ }).click();
    const dialog = s.win.getByRole('dialog', { name: 'Page size' });
    await dialog.waitFor({ timeout: 10000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await s.win.getByRole('dialog', { name: 'Page size' }).count()) === 0, { timeoutMs: 5000, label: 'sheet closed' });

    // A collapsed toggle keeps its check state in the menu.
    await s.win.getByRole('toolbar').getByRole('button', { name: 'More commands' }).click();
    const loupe = s.win.getByRole('menu', { name: 'More commands' }).getByRole('menuitemcheckbox', { name: /Loupe/ });
    assert.equal(await loupe.getAttribute('aria-checked'), 'false');
    await loupe.click();
    await s.win.getByRole('toolbar').getByRole('button', { name: 'More commands' }).click();
    assert.equal(await s.win.getByRole('menu', { name: 'More commands' }).getByRole('menuitemcheckbox', { name: /Loupe/ }).getAttribute('aria-checked'), 'true', 'the toggle shows it is on');
    assert.equal(await s.win.locator('section.floating').count(), 1, 'the Loupe window opened');
    // Turn it off again from the menu.
    await s.win.getByRole('menu', { name: 'More commands' }).getByRole('menuitemcheckbox', { name: /Loupe/ }).click();
    await waitFor(async () => (await s.win.locator('section.floating').count()) === 0, { timeoutMs: 5000, label: 'the Loupe closed' });

    // The menu keeps a disabled row's state and reason: a one-page document cannot delete its last page.
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => /of 1\b/.test(await statusText(s.win)), { timeoutMs: 15000, label: 'one page left' });
    await s.win.getByRole('toolbar').getByRole('button', { name: 'More commands' }).click();
    const del = s.win.getByRole('menu', { name: 'More commands' }).getByRole('menuitem', { name: /Delete Pages/ });
    assert.equal(await del.isDisabled(), true, 'Delete is disabled in the menu');
    assert.equal(await del.getAttribute('title'), 'A PDF needs at least one page.', 'with the reason');
    assert.equal(await del.locator('.menu-accel').innerText(), 'Delete', 'and its shortcut');
    await s.win.keyboard.press('Escape');

    // Widening the window brings the items back.
    await setWidth(s, 1500);
    const wide = await barState(s);
    assert.deepEqual(wide.hidden, []);
    assert.equal(wide.overflowVisible, false);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeCopy(copy);
  }
});

// ------------------------------------------------------------------------------------------------ status bar

test('status bar: Page [n] of Y, the page number box, and the zoom controls (fit, step, typed %, presets, slider)', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);

    // The Zoom group is gone from the top bar; the controls are in the status bar.
    assert.equal(await s.win.locator('.top-bar').getByLabel('Zoom level').count(), 0, 'no zoom box in the top bar');
    assert.equal(await s.win.getByRole('toolbar').getByRole('group', { name: 'Zoom' }).count(), 0, 'no Zoom group in the top bar');
    const status = s.win.locator('footer.status-bar');
    assert.equal(Math.round((await status.boundingBox()).height), 24, 'the status bar is 24 px tall');
    for (const name of ['Fit page', 'Fit width', 'Zoom out', 'Zoom in', 'Zoom presets']) {
      assert.equal(await status.getByRole('button', { name, exact: true }).isVisible(), true, `${name} is in the status bar`);
    }
    assert.equal(await status.getByLabel('Zoom slider').isVisible(), true, 'the slider is there at 1500 px');
    const sliderBox = await status.getByLabel('Zoom slider').boundingBox();
    assert.ok(Math.abs(sliderBox.width - 80) <= 2, `the slider is 80 px wide (${sliderBox.width})`);
    // Left: "Page [n] of Y", then the document info.
    assert.equal(await status.getByLabel('Go to page').inputValue(), '1');
    assert.equal((await status.locator('.status-of').innerText()).trim(), 'of 8');
    assert.match(await status.locator('.status-info').innerText(), /8\.5 × 11 in|215\.9 × 279\.4 mm/, 'the page size is the document info');
    const left = await status.locator('.status-left').boundingBox();
    const right = await status.locator('.status-zoom').boundingBox();
    assert.ok(left.x < right.x, 'the page is on the left and the zoom controls on the right');

    // Fit width and Fit page.
    await status.getByRole('button', { name: 'Fit width', exact: true }).click();
    await waitFor(async () => (await status.getByRole('button', { name: 'Fit width', exact: true }).getAttribute('aria-pressed')) === 'true', { timeoutMs: 5000, label: 'fit width on' });
    const fitWidth = await zoomPercent(s);
    await status.getByRole('button', { name: 'Fit page', exact: true }).click();
    await waitFor(async () => (await status.getByRole('button', { name: 'Fit page', exact: true }).getAttribute('aria-pressed')) === 'true', { timeoutMs: 5000, label: 'fit page on' });
    const fitPage = await zoomPercent(s);
    assert.ok(fitPage <= fitWidth, `fit page (${fitPage}%) is no larger than fit width (${fitWidth}%) on this window`);
    // Fit width fits the widest page of the document to the viewer: there is no horizontal scroll bar.
    await status.getByRole('button', { name: 'Fit width', exact: true }).click();
    await waitFor(async () => (await zoomPercent(s)) === fitWidth, { timeoutMs: 5000, label: 'fit width again' });
    await delay(400);
    const scroll = await s.win.evaluate(() => {
      let scroller = document.querySelector('.page').parentElement;
      while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      return { content: scroller.scrollWidth, room: scroller.clientWidth };
    });
    assert.ok(scroll.content <= scroll.room + 1, `fit width leaves no horizontal scroll: ${scroll.content}px of content in ${scroll.room}px`);

    // Zoom in and Zoom out step, and the shortcuts are unchanged.
    await status.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await waitFor(async () => (await zoomPercent(s)) > fitWidth, { timeoutMs: 5000, label: 'zoomed in' });
    const stepped = await zoomPercent(s);
    await status.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await waitFor(async () => (await zoomPercent(s)) < stepped, { timeoutMs: 5000, label: 'zoomed out' });
    await s.win.keyboard.press('Control+=');
    await waitFor(async () => (await zoomPercent(s)) > fitWidth - 1, { timeoutMs: 5000, label: 'Ctrl+= still zooms in' });
    await s.win.keyboard.press('Control+0');
    await waitFor(async () => (await status.getByRole('button', { name: 'Fit page', exact: true }).getAttribute('aria-pressed')) === 'true', { timeoutMs: 5000, label: 'Ctrl+0 is still fit page' });

    // A typed percentage: 100, then 200. The page on screen is twice as wide.
    const box = status.getByLabel('Zoom level');
    await box.fill('100');
    await box.press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 100, { timeoutMs: 5000, label: '100%' });
    await delay(400);
    const at100 = await pageWidthPx(s);
    await box.fill('200%');
    await box.press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 200, { timeoutMs: 5000, label: '200%' });
    await delay(400);
    const at200 = await pageWidthPx(s);
    assert.ok(Math.abs(at200 / at100 - 2) < 0.03, `200% draws the page twice as wide as 100% (${at100} to ${at200})`);
    // Text that is not a number changes nothing; a value out of range is brought in; Escape leaves the box as it was.
    await box.fill('big');
    await box.press('Enter');
    assert.equal(await zoomPercent(s), 200, 'text that is not a number is ignored');
    await box.fill('9000');
    await box.press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 800, { timeoutMs: 5000, label: 'clamped to 800%' });
    await box.fill('1');
    await box.press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 10, { timeoutMs: 5000, label: 'clamped to 10%' });
    await box.focus();
    await box.fill('300');
    await box.press('Escape');
    assert.equal(await zoomPercent(s), 10, 'Escape leaves the zoom as it was');

    // Presets: 50, 75, 100, 125, 150, 200, 400.
    await status.getByRole('button', { name: 'Zoom presets' }).click();
    const presets = s.win.getByRole('menu', { name: 'Zoom presets' });
    const labels = await presets.getByRole('menuitemradio').allInnerTexts();
    assert.deepEqual(labels.map((l) => l.replace('●', '').trim()), ['50%', '75%', '100%', '125%', '150%', '200%', '400%']);
    assert.equal(await presets.getByRole('menuitem', { name: /Fit/ }).count(), 0, 'Fit page and Fit width are not in the menu while they have buttons');
    await presets.getByRole('menuitemradio', { name: '150%' }).click();
    await waitFor(async () => (await zoomPercent(s)) === 150, { timeoutMs: 5000, label: '150% from the presets' });
    await status.getByRole('button', { name: 'Zoom presets' }).click();
    assert.equal(await s.win.getByRole('menu', { name: 'Zoom presets' }).getByRole('menuitemradio', { name: '150%' }).getAttribute('aria-checked'), 'true', 'the current preset is marked');
    await s.win.keyboard.press('Escape');

    // The slider: Home is the smallest zoom, End the largest, arrows move it.
    const slider = status.getByLabel('Zoom slider');
    await slider.focus();
    await slider.press('Home');
    await waitFor(async () => (await zoomPercent(s)) === 10, { timeoutMs: 5000, label: 'slider at the start' });
    await slider.press('End');
    await waitFor(async () => (await zoomPercent(s)) === 800, { timeoutMs: 5000, label: 'slider at the end' });
    await slider.press('ArrowLeft');
    await waitFor(async () => (await zoomPercent(s)) < 800, { timeoutMs: 5000, label: 'slider moves down' });

    // Tooltips of the status bar buttons.
    assert.equal((await tooltipAfterHover(s, status.getByRole('button', { name: 'Zoom in', exact: true })))?.text, 'Zoom in (Ctrl+=)');
    assert.equal((await tooltipAfterHover(s, status.getByRole('button', { name: 'Fit page', exact: true })))?.text, 'Fit page (Ctrl+0)');

    // The page number box: Enter goes to the page; text that is not a number, and Escape, change nothing; too big goes to the last page.
    await status.getByRole('button', { name: 'Fit page', exact: true }).click();
    const pageBox = status.getByLabel('Go to page');
    await pageBox.fill('5');
    await pageBox.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 5 of 8'), { timeoutMs: 10000, label: 'page 5' });
    await pageBox.fill('x');
    await pageBox.press('Enter');
    await delay(300);
    assert.ok((await statusText(s.win)).startsWith('Page 5 of 8'), 'text that is not a number does not move');
    await pageBox.focus();
    await pageBox.fill('2');
    await pageBox.press('Escape');
    await delay(300);
    assert.ok((await statusText(s.win)).startsWith('Page 5 of 8'), 'Escape does not move');
    await pageBox.fill('99');
    await pageBox.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 8 of 8'), { timeoutMs: 10000, label: 'last page' });
    // The box follows the scroll, and Ctrl+G still jumps to a page box.
    await s.win.keyboard.press('Control+g');
    assert.equal(await s.win.evaluate(() => document.activeElement?.id), 'page-box', 'Ctrl+G focuses the page box of the top bar');
    await s.win.keyboard.press('Escape');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('status bar at narrow widths: the slider goes first, then the document info, then Fit page and Fit width (they move into the % menu)', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    const status = s.win.locator('footer.status-bar');
    const seen = async () => ({
      slider: await status.getByLabel('Zoom slider').count(),
      info: await status.locator('.status-info').count(),
      fit: await status.getByRole('button', { name: 'Fit page', exact: true }).count(),
      pageBox: await status.getByLabel('Go to page').count(),
      zoomBox: await status.getByLabel('Zoom level').count(),
    });
    await setWidth(s, 1500);
    assert.deepEqual(await seen(), { slider: 1, info: 1, fit: 1, pageBox: 1, zoomBox: 1 });
    await setWidth(s, 600);
    assert.deepEqual(await seen(), { slider: 0, info: 1, fit: 1, pageBox: 1, zoomBox: 1 }, 'the slider goes first');
    await setWidth(s, 480);
    assert.deepEqual(await seen(), { slider: 0, info: 0, fit: 1, pageBox: 1, zoomBox: 1 }, 'then the document info');
    await setWidth(s, 380);
    assert.deepEqual(await seen(), { slider: 0, info: 0, fit: 0, pageBox: 1, zoomBox: 1 }, 'then Fit page and Fit width; the page box and the zoom box stay');
    // Fit page and Fit width are in the % menu now.
    await status.getByRole('button', { name: 'Zoom presets' }).click();
    const menu = s.win.getByRole('menu', { name: 'Zoom presets' });
    assert.equal(await menu.getByRole('menuitem', { name: /Fit page/ }).count(), 1);
    assert.equal(await menu.getByRole('menuitem', { name: /Fit width/ }).count(), 1);
    await menu.getByRole('menuitem', { name: /Fit width/ }).click();
    await waitFor(async () => (await zoomPercent(s)) > 0, { timeoutMs: 5000, label: 'fit width from the menu' });
    // The page box is still usable at this width.
    await status.getByLabel('Go to page').fill('3');
    await status.getByLabel('Go to page').press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 3 of 8'), { timeoutMs: 10000, label: 'page 3' });
    await setWidth(s, 1500);
    assert.deepEqual(await seen(), { slider: 1, info: 1, fit: 1, pageBox: 1, zoomBox: 1 }, 'everything is back at 1500 px');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('scrolling a big file changes only the page number in the status bar and the toolbar (nothing else is drawn again)', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture('big-1000.pdf'), 1000);
    await setWidth(s, 1500);
    const result = await s.win.evaluate(async () => {
      let scroller = document.querySelector('.page');
      while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const name = (node) => {
        const el = node.nodeType === 1 ? node : node.parentElement;
        return el?.id || (typeof el?.className === 'string' ? el.className : '') || el?.tagName;
      };
      const watch = (root) => {
        const seen = { records: 0, targets: new Set() };
        const observer = new MutationObserver((records) => {
          for (const r of records) {
            seen.records += 1;
            seen.targets.add(name(r.target));
          }
        });
        observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        return { seen, observer };
      };
      const status = watch(document.querySelector('footer.status-bar'));
      const top = watch(document.querySelector('.top-bar'));
      const pages = new Set();
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 0; i < 300; i++) {
        scroller.scrollTop += 30;
        await frame();
        pages.add(document.querySelector('#status-page-box').value);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      status.observer.takeRecords();
      status.observer.disconnect();
      top.observer.disconnect();
      return { pages: pages.size, status: { records: status.seen.records, targets: [...status.seen.targets] }, top: { records: top.seen.records, targets: [...top.seen.targets] } };
    });
    assert.ok(result.pages >= 4, `the scroll crossed several pages (${result.pages})`);
    // Over 300 frames the status bar changed its page number box once per page, and nothing else.
    assert.deepEqual(result.status.targets, ['status-page-box'], 'only the page number box of the status bar changes');
    assert.ok(result.status.records <= result.pages * 3 + 3, `the status bar changed ${result.status.records} times for ${result.pages} pages`);
    // The toolbar changes the page box, and the Previous page button once when it leaves page 1.
    assert.ok(result.top.targets.every((t) => ['page-box', 'tb-btn', 'tb-tip'].includes(t)), `only the page box and the page buttons change in the toolbar: ${result.top.targets}`);
    assert.ok(result.top.records <= result.pages * 3 + 12, `the toolbar changed ${result.top.records} times for ${result.pages} pages`);
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('a real mouse click into the page box or the zoom box selects its text, so typing replaces it; the presets button is off with no file', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    const presets = s.win.locator('footer.status-bar').getByRole('button', { name: 'Zoom presets' });
    assert.equal(await presets.isDisabled(), true, 'the presets button is off with no document open');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);
    assert.equal(await presets.isDisabled(), false, 'and on with a document');
    const status = s.win.locator('footer.status-bar');
    // Real clicks and key presses (fill() would hide the problem: it selects the text itself).
    const zoom = status.getByLabel('Zoom level');
    await zoom.click();
    await s.win.keyboard.type('150');
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 150, { timeoutMs: 5000, label: '150% typed after a click' });
    const page = status.getByLabel('Go to page');
    await page.click();
    await s.win.keyboard.type('4');
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 4 of 8'), { timeoutMs: 10000, label: 'page 4 typed after a click' });
    const top = s.win.getByLabel('Page number');
    await top.click();
    await s.win.keyboard.type('6');
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 6 of 8'), { timeoutMs: 10000, label: 'page 6 typed in the top bar' });
    // A second click inside the box places the caret instead of selecting everything.
    await zoom.click();
    await zoom.click({ position: { x: 5, y: 8 } });
    await s.win.keyboard.type('9');
    assert.match(await zoom.inputValue(), /^9.+/, 'a click in the focused box places the caret');
    await s.win.keyboard.press('Escape');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('an open "…" menu closes when the window widens and nothing is collapsed any more', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 520);
    await s.win.getByRole('toolbar').getByRole('button', { name: 'More commands' }).click();
    await s.win.getByRole('menu', { name: 'More commands' }).waitFor();
    await setWidth(s, 1500);
    await waitFor(async () => (await s.win.getByRole('menu', { name: 'More commands' }).count()) === 0, { timeoutMs: 5000, label: 'the menu went with the button' });
    assert.equal((await barState(s)).overflowVisible, false);
    assert.equal(await s.win.getByRole('toolbar').getByRole('button', { name: 'Pan and zoom', exact: true }).isVisible(), true, 'the toolbar says "Pan and zoom"');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('with no file open every disabled zoom control gives the reason as its tooltip', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    const status = s.win.locator('footer.status-bar');
    const reason = 'Open a PDF to use zoom.';
    for (const target of [
      status.getByRole('button', { name: 'Fit page', exact: true }),
      status.getByRole('button', { name: 'Zoom in', exact: true }),
      status.getByRole('button', { name: 'Zoom presets', exact: true }),
      status.getByLabel('Zoom level'),
      status.getByLabel('Zoom slider'),
    ]) {
      assert.equal(await target.isDisabled(), true);
      // Hover the slot the control sits in (a disabled control does not take the pointer) and read the real tooltip.
      const tip = await tooltipAfterHover(s, target.locator("xpath=ancestor::*[contains(@class,'tb-tip')][1]"));
      assert.equal(tip?.text, reason);
    }
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

// ------------------------------------------------------------------------------------------------ keyboard

/** The accessible name of the element that has the focus. */
const focusedName = (s) =>
  s.win.evaluate(() => {
    const el = document.activeElement;
    return el ? el.getAttribute('aria-label') || el.id || el.textContent?.trim().slice(0, 30) || el.tagName : null;
  });

test('keyboard: Tab reaches every toolbar and status bar control, the "…" menu opens with Enter or Down and works with arrows and Esc', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    await setWidth(s, 1500);

    // Tab through the whole window and collect the names of what takes the focus.
    await s.win.evaluate(() => document.activeElement?.blur());
    const reached = new Set();
    for (let i = 0; i < 160; i++) {
      await s.win.keyboard.press('Tab');
      const name = await focusedName(s);
      if (name) reached.add(name);
      if (name === 'Zoom slider') break;
    }
    // Undo and Redo are off until there is something to undo, and an off button is not a Tab stop.
    for (const name of [...CRITICAL_NAMES.filter((n) => n !== 'Undo' && n !== 'Redo'), 'Recent files', 'Split', 'Loupe', 'Pan and zoom', 'Insert pages', 'Rotate right 90°', 'More rotation options', 'Crop pages', 'Page size', 'More page actions', 'Go to page', 'Fit page', 'Fit width', 'Zoom out', 'Zoom level', 'Zoom presets', 'Zoom in', 'Zoom slider']) {
      const found = [...reached].some((r) => r === name || r.startsWith(`${name}`) || (name === 'Open' && r === 'Open'));
      assert.ok(found, `Tab reaches "${name}" (reached: ${[...reached].join(' | ')})`);
    }

    // A toolbar menu: Down opens it, arrows move, Enter runs a row, Esc closes and the focus returns to the button.
    const insert = s.win.getByRole('toolbar').getByRole('button', { name: 'Insert pages' });
    await insert.focus();
    await insert.press('ArrowDown');
    const menu = s.win.getByRole('menu', { name: 'Insert pages' });
    await menu.waitFor();
    assert.equal(await insert.getAttribute('aria-expanded'), 'true');
    const first = await focusedName(s);
    assert.equal(first, 'Blank page…', 'the first row has the focus');
    await s.win.keyboard.press('ArrowDown');
    assert.equal(await s.win.evaluate(() => document.activeElement?.textContent?.trim()), 'Lined page…');
    await s.win.keyboard.press('ArrowUp');
    await s.win.keyboard.press('ArrowUp');
    assert.equal(await s.win.evaluate(() => document.activeElement?.textContent?.trim()), 'From PDF…', 'the arrow keys wrap around');
    await s.win.keyboard.press('Escape');
    assert.equal(await s.win.getByRole('menu', { name: 'Insert pages' }).count(), 0, 'Esc closes the menu');
    assert.equal(await s.win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Insert pages', 'and the focus goes back to its button');
    // Enter on a row runs it: the Insert sheet opens (then Esc/Cancel closes it).
    await insert.focus();
    await insert.press('Enter');
    await s.win.getByRole('menu', { name: 'Insert pages' }).waitFor();
    await s.win.keyboard.press('Enter');
    const sheet = s.win.getByRole('dialog', { name: 'Insert pages' });
    await sheet.waitFor({ timeout: 10000 });
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await s.win.getByRole('dialog', { name: 'Insert pages' }).count()) === 0, { timeoutMs: 5000, label: 'sheet closed' });

    // The zoom presets menu from the keyboard.
    const presets = s.win.locator('footer.status-bar').getByRole('button', { name: 'Zoom presets' });
    await presets.focus();
    await presets.press('Enter');
    await s.win.getByRole('menu', { name: 'Zoom presets' }).waitFor();
    // Arrow to 200% and press Enter.
    for (let i = 0; i < 12; i++) {
      if ((await s.win.evaluate(() => document.activeElement?.textContent ?? '')).includes('200%')) break;
      await s.win.keyboard.press('ArrowDown');
    }
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await zoomPercent(s)) === 200, { timeoutMs: 5000, label: '200% from the keyboard' });

    // At a narrow width the "…" button is in the Tab order, and the menu works with the keyboard.
    await setWidth(s, 520);
    const more = s.win.getByRole('toolbar').getByRole('button', { name: 'More commands' });
    assert.equal(await more.isVisible(), true);
    await s.win.getByLabel('Page number').focus();
    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) {
      await s.win.keyboard.press('Tab');
      landed = (await focusedName(s)) === 'More commands';
    }
    assert.ok(landed, 'Tab reaches "…"');
    await s.win.keyboard.press('Enter');
    const overflow = s.win.getByRole('menu', { name: 'More commands' });
    await overflow.waitFor();
    const firstRow = await s.win.evaluate(() => document.activeElement?.textContent);
    await s.win.keyboard.press('ArrowDown');
    assert.notEqual(await s.win.evaluate(() => document.activeElement?.textContent), firstRow, 'ArrowDown moves to the next row');
    await s.win.keyboard.press('Escape');
    assert.equal(await overflow.count(), 0, 'Esc closes the "…" menu');
    assert.equal(await focusedName(s), 'More commands', 'and the focus is back on "…"');
    await s.win.keyboard.press('ArrowDown');
    await s.win.getByRole('menu', { name: 'More commands' }).waitFor();
    await s.win.keyboard.press('Escape');
    // Everything in the "…" menu is reachable and runs: Enter on a row.
    await s.win.keyboard.press('Enter');
    const loupeRow = s.win.getByRole('menu', { name: 'More commands' }).getByRole('menuitemcheckbox', { name: /Loupe/ });
    await loupeRow.focus();
    await s.win.keyboard.press('Enter');
    await waitFor(async () => (await s.win.getByRole('menu', { name: 'More commands' }).count()) === 0, { timeoutMs: 5000, label: 'menu closed after Enter' });
    await waitFor(async () => (await s.win.locator('section.floating').count()) === 1, { timeoutMs: 5000, label: 'the Loupe opened' });
    await s.win.locator('section.floating').getByRole('button', { name: /Close/ }).first().click();
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

// ------------------------------------------------------------------------------------------------ sign-off items 2 to 5

test('Close All is Ctrl+Shift+W and the File menu shows it; the File menu says "Open…"', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(MARGINS);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, a.path, 8);
    await s.setDialogAnswer([b.path]);
    await s.win.keyboard.press('Control+o');
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 2, { timeoutMs: 20000, label: 'two tabs' });

    await s.win.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
    const rows = await s.win.locator('.menu-top > .menu-dropdown > .menu-item').evaluateAll((els) =>
      els.map((el) => ({ label: el.querySelector('.menu-label')?.textContent ?? '', accel: el.querySelector('.menu-accel')?.textContent ?? '' })),
    );
    assert.deepEqual(rows.find((r) => r.label === 'Open…'), { label: 'Open…', accel: 'Ctrl+O' }, 'the File menu says "Open…"');
    assert.equal(rows.some((r) => r.label === 'Open PDF'), false, 'and not "Open PDF"');
    assert.deepEqual(rows.find((r) => r.label === 'Close All'), { label: 'Close All', accel: 'Ctrl+Shift+W' }, 'Close All shows Ctrl+Shift+W');
    assert.deepEqual(rows.find((r) => r.label === 'Close Tab'), { label: 'Close Tab', accel: 'Ctrl+W' });
    await s.win.keyboard.press('Escape');

    await s.win.keyboard.press('Control+Shift+w');
    await waitFor(async () => (await s.win.getByRole('tab').count()) === 0, { timeoutMs: 10000, label: 'all tabs closed' });
    await s.win.locator('.empty-state').waitFor({ timeout: 5000 });
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeCopy(a);
    removeCopy(b);
  }
});

test('Insert lined and Insert grid say "lined" and "grid" in the toast and in the Undo label', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, fixture(MIXED), 8);
    for (const [command, kind] of [['Pages: Insert lined page…', 'lined'], ['Pages: Insert grid page…', 'grid'], ['Pages: Insert blank page…', 'blank']]) {
      await palette(s.win, command);
      const sheet = s.win.getByRole('dialog', { name: 'Insert pages' });
      await sheet.waitFor({ timeout: 10000 });
      await sheet.getByRole('button', { name: 'Apply' }).click();
      await s.win.locator('.toast', { hasText: `Inserted 1 ${kind} page` }).first().waitFor({ timeout: 10000 });
      const undo = s.win.getByRole('toolbar').getByRole('button', { name: /^Undo/ });
      await waitFor(async () => (await undo.getAttribute('aria-label')) === `Undo Insert 1 ${kind} page`, { timeoutMs: 10000, label: `Undo says ${kind}` });
      // The Edit menu says the same.
      await s.win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
      await s.win.locator('.menu-dropdown').getByRole('menuitem', { name: `Undo Insert 1 ${kind} page` }).waitFor({ timeout: 5000 });
      await s.win.keyboard.press('Escape');
    }
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('a long window title is cut in the middle of the file name; the unsaved dot and " — PDF Suite" never are; the tooltip has the full name', async () => {
  const dir = copyOf(MIXED);
  const longName = `A very long file name that goes on and on ${'and on '.repeat(14)}final.pdf`;
  const path = join(dir.dir, longName);
  copyFileSync(dir.path, path);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await openFile(s, path, 8);
    await setWidth(s, 760);
    // An unsaved change shows the dot.
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 10000, label: 'unsaved' });

    const info = await s.win.evaluate(() => {
      const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const title = document.querySelector('.menu-title');
      const head = document.querySelector('.menu-title-head');
      const end = document.querySelector('.menu-title-end');
      const tail = document.querySelector('.menu-title-tail');
      const tops = rect('.menu-tops');
      const space = rect('.menu-window-space');
      return {
        tooltip: title.getAttribute('title'),
        documentTitle: document.title,
        headText: head.textContent,
        headCut: head.scrollWidth > head.clientWidth,
        endText: end.textContent,
        endBox: [end.getBoundingClientRect().left, end.getBoundingClientRect().right],
        tailText: tail.textContent,
        tailBox: [tail.getBoundingClientRect().left, tail.getBoundingClientRect().right],
        tailClipped: tail.scrollWidth > tail.clientWidth,
        title: [title.getBoundingClientRect().left, title.getBoundingClientRect().right],
        menus: tops.right,
        windowButtons: space.left,
      };
    });
    assert.equal(info.tooltip, `${longName} • — PDF Suite`, 'the tooltip holds the full title, dot included');
    assert.equal(info.documentTitle, info.tooltip, 'document.title is the same text, for the taskbar');
    assert.equal(info.headCut, true, 'the long name is cut');
    assert.ok(info.headText.startsWith('A very long file name'), 'the start of the name stays in the text');
    assert.ok(info.endText.endsWith('.pdf') && longName.endsWith(info.endText), `the end of the name, with its extension, is always shown (${info.endText})`);
    assert.ok(info.endBox[1] <= info.tailBox[0] + 1, 'the end of the name comes before the tail');
    assert.ok(info.tailText.includes('•') && info.tailText.endsWith('— PDF Suite'), `the dot and the app name are in the tail (${JSON.stringify(info.tailText)})`);
    assert.equal(info.tailClipped, false, 'the tail is never cut');
    assert.ok(info.tailBox[1] <= info.windowButtons + 1 && info.title[0] >= info.menus - 1, 'the title stays between the menus and the window buttons');
    // The part the user sees: the first characters, an ellipsis, then the end with the extension.
    const visible = await s.win.evaluate(() => {
      const head = document.querySelector('.menu-title-head');
      return { cut: getComputedStyle(head).textOverflow, overflow: getComputedStyle(head).overflow };
    });
    assert.deepEqual(visible, { cut: 'ellipsis', overflow: 'hidden' });

    // Save to leave nothing unsaved (the file is a copy in a temp folder).
    await s.win.keyboard.press('Control+s');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) === 0, { timeoutMs: 20000, label: 'saved' });
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    removeCopy(dir);
  }
});
