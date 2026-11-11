// Background tabs release memory (1.5.4), driven through the real UI of the packaged app.
// A tab not shown for a while (here 1 s, set through the test hook; the app uses 60 s) with no unsaved edits and no running
// operation ends its worker; coming back reopens it at the same page and zoom. A tab with unsaved edits keeps its worker and
// its undo history. A file that changed on disk while the tab was released is reopened as it is now, with a plain notice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { launchTracked, engineState, pageInk, waitPainted } from '../signoff2/lib.mjs';
import { copyOf, removeCopy, open, statusText, waitFor, waitForCount, currentPage, pageCount, closeAll, cleanupProfile, fixture } from './matrix-lib.mjs';

after(closeAll);

const MIXED = 'mixed-sizes-rotated.pdf'; // 8 pages
const BIG = 'big-1000.pdf'; // 1,000 pages
const hook = (s, call, arg) => s.win.evaluate(({ call, arg }) => window.__pdfSuiteResidency[call](arg), { call, arg });
const tab = (s, i) => s.win.getByRole('tab').nth(i);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function goTo(s, page) {
  const box = s.win.getByLabel('Page number');
  await box.click();
  await box.fill(String(page));
  await box.press('Enter');
  await waitFor(async () => (await currentPage(s.win)) === page, { timeoutMs: 15000, label: `page ${page}` });
}

/** Waits one idle period, then asks for one sweep. Returns what it released. */
async function sweepAfterIdle(s) {
  await hook(s, 'setIdleMs', 800);
  await delay(1200);
  return hook(s, 'sweep');
}

async function finish(s, copies) {
  await s.close();
  cleanupProfile(s.profile);
  copies.forEach(removeCopy);
}

test('a clean background tab ends its worker; coming back reopens it at the same page and zoom, and the pages draw', async () => {
  const a = copyOf(BIG);
  const b = copyOf(MIXED);
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 1000);
    await goTo(s, 40);
    for (let i = 0; i < 2; i++) await s.win.keyboard.press('Control+=');
    await delay(500);
    const before = await statusText(s.win);
    await open(s, b.path, 8);
    const live0 = (await engineState(s.win)).mupdfWorkersLive;

    const done = await sweepAfterIdle(s);
    const live1 = (await engineState(s.win)).mupdfWorkersLive;
    console.log(`  released: ${done.workers.length} worker(s); live workers ${live0} -> ${live1}; status before ${JSON.stringify(before)}`);
    assert.equal(done.workers.length, 1, 'the background tab ends its worker');
    assert.equal(live1, live0 - 1, 'one live worker less');
    assert.equal((await hook(s, 'released')).length, 1);

    const t0 = Date.now();
    await tab(s, 0).click();
    await waitFor(async () => (await statusText(s.win)) === before, { timeoutMs: 20000, label: `status ${before}` });
    const painted = await waitPainted(s.win, 39, 20000);
    const ms = Date.now() - t0;
    const after = await statusText(s.win);
    const resumed = await hook(s, 'lastResume');
    console.log(`  back on the tab: ${ms} ms to the page painted (reopen ${resumed?.ms} ms); status ${JSON.stringify(after)}; ink ${painted.value.ink}`);
    assert.equal(after, before, 'the same page and zoom as before');
    assert.ok(painted.value.ink > 0.001, 'the page is drawn, not blank');
    assert.equal(resumed?.changed, false);
    assert.equal((await hook(s, 'released')).length, 0);
    assert.equal((await engineState(s.win)).mupdfWorkersLive, live0, 'the worker is back');
    assert.equal(await s.win.getByText('This file changed on disk.').count(), 0, 'an unchanged file shows no bar');
    // Scroll a few pages: every visible page draws.
    await s.win.mouse.move(700, 450);
    await s.win.mouse.wheel(0, 1500);
    await delay(800);
    const page = (await currentPage(s.win)) - 1;
    const ink = await waitPainted(s.win, page, 15000);
    assert.ok(ink.value.ink > 0.001, 'a page after scrolling is drawn');
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await finish(s, [a, b]);
  }
});

test('a tab with unsaved edits keeps its worker and its undo history; only its bitmaps are released', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(BIG);
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await s.win.locator('.thumb').nth(0).click();
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    await open(s, b.path, 1000);
    const live0 = (await engineState(s.win)).mupdfWorkersLive;

    const done = await sweepAfterIdle(s);
    const live1 = (await engineState(s.win)).mupdfWorkersLive;
    console.log(`  bitmaps released for ${done.bitmaps.length} document(s), workers ${done.workers.length}; live workers ${live0} -> ${live1}`);
    assert.equal(done.workers.length, 0, 'the worker with edits is never ended');
    assert.ok(done.bitmaps.length >= 1, 'its bitmaps are released');
    assert.equal(live1, live0);
    assert.equal((await hook(s, 'released')).length, 0);

    await tab(s, 0).click();
    await waitFor(async () => (await pageCount(s.win)) === 7, { timeoutMs: 20000, label: '7 pages' });
    await waitPainted(s.win, 0, 20000);
    assert.equal(await hook(s, 'lastResume'), null, 'nothing was reopened');
    // The undo history is still there.
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 8);
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await finish(s, [a, b]);
  }
});

test('a file that changed on disk while its tab was released is reopened as it is now, with a plain notice and no Reload / Keep bar', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(BIG);
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 8);
    await goTo(s, 3);
    await open(s, b.path, 1000);
    const done = await sweepAfterIdle(s);
    assert.equal(done.workers.length, 1);
    // Another program replaces the released tab's file.
    writeFileSync(a.path, readFileSync(fixture(BIG)));
    await tab(s, 0).click();
    await s.win.locator('.toast', { hasText: 'This file changed while the tab was in the background, so it was reopened as it is now.' }).first().waitFor({ timeout: 20000 });
    await waitFor(async () => (await pageCount(s.win)) === 1000, { timeoutMs: 20000, label: '1000 pages (the file as it is now)' });
    const resumed = await hook(s, 'lastResume');
    console.log(`  notice shown after the reopen; changed=${resumed?.changed}; status ${JSON.stringify(await statusText(s.win))}`);
    assert.equal(resumed?.changed, true);
    // There is no other version to keep, so no bar, and the file stays unchanged by the app: nothing is flagged later either.
    assert.equal(await s.win.getByText('This file changed on disk.').count(), 0, 'no Reload / Keep bar');
    await delay(6500); // longer than the disk watch interval
    assert.equal(await s.win.getByText('This file changed on disk.').count(), 0, 'the disk watch does not flag the reopened file');
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await finish(s, [a, b]);
  }
});

test('the document of the active tab, also in a split, is never released', async () => {
  const a = copyOf(MIXED);
  const b = copyOf(BIG);
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, b.path, 1000);
    await open(s, a.path, 8);
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    const done = await sweepAfterIdle(s);
    assert.equal(done.workers.length, 1, 'only the other tab (not shown) is released');
    assert.equal(await s.win.locator('.pane-frame').count(), 2);
    assert.equal(await currentPage(s.win), 1);
    const ink = await pageInk(s.win, 0, 0);
    assert.ok(ink.found && !ink.placeholder, 'the split still shows its pages');
    assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
  } finally {
    await finish(s, [a, b]);
  }
});
