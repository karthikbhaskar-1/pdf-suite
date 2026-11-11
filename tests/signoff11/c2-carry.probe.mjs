// Sign-Off 11, C, second run (undo before Save: a save resets the undo history by design; Extract with a longer wait): Extract / Insert / Replace carry links, notes and form boxes (same counts, values intact) on fw9 and
// annotated-links; undo, redo, save; recovery replay of an Insert that carried annotations. Auditor code only.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as mu from 'mupdf';
import { buildPdf, put, dirOf, inspect, render, inkShare, wipe, report, start, closeAll, open, palette, sha, delay, waitFor, isDirty, saveNow, fixture } from '../signoff9/lib9.mjs';
import { launch, placeWindow, forceKill, newProfileDir, cleanupProfile, waitForCount, pageCount, clickRowByIndex, selectAllPages, showPanel } from '../e2e/matrix-lib.mjs';

const R = report('s11-c2-carry');

/** Per page: form boxes as "type=value" (sorted), notes, links. Plus the number of fields the form lists. */
function facts(path) {
  const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  const pdf = doc.asPDF ? doc.asPDF() : doc;
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const widgets = (page.getWidgets ? page.getWidgets() : []).map((w) => `${w.getFieldType()}=${w.getValue?.() ?? ''}`).sort();
    const notes = page.getAnnotations().map((a) => `${a.getType()}:${a.getContents?.() ?? ''}`).filter((t) => !/^Widget|^Link/.test(t)).sort();
    const links = page.getLinks().map((l) => l.getURI());
    pages.push({ widgets, notes, links });
    page.destroy();
  }
  let fields = -1;
  try {
    const form = pdf.getTrailer().get('Root').get('AcroForm');
    fields = form && !form.isNull() ? form.get('Fields').length : 0;
  } catch { fields = -1; }
  doc.destroy();
  return { pages, fields };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inkOf = (path, i) => inkShare(render(path, i, 1));

// fw9 with every text box filled and the first check box ticked
const dir0 = dirOf('src');
const FW9 = join(dir0, 'fw9-filled.pdf');
{
  const pdf = new mu.PDFDocument(readFileSync(join(process.cwd(), 'tests', 'engine', 'corpus', 'irs-fw9', 'fw9.pdf')));
  const page = pdf.loadPage(0);
  let n = 0;
  let ticked = false;
  for (const w of page.getWidgets()) {
    const type = w.getFieldType();
    if (type === 'text') { try { w.setTextValue(`V${++n}x`); } catch { /* comb fields may refuse */ } }
    else if (type === 'checkbox' && !ticked) { w.toggle(); ticked = true; }
    w.update();
  }
  page.update?.();
  put(dir0, 'fw9-filled.pdf', Buffer.from(pdf.saveToBuffer('').asUint8Array().slice()));
}
const ANN = join(dir0, 'annotated-links.pdf');
put(dir0, 'annotated-links.pdf', readFileSync(fixture('annotated-links.pdf')));
const srcF = facts(FW9);
const srcA = facts(ANN);
const srcSha = [sha(FW9), sha(ANN)];
R.say(`INFO fw9-filled: page 1 has ${srcF.pages[0].widgets.length} boxes, ${srcF.pages[0].widgets.filter((w) => /=V\d+x$/.test(w)).length} text values set, ticked ${srcF.pages[0].widgets.filter((w) => /^checkbox=(?!Off$).+/.test(w)).length}; form lists ${srcF.fields} fields; links ${srcF.pages.map((p) => p.links.length)}`);
R.say(`INFO annotated-links: ${JSON.stringify(srcA.pages.map((p) => [p.notes.length, p.links.length]))}`);

