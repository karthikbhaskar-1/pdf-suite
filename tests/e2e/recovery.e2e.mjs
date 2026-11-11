// Crash recovery (force-kill, relaunch) and single-instance file forwarding.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, fixture, statusText, waitFor, waitForPage, forceKill, runSecondInstance, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

const tabs = (win) => win.getByRole('tab');

test('force-kill then relaunch restores tabs, page, zoom, split, and shows "Restored 2 tabs"', async () => {
  const s = await launch();
  const profile = s.profile;
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000');
    assert.equal(await tabs(s.win).count(), 2);

    // Page 500 and zoom 150% in the big file, then split the view.
    const box = s.win.getByLabel('Page number');
    await box.click();
    await box.fill('500');
    await box.press('Enter');
    await waitForPage(s, 'Page 500 of 1000');
    for (let i = 0; i < 2; i++) await s.win.keyboard.press('Control+=');
    await s.win.waitForTimeout(400);
    const beforeKill = await statusText(s.win);
    await s.win.keyboard.press('Control+\\');
    await s.win.locator('.split').first().waitFor({ timeout: 10000 });
    await s.win.waitForTimeout(3000); // let the session snapshot write
    const beforeSplit = await s.win.locator('.pane-frame').count();
    console.log(`  before kill: status ${JSON.stringify(beforeKill)}, panes ${beforeSplit}`);

    await forceKill(s.app);
    await waitFor(async () => s.app.process().exitCode !== null || s.app.process().signalCode !== null, { timeoutMs: 15000, label: 'app exit after kill' }).catch(() => undefined);
    console.log('  app killed');

    const r = await launch({ profile });
    try {
      const toast = r.win.locator('.toast').filter({ hasText: /Restored \d+ tabs?/ });
      await toast.first().waitFor({ timeout: 20000 });
      const toastText = (await toast.first().innerText()).trim();
      console.log(`  toast after relaunch: ${JSON.stringify(toastText)}`);
      assert.equal(toastText, 'Restored 2 tabs');
      assert.equal(await tabs(r.win).count(), 2, 'both tabs should come back');
      // Make the big tab active if it is not, then check page and zoom.
      await tabs(r.win).filter({ hasText: 'big-1000.pdf' }).click();
      await waitForPage(r, 'Page 500 of 1000', { timeoutMs: 30000 }).catch(async (e) => {
        console.log(`  restored status: ${JSON.stringify(await statusText(r.win))}`);
        throw e;
      });
      const restored = await statusText(r.win);
      console.log(`  restored status: ${JSON.stringify(restored)} (before kill ${JSON.stringify(beforeKill)})`);
      assert.equal(restored, beforeKill, 'page and zoom should match the state before the kill');
      const panes = await r.win.locator('.pane-frame').count();
      console.log(`  restored panes: ${panes}`);
      assert.equal(panes, beforeSplit, 'split view should come back');
      assert.deepEqual(r.errors, []);
    } finally {
      await r.close();
    }
    assert.deepEqual(s.errors.filter((e) => !/Target closed|crashed/.test(e)), []);
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(profile);
  }
});

test('second launch with a PDF path opens a new tab in the first window and exits', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    const windowsBefore = s.app.windows().length;

    const second = await runSecondInstance([fixture('big-1000.pdf')], s.profile);
    console.log(`  second instance exit code ${second.code}; windows before ${windowsBefore}`);
    assert.equal(second.code, 0, `second launch should exit cleanly: ${second.out.slice(0, 300)}`);

    await waitFor(async () => (await tabs(s.win).count()) === 2, { timeoutMs: 20000, label: 'second tab from second launch' });
    await tabs(s.win).filter({ hasText: 'big-1000.pdf' }).waitFor();
    assert.equal(s.app.windows().length, windowsBefore, 'no second window should open');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});
