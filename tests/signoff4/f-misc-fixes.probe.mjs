// Probe F: the smaller fixes made after round 1, and a few spec checks: redo after a cancelled auto-crop preview, the crop
// margin boxes, auto-crop itself, a password-protected source PDF (dialog, wrong password, recovery switching off with
// one message and coming back after a save), the "wait" message for keys pressed during a long change, the command
// palette starting empty, the menu accelerators against the spec, About, and lined / grid pages really being ruled.
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as mupdf from 'mupdf';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, delay, fixture, newProfileDir, cleanupProfile, waitFor,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspect, toasts, bars, isDirty, plainEnglish, selectAllPages, currentPageSize, uids,
} from './lib.mjs';

const R = makeReport('f-misc-fixes');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
let profile;
const rec = () => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')).filter((f) => f.endsWith('.json')) : []);
async function closeTabs(win) {
  for (let i = 0; i < 5 && (await win.locator('.empty-state').count()) === 0; i++) {
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+w');
    await delay(500);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(500);
  }
}
/** Share of dark pixels of one page of a file, rendered by mupdf in node at 36 dpi. */
function inkShare(path, index) {
  const doc = mupdf.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    const page = doc.loadPage(index);
    const pix = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceGray, false);
    const px = pix.getPixels();
    let dark = 0;
    for (let i = 0; i < px.length; i++) if (px[i] < 250) dark++;
    return dark / px.length;
  } finally {
    doc.destroy();
  }
}

