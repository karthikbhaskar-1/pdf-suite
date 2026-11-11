// Menu bar and edge cases of 1.2.1: every menu item with no document open (no errors), keyboard-only menu use (Alt,
// mnemonics, arrows, Esc), the last page cannot be deleted, insert from a password-locked source and from a non-PDF,
// invalid sheet inputs, and blank clicks with zero console errors.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, closeAll, copyOf, removeCopy, open, palette, jumpTo, pageCount, waitFor, assertNoErrors, delay, statusText } from './matrix-lib.mjs';

after(closeAll);

const MARGINS = 'margins-white.pdf';
const LOCKED = 'locked.pdf';
const NOT_PDF = 'notes.txt';

/** Items that would quit the app, open Explorer, or change a saved setting. They are not clicked. */
const SKIP = /^(Exit|Open logs folder|Full screen|Toolbar|Theme|Dark|Light|System|Clear recent list)/i;

test('with no document open, every menu item can be clicked with no error', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    const tops = s.win.locator('[role="menubar"] > .menu-top > [role="menuitem"]');
    assert.equal(await tops.count(), 6, 'six top-level menus: File, Edit, View, Pages, Window, Help');
    const itemsOf = s.win.locator('.menu-dropdown:not(.menu-sub) > [role^="menuitem"], .menu-dropdown:not(.menu-sub) > .menu-sub-wrap > [role="menuitem"]');
    // Esc closes a submenu first and then the menu, so it is pressed until no dropdown is left.
    const menuClosed = async () => {
      for (let k = 0; k < 3 && (await s.win.locator('.menu-dropdown').count()) > 0; k++) await s.win.keyboard.press('Escape');
      await waitFor(async () => (await s.win.locator('.menu-dropdown').count()) === 0, { timeoutMs: 5000, label: 'menu closed' });
    };
    let clicked = 0;
    for (let m = 0; m < 6; m++) {
      await tops.nth(m).click();
      const menu = s.win.locator('.menu-dropdown:not(.menu-sub)').first();
      await menu.waitFor({ timeout: 5000 });
      const labels = await itemsOf.evaluateAll((els) => els.map((e) => ({ name: e.textContent?.trim() ?? '', disabled: e.disabled === true })));
      await s.win.keyboard.press('Escape');
      await menuClosed();
      assert.ok(labels.length > 0, `menu ${m} lists items`);
      for (let i = 0; i < labels.length; i++) {
        const { name, disabled } = labels[i];
        if (SKIP.test(name.replace(/^[✓●]\s*/, ''))) continue;
        await tops.nth(m).click();
        const item = itemsOf.nth(i);
        try {
          await item.waitFor({ timeout: 5000 });
          if (disabled) {
            assert.equal(await item.isDisabled(), true, 'stays disabled');
            await s.win.keyboard.press('Escape');
          } else {
            await item.click({ timeout: 3000 });
            clicked++;
          }
        } catch (error) {
          assert.fail(`menu item "${name}" (menu ${m}, item ${i}) could not be clicked: ${error.message}`);
        }
        // Real conditions instead of fixed waits: the menu closes (or Esc closes a submenu or a disabled item's menu),
        // the page settles for two frames, then any dialog the item opened is dismissed and must go away.
        if (!disabled) await s.win.keyboard.press('Escape').catch(() => undefined);
        await menuClosed();
        await s.win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        for (let k = 0; k < 3 && (await s.win.locator('[role="dialog"]').count()) > 0; k++) {
          await s.win.keyboard.press('Escape');
          await waitFor(async () => (await s.win.locator('[role="dialog"]').count()) < 1 || k < 2, { timeoutMs: 3000, label: `dialog from "${name}" dismissed` });
        }
        assert.equal(await s.win.locator('[role="dialog"]').count(), 0, `the dialog opened by "${name}" is dismissed`);
      }
    }
    assert.ok(clicked > 5, `enough enabled items were clicked: ${clicked}`);
    assert.equal(await s.win.locator('.empty-state').count(), 1, 'the app is still on the empty state');
    assertNoErrors(s);
  } finally {
    await s.close();
  }
});

/** True when the focused element is inside the menu bar. */
const focusInBar = (win) => win.evaluate(() => !!document.activeElement?.closest('[role="menubar"], [role="menu"]'));

