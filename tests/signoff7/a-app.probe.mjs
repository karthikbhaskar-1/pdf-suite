// Sign-Off 7 (ticket 1.3.1), app-level probes on the built app. Run:  node tests/signoff7/a-app.probe.mjs [filter]
//  A  a page next to a /Pages node that carries /Rotate or /CropBox: Cut and Duplicate, then Save, then the file on disk
//  B  which pages a command acts on: selection and page box after cut + undo + save; a sheet left open across a Save; split view
//  C  cut -> Save As -> more edits -> force-kill -> relaunch -> Keep: the replayed document equals the one that was lost
//  D  quick pass over the sheet against the UI spec
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeAll, forceKill, cleanupProfile, open, palette, waitForCount, saveNow, isDirty, delay, pageCount, currentPage, statusText, waitFor, uids,
  clickRowByIndex, setSaveAnswer, showPanel,
  newFile, copyTo, wipe, report, readPages, expectedImages, compare, planAll, planOnly, VERT, HORZ, openSheet, setOptions, sheetOf, summaryOf, sub,
  start, FX, selectedIdx, currentIdx, sizesOnDisk,
} from './lib7.mjs';

const R = report('a-app');
const ONLY = process.argv[2];
const realStep = R.step;
R.step = (label, fn) => (!ONLY || label.startsWith(ONLY) ? realStep(label, fn) : Promise.resolve());
const fx = (name) => join(FX, name);

async function session(file, pages, body, options) {
  const s = await start(options);
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, file.path, pages);
    await body(s);
    const errs = s.errors.filter((e) => !/favicon/.test(e));
    if (errs.length) R.say(`INFO  app errors: ${errs.slice(0, 3).join(' | ').slice(0, 300)}`);
  } finally {
    await s.close();
  }
}
async function cut(s, opts, after) {
  const sheet = await openSheet(s, palette);
  await setOptions(sheet, opts);
  await sheet.getByRole('button', { name: 'Apply' }).click();
  await sheetOf(s.win).waitFor({ state: 'detached', timeout: 30000 });
  if (after !== undefined) await waitForCount(s.win, after);
}
const key = (s, k) => s.win.keyboard.press(k);
const state = async (win) => `selected [${await selectedIdx(win)}] current ${await currentIdx(win)} box ${await currentPage(win)} of ${await pageCount(win)}`;

// ---------------- A. A neighbouring /Pages node that carries /Rotate or /CropBox ----------------
for (const [name, pages, wide] of [['boundary-rotate.pdf', 4, 3], ['boundary-crop.pdf', 3, 2], ['flat5.pdf', 5, 5]]) {
  await R.step(`A1 ${name}: Cut the pages before the section -> Save -> file on disk`, async () => {
    const f = copyTo(fx(name), name);
    const o = readPages(f.path);
    R.say(`INFO  ${name} before: ${o.map((p) => `${p.w}x${p.h}`).join(' ')}`);
    await session(f, pages, async (s) => {
      // The pages before the section are cut: they are selected (click the first, Shift-click the last), scope Selected pages.
      await clickRowByIndex(s.win, 0);
      if (wide > 1) await clickRowByIndex(s.win, wide - 1, ['Shift']);
      await cut(s, { scope: wide > 1 ? 'selected' : 'current' }, pages + wide);
      await saveNow(s.win);
      const exp = expectedImages(o, Array.from({ length: pages }, (_u, i) => (i < wide ? VERT : null)));
      const { problems } = compare(f.path, exp);
      R.say(`INFO  ${name} on disk after cut+save: ${sizesOnDisk(f.path)}  (expected ${exp.map((p) => `${p.w}x${p.h}`).join(' ')})`);
      R.check(`${name}: every half on disk is the half of its page`, problems.length === 0, problems.join('; '));
    });
  });
  await R.step(`A2 ${name}: Duplicate the last wide page -> Save -> file on disk`, async () => {
    const f = copyTo(fx(name), name);
    const o = readPages(f.path);
    await session(f, pages, async (s) => {
      await clickRowByIndex(s.win, wide - 1);
      await palette(s.win, 'Pages: Duplicate');
      await waitForCount(s.win, pages + 1);
      await saveNow(s.win);
      const exp = o.map((p, i) => ({ ...p, label: `p${i + 1}` }));
      exp.splice(wide, 0, { ...o[wide - 1], label: `copy of p${wide}` });
      const { problems } = compare(f.path, exp);
      R.say(`INFO  ${name} on disk after duplicate+save: ${sizesOnDisk(f.path)}  (expected ${exp.map((p) => `${p.w}x${p.h}`).join(' ')})`);
      R.check(`${name}: the copy on disk looks like the page it was copied from`, problems.length === 0, problems.join('; '));
    });
  });
}

