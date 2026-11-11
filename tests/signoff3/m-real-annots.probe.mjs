// Probe M: well-formed comments (sticky note, highlight, free text) made with plain mupdf, taken through duplicate,
// fine rotation, page size and crop in the app, saved, and read back with plain mupdf.
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as mupdf from 'mupdf';
import {
  launch, closeAll, open, jumpTo, waitForCount, delay, fixture,
  makeReport, watchToasts, toastAfter, menu, sheet, shot, palette, toasts, plainEnglish,
} from './lib.mjs';

const R = makeReport('m-real-annots');
const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-so3-'));
const file = join(dir, 'commented.pdf');
let s;

function makeFixture() {
  const doc = mupdf.Document.openDocument(readFileSync(fixture('outline-6.pdf')), 'application/pdf').asPDF();
  for (let i = 0; i < 4; i++) {
    const page = doc.loadPage(i);
    const note = page.createAnnotation('Text');
    note.setRect([400, 80, 420, 100]);
    note.setContents(`sticky ${i + 1}`);
    note.update();
    const hl = page.createAnnotation('Highlight');
    hl.setQuadPoints([[72, 70, 300, 70, 72, 105, 300, 105]]);
    hl.setContents(`highlight ${i + 1}`);
    hl.update();
    const ft = page.createAnnotation('FreeText');
    ft.setRect([100, 300, 300, 340]);
    ft.setContents(`free ${i + 1}`);
    ft.update();
  }
  writeFileSync(file, doc.saveToBuffer('').asUint8Array());
}
function read(path) {
  const doc = mupdf.Document.openDocument(readFileSync(path), 'application/pdf').asPDF();
  const out = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const b = page.getBounds().map((v) => Math.round(v));
    const annots = page.getAnnotations().map((a) => {
      const r = a.getBounds().map((v) => Math.round(v));
      return { type: a.getType(), contents: a.getContents(), rect: r, inside: r[0] >= b[0] - 2 && r[1] >= b[1] - 2 && r[2] <= b[2] + 2 && r[3] <= b[3] + 2 };
    });
    out.push({ bounds: b, annots });
  }
  return out;
}

try {
  makeFixture();
  const before = read(file);
  R.info('fixture: ' + JSON.stringify(before.slice(0, 1)));
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, file, 6);
  await watchToasts(win);
  await jumpTo(win, 0);
  await toastAfter(win, () => win.keyboard.press('Control+d'));
  await waitForCount(win, 7);
  await jumpTo(win, 2); // original page 2: 10 degrees
  await palette(win, 'Pages: Rotate by a custom angle…');
  let d = sheet(win, 'Rotate pages');
  await d.getByRole('spinbutton', { name: 'Angle in degrees' }).fill('10');
  await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
  await jumpTo(win, 3); // original page 3: A4, scale to fit
  await palette(win, 'Pages: Set page size…');
  d = sheet(win, 'Page size');
  await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
  await jumpTo(win, 4); // original page 4: rotate right, then crop 0.5 in
  await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
  await menu(win, 'Pages', 'Crop Pages…');
  d = sheet(win, 'Crop pages');
  await d.getByRole('combobox', { name: 'Units' }).selectOption('in');
  for (const edge of ['Top', 'Bottom', 'Left', 'Right']) await d.getByRole('spinbutton', { name: `${edge} margin` }).fill('0.5');
  await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
  await shot(win, 'm-before-save');
  await toastAfter(win, () => win.keyboard.press('Control+s'));
  await delay(500);
  const after = read(file);
  after.forEach((p, i) => R.info(`page ${i + 1}: bounds ${JSON.stringify(p.bounds)} ${JSON.stringify(p.annots.map((a) => `${a.type} "${a.contents}" ${JSON.stringify(a.rect)}${a.inside ? '' : ' OUTSIDE'}`))}`));
  const kinds = (p) => p.annots.map((a) => `${a.type}:${a.contents}`).sort().join('|');
  R.check('the copy of page 1 has the same three comments as page 1', kinds(after[1]) === kinds(after[0]) && after[1].annots.length === 3, `${kinds(after[0])} vs ${kinds(after[1])}`);
  R.check('copies are separate objects: page 1 still has exactly three', after[0].annots.length === 3);
  R.check('fine-rotated page 2 keeps its three comments', after[2].annots.length === 3 && kinds(after[2]) === 'FreeText:free 2|Highlight:highlight 2|Text:sticky 2', kinds(after[2]));
  R.check('resized page 3 keeps its three comments, inside the new page', after[3].annots.length === 3 && after[3].annots.every((a) => a.inside), JSON.stringify(after[3].annots));
  R.check('rotated + cropped page 4 keeps its three comments', after[4].annots.length === 3, kinds(after[4]));
  R.check('untouched pages 5 and 6 have none', after[5].annots.length === 0 && after[6].annots.length === 0);
  const moved3 = after[3].annots.find((a) => a.type === 'Text');
  R.info(`sticky note on page 3 moved from [400,80,420,100] to ${JSON.stringify(moved3?.rect)} (page scaled from 612x792 to A4)`);
  const all = await toasts(win);
  R.check('every toast is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'm-failure');
} finally {
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = R.summary() ? 1 : 0;
}
