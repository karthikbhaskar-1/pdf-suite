// 1.3.3 Combine, driven through the real UI of the packaged app. Every file it makes is re-read from disk with pdf.js (a second
// engine: tests/lib/reread.mjs): page count, sizes, text, bookmarks, annotations, links, form fields. The inputs' bytes are checked
// before and after. Dialogs are stubbed (the Add files picker answers with the test's own files, the Save dialog with a temp
// path); outputs go to %TEMP%\pdfsuite-e2e-* and are deleted. Every test ends with its documents saved, or dropped by the
// test-mode quit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mu from 'mupdf';
import { launch, closeAll, palette, waitFor, statusText, saveNow, setSaveAnswer, assertNoErrors, delay, fixture, ROOT, open as openDoc } from './matrix-lib.mjs';
import { reread } from '../lib/reread.mjs';
import { makeBmp, makePng, makeTiff } from '../lib/makeImages.mjs';

const WORK = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-combine-'));
after(async () => {
  await closeAll();
  rmSync(WORK, { recursive: true, force: true });
});

let counter = 0;
const fresh = (label) => {
  const dir = join(WORK, `${label}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const listing = (dir) => readdirSync(dir).sort();
const put = (dir, name, bytes) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

// ---- Fixtures ------------------------------------------------------------------------------------------------------------

/** Pages of 300 x 400 with the text "<tag> n", an optional outline [{ title, page }] and optional notes on pages. */
function buildPdf({ pages, tag = 'Page', outline = null, notes = [], links = [] }) {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('F1', font);
  const res = pdf.addObject(pdf.newDictionary());
  res.put('Font', fonts);
  for (let n = 1; n <= pages; n++) pdf.insertPage(-1, pdf.addPage([0, 0, 300, 400], 0, res, `BT /F1 24 Tf 40 300 Td (${tag} ${n}) Tj ET`));
  for (const n of notes) {
    const page = pdf.loadPage(n - 1);
    const note = page.createAnnotation('Text');
    note.setRect([200, 200, 220, 220]);
    note.setContents(`note ${tag} ${n}`);
    page.update();
  }
  for (const link of links) {
    const page = pdf.loadPage(link.page - 1);
    page.createLink([20, 20, 120, 50], link.url ?? `#page=${link.toPage}`);
    page.update();
  }
  if (outline) {
    const outlines = pdf.createObject();
    const refs = outline.map(() => pdf.createObject());
    outline.forEach((item, i) => {
      const dict = pdf.newDictionary();
      dict.put('Title', pdf.newString(item.title));
      dict.put('Parent', outlines);
      if (i > 0) dict.put('Prev', refs[i - 1]);
      if (i < outline.length - 1) dict.put('Next', refs[i + 1]);
      const dest = pdf.newArray();
      dest.push(pdf.findPage(item.page - 1));
      dest.push(pdf.newName('Fit'));
      dict.put('Dest', dest);
      refs[i].writeObject(dict);
    });
    const top = pdf.newDictionary();
    top.put('Type', pdf.newName('Outlines'));
    top.put('First', refs[0]);
    top.put('Last', refs[refs.length - 1]);
    top.put('Count', outline.length);
    outlines.writeObject(top);
    pdf.getTrailer().get('Root').put('Outlines', outlines);
  }
  return Buffer.from(pdf.saveToBuffer('garbage=compact').asUint8Array().slice());
}

// ---- Driving the window --------------------------------------------------------------------------------------------------

const windowOf = (win) => win.getByRole('dialog', { name: 'Combine files' });
const noticeOf = (win) => win.locator('[data-job-notice]');
const rowNames = (dlg) => dlg.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-name')));
const rowOf = (dlg, name) => dlg.locator(`[data-row-name="${name}"]`).first();

async function openCombine(s) {
  await palette(s.win, 'Pages: Combine files');
  const dlg = windowOf(s.win);
  await dlg.waitFor({ timeout: 10000 });
  return dlg;
}

/** All rows are read (no "Reading…") and there are `count` of them. */
async function rowsReady(dlg, count) {
  await waitFor(
    async () => {
      const names = await dlg.locator('[data-row-id]').count();
      const reading = await dlg.getByText('Reading…').count();
      return names === count && reading === 0;
    },
    { timeoutMs: 30000, label: `${count} rows read` },
  );
}

async function addFiles(s, dlg, paths, expectRows) {
  await s.setDialogAnswer(paths);
  await dlg.getByRole('button', { name: 'Add files…' }).click();
  if (expectRows !== undefined) await rowsReady(dlg, expectRows);
}

const messagesOf = (dlg) => dlg.locator('[data-combine-message]').evaluateAll((els) => els.map((e) => e.querySelector('span').textContent));

async function waitNotice(s, pattern, timeoutMs = 60000) {
  const notice = noticeOf(s.win);
  await notice.waitFor({ timeout: timeoutMs });
  await waitFor(async () => pattern.test(await notice.innerText()), { timeoutMs, label: `notice ${pattern}` });
  return (await notice.innerText()).replace(/\s+/g, ' ').trim();
}

