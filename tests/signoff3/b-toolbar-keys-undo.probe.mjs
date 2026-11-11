// Probe B: the same operations from the top bar, the thumbnail icon row, the right-click menus, the keyboard and a
// mouse drag; then a full undo chain back to the start, a full redo chain forward, redo truncation, save and disk check.
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, pageCount, fixture, waitFor, delay, setSaveAnswer,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspectMupdf, plainEnglish, toasts, isDirty, clickRowByIndex, snapshot, palette,
} from './lib.mjs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const R = makeReport('b-toolbar-keys-undo');
const copy = copyOf('outline-6.pdf');
const outDir = mkdtempSync(join(tmpdir(), 'pdfsuite-so3-'));
let s;
const snaps = [];
const labels = [];

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, copy.path, 6);
  await watchToasts(win);
  snaps.push(await snapshot(win));
  const topbar = win.locator('.tb-group[aria-label="Pages"]');
  const thumbBar = win.locator('.thumb-toolbar');

  /** Runs one edit, waits for its toast, and records the snapshot after it. */
  const edit = async (label, action, expectToast) => {
    await R.step(label, async () => {
      const t = await toastAfter(win, action);
      await delay(150);
      const snap = await snapshot(win);
      const changed = snap !== snaps.at(-1);
      snaps.push(snap);
      labels.push(label);
      R.check(`${label}: toast "${t}"`, expectToast.test(t) && plainEnglish(t), t);
      R.info(`${label}: order ${JSON.parse(snap).ids.join(',')}${changed ? '' : ' (list unchanged)'}`);
    });
  };

  // --- Top bar
  await jumpTo(win, 0);
  await edit('topbar Insert ▸ Blank page', async () => {
    await topbar.locator('summary', { hasText: 'Insert' }).click();
    await topbar.getByRole('menuitem', { name: 'Blank page…' }).click();
    await sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click();
  }, /Inserted 1 blank page/);
  await jumpTo(win, 2);
  await edit('topbar Rotate (right 90)', () => topbar.getByRole('button', { name: 'Rotate right 90°' }).click(), /Rotated 1 page/);
  await edit('topbar Rotate ▾ Left 90°', async () => {
    await topbar.locator('summary[aria-label="More rotation options"]').click();
    await topbar.getByRole('menuitem', { name: 'Left 90°' }).click();
  }, /Rotated 1 page/);
  await edit('topbar Rotate ▾ 180°', async () => {
    await topbar.locator('summary[aria-label="More rotation options"]').click();
    await topbar.getByRole('menuitem', { name: '180°', exact: true }).click();
  }, /Rotated 1 page/);
  await edit('topbar Rotate ▾ Custom angle (slider to -7.5)', async () => {
    await topbar.locator('summary[aria-label="More rotation options"]').click();
    await topbar.getByRole('menuitem', { name: 'Custom angle…' }).click();
    const d = sheet(win, 'Rotate pages');
    await d.getByRole('slider', { name: 'Rotation angle' }).fill('-7.5');
    const says = await d.locator('.side-summary').innerText();
    R.check('rotate slider drives the summary', /by -7\.5°/.test(says), says);
    await d.getByRole('button', { name: 'Apply' }).click();
  }, /Rotated 1 page/);
  await jumpTo(win, 3);
  await edit('topbar Crop ▸ Auto-crop', async () => {
    await topbar.locator('summary', { hasText: 'Crop' }).click();
    await topbar.getByRole('menuitem', { name: 'Auto-crop' }).click();
  }, /Auto-cropped 1 page/);

  await R.step('topbar Crop ▸ Crop pages…: drag a handle, then Cancel changes nothing', async () => {
    await jumpTo(win, 4);
    const before = await snapshot(win);
    const undoBefore = (await menuItems(win, 'Edit'))[0].label;
    await topbar.locator('summary', { hasText: 'Crop' }).click();
    await topbar.getByRole('menuitem', { name: 'Crop pages…' }).click();
    const d = sheet(win, 'Crop pages');
    await d.getByRole('combobox', { name: 'Units' }).selectOption('pt');
    const handle = win.locator('.crop-handle').first();
    const b = await handle.boundingBox();
    await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await win.mouse.down();
    await win.mouse.move(b.x + 60, b.y + 80, { steps: 6 });
    await win.mouse.up();
    const margins = await d.getByRole('spinbutton').evaluateAll((els) => els.map((e) => Number(e.value)));
    R.check('dragging a crop handle fills the margin boxes', margins.some((m) => m > 5), JSON.stringify(margins));
    await shot(win, 'b-crop-drag');
    await win.keyboard.press('Escape');
    await waitFor(async () => (await sheet(win, 'Crop pages').count()) === 0, { timeoutMs: 5000, label: 'sheet closed by Esc' });
    await delay(300);
    R.check('Esc on the crop sheet leaves the document as it was', (await snapshot(win)) === before);
    R.check('Esc on the crop sheet adds no undo step', (await menuItems(win, 'Edit'))[0].label === undoBefore);
  });

  await R.step('Crop sheet: Auto-crop preview, then Cancel, undoes only the preview', async () => {
    await jumpTo(win, 4);
    const before = await snapshot(win);
    const undoBefore = (await menuItems(win, 'Edit'))[0].label;
    await palette(win, 'Pages: Crop…');
    const d = sheet(win, 'Crop pages');
    await d.getByRole('button', { name: 'Auto-crop' }).click();
    await d.getByText('Auto-crop applied. Cancel undoes it.').waitFor({ timeout: 15000 });
    R.check('auto-crop preview changed the page', (await snapshot(win)) !== before);
    await d.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await snapshot(win)) === before, { timeoutMs: 10000, label: 'preview undone' });
    await delay(300);
    const undoAfter = (await menuItems(win, 'Edit'))[0].label;
    R.check('after Cancel the undo step is the one from before the preview', undoAfter === undoBefore, `${undoBefore} -> ${undoAfter}`);
    // The cancelled preview must not leave a redo step that a later Ctrl+Y would bring back... record what Redo says.
    R.info(`Redo after cancelled preview: "${(await menuItems(win, 'Edit'))[1].label}" disabled=${(await menuItems(win, 'Edit'))[1].disabled}`);
  });

  await edit('topbar Page size ▸ Letter, Center, all pages', async () => {
    await win.keyboard.press('Escape');
    await topbar.getByRole('button', { name: 'Page size' }).click();
    const d = sheet(win, 'Page size');
    await d.getByRole('radio', { name: 'Letter' }).click();
    await d.getByRole('radio', { name: 'Center' }).click();
    await d.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
    await d.getByRole('button', { name: 'Apply' }).click();
  }, /Resized 7 pages/);
  await jumpTo(win, 5);
  await edit('topbar More ▸ Duplicate', async () => {
    await topbar.locator('summary', { hasText: 'More' }).click();
    await topbar.getByRole('menuitem', { name: 'Duplicate' }).click();
  }, /Duplicated 1 page/);
  await edit('topbar More ▸ Replace…', async () => {
    await topbar.locator('summary', { hasText: 'More' }).click();
    await topbar.getByRole('menuitem', { name: 'Replace…' }).click();
    const d = sheet(win, 'Replace page');
    await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
    await d.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await d.getByText('mixed-sizes-rotated.pdf, 8 pages').waitFor({ timeout: 15000 });
    await d.getByRole('spinbutton', { name: 'Page in the PDF' }).fill('5');
    await d.getByRole('button', { name: 'Apply' }).click();
  }, /Replaced the page/);
  await edit('topbar More ▸ Reverse (two selected pages)', async () => {
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 1, ['Control']);
    await topbar.locator('summary', { hasText: 'More' }).click();
    await topbar.getByRole('menuitem', { name: 'Reverse' }).click();
  }, /Reversed 2 pages/);
  await R.step('topbar More ▸ Extract…', async () => {
    const target = join(outDir, 'tb-extract.pdf');
    await setSaveAnswer(s, target);
    await jumpTo(win, 2);
    const t = await toastAfter(win, async () => {
      await topbar.locator('summary', { hasText: 'More' }).click();
      await topbar.getByRole('menuitem', { name: 'Extract…' }).click();
    });
    const x = inspectMupdf(target);
    R.check('topbar extract wrote a valid 1-page PDF', /Extracted 1 page/.test(t) && x.ok && x.count === 1, `${t} ${JSON.stringify(x.pages)}`);
  });
  await jumpTo(win, 1);
  await edit('topbar Delete', () => topbar.getByRole('button', { name: 'Delete pages' }).click(), /Deleted 1 page/);

  // --- Thumbnail icon row
  await jumpTo(win, 0);
  await edit('thumb row Insert', async () => {
    await thumbBar.getByRole('button', { name: 'Insert a blank page' }).click();
    await sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click();
  }, /Inserted 1 blank page/);
  await jumpTo(win, 1);
  await edit('thumb row Rotate', () => thumbBar.getByRole('button', { name: 'Rotate right 90°' }).click(), /Rotated 1 page/);
  await edit('thumb row Delete', () => thumbBar.getByRole('button', { name: 'Delete pages' }).click(), /Deleted 1 page/);
  await jumpTo(win, 3);
  await edit('thumb row More ▸ Duplicate', async () => {
    await thumbBar.locator('summary').click();
    await thumbBar.getByRole('menuitem', { name: 'Duplicate' }).click();
  }, /Duplicated 1 page/);
  await edit('thumb row More ▸ Reverse (nothing selected: all)', async () => {
    // Deselect: a Ctrl+click on the selected row removes it from the selection.
    const sel = win.locator('.thumb-selected');
    while ((await sel.count()) > 0) await sel.first().click({ modifiers: ['Control'] });
    await thumbBar.locator('summary').click();
    await thumbBar.getByRole('menuitem', { name: 'Reverse' }).click();
  }, /Reversed all \d+ pages/);
  await R.step('thumb row Extract', async () => {
    const target = join(outDir, 'thumb-extract.pdf');
    await setSaveAnswer(s, target);
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 2, ['Shift']);
    const t = await toastAfter(win, () => thumbBar.getByRole('button', { name: 'Extract pages to a new PDF' }).click());
    const x = inspectMupdf(target);
    R.check('thumb row extract wrote a valid 3-page PDF', /Extracted 3 pages/.test(t) && x.ok && x.count === 3, `${t} count ${x.count}`);
  });

  // --- Right-click menus
  await R.step('thumbnail right-click menu lists the spec items', async () => {
    await win.locator('.thumb').nth(1).click({ button: 'right' });
    const items = await win.locator('.context-menu .context-item').allInnerTexts();
    const want = ['Insert blank page…', 'Insert pages from a PDF…', 'Duplicate', 'Replace…', 'Rotate right 90°', 'Crop…', 'Extract…', 'Delete'];
    R.check('thumbnail context menu items', want.every((w) => items.some((i) => i.trim() === w)), JSON.stringify(items));
    await win.keyboard.press('Escape');
  });
  await R.step('right-click inside a selection acts on the whole selection (3 pages)', async () => {
    R.check('three rows are selected', (await win.locator('.thumb-selected').count()) === 3);
    await win.locator('.thumb').nth(1).click({ button: 'right' });
    const t = await toastAfter(win, () => win.locator('.context-menu').getByRole('menuitem', { name: 'Rotate right 90°' }).click());
    R.check('rotate from the menu turned the 3 selected pages', /Rotated 3 pages/.test(t), t);
    await win.keyboard.press('Control+z');
    await delay(600);
  });
  // A plain click selects one page; a right-click on another, unselected page then acts on that page alone.
  await jumpTo(win, 5);
  await edit('thumbnail right-click ▸ Duplicate', async () => {
    await win.locator('.thumb').nth(1).click({ button: 'right' });
    await win.locator('.context-menu').getByRole('menuitem', { name: 'Duplicate' }).click();
  }, /Duplicated 1 page/);
  await edit('thumbnail right-click ▸ Rotate right 90°', async () => {
    await win.locator('.thumb').nth(0).click({ button: 'right' });
    await win.locator('.context-menu').getByRole('menuitem', { name: 'Rotate right 90°' }).click();
  }, /Rotated 1 page/);
  await edit('thumbnail right-click ▸ Delete', async () => {
    await win.locator('.thumb').nth(2).click({ button: 'right' });
    await win.locator('.context-menu').getByRole('menuitem', { name: 'Delete', exact: true }).click();
  }, /Deleted 1 page/);
  await R.step('page right-click ▸ Pages submenu', async () => {
    await win.locator('.page-canvas').first().click({ button: 'right', force: true });
    const group = win.locator('.context-menu').getByRole('menuitem', { name: /^Pages/ });
    R.check('page context menu has a Pages submenu', (await group.count()) === 1, (await win.locator('.context-menu .context-item').allInnerTexts()).join(' | '));
    await group.click();
    const sub = await win.locator('.context-menu .context-sub .context-item').allInnerTexts();
    R.check('Pages submenu has the organizer items', ['Duplicate', 'Delete', 'Extract…'].every((w) => sub.some((i) => i.trim() === w)), JSON.stringify(sub));
    await win.keyboard.press('Escape');
    if ((await win.locator('.context-menu').count()) > 0) await win.mouse.click(5, 300);
  });

  // --- Keyboard
  await jumpTo(win, 0);
  await edit('Ctrl+D duplicates', () => win.keyboard.press('Control+d'), /Duplicated 1 page/);
  await edit('Ctrl+Shift+R rotates right', () => win.keyboard.press('Control+Shift+R'), /Rotated 1 page/);
  await edit('Ctrl+Shift+L rotates left', () => win.keyboard.press('Control+Shift+L'), /Rotated 1 page/);
  await edit('Alt+Down moves the page down', () => win.keyboard.press('Alt+ArrowDown'), /Moved 1 page/);
  await edit('Alt+End moves it to the end', () => win.keyboard.press('Alt+End'), /Moved 1 page/);
  await edit('Alt+Up moves it up', () => win.keyboard.press('Alt+ArrowUp'), /Moved 1 page/);
  await edit('Alt+Home moves it to the start', () => win.keyboard.press('Alt+Home'), /Moved 1 page/);
  await edit('Delete key deletes', () => win.keyboard.press('Delete'), /Deleted 1 page/);
  R.check('menu bar is not left open or focused after Alt chords', (await win.locator('.menu-dropdown').count()) === 0 && (await win.locator('.menu-button-on').count()) === 0);

  // --- Mouse drag
  await R.step('drag one page down two places', async () => {
    const before = JSON.parse(await snapshot(win)).ids;
    const t = await toastAfter(win, () => win.locator('.thumb').nth(0).dragTo(win.locator('.thumb').nth(2), { targetPosition: { x: 60, y: 4 } }));
    const snap = await snapshot(win);
    snaps.push(snap);
    labels.push('drag 1 page');
    const after = JSON.parse(snap).ids;
    const want = [before[1], before[0], ...before.slice(2)];
    R.check('drag: page 1 dropped before page 3', /Moved 1 page/.test(t) && after.join() === want.join(), `${before.join()} -> ${after.join()}`);
  });
  await R.step('drag two selected pages (Ctrl+click) to the top, as a block', async () => {
    const before = JSON.parse(await snapshot(win)).ids;
    await clickRowByIndex(win, 1);
    await clickRowByIndex(win, 3, ['Control']);
    const t = await toastAfter(win, () => win.locator('.thumb').nth(3).dragTo(win.locator('.thumb').nth(0), { targetPosition: { x: 60, y: 4 } }));
    const snap = await snapshot(win);
    snaps.push(snap);
    labels.push('drag 2 pages');
    const after = JSON.parse(snap).ids;
    const want = [before[1], before[3], before[0], before[2], ...before.slice(4)];
    R.check('drag: the two picked pages lead the list in their order', /Moved 2 pages/.test(t) && after.join() === want.join(), `${before.join()} -> ${after.join()}`);
  });
  await R.step('a drag that ends where it started is not an edit', async () => {
    const undoBefore = (await menuItems(win, 'Edit'))[0].label;
    await win.locator('.thumb').nth(0).click();
    await win.locator('.thumb').nth(0).dragTo(win.locator('.thumb').nth(1), { targetPosition: { x: 60, y: 4 } });
    await delay(500);
    R.check('no-op drag adds no undo step', (await menuItems(win, 'Edit'))[0].label === undoBefore && (await snapshot(win)) === snaps.at(-1));
  });

  // --- Undo chain back to the very start, by every route
  R.info(`edits made: ${labels.length}`);
  await R.step('undo every step: each state equals the snapshot taken before it', async () => {
    let bad = 0;
    for (let i = snaps.length - 2; i >= 0; i--) {
      const route = i % 3;
      const menuLabel = (await menuItems(win, 'Edit'))[0];
      if (menuLabel.disabled) {
        R.check(`undo available for step ${i + 1} (${labels[i]})`, false, 'Undo is disabled early');
        bad++;
        break;
      }
      if (route === 0) await win.keyboard.press('Control+z');
      else if (route === 1) await menu(win, 'Edit', menuLabel.label);
      else await win.locator('.tb-button[aria-label^="Undo"]').first().click();
      try {
        await waitFor(async () => (await snapshot(win)) === snaps[i], { timeoutMs: 8000, label: `state before "${labels[i]}"` });
      } catch {
        bad++;
        R.check(`undo of "${labels[i]}" (step ${i + 1}) restores the earlier state`, false, `\n have ${await snapshot(win)}\n want ${snaps[i]}`);
      }
    }
    R.check(`undo chain: all ${snaps.length - 1} steps restore their earlier state`, bad === 0, `${bad} mismatches`);
    const edits = await menuItems(win, 'Edit');
    R.check('at the start: Undo is disabled and the document is clean', edits[0].disabled && !(await isDirty(win)), `undo "${edits[0].label}" disabled=${edits[0].disabled} dirty=${await isDirty(win)}`);
  });
  await R.step('redo every step: each state equals the snapshot taken after it', async () => {
    let bad = 0;
    for (let i = 1; i < snaps.length; i++) {
      await win.keyboard.press(i % 2 ? 'Control+y' : 'Control+Shift+Z');
      try {
        await waitFor(async () => (await snapshot(win)) === snaps[i], { timeoutMs: 8000, label: `state after "${labels[i - 1]}"` });
      } catch {
        bad++;
        R.check(`redo of "${labels[i - 1]}" (step ${i}) gives the later state`, false, `\n have ${await snapshot(win)}\n want ${snaps[i]}`);
      }
    }
    R.check(`redo chain: all ${snaps.length - 1} steps`, bad === 0, `${bad} mismatches`);
    const edits = await menuItems(win, 'Edit');
    R.check('at the end: Redo is disabled, document unsaved', edits[1].disabled && (await isDirty(win)), `redo "${edits[1].label}"`);
  });
  await R.step('a new edit after two undos drops the redo steps', async () => {
    await win.keyboard.press('Control+z');
    await waitFor(async () => (await snapshot(win)) === snaps.at(-2), { timeoutMs: 8000, label: 'one undo' });
    await win.keyboard.press('Control+z');
    await waitFor(async () => (await snapshot(win)) === snaps.at(-3), { timeoutMs: 8000, label: 'two undos' });
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    const edits = await menuItems(win, 'Edit');
    R.check('Redo is disabled after a new edit', edits[1].disabled, edits[1].label);
    R.check('Undo names the new edit', /Undo Duplicate/.test(edits[0].label), edits[0].label);
  });
  await R.step('toast Undo button undoes the edit', async () => {
    const before = await snapshot(win);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await win.locator('.toast-action', { hasText: 'Undo' }).last().click();
    await waitFor(async () => (await snapshot(win)) === before, { timeoutMs: 8000, label: 'toast undo' });
    R.check('toast Undo restored the state', true);
  });

  // --- Save and compare with the disk
  await R.step('save, then the disk file matches the page list and keeps the bookmarks on their pages', async () => {
    const order = JSON.parse(await snapshot(win)).ids;
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    R.check('Ctrl+S toast', /Saved outline-6\.pdf/.test(t), t);
    const d = inspectMupdf(copy.path);
    R.check('disk: valid, same page count as the app', d.ok && d.eof && d.count === order.length, `${d.count} vs ${order.length}`);
    const wrong = order.map((uid, i) => (/^\d+$/.test(uid) && !d.pages[i].text.includes(`Outline page ${Number(uid) + 1}`) && !d.pages[i].text.includes('Small square') ? `${i + 1}:${uid}:"${d.pages[i].text}"` : null)).filter(Boolean);
    R.info('disk pages: ' + JSON.stringify(d.pages.map((p) => [p.text, p.shown, p.rotate])));
    R.info('app order: ' + order.join(','));
    R.check('disk: original pages sit where the app shows them', wrong.length <= 1, wrong.join(' ; '));
    R.info('disk outline: ' + JSON.stringify(d.outline));
    const stale = (d.outline ?? []).filter((o) => typeof o.page === 'number' && o.page >= 1 && d.pages[o.page - 1] && !d.pages[o.page - 1].text.includes(`Outline page ${{ Intro: 2, Middle: 4, End: 6 }[o.title]}`));
    R.check('disk: every bookmark still points at its own page (or was removed with it)', stale.length === 0, JSON.stringify(stale));
    R.check('after save the undo history is reset', (await menuItems(win, 'Edit'))[0].disabled);
  });

  const all = await toasts(win);
  R.check('every toast is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'b-failure');
} finally {
  await closeAll();
  removeCopy(copy);
  rmSync(outDir, { recursive: true, force: true });
  process.exitCode = R.summary() ? 1 : 0;
}
