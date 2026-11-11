// Probe E: one long sequence on ONE document: insert, duplicate, undo, redo, rotate, custom angle, undo, move, reverse,
// save; delete, insert from PDF, replace, save; page size, Save As; rotate, save; extract; close, reopen. After every save
// the file is read with two independent readers (mupdf in node, pdf.js) and compared with a model kept by hand.
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, delay, fixture, setSaveAnswer,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspect, inspectPdfjs, toasts, isDirty, uids, plainEnglish, selectAllPages, clickRowByIndex,
} from './lib.mjs';

const R = makeReport('e-sequence');
const copy = copyOf('mixed-sizes-rotated.pdf');
const outDir = mkdtempSync(join(tmpdir(), 'pdfsuite-so4-'));
let s;
const P = (n, r = 0) => ({ t: `Page ${n}:`, r });
let model = [P(1), P(2), P(3), P(4), P(5), P(6, 90), P(7, 180), P(8, 270)];
const idx = (n) => model.findIndex((p) => p.t === `Page ${n}:`);
const show = (list) => list.map((p) => `${p.t ? p.t.replace('Page ', 'm').replace('Outline page ', 'o').replace(':', '') : '·'}${p.r ? `/r${p.r}` : ''}`).join(',');
/** Compares a file with the model: count, text of each page (prefix) and /Rotate. */
async function verify(label, path) {
  const d = inspect(path);
  const got = d.pages.map((p) => ({ t: p.text, r: p.rotate }));
  const ok = d.ok && d.eof && d.count === model.length && model.every((m, i) => (m.t === '' ? got[i].t === '' : got[i].t.startsWith(m.t)) && got[i].r === m.r);
  R.check(`${label}: mupdf reads the file as the model (${model.length} pages)`, ok, `want ${show(model)} | got ${show(got.map((g) => ({ t: g.t.replace(/^(Page \d+:).*/, '$1'), r: g.r })))}`);
  let pjOk = false;
  let detail = '';
  try {
    const pj = await inspectPdfjs(path);
    pjOk = pj.count === model.length && model.every((m, i) => (m.t === '' ? pj.pages[i].text === '' : pj.pages[i].text.startsWith(m.t)) && pj.pages[i].rotate === m.r);
    detail = pj.pages.map((p) => `${p.text.slice(0, 8)}/r${p.rotate}`).join(',');
  } catch (e) {
    detail = e.message;
  }
  R.check(`${label}: pdf.js agrees`, pjOk, detail);
  return d;
}

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, copy.path, 8);
  await watchToasts(win);

  await R.step('part 1 threw', async () => {
    await jumpTo(win, 0);
    await menu(win, 'Pages', 'Insert Lined Page…');
    const d = sheet(win, 'Insert pages');
    await d.getByRole('combobox', { name: 'Page size' }).selectOption('a4');
    await d.getByRole('spinbutton', { name: 'Number of pages' }).fill('2');
    await d.getByRole('combobox', { name: 'Position' }).selectOption('at');
    await d.getByRole('spinbutton', { name: 'Position number' }).fill('1');
    await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 10);
    model.splice(0, 0, { t: '', r: 0 }, { t: '', r: 0 });

    await jumpTo(win, idx(3));
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 11);
    await win.keyboard.press('Control+z');
    await waitForCount(win, 10);
    const afterUndo = (await menuItems(win, 'Edit')).slice(0, 2).map((i) => i.label).join(' | ');
    await win.keyboard.press('Control+y');
    await waitForCount(win, 11);
    R.check('undo/redo of Duplicate; the menu names the steps', /Undo Insert 2 lined pages \| Redo Duplicate 1 page/.test(afterUndo), afterUndo);
    model.splice(idx(3) + 1, 0, P(3));

    await jumpTo(win, idx(5));
    await toastAfter(win, () => menu(win, 'Pages', 'Rotate 180°'));
    model[idx(5)].r = 180;

    await jumpTo(win, idx(4));
    await menu(win, 'Pages', 'Custom Angle…');
    const rot = sheet(win, 'Rotate pages');
    await rot.getByRole('spinbutton', { name: 'Angle in degrees' }).fill('7.5');
    await toastAfter(win, () => rot.getByRole('button', { name: 'Apply' }).click());
    await delay(500);
    await win.keyboard.press('Control+z');
    await delay(900);
    const u = (await menuItems(win, 'Edit')).slice(0, 2).map((i) => i.label).join(' | ');
    R.check('the custom angle is undone (Redo offers it again)', /Undo Rotate 1 page \| Redo Rotate 1 page/.test(u), u);

    const before = await uids(win);
    await clickRowByIndex(win, idx(1));
    await win.keyboard.press('Alt+ArrowDown');
    await delay(900);
    const after = await uids(win);
    const i1 = idx(1);
    R.check('Alt+Down moves the selected page one place down', after[i1 + 1] === before[i1] && after[i1] === before[i1 + 1], `${before.join(',')} -> ${after.join(',')}`);
    [model[i1], model[i1 + 1]] = [model[i1 + 1], model[i1]];

    await selectAllPages(win);
    await toastAfter(win, () => menu(win, 'Pages', 'Reverse'));
    await delay(600);
    model.reverse();
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(600);
    R.check('save 1: toast and clean document', /^Saved mixed-sizes-rotated\.pdf/.test(t) && !(await isDirty(win)), t);
    await verify('save 1 (insert, dup, undo/redo, rotate, angle+undo, move, reverse)', copy.path);
  });

  let afterSave2;
  await R.step('part 2 threw', async () => {
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 10);
    model.splice(0, 1);

    await menu(win, 'Pages', 'Insert from PDF…');
    const d = sheet(win, 'Insert from a PDF');
    await s.setDialogAnswer([fixture('outline-6.pdf')]);
    await d.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await d.getByText('outline-6.pdf, 6 pages').waitFor({ timeout: 15000 });
    await d.getByRole('textbox', { name: 'Page range' }).fill('2,4');
    await d.getByRole('combobox', { name: 'Position' }).selectOption('at');
    await d.getByRole('spinbutton', { name: 'Position number' }).fill('11');
    await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 12);
    model.push({ t: 'Outline page 2', r: 0 }, { t: 'Outline page 4', r: 0 });

    await jumpTo(win, 0);
    await menu(win, 'Pages', 'Replace…');
    const rep = sheet(win, 'Replace page');
    await s.setDialogAnswer([fixture('outline-6.pdf')]);
    await rep.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await rep.getByText('outline-6.pdf, 6 pages').waitFor({ timeout: 15000 });
    await rep.getByRole('spinbutton', { name: 'Page in the PDF' }).fill('6');
    const t = await toastAfter(win, () => rep.getByRole('button', { name: 'Apply' }).click());
    R.info(`replace toast: "${t}"`);
    model[0] = { t: 'Outline page 6', r: 0 };
    // Undo and redo across the three steps, then save.
    for (let i = 0; i < 3; i++) {
      await win.keyboard.press('Control+z');
      await delay(700);
    }
    R.check('three undos take the document back to the 11 saved pages, clean of the three steps', (await pageCount(win)) === 11, `pages ${await pageCount(win)} dirty ${await isDirty(win)}`);
    for (let i = 0; i < 3; i++) {
      await win.keyboard.press('Control+y');
      await delay(700);
    }
    await waitForCount(win, 12);
    const t2 = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(600);
    R.check('save 2: toast and clean document', /^Saved/.test(t2) && !(await isDirty(win)), t2);
    await verify('save 2 (delete, insert from PDF, replace, undo×3, redo×3)', copy.path);
    afterSave2 = readFileSync(copy.path);
  });

  const target = join(outDir, 'sequence saved as.pdf');
  await R.step('part 3 threw', async () => {
    await selectAllPages(win);
    await menu(win, 'Pages', 'Page Size…');
    const d = sheet(win, 'Page size');
    await d.getByRole('radio', { name: 'Letter' }).click();
    await d.getByRole('radio', { name: 'Scale to fit' }).click();
    await d.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
    const summary = await d.locator('.side-summary').innerText();
    const t = await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click(), 30000);
    R.info(`page size: summary "${summary}" toast "${t}"`);
    await setSaveAnswer(s, target);
    const t2 = await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    await delay(600);
    R.check('Save As: toast, clean, original file unchanged since save 2', /^Saved sequence saved as\.pdf/.test(t2) && !(await isDirty(win)) && readFileSync(copy.path).equals(afterSave2), t2);
    // After "make the same size" the pages keep their text and order; /Rotate may be folded into the page, so only text is modelled here.
    const d3 = inspect(target);
    const sizes = d3.pages.map((p) => p.shown.map((v) => Math.round(v)).join('x'));
    R.check('Save As file: 12 pages, same text order', d3.count === 12 && model.every((m, i) => (m.t === '' ? d3.pages[i].text === '' : d3.pages[i].text.startsWith(m.t))), d3.pages.map((p) => p.text.slice(0, 9)).join(','));
    R.check('Save As file: every page is Letter size (612×792 or turned)', sizes.every((x) => x === '612x792' || x === '792x612'), sizes.join(' '));
    const pj = await inspectPdfjs(target);
    const pjSizes = pj.pages.map((p) => `${Math.round(p.w)}x${Math.round(p.h)}`);
    R.check('Save As file: pdf.js sees the same sizes and text', pj.count === 12 && pjSizes.join() === sizes.join() && model.every((m, i) => (m.t === '' ? pj.pages[i].text === '' : pj.pages[i].text.startsWith(m.t))), pjSizes.join(' '));

    const rBefore = d3.pages[11].rotate;
    await jumpTo(win, 11);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+L'));
    const t3 = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(600);
    const d4 = inspect(target);
    R.check('edit + Save after Save As: the new file has the rotation, the original is unchanged', /^Saved sequence saved as\.pdf/.test(t3) && d4.pages[11].rotate === (rBefore + 270) % 360 && d4.count === 12 && readFileSync(copy.path).equals(afterSave2), `${t3} rotate ${rBefore} -> ${d4.pages[11].rotate}`);

    const extract = join(outDir, 'two pages.pdf');
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 1, ['Shift']);
    await setSaveAnswer(s, extract);
    const t4 = await toastAfter(win, () => menu(win, 'File', 'Extract Pages…'));
    await delay(500);
    const de = inspect(extract);
    R.check('Extract of pages 1–2: a new 2-page file with those pages; the document is not changed', /Extracted 2 pages/.test(t4) && de.count === 2 && de.pages[0].text.startsWith('Outline page 6') && de.pages[1].text.startsWith(model[1].t) && !(await isDirty(win)) && (await pageCount(win)) === 12, `${t4} / ${de.pages.map((p) => p.text.slice(0, 14)).join(',')}`);

    await win.keyboard.press('Control+w');
    await win.waitForSelector('.empty-state', { timeout: 10000 });
    await open(s, target, 12);
    await delay(500);
    R.check('reopened Save As file: 12 pages, clean, nothing recovered', (await pageCount(win)) === 12 && !(await isDirty(win)) && (await win.locator('.doc-bar').count()) === 0);
  });

  const all = await toasts(win);
  R.check('every toast in the sequence is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.info('toasts: ' + all.join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'e-failure');
} finally {
  await closeAll();
  removeCopy(copy);
  rmSync(outDir, { recursive: true, force: true });
  process.exitCode = R.summary() ? 1 : 0;
}