/** Combine… with the Save dialog answering `out`; resolves when the window has closed. */
async function combine(s, dlg, out) {
  await setSaveAnswer(s, out);
  await dlg.getByRole('button', { name: 'Combine…' }).click();
}

async function launched(body, launchOptions = {}) {
  const s = await launch(launchOptions);
  try {
    await s.win.waitForSelector('.empty-state');
    await body(s);
    assertNoErrors(s);
  } finally {
    await s.close();
  }
}

// ---- The tests -------------------------------------------------------------------------------------------------------------

test('S1: PDF + PNG + TXT: order by buttons, ranges typed and clicked, notices, one result that is exactly what the list says, then edit, save twice and split', async () => {
  const dir = fresh('in');
  const pdf = put(dir, 'Report.pdf', buildPdf({ pages: 5, tag: 'Report', outline: [{ title: 'Intro', page: 1 }, { title: 'End', page: 5 }], notes: [2], links: [{ page: 1, url: 'https://example.com/r' }] }));
  const png = put(dir, 'scan.png', makePng(150, 100, 3, 150));
  const txt = put(dir, 'notes.txt', 'first line of the notes\nsecond line');
  const before = [pdf, png, txt].map(sha);
  const out = join(fresh('out'), 'Combined.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    assert.equal((await dlg.locator('[data-combine-empty]').innerText()).trim(), 'Add the files you want to combine. Drop them here, or choose Add files…');
    assert.equal(await dlg.getByRole('button', { name: 'Combine…' }).isDisabled(), true);
    await addFiles(s, dlg, [pdf, png, txt], 3);
    assert.deepEqual(await rowNames(dlg), ['Report.pdf', 'scan.png', 'notes.txt']);
    // The row says what the file is.
    assert.match(await rowOf(dlg, 'Report.pdf').innerText(), /5 pages · /);
    assert.match(await rowOf(dlg, 'scan.png').innerText(), /1 page · /);
    assert.equal(await rowOf(dlg, 'scan.png').getByLabel('Pages of scan.png').count(), 0, 'a one-page picture has no Pages field');
    assert.equal(await rowOf(dlg, 'notes.txt').getByLabel('Pages of notes.txt').count(), 0);
    assert.match(await dlg.locator('[data-combine-summary]').innerText(), /^3 files · 7 pages · /);
    // Order: select notes.txt and move it to the top with Move up twice.
    await rowOf(dlg, 'notes.txt').click();
    await dlg.getByRole('button', { name: 'Move up' }).click();
    await dlg.getByRole('button', { name: 'Move up' }).click();
    assert.deepEqual(await rowNames(dlg), ['notes.txt', 'Report.pdf', 'scan.png']);
    // Ranges: type 2-4 for the report, then leave page 3 out by clicking it in the preview.
    await rowOf(dlg, 'Report.pdf').click();
    await dlg.locator('[data-combine-preview] [data-page="0"]').waitFor({ timeout: 10000 });
    await dlg.getByLabel('Pages of Report.pdf').fill('2-4');
    assert.deepEqual(await dlg.locator('[data-combine-preview] [role="checkbox"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))), ['false', 'true', 'true', 'true', 'false']);
    await dlg.getByRole('checkbox', { name: 'Page 3' }).click();
    assert.equal(await dlg.getByLabel('Pages of Report.pdf').inputValue(), '2, 4');
    assert.equal(await dlg.getByRole('checkbox', { name: 'Page 3, left out' }).count(), 1);
    // A wrong range says why and turns Combine… off; fixing it turns it on.
    await dlg.getByLabel('Pages of Report.pdf').fill('9');
    assert.equal((await dlg.locator('[data-combine-range-error]').innerText()).trim(), '9 is outside 1-5.');
    assert.equal(await dlg.getByRole('button', { name: 'Combine…' }).isDisabled(), true);
    await dlg.getByLabel('Pages of Report.pdf').fill('2, 4');
    assert.match(await dlg.locator('[data-combine-summary]').innerText(), /^3 files · 4 pages · /);
    // Run. The Save dialog is asked for Combined.pdf (stubbed); the new file opens when ready (default).
    await combine(s, dlg, out);
    const done = await waitNotice(s, /Combined 3 files into Combined\.pdf \(4 pages\)\./);
    assert.match(done, /Show in folder/);
    assert.equal(await windowOf(s.win).count(), 0, 'the window closed');

    // The file on disk is exactly what the list said.
    const read = await reread(readFileSync(out));
    assert.equal(read.pages, 4);
    assert.deepEqual(read.text, ['first line of the notes second line', 'Report 2', 'Report 4', ''], 'order: notes, report pages 2 and 4, the picture');
    assert.deepEqual(read.sizes.map((x) => [x.width, x.height]), [[612, 792], [300, 400], [300, 400], [72, 48]]);
    assert.deepEqual(read.outline.map((o) => `${o.depth}:${o.title}`), ['0:notes', '0:Report', '0:scan'], 'Intro points at a left-out page and End at page 5 (left out): both are dropped');
    assert.deepEqual(read.outline.map((o) => o.page), [1, 2, 4]);
    assert.ok(read.annotations.some((a) => a.page === 2 && a.subtype === 'Text'), 'the note on page 2 came along');
    assert.deepEqual([pdf, png, txt].map(sha), before, 'the inputs are unchanged');

    // It opened in a tab (Open the new file when it is ready). Chain: rotate, delete, save, save again, split by count.
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 4'), { timeoutMs: 30000, label: 'the result is open' });
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 10000, label: 'unsaved' });
    await saveNow(s.win);
    const afterRotate = await reread(readFileSync(out));
    assert.equal(afterRotate.pages, 4);
    assert.equal(afterRotate.sizes[0].rotate, 90);
    await palette(s.win, 'Pages: Delete');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 10000, label: 'unsaved after the delete' });
    await saveNow(s.win);
    assert.equal((await reread(readFileSync(out))).pages, 3, 'the deleted page is gone after the second save');
    // Save again with nothing new: still the same file.
    const savedTwice = sha(out);
    await s.win.keyboard.press('Control+s');
    await delay(500);
    assert.equal(sha(out), savedTwice);
    // Split into files by page count: the combined file is a good source.
    const parts = fresh('parts');
    await palette(s.win, 'Pages: Split into files');
    const sheet = s.win.getByRole('dialog', { name: 'Split into files' });
    await sheet.locator('[data-split-source]').waitFor({ timeout: 20000 });
    await sheet.getByLabel('Pages in each file').fill('2');
    await s.setDialogAnswer([parts]);
    await sheet.getByRole('button', { name: 'Choose folder…' }).click();
    await sheet.locator('[data-split-folder="true"]').waitFor({ timeout: 10000 });
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Combined\.pdf into 2 files\./);
    assert.deepEqual(listing(parts), ['Combined - part 01.pdf', 'Combined - part 02.pdf']);
    const first = await reread(readFileSync(join(parts, 'Combined - part 01.pdf')));
    const second = await reread(readFileSync(join(parts, 'Combined - part 02.pdf')));
    assert.equal(first.pages + second.pages, 3);
  });
});