test('keyboard only: Alt and F10 put DOM focus in the bar, F opens File, arrows move, Esc returns focus', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    const page = s.win.locator('.main');
    await page.focus().catch(() => undefined);
    // A lone Alt moves real focus to the first menu button; the same Alt again gives it back.
    await s.win.keyboard.press('Alt');
    await waitFor(() => focusInBar(s.win), { timeoutMs: 5000, label: 'focus in the bar after Alt' });
    assert.equal(await s.win.evaluate(() => document.activeElement?.textContent?.trim()), 'File', 'Alt focuses the first menu');
    await s.win.keyboard.press('ArrowRight');
    await waitFor(async () => (await s.win.evaluate(() => document.activeElement?.textContent?.trim())) === 'Edit', { timeoutMs: 5000, label: 'Right focuses Edit' });
    await s.win.keyboard.press('Escape');
    await waitFor(async () => !(await focusInBar(s.win)), { timeoutMs: 5000, label: 'focus left the bar after Esc' });
    // F10 does the same.
    await s.win.keyboard.press('F10');
    await waitFor(() => focusInBar(s.win), { timeoutMs: 5000, label: 'focus in the bar after F10' });
    assert.equal(await s.win.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
    await s.win.keyboard.press('Escape');
    await waitFor(async () => !(await focusInBar(s.win)), { timeoutMs: 5000, label: 'focus left the bar after Esc (F10)' });
    // The mnemonic F opens File; the focus is on its first item.
    await s.win.keyboard.press('Alt');
    await s.win.keyboard.press('f');
    const fileItem = s.win.getByRole('menuitem', { name: /^Save As/ });
    await waitFor(async () => (await fileItem.count()) > 0, { timeoutMs: 5000, label: 'File menu open (Save As visible)' });
    assert.ok(await focusInBar(s.win), 'focus is inside the open menu');
    await s.win.keyboard.press('ArrowRight');
    // Right moves to Edit: its items (Find, Go to Page) are visible and File's are not.
    await waitFor(async () => (await s.win.getByRole('menuitem', { name: /^Find/ }).count()) > 0, { timeoutMs: 5000, label: 'Edit menu open (Find visible)' });
    assert.equal(await fileItem.count(), 0, 'File closed when Right moved to Edit');
    await s.win.keyboard.press('Escape');
    await waitFor(async () => (await s.win.getByRole('menuitem', { name: /^Find/ }).count()) === 0, { timeoutMs: 5000, label: 'menu closed by Esc' });
    assert.equal(await focusInBar(s.win), false, 'focus returned out of the bar');
    assertNoErrors(s);
  } finally {
    await s.close();
  }
});

test('the last page of a document cannot be deleted: Delete is disabled with its reason, and the Delete key shows it as a toast', async () => {
  const copy = copyOf(MARGINS);
  const s = await launch();
  const REASON = 'A PDF needs at least one page.';
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await jumpTo(s.win, 0);
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => (await pageCount(s.win)) === 1, { timeoutMs: 15000, label: 'one page left' });
    await jumpTo(s.win, 0);

    // The toolbar button is disabled and its tooltip is the reason.
    const button = s.win.getByRole('button', { name: 'Delete pages', exact: true }).first();
    await waitFor(async () => (await button.isDisabled()) && (await button.getAttribute('data-tooltip')) === REASON, {
      timeoutMs: 10000,
      label: 'Delete pages disabled with its reason',
    });

    // The palette lists the command as disabled, and Enter does not run it (the palette stays open).
    await s.win.keyboard.press('Control+k');
    const dialog = s.win.getByRole('dialog', { name: 'Command palette' });
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByPlaceholder('Type a command').fill('Pages: Delete');
    const option = dialog.getByRole('option', { name: /Pages: Delete/ }).first();
    await waitFor(async () => (await option.getAttribute('aria-disabled')) === 'true', { timeoutMs: 5000, label: 'palette shows Pages: Delete disabled' });
    await dialog.getByPlaceholder('Type a command').press('Enter');
    await delay(300);
    assert.equal(await dialog.count(), 1, 'Enter on a disabled command leaves the palette open');
    await s.win.keyboard.press('Escape');
    await waitFor(async () => (await s.win.getByRole('dialog', { name: 'Command palette' }).count()) === 0, { timeoutMs: 5000, label: 'palette closed' });

    // The Delete key on the only page says why, as a toast, and the page stays.
    await jumpTo(s.win, 0);
    await s.win.keyboard.press('Delete');
    await s.win.locator('.toast', { hasText: REASON }).first().waitFor({ timeout: 10000 });
    assert.equal(await s.win.getByRole('dialog', { name: 'Delete pages?' }).count(), 0, 'no confirm sheet is asked');
    assert.equal(await pageCount(s.win), 1, 'the last page is kept');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('insert from a password-locked source asks for the password, and cancelling leaves the document alone', async () => {
  const copy = copyOf(MARGINS);
  const locked = copyOf(LOCKED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await s.setDialogAnswer([locked.path]);
    await palette(s.win, 'Pages: Insert pages from a PDF…');
    const dialog = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
    // The app asks for the password (a dialog with a Password box); Cancel leaves the document alone.
    const prompt = s.win.getByRole('dialog', { name: 'Password needed' });
    await prompt.waitFor({ timeout: 20000 });
    assert.equal(await prompt.getByLabel('Password').count(), 1, 'the prompt has a Password box');
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await prompt.waitFor({ state: 'detached', timeout: 10000 });
    await delay(300);
    assert.equal(await pageCount(s.win), 2, 'the document still has its 2 pages');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
    removeCopy(locked);
  }
});

test('insert from a non-PDF file shows "This isn\'t a PDF." and inserts nothing', async () => {
  const copy = copyOf(MARGINS);
  const notPdf = copyOf(NOT_PDF);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await s.setDialogAnswer([notPdf.path]);
    await palette(s.win, 'Pages: Insert pages from a PDF…');
    const dialog = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await s.win.getByText("This isn't a PDF.").first().waitFor({ timeout: 20000 });
    assert.equal(await pageCount(s.win), 2);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
    removeCopy(notPdf);
  }
});

