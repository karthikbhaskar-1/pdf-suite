// Probe A: every organizer operation from the classic menu bar, on the 8-page mixed file, then Save, close, and an
// independent read of the file on disk (page count, order, sizes, rotation, crop boxes), then reopen in the app.
import { join } from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitForCount, pageCount, fixture, waitFor, setSaveAnswer,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspectMupdf, inspectPdfjs, plainEnglish, toasts, isDirty, clickRowByIndex,
} from './lib.mjs';

const R = makeReport('a-menu-ops');
const copy = copyOf('mixed-sizes-rotated.pdf');
const outDir = mkdtempSync(join(tmpdir(), 'pdfsuite-so3-'));
let s;
// The expected document, kept by hand next to the app. t = text on the page, k = kind of an inserted page.
let model = [
  { t: 'Page 1: Letter portrait' }, { t: 'Page 2: A4 portrait' }, { t: 'Page 3: Letter as explicit points' }, { t: 'Page 4: A3 landscape' },
  { t: 'Page 5: Small square' }, { t: 'Page 6: Letter rotated 90' }, { t: 'Page 7: A5 rotated 180' }, { t: 'Page 8: Tall custom rotated 270' },
];
const idx = (t) => model.findIndex((p) => p.t === t);

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  // With no document, the Pages menu must be visible but greyed out.
  const emptyPages = await menuItems(win, 'Pages');
  R.check('Pages menu with no document: all items disabled, still listed', emptyPages.length >= 14 && emptyPages.every((i) => i.disabled), JSON.stringify(emptyPages.map((i) => i.label)));
  const tops = await win.locator('.menu-tops > .menu-top > button').allInnerTexts();
  R.check('menu bar is File Edit View Pages Window Help', tops.join(' ') === 'File Edit View Pages Window Help', tops.join(' '));

  await open(s, copy.path, 8);
  await watchToasts(win);

  await R.step('insert blank (menu, defaults)', async () => {
    await jumpTo(win, 0);
    const t = await toastAfter(win, async () => {
      await menu(win, 'Pages', 'Insert Blank Page…');
      await sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click();
    });
    await waitForCount(win, 9);
    model.splice(1, 0, { t: '', k: 'blank', w: 612, h: 792 });
    R.check('insert blank: toast', /Inserted 1 blank page/.test(t), t);
  });

  await R.step('insert 2 lined A4 at page 1 (menu)', async () => {
    await menu(win, 'Pages', 'Insert Lined Page…');
    const d = sheet(win, 'Insert pages');
    await d.getByRole('combobox', { name: 'Page size' }).selectOption('a4');
    await d.getByRole('spinbutton', { name: 'Number of pages' }).fill('2');
    await d.getByRole('combobox', { name: 'Position' }).selectOption('at');
    await d.getByRole('spinbutton', { name: 'Position number' }).fill('1');
    const summary = await d.locator('.side-summary').innerText();
    R.check('insert sheet summary says where', /Adds 2 lined pages at the start\./.test(summary), summary);
    await d.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(win, 11);
    model.splice(0, 0, { t: '', k: 'lined', w: 595.28, h: 841.89 }, { t: '', k: 'lined', w: 595.28, h: 841.89 });
  });

  await R.step('insert grid Legal before current (menu)', async () => {
    await jumpTo(win, idx('Page 3: Letter as explicit points'));
    await menu(win, 'Pages', 'Insert Grid Page…');
    const d = sheet(win, 'Insert pages');
    await d.getByRole('combobox', { name: 'Page size' }).selectOption('legal');
    await d.getByRole('combobox', { name: 'Position' }).selectOption('before');
    await d.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(win, 12);
    model.splice(idx('Page 3: Letter as explicit points'), 0, { t: '', k: 'grid', w: 612, h: 1008 });
  });

  await R.step('insert from PDF "2-3, 6" at the end (menu)', async () => {
    await menu(win, 'Pages', 'Insert from PDF…');
    const d = sheet(win, 'Insert from a PDF');
    await s.setDialogAnswer([fixture('outline-6.pdf')]);
    await d.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await d.getByText('outline-6.pdf, 6 pages').waitFor({ timeout: 15000 });
    await d.getByRole('textbox', { name: 'Page range' }).fill('2-3, 6');
    await d.getByRole('combobox', { name: 'Position' }).selectOption('at');
    await d.getByRole('spinbutton', { name: 'Position number' }).fill('13');
    await d.getByRole('button', { name: 'Apply' }).click();
    await waitForCount(win, 15);
    model.push({ t: 'Outline page 2' }, { t: 'Outline page 3' }, { t: 'Outline page 6' });
  });

  await R.step('duplicate (menu)', async () => {
    const i = idx('Page 5: Small square');
    await jumpTo(win, i);
    const t = await toastAfter(win, () => menu(win, 'Pages', 'Duplicate'));
    await waitForCount(win, 16);
    model.splice(i + 1, 0, { ...model[i] });
    R.check('duplicate: toast', /Duplicated 1 page/.test(t), t);
  });

  await R.step('rotate right / left / 180 (menu)', async () => {
    await jumpTo(win, idx('Page 1: Letter portrait'));
    const t = await toastAfter(win, () => menu(win, 'Pages', 'Rotate Right 90°'));
    model[idx('Page 1: Letter portrait')].rot = 90;
    R.check('rotate right toast', /Rotated 1 page/.test(t), t);
    await jumpTo(win, idx('Page 2: A4 portrait'));
    await toastAfter(win, () => menu(win, 'Pages', 'Rotate Left 90°'));
    model[idx('Page 2: A4 portrait')].rot = 270;
    await jumpTo(win, idx('Page 3: Letter as explicit points'));
    await toastAfter(win, () => menu(win, 'Pages', 'Rotate 180°'));
    model[idx('Page 3: Letter as explicit points')].rot = 180;
  });

  await R.step('custom angle 12.5 (menu)', async () => {
    await jumpTo(win, idx('Page 4: A3 landscape'));
    await menu(win, 'Pages', 'Custom Angle…');
    const d = sheet(win, 'Rotate pages');
    await d.getByRole('spinbutton', { name: 'Angle in degrees' }).fill('12.5');
    const summary = await d.locator('.side-summary').innerText();
    R.check('rotate sheet summary', /Rotates 1 page by 12\.5°/.test(summary), summary);
    const t = await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    model[idx('Page 4: A3 landscape')].fine = 12.5;
    R.check('custom rotate toast', /Rotated 1 page/.test(t), t);
  });

  await R.step('crop 1 in on every side of Outline page 2 (menu)', async () => {
    await jumpTo(win, idx('Outline page 2'));
    await menu(win, 'Pages', 'Crop Pages…');
    const d = sheet(win, 'Crop pages');
    await d.getByRole('combobox', { name: 'Units' }).selectOption('in');
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) await d.getByRole('spinbutton', { name: `${edge} margin` }).fill('1');
    const handles = await win.locator('[class*="crop-handle"]').count();
    R.check('crop overlay shows 8 handles', handles === 8, `handles ${handles}`);
    await shot(win, 'a-crop-sheet');
    const t = await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    model[idx('Outline page 2')].crop = [72, 72, 540, 720];
    R.check('crop toast', /Cropped 1 page/.test(t), t);
  });

  await R.step('crop top 1 in on the rotated-90 page: the visual top is cut', async () => {
    await jumpTo(win, idx('Page 6: Letter rotated 90'));
    await menu(win, 'Pages', 'Crop Pages…');
    const d = sheet(win, 'Crop pages');
    await d.getByRole('combobox', { name: 'Units' }).selectOption('in');
    await d.getByRole('spinbutton', { name: 'Top margin' }).fill('1');
    await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    model[idx('Page 6: Letter rotated 90')].cropShown = [792, 540];
  });

  await R.step('auto-crop (menu) on Outline page 3', async () => {
    await jumpTo(win, idx('Outline page 3'));
    const t = await toastAfter(win, () => menu(win, 'Pages', 'Auto-Crop'));
    model[idx('Outline page 3')].auto = true;
    R.check('auto-crop toast', /Auto-cropped 1 page/.test(t), t);
  });

  await R.step('page size A4, scale to fit, two selected pages (menu)', async () => {
    const a = idx('Page 7: A5 rotated 180');
    await clickRowByIndex(win, a);
    await clickRowByIndex(win, a + 1, ['Shift']);
    await menu(win, 'Pages', 'Page Size…');
    const d = sheet(win, 'Page size');
    const summary = await d.locator('.side-summary').innerText();
    R.check('size sheet: scope is the 2 selected pages, A4', /Sets 2 pages to A4/.test(summary), summary);
    const t = await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    model[a].size = [595.28, 841.89];
    model[a + 1].size = [595.28, 841.89];
    R.check('resize toast', /Resized 2 pages/.test(t), t);
  });

  await R.step('replace a blank page with page 4 of outline-6 (menu)', async () => {
    const i = model.findIndex((p) => p.k === 'blank');
    await jumpTo(win, i);
    await menu(win, 'Pages', 'Replace…');
    const d = sheet(win, 'Replace page');
    const says = await d.locator('.side-text').first().innerText();
    R.check('replace sheet names the page', says.includes(`This replaces page ${i + 1} of this file.`), says);
    await s.setDialogAnswer([fixture('outline-6.pdf')]);
    await d.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await d.getByText('outline-6.pdf, 6 pages').waitFor({ timeout: 15000 });
    await d.getByRole('spinbutton', { name: 'Page in the PDF' }).fill('4');
    const t = await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    model[i] = { t: 'Outline page 4' };
    R.check('replace toast', /Replaced the page/.test(t), t);
    R.check('replace keeps the page count', (await pageCount(win)) === 16);
  });

  await R.step('delete one page (menu)', async () => {
    const i = model.findIndex((p) => p.k === 'grid');
    await jumpTo(win, i);
    const t = await toastAfter(win, () => menu(win, 'Pages', 'Delete Pages'));
    await waitForCount(win, 15);
    model.splice(i, 1);
    R.check('delete toast', /Deleted 1 page/.test(t), t);
  });

  await R.step('reverse all (menu, nothing selected)', async () => {
    // With one page selected, Reverse must explain itself instead of doing nothing.
    await jumpTo(win, 0);
    const one = await toastAfter(win, () => menu(win, 'Pages', 'Reverse'));
    R.check('reverse with one selected page explains what to do', /Select two or more pages to reverse, or clear the selection/.test(one), one);
    // A Ctrl+click on a selected row takes it out of the selection.
    const sel = win.locator('.thumb-selected');
    for (let i = 0; i < 5 && (await sel.count()) > 0; i++) await sel.first().click({ modifiers: ['Control'] });
    const selected = await win.locator('.thumb-selected').count();
    R.info(`selected thumbnails before reverse: ${selected}`);
    const t = await toastAfter(win, () => menu(win, 'Pages', 'Reverse'));
    if (/Reversed all 15 pages/.test(t)) model.reverse();
    R.check('reverse toast says all', /Reversed all 15 pages/.test(t), t);
  });

  await R.step('extract 2 pages (File menu)', async () => {
    const target = join(outDir, 'picked-extract.pdf');
    await setSaveAnswer(s, target);
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 1, ['Shift']);
    const t = await toastAfter(win, () => menu(win, 'File', 'Extract Pages…'));
    R.check('extract toast', /Extracted 2 pages/.test(t), t);
    const x = inspectMupdf(target);
    R.check('extract: valid 2-page PDF with the right pages', x.ok && x.count === 2 && x.pages[0].text === model[0].t && x.pages[1].text === model[1].t, JSON.stringify(x.pages?.map((p) => p.text)));
    const xj = await inspectPdfjs(target);
    R.check('extract: pdf.js reads it too', xj.count === 2, JSON.stringify(xj.pages.map((p) => p.text)));
    R.check('extract leaves the document as it was (15 pages, still unsaved)', (await pageCount(win)) === 15 && (await isDirty(win)));
  });

  const title = await win.title();
  R.check('window title shows the unsaved dot', /mixed-sizes-rotated\.pdf • — PDF Suite/.test(title), title);
  const undoLabel = (await menuItems(win, 'Edit')).slice(0, 2).map((i) => i.label).join(' / ');
  R.check('Edit menu names the undo step', /^Undo Reverse/.test(undoLabel), undoLabel);

  await R.step('save (File menu) and verify the file on disk with independent readers', async () => {
    const order = await uids(win);
    const t = await toastAfter(win, () => menu(win, 'File', 'Save'));
    R.check('save toast', /Saved mixed-sizes-rotated\.pdf/.test(t), t);
    await waitFor(async () => !(await isDirty(win)), { timeoutMs: 20000, label: 'clean' });
    const title2 = await win.title();
    R.check('title loses the dot after save', title2 === 'mixed-sizes-rotated.pdf — PDF Suite', title2);
    const after = await uids(win);
    R.check('page list is the same length after the save reopened the file', after.length === order.length, `${after.length} vs ${order.length}`);
    const leftovers = readdirSync(copy.dir).filter((f) => f.endsWith('.tmp'));
    R.check('no temp files left next to the saved file', leftovers.length === 0, leftovers.join(','));
    const d = inspectMupdf(copy.path);
    R.info('disk: ' + JSON.stringify(d.pages.map((p) => [p.text, p.media, p.crop, p.rotate, p.shown])));
    R.check('disk: valid PDF, 15 pages', d.ok && d.eof && d.count === 15, `count ${d.count}`);
    R.check('disk: page order matches', JSON.stringify(d.pages.map((p) => p.text)) === JSON.stringify(model.map((p) => p.t)), `\n disk ${JSON.stringify(d.pages.map((p) => p.text))}\n want ${JSON.stringify(model.map((p) => p.t))}`);
    const j = await inspectPdfjs(copy.path);
    R.check('disk: pdf.js agrees on count and order', j.count === 15 && JSON.stringify(j.pages.map((p) => p.text)) === JSON.stringify(model.map((p) => p.t)), JSON.stringify(j.pages.map((p) => p.text)));
    const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
    model.forEach((m, i) => {
      const p = d.pages[i];
      if (!p) return;
      if (m.k) R.check(`disk: ${m.k} page ${i + 1} is ${m.w}x${m.h}`, near(p.shown[0], m.w) && near(p.shown[1], m.h), JSON.stringify(p.shown));
      if (m.rot !== undefined) R.check(`disk: "${m.t}" has /Rotate ${m.rot}`, ((p.rotate % 360) + 360) % 360 === m.rot, `rotate ${p.rotate}`);
      if (m.crop) R.check(`disk: "${m.t}" CropBox ${m.crop}`, p.crop && p.crop.every((v, k) => near(v, m.crop[k])), JSON.stringify(p.crop));
      if (m.cropShown) R.check(`disk: "${m.t}" shows ${m.cropShown} after the crop`, near(p.shown[0], m.cropShown[0]) && near(p.shown[1], m.cropShown[1]), `shown ${JSON.stringify(p.shown)} crop ${JSON.stringify(p.crop)} rot ${p.rotate}`);
      if (m.auto) R.check(`disk: "${m.t}" has an auto CropBox inside the page`, p.crop && p.crop[0] > 0 && p.crop[1] > 0 && p.crop[2] < 612 && p.crop[3] < 792, JSON.stringify(p.crop));
      if (m.size) R.check(`disk: "${m.t}" is A4 now`, (near(p.shown[0], m.size[0]) && near(p.shown[1], m.size[1])) || (near(p.shown[0], m.size[1]) && near(p.shown[1], m.size[0])), `shown ${JSON.stringify(p.shown)} media ${JSON.stringify(p.media)} rot ${p.rotate}`);
      if (m.fine) R.check(`disk: "${m.t}" fine rotation grew the page to the rotated bounding box`, near(p.shown[0], 1344.55, 3) && near(p.shown[1], 1079.62, 3), JSON.stringify(p.shown));
    });
    const pj = j.pages.map((p) => [p.w, p.h]);
    R.check('disk: pdf.js page sizes agree with mupdf', d.pages.every((p, i) => near(p.shown[0], pj[i][0], 1.5) && near(p.shown[1], pj[i][1], 1.5)), JSON.stringify(pj));
  });

  const all = await toasts(win);
  R.check('every toast is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.info('toasts: ' + all.join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
  await s.close();

  // Reopen in a fresh app and compare with the disk.
  s = await launch();
  await s.win.waitForSelector('.empty-state');
  await open(s, copy.path, 15);
  R.check('reopen: the app shows 15 pages', (await pageCount(s.win)) === 15 && (await uids(s.win)).length === 15);
  R.check('reopen: not marked unsaved', !(await isDirty(s.win)));
  await shot(s.win, 'a-reopened');
  R.check('reopen: no errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'a-failure');
} finally {
  await closeAll();
  removeCopy(copy);
  rmSync(outDir, { recursive: true, force: true });
  process.exitCode = R.summary() ? 1 : 0;
}