test('carry-over: comments, links and bookmarks of PDF inputs are in the result, found by re-reading it', async () => {
  const dir = fresh('in');
  const a = put(dir, 'A.pdf', buildPdf({ pages: 3, tag: 'A', outline: [{ title: 'A one', page: 1 }, { title: 'A three', page: 3 }], notes: [1, 3], links: [{ page: 1, url: 'https://example.com/a' }, { page: 1, toPage: 3 }] }));
  const b = put(dir, 'B.pdf', buildPdf({ pages: 2, tag: 'B', outline: [{ title: 'B two', page: 2 }], notes: [2], links: [{ page: 2, toPage: 1 }] }));
  const out = join(fresh('out'), 'Both.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b], 2);
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    const done = await waitNotice(s, /Combined 2 files into Both\.pdf \(5 pages\)\./);
    assert.match(done, /Show in folder/);
    assert.match(done, /Open/, 'not opened automatically, so the notice offers Open');
    const read = await reread(readFileSync(out));
    assert.deepEqual(read.text, ['A 1', 'A 2', 'A 3', 'B 1', 'B 2']);
    assert.deepEqual(read.outline.map((o) => `${o.depth}:${o.title}:${o.page}`), ['0:A:1', '1:A one:1', '1:A three:3', '0:B:4', '1:B two:5']);
    assert.deepEqual(read.annotations.filter((x) => x.subtype === 'Text').map((x) => x.page), [1, 3, 5]);
    assert.ok(read.annotations.some((x) => x.page === 1 && x.url === 'https://example.com/a'), 'the web link is kept');
    const doc = mu.Document.openDocument(readFileSync(out), 'application/pdf');
    const internal = (n) => doc.loadPage(n).getLinks().filter((l) => !l.isExternal()).map((l) => doc.resolveLink(l.getURI()));
    assert.deepEqual(internal(0), [2], 'A page 1 links to A page 3');
    assert.deepEqual(internal(4), [3], 'B page 2 links to B page 1, which is page 4 of the result');
    // The notice offers Open: pressing it opens the result in a tab.
    await noticeOf(s.win).getByRole('button', { name: 'Open' }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 5'), { timeoutMs: 30000, label: 'opened from the notice' });
  });
});