// ---------------- B. Which pages a command acts on ----------------
await R.step('B1 cut current -> save: selection and page box stay on the same pages; Delete removes the highlighted page', async () => {
  const f = copyTo(fx('flat5.pdf'), 'b1.pdf');
  const o = readPages(f.path);
  await session(f, 5, async (s) => {
    await clickRowByIndex(s.win, 2);
    R.say(`INFO  after click on page 3: ${await state(s.win)}`);
    await cut(s, { scope: 'current' }, 6);
    const afterCut = await state(s.win);
    await saveNow(s.win);
    await delay(600);
    const afterSave = await state(s.win);
    R.check('cut + save: selection, current thumbnail and page box unchanged by the save', afterCut === afterSave, `${afterCut}  ->  ${afterSave}`);
    const sel = await selectedIdx(s.win);
    const cur = await currentIdx(s.win);
    const target = sel.length ? sel : [cur];
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 6 - target.length);
    await saveNow(s.win);
    const exp = expectedImages(o, planOnly(5, [2], VERT)).filter((_p, i) => !target.includes(i + 1));
    const { problems } = compare(f.path, exp);
    R.check(`Delete after cut+save removed the highlighted page(s) [${target}] and nothing else`, problems.length === 0, problems.join('; '));
  });
});
await R.step('B2 cut -> undo -> redo -> undo -> rotate -> save: the rotate lands on the page that is highlighted', async () => {
  const f = copyTo(fx('flat5.pdf'), 'b2.pdf');
  const o = readPages(f.path);
  await session(f, 5, async (s) => {
    await clickRowByIndex(s.win, 3);
    const before = await state(s.win);
    await cut(s, { scope: 'current' }, 6);
    await key(s, 'Control+z');
    await waitForCount(s.win, 5);
    const undone = await state(s.win);
    R.check('cut + undo: selection, current thumbnail and page box are back on page 4', before === undone, `${before}  ->  ${undone}`);
    await key(s, 'Control+y');
    await waitForCount(s.win, 6);
    await key(s, 'Control+z');
    await waitForCount(s.win, 5);
    const again = await state(s.win);
    R.check('redo + undo: still page 4', before === again, `${before}  ->  ${again}`);
    R.check('after the undo the document is not marked unsaved', !(await isDirty(s.win)));
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'rotate applied' });
    await saveNow(s.win);
    const sizes = readPages(f.path).map((p) => `${p.w}x${p.h}`);
    R.check('on disk: only page 4 is turned', sizes.join(' ') === '800x500 800x500 800x500 500x800 800x500', sizes.join(' '));
    // Cut all, undo, save (nothing to save), then cut all again and save: 10 right halves.
    await cut(s, { scope: 'all' }, 10);
    await saveNow(s.win);
    const after = await state(s.win);
    R.say(`INFO  after cut all + save: ${after}`);
    R.check('cut all + save: 10 pages on disk', readPages(f.path).length === 10);
    void o;
  });
});
await R.step('B3 a Rotate sheet left open across a Save acts on the page it was opened for', async () => {
  const f = copyTo(fx('flat5.pdf'), 'b3.pdf');
  const o = readPages(f.path);
  await session(f, 5, async (s) => {
    await cut(s, { scope: 'all', order: 'right' }, 10);
    await clickRowByIndex(s.win, 3);
    await palette(s.win, 'Pages: Rotate by a custom angle…');
    const sheet = s.win.getByRole('dialog', { name: 'Rotate pages' });
    await sheet.waitFor({ timeout: 10000 });
    await sheet.getByRole('button', { name: 'Right 90°' }).click();
    await key(s, 'Control+s');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 20000, label: 'saved with the sheet open' });
    await delay(500);
    const open = (await sheet.count()) > 0;
    R.say(`INFO  Rotate sheet still open after the save: ${open}; ${await state(s.win)}`);
    if (open) {
      R.say(`INFO  sheet summary: ${(await sheet.locator('.side-summary').innerText().catch(() => '')).trim()}`);
      await sheet.getByRole('button', { name: 'Apply' }).click();
      await sheet.waitFor({ state: 'detached', timeout: 20000 });
      await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'rotate applied' });
    }
    await saveNow(s.win);
    const sizes = readPages(f.path).map((p) => `${p.w}x${p.h}`);
    const want = Array.from({ length: 10 }, (_u, i) => (open && i === 3 ? '500x400' : '400x500'));
    R.check('on disk: exactly the 4th page is turned (or none, when the sheet closed)', sizes.join(' ') === want.join(' '), sizes.join(' '));
    // The same with the Crop sheet on page 7 and the Delete confirmation on pages 8-10... (6 of 10 is the confirm limit)
    await clickRowByIndex(s.win, 6);
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'dirty again' });
    await clickRowByIndex(s.win, 0);
    await clickRowByIndex(s.win, 5, ['Shift']);
    const selBefore = await selectedIdx(s.win);
    await palette(s.win, 'Pages: Delete');
    const confirm = s.win.getByRole('dialog', { name: 'Delete pages?' });
    await confirm.waitFor({ timeout: 10000 });
    await key(s, 'Control+s');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 20000, label: 'saved with the confirm open' });
    await delay(500);
    const stillOpen = (await confirm.count()) > 0;
    R.say(`INFO  Delete confirmation still open after the save: ${stillOpen}; selected before [${selBefore}], now ${await state(s.win)}`);
    if (stillOpen) {
      await confirm.getByRole('button', { name: /^Delete 6 pages$/ }).click();
      await waitForCount(s.win, 4);
    }
    await saveNow(s.win);
    const saved = readPages(f.path);
    const exp = expectedImages(o, planAll(5, { cut: 'vertical', at: 0.5, first: 'right' }));
    // Page 4 and page 7 are turned: compare sizes only for those, pixels for the rest.
    const left = stillOpen ? exp.slice(6) : exp;
    const sizesNow = saved.map((p) => `${p.w}x${p.h}`).join(' ');
    R.check('on disk: pages 1-6 are the ones deleted (7 turned, 8-10 as they were)', stillOpen ? sizesNow === '500x400 400x500 400x500 400x500' : saved.length === 10, sizesNow);
    if (stillOpen) {
      const { problems } = compare(f.path, [saved[0], ...left.slice(1)]);
      R.check('on disk: pages 8, 9 and 10 are the last three halves', problems.length === 0, problems.join('; '));
    }
  });
});
await R.step('B4 a Crop sheet left open across a Save crops the page it was opened for', async () => {
  const f = copyTo(fx('flat5.pdf'), 'b4.pdf');
  await session(f, 5, async (s) => {
    await cut(s, { scope: 'all' }, 10);
    await clickRowByIndex(s.win, 4);
    await palette(s.win, 'Pages: Crop…');
    const sheet = s.win.getByRole('dialog', { name: 'Crop pages' });
    await sheet.waitFor({ timeout: 10000 });
    await sheet.getByLabel('Apply to').selectOption('current');
    await sheet.getByLabel('Units').selectOption({ index: 0 });
    const unit = await sheet.getByLabel('Units').inputValue();
    await sheet.getByLabel('Top margin').fill('1');
    await sheet.getByLabel('Top margin').press('Tab');
    await key(s, 'Control+s');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 20000, label: 'saved with the crop sheet open' });
    await delay(500);
    const open = (await sheet.count()) > 0;
    R.say(`INFO  Crop sheet still open after the save: ${open} (unit ${unit}); ${await state(s.win)}`);
    if (open) {
      await sheet.getByRole('button', { name: 'Apply' }).click();
      await sheet.waitFor({ state: 'detached', timeout: 20000 });
      await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'crop applied' });
      await saveNow(s.win);
    }
    const sizes = readPages(f.path).map((p) => `${p.w}x${p.h}`);
    const changed = sizes.flatMap((v, i) => (v === '400x500' ? [] : [i + 1]));
    R.check('on disk: only the 5th page is cropped (or none, when the sheet closed)', open ? changed.join() === '5' : changed.length === 0, sizes.join(' '));
  });
});
await R.step('B5 split view: a cut of the current page acts on the active pane\'s page', async () => {
  const f = copyTo(fx('flat5.pdf'), 'b5.pdf');
  const o = readPages(f.path);
  await session(f, 5, async (s) => {
    await palette(s.win, 'Split vertical');
    await delay(800);
    const panes = await s.win.locator('.pane, [data-pane-id]').count();
    R.say(`INFO  panes after Split vertical: ${panes}; ${await state(s.win)}`);
    // The active pane goes to page 4 through the status bar's page box.
    const box = s.win.locator('#status-page-box');
    await box.fill('4');
    await box.press('Enter');
    await waitFor(async () => (await currentPage(s.win)) === 4, { timeoutMs: 10000, label: 'page box 4' });
    await cut(s, { scope: 'current' }, 6);
    R.say(`INFO  after cut in the active pane: ${await state(s.win)}`);
    await palette(s.win, 'Switch pane');
    await delay(600);
    const other = await currentPage(s.win);
    R.say(`INFO  after Switch pane: ${await state(s.win)}`);
    await cut(s, { scope: 'current', direction: 'horizontal' }, 7);
    await saveNow(s.win);
    // Expected: page 4 cut left/right; then the other pane's page (index other-1 in the 6-page list) cut top/bottom.
    const first = expectedImages(o, planOnly(5, [3], VERT));
    const exp = [];
    first.forEach((img, i) => {
      if (i !== other - 1) exp.push(img);
      else exp.push({ ...sub(img, [0, 0, img.w, img.h / 2]), label: `${img.label} top` }, { ...sub(img, [0, img.h / 2, img.w, img.h]), label: `${img.label} bottom` });
    });
    const { problems } = compare(f.path, exp);
    R.check(`split view: page 4 was cut from the first pane, page ${other} from the other pane; file on disk agrees`, problems.length === 0, `${sizesOnDisk(f.path)} :: ${problems.join('; ')}`);
  });
});

