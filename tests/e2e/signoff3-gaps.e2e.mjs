// Sign-off round 3 gaps for 1.2.1 (the auditor's steps, reproduced in the packaged app, each checking the real outcome):
//  1. saving again after a failed save writes every edit (read-only file, a failed Save As, more edits, two failures);
//  2. File > Exit, Alt+F4 and the close button all ask Save / Don't save / Cancel;
//  3. Discard on the recovery bar leaves the viewer and thumbnails exactly as a fresh open of the file;
//  4. a cancelled auto-crop preview leaves nothing to redo;
//  5. the four Crop margin boxes are equally wide and readable;
//  6. Insert from a password-protected PDF asks for the password (wrong one is said so, Cancel leaves the document);
//  7. a key pressed while an edit runs is refused with a message, never dropped silently.
// Every test ends with its edits saved, discarded through a prompt, or dropped by the test-mode quit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  showPanel, launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, isDirty, assertNoErrors, assertNoErrorsAfterKill, waitFor,
  statusText, forceKill, cleanupProfile, delay, setSaveAnswer, palette, uids, lastScan, newProfileDir,
} from './matrix-lib.mjs';
import { inspectMupdf } from '../signoff3/inspect.mjs';

after(closeAll);

const OUTLINE = 'outline-6.pdf';
const MIXED = 'mixed-sizes-rotated.pdf';
const MARGINS = 'margins-white.pdf';
const LOCKED = 'locked.pdf'; // password test123
const LOCK_PASSWORD = 'test123';

const FAILED_SAVE_BASE = 'The file could not be saved. Check that it is not open in another program.';
/** For a document with changes, the message also says that they can no longer be undone. */
const UNDO_LOST = ' Your changes are kept and can be saved again, but they can no longer be undone.';
const FAILED_SAVE = FAILED_SAVE_BASE + UNDO_LOST;
const UNDO_REASON = 'Changes made before the save that failed are kept, but can no longer be undone.';

/** Records every toast the app shows from now on (toasts vanish after a few seconds). */
async function watchToasts(win) {
  await win.evaluate(() => {
    if (window.__gaps) return;
    window.__gaps = { toasts: [] };
    const seen = new WeakSet();
    const scan = () => {
      for (const el of document.querySelectorAll('.toast')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__gaps.toasts.push(el.querySelector('span')?.textContent ?? el.textContent ?? '');
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  });
}
const toasts = (win) => win.evaluate(() => [...(window.__gaps?.toasts ?? [])]);
async function toastAfter(win, action, timeoutMs = 20000) {
  const before = (await toasts(win)).length;
  await action();
  const r = await waitFor(async () => {
    const all = await toasts(win);
    return all.length > before ? all.slice(before) : null;
  }, { timeoutMs, label: 'a new toast' });
  return r.value.join(' | ');
}

/** Clicks through the in-page menu bar: menu(win, 'File', 'Exit') or menu(win, 'Pages', 'Crop Pages…'). */
async function menu(win, top, item) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  const exact = new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const row = win
    .locator('.menu-top > .menu-dropdown > .menu-item, .menu-top > .menu-dropdown > .menu-sub-wrap > .menu-item')
    .filter({ has: win.locator('.menu-label', { hasText: exact }) });
  await row.first().waitFor({ timeout: 5000 });
  await row.first().click();
}
/** Whether a top-level menu item is disabled (opens the menu, reads, closes it). */
async function menuItemDisabled(win, top, label) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  const items = await win
    .locator('.menu-top > .menu-dropdown > .menu-item')
    .evaluateAll((els) => els.map((el) => ({ label: el.querySelector('.menu-label')?.textContent ?? '', disabled: el.disabled })));
  await win.keyboard.press('Escape');
  const found = items.find((i) => i.label.startsWith(label));
  assert.ok(found, `menu item ${label} exists (${items.map((i) => i.label).join(', ')})`);
  return found.disabled;
}

