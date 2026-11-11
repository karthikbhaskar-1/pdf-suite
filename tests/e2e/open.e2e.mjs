import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, fixture, statusText, waitFor, waitForPage, waitForOutcome, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

const tabList = (win) => win.getByRole('tab');

test('empty state at first launch shows drop zone, Open PDF and no errors', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state', { timeout: 15000 });
    assert.match(await s.win.locator('body').innerText(), /Drop a PDF here/);
    assert.ok(await s.win.getByRole('button', { name: 'Open PDF' }).isVisible());
    assert.equal(await statusText(s.win), 'No file open');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test('BUG-1 check: a freshly opened file is the active pane without any extra click', async () => {
  const s = await launch({ args: [fixture('mixed-sizes-rotated.pdf')] });
  try {
    await s.win.locator('.page-canvas').first().waitFor({ timeout: 30000 });
    await s.win.waitForTimeout(1500);
    // The zoom is the one Fit width gives on this window, so it is not a fixed number: the status must show a percentage,
    // and the page must fill the viewer width (less its side padding) to within 2 px.
    assert.match(await statusText(s.win), /^Page 1 of 8 · \d+%$/, 'status bar should show the open file and a zoom');
    const fit = await s.win.evaluate(() => {
      const page = document.querySelector('.page');
      let scroller = page?.parentElement;
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto' && getComputedStyle(scroller).overflowY !== 'scroll') scroller = scroller.parentElement;
      if (!page || !scroller) return null;
      const cs = getComputedStyle(scroller);
      const availW = scroller.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
      const availH = scroller.clientHeight - Number.parseFloat(cs.paddingTop) - Number.parseFloat(cs.paddingBottom);
      const r = page.getBoundingClientRect();
      return { w: r.width, h: r.height, availW, availH };
    });
    assert.ok(fit, 'the page and its scroll container are found');
    // The zoom is a fit mode (fit page on this window): the page sits inside the viewer and touches one edge within 2 px.
    assert.ok(fit.w <= fit.availW + 2 && fit.h <= fit.availH + 2, `page ${fit.w.toFixed(0)}x${fit.h.toFixed(0)} px fits the viewer ${fit.availW}x${fit.availH} px`);
    assert.ok(Math.abs(fit.w - fit.availW) <= 2 || Math.abs(fit.h - fit.availH) <= 2, `the page fills the viewer in one direction: ${fit.w.toFixed(0)}x${fit.h.toFixed(0)} px in ${fit.availW}x${fit.availH} px`);
    assert.equal(await s.win.getByRole('button', { name: 'Fit width' }).isDisabled(), false, 'Fit width should be enabled');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test('Ctrl+O opens a file chosen in the dialog and reaches "Page 1 of 1000"', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    const started = performance.now();
    await s.win.keyboard.press('Control+o');
    const ms = await waitForPage(s, 'Page 1 of 1000');
    console.log(`  measured: big-1000.pdf status "Page 1 of 1000" after ${Math.round(performance.now() - started)} ms (workarounds: ${s.workarounds.length})`);
    assert.equal(await tabList(s.win).count(), 1);
    assert.ok(ms >= 0);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test('Open PDF button opens a file from the dialog', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.getByRole('button', { name: 'Open PDF' }).click();
    await waitForPage(s, 'Page 1 of 8');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test('a PDF named on the command line opens at startup', async () => {
  const s = await launch({ args: [fixture('mixed-sizes-rotated.pdf')] });
  try {
    await waitForPage(s, 'Page 1 of 8');
    assert.equal(await tabList(s.win).count(), 1);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test('locked PDF: wrong password shows the spec message, right password opens it', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('locked.pdf')]);
    await s.win.keyboard.press('Control+o');
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    await dialog.waitFor({ timeout: 15000 });
    await dialog.getByLabel('Password').fill('wrong-pass');
    await dialog.getByRole('button', { name: 'Open' }).click();
    await s.win.getByText('Wrong password, try again.', { exact: true }).waitFor({ timeout: 15000 });
    assert.ok(await dialog.isVisible(), 'the prompt must stay open after a wrong password');
    await dialog.getByLabel('Password').fill('test123');
    await dialog.getByRole('button', { name: 'Open' }).click();
    await waitForPage(s, 'Page 1 of 1');
    await waitFor(async () => (await s.win.getByRole('dialog', { name: 'Password needed' }).count()) === 0, { timeoutMs: 5000, label: 'prompt closed' });
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test('locked PDF: Cancel closes the prompt and opens nothing', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('locked.pdf')]);
    await s.win.keyboard.press('Control+o');
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    await dialog.waitFor({ timeout: 15000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await dialog.count()) === 0, { timeoutMs: 5000, label: 'prompt closed' });
    await s.win.waitForTimeout(500);
    console.log(`  observed after cancel: tabs=${await tabList(s.win).count()} status=${JSON.stringify(await statusText(s.win))}`);
    assert.equal(await tabList(s.win).count(), 0, 'cancelling should not leave a tab behind');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

const badFiles = [
  ['truncated.pdf', 'This file is damaged.'],
  ['png-renamed.pdf', "This isn't a PDF."],
  ['empty.pdf', 'This file is empty.'],
];
for (const [name, message] of badFiles) {
  test(`bad file ${name} shows "${message}" inline in its tab`, async () => {
    const s = await launch({ args: [fixture(name)] });
    try {
      const outcome = await waitForOutcome(s, { timeoutMs: 20000 });
      console.log(`  ${name}: shown "${outcome.text ?? outcome.kind}"`);
      assert.equal(outcome.kind, 'message', 'expected an inline error');
      assert.equal(outcome.text, message);
      assert.equal(await s.win.getByRole('dialog').count(), 0, 'error must be inline, not a modal');
      assert.deepEqual(s.errors, [], 'unexpected console errors');
    } finally {
      await s.close();
    }
  });
}

// Files that are not PDFs are not dropped: each one opens a tab with the spec message, from the engine's check.
for (const name of ['notes.txt', 'picture.png']) {
  test(`${name} named on the command line opens a tab that says "This isn't a PDF."`, async () => {
    const s = await launch({ args: [fixture(name)] });
    try {
      const outcome = await waitForOutcome(s, { timeoutMs: 20000 });
      console.log(`  ${name}: shown "${outcome.text ?? outcome.kind}"`);
      assert.equal(outcome.kind, 'message', 'expected an inline message');
      assert.equal(outcome.text, "This isn't a PDF.");
      assert.equal(await s.win.getByRole('tab').count(), 1, 'the file gets its own tab');
      assert.equal(await s.win.getByRole('dialog').count(), 0, 'the message is inline, not a modal');
      assert.deepEqual(s.errors, [], 'unexpected console errors');
    } finally {
      await s.close();
    }
  });
}

test('notes.txt picked in the Open dialog opens a tab that says "This isn\'t a PDF."', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('notes.txt')]);
    await s.win.keyboard.press('Control+o');
    const outcome = await waitForOutcome(s, { timeoutMs: 20000 });
    assert.equal(outcome.kind, 'message');
    assert.equal(outcome.text, "This isn't a PDF.");
    assert.deepEqual(s.errors, [], 'unexpected console errors');
  } finally {
    await s.close();
  }
});

test('two tabs: Ctrl+Tab cycles, Ctrl+W closes, closing the last tab shows the empty state', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000');
    assert.equal(await tabList(s.win).count(), 2, 'expected 2 tabs');
    await s.win.keyboard.press('Control+Tab');
    await waitForPage(s, 'Page 1 of 8');
    await s.win.keyboard.press('Control+w');
    await waitFor(async () => (await tabList(s.win).count()) === 1, { label: 'one tab left' });
    await s.win.keyboard.press('Control+w');
    await s.win.waitForSelector('.empty-state');
    assert.equal(await statusText(s.win), 'No file open');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