// ---------------- C. Cut -> Save As -> more edits -> crash -> replay ----------------
await R.step('C1 cut all -> Save As -> cut one half again -> delete a page -> kill -> relaunch -> Keep -> save', async () => {
  const f = copyTo(fx('flat5.pdf'), 'c1.pdf');
  const target = newFile('c1-saved-as.pdf');
  const original = readFileSync(f.path);
  const o = readPages(f.path);
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-so7-'));
  try {
    let s = await start({ profile });
    await s.win.waitForSelector('.empty-state');
    await open(s, f.path, 5);
    await cut(s, { scope: 'all' }, 10);
    await setSaveAnswer(s, target.path);
    await key(s, 'Control+Shift+s');
    await waitFor(() => existsSync(target.path) && readFileSync(target.path).length > 100, { timeoutMs: 20000, label: 'Save As wrote the file' });
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 20000, label: 'clean after Save As' });
    const tenBytes = readFileSync(target.path);
    R.check('Save As wrote the 10 halves', compare(target.path, expectedImages(o, planAll(5, VERT))).problems.length === 0);
    R.check('the first file is unchanged by Save As', readFileSync(f.path).equals(original));
    await clickRowByIndex(s.win, 1);
    await cut(s, { scope: 'current', direction: 'horizontal' }, 11);
    await clickRowByIndex(s.win, 7);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 10);
    await clickRowByIndex(s.win, 4);
    const lost = { ids: await uids(s.win), state: await state(s.win) };
    await delay(2000); // the recovery log is written a moment after each edit
    await forceKill(s.app);
    R.check('at the crash the Save As file still holds the 10 halves', readFileSync(target.path).equals(tenBytes));
    s = await start({ profile });
    try {
      const bar = s.win.getByText(/Recovered unsaved edits/);
      await s.win.waitForSelector('.empty-state', { timeout: 20000 }).catch(() => undefined);
      try {
        await bar.waitFor({ timeout: 20000 });
      } catch {
        await s.setDialogAnswer([target.path]);
        await key(s, 'Control+o');
        await bar.waitFor({ timeout: 30000 });
      }
      await showPanel(s.win, 'Thumbnails');
      await s.win.getByRole('button', { name: 'Keep', exact: true }).click();
      await waitForCount(s.win, 10);
      const now = await uids(s.win);
      R.check('replay: the same pages with the same ids as before the crash', JSON.stringify(now) === JSON.stringify(lost.ids), `${lost.ids} -> ${now}`);
      R.check('replay did not touch either file', readFileSync(target.path).equals(tenBytes) && readFileSync(f.path).equals(original));
      R.check('the recovered edits count as unsaved', await isDirty(s.win));
      await key(s, 'Control+z');
      await waitForCount(s.win, 11);
      await key(s, 'Control+y');
      await waitForCount(s.win, 10);
      await saveNow(s.win);
      const ten = expectedImages(o, planAll(5, VERT));
      const exp = [];
      ten.forEach((img, i) => {
        if (i !== 1) exp.push(img);
        else exp.push({ ...sub(img, [0, 0, img.w, img.h / 2]), label: 'p1b top' }, { ...sub(img, [0, img.h / 2, img.w, img.h]), label: 'p1b bottom' });
      });
      exp.splice(7, 1);
      const { problems } = compare(target.path, exp);
      R.check('after Keep + Save the Save As file is the document that was lost in the crash', problems.length === 0, `${sizesOnDisk(target.path)} :: ${problems.join('; ')}`);
      R.check('the first file was never written', readFileSync(f.path).equals(original));
    } finally {
      await s.close();
    }
  } finally {
    cleanupProfile(profile);
  }
});

