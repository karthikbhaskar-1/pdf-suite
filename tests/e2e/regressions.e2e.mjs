// Regression checks for the milestone 1.1 bug round: split view fits the window, "Go to page" lands on
// the page asked for, and navigation still works during a long search. BUG-1 (a new tab is active
// without a click) is covered in open.e2e.mjs. Bad-file messages by path are covered there too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, fixture, statusText, waitFor, waitForPage, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

async function openBig() {
  const s = await launch();
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([fixture('big-1000.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  return s;
}

async function goToPage(s, number) {
  const box = s.win.getByLabel('Page number');
  await box.click();
  await box.fill(String(number));
  await box.press('Enter');
}

const done = async (s) => {
  await s.close();
  cleanupProfile(s.profile);
};

test('split view keeps both panes inside the window (no horizontal overflow)', async () => {
  const s = await openBig();
  try {
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    await s.win.waitForTimeout(500);
    const layout = await s.win.evaluate(() => ({
      winWidth: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      appScrollWidth: document.querySelector('.app')?.scrollWidth ?? 0,
      appWidth: document.querySelector('.app')?.clientWidth ?? 0,
      paneRights: [...document.querySelectorAll('.pane-frame')].map((el) => el.getBoundingClientRect().right),
    }));
    console.log(`  split layout: ${JSON.stringify(layout)}`);
    assert.ok(layout.pageScrollWidth <= layout.winWidth, 'the page must not scroll sideways');
    assert.ok(layout.appScrollWidth <= layout.appWidth, 'the app frame must not overflow');
    assert.equal(layout.paneRights.length, 2);
    for (const right of layout.paneRights) assert.ok(right <= layout.winWidth + 0.5, `pane edge ${right} is past the window`);
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('Go to page 100 lands on "Page 100 of 1000", at default zoom and after zooming', async () => {
  const s = await openBig();
  try {
    await goToPage(s, 100);
    await waitForPage(s, 'Page 100 of 1000', { timeoutMs: 15000 });
    await s.win.waitForTimeout(600);
    assert.match(await statusText(s.win), /^Page 100 of 1000/, 'the status must not drift to the page before');

    await s.win.keyboard.press('Control+=');
    await s.win.waitForTimeout(300);
    await goToPage(s, 100);
    await waitForPage(s, 'Page 100 of 1000', { timeoutMs: 15000 });
    await s.win.waitForTimeout(600);
    assert.match(await statusText(s.win), /^Page 100 of 1000/, 'after zooming, the status must still read page 100');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('a page request made during a search scan is delivered without waiting for the scan', async () => {
  const s = await openBig();
  try {
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.waitFor({ timeout: 5000 });
    await find.fill('zephyrbloom');
    const started = performance.now();
    await goToPage(s, 500);
    await waitForPage(s, 'Page 500 of 1000', { timeoutMs: 5000 });
    const ms = Math.round(performance.now() - started);
    console.log(`  page request during search delivered in ${ms} ms`);
    assert.ok(ms < 5000);
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});