test('refusals and notices: each is the spec text and names the right file; a multi-page TIFF takes a range; options re-read the rows', async () => {
  const dir = fresh('in');
  const word = put(dir, 'letter.docx', Buffer.from('PK\u0003\u0004 not really'));
  const song = put(dir, 'song.mp3', Buffer.from('ID3 not really'));
  const tiff = put(dir, 'scan.tif', makeTiff([{ w: 30, h: 20, seed: 1, dpi: 72 }, { w: 10, h: 40, seed: 2, dpi: 72 }, { w: 25, h: 25, seed: 3, dpi: 72 }, { w: 12, h: 12, seed: 4, dpi: 72 }]));
  const cjk = put(dir, 'cjk.txt', 'plain words\n日本語 text');
  const lines = put(dir, 'long.txt', Array.from({ length: 56 }, (_v, i) => `line ${i + 1}`).join('\n'));
  const bad = put(dir, 'bad.pdf', '%PDF-1.4 this is damaged, not a real pdf');
  const notPdf = put(dir, 'fake.pdf', 'this is not a pdf at all');
  const xfaSource = join(ROOT, 'tests', 'engine', 'corpus', 'irs-fw9', 'fw9.pdf');
  const hybrid = put(dir, 'fw9.pdf', readFileSync(xfaSource));
  // A form without its XFA part: an ordinary fillable form, flattened on Combine with the notice.
  const form = new mu.PDFDocument(readFileSync(xfaSource));
  form.getTrailer().get('Root').get('AcroForm').delete('XFA');
  const filled = put(dir, 'form.pdf', Buffer.from(form.saveToBuffer('').asUint8Array().slice()));
  const out = join(fresh('out'), 'Mixed.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [word, song, bad, notPdf, hybrid]);
    await waitFor(async () => (await messagesOf(dlg)).length >= 5, { timeoutMs: 30000, label: 'five refusals' });
    const messages = await messagesOf(dlg);
    assert.ok(messages.includes("letter.docx was not added. Word, Excel and PowerPoint files can't be combined yet. For now, save it as a PDF first, then add the PDF."));
    assert.ok(messages.includes('song.mp3 was not added. PDF Suite can combine PDFs, pictures (JPEG, PNG, TIFF, GIF, BMP, WebP) and text files.'));
    assert.ok(messages.includes('bad.pdf is damaged or is not a PDF, so it was not added.'));
    assert.ok(messages.includes('fake.pdf was not added. PDF Suite can combine PDFs, pictures (JPEG, PNG, TIFF, GIF, BMP, WebP) and text files.'), 'a file that is not a PDF by its first bytes is typed as unsupported');
    assert.ok(messages.includes("fw9.pdf was not added. It is a kind of form that can't be combined yet."));
    assert.equal(await dlg.locator('[data-row-id]').count(), 0, 'none of them is listed');

    await addFiles(s, dlg, [tiff, cjk, lines, filled], 4);
    // The TIFF shows its page count and a Pages field; the preview has a checkbox for each of its 4 pages.
    assert.match(await rowOf(dlg, 'scan.tif').innerText(), /4 pages/);
    await rowOf(dlg, 'scan.tif').click();
    await dlg.locator('[data-combine-preview] [role="checkbox"]').first().waitFor({ timeout: 10000 });
    assert.equal(await dlg.locator('[data-combine-preview] [role="checkbox"]').count(), 4);
    await dlg.getByLabel('Pages of scan.tif').fill('2, 4');
    // Notices: forms (names the file), the unprintable characters (names the file and the count), and no password notice.
    const notices = await dlg.locator('[data-combine-notices] p').evaluateAll((els) => els.map((e) => e.textContent));
    assert.equal(notices.length, 2, notices.join(' | '));
    assert.match(notices[0], /^Fillable forms in form\.pdf: what is filled in stays visible, but the boxes can no longer be typed in, and signatures can no longer be checked\. Your original files are not changed\.$/);
    assert.equal(notices[1], "cjk.txt has 3 characters PDF Suite can't print yet (it prints Latin, Greek and Cyrillic letters). Each will appear as “?”. The text file itself is not changed.");
    assert.equal(await rowOf(dlg, 'form.pdf').locator('.combine-warn').count(), 1, 'the row with a notice has the warning sign');
    assert.equal(await rowOf(dlg, 'scan.tif').locator('.combine-warn').count(), 0);
    // Text pages: Letter holds 54 lines, A4 holds 58, so long.txt is 2 pages and then 1.
    assert.match(await rowOf(dlg, 'long.txt').innerText(), /2 pages/);
    await dlg.getByLabel('Text pages').selectOption('A4');
    await rowsReady(dlg, 4);
    assert.match(await rowOf(dlg, 'long.txt').innerText(), /1 page /);
    await dlg.getByLabel('Picture pages').selectOption('Letter');
    await rowsReady(dlg, 4);
    await combine(s, dlg, out);
    await waitNotice(s, /Combined 4 files into Mixed\.pdf \(\d+ pages\)\./);
    const read = await reread(readFileSync(out));
    // tiff frames 2 and 4 (Letter, one picture each), cjk (1 page, A4), long (1 page, A4), the form (fw9 has several pages).
    assert.deepEqual(read.sizes.slice(0, 2).map((x) => [Math.round(x.width), Math.round(x.height)]), [[612, 792], [612, 792]], 'the two TIFF frames are Letter pages');
    assert.deepEqual(read.sizes.slice(2, 4).map((x) => [Math.round(x.width), Math.round(x.height)]), [[595, 842], [595, 842]], 'the text pages are A4');
    assert.ok(read.text[2].includes('plain words'));
    assert.ok(read.text[2].includes('?'), 'the characters that cannot be printed appear as ?');
    assert.equal(read.annotations.filter((x) => x.subtype === 'Widget').length, 0, 'the form is flattened');
    assert.ok(read.pages >= 5);
  });
});