// ---------------- D. Quick spec pass ----------------
await R.step('D1 entry points and sheet against the UI spec', async () => {
  const f = copyTo(fx('flat5.pdf'), 'd1.pdf');
  await session(f, 5, async (s) => {
    const win = s.win;
    // Menu
    await win.getByRole('menubar').getByRole('menuitem', { name: 'Pages', exact: true }).click();
    const dd = win.locator('.menu-dropdown').last();
    await dd.waitFor({ timeout: 5000 });
    const items = (await dd.locator('[role="menuitem"], [role="separator"], hr, .menu-separator').evaluateAll((els) => els.map((e) => (e.getAttribute('role') === 'menuitem' ? e.innerText.replace(/\s+/g, ' ').trim() : '---'))));
    R.say(`INFO  Pages menu: ${items.join(' | ')}`);
    R.check('Pages menu has "Cut Pages in Half…"', items.some((t) => t.startsWith('Cut Pages in Half…')));
    await win.keyboard.press('Escape');
    // Toolbar
    const tool = win.getByRole('button', { name: 'Cut pages in half' });
    R.check('toolbar has a "Cut pages in half" button', (await tool.count()) > 0, `count ${await tool.count()}`);
    // Thumbnail right-click
    const uid = (await uids(win))[1];
    await win.locator(`.thumb[data-uid="${uid}"]`).click({ button: 'right' });
    const ctx = win.locator('[role="menu"]').last();
    await ctx.waitFor({ timeout: 5000 });
    const ctxItems = await ctx.locator('[role="menuitem"]').allInnerTexts();
    R.check('thumbnail right-click has the Cut item', ctxItems.some((t) => /Cut pages in half/i.test(t)), ctxItems.join(' | ').replace(/\s+/g, ' '));
    await win.keyboard.press('Escape');
    // Sheet
    const sheet = await openSheet(s, palette);
    const focus = await win.evaluate(() => { const a = document.activeElement; return `${a?.getAttribute('role') ?? a?.tagName} ${a?.getAttribute('aria-label') ?? a?.textContent ?? ''}`.trim(); });
    R.check('focus on open is in "Cut into"', /Left and right|Cut into/.test(focus), focus);
    R.check('defaults: Left and right, 50, Left page first, All pages', (await sheet.getByRole('radio', { name: 'Left and right' }).getAttribute('aria-checked')) === 'true'
      && (await sheet.getByLabel('Cut position in percent').inputValue()) === '50'
      && (await sheet.getByRole('radio', { name: 'Left page first' }).getAttribute('aria-checked')) === 'true'
      && (await sheet.getByLabel('Apply to').inputValue()) === 'all', `${await sheet.getByLabel('Cut position in percent').inputValue()} / ${await sheet.getByLabel('Apply to').inputValue()}`);
    const options = await sheet.getByLabel('Apply to').locator('option').allInnerTexts();
    R.check('Apply to offers Current page, Selected pages, All pages, Wide pages only', options.join('|') === 'Current page|Selected pages|All pages|Wide pages only', options.join('|'));
    R.check('summary text', (await summaryOf(sheet)).replace(/\s+/g, ' ').trim() === 'Cuts 5 pages into 10. Comments and links stay with their half.', await summaryOf(sheet));
    R.check('hint for right-to-left books is shown', (await sheet.getByText('Choose Right page first for books read right to left.').count()) === 1);
    R.check('a Center button exists', (await sheet.getByRole('button', { name: 'Center' }).count()) === 1);
    R.check('slider label', (await sheet.getByLabel('Cut position, percent of the page width').count()) === 1);
    await sheet.getByRole('radio', { name: 'Top and bottom' }).click();
    R.check('Top and bottom hides Page order and offers Tall pages only', (await sheet.getByRole('radio', { name: 'Left page first' }).count()) === 0 && (await sheet.getByLabel('Apply to').locator('option').allInnerTexts()).includes('Tall pages only'));
    await sheet.getByLabel('Apply to').selectOption('wide');
    const none = (await sheet.innerText()).includes('No pages match. Choose a different “Apply to”.');
    R.check('no match: message shown and Apply off', none && (await sheet.getByRole('button', { name: 'Apply' }).isDisabled()));
    await sheet.getByRole('radio', { name: 'Left and right' }).click();
    await sheet.getByLabel('Apply to').selectOption('all');
    await sheet.getByLabel('Cut position in percent').fill('80');
    await sheet.getByLabel('Cut position in percent').press('Tab');
    R.check('80 %: "Enter a number from 30 to 70." and Apply off', (await sheet.innerText()).includes('Enter a number from 30 to 70.') && (await sheet.getByRole('button', { name: 'Apply' }).isDisabled()));
    await sheet.getByRole('button', { name: 'Center' }).click();
    R.check('Center puts 50 back', (await sheet.getByLabel('Cut position in percent').inputValue()) === '50');
    R.check('the viewer shows the cut guide before Apply and the document is unchanged', (await win.locator('.cut-guide, [data-cut-guide]').count()) > 0 && (await pageCount(win)) === 5 && !(await isDirty(win)), `guides ${await win.locator('.cut-guide, [data-cut-guide]').count()}`);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    R.check('Cancel leaves 5 pages and a clean document', (await pageCount(win)) === 5 && !(await isDirty(win)));
    // Two selected pages: the default scope is Selected pages.
    await clickRowByIndex(win, 1);
    await clickRowByIndex(win, 2, ['Shift']);
    const sheet2 = await openSheet(s, palette);
    R.check('with 2 pages selected the default is Selected pages', (await sheet2.getByLabel('Apply to').inputValue()) === 'selected', await summaryOf(sheet2));
    await sheet2.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(win, 7);
    const toast = (await win.locator('.toast, [role="status"]').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
    R.check('toast "Cut 2 pages in half" with Undo', /Cut 2 pages in half/.test(toast) && /Undo/.test(toast), toast.slice(0, 200));
    await win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const edit = win.locator('.menu-dropdown').last();
    await edit.waitFor({ timeout: 5000 });
    const undoText = (await edit.locator('[role="menuitem"]').first().innerText()).replace(/\s+/g, ' ').trim();
    R.check('Edit menu: "Undo Cut 2 pages in half"', undoText.startsWith('Undo Cut 2 pages in half'), undoText);
    await win.keyboard.press('Escape');
    await key(s, 'Control+z');
    await waitForCount(win, 5);
    R.check('one undo takes the whole cut back and the document is clean', !(await isDirty(win)));
  });
});

const failed = R.summary();
await closeAll();
wipe();
process.exit(failed ? 1 : 0);
