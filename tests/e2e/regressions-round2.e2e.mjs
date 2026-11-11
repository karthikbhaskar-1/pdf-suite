// Regression checks for bug-fix round 2 in the packaged app: Copy path, Open in split on a background
// tab, a restored file that was deleted between sessions, and quick relaunch / force-kill restores.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, fixture, statusText, waitFor, waitForPage, waitForOutcome, forceKill, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

const tabs = (win) => win.getByRole('tab');

const done = async (s) => {
  await s.close();
  cleanupProfile(s.profile);
};

test('Copy path from a tab puts the file path on the clipboard, with no error toast', async () => {
  const s = await launch({ args: [fixture('mixed-sizes-rotated.pdf')] });
  try {
    await waitForPage(s, 'Page 1 of 8');
    await s.app.evaluate(({ clipboard }) => clipboard.writeText(''));

    await tabs(s.win).first().click({ button: 'right' });
    await s.win.getByText('Copy path', { exact: true }).click();

    await waitFor(
      async () => (await s.app.evaluate(({ clipboard }) => clipboard.readText())) === fixture('mixed-sizes-rotated.pdf'),
      { timeoutMs: 10000, label: 'path on the clipboard' },
    );
    assert.equal(await s.win.locator('.toast', { hasText: 'The path could not be copied.' }).count(), 0, 'no failure toast on success');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('Open in split on a background tab activates that tab, so the status bar matches the viewer', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });

    // Make the small file the active tab, so the big one is in the background.
    await tabs(s.win).filter({ hasText: 'mixed-sizes-rotated.pdf' }).click();
    await waitForPage(s, 'Page 1 of 8');

    await tabs(s.win).filter({ hasText: 'big-1000.pdf' }).click({ button: 'right' });
    await s.win.getByText('Open in split', { exact: true }).click();

    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 1000'), { timeoutMs: 15000, label: 'status shows the split file' });
    assert.equal(await s.win.locator('.tab-active', { hasText: 'big-1000.pdf' }).count(), 1, 'the split tab is the active tab');
    assert.equal(await s.win.locator('.pane-frame.pane-active').count(), 1, 'one pane is focused');
    assert.deepEqual(s.errors, []);
  } finally {
    await done(s);
  }
});

test('a file deleted between sessions stays as a tab with "This file was moved, renamed or deleted." through relaunches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-gone-'));
  const copy = join(dir, 'vanishing.pdf');
  copyFileSync(fixture('mixed-sizes-rotated.pdf'), copy);
  const first = await launch({ args: [copy] });
  const profile = first.profile;
  try {
    await waitForPage(first, 'Page 1 of 8');
  } finally {
    await first.close();
  }
  unlinkSync(copy);

  try {
    for (let round = 1; round <= 2; round++) {
      const again = await launch({ profile });
      try {
        const outcome = await waitForOutcome(again, { timeoutMs: 30000 });
        assert.equal(await tabs(again.win).count(), 1, `round ${round}: the tab must come back`);
        assert.equal(outcome.kind, 'message', `round ${round}: an inline message is expected`);
        assert.equal(outcome.text, 'This file was moved, renamed or deleted.', `round ${round}: message`);
        assert.deepEqual(again.errors, []);
      } finally {
        await again.close();
      }
    }
  } finally {
    cleanupProfile(profile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a normal close followed by an immediate relaunch restores the tab', async () => {
  const s = await launch();
  const profile = s.profile;
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    await s.close(); // no pause: the quit itself must make the session current
  } finally {
    // The relaunch below is the check.
  }

  const r = await launch({ profile });
  try {
    await waitForPage(r, 'Page 1 of 8', { timeoutMs: 30000 });
    assert.equal(await tabs(r.win).count(), 1, 'the tab must come back after a quick relaunch');
    assert.deepEqual(r.errors, []);
  } finally {
    await r.close();
    cleanupProfile(profile);
  }
});

test('a force-kill right after a file opens still restores that file on relaunch', async () => {
  const s = await launch();
  const profile = s.profile;
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 8');
    await forceKill(s.app);
    await waitFor(async () => s.app.process().exitCode !== null || s.app.process().signalCode !== null, { timeoutMs: 15000, label: 'app exit after kill' }).catch(() => undefined);
  } finally {
    // The relaunch below is the check.
  }

  const r = await launch({ profile });
  try {
    await waitForPage(r, 'Page 1 of 8', { timeoutMs: 30000 });
    assert.equal(await tabs(r.win).count(), 1, 'the tab must come back after a force-kill');
  } finally {
    await r.close();
    cleanupProfile(profile);
  }
});