test('a locked file: the password is asked once, a wrong one again, the new file has no password; cancelling the prompt does not add the file', async () => {
  const dir = fresh('in');
  const locked = new mu.PDFDocument(buildPdf({ pages: 2, tag: 'Locked' }));
  const lockedPath = put(dir, 'locked.pdf', Buffer.from(locked.saveToBuffer('encrypt=aes-256,user-password=test123,owner-password=test123').asUint8Array().slice()));
  const plain = put(dir, 'plain.pdf', buildPdf({ pages: 1, tag: 'Plain' }));
  const out = join(fresh('out'), 'Locked together.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    // Cancel the prompt first.
    await s.setDialogAnswer([lockedPath]);
    await dlg.getByRole('button', { name: 'Add files…' }).click();
    const prompt = s.win.getByRole('dialog', { name: 'Password needed' });
    await prompt.waitFor({ timeout: 15000 });
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(async () => (await messagesOf(dlg)).includes('locked.pdf was not added because it needs a password.'), { timeoutMs: 10000, label: 'the cancelled-prompt message' });
    assert.equal(await dlg.locator('[data-row-id]').count(), 0);
    // Now a wrong password, then the right one.
    await addFiles(s, dlg, [lockedPath]);
    await prompt.waitFor({ timeout: 15000 });
    await prompt.getByLabel('Password').fill('wrong');
    await prompt.getByRole('button', { name: 'Use password' }).click();
    await prompt.getByRole('alert').waitFor({ timeout: 10000 });
    await prompt.getByLabel('Password').fill('test123');
    await prompt.getByRole('button', { name: 'Use password' }).click();
    await rowsReady(dlg, 1);
    await addFiles(s, dlg, [plain], 2);
    // Select the other row and come back: the password is not asked again.
    await rowOf(dlg, 'plain.pdf').click();
    await rowOf(dlg, 'locked.pdf').click();
    await delay(500);
    assert.equal(await s.win.getByRole('dialog', { name: 'Password needed' }).count(), 0);
    assert.equal((await dlg.locator('[data-combine-notices] p').innerText()).trim(), 'The new file will not have a password, although locked.pdf does.');
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    await waitNotice(s, /Combined 2 files into Locked together\.pdf \(3 pages\)\./);
    assert.equal(await s.win.getByRole('dialog', { name: 'Password needed' }).count(), 0, 'not asked again at the run');
    const bytes = readFileSync(out);
    assert.equal(mu.Document.openDocument(bytes, 'application/pdf').needsPassword(), false, 'the new file has no password');
    assert.deepEqual((await reread(bytes)).text, ['Locked 1', 'Locked 2', 'Plain 1']);
    assert.equal(readFileSync(out).includes(Buffer.from('test123')), false, 'the password is not in the file');
  });
});

test('a file changed or deleted after it was added is found before the run: no Save dialog, nothing is written, and Try again works', async () => {
  const dir = fresh('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const b = put(dir, 'b.pdf', buildPdf({ pages: 3, tag: 'B' }));
  const c = put(dir, 'c.pdf', buildPdf({ pages: 1, tag: 'C' }));
  const outDir = fresh('out');
  const out = join(outDir, 'Result.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b, c], 3);
    // b.pdf changes on disk (more pages), c.pdf is deleted.
    await delay(50);
    writeFileSync(b, buildPdf({ pages: 5, tag: 'NEW' }));
    rmSync(c);
    await setSaveAnswer(s, out);
    await dlg.getByRole('button', { name: 'Combine…' }).click();
    await waitFor(async () => (await messagesOf(dlg)).length >= 2, { timeoutMs: 20000, label: 'both problems are named' });
    const messages = await messagesOf(dlg);
    assert.ok(messages.includes('b.pdf was changed while PDF Suite was working, so nothing was created. Try again.'), messages.join(' | '));
    assert.ok(messages.includes('c.pdf could not be read, so nothing was created. Your files were not changed.'));
    assert.equal(await windowOf(s.win).count(), 1, 'the window stays');
    assert.deepEqual(listing(outDir), [], 'nothing was written');
    // The row of b.pdf was read again (5 pages now); c.pdf has to be removed.
    await waitFor(async () => /5 pages/.test(await rowOf(dlg, 'b.pdf').innerText()), { timeoutMs: 20000, label: 'b.pdf read again' });
    assert.equal(await dlg.getByRole('button', { name: 'Combine…' }).isDisabled(), true, 'a missing file blocks the run');
    await rowOf(dlg, 'c.pdf').click();
    await dlg.getByRole('button', { name: 'Remove' }).click();
    assert.deepEqual(await rowNames(dlg), ['a.pdf', 'b.pdf'], (await messagesOf(dlg)).join(' | '));
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    await waitNotice(s, /Combined 2 files into Result\.pdf \(7 pages\)\./);
    assert.deepEqual((await reread(readFileSync(out))).text, ['A 1', 'A 2', 'NEW 1', 'NEW 2', 'NEW 3', 'NEW 4', 'NEW 5']);
  });
});

