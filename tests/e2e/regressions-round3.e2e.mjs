// Regression checks for the review round: the main-process path grants, and the password dialog's
// focus trap, Escape and focus restore. The bitmap ownership and the page-index contract are covered
// by unit tests (usePageBitmap.test.ts, BitmapCanvas.test.tsx, engine/pageRef).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launch, fixture, waitForPage, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

test('the page cannot read or stat a PDF the user did not choose, and can read one that was opened', async () => {
  const s = await launch({ args: [fixture('mixed-sizes-rotated.pdf')] });
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-ungranted-'));
  const ungranted = join(dir, 'not-chosen.pdf');
  copyFileSync(fixture('mixed-sizes-rotated.pdf'), ungranted);
  try {
    await waitForPage(s, 'Page 1 of 8');
    const outcome = await s.win.evaluate(
      async ({ ungranted: other, granted, traversal }) => {
        const api = window.pdfSuite;
        const readOther = await api.files.read(other);
        const statOther = await api.files.stat(other);
        const readTraversal = await api.files.read(traversal);
        const readGranted = await api.files.read(granted);
        return {
          readOther: readOther.ok ? 'allowed' : readOther.reason,
          statOther,
          readTraversal: readTraversal.ok ? 'allowed' : readTraversal.reason,
          readGranted: readGranted.ok,
        };
      },
      {
        ungranted,
        granted: fixture('mixed-sizes-rotated.pdf'),
        // Walks up out of the fixture folder to another file that was never chosen.
        traversal: join(dirname(fixture('mixed-sizes-rotated.pdf')), '..', 'out', 'big-1000.pdf'),
      },
    );
    console.log(`  path grants: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.readOther, 'invalid-argument', 'an ungranted path must be refused');
    assert.equal(outcome.statOther, null, 'an ungranted path must not be stat-ed');
    assert.equal(outcome.readTraversal, 'invalid-argument', 'a path that resolves to an ungranted file must be refused');
    assert.equal(outcome.readGranted, true, 'the file the user opened must still be readable');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('password dialog: Tab stays inside it, the app behind is inert, Escape cancels and focus returns', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');

    const fit = s.win.getByRole('button', { name: 'Fit width' });
    await fit.focus();
    await s.setDialogAnswer([fixture('locked.pdf')]);
    await s.win.keyboard.press('Control+o');
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    await dialog.waitFor({ timeout: 15000 });

    assert.ok((await s.win.evaluate(() => document.querySelectorAll('.app > [inert]').length)) > 0, 'the app behind must be inert');
    for (let i = 0; i < 8; i++) {
      await s.win.keyboard.press('Tab');
      const inside = await s.win.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
      assert.ok(inside, `Tab press ${i + 1} must keep focus inside the dialog`);
    }

    await s.win.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await s.win.evaluate(() => document.querySelectorAll('.app > [inert]').length), 0, 'the app is active again');
    assert.equal(await fit.evaluate((el) => el === document.activeElement), true, 'focus returns to the control that had it');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});