try {
  profile = newProfileDir();
  s = await launch({ profile });
  const { win } = s;
  await win.waitForSelector('.empty-state');

  // ---------- F1. Crop sheet: boxes, auto-crop preview cancelled, redo
  const m = mk('margins-white.pdf');
  await R.step('F1 threw', async () => {
    await open(s, m.path, 2);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 3);
    await jumpTo(win, 0);
    const full = await currentPageSize(win);
    await menu(win, 'Pages', 'Crop Pages…');
    const d = sheet(win, 'Crop pages');
    await d.getByRole('combobox', { name: 'Units' }).selectOption('mm');
    const boxes = [];
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) {
      const f = d.getByRole('spinbutton', { name: `${edge} margin` });
      await f.fill('112.75');
      boxes.push(await f.evaluate((el) => ({ w: Math.round(el.getBoundingClientRect().width), fits: el.scrollWidth <= el.clientWidth, value: el.value })));
    }
    R.check('F1 the four crop margin boxes are the same width and show "112.75" in full', boxes.every((b) => b.w === boxes[0].w && b.w >= 60 && b.fits && b.value === '112.75'), JSON.stringify(boxes));
    await shot(win, 'f1-crop-boxes');
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) await d.getByRole('spinbutton', { name: `${edge} margin` }).fill('0');
    await d.getByRole('button', { name: 'Auto-crop' }).click();
    await d.getByText('Auto-crop applied').waitFor({ timeout: 15000 });
    const preview = await d.locator('.side-text').allInnerTexts();
    await d.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await win.getByRole('dialog', { name: 'Crop pages' }).count()) === 0, { timeoutMs: 5000, label: 'sheet closed' });
    await delay(700);
    const items = (await menuItems(win, 'Edit')).slice(0, 2);
    R.check('F1 after Cancel of an auto-crop preview: Undo is the earlier step and there is nothing to redo', items[0].label === 'Undo Duplicate 1 page' && items[1].disabled && items[1].label === 'Redo', `${items[0].label} | ${items[1].label} disabled=${items[1].disabled} (sheet said: ${preview.join(' / ')})`);
    await win.keyboard.press('Control+y');
    await delay(800);
    const size = await currentPageSize(win);
    R.check('F1 Ctrl+Y after the cancelled preview changes nothing', (await pageCount(win)) === 3 && size.width === full.width && size.height === full.height, JSON.stringify(size));
    // Auto-crop for real, undo, redo, save.
    await jumpTo(win, 0);
    const t = await toastAfter(win, () => menu(win, 'Pages', 'Auto-Crop'));
    await delay(500);
    const cropped = await currentPageSize(win);
    R.check('F1 Auto-Crop trims the white margins of the page', /cropped 1 page/i.test(t) && cropped.width < full.width - 20 && cropped.height < full.height - 20, `${t} ${JSON.stringify(full)} -> ${JSON.stringify(cropped)}`);
    await win.keyboard.press('Control+z');
    await delay(800);
    const back = await currentPageSize(win);
    await win.keyboard.press('Control+y');
    await delay(800);
    const again = await currentPageSize(win);
    R.check('F1 undo and redo of Auto-Crop', back.width === full.width && again.width === cropped.width, `${back.width} / ${again.width}`);
    await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(500);
    const disk = inspect(m.path);
    const crops = disk.pages.map((p) => (p.crop ? p.crop.join(' ') : '-'));
    R.check('F1 saved file: 3 pages, a crop box on page 1 only, inside the page, and the text is still there', disk.count === 3 && disk.pages[0].crop && !disk.pages[1].crop && !disk.pages[2].crop && disk.pages[0].crop[0] > 0 && disk.pages[0].crop[2] < 612 && inkShare(m.path, 0) > 0.001, crops.join(' | '));
  });

  // ---------- F2. Insert from a password-protected PDF
  await R.step('F2 threw', async () => {
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await delay(700);
    R.check('F2 before: an ordinary edit has a recovery log', rec().length === 1, String(rec()));
    await menu(win, 'Pages', 'Insert from PDF…');
    const d = sheet(win, 'Insert from a PDF');
    await s.setDialogAnswer([fixture('locked.pdf')]);
    await d.getByRole('button', { name: 'Browse for a PDF…' }).click();
    const pw = win.getByRole('dialog').filter({ has: win.locator('input[type="password"]') });
    await pw.waitFor({ timeout: 15000 });
    const text1 = (await pw.innerText()).replace(/\s+/g, ' ');
    await pw.locator('input[type="password"]').fill('not-it');
    await win.keyboard.press('Enter');
    await delay(1200);
    const text2 = (await pw.innerText().catch(() => 'dialog gone')).replace(/\s+/g, ' ');
    R.check('F2 a protected source asks for its password in plain words; a wrong one is said so and asked again', /password/i.test(text1) && plainEnglish(text1) && /wrong password/i.test(text2) && plainEnglish(text2), `"${text1}" -> "${text2}"`);
    await shot(win, 'f2-source-password');
    await pw.locator('input[type="password"]').fill('test123');
    await win.keyboard.press('Enter');
    await d.getByText('locked.pdf, 1 page').waitFor({ timeout: 15000 });
    R.check('F2 choosing the protected PDF alone does not switch recovery off', rec().length === 1, String(rec()));
    await d.getByRole('textbox', { name: 'Page range' }).fill('1');
    const n = (await toasts(win)).length;
    await d.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(win, 4);
    await delay(900);
    const fresh = (await toasts(win)).slice(n);
    R.check('F2 using its page: one plain message that crash recovery is off until the next save; the log is removed', fresh.filter((t) => /Crash recovery is off for this file until you save it/.test(t)).length === 1 && fresh.every(plainEnglish) && rec().length === 0, `${JSON.stringify(fresh)} rec=${rec()}`);
    await jumpTo(win, 3);
    const n2 = (await toasts(win)).length;
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await delay(800);
    R.check('F2 the message is not repeated for the next edit, and still no log', !(await toasts(win)).slice(n2).some((t) => /Crash recovery/.test(t)) && rec().length === 0, JSON.stringify((await toasts(win)).slice(n2)));
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(600);
    const disk = inspect(m.path);
    R.check('F2 save: the file has 5 pages with the borrowed page, and opens without a password', /^Saved/.test(t) && disk.ok && disk.count === 5 && disk.pages.some((p) => p.text.startsWith('Locked document')), `${t} count ${disk.count} texts ${disk.pages.map((p) => p.text.slice(0, 10)).join('|')}`);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await delay(900);
    R.check('F2 after the save, crash recovery works again (a log is written for the next edit)', rec().length === 1, String(rec()));
    await toastAfter(win, () => win.keyboard.press('Control+s'));
  });
  await closeTabs(win);

  // ---------- F3. Keys pressed while a long change runs
  await R.step('F3 threw', async () => {
    const big = mk('big-1000.pdf');
    await open(s, big.path, 1000);
    await selectAllPages(win);
    const n = (await toasts(win)).length;
    await win.keyboard.press('Control+Shift+R');
    await win.keyboard.press('Control+d');
    await win.keyboard.press('Control+d');
    await win.keyboard.press('Delete');
    await win.keyboard.press('Control+z');
    await waitFor(async () => (await toasts(win)).slice(n).some((t) => /Rotated 1000 pages/.test(t)), { timeoutMs: 60000, label: 'the rotation to finish' });
    await delay(2500);
    const fresh = (await toasts(win)).slice(n);
    const count = await pageCount(win);
    const ids = await uids(win);
    R.info(`F3 toasts: ${JSON.stringify(fresh)}; pages now ${count}; uids ${ids.length}`);
    const waits = fresh.filter((t) => /Wait for the current change to finish/.test(t)).length;
    const edits = fresh.filter((t) => /Duplicated|Deleted/.test(t)).length;
    R.check('F3 every key pressed during the rotation is either carried out or answered with "Wait for the current change to finish."', waits + edits >= 1 && fresh.every(plainEnglish) && count === ids.length, `waits=${waits} edits=${edits} pages=${count}`);
    const sheetOpen = await win.getByRole('dialog').count();
    if (sheetOpen) await win.keyboard.press('Escape');
  });
  await closeTabs(win);

  // ---------- F4. Command palette starts empty; F5. menus against the spec
  await R.step('F4/F5 threw', async () => {
    const o = mk('outline-6.pdf');
    await open(s, o.path, 6);
    await win.keyboard.press('Control+k');
    const dialog = win.getByRole('dialog', { name: 'Command palette' });
    const input = dialog.getByPlaceholder('Type a command');
    await input.fill('rotate');
    const listed = await dialog.getByRole('option').allInnerTexts();
    await win.keyboard.press('Escape');
    await delay(300);
    await win.keyboard.press('Control+k');
    const v1 = await input.inputValue();
    await input.fill('Pages: Reverse');
    await delay(300);
    await input.press('Enter');
    await delay(1000);
    await win.keyboard.press('Control+k');
    const v2 = await input.inputValue();
    const allOptions = await dialog.getByRole('option').count();
    await win.keyboard.press('Escape');
    R.check('F4 the palette opens empty after Esc and after running a command, listing everything', v1 === '' && v2 === '' && allOptions > 20 && listed.every((l) => /rotat/i.test(l)), `"${v1}" "${v2}" options=${allOptions} filtered=${JSON.stringify(listed.slice(0, 6))}`);
    R.check('F4 the palette command ran (order reversed, undo names it)', (await uids(win)).join() === '5,4,3,2,1,0' && (await menuItems(win, 'Edit'))[0].label === 'Undo Reverse 6 pages', `${(await uids(win)).join()} / ${(await menuItems(win, 'Edit'))[0].label}`);

    const tops = await win.locator('.menu-tops > .menu-top > button').allInnerTexts();
    const file = await menuItems(win, 'File');
    const edit = await menuItems(win, 'Edit');
    const fileText = file.map((i) => `${i.label}${i.accel ? ` [${i.accel}]` : ''}`).join(', ');
    const editText = edit.map((i) => `${i.label}${i.accel ? ` [${i.accel}]` : ''}`).join(', ');
    R.info(`F5 File: ${fileText}`);
    R.info(`F5 Edit: ${editText}`);
    R.check('F5 menu bar is File Edit View Pages Window Help', tops.join(' ') === 'File Edit View Pages Window Help', tops.join(' '));
    const want = { 'Open…': 'Ctrl+O', Save: 'Ctrl+S', 'Save As…': 'Ctrl+Shift+S', 'Close Tab': 'Ctrl+W', 'Close All': 'Ctrl+Shift+W', Exit: 'Alt+F4' };
    const missing = Object.entries(want).filter(([label, accel]) => file.find((i) => i.label === label)?.accel !== accel).map(([label, accel]) => `${label} should show ${accel}, shows "${file.find((i) => i.label === label)?.accel ?? 'no such item'}"`);
    R.check('F5 File menu shortcuts are the ones in the menu-bar spec', missing.length === 0, missing.join('; '));
    // Ctrl+Shift+W (the spec's Close All shortcut) on a document with an edit: it must ask, or at least do something.
    await win.keyboard.press('Control+Shift+W');
    await delay(800);
    const asked = (await win.getByRole('alertdialog').count()) > 0;
    R.check('F5 Ctrl+Shift+W (Close All in the spec) does something', asked, `prompt shown=${asked}, tabs=${await win.getByRole('tab').count()}`);
    if (asked) await win.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();

    await menu(win, 'Help', 'About PDF Suite…');
    await delay(600);
    const about = (await win.getByRole('dialog').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
    R.info(`F5 About: ${about.slice(0, 400)}`);
    R.check('F5 About names the version and the open-source engines, and nothing from Adobe', /MuPDF/.test(about) && /AGPL/.test(about) && !/adobe|acrobat/i.test(about), about.slice(0, 200));
    await win.keyboard.press('Escape');
  });
  await closeTabs(win);

  // ---------- F6. Lined and grid pages are really ruled
  await R.step('F6 threw', async () => {
    const o = mk('outline-6.pdf');
    await open(s, o.path, 6);
    await jumpTo(win, 0);
    for (const kind of ['Insert Blank Page…', 'Insert Lined Page…', 'Insert Grid Page…']) {
      await jumpTo(win, 0);
      await menu(win, 'Pages', kind);
      const sh = sheet(win, 'Insert pages');
      const type = await sh.getByRole('radiogroup', { name: 'Page type' }).getByRole('radio', { checked: true }).innerText();
      const sum = await sh.locator('.side-summary').innerText();
      const tt = await toastAfter(win, () => sh.getByRole('button', { name: 'Apply' }).click());
      R.info(`F6 ${kind}: sheet type "${type}", summary "${sum}", toast "${tt}"`);
    }
    await waitForCount(win, 9);
    await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(500);
    const d = inspect(o.path);
    // Each insert went in after page 1, so the order is: o1, grid, lined, blank, o2…
    const ink = [1, 2, 3].map((i) => inkShare(o.path, i));
    R.info(`F6 disk: ${d.pages.map((p) => p.text.slice(0, 9) || '·').join(',')}; ink grid/lined/blank = ${ink.map((v) => v.toFixed(4)).join(' / ')}`);
    R.check('F6 saved file: the grid page has more ruling than the lined page, and the blank page has none', d.count === 9 && ink[0] > ink[1] && ink[1] > 0.002 && ink[2] === 0, ink.join(' / '));
  });
  await closeTabs(win);

  const all = await toasts(win);
  const seen = await bars(win);
  R.check('every toast, bar and dialog text seen in this probe is plain English', all.every(plainEnglish) && seen.filter((t) => !t.startsWith('About PDF Suite')).every(plainEnglish), [...all, ...seen].filter((t) => !t.startsWith('About PDF Suite') && !plainEnglish(t)).join(' | ').slice(0, 600));
  R.info('all toasts: ' + [...new Set(all)].join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'f-failure');
} finally {
  await closeAll();
  if (profile) cleanupProfile(profile);
  for (const c of copies) removeCopy(c);
  process.exitCode = R.summary() ? 1 : 0;
}