/** The tooltip (title) of a top-level menu item. */
async function menuItemTitle(win, top, label) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  const items = await win
    .locator('.menu-top > .menu-dropdown > .menu-item')
    .evaluateAll((els) => els.map((el) => ({ label: el.querySelector('.menu-label')?.textContent ?? '', title: el.getAttribute('title') ?? '' })));
  await win.keyboard.press('Escape');
  return items.find((i) => i.label.startsWith(label))?.title;
}

const pagesAndRotations = (path) => {
  const d = inspectMupdf(path);
  return { count: d.count, text: d.pages.map((p) => `${p.text.replace('Outline page ', 'p')}${p.rotate ? `/r${p.rotate}` : ''}`) };
};
const recoveryFiles = (profile) => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : []);

// ------------------------------------------------------------------------------------------------ 1. failed save, then save

test('gap 1: duplicate, a failed save (read-only file), then Save writes the duplicate', async () => {
  const copy = copyOf(OUTLINE);
  const original = readFileSync(copy.path);
  const profile = newProfileDir();
  const s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    await waitForCount(s.win, 7);
    chmodSync(copy.path, 0o444);
    const failed = await toastAfter(s.win, () => s.win.keyboard.press('Control+s'));
    assert.equal(failed, FAILED_SAVE);
    assert.equal(await isDirty(s.win), true, 'a failed save leaves the document unsaved');
    // Undo stopped for the earlier changes, and the user is told why: Undo is off, with the reason as its tooltip.
    assert.equal(await menuItemDisabled(s.win, 'Edit', 'Undo'), true, 'Undo is off after the failed save');
    assert.equal(await menuItemTitle(s.win, 'Edit', 'Undo'), UNDO_REASON, 'the Undo item says why');
    assert.equal(await s.win.getByRole('button', { name: /^Undo/ }).first().getAttribute('data-tooltip'), UNDO_REASON, 'the toolbar Undo says why');
    assert.equal(await toastAfter(s.win, () => s.win.keyboard.press('Control+z')), UNDO_REASON, 'Ctrl+Z says why');
    assert.equal(await pageCount(s.win), 7, 'the window still shows 7 pages');
    await waitFor(async () => recoveryFiles(profile).length > 0, { timeoutMs: 10000, label: 'the recovery log' });
    assert.ok(recoveryFiles(profile).length > 0, 'the recovery log is kept after a failed save');
    chmodSync(copy.path, 0o666);
    assert.match(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), /^Saved /);
    await waitFor(async () => !(await isDirty(s.win)), { label: 'clean after the save' });
    const disk = pagesAndRotations(copy.path);
    assert.equal(disk.count, 7, `the file on disk has the duplicate: ${disk.text}`);
    assert.deepEqual(disk.text, ['p1', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    assert.ok(!readFileSync(copy.path).equals(original), 'the file is no longer the original');
    assert.equal(await pageCount(s.win), 7, 'the window still shows 7 pages after the save');
    assert.equal(recoveryFiles(profile).length, 0, 'the recovery log is gone only after the edits were written');
    assertNoErrors(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

test('gap 1: a failed save, more edits, then Save writes the earlier and the later edits', async () => {
  const copy = copyOf(OUTLINE);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    await waitForCount(s.win, 7);
    chmodSync(copy.path, 0o444);
    assert.equal(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), FAILED_SAVE);
    chmodSync(copy.path, 0o666);
    await jumpTo(s.win, 6);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
    assert.match(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), /^Saved /);
    await waitFor(async () => !(await isDirty(s.win)), { label: 'clean after the save' });
    const disk = pagesAndRotations(copy.path);
    assert.deepEqual(disk.text, ['p1/r90', 'p1/r90', 'p2', 'p3', 'p4', 'p5', 'p6/r90'], 'both rotations and the duplicate are on disk');
    assert.equal(await pageCount(s.win), 7);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('gap 1: two failed saves in a row, then Save', async () => {
  const copy = copyOf(OUTLINE);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    await waitForCount(s.win, 7);
    chmodSync(copy.path, 0o444);
    assert.equal(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), FAILED_SAVE);
    assert.equal(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), FAILED_SAVE);
    assert.equal(await isDirty(s.win), true);
    chmodSync(copy.path, 0o666);
    assert.match(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), /^Saved /);
    await waitFor(async () => !(await isDirty(s.win)), { label: 'clean after the save' });
    assert.equal(pagesAndRotations(copy.path).count, 7);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('gap 1: a failed Save As, then Save, writes the edits to the original file', async () => {
  const copy = copyOf(OUTLINE);
  const blocked = copyOf(OUTLINE);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    await waitForCount(s.win, 7);
    // The Save As target is an existing read-only file, so the write fails.
    chmodSync(blocked.path, 0o444);
    await setSaveAnswer(s, blocked.path);
    assert.equal(await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+S')), FAILED_SAVE);
    assert.equal(await isDirty(s.win), true, 'still unsaved after the failed Save As');
    assert.equal(pagesAndRotations(blocked.path).count, 6, 'the blocked file was not touched');
    assert.match(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), /^Saved /);
    await waitFor(async () => !(await isDirty(s.win)), { label: 'clean after the save' });
    assert.equal(pagesAndRotations(copy.path).count, 7, 'the original file has the duplicate');
    assert.equal(await pageCount(s.win), 7);
    assertNoErrors(s);
  } finally {
    await s.close();
    try {
      chmodSync(blocked.path, 0o666);
    } catch {
      /* gone */
    }
    removeCopy(copy);
    removeCopy(blocked);
  }
});

test('gap 1: a failed save followed by a delete of a page and a save writes the deletion too', async () => {
  const copy = copyOf(OUTLINE);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
    await waitForCount(s.win, 7);
    chmodSync(copy.path, 0o444);
    assert.equal(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), FAILED_SAVE);
    chmodSync(copy.path, 0o666);
    await jumpTo(s.win, 2);
    await toastAfter(s.win, () => s.win.keyboard.press('Delete'));
    await waitForCount(s.win, 6);
    assert.match(await toastAfter(s.win, () => s.win.keyboard.press('Control+s')), /^Saved /);
    await waitFor(async () => !(await isDirty(s.win)), { label: 'clean after the save' });
    assert.deepEqual(pagesAndRotations(copy.path).text, ['p1', 'p1', 'p3', 'p4', 'p5', 'p6']);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

// ------------------------------------------------------------------------------------------------ 2. every way out asks

const exited = (x) => x.gone === true;
async function startWithPrompts(profile) {
  const x = await launch({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
  x.proc = x.app.process();
  x.gone = false;
  x.proc.once('exit', () => {
    x.gone = true;
  });
  return x;
}
async function killTree(x) {
  if (x.gone) return;
  await new Promise((done) => {
    const killer = spawn('taskkill', ['/PID', String(x.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', () => done());
  });
}
const prompt = (win) => win.getByRole('alertdialog');

/** After a quit request: waits up to 4 s for the prompt or the exit. */
async function watchQuit(x) {
  const t0 = Date.now();
  let sawPrompt = false;
  while (Date.now() - t0 < 4000 && !exited(x)) {
    try {
      if ((await prompt(x.win).count()) > 0) {
        sawPrompt = true;
        break;
      }
    } catch {
      break;
    }
    await delay(100);
  }
  await delay(300);
  return { sawPrompt, exited: exited(x) };
}

test('gap 2: File > Exit, Alt+F4 and the close button each ask Save / Don\'t save / Cancel; Cancel keeps the edit', async () => {
  const copy = copyOf(OUTLINE);
  const original = readFileSync(copy.path);
  const profile = newProfileDir();
  const x = await startWithPrompts(profile);
  try {
    await x.win.waitForSelector('.empty-state');
    await open(x, copy.path, 6);
    await watchToasts(x.win);
    await jumpTo(x.win, 0);
    await toastAfter(x.win, () => x.win.keyboard.press('Delete'));
    await waitForCount(x.win, 5);
    const ways = {
      'File > Exit': () => menu(x.win, 'File', 'Exit'),
      'Alt+F4': () => x.win.keyboard.press('Alt+F4'),
      'the close button': () => x.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()),
    };
    for (const [name, quit] of Object.entries(ways)) {
      void quit().catch(() => undefined);
      const seen = await watchQuit(x);
      assert.equal(seen.exited, false, `${name}: the app must not quit without asking`);
      assert.equal(seen.sawPrompt, true, `${name}: asks Save / Don't save / Cancel`);
      assert.equal(await prompt(x.win).getByRole('button', { name: 'Save', exact: true }).count(), 1);
      assert.equal(await prompt(x.win).getByRole('button', { name: "Don't save", exact: true }).count(), 1);
      await prompt(x.win).getByRole('button', { name: 'Cancel', exact: true }).click();
      await delay(500);
      assert.equal(exited(x), false, `${name}: Cancel keeps the app open`);
      assert.equal(await pageCount(x.win), 5, `${name}: Cancel keeps the edit`);
      assert.equal(await isDirty(x.win), true, `${name}: Cancel keeps the document unsaved`);
    }
    assert.ok(readFileSync(copy.path).equals(original), 'the file on disk was not touched');
    // Finish through the prompt: File > Exit, Don't save.
    void menu(x.win, 'File', 'Exit').catch(() => undefined);
    await prompt(x.win).waitFor({ timeout: 10000 });
    await prompt(x.win).getByRole('button', { name: "Don't save", exact: true }).click();
    await waitFor(async () => exited(x), { timeoutMs: 15000, label: 'the app to exit after Don\'t save' });
    assert.ok(readFileSync(copy.path).equals(original), 'Don\'t save leaves the file as it was');
    assert.equal(recoveryFiles(profile).length, 0, "Don't save drops the recovery log");
  } finally {
    await killTree(x);
    await x.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

test('gap 2: File > Exit with Save writes the file and then quits', async () => {
  const copy = copyOf(OUTLINE);
  const profile = newProfileDir();
  const x = await startWithPrompts(profile);
  try {
    await x.win.waitForSelector('.empty-state');
    await open(x, copy.path, 6);
    await jumpTo(x.win, 0);
    await x.win.keyboard.press('Delete');
    await waitForCount(x.win, 5);
    void menu(x.win, 'File', 'Exit').catch(() => undefined);
    await prompt(x.win).waitFor({ timeout: 10000 });
    await prompt(x.win).getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(async () => exited(x), { timeoutMs: 20000, label: 'the app to exit after Save' });
    assert.equal(pagesAndRotations(copy.path).count, 5, 'the deletion was saved');
  } finally {
    await killTree(x);
    await x.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

test('gap 2: in test mode (no PDFSUITE_E2E_PROMPTS) File > Exit still quits silently, as docs/TESTING-RULES.md says', async () => {
  const copy = copyOf(OUTLINE);
  const original = readFileSync(copy.path);
  const profile = newProfileDir();
  const s = await launch({ profile });
  const proc = s.app.process();
  let gone = false;
  proc.once('exit', () => {
    gone = true;
  });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await jumpTo(s.win, 0);
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 5);
    void menu(s.win, 'File', 'Exit').catch(() => undefined);
    await waitFor(async () => gone, { timeoutMs: 15000, label: 'the silent quit' });
    assert.ok(readFileSync(copy.path).equals(original), 'the edit was discarded, not saved');
    assert.equal(recoveryFiles(profile).length, 0, 'the recovery log was dropped');
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

// ------------------------------------------------------------------------------------------------ 3. Discard shows the file

test('gap 3: after a crash and Discard the viewer and thumbnails are exactly a fresh open of the file', async () => {
  const copy = copyOf(MIXED);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-discard-'));
  const layout = async (win) => {
    const ids = await uids(win);
    return JSON.stringify({ ids, tops: (lastScan.tops ?? []).map((t) => Math.round(t)), h: Math.round(lastScan.scrollHeight ?? 0) });
  };
  let s = await launch({ profile });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await showPanel(s.win, 'Thumbnails');
    await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
    const fresh = await layout(s.win);
    await jumpTo(s.win, 0);
    await s.win.keyboard.press('Delete');
    await waitForCount(s.win, 7);
    await jumpTo(s.win, 1);
    await s.win.keyboard.press('Control+Shift+R');
    await delay(500);
    await jumpTo(s.win, 0);
    await s.win.keyboard.press('Control+d');
    await waitForCount(s.win, 8);
    await delay(1800);
    await forceKill(s.app);
    s = await launch({ profile });
    await waitFor(async () => (await statusText(s.win)).includes('of 8'), { timeoutMs: 30000, label: 'the restored tab' });
    await showPanel(s.win, 'Thumbnails');
    await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
    const bar = s.win.locator('.doc-bar', { hasText: 'Recovered unsaved edits' });
    await bar.waitFor({ timeout: 15000 });
    await bar.getByRole('button', { name: 'Discard' }).click();
    await waitFor(async () => (await bar.count()) === 0, { label: 'the recovery bar to go' });
    await delay(2500);
    assert.equal(await layout(s.win), fresh, 'thumbnails: the same pages, row positions and list height as a fresh open');
    // The viewer: every page is drawn in a slot of its own shape.
    const truth = inspectMupdf(copy.path).pages.map((p) => p.shown[0] / p.shown[1]);
    for (const index of [0, 1, 2, 3, 5, 7]) {
      await jumpTo(s.win, index);
      await delay(600);
      const box = await s.win.evaluate((i) => {
        const el = document.querySelector(`.page[data-page-index="${i}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }, index);
      assert.ok(box, `page ${index + 1} is in the viewer`);
      assert.ok(Math.abs(box.w / box.h - truth[index]) < 0.02, `page ${index + 1}: slot ${(box.w / box.h).toFixed(3)} should be ${truth[index].toFixed(3)}`);
    }
    assert.equal(await isDirty(s.win), false);
    assertNoErrorsAfterKill(s);
  } finally {
    await s.close();
    cleanupProfile(profile);
    removeCopy(copy);
  }
});

// ------------------------------------------------------------------------------------------------ 4 and 5. Crop sheet

async function openCropSheet(s) {
  await menu(s.win, 'Pages', 'Crop Pages…');
  const sheet = s.win.getByRole('dialog', { name: 'Crop pages' });
  await sheet.waitFor();
  return sheet;
}

test('gap 4: Cancel on the Crop sheet after Auto-crop leaves nothing to redo', async () => {
  const copy = copyOf(MARGINS);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    assert.equal(await menuItemDisabled(s.win, 'Edit', 'Redo'), true, 'no redo to start with');
    const sheet = await openCropSheet(s);
    await toastAfter(s.win, () => sheet.getByRole('button', { name: 'Auto-crop' }).click());
    assert.equal(await isDirty(s.win), true, 'the preview is an edit while the sheet is open');
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => !(await isDirty(s.win)), { label: 'the preview to be taken back' });
    assert.equal(await menuItemDisabled(s.win, 'Edit', 'Redo'), true, 'Redo is off: the cancelled preview is not a redo step');
    assert.equal(await menuItemDisabled(s.win, 'Edit', 'Undo'), true, 'Undo is off: the document is as it was');
    await s.win.keyboard.press('Control+y');
    await delay(500);
    assert.equal(await isDirty(s.win), false, 'Ctrl+Y does not bring the preview back');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

test('gap 5: the four Crop margin boxes are equally wide and readable at the default window size', async () => {
  const copy = copyOf(MARGINS);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    const sheet = await openCropSheet(s);
    const widths = {};
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) {
      const box = await sheet.getByLabel(`${edge} margin`).boundingBox();
      assert.ok(box, `${edge} box is shown`);
      widths[edge] = box.width;
    }
    const values = Object.values(widths);
    assert.ok(Math.min(...values) >= 60, `every box is at least 60 px wide: ${JSON.stringify(widths)}`);
    assert.ok(Math.max(...values) - Math.min(...values) <= 1, `all four are the same width: ${JSON.stringify(widths)}`);
    // A typed value is fully visible in the box.
    const top = sheet.getByLabel('Top margin');
    await top.fill('0.75');
    const clipped = await top.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(clipped, false, 'the typed value is not cut off');
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});

// ------------------------------------------------------------------------------------------------ 6. protected source

test('gap 6: Insert from a password-protected PDF asks for the password; wrong is said so; the right one inserts', async () => {
  const copy = copyOf(MARGINS);
  const locked = copyOf(LOCKED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await s.setDialogAnswer([locked.path]);
    await palette(s.win, 'Pages: Insert pages from a PDF…');
    const sheet = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
    await sheet.waitFor();
    await sheet.getByRole('button', { name: 'Browse for a PDF…' }).click();
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    await dialog.waitFor({ timeout: 20000 });
    await dialog.getByLabel('Password').fill('not-the-password');
    await dialog.getByRole('button', { name: 'Use password' }).click();
    const again = s.win.getByRole('dialog', { name: 'Password needed' });
    await again.getByText('Wrong password, try again.').waitFor({ timeout: 20000 });
    assert.equal(await pageCount(s.win), 2, 'a wrong password changes nothing');
    await again.getByLabel('Password').fill(LOCK_PASSWORD);
    await again.getByRole('button', { name: 'Use password' }).click();
    await again.waitFor({ state: 'detached', timeout: 20000 });
    // The sheet now lists the file; insert its pages.
    await sheet.getByText(/locked\.pdf, \d+ pages?/).waitFor({ timeout: 10000 });
    await sheet.getByLabel('Page range').fill('1');
    await sheet.getByRole('button', { name: 'Apply' }).click();
    await waitFor(async () => (await pageCount(s.win)) > 2, { timeoutMs: 20000, label: 'the pages of the protected file' });
    assert.equal(await isDirty(s.win), true);
    // The password is not in the recovery log or anywhere the page stores state.
    const stored = await s.win.evaluate(() => JSON.stringify({ local: { ...localStorage } }));
    assert.ok(!stored.includes(LOCK_PASSWORD), 'the password is not in local storage');
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
    removeCopy(locked);
  }
});

test('gap 6: Cancel on the password prompt leaves the document alone', async () => {
  const copy = copyOf(MARGINS);
  const locked = copyOf(LOCKED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 2);
    await s.setDialogAnswer([locked.path]);
    await palette(s.win, 'Pages: Insert pages from a PDF…');
    const sheet = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
    await sheet.waitFor();
    await sheet.getByRole('button', { name: 'Browse for a PDF…' }).click();
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    await dialog.waitFor({ timeout: 20000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await pageCount(s.win), 2);
    assert.equal(await isDirty(s.win), false, 'the document is untouched');
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
    removeCopy(locked);
  }
});

// ------------------------------------------------------------------------------------------------ 7. fast repeated presses

test('gap 7: Ctrl+D pressed fast is either done or refused with a message, never dropped silently', async () => {
  const copy = copyOf(OUTLINE);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 6);
    await watchToasts(s.win);
    await jumpTo(s.win, 0);
    const PRESSES = 6;
    const before = (await toasts(s.win)).length;
    for (let i = 0; i < PRESSES; i++) await s.win.keyboard.press('Control+d');
    await waitFor(async () => (await toasts(s.win)).length - before >= PRESSES, { timeoutMs: 20000, label: 'one answer per press' });
    await delay(800);
    const answers = (await toasts(s.win)).slice(before);
    const done = answers.filter((t) => t === 'Duplicated 1 page').length;
    const refused = answers.filter((t) => t === 'Wait for the current change to finish.').length;
    assert.equal(done + refused, PRESSES, `every press got an answer: ${answers.join(' | ')}`);
    assert.ok(done >= 1, 'at least the first press was done');
    await waitForCount(s.win, 6 + done);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});