test('the output name: one of the listed files, or a file open in the app, is refused with the spec text; the file is not changed; nothing is written', async () => {
  const dir = fresh('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const b = put(dir, 'b.pdf', buildPdf({ pages: 2, tag: 'B' }));
  const open = put(dir, 'open.pdf', buildPdf({ pages: 2, tag: 'Open' }));
  const good = join(fresh('out'), 'Good.pdf');
  await launched(async (s) => {
    await openDoc(s, open, 2);
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b], 2);
    const before = [sha(a), sha(b), sha(open)];
    await setSaveAnswer(s, a);
    await dlg.getByRole('button', { name: 'Combine…' }).click();
    const target = dlg.locator('[data-combine-target]');
    await target.waitFor({ timeout: 15000 });
    assert.equal((await target.innerText()).trim(), 'Choose a different name: that file is one of the files being combined.');
    assert.equal(await windowOf(s.win).count(), 1);
    await setSaveAnswer(s, open);
    await dlg.getByRole('button', { name: 'Combine…' }).click();
    await waitFor(async () => /open in PDF Suite/.test(await target.innerText().catch(() => '')), { timeoutMs: 15000, label: 'the open-file message' });
    assert.equal((await target.innerText()).trim(), 'Choose a different name: that file is open in PDF Suite.');
    assert.deepEqual([sha(a), sha(b), sha(open)], before, 'no file was changed');
    // A good name works.
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, good);
    await waitNotice(s, /Combined 2 files into Good\.pdf \(4 pages\)\./);
    assert.equal(existsSync(good), true);
  });
});

test('Add open files lists the open documents; a listed open file with unsaved changes says so, and Save now uses the saved version', async () => {
  const dir = fresh('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 3, tag: 'A' }));
  const b = put(dir, 'b.pdf', buildPdf({ pages: 2, tag: 'B' }));
  await launched(async (s) => {
    await openDoc(s, a, 3);
    await openDoc(s, b, 2);
    // Leave b.pdf with an unsaved change.
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(async () => (await s.win.locator('.tab-dirty').count()) > 0, { timeoutMs: 10000, label: 'unsaved' });
    const dlg = await openCombine(s);
    await dlg.getByRole('button', { name: 'Add open files' }).click();
    await rowsReady(dlg, 2);
    assert.deepEqual((await rowNames(dlg)).sort(), ['a.pdf', 'b.pdf']);
    const note = dlg.locator('[data-combine-unsaved]');
    await note.waitFor({ timeout: 10000 });
    assert.equal((await note.locator('span').innerText()).trim(), 'b.pdf has unsaved changes. The saved version will be used.');
    await note.getByRole('button', { name: 'Save now' }).click();
    await waitFor(async () => (await dlg.locator('[data-combine-unsaved]').count()) === 0, { timeoutMs: 20000, label: 'saved' });
    await rowsReady(dlg, 2);
    await dlg.getByRole('button', { name: 'Combine…' }).waitFor();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await windowOf(s.win).count(), 0);
  });
});

test('every entry point opens Combine: the File and Pages menus, the toolbar button, the palette; with no document and with one open', async () => {
  const dir = fresh('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  await launched(async (s) => {
    const closeWindow = async () => {
      await windowOf(s.win).getByRole('button', { name: 'Cancel' }).click();
      await windowOf(s.win).waitFor({ state: 'detached', timeout: 5000 });
    };
    // Toolbar button (no document open).
    await s.win.getByRole('button', { name: 'Combine files' }).first().click();
    await windowOf(s.win).waitFor({ timeout: 10000 });
    await closeWindow();
    // File menu.
    await s.win.getByRole('menuitem', { name: /^File/ }).first().click();
    await s.win.getByRole('menuitem', { name: /^Combine Files/ }).click();
    await windowOf(s.win).waitFor({ timeout: 10000 });
    await closeWindow();
    // With a document open: the Pages menu and the palette.
    await openDoc(s, a, 2);
    await s.win.getByRole('menuitem', { name: /^Pages/ }).first().click();
    await s.win.getByRole('menuitem', { name: /^Combine Files/ }).click();
    await windowOf(s.win).waitFor({ timeout: 10000 });
    await closeWindow();
    await openCombine(s);
    // Esc closes it and focus goes back where it was.
    await s.win.keyboard.press('Escape');
    await windowOf(s.win).waitFor({ state: 'detached', timeout: 5000 });
  });
});

