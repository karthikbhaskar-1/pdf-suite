// Probe J: two follow-ups. (1) After a crash, "Discard" on the recovery bar: does the window show the file as saved
// (page list, sizes, rotation)? (2) Duplicate, rotate, crop and resize on pages with a note and a link: what is on disk.
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, waitFor, delay, newProfileDir, cleanupProfile, forceKill,
  makeReport, watchToasts, toastAfter, menu, sheet, shot, inspectMupdf, isDirty, snapshot, statusText, showPanel, toasts, currentPageSize, palette,
} from './lib.mjs';

const R = makeReport('j-discard-annots');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;

/** Subtype, rectangle and target of every annotation on every page, read with plain mupdf. */
function annotsOnDisk(path) {
  const doc = mupdf.Document.openDocument(readFileSync(path), 'application/pdf').asPDF();
  const out = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    const list = page.get('Annots');
    const row = [];
    if (!list.isNull() && list.isArray()) {
      for (let k = 0; k < list.length; k++) {
        const a = list.get(k);
        const rect = a.get('Rect');
        const r = rect.isNull() ? [] : [0, 1, 2, 3].map((n) => Math.round(rect.get(n).asNumber()));
        const action = a.get('A');
        const uri = !action.isNull() && !action.get('URI').isNull() ? action.get('URI').asString() : '';
        const contents = a.get('Contents');
        const p = a.get('P');
        let pOk = 'noP';
        try {
          if (!p.isNull()) pOk = p.asIndirect() === page.asIndirect() ? 'P=own page' : 'P=OTHER page';
        } catch {
          pOk = 'P=?';
        }
        row.push(`${a.get('Subtype').asName()}[${r.join(' ')}]${uri ? ` ${uri}` : ''}${contents.isNull() ? '' : ` "${contents.asString()}"`} ${pOk}`);
      }
    }
    out.push(row);
  }
  return out;
}

