// Round 2 coverage: rotate view, copy path, thumbnail multi-select, custom recolor, per-pane picker,
// whole-word search, Open in split, floating window memory across relaunch, split divider keys,
// and a restored tab whose file was deleted between sessions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, fixture, statusText, waitFor, waitForPage, waitForOutcome, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

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
const tabs = (win) => win.getByRole('tab');

test('Rotate view turns only the active pane; the other pane and the thumbnails are unchanged', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
    const thumbSizes = () => s.win.locator('.thumb-image').evaluateAll((els) => els.map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`).join(','));
    const paneBox = (i) => s.win.locator('.pane-frame').nth(i).locator('.page-canvas').first().evaluate((c) => `${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`);
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { label: 'two panes' });
    await s.win.waitForTimeout(600);
    const before = { p1: await paneBox(0), p2: await paneBox(1), thumbs: await thumbSizes() };
    // Rotate the active pane (the second one, after the split) from the palette.
    await s.win.keyboard.press('Control+k');
    await s.win.getByLabel('Type a command').fill('Rotate view');
    await s.win.keyboard.press('Enter');
    await s.win.waitForTimeout(800);
    const after = { p1: await paneBox(0), p2: await paneBox(1), thumbs: await thumbSizes() };
    console.log(`  rotate: pane1 ${before.p1} -> ${after.p1}; pane2 ${before.p2} -> ${after.p2}; thumbs unchanged: ${before.thumbs === after.thumbs}`);
    assert.notEqual(after.p2, before.p2, 'the active pane should rotate');
    assert.equal(after.p1, before.p1, 'the other pane should not rotate');
    assert.equal(after.thumbs, before.thumbs, 'thumbnails should not change');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('Copy path from the tab menu puts the file path on the system clipboard (read in the main process)', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    await s.app.evaluate(({ clipboard }) => clipboard.clear());
    await tabs(s.win).first().click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: /Copy path/ }).click();
    const clip = await waitFor(async () => {
      const text = await s.app.evaluate(({ clipboard }) => clipboard.readText());
      return text.length > 0 ? text : undefined;
    }, { timeoutMs: 5000, label: 'clipboard text' }).then((r) => r.value).catch(() => '');
    console.log(`  clipboard: ${clip}`);
    assert.equal(clip.toLowerCase(), fixture('mixed-sizes-rotated.pdf').toLowerCase());
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('thumbnails: click selects one, Ctrl+click adds, Shift+click selects the range from the anchor', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
    const rows = s.win.locator('.thumb[role="option"]');
    await rows.first().waitFor({ timeout: 15000 });
    const selected = async () => {
      const labels = await s.win.locator('[role="option"][aria-selected="true"] .thumb-label').allInnerTexts();
      return labels.map((t) => Number(t.trim())).sort((a, b) => a - b);
    };
    await rows.nth(0).click();
    assert.deepEqual(await selected(), [1]);
    await rows.nth(2).click({ modifiers: ['Control'] });
    assert.deepEqual(await selected(), [1, 3], 'Ctrl+click adds page 3');
    await rows.nth(3).click({ modifiers: ['Shift'] });
    const range = await selected();
    console.log(`  after Shift+click on page 4 from anchor page 3: selected ${range.join(',')}`);
    assert.deepEqual(range, [3, 4], 'Shift+click selects the range from the anchor (page 3, set by Ctrl+click)');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('custom recolor: two colors (background and text) change the recolor filter', async () => {
  const s = await open('mixed-sizes-rotated.pdf', 'Page 1 of 8');
  try {
    // The Recolor button is an icon since 1.2.2: its name carries the current mode.
    await s.win.getByRole('button', { name: /^Page colors: Off$/ }).click();
    await s.win.getByRole('menuitemradio', { name: 'Custom' }).click();
    await waitFor(async () => (await s.win.getByRole('button', { name: /^Page colors: Custom$/ }).count()) === 1, { label: 'Page colors: Custom' });
    const filterDefs = () => s.win.evaluate(() => document.querySelector('#pdf-recolor')?.innerHTML ?? '');
    const before = await filterDefs();
    await s.win.getByLabel('Custom background color').fill('#102030');
    await s.win.getByLabel('Custom text color').fill('#ffee00');
    await s.win.waitForTimeout(300);
    const after = await filterDefs();
    console.log(`  custom filter definition changed after two colors: ${before !== after}`);
    assert.notEqual(before, after, 'choosing colors should change the recolor filter');
    assert.equal(await s.win.locator('.page-canvas').first().evaluate((el) => getComputedStyle(el).filter), 'url("#pdf-recolor")');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('per-pane file picker: two panes show two different files', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000');
    await tabs(s.win).filter({ hasText: 'mixed-sizes-rotated.pdf' }).click();
    await waitForPage(s, 'Page 1 of 8');
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { label: 'two panes' });
    const pickers = s.win.getByRole('combobox', { name: 'Document in this pane' });
    await pickers.nth(1).selectOption({ label: 'big-1000.pdf' });
    await waitFor(async () => (await pickers.nth(1).evaluate((el) => el.selectedOptions[0].textContent)) === 'big-1000.pdf', { label: 'pane 2 picker' });
    const names = [];
    for (let i = 0; i < 2; i++) names.push(await pickers.nth(i).evaluate((el) => el.selectedOptions[0].textContent));
    console.log(`  pane pickers: ${names.join(' | ')}`);
    assert.deepEqual(names, ['mixed-sizes-rotated.pdf', 'big-1000.pdf']);
    const pagesInPane2 = await s.win.locator('.pane-frame').nth(1).locator('.page-canvas').count();
    assert.ok(pagesInPane2 > 0, 'pane 2 should render its page');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('whole-word toggle: "zephyr" matches inside "zephyrbloom" only when whole word is off', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.fill('zephyr');
    await waitFor(async () => /^\d+ of 1000$/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 60000, label: 'substring search finished' });
    const substring = (await s.win.locator('.search-status').innerText()).trim();
    await s.win.getByTitle('Whole word').click();
    await waitFor(async () => (await s.win.locator('.search-status').innerText()).trim() === 'No matches', { timeoutMs: 60000, label: 'whole-word result' });
    const wholeWord = (await s.win.locator('.search-status').innerText()).trim();
    console.log(`  "zephyr": substring -> "${substring}"; whole word -> "${wholeWord}"`);
    assert.match(substring, /of 1000/);
    assert.equal(wholeWord, 'No matches');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('tab menu "Open in split" splits the clicked tab', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000');
    await tabs(s.win).filter({ hasText: 'mixed-sizes-rotated.pdf' }).click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: /Open in split/ }).click();
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { label: 'split from tab menu' });
    const names = await s.win.getByRole('combobox', { name: 'Document in this pane' }).evaluateAll((els) => els.map((e) => e.selectedOptions[0].textContent));
    console.log(`  panes after Open in split: ${names.join(' | ')}`);
    assert.deepEqual(names, ['mixed-sizes-rotated.pdf', 'mixed-sizes-rotated.pdf']);
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('Pan-zoom window keeps its position and size after relaunch', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  const profile = s.profile;
  try {
    await s.win.getByRole('button', { name: 'Pan and zoom', exact: true }).click();
    const pz = s.win.locator('.floating[aria-label="Pan and zoom"]');
    await pz.waitFor({ timeout: 5000 });
    const header = pz.locator('.floating-header');
    const hb = await header.boundingBox();
    await s.win.mouse.move(hb.x + 30, hb.y + hb.height / 2);
    await s.win.mouse.down();
    await s.win.mouse.move(hb.x - 90, hb.y + hb.height / 2 + 60, { steps: 8 });
    await s.win.mouse.up();
    await s.win.waitForTimeout(500);
    const moved = await pz.boundingBox();
    await s.close();
    const r = await launch({ profile });
    try {
      await waitForPage(r, 'Page 1 of 1000', { timeoutMs: 30000 });
      await r.win.getByRole('button', { name: 'Pan and zoom', exact: true }).click();
      const pz2 = r.win.locator('.floating[aria-label="Pan and zoom"]');
      await pz2.waitFor({ timeout: 10000 });
      const again = await pz2.boundingBox();
      console.log(`  pan-zoom before relaunch (${Math.round(moved.x)},${Math.round(moved.y)}) ${Math.round(moved.width)}x${Math.round(moved.height)}; after (${Math.round(again.x)},${Math.round(again.y)}) ${Math.round(again.width)}x${Math.round(again.height)}`);
      assert.ok(Math.abs(again.x - moved.x) < 4 && Math.abs(again.y - moved.y) < 4, 'position should be remembered');
      assert.ok(Math.abs(again.width - moved.width) < 4 && Math.abs(again.height - moved.height) < 4, 'size should be remembered');
    } finally {
      await r.close();
    }
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(profile);
  }
});

test('split divider keys: Right/Left move 2%, Shift+Arrow moves 10%, Home and End go to the limits', async () => {
  const s = await open('big-1000.pdf', 'Page 1 of 1000');
  try {
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { label: 'split' });
    const handle = s.win.locator('.split-handle');
    await handle.focus();
    const value = () => handle.getAttribute('aria-valuenow').then(Number);
    const start = await value();
    const steps = [];
    await s.win.keyboard.press('ArrowRight');
    steps.push(['ArrowRight', await value()]);
    await s.win.keyboard.press('ArrowLeft');
    await s.win.keyboard.press('ArrowLeft');
    steps.push(['ArrowLeft x2', await value()]);
    await s.win.keyboard.press('Shift+ArrowRight');
    steps.push(['Shift+ArrowRight', await value()]);
    await s.win.keyboard.press('Home');
    steps.push(['Home', await value()]);
    await s.win.keyboard.press('End');
    steps.push(['End', await value()]);
    console.log(`  divider: start ${start}; ${steps.map(([k, v]) => `${k} -> ${v}`).join('; ')}`);
    assert.equal(steps[0][1], start + 2, 'ArrowRight should move 2%');
    assert.equal(steps[1][1], start - 2, 'two ArrowLeft should move back 4%');
    assert.equal(steps[2][1], start + 8, 'Shift+ArrowRight should move 10% (from 46)');
    assert.equal(steps[3][1], 15, 'Home should go to the minimum (15%)');
    assert.equal(steps[4][1], 85, 'End should go to the maximum (85%)');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('a restored tab whose file was deleted shows "This file was moved, renamed or deleted." and never hangs on Opening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-moved-'));
  const copy = join(dir, 'vanishing.pdf');
  copyFileSync(fixture('mixed-sizes-rotated.pdf'), copy);
  const s = await launch({ args: [copy] });
  const profile = s.profile;
  try {
    await waitForPage(s, 'Page 1 of 8');
    await s.close();
    rmSync(copy, { force: true });
    const r = await launch({ profile });
    try {
      const started = performance.now();
      const outcome = await waitForOutcome(r, { timeoutMs: 75000 });
      const ms = Math.round(performance.now() - started);
      const loading = await r.win.locator('.tab-message[role="status"]').count();
      console.log(`  restored deleted file: "${outcome.text}" after ${ms} ms; loading line still showing: ${loading > 0}`);
      assert.equal(outcome.kind, 'message');
      assert.equal(outcome.text, 'This file was moved, renamed or deleted.');
      assert.deepEqual(r.errors, []);
    } finally {
      await r.close();
    }
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(profile);
    rmSync(dir, { recursive: true, force: true });
  }
});
