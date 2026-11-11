// Sign-Off 11, C: Extract / Insert / Replace carry links, notes and form boxes (same counts, values intact) on fw9 and
// annotated-links; undo, redo, save; recovery replay of an Insert that carried annotations. Auditor code only.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as mu from 'mupdf';
import { buildPdf, put, dirOf, inspect, render, inkShare, wipe, report, start, closeAll, open, palette, sha, delay, waitFor, isDirty, saveNow, fixture } from '../signoff9/lib9.mjs';
import { launch, placeWindow, forceKill, newProfileDir, cleanupProfile, waitForCount, pageCount, clickRowByIndex, selectAllPages, showPanel } from '../e2e/matrix-lib.mjs';

const R = report('s11-c-carry');

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

async function extractTo(s, out) {
  await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
  await palette(s.win, 'Pages: Extract to a new PDF…');
  await waitFor(() => existsSync(out), { timeoutMs: 30000, label: 'extract written' });
  await delay(800);
}
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

await R.step('C1 Extract', async () => {
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const outDir = dirOf('ext');
    await open(s, FW9, 6);
    await clickRowByIndex(s.win, 0);
    const o1 = join(outDir, 'fw9-p1.pdf');
    await extractTo(s, o1);
    const f1 = facts(o1);
    R.say(`INFO extract fw9 page 1: ${f1.pages.length} page(s), ${f1.pages[0].widgets.length} boxes, form lists ${f1.fields} fields`);
    R.check('fw9 page 1 extracted: 23 form boxes with the same types and values', f1.pages.length === 1 && same(f1.pages[0].widgets, srcF.pages[0].widgets), f1.pages[0].widgets.slice(0, 6));
    const inkS = inkOf(FW9, 0);
    const inkO = inkOf(o1, 0);
    R.check('the extracted page looks the same (ink within 2% of the source page)', Math.abs(inkS - inkO) <= inkS * 0.02, { inkS, inkO });
    R.check('fw9 source unchanged, tab not dirty', sha(FW9) === srcSha[0] && !(await isDirty(s.win)));
    await open(s, ANN, 4);
    await selectAllPages(s.win);
    const o2 = join(outDir, 'ann-all.pdf');
    await extractTo(s, o2);
    const f2 = facts(o2);
    R.check('annotated-links, all 4 pages extracted: same notes and links on every page', same(f2.pages, srcA.pages), f2.pages);
    await clickRowByIndex(s.win, 1);
    const o3 = join(outDir, 'ann-p2.pdf');
    await extractTo(s, o3);
    const f3 = facts(o3);
    R.check('annotated-links page 2 alone: its note, highlight and web link', f3.pages.length === 1 && same(f3.pages[0], srcA.pages[1]), f3.pages);
    R.check('annotated-links source unchanged', sha(ANN) === srcSha[1]);
  } finally { await s.close(); }
});