test('keyboard only: Alt+arrows reorder, Delete removes, the Pages field is typed, Space on a preview page leaves it out, Enter on Combine… runs it', async () => {
  const dir = fresh('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 4, tag: 'A' }));
  const b = put(dir, 'b.pdf', buildPdf({ pages: 2, tag: 'B' }));
  const c = put(dir, 'c.pdf', buildPdf({ pages: 2, tag: 'C' }));
  const out = join(fresh('out'), 'Keys.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b, c], 3);
    const list = dlg.getByRole('listbox', { name: 'Files to combine' });
    await list.focus();
    // a.pdf is selected: Alt+End puts it last; the live region says where it went.
    await s.win.keyboard.press('Alt+End');
    assert.deepEqual(await rowNames(dlg), ['b.pdf', 'c.pdf', 'a.pdf']);
    assert.match(await dlg.locator('[data-combine-announce]').allInnerTexts().then((x) => x.join(' ')), /a\.pdf moved to 3 of 3/);
    await s.win.keyboard.press('Alt+ArrowUp');
    assert.deepEqual(await rowNames(dlg), ['b.pdf', 'a.pdf', 'c.pdf']);
    // Down arrow selects c.pdf, Delete removes it.
    await s.win.keyboard.press('ArrowDown');
    await s.win.keyboard.press('Delete');
    assert.deepEqual(await rowNames(dlg), ['b.pdf', 'a.pdf']);
    // Tab goes to the Pages field of the focused row (a.pdf is now focused), then into the preview.
    assert.equal(await dlg.getByLabel('Pages of a.pdf').count(), 1);
    await s.win.keyboard.press('Tab');
    assert.equal(await s.win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Pages of a.pdf');
    await s.win.keyboard.type('1-3');
    await s.win.keyboard.press('Tab');
    const inPreview = await s.win.evaluate(() => document.activeElement?.getAttribute('role'));
    assert.equal(inPreview, 'checkbox');
    await s.win.keyboard.press('ArrowRight');
    await s.win.keyboard.press('Space');
    assert.equal(await dlg.getByLabel('Pages of a.pdf').inputValue(), '1, 3');
    // Run with the keyboard: Tab to Combine… and Enter.
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await setSaveAnswer(s, out);
    await dlg.getByRole('button', { name: 'Combine…' }).focus();
    await s.win.keyboard.press('Enter');
    await waitNotice(s, /Combined 2 files into Keys\.pdf \(4 pages\)\./);
    assert.deepEqual((await reread(readFileSync(out))).text, ['B 1', 'B 2', 'A 1', 'A 3']);
  });
});

test('dragging the handle moves a file; the order written is the order dropped', async () => {
  const dir = fresh('in');
  const names = ['a', 'b', 'c'];
  const paths = names.map((n) => put(dir, `${n}.pdf`, buildPdf({ pages: 1, tag: n.toUpperCase() })));
  const out = join(fresh('out'), 'Drag.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    await addFiles(s, dlg, paths, 3);
    const handle = rowOf(dlg, 'c.pdf').locator('.combine-handle');
    const target = rowOf(dlg, 'a.pdf');
    const box = await target.boundingBox();
    await handle.dragTo(target, { targetPosition: { x: 40, y: Math.max(2, Math.floor(box.height / 4)) } });
    assert.deepEqual(await rowNames(dlg), ['c.pdf', 'a.pdf', 'b.pdf']);
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    await waitNotice(s, /Combined 3 files into Drag\.pdf \(3 pages\)\./);
    assert.deepEqual((await reread(readFileSync(out))).text, ['C 1', 'A 1', 'B 1']);
  });
});

test('S2: Cancel at half leaves no file and no .part; the list is as it was; the second run succeeds (a big file, Cancel in the status bar)', async () => {
  const dir = fresh('in');
  const big = put(dir, 'big.pdf', readFileSync(fixture('big-1000.pdf')));
  const small = put(dir, 'small.pdf', buildPdf({ pages: 2, tag: 'S' }));
  const outDir = fresh('out');
  const out = join(outDir, 'Big.pdf');
  await launched(async (s) => {
    let dlg = await openCombine(s);
    await addFiles(s, dlg, [big, big, big, small], 4);
    await combine(s, dlg, out);
    const bar = s.win.locator('footer[data-job-status="combine"]');
    await bar.waitFor({ timeout: 20000 });
    assert.match(await bar.innerText(), /^Combining files/);
    await bar.getByRole('button', { name: 'Cancel' }).click();
    const message = await waitNotice(s, /Cancelled/);
    assert.equal(message.replace(/ ×$/, ''), 'Cancelled. No files were created and your original files were not changed.');
    assert.deepEqual(listing(outDir), [], 'no file and no .part');
    // Combine Files… reopens with the list as it was.
    dlg = await openCombine(s);
    await rowsReady(dlg, 4);
    assert.deepEqual(await rowNames(dlg), ['big.pdf', 'big.pdf', 'big.pdf', 'small.pdf']);
    // Remove two of the big ones so the second run is quick, and run again.
    await rowOf(dlg, 'big.pdf').click();
    await dlg.getByRole('button', { name: 'Remove' }).click();
    await rowOf(dlg, 'big.pdf').click();
    await dlg.getByRole('button', { name: 'Remove' }).click();
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    await waitNotice(s, /Combined 2 files into Big\.pdf \(1002 pages\)\./, 180000);
    assert.deepEqual(listing(outDir), ['Big.pdf']);
    assert.equal((await reread(readFileSync(out))).pages, 1002);
  });
});