async function insertFrom(s, path, pagesText, range, expectCount) {
  await palette(s.win, 'Pages: Insert pages from a PDF…');
  const dialog = s.win.getByRole('dialog', { name: 'Insert from a PDF' });
  await dialog.waitFor();
  await s.setDialogAnswer([path]);
  await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
  await dialog.getByText(pagesText).first().waitFor({ timeout: 20000 });
  await dialog.getByRole('textbox', { name: 'Page range' }).fill(range);
  await dialog.getByRole('combobox', { name: 'Position' }).selectOption('after');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await waitForCount(s.win, expectCount);
  await delay(400);
  if (await dialog.count()) await s.win.keyboard.press('Escape').catch(() => undefined);
  await delay(300);
}
async function replaceWith(s, path, pagesText, pageInPdf) {
  const group = s.win.getByRole('group', { name: 'Pages' });
  await s.setDialogAnswer([path]);
  await group.getByRole('button', { name: 'More page actions' }).click();
  await group.getByRole('menuitem', { name: 'Replace…' }).click();
  const dialog = s.win.getByRole('dialog', { name: 'Replace page' });
  await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
  await dialog.getByText(pagesText).first().waitFor({ timeout: 20000 });
  await dialog.getByRole('spinbutton', { name: 'Page in the PDF' }).fill(String(pageInPdf));
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await s.win.locator('.toast', { hasText: 'Replaced the page' }).first().waitFor({ timeout: 15000 });
  await delay(500);
  if (await dialog.count()) await s.win.keyboard.press('Escape').catch(() => undefined);
  await delay(300);
}


async function extractTo(s, out) {
  await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
  await s.win.keyboard.press('Control+k');
  const dialog = s.win.getByRole('dialog', { name: 'Command palette' });
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByPlaceholder('Type a command').fill('Pages: Extract to a new PDF…');
  await delay(600);
  const first = dialog.getByRole('option').first();
  R.say(`INFO palette top option: ${(await first.innerText().catch(() => '')).replace(/\s+/g, ' ')}; disabled: ${await first.getAttribute('aria-disabled').catch(() => '?')}`);
  await dialog.getByPlaceholder('Type a command').press('Enter');
  try { await waitFor(() => existsSync(out), { timeoutMs: 45000, label: 'extract written' }); } catch { /* reported by the caller */ }
  await delay(800);
  if (await dialog.count()) { R.say('INFO the palette is still open after Enter; closing it'); await s.win.keyboard.press('Escape'); await delay(300); }
  const toasts = await s.win.locator('.toast').allInnerTexts();
  if (toasts.length) R.say(`INFO toasts: ${JSON.stringify(toasts)}`);
  return existsSync(out);
}
const undo = async (s, count) => { await s.win.locator('.thumb').first().focus().catch(() => undefined); await s.win.keyboard.press('Control+z'); await waitForCount(s.win, count); };
const redo = async (s, count) => { await s.win.keyboard.press('Control+y'); await waitForCount(s.win, count); };

await R.step('C1 Extract', async () => {
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const outDir = dirOf('ext');
    await open(s, ANN, 4);
    await selectAllPages(s.win);
    const o2 = join(outDir, 'ann-all.pdf');
    if (R.check('annotated-links, all pages: Extract wrote a file', await extractTo(s, o2))) {
      const f2 = facts(o2);
      R.check('annotated-links, all 4 pages extracted: same notes and links on every page', same(f2.pages, srcA.pages), f2.pages);
    }
    await clickRowByIndex(s.win, 1);
    const o3 = join(outDir, 'ann-p2.pdf');
    if (R.check('annotated-links page 2: Extract wrote a file', await extractTo(s, o3))) {
      const f3 = facts(o3);
      R.check('annotated-links page 2 alone: its note, highlight and web link', f3.pages.length === 1 && same(f3.pages[0], srcA.pages[1]), f3.pages);
    }
    R.check('annotated-links source unchanged', sha(ANN) === srcSha[1]);
    await open(s, FW9, 6);
    await clickRowByIndex(s.win, 0);
    const o1 = join(outDir, 'fw9-p1.pdf');
    if (R.check('fw9 page 1: Extract wrote a file', await extractTo(s, o1))) {
      const f1 = facts(o1);
      R.say(`INFO extract fw9 page 1: ${f1.pages.length} page(s), ${f1.pages[0].widgets.length} boxes, form lists ${f1.fields} fields`);
      R.check('fw9 page 1 extracted: 23 form boxes with the same types and values', f1.pages.length === 1 && same(f1.pages[0].widgets, srcF.pages[0].widgets), f1.pages[0].widgets.slice(0, 6));
      const inkS = inkOf(FW9, 0);
      const inkO = inkOf(o1, 0);
      R.check('the extracted page looks the same (ink within 2% of the source page)', Math.abs(inkS - inkO) <= inkS * 0.02, { inkS, inkO });
    }
    R.check('fw9 source unchanged', sha(FW9) === srcSha[0]);
  } finally { await s.close(); }
});