try {
  // ---------- 1. Discard after a crash
  const a = mk('mixed-sizes-rotated.pdf');
  const original = readFileSync(a.path);
  const profile = newProfileDir();
  s = await launch({ profile });
  await s.win.waitForSelector('.empty-state');
  await open(s, a.path, 8);
  await watchToasts(s.win);
  const snap0 = await snapshot(s.win);
  await jumpTo(s.win, 0);
  await toastAfter(s.win, () => s.win.keyboard.press('Delete'));
  await jumpTo(s.win, 1);
  await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
  await jumpTo(s.win, 0);
  await toastAfter(s.win, () => s.win.keyboard.press('Control+d'));
  const snapEdited = await snapshot(s.win);
  await delay(1500);
  await forceKill(s.app);
  s = await launch({ profile });
  await waitFor(async () => (await statusText(s.win)).includes('of 8'), { timeoutMs: 30000, label: 'restored tab' });
  await showPanel(s.win, 'Thumbnails');
  await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
  await watchToasts(s.win);
  const bar = s.win.locator('.doc-bar', { hasText: 'Recovered unsaved edits' });
  await bar.waitFor({ timeout: 15000 });
  R.check('recovered state equals the state before the crash', (await snapshot(s.win)) === snapEdited, `\n have ${await snapshot(s.win)}\n want ${snapEdited}`);
  await bar.getByRole('button', { name: 'Discard' }).click();
  await delay(3000);
  const after = await snapshot(s.win);
  R.check('after Discard the page list equals the file as saved (order and row sizes)', after === snap0, `\n have ${after}\n want ${snap0}`);
  R.info(`after Discard: status "${await statusText(s.win)}", unsaved=${await isDirty(s.win)}, bar shown=${(await bar.count()) > 0}, toasts: ${(await toasts(s.win)).join(' | ')}`);
  await shot(s.win, 'j-after-discard');
  // The page slots in the viewer: each drawn page's width/height against the true page shape in the saved file.
  const truth = inspectMupdf(a.path).pages.map((p) => p.shown[0] / p.shown[1]);
  const slotReport = [];
  for (const index of [0, 2, 3, 5, 7]) {
    await jumpTo(s.win, index);
    await delay(700);
    const box = await s.win.evaluate((i) => {
      const el = document.querySelector(`.page[data-page-index="${i}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const c = el.querySelector('.page-canvas');
      return { w: r.width, h: r.height, cw: c?.width ?? 0, ch: c?.height ?? 0 };
    }, index);
    if (!box) continue;
    const slot = box.w / box.h;
    slotReport.push(`page ${index + 1}: slot ${slot.toFixed(3)} true ${truth[index].toFixed(3)}${Math.abs(slot - truth[index]) > 0.02 ? ' WRONG SHAPE' : ''}`);
  }
  R.info(`viewer page slots after Discard: ${slotReport.join(' | ')}`);
  await shot(s.win, 'j-after-discard-page8');
  R.check('after Discard every page is drawn in a slot of its own shape', slotReport.length > 0 && slotReport.every((x) => !x.includes('WRONG')), slotReport.filter((x) => x.includes('WRONG')).join(' | '));
  await jumpTo(s.win, 1);
  const size = await currentPageSize(s.win);
  R.check('after Discard, page 2 is A4 portrait again (595 x 842)', Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, JSON.stringify(size));
  R.check('after Discard the file on disk is untouched', readFileSync(a.path).equals(original));
  R.check('no console errors (part 1)', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
  await s.close();
  cleanupProfile(profile);

  // ---------- 2. Notes and links through the page operations
  const b = mk('annotated-links.pdf');
  R.info('annotations in the original: ' + JSON.stringify(annotsOnDisk(b.path)));
  s = await launch();
  await s.win.waitForSelector('.empty-state');
  await open(s, b.path, 4);
  await watchToasts(s.win);
  await jumpTo(s.win, 0);
  await toastAfter(s.win, () => s.win.keyboard.press('Control+d')); // page 1 copied -> 5 pages
  await waitForCount(s.win, 5);
  await jumpTo(s.win, 2); // original page 2
  await toastAfter(s.win, () => s.win.keyboard.press('Control+Shift+R'));
  await jumpTo(s.win, 3); // original page 3: crop 1 in all round
  await menu(s.win, 'Pages', 'Crop Pages…');
  let d = sheet(s.win, 'Crop pages');
  await d.getByRole('combobox', { name: 'Units' }).selectOption('in');
  for (const edge of ['Top', 'Bottom', 'Left', 'Right']) await d.getByRole('spinbutton', { name: `${edge} margin` }).fill('0.5');
  await toastAfter(s.win, () => d.getByRole('button', { name: 'Apply' }).click());
  await jumpTo(s.win, 4); // original page 4: resize to A4
  await s.win.locator('.thumb-selected').first().waitFor();
  await palette(s.win, 'Pages: Set page size…');
  d = sheet(s.win, 'Page size');
  await toastAfter(s.win, () => d.getByRole('button', { name: 'Apply' }).click());
  await toastAfter(s.win, () => s.win.keyboard.press('Control+s'));
  await delay(500);
  const disk = annotsOnDisk(b.path);
  R.info('annotations after duplicate(p1), rotate(p2), crop(p3), A4(p4) and save:');
  disk.forEach((row, i) => R.info(`  page ${i + 1}: ${JSON.stringify(row)}`));
  const texts = inspectMupdf(b.path).pages.map((p) => `${p.text} ${JSON.stringify(p.shown)} r${p.rotate}`);
  R.info('pages: ' + JSON.stringify(texts));
  // The fixture has four annotations a page: a note (Text), its Popup, a Highlight and a Link.
  const KINDS = ['Text', 'Popup', 'Highlight', 'Link'];
  const hasAll = (row) => row.length === 4 && KINDS.every((k) => row.some((x) => x.startsWith(k)));
  R.check('the copy of page 1 has its note, popup, highlight and link', hasAll(disk[1]), JSON.stringify(disk[1]));
  R.check('the original page 1 still has all four', hasAll(disk[0]), JSON.stringify(disk[0]));
  R.check('every page keeps its note, popup, highlight and link', disk.every(hasAll), JSON.stringify(disk.map((r) => r.length)));
  R.check('every annotation belongs to the page it sits on', disk.flat().every((x) => !x.includes('P=OTHER')), disk.flat().filter((x) => x.includes('P=OTHER')).join(' ; '));
  R.check('no console errors (part 2)', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'j-failure');
} finally {
  await closeAll();
  for (const c of copies) removeCopy(c);
  process.exitCode = R.summary() ? 1 : 0;
}