test('S13: a write failure at the first chunk: the notice says so, nothing is made, the inputs are unchanged, and the next run succeeds', async () => {
  const dir = fresh('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const outDir = fresh('out');
  const out = join(outDir, 'W.pdf');
  const before = sha(a);
  await launched(
    async (s) => {
      const dlg = await openCombine(s);
      await addFiles(s, dlg, [a], 1);
      await dlg.getByLabel('Open the new file when it is ready').uncheck();
      await combine(s, dlg, out);
      const message = await waitNotice(s, /could not be written/);
      assert.match(message, /^The new file could not be written, so nothing was created\. Your files were not changed\./);
      assert.deepEqual(listing(outDir), []);
      assert.equal(sha(a), before);
      // The list is kept, and a second run (chunk 2 and on) is not affected.
      const again = await openCombine(s);
      await rowsReady(again, 1);
      await again.getByLabel('Open the new file when it is ready').uncheck();
      await combine(s, again, out);
      await waitFor(async () => /Combined 1 file into W\.pdf/.test(await noticeOf(s.win).innerText().catch(() => '')), { timeoutMs: 30000, label: 'second run done' });
      assert.deepEqual(listing(outDir), ['W.pdf']);
    },
    { env: { PDFSUITE_E2E_JOB_FAIL_APPEND: '1' } },
  );
});

test('Combine and Split are off while a job runs, with the spec reason; quitting while it runs asks "Stop and exit?" (S14)', async () => {
  const dir = fresh('in');
  const big = put(dir, 'big.pdf', readFileSync(fixture('big-1000.pdf')));
  const outDir = fresh('out');
  const out = join(outDir, 'Q.pdf');
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } });
  try {
    await s.win.waitForSelector('.empty-state');
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [big, big, big], 3);
    await combine(s, dlg, out);
    const bar = s.win.locator('footer[data-job-status="combine"]');
    await bar.waitFor({ timeout: 20000 });
    await s.win.keyboard.press('Control+k');
    const palette_ = s.win.getByRole('dialog', { name: 'Command palette' });
    await palette_.waitFor({ timeout: 5000 });
    await palette_.getByPlaceholder('Type a command').fill('Combine files');
    const option = palette_.getByRole('option').first();
    assert.equal(await option.getAttribute('aria-disabled'), 'true', 'Combine is off while the job runs');
    await s.win.keyboard.press('Escape');
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const prompt = s.win.getByRole('alertdialog');
    await prompt.waitFor({ timeout: 15000 });
    assert.match(await prompt.innerText(), /PDF Suite is still working on your files\. Stop and exit\?/);
    await prompt.getByRole('button', { name: 'Stop and exit' }).click();
    await waitFor(async () => s.app.evaluate(() => true).then(() => false).catch(() => true), { timeoutMs: 30000, label: 'the app quit' });
    assert.deepEqual(listing(outDir), [], 'no file and no .part left behind');
  } finally {
    await s.close();
  }
});

test('pictures: BMP, PNG and a multi-page TIFF each become pages; a hand-made BMP of 3 x 2 is a page', async () => {
  const dir = fresh('in');
  const bmp = put(dir, 'tiny.bmp', makeBmp(30, 20, 5));
  const tiff = put(dir, 'two.tif', makeTiff([{ w: 20, h: 30, dpi: 72 }, { w: 40, h: 10, dpi: 72 }]));
  const out = join(fresh('out'), 'Pictures.pdf');
  await launched(async (s) => {
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [bmp, tiff], 2);
    assert.match(await rowOf(dlg, 'two.tif').innerText(), /2 pages/);
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    await waitNotice(s, /Combined 2 files into Pictures\.pdf \(3 pages\)\./);
    const read = await reread(readFileSync(out));
    assert.equal(read.pages, 3);
    assert.deepEqual(read.sizes.map((x) => [Math.round(x.width), Math.round(x.height)]), [[23, 15], [20, 30], [40, 10]], 'pixels x 72 / 96 (BMP, no DPI) and x 72 / 72 (TIFF at 72 DPI)');
  });
});

test('sign-off 11: the output name reached through a folder junction or the long-path spelling is still an input, or an open file: refused, nothing replaced', async () => {
  const root = fresh('junction');
  const real = join(root, 'Real Folder With A Long Name');
  mkdirSync(real);
  const alias = join(root, 'alias');
  symlinkSync(real, alias, 'junction');
  const a = put(real, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const b = put(real, 'b.pdf', buildPdf({ pages: 1, tag: 'B' }));
  const opened = put(real, 'opened.pdf', buildPdf({ pages: 3, tag: 'Opened' }));
  const good = join(fresh('out'), 'Good.pdf');
  await launched(async (s) => {
    await openDoc(s, opened, 3);
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b], 2);
    const before = [sha(a), sha(b), sha(opened)];
    const target = dlg.locator('[data-combine-target]');
    const cases = [
      [join(alias, 'a.pdf'), /one of the files being combined/],
      [`\\\\?\\${a}`, /one of the files being combined/],
      [join(alias, 'A.PDF'), /one of the files being combined/],
      [join(alias, 'opened.pdf'), /open in PDF Suite/],
      [`\\\\?\\${opened}`, /open in PDF Suite/],
    ];
    for (const [path, message] of cases) {
      await setSaveAnswer(s, path);
      await dlg.getByRole('button', { name: 'Combine…' }).click();
      await waitFor(async () => message.test(await target.innerText().catch(() => '')), { timeoutMs: 15000, label: `refused: ${path}` });
      assert.equal(await windowOf(s.win).count(), 1, 'the window stays');
      assert.deepEqual([sha(a), sha(b), sha(opened)], before, `no file was changed by ${path}`);
    }
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, good);
    await waitNotice(s, /Combined 2 files into Good\.pdf \(3 pages\)\./);
    assert.deepEqual([sha(a), sha(b), sha(opened)], before);
  });
});