await R.step('C2 Insert, save, undo, redo, save', async () => {
  const dir = dirOf('ins');
  const host = put(dir, 'Host.pdf', buildPdf({ pages: 3, tag: 'Host' }));
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, host, 3);
    await clickRowByIndex(s.win, 0);
    await insertFrom(s, FW9, /6 pages/, '1', 4);
    await clickRowByIndex(s.win, 1);
    await insertFrom(s, ANN, /4 pages/, '1-4', 8);
    await saveNow(s.win);
    const f = facts(host);
    const t = inspect(host).text.map((x) => x.slice(0, 16));
    R.say(`INFO after insert + save: ${f.pages.length} pages; boxes per page ${JSON.stringify(f.pages.map((p) => p.widgets.length))}; notes ${JSON.stringify(f.pages.map((p) => p.notes.length))}; links ${JSON.stringify(f.pages.map((p) => p.links.length))}; form lists ${f.fields} fields; text ${JSON.stringify(t)}`);
    const wp = f.pages.findIndex((p) => p.widgets.length > 0);
    R.check('the inserted fw9 page holds 23 boxes with the same values', wp === 1 && same(f.pages[1].widgets, srcF.pages[0].widgets), f.pages[wp]?.widgets.slice(0, 5));
    R.check('the four inserted annotated pages hold the same notes and links, in order', same(f.pages.slice(2, 6), srcA.pages), f.pages.slice(2, 6));
    R.check('host pages hold nothing extra', f.pages[0].widgets.length + f.pages[6].widgets.length + f.pages[7].widgets.length + f.pages[0].notes.length + f.pages[7].notes.length === 0);
    const inkS = inkOf(FW9, 0);
    const inkO = inkOf(host, 1);
    R.check('the inserted form page looks the same as the source page (ink within 2%)', Math.abs(inkS - inkO) <= inkS * 0.02, { inkS, inkO });
    // undo both, save, check; redo both, save, check
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 4);
    await s.win.keyboard.press('Control+z');
    await waitForCount(s.win, 3);
    await saveNow(s.win).catch(async () => { R.say('INFO nothing to save after undo (not dirty)'); });
    const u = facts(host);
    R.say(`INFO after undo x2 + save: ${u.pages.length} pages; boxes ${u.pages.reduce((n, p) => n + p.widgets.length, 0)}; notes ${u.pages.reduce((n, p) => n + p.notes.length, 0)}; links ${u.pages.reduce((n, p) => n + p.links.length, 0)}; form lists ${u.fields} fields`);
    R.check('undo of both inserts: 3 host pages, no boxes, notes or links left behind', u.pages.length === 3 && u.pages.every((p) => p.widgets.length + p.notes.length + p.links.length === 0), u.pages);
    R.check('undo: the form lists no orphan fields', u.fields <= 0, u.fields);
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 4);
    await s.win.keyboard.press('Control+y');
    await waitForCount(s.win, 8);
    await saveNow(s.win);
    const r = facts(host);
    R.check('redo of both + save: same boxes, values, notes and links as after the first save', same(r.pages, f.pages), r.pages.map((p) => [p.widgets.length, p.notes.length, p.links.length]));
    R.check('redo: the form lists the same number of fields as after the first save (no doubles)', r.fields === f.fields, { first: f.fields, now: r.fields });
    R.check('sources unchanged', sha(FW9) === srcSha[0] && sha(ANN) === srcSha[1]);
    // the inserted pages can themselves be extracted again with their boxes
    await clickRowByIndex(s.win, 1);
    const again = join(dirOf('ext'), 're-extract.pdf');
    await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, again);
    await palette(s.win, 'Pages: Extract to a new PDF…');
    await waitFor(() => existsSync(again), { timeoutMs: 30000, label: 're-extract' });
    await delay(600);
    R.check('extracting the inserted form page again keeps its 23 boxes and values', same(facts(again).pages[0].widgets, srcF.pages[0].widgets));
  } finally { await s.close(); }
});

await R.step('C3 Replace, undo, redo, save', async () => {
  const dir = dirOf('rep');
  const host = put(dir, 'Host3.pdf', buildPdf({ pages: 3, tag: 'Host' }));
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, host, 3);
    await clickRowByIndex(s.win, 0);
    await replaceWith(s, FW9, /6 pages/, 1);
    await clickRowByIndex(s.win, 1);
    await replaceWith(s, ANN, /4 pages/, 3);
    await saveNow(s.win);
    const f = facts(host);
    R.say(`INFO after replace + save: ${f.pages.length} pages; boxes ${JSON.stringify(f.pages.map((p) => p.widgets.length))}; notes ${JSON.stringify(f.pages.map((p) => p.notes))}; links ${JSON.stringify(f.pages.map((p) => p.links))}`);
    R.check('page 1 replaced by fw9 page 1: 23 boxes, same values', f.pages.length === 3 && same(f.pages[0].widgets, srcF.pages[0].widgets));
    R.check('page 2 replaced by annotated page 3: its note, highlight and link', same(f.pages[1], srcA.pages[2]), f.pages[1]);
    R.check('page 3 is still the host page', inspect(host).text[2] === 'Host 3' && f.pages[2].widgets.length + f.pages[2].notes.length === 0);
    await s.win.keyboard.press('Control+z');
    await delay(1200);
    await s.win.keyboard.press('Control+z');
    await delay(1200);
    await saveNow(s.win).catch(() => R.say('INFO not dirty after undo'));
    const u = facts(host);
    const ut = inspect(host).text;
    R.check('undo of both replaces + save: the three host pages are back, nothing carried is left', same(ut, ['Host 1', 'Host 2', 'Host 3']) && u.pages.every((p) => p.widgets.length + p.notes.length + p.links.length === 0), { ut, u: u.pages });
    await s.win.keyboard.press('Control+y');
    await delay(1200);
    await s.win.keyboard.press('Control+y');
    await delay(1200);
    await saveNow(s.win);
    R.check('redo of both + save: same as after the first save', same(facts(host).pages, f.pages));
  } finally { await s.close(); }
});

