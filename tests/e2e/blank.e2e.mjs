// "Blank clicks": with no document open, every top-bar control, rail icon and palette command runs without a crash.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

test('no document open: click every top-bar button and rail icon, run every palette command, nothing crashes', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    const clicked = [];
    const skipped = [];

    // Top bar and rail controls. Each is read by its visible text or label, then clicked fresh.
    const controls = s.win.locator('.tb-group button, .tb-group summary, .tb-group select, .rail button, .rail summary');
    const count = await controls.count();
    for (let i = 0; i < count; i++) {
      const el = controls.nth(i);
      const label = ((await el.getAttribute('aria-label')) ?? (await el.innerText().catch(() => ''))).trim() || `#${i}`;
      if (!(await el.isVisible().catch(() => false))) {
        skipped.push(`${label} (hidden)`);
        continue;
      }
      if (await el.isDisabled().catch(() => false)) {
        skipped.push(`${label} (disabled)`);
        continue;
      }
      if ((await el.evaluate((node) => node.tagName)) === 'SELECT') {
        clicked.push(label + ' (select, skipped)');
        continue;
      }
      await el.click({ timeout: 5000 }).catch((e) => skipped.push(`${label} (click failed: ${e.message.split('\n')[0]})`));
      clicked.push(label);
      await s.win.keyboard.press('Escape').catch(() => undefined);
      await s.win.waitForTimeout(120);
    }
    // Close any dialog a click opened (for example the Open dialog, which is stubbed to cancel).
    await s.win.keyboard.press('Escape').catch(() => undefined);
    console.log(`  clicked ${clicked.length} controls: ${clicked.join(', ')}`);
    console.log(`  skipped ${skipped.length}: ${skipped.join(', ')}`);

    // Every command in the palette, one at a time, with an empty document.
    await s.win.keyboard.press('Control+k');
    const palette = s.win.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor({ timeout: 5000 });
    // Commands that end the app are tested on their own (see the Exit test): they are not run in this loop.
    const all = await palette.getByRole('option').allInnerTexts();
    const names = all.filter((n) => !/^\s*(Exit|Quit)\b/i.test(n));
    await s.win.keyboard.press('Escape');
    console.log(`  palette lists ${all.length} commands, ${names.length} run here (Exit excluded)`);

    const ran = [];
    for (let i = 0; i < all.length; i++) {
      if (/^\s*(Exit|Quit)\b/i.test(all[i])) continue; // ends the app: tested on its own
      await s.win.keyboard.press('Control+k');
      await palette.waitFor({ timeout: 5000 });
      for (let k = 0; k < i; k++) await s.win.keyboard.press('ArrowDown');
      await s.win.keyboard.press('Enter');
      ran.push(all[i].trim().split('\n')[0]);
      await s.win.waitForTimeout(120);
      await s.win.keyboard.press('Escape').catch(() => undefined);
    }
    console.log(`  ran palette commands: ${ran.join(' | ')}`);

    assert.equal(s.win.isClosed(), false, 'window must still be open');
    assert.equal(await s.win.locator('.empty-state').count(), 1, 'empty state should still show after blank clicks');
    assert.deepEqual(s.errors, [], 'no console or page errors during blank clicks');
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('Exit from the palette quits the app cleanly, with no prompt in E2E mode, and leaves no window', async () => {
  const s = await launch();
  const proc = s.app.process(); // taken now: Playwright does not return it after the app exits
  try {
    await s.win.waitForSelector('.empty-state');
    await s.win.keyboard.press('Control+k');
    const palette = s.win.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor({ timeout: 5000 });
    await palette.getByPlaceholder('Type a command').fill('Exit');
    // The app quits on Enter, so the window may close under this press.
    await s.win.keyboard.press('Enter').catch(() => undefined);
    const started = Date.now();
    while (proc.exitCode === null && Date.now() - started < 10000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notEqual(proc.exitCode, null, 'the app process exits within 10 s');
    // The app exited within 10 s, so no close prompt was waiting for an answer (the prompt would block the exit).
    assert.equal(s.win.isClosed(), true, 'the window is closed');
    // Electron prints "Waiting for the debugger to disconnect..." when a launched process exits. That is not an error.
    assert.deepEqual(s.errors.filter((e) => !/Waiting for the debugger to disconnect/.test(e)), []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});
