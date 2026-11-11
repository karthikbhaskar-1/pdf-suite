// 1.3.2 Split into Files, driven through the real UI of the packaged app. Every file it makes is re-read from disk with pdf.js
// (a second engine: tests/lib/reread.mjs): page count, text, rotation, outline. The source file's bytes are checked before and
// after. Dialogs are stubbed (the folder dialog answers with a temp folder, the Open dialog with the test's own file); outputs
// go to %TEMP%\pdfsuite-e2e-* and are deleted. Every test ends with its document saved, or dropped by the test-mode quit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mu from 'mupdf';
import { launch, closeAll, open, palette, waitFor, statusText, clickRowByIndex, saveNow, setSaveAnswer, assertNoErrors, delay, fixture, waitForCount, isDirty } from './matrix-lib.mjs';
import { reread } from '../lib/reread.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-split-'));
after(async () => {
  await closeAll();
  rmSync(ROOT, { recursive: true, force: true });
});

let counter = 0;
const fresh = (label) => {
  const dir = join(ROOT, `${label}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const listing = (dir) => readdirSync(dir).sort();

// ---- Fixtures ------------------------------------------------------------------------------------------------------------

/** Pages of 300 x 400 with the text "<tag> n" (page numbers from 1), optional blanks, outline and a bulky image page. */
function buildPdf({ pages, tag = 'Page', blanks = [], outline = null, junkKb = 0 }) {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('F1', font);
  const res = pdf.addObject(pdf.newDictionary());
  res.put('Font', fonts);
  for (let n = 1; n <= pages; n++) {
    const body = blanks.includes(n) ? '' : `BT /F1 24 Tf 40 300 Td (${tag} ${n}) Tj ET`;
    const junk = junkKb > 0 && !blanks.includes(n) ? `\n% ${randomBytes(junkKb * 512).toString('hex')}` : '';
    pdf.insertPage(-1, pdf.addPage([0, 0, 300, 400], 0, res, body + junk));
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

function put(dir, name, bytes) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

// ---- Driving the sheet ---------------------------------------------------------------------------------------------------

const sheetOf = (win) => win.getByRole('dialog', { name: 'Split into files' });
const noticeOf = (win) => win.locator('[data-job-notice]');

async function openSheet(s) {
  await palette(s.win, 'Pages: Split into files');
  const sheet = sheetOf(s.win);
  await sheet.waitFor({ timeout: 10000 });
  return sheet;
}

async function ready(sheet) {
  await sheet.locator('[data-split-source]').waitFor({ timeout: 20000 });
}

async function chooseFolder(s, sheet, dir) {
  await s.setDialogAnswer([dir]);
  await sheet.getByRole('button', { name: 'Choose folder…' }).click();
  await sheet.locator('[data-split-folder="true"]').waitFor({ timeout: 10000 });
}

async function waitNotice(s, pattern) {
  const notice = noticeOf(s.win);
  await notice.waitFor({ timeout: 60000 });
  await waitFor(async () => pattern.test(await notice.innerText()), { timeoutMs: 60000, label: `notice ${pattern}` });
  return (await notice.innerText()).replace(/\s+/g, ' ').trim();
}

/** Opens a copy of a PDF in the app and runs the body with the session; the document ends saved or dropped by the quit. */
async function withDoc(bytes, name, pages, body, launchOptions = {}) {
  const dir = fresh('src');
  const path = put(dir, name, bytes);
  const s = await launch(launchOptions);
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, pages);
    await body(s, path, dir);
    assertNoErrors(s);
  } finally {
    await s.close();
  }
}

async function textsOf(path) {
  return (await reread(readFileSync(path))).text;
}

// ---- The tests -------------------------------------------------------------------------------------------------------------

test('page count: validates, shows the example, makes the files, and the source is unchanged', async () => {
  const src = buildPdf({ pages: 10 });
  await withDoc(src, 'Report.pdf', 10, async (s, path) => {
    const before = sha(path);
    const out = fresh('out');
    const sheet = await openSheet(s);
    await ready(sheet);
    assert.match(await sheet.locator('[data-split-source]').innerText(), /^Report\.pdf · 10 pages · /);
    // Split is off until the settings are valid and a folder is chosen.
    const split = sheet.getByRole('button', { name: 'Split', exact: true });
    assert.equal(await split.isDisabled(), true);
    await sheet.getByLabel('Pages in each file').fill('0');
    assert.equal((await sheet.locator('[data-split-error]').innerText()).trim(), 'Enter a whole number from 1 to 9.');
    await sheet.getByLabel('Pages in each file').fill('4');
    assert.equal((await sheet.locator('[data-split-example]').innerText()).trim(), 'Example: Report - part 01.pdf … Report - part 03.pdf');
    assert.equal((await sheet.locator('[data-split-summary]').innerText()).trim(), 'Makes 3 files.');
    assert.equal(await split.isDisabled(), true, 'no folder yet');
    await sheet.getByLabel('File name').fill('Bad/Name');
    await sheet.getByText("A file name can't contain \\ / : * ? \" < > |").waitFor({ timeout: 5000 });
    await sheet.getByLabel('File name').fill('Report');
    await chooseFolder(s, sheet, out);
    await split.click();
    const message = await waitNotice(s, /Split Report\.pdf into 3 files\./);
    assert.match(message, /^Split Report\.pdf into 3 files\./);
    assert.deepEqual(listing(out), ['Report - part 01.pdf', 'Report - part 02.pdf', 'Report - part 03.pdf']);
    assert.deepEqual(await textsOf(join(out, 'Report - part 01.pdf')), ['Page 1', 'Page 2', 'Page 3', 'Page 4']);
    assert.deepEqual(await textsOf(join(out, 'Report - part 03.pdf')), ['Page 9', 'Page 10']);
    assert.equal(sha(path), before, 'the source file is unchanged');
    // The sheet closed with the run, and the status bar is back to the page bar.
    assert.equal(await sheetOf(s.win).count(), 0);
  });
});

test('which document: another one is open with a selection; the focused one is split, all of its pages; and after the split the other can be split too', async () => {
  const a = buildPdf({ pages: 6, tag: 'Alpha' });
  const b = buildPdf({ pages: 4, tag: 'Beta' });
  const dir = fresh('two');
  const pathA = put(dir, 'Alpha.pdf', a);
  const pathB = put(dir, 'Beta.pdf', b);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, pathA, 6);
    await open(s, pathB, 4);
    // A selection in Beta (pages 1 and 2): Split ignores it.
    await clickRowByIndex(s.win, 0);
    await clickRowByIndex(s.win, 1, ['Shift']);
    const out1 = fresh('out');
    let sheet = await openSheet(s);
    await ready(sheet);
    assert.match(await sheet.locator('[data-split-source]').innerText(), /^Beta\.pdf · 4 pages/);
    await sheet.getByLabel('Pages in each file').fill('2');
    await chooseFolder(s, sheet, out1);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Beta\.pdf into 2 files\./);
    assert.deepEqual(listing(out1), ['Beta - part 01.pdf', 'Beta - part 02.pdf']);
    assert.deepEqual(await textsOf(join(out1, 'Beta - part 02.pdf')), ['Beta 3', 'Beta 4']);
    // Now the first document: its own pages, not Beta's.
    await s.win.getByRole('tab', { name: /Alpha\.pdf/ }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 6'), { timeoutMs: 15000, label: 'Alpha is shown' });
    const out2 = fresh('out');
    sheet = await openSheet(s);
    await ready(sheet);
    assert.match(await sheet.locator('[data-split-source]').innerText(), /^Alpha\.pdf · 6 pages/);
    await sheet.getByLabel('Pages in each file').fill('3');
    await chooseFolder(s, sheet, out2);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Alpha\.pdf into 2 files\./);
    assert.deepEqual(await textsOf(join(out2, 'Alpha - part 01.pdf')), ['Alpha 1', 'Alpha 2', 'Alpha 3']);
    assertNoErrors(s);
  } finally {
    await s.close();
  }
});

test('unsaved edits: the sheet asks to save first; Save and continue saves, and the parts hold the edit', async () => {
  const src = buildPdf({ pages: 6 });
  await withDoc(src, 'Edits.pdf', 6, async (s, path) => {
    // Rotate page 1 (the current page) and leave it unsaved.
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'the document is unsaved' });
    const before = sha(path);
    const sheet = await openSheet(s);
    await sheet.getByText('Save your changes first? Split works from the saved file.').waitFor({ timeout: 10000 });
    // Only that message and its two buttons: no controls, nothing read from the disk yet.
    assert.equal(await sheet.getByLabel('Pages in each file').count(), 0);
    assert.equal(sha(path), before, 'the file on disk is still the old one');
    await sheet.getByRole('button', { name: 'Save and continue' }).click();
    await ready(sheet);
    assert.notEqual(sha(path), before, 'the save wrote the edit');
    await sheet.getByLabel('Pages in each file').fill('3');
    const out = fresh('out');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Edits\.pdf into 2 files\./);
    const first = await reread(readFileSync(join(out, 'Edits - part 01.pdf')));
    const second = await reread(readFileSync(join(out, 'Edits - part 02.pdf')));
    // Page 1 was turned: its part shows it 400 wide and 300 tall (the turn is in the part's page), and the others are not.
    assert.deepEqual(first.sizes.map((p) => [p.width, p.height]), [[400, 300], [300, 400], [300, 400]]);
    assert.deepEqual(second.sizes.map((p) => [p.width, p.height]), [[300, 400], [300, 400], [300, 400]]);
    assert.deepEqual(first.text, ['Page 1', 'Page 2', 'Page 3']);
  });
});

test('after Save As the new file is the one split, and the first file is unchanged', async () => {
  const src = buildPdf({ pages: 4 });
  await withDoc(src, 'First.pdf', 4, async (s, path, dir) => {
    const target = join(dir, 'Second.pdf');
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'unsaved' });
    const before = sha(path);
    await setSaveAnswer(s, target);
    await palette(s.win, 'Save as');
    await waitFor(async () => (await s.win.getByRole('tab', { name: /Second\.pdf/ }).count()) > 0 && !(await isDirty(s.win)), { timeoutMs: 20000, label: 'saved as Second.pdf' });
    assert.equal(sha(path), before);
    const out = fresh('out');
    const sheet = await openSheet(s);
    await ready(sheet);
    assert.match(await sheet.locator('[data-split-source]').innerText(), /^Second\.pdf · 4 pages/);
    assert.equal(await sheet.getByLabel('File name').inputValue(), 'Second');
    await sheet.getByLabel('Pages in each file').fill('2');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Second\.pdf into 2 files\./);
    assert.deepEqual(listing(out), ['Second - part 01.pdf', 'Second - part 02.pdf']);
    const first = await reread(readFileSync(join(out, 'Second - part 01.pdf')));
    assert.deepEqual(first.sizes[0] && [first.sizes[0].width, first.sizes[0].height], [400, 300], 'it is the edited, saved copy');
    assert.equal(sha(path), before, 'First.pdf is still as it was');
  });
});

test('splitting twice into one folder: the second set gets (2) and the first set is unchanged', async () => {
  const src = buildPdf({ pages: 4 });
  await withDoc(src, 'Twice.pdf', 4, async (s) => {
    const out = fresh('out');
    for (let run = 1; run <= 2; run++) {
      const sheet = await openSheet(s);
      await ready(sheet);
      await sheet.getByLabel('Pages in each file').fill('2');
      await chooseFolder(s, sheet, out);
      await sheet.getByRole('button', { name: 'Split', exact: true }).click();
      await waitFor(async () => (await noticeOf(s.win).count()) > 0 && /Split Twice\.pdf into 2 files\./.test(await noticeOf(s.win).innerText()), { timeoutMs: 60000, label: `run ${run} done` });
      if (run === 1) {
        assert.deepEqual(listing(out), ['Twice - part 01.pdf', 'Twice - part 02.pdf']);
        // The notice stays until closed or the next job starts.
        await delay(4500);
        assert.equal(await noticeOf(s.win).count(), 1, 'the result notice is still shown after 4 seconds');
      }
    }
    assert.deepEqual(listing(out), ['Twice - part 01 (2).pdf', 'Twice - part 01.pdf', 'Twice - part 02 (2).pdf', 'Twice - part 02.pdf']);
    assert.deepEqual(await textsOf(join(out, 'Twice - part 01.pdf')), ['Page 1', 'Page 2']);
  });
});

test('blank pages: the search lists them, unticking one changes the result, blank pages are left out', async () => {
  const src = buildPdf({ pages: 8, blanks: [3, 6] });
  await withDoc(src, 'Blanks.pdf', 8, async (s) => {
    const out = fresh('out');
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Blank pages' }).click();
    await sheet.getByText('Found 2 blank pages. Untick any that should not start a new file.').waitFor({ timeout: 30000 });
    assert.equal((await sheet.locator('[data-split-summary]').innerText()).trim(), 'Makes 3 files. 2 pages will be left out.');
    // Untick page 6: it becomes content, so there are two files.
    await sheet.getByLabel('Page 6, starts a new file').uncheck();
    assert.equal((await sheet.locator('[data-split-summary]').innerText()).trim(), 'Makes 2 files. 1 page will be left out.');
    await sheet.getByLabel('Page 6, starts a new file').check();
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Blanks\.pdf into 3 files\./);
    assert.deepEqual(await textsOf(join(out, 'Blanks - part 01.pdf')), ['Page 1', 'Page 2']);
    assert.deepEqual(await textsOf(join(out, 'Blanks - part 02.pdf')), ['Page 4', 'Page 5']);
    assert.deepEqual(await textsOf(join(out, 'Blanks - part 03.pdf')), ['Page 7', 'Page 8']);
  });
});

test('bookmarks: parts are named after the top-level bookmarks and hold their own bookmarks; none gives the spec message', async () => {
  const outline = [{ title: 'Introduction', page: 3 }, { title: 'Methods: part A', page: 5 }, { title: 'Results', page: 8 }];
  await withDoc(buildPdf({ pages: 9, outline }), 'Book.pdf', 9, async (s) => {
    const out = fresh('out');
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Bookmarks' }).click();
    await sheet.getByText('3 top-level bookmarks').waitFor({ timeout: 15000 });
    assert.equal((await sheet.locator('[data-split-example]').innerText()).trim(), 'Example: Book - 01 Start.pdf … Book - 04 Results.pdf');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Book\.pdf into 4 files\./);
    assert.deepEqual(listing(out), ['Book - 01 Start.pdf', 'Book - 02 Introduction.pdf', 'Book - 03 Methods- part A.pdf', 'Book - 04 Results.pdf']);
    const methods = await reread(readFileSync(join(out, 'Book - 03 Methods- part A.pdf')));
    assert.deepEqual(methods.text, ['Page 5', 'Page 6', 'Page 7']);
    assert.deepEqual(methods.outline, [{ title: 'Methods: part A', depth: 0, page: 1 }]);
  });
  await withDoc(buildPdf({ pages: 3 }), 'Plain.pdf', 3, async (s) => {
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Bookmarks' }).click();
    await sheet.getByText('This document has no bookmarks to split by.').waitFor({ timeout: 15000 });
  });
});

test('file size: every part is at or under the limit, and no page is lost', async () => {
  const src = buildPdf({ pages: 24, junkKb: 10 });
  await withDoc(src, 'Big.pdf', 24, async (s) => {
    const out = fresh('out');
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'File size' }).click();
    await sheet.getByLabel('Largest file').fill('100');
    await sheet.getByLabel('Size unit').selectOption('KB');
    await sheet.getByText('Each file will be 100 KB or smaller. The number of files depends on the pages.').waitFor({ timeout: 5000 });
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitNotice(s, /Split Big\.pdf into \d+ files\./);
    const names = listing(out);
    assert.ok(names.length >= 2);
    let pages = 0;
    for (const name of names) {
      const bytes = readFileSync(join(out, name));
      assert.ok(bytes.length <= 100 * 1024, `${name} is ${bytes.length} bytes`);
      pages += (await reread(bytes)).pages;
    }
    assert.equal(pages, 24);
  });
});

test('a locked file: the password is kept by default, and dropped when the box is unticked', async () => {
  const dir = fresh('lock');
  const path = join(dir, 'locked.pdf');
  copyFileSync(fixture('locked.pdf'), path);
  // locked.pdf has one page: make a longer locked file of our own with the same password.
  const longer = new mu.PDFDocument(buildPdf({ pages: 4 }));
  writeFileSync(path, Buffer.from(longer.saveToBuffer('encrypt=aes-256,user-password=test123,owner-password=test123').asUint8Array().slice()));
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([path]);
    await s.win.keyboard.press('Control+o');
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    await dialog.waitFor({ timeout: 15000 });
    await dialog.getByLabel('Password').fill('test123');
    await dialog.getByRole('button', { name: 'Open' }).click();
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 4'), { timeoutMs: 20000, label: 'opened' });
    for (const keep of [true, false]) {
      const out = fresh('out');
      const sheet = await openSheet(s);
      await ready(sheet);
      const box = sheet.getByLabel('Keep the password on the new files');
      assert.equal(await box.isChecked(), true, 'on by default');
      if (!keep) await box.uncheck();
      await sheet.getByLabel('Pages in each file').fill('2');
      await chooseFolder(s, sheet, out);
      await sheet.getByRole('button', { name: 'Split', exact: true }).click();
      await waitNotice(s, /Split locked\.pdf into 2 files\./);
      const file = readFileSync(join(out, 'locked - part 01.pdf'));
      const doc = mu.Document.openDocument(file, 'application/pdf');
      assert.equal(doc.needsPassword(), keep, keep ? 'the part asks for the password' : 'the part opens without one');
      if (keep) assert.ok(doc.authenticatePassword('test123'));
      await s.win.locator('[data-job-notice] .job-notice-close').click();
    }
    assertNoErrors(s);
  } finally {
    await s.close();
  }
});

test('Cancel in the status bar leaves no files and no temp files; the next run succeeds', async () => {
  const src = readFileSync(fixture('big-1000.pdf'));
  await withDoc(src, 'big.pdf', 1000, async (s) => {
    const out = fresh('out');
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByLabel('Pages in each file').fill('1');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    const bar = s.win.locator('footer[data-job-status="split"]');
    await bar.waitFor({ timeout: 20000 });
    assert.match(await bar.innerText(), /^Splitting into files/);
    await bar.getByRole('button', { name: 'Cancel' }).click();
    assert.match(await bar.innerText().catch(() => 'Cancelling…'), /Cancelling…|Splitting/);
    const message = await waitNotice(s, /Cancelled/);
    assert.equal(message.replace(/ ×$/, ''), 'Cancelled. No files were created and your original files were not changed.');
    assert.deepEqual(listing(out), [], 'no files and no .part files');
    // The next run works.
    const sheet2 = await openSheet(s);
    await ready(sheet2);
    await sheet2.getByLabel('Pages in each file').fill('500');
    await chooseFolder(s, sheet2, out);
    await sheet2.getByRole('button', { name: 'Split', exact: true }).click();
    await waitFor(async () => /Split big\.pdf into 2 files\./.test(await noticeOf(s.win).innerText().catch(() => '')), { timeoutMs: 120000, label: 'second run done' });
    assert.deepEqual(listing(out), ['big - part 01.pdf', 'big - part 02.pdf']);
  });
});

test('a write failure at the second chunk: the notice says so, the folder is empty, the source is unchanged, and the next run succeeds (S13)', async () => {
  const src = buildPdf({ pages: 6 });
  await withDoc(src, 'Fail.pdf', 6, async (s, path) => {
    const before = sha(path);
    const out = fresh('out');
    let sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByLabel('Pages in each file').fill('2');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    const message = await waitNotice(s, /could not be written/);
    assert.match(message, /^The new file could not be written, so nothing was created\. Your files were not changed\./);
    assert.deepEqual(listing(out), []);
    assert.equal(sha(path), before);
    // The injection fails only the second chunk of the run: a second run (chunks 3 and on) is not affected.
    sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByLabel('Pages in each file').fill('2');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await waitFor(async () => /Split Fail\.pdf into 3 files\./.test(await noticeOf(s.win).innerText().catch(() => '')), { timeoutMs: 60000, label: 'second run done' });
    assert.equal(listing(out).length, 3);
  }, { env: { PDFSUITE_E2E_JOB_FAIL_APPEND: '2' } });
});

test('quitting while a job runs asks "Stop and exit?", and Stop and exit leaves no files and no temp files (S14)', async () => {
  const src = readFileSync(fixture('big-1000.pdf'));
  const dir = fresh('quit');
  const path = put(dir, 'big.pdf', src);
  const out = fresh('out');
  const s = await launch({ env: { PDFSUITE_E2E_PROMPTS: '1' } });
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 1000);
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByLabel('Pages in each file').fill('1');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Split', exact: true }).click();
    await s.win.locator('footer[data-job-status="split"]').waitFor({ timeout: 20000 });
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const prompt = s.win.getByRole('alertdialog');
    await prompt.waitFor({ timeout: 15000 });
    assert.match(await prompt.innerText(), /PDF Suite is still working on your files\. Stop and exit\?/);
    // Cancel keeps the app and the job; then close again and stop.
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await s.win.locator('footer[data-job-status="split"]').waitFor({ timeout: 10000 });
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await prompt.waitFor({ timeout: 15000 });
    await prompt.getByRole('button', { name: 'Stop and exit' }).click();
    await waitFor(async () => (await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 0)) === 0, { timeoutMs: 30000, label: 'the app quit' });
  } finally {
    await s.close();
  }
  assert.deepEqual(listing(out), [], 'no files and no temp files after Stop and exit');
});