await R.step('C4 recovery replay of an Insert that carried annotations', async () => {
  const dir = dirOf('rec');
  const host = put(dir, 'HostR.pdf', buildPdf({ pages: 3, tag: 'Host' }));
  const hostSha = sha(host);
  const profile = newProfileDir();
  let s = await launch({ profile });
  await placeWindow(s, { width: 1300, height: 900 });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, host, 3);
    await clickRowByIndex(s.win, 0);
    await insertFrom(s, FW9, /6 pages/, '1', 4);
    await clickRowByIndex(s.win, 1);
    await insertFrom(s, ANN, /4 pages/, '2-3', 6);
    await delay(2000);
    await forceKill(s.app);
    R.check('the file on disk is unchanged by the crash', sha(host) === hostSha);
    s = await launch({ profile });
    await placeWindow(s, { width: 1300, height: 900 });
    await s.win.waitForSelector('.empty-state', { timeout: 20000 }).catch(() => undefined);
    const bar = s.win.getByText(/Recovered unsaved edits/);
    try { await bar.waitFor({ timeout: 20000 }); } catch {
      await s.setDialogAnswer([host]);
      await s.win.keyboard.press('Control+o');
      await bar.waitFor({ timeout: 30000 });
    }
    R.say(`INFO recovery bar: ${(await bar.first().innerText()).trim()}`);
    await showPanel(s.win, 'Thumbnails');
    await s.win.getByRole('button', { name: 'Keep', exact: true }).click();
    await waitForCount(s.win, 6);
    R.check('recovered: 6 pages, unsaved again, file still unchanged', (await pageCount(s.win)) === 6 && (await isDirty(s.win)) && sha(host) === hostSha);
    await saveNow(s.win);
    const f = facts(host);
    R.say(`INFO after recovery + save: boxes ${JSON.stringify(f.pages.map((p) => p.widgets.length))}; notes ${JSON.stringify(f.pages.map((p) => p.notes.length))}; links ${JSON.stringify(f.pages.map((p) => p.links.length))}; form lists ${f.fields}`);
    R.check('replayed insert of the form page: 23 boxes, same values', f.pages.length === 6 && same(f.pages[1].widgets, srcF.pages[0].widgets), f.pages[1]?.widgets.slice(0, 5));
    R.check('replayed insert of annotated pages 2-3: same notes and links', same(f.pages.slice(2, 4), srcA.pages.slice(1, 3)), f.pages.slice(2, 4));
    const inkS = inkOf(FW9, 0);
    const inkO = inkOf(host, 1);
    R.check('the replayed form page looks the same as the source (ink within 2%)', Math.abs(inkS - inkO) <= inkS * 0.02, { inkS, inkO });
    R.check('sources unchanged', sha(FW9) === srcSha[0] && sha(ANN) === srcSha[1]);
  } finally {
    await s.close();
    cleanupProfile(profile);
  }
});

await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