await R.step('C2 Insert, then undo and redo before saving', async () => {
  const dir = dirOf('ins');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    // A: insert both, undo both: nothing left; the file is as it was
    const hostA = put(dir, 'HostA.pdf', buildPdf({ pages: 3, tag: 'Host' }));
    const shaA = sha(hostA);
    await open(s, hostA, 3);
    await clickRowByIndex(s.win, 0);
    await insertFrom(s, FW9, /6 pages/, '1', 4);
    await clickRowByIndex(s.win, 1);
    await insertFrom(s, ANN, /4 pages/, '1-4', 8);
    await undo(s, 4);
    await undo(s, 3);
    const dirtyA = await isDirty(s.win);
    R.say(`INFO after undoing both inserts: 3 pages, unsaved dot ${dirtyA}`);
    if (dirtyA) await saveNow(s.win);
    const u = facts(hostA);
    R.check('undo of both inserts (then Save if still marked unsaved): 3 host pages, no boxes, notes, links or form fields left behind', u.pages.length === 3 && u.pages.every((p) => p.widgets.length + p.notes.length + p.links.length === 0) && u.fields <= 0 && same(inspect(hostA).text, ['Host 1', 'Host 2', 'Host 3']), { pages: u.pages, fields: u.fields, same: sha(hostA) === shaA });
    // B: insert both, undo both, redo both, save
    const hostB = put(dir, 'HostB.pdf', buildPdf({ pages: 3, tag: 'Host' }));
    await open(s, hostB, 3);
    await clickRowByIndex(s.win, 0);
    await insertFrom(s, FW9, /6 pages/, '1', 4);
    await clickRowByIndex(s.win, 1);
    await insertFrom(s, ANN, /4 pages/, '1-4', 8);
    await undo(s, 4);
    await undo(s, 3);
    await redo(s, 4);
    await redo(s, 8);
    await saveNow(s.win);
    const f = facts(hostB);
    R.say(`INFO insert, undo x2, redo x2, save: boxes ${JSON.stringify(f.pages.map((p) => p.widgets.length))}; notes ${JSON.stringify(f.pages.map((p) => p.notes.length))}; links ${JSON.stringify(f.pages.map((p) => p.links.length))}; form lists ${f.fields} fields`);
    R.check('redo: the form page holds 23 boxes with the same values (no doubles)', f.pages.length === 8 && same(f.pages[1].widgets, srcF.pages[0].widgets) && f.pages.reduce((n, p) => n + p.widgets.length, 0) === 23);
    R.check('redo: the four annotated pages hold the same notes and links, in order', same(f.pages.slice(2, 6), srcA.pages), f.pages.slice(2, 6));
    const inkS = inkOf(FW9, 0);
    R.check('redo: the form page looks the same as the source page (ink within 2%)', Math.abs(inkS - inkOf(hostB, 1)) <= inkS * 0.02);
    // C: insert both, undo the second only, save
    const hostC = put(dir, 'HostC.pdf', buildPdf({ pages: 3, tag: 'Host' }));
    await open(s, hostC, 3);
    await clickRowByIndex(s.win, 0);
    await insertFrom(s, FW9, /6 pages/, '1', 4);
    await clickRowByIndex(s.win, 1);
    await insertFrom(s, ANN, /4 pages/, '1-4', 8);
    await undo(s, 4);
    await saveNow(s.win);
    const c = facts(hostC);
    R.check('undo of the second insert only, then Save: 4 pages, the form page keeps its 23 boxes and values, no notes or links left', c.pages.length === 4 && same(c.pages[1].widgets, srcF.pages[0].widgets) && c.pages.every((p) => p.notes.length + p.links.length === 0), c.pages.map((p) => [p.widgets.length, p.notes.length, p.links.length]));
    // the saved inserted form page can be extracted again
    await clickRowByIndex(s.win, 1);
    const again = join(dirOf('ext'), 're-extract.pdf');
    if (R.check('re-extract of the inserted form page wrote a file', await extractTo(s, again))) R.check('extracting the inserted form page again keeps its 23 boxes and values', same(facts(again).pages[0].widgets, srcF.pages[0].widgets));
    R.check('sources unchanged', sha(FW9) === srcSha[0] && sha(ANN) === srcSha[1]);
  } finally { await s.close(); }
});

