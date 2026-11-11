// Thumbnail list keys and "follows the current page" (1.5.5 B1, B2), driven through the real UI of the packaged app.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, closeAll, copyOf, removeCopy, open, waitFor, statusText, placeWindow, assertNoErrors } from './matrix-lib.mjs';

after(closeAll);

const BIG = 'big-1000.pdf';

const list = (win) => win.getByRole('listbox', { name: 'Pages' });
const activeLabel = (win) =>
  win.evaluate(() => {
    const list = document.querySelector('.thumb-list');
    const id = list?.getAttribute('aria-activedescendant');
    return id ? (document.getElementById(id)?.getAttribute('aria-label') ?? '').replace(', current page', '') : null;
  });
const selectedLabels = (win) => win.locator('.thumb[aria-selected="true"]').evaluateAll((els) => els.map((el) => (el.getAttribute('aria-label') ?? '').replace(', current page', '')));
const pageBox = (win) => win.evaluate(() => document.querySelector('#status-page-box')?.value);

test('thumbnail list: one tab stop, Explorer keys, and Esc back to the page', async () => {
  const copy = copyOf(BIG);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1200, height: 800 });
    await open(s, copy.path, 1000);

    // Tab from "More page actions" lands on the list, and the selection does not change.
    await s.win.locator('.thumb-toolbar summary[aria-label="More page actions"]').focus();
    await s.win.keyboard.press('Tab');
    await waitFor(async () => (await list(s.win).evaluate((el) => el === document.activeElement)) === true, { label: 'list has focus' });
    assert.deepEqual(await selectedLabels(s.win), [], 'focus by Tab selects nothing');

    // Down three times from page 1 selects page 4 alone, and the page box shows 4.
    for (let i = 0; i < 3; i++) await s.win.keyboard.press('ArrowDown');
    await waitFor(async () => (await pageBox(s.win)) === '4', { label: 'page box 4' });
    assert.deepEqual(await selectedLabels(s.win), ['Page 4']);

    // Shift+Down selects 4-5 and the page box still shows 4.
    await s.win.keyboard.press('Shift+ArrowDown');
    await waitFor(async () => (await selectedLabels(s.win)).length === 2, { label: 'two selected' });
    assert.deepEqual(await selectedLabels(s.win), ['Page 4', 'Page 5']);
    await s.win.waitForTimeout(300);
    assert.equal(await pageBox(s.win), '4');

    // End makes the last page's row active and rendered.
    await s.win.keyboard.press('End');
    await waitFor(async () => (await activeLabel(s.win)) === 'Page 1000', { label: 'last row active' });
    assert.equal(await s.win.locator('.thumb[aria-label^="Page 1000"]').count(), 1, 'the last row is in the page');

    // Esc puts focus on the page and keeps the selection.
    await s.win.keyboard.press('Escape');
    await waitFor(async () => (await list(s.win).evaluate((el) => el === document.activeElement)) === false, { label: 'list lost focus' });
    assert.deepEqual(await selectedLabels(s.win), ['Page 1000']);
    assert.equal(await s.win.evaluate(() => document.activeElement === document.body), false, 'focus never ends on the body');
    assertNoErrors(s);
  } finally {
    await s.close?.();
    removeCopy(copy);
  }
});

test('the thumbnail list follows the current page', async () => {
  const copy = copyOf(BIG);
  const s = await launch();
  try {
    await placeWindow(s, { width: 1200, height: 800 });
    await open(s, copy.path, 1000);
    const box = s.win.locator('#status-page-box');
    await box.fill('400');
    await box.press('Enter');
    await waitFor(async () => (await s.win.locator('.thumb-current').count()) === 1, { timeoutMs: 15000, label: 'thumbnail 400 drawn' });
    const inside = (n) =>
      s.win.evaluate((page) => {
        const list = document.querySelector('.thumb-list');
        const row = [...document.querySelectorAll('.thumb')].find((el) => el.getAttribute('aria-label')?.startsWith(`Page ${page}`));
        if (!list || !row) return false;
        const a = list.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        return b.top >= a.top && b.bottom <= a.bottom;
      }, n);
    await waitFor(() => inside(400), { label: 'thumbnail 400 fully inside the list' });
    assert.match(await statusText(s.win), /^Page 400 of 1000/);

    // Wheel the list away, then Next page: thumbnail 401 is back in view.
    await s.win.locator('.thumb-list').evaluate((el) => {
      el.scrollTop = 0;
    });
    await s.win.keyboard.press('Escape');
    await s.win.getByRole('button', { name: /^Next page/ }).first().click();
    await waitFor(() => inside(401), { timeoutMs: 15000, label: 'thumbnail 401 in view' });
    assertNoErrors(s);
  } finally {
    await s.close?.();
    removeCopy(copy);
  }
});