test('invalid sheet inputs leave the document unchanged: negative margin, absurd size, range "9-3", empty range', async () => {
  const copy = copyOf(MARGINS);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await jumpTo(s.win, 0);

    // Negative margin: the field must not keep a negative value, or Apply must be disabled.
    await palette(s.win, 'Pages: Crop…');
    const crop = s.win.getByRole('dialog', { name: 'Crop pages' });
    await crop.waitFor();
    await crop.getByRole('spinbutton', { name: 'Top margin' }).fill('-10');
    const topValue = await crop.getByRole('spinbutton', { name: 'Top margin' }).inputValue();
    const applyDisabled = await crop.getByRole('button', { name: 'Apply' }).isDisabled();
    assert.ok(!topValue.startsWith('-') || applyDisabled, `a negative margin is refused (value "${topValue}", apply disabled ${applyDisabled})`);
    await s.win.keyboard.press('Escape');

    // Absurd page size: over 14,400 pt must be refused.
    await palette(s.win, 'Pages: Set page size…');
    const size = s.win.getByRole('dialog', { name: 'Page size' });
    await size.waitFor();
    await size.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: 'Custom' }).click();
    await size.getByRole('spinbutton', { name: 'Custom width' }).fill('20000');
    await size.getByRole('spinbutton', { name: 'Custom height' }).fill('20000');
    if (!(await size.getByRole('button', { name: 'Apply' }).isDisabled())) await size.getByRole('button', { name: 'Apply' }).click();
    await delay(800);
    assert.equal(await s.win.locator('.toast', { hasText: '20000' }).count(), 0, 'no page is resized to 20,000 pt');
    await s.win.keyboard.press('Escape');

    // Range "9-3" and an empty range, on a From PDF sheet with the 2-page file as the source.
    await s.setDialogAnswer([copy.path]);
    await palette(s.win, 'Pages: Insert pages from a PDF…');
    const from = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
    await from.waitFor();
    await from.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await from.getByText(/2 pages/).waitFor({ timeout: 20000 });
    for (const range of ['9-3', '']) {
      await from.getByRole('textbox', { name: 'Page range' }).fill(range);
      if (!(await from.getByRole('button', { name: 'Apply' }).isDisabled())) await from.getByRole('button', { name: 'Apply' }).click();
      await delay(500);
      assert.equal(await pageCount(s.win), 2, `range "${range}" inserts nothing`);
    }
    await s.win.keyboard.press('Escape');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('blank clicks on the empty state and the page area raise no console errors', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    const box = await s.win.locator('.empty-state').boundingBox();
    for (let i = 0; i < 20; i++) {
      await s.win.mouse.click(box.x + box.width / 2 + (i % 5) * 7, box.y + box.height / 2 + (i % 3) * 5);
    }
    await s.win.mouse.click(5, 5);
    assert.equal(await statusText(s.win).then((t) => /Page/.test(t)), false, 'no page appears from blank clicks');
    assertNoErrors(s);
  } finally {
    await s.close();
  }
});