await R.step('C3 Replace, then undo and redo before saving', async () => {
  const dir = dirOf('rep');
  const host = put(dir, 'Host3.pdf', buildPdf({ pages: 3, tag: 'Host' }));
  const hostSha = sha(host);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, host, 3);
    await clickRowByIndex(s.win, 0);
    await replaceWith(s, FW9, /6 pages/, 1);
    await clickRowByIndex(s.win, 1);
    await replaceWith(s, ANN, /4 pages/, 3);
    await s.win.locator('.thumb').first().focus().catch(() => undefined);
    await s.win.keyboard.press('Control+z');
    await delay(1500);
    await s.win.keyboard.press('Control+z');
    await delay(1500);
    const dirty = await isDirty(s.win);
    R.say(`INFO after undoing both replaces: unsaved dot ${dirty}`);
    if (dirty) await saveNow(s.win);
    const u = facts(host);
    const ut = inspect(host).text;
    R.check('undo of both replaces (then Save if still marked unsaved): the three host pages are back, nothing carried is left', same(ut, ['Host 1', 'Host 2', 'Host 3']) && u.pages.every((p) => p.widgets.length + p.notes.length + p.links.length === 0) && u.fields <= 0, { ut: ut.map((t) => t.slice(0, 20)), u: u.pages.map((p) => [p.widgets.length, p.notes.length, p.links.length]), fields: u.fields, bytesSame: sha(host) === hostSha });
    // again on a fresh copy: replace both, undo both, redo both, save
    const host2 = put(dir, 'Host4.pdf', buildPdf({ pages: 3, tag: 'Host' }));
    await open(s, host2, 3);
    await clickRowByIndex(s.win, 0);
    await replaceWith(s, FW9, /6 pages/, 1);
    await clickRowByIndex(s.win, 1);
    await replaceWith(s, ANN, /4 pages/, 3);
    await s.win.locator('.thumb').first().focus().catch(() => undefined);
    for (const k of ['Control+z', 'Control+z', 'Control+y', 'Control+y']) { await s.win.keyboard.press(k); await delay(1500); }
    await saveNow(s.win);
    const f = facts(host2);
    R.check('replace both, undo both, redo both, Save: page 1 has the 23 boxes and values, page 2 the note, highlight and link, page 3 is the host page', f.pages.length === 3 && same(f.pages[0].widgets, srcF.pages[0].widgets) && same(f.pages[1], srcA.pages[2]) && inspect(host2).text[2] === 'Host 3', f.pages.map((p) => [p.widgets.length, p.notes.length, p.links.length]));
  } finally { await s.close(); }
});

await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
