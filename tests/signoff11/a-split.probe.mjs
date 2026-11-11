// Sign-Off 11, A: Split of a password-protected file (kept, dropped, user != owner password; never stored), and
// Split by blank pages on colour scans and rotated scans. Auditor code only; nothing edits product code.
import { join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as mu from 'mupdf';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, openSheet, ready, chooseFolder, anyNotice, splitButton, listing, sha, closeNotice, waitFor, delay, statusText } from '../signoff9/lib9.mjs';

const R = report('s11-a-split');

function walkFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

async function openLocked(s, path, pw, pages) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByLabel('Password').fill(pw);
  await dialog.getByRole('button', { name: 'Open' }).click();
  await waitFor(async () => (await statusText(s.win)).startsWith(`Page 1 of ${pages}`), { timeoutMs: 20000, label: 'opened' });
}

for (const variant of [{ label: 'same user and owner password', user: 'Uzer-Kq81-pw', owner: 'Uzer-Kq81-pw' }, { label: 'different user and owner passwords', user: 'Uzer-Kq82-pw', owner: 'Ownr-Zz93-pw' }]) {
  await R.step(`A1 locked file split (${variant.label})`, async () => {
    const dir = dirOf('lock');
    const src = new mu.PDFDocument(buildPdf({ pages: 5, tag: 'Secret', notes: [{ page: 2, text: 'note on two' }], links: [{ page: 1, toPage: 2 }, { page: 3, url: 'https://example.com/x' }] }));
    const path = put(dir, 'Vault.pdf', Buffer.from(src.saveToBuffer(`encrypt=aes-256,user-password=${variant.user},owner-password=${variant.owner}`).asUint8Array().slice()));
    const before = sha(path);
    const s = await start();
    try {
      await s.win.waitForSelector('.empty-state');
      await openLocked(s, path, variant.user, 5);
      for (const keep of [true, false]) {
        const out = dirOf('out');
        const sheet = await openSheet(s);
        // the app may ask for the password again if it no longer holds it
        const again = s.win.getByRole('dialog', { name: 'Password needed' });
        await Promise.race([ready(sheet), again.waitFor({ timeout: 20000 })]).catch(() => undefined);
        if (await again.count()) {
          R.say('INFO the sheet asked for the password again');
          await again.getByLabel('Password').fill(variant.user);
          await again.getByRole('button').filter({ hasText: /Open|Use password/ }).first().click();
          await ready(sheet);
        }
        const box = sheet.getByLabel('Keep the password on the new files');
        R.check(`keep=${keep}: the Keep the password box is shown and on by default`, (await box.count()) === 1 && (await box.isChecked()));
        if (!keep) await box.uncheck();
        await sheet.getByLabel('Pages in each file').fill('2');
        await chooseFolder(s, sheet, out);
        await splitButton(sheet).click();
        let text = '';
        try { text = await anyNotice(s, 60000); } catch { text = ''; }
        const note = (await s.win.locator('[data-split-password-note]').count()) ? (await s.win.locator('[data-split-password-note]').innerText()).trim() : '';
        R.say(`INFO keep=${keep}: notice "${text}"; password note "${note}"; files ${JSON.stringify(listing(out))}`);
        const names = listing(out);
        if (note) {
          R.check(`keep=${keep}: protection can't be kept -> spec message and no files`, names.length === 0 && /can't be kept in the new files/.test(note), { note, names });
          const sh = s.win.getByRole('dialog', { name: 'Split into files' });
          if (await sh.count()) await sh.getByRole('button', { name: 'Cancel' }).click().catch(() => undefined);
        } else {
          R.check(`keep=${keep}: 3 files with the spec names`, JSON.stringify(names) === JSON.stringify(['Vault - part 01.pdf', 'Vault - part 02.pdf', 'Vault - part 03.pdf']), names);
          let allOk = names.length > 0;
          const texts = [];
          for (const n of names) {
            const bytes = readFileSync(join(out, n));
            const doc = mu.Document.openDocument(bytes, 'application/pdf');
            const needs = doc.needsPassword();
            if (needs !== keep) allOk = false;
            if (keep) {
              if (!doc.authenticatePassword(variant.user)) { allOk = false; R.say(`INFO ${n}: the user password does not open the part`); }
              const ownerOk = mu.Document.openDocument(bytes, 'application/pdf').authenticatePassword(variant.owner);
              R.say(`INFO ${n}: owner password result ${ownerOk}`);
            }
            if (bytes.includes(Buffer.from(variant.user)) || bytes.includes(Buffer.from(variant.owner))) { allOk = false; R.say(`INFO ${n} holds a password in clear text`); }
            doc.destroy();
            const p = inspect(join(out, n), variant.user);
            texts.push(...p.text);
          }
          R.check(`keep=${keep}: every part is ${keep ? 'locked and opens with the password' : 'open without a password'}, no clear-text password`, allOk);
          R.check(`keep=${keep}: all 5 pages in order`, JSON.stringify(texts) === JSON.stringify(['Secret 1', 'Secret 2', 'Secret 3', 'Secret 4', 'Secret 5']), texts);
          if (names.length === 3) {
            const p1 = inspect(join(out, names[0]), variant.user);
            const p2 = inspect(join(out, names[1]), variant.user);
            R.check(`keep=${keep}: note, inner link (1->2) and web link survive in the locked parts`, p1.notes[1].some((x) => /note on two/.test(x)) && p1.links[0].some((l) => l.target === 2) && p2.links[0].some((l) => /example\.com/.test(l.uri)), { notes: p1.notes, links1: p1.links, links2: p2.links });
          }
        }
        await closeNotice(s);
        await delay(300);
      }
      R.check('the source file is unchanged', sha(path) === before);
      const hit = walkFiles(s.profile).filter((f) => { try { const b = statSync(f).size < 64 * 1024 * 1024 ? readFileSync(f) : Buffer.alloc(0); return b.includes(Buffer.from(variant.user)) || b.includes(Buffer.from(variant.owner)) || b.includes(Buffer.from(variant.user, 'utf16le')); } catch { return false; } });
      R.check('the password is not written anywhere in the app profile (UTF-8 or UTF-16)', hit.length === 0, hit);
    } finally { await s.close(); }
  });
}

// ---- blank pages on colour and rotated scans -------------------------------------------------------------------------

const W = 612;
/** Renders one vector page (text in a colour) to RGB pixels at 100 dpi, then makes it look scanned on a paper tone. */
function scanPixels({ h, lines = 0, oneLine = null, ink = [0, 0, 0], paper = [255, 255, 255], lineY = null, noise = 3 }) {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('F1', font);
  const res = pdf.addObject(pdf.newDictionary());
  res.put('Font', fonts);
  const col = `${(ink[0] / 255).toFixed(3)} ${(ink[1] / 255).toFixed(3)} ${(ink[2] / 255).toFixed(3)} rg`;
  let body = '';
  if (lines) body = Array.from({ length: lines }, (_v, i) => `BT ${col} /F1 12 Tf 72 ${h - 80 - i * 18} Td (Line ${i + 1}: the quick brown fox jumps over the lazy dog again) Tj ET`).join('\n');
  else if (oneLine) body = `BT ${col} /F1 12 Tf 72 ${lineY ?? Math.round(h / 2)} Td (${oneLine}) Tj ET`;
  pdf.insertPage(-1, pdf.addPage([0, 0, W, h], 0, res, body));
  const page = pdf.loadPage(0);
  const s = 100 / 72;
  const pm = page.toPixmap([s, 0, 0, s, 0, 0], mu.ColorSpace.DeviceRGB, false, true);
  const w = pm.getWidth();
  const ph = pm.getHeight();
  const stride = pm.getStride();
  const src = pm.getPixels();
  const rgb = new Uint8Array(w * ph * 3);
  let seed = 12345 + h;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < ph; y++) for (let x = 0; x < w; x++) {
    const n = Math.round((rnd() - 0.5) * 2 * noise);
    for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, Math.round((src[y * stride + x * 3 + c] * paper[c]) / 255) + n));
  }
  pm.destroy();
  page.destroy();
  pdf.destroy();
  return { w, h: ph, rgb };
}
/** Turns pixels a quarter turn (counter-clockwise), as a sheet fed sideways into a scanner. */
function quarterTurn(img) {
  const out = new Uint8Array(img.rgb.length);
  const nw = img.h;
  const nh = img.w;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const nx = y;
    const ny = img.w - 1 - x;
    out.set(img.rgb.subarray((y * img.w + x) * 3, (y * img.w + x) * 3 + 3), (ny * nw + nx) * 3);
  }
  return { w: nw, h: nh, rgb: out };
}

function buildScanFile(defs) {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Helvetica'));
  defs.forEach((d, i) => {
    const h = 792 + (i + 1); // every page has its own height: page n is 792 + n tall
    if (d.vector) {
      const fonts = pdf.newDictionary();
      fonts.put('F1', font);
      const res = pdf.addObject(pdf.newDictionary());
      res.put('Font', fonts);
      const body = Array.from({ length: 20 }, (_v, k) => `BT /F1 12 Tf 72 ${h - 80 - k * 18} Td (${d.vector} line ${k + 1} ordinary body text of a letter) Tj ET`).join('\n');
      pdf.insertPage(-1, pdf.addPage([0, 0, W, h], 0, res, body));
      return;
    }
    let img = scanPixels({ h, ...d });
    let box = [0, 0, W, h];
    let rotate = 0;
    if (d.sideways || d.rotate === 90 || d.rotate === 270) {
      img = quarterTurn(img);
      if (d.rotate === 270) img = quarterTurn(quarterTurn(img));
      box = [0, 0, h, W];
      rotate = d.sideways ? 0 : d.rotate;
    } else if (d.rotate === 180) {
      img = quarterTurn(quarterTurn(img));
      rotate = 180;
    }
    const pm = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, img.w, img.h], false);
    const px = pm.getPixels();
    const stride = pm.getStride();
    for (let y = 0; y < img.h; y++) px.set(img.rgb.subarray(y * img.w * 3, (y + 1) * img.w * 3), y * stride);
    const ref = pdf.addImage(new mu.Image(pm));
    const xo = pdf.newDictionary();
    xo.put('Im0', ref);
    const res = pdf.addObject(pdf.newDictionary());
    res.put('XObject', xo);
    pdf.insertPage(-1, pdf.addPage(box, rotate, res, `q ${box[2]} 0 0 ${box[3]} 0 0 cm /Im0 Do Q`));
    pm.destroy();
  });
  return Buffer.from(pdf.saveToBuffer('garbage=compact,compress=yes').asUint8Array().slice());
}

// expect: 'blank' (should be found), 'content' (must never be found at the default), 'info' (documented limit or ruled case)
const DEFS = [
  { name: 'vector Doc A', vector: 'DocA', expect: 'content' },
  { name: 'colour scan, white paper, empty', expect: 'blank' },
  { name: 'vector Doc B', vector: 'DocB', expect: 'content' },
  { name: 'colour scan, cream paper, empty', paper: [250, 240, 215], expect: 'blank' },
  { name: 'colour scan, cream paper, full page blue ink', paper: [250, 240, 215], lines: 30, ink: [0, 0, 160], expect: 'content' },
  { name: 'colour scan, white, one red line "See attached."', oneLine: 'See attached. Payment enclosed.', ink: [200, 0, 0], expect: 'content' },
  { name: 'colour scan, white, one blue-pen line', oneLine: 'Approved by J. Brown, 4 March', ink: [60, 90, 200], expect: 'content' },
  { name: 'colour scan, white, one green line', oneLine: 'Approved by J. Brown, 4 March', ink: [0, 150, 60], expect: 'content' },
  { name: 'colour scan, blue separator sheet, empty', paper: [120, 160, 220], expect: 'info' },
  { name: 'colour scan, blue sheet with black full text', paper: [120, 160, 220], lines: 30, expect: 'content' },
  { name: 'colour scan, yellow sheet with one black line', paper: [250, 235, 120], oneLine: 'See attached. Payment enclosed.', expect: 'content' },
  { name: 'vector Doc C', vector: 'DocC', expect: 'content' },
  { name: 'Rotate 90 scan, empty', rotate: 90, expect: 'blank' },
  { name: 'Rotate 90 scan, full text', rotate: 90, lines: 30, expect: 'content' },
  { name: 'Rotate 270 scan, one line mid-page', rotate: 270, oneLine: 'See attached. Payment enclosed.', expect: 'content' },
  { name: 'Rotate 180 scan, one line mid-page', rotate: 180, oneLine: 'See attached. Payment enclosed.', expect: 'content' },
  { name: 'sideways scan (no Rotate), full text', sideways: true, lines: 30, expect: 'content' },
  { name: 'sideways scan (no Rotate), one line mid-page', sideways: true, oneLine: 'See attached. Payment enclosed.', expect: 'content' },
  { name: 'sideways scan (no Rotate), only one line at the top margin (in the side band)', sideways: true, oneLine: 'Sincerely, J. Brown', lineY: 792 - 30, expect: 'info' },
  { name: 'colour scan, only yellow highlighter text', oneLine: 'See attached. Payment enclosed.', ink: [255, 240, 0], expect: 'info' },
  { name: 'colour scan, full page of orange text', lines: 30, ink: [255, 140, 0], expect: 'content' },
  { name: 'colour scan, full page of light-blue (cyan) text', lines: 30, ink: [0, 190, 255], expect: 'content' },
  { name: 'vector Doc D', vector: 'DocD', expect: 'content' },
];

await R.step('A2 blank pages on colour and rotated scans', async () => {
  const dir = dirOf('scan');
  const path = put(dir, 'Scans.pdf', buildScanFile(DEFS));
  const before = sha(path);
  const total = DEFS.length;
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([path]);
    await s.win.keyboard.press('Control+o');
    await waitFor(async () => (await statusText(s.win)).startsWith(`Page 1 of ${total}`), { timeoutMs: 30000, label: 'opened' });
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Blank pages' }).click();
    await sheet.getByText(/No blank pages were found|Found \d+ blank/).first().waitFor({ timeout: 120000 });
    const options = await sheet.getByLabel('What counts as blank').locator('option').evaluateAll((els) => els.map((e) => ({ v: e.value, t: e.textContent })));
    R.say(`INFO blank choices: ${JSON.stringify(options)}`);
    const readList = async () => sheet.locator('.split-blank-item').evaluateAll((els) => els.map((e) => ({ label: e.querySelector('input').getAttribute('aria-label'), text: e.textContent.trim(), checked: e.querySelector('input').checked })));
    const found = await readList();
    const foundPages = found.map((f) => Number(/Page (\d+)/.exec(f.label)[1]));
    R.say(`INFO default choice found pages ${JSON.stringify(foundPages)}; text: ${(await sheet.getByText(/No blank pages were found|Found \d+ blank/).first().innerText()).trim()}`);
    R.say(`INFO help: ${(await sheet.locator('[data-split-blank-help]').innerText()).trim()}`);
    DEFS.forEach((d, i) => {
      const isFound = foundPages.includes(i + 1);
      if (d.expect === 'content') R.check(`default: page ${i + 1} (${d.name}) is NOT listed as blank`, !isFound);
      else if (d.expect === 'blank') R.check(`default: page ${i + 1} (${d.name}) is listed as blank`, isFound);
      else R.say(`INFO default: page ${i + 1} (${d.name}) listed as blank: ${isFound}`);
    });
    const summary = (await sheet.locator('[data-split-summary]').innerText().catch(() => '')).trim();
    R.say(`INFO summary (default): ${summary}`);
    const leaveOut = await sheet.getByRole('radio', { name: 'Leave out' }).isChecked();
    R.check('default: Leave out is selected', leaveOut);
    // second choice
    await sheet.getByLabel('What counts as blank').selectOption({ index: 1 });
    await delay(400);
    const loose = await readList();
    R.say(`INFO second choice list: ${JSON.stringify(loose.map((f) => f.text))}`);
    R.check('second choice: switches to "Keep at the end of the file before"', await sheet.getByRole('radio', { name: 'Keep at the end of the file before' }).isChecked());
    const loosePages = loose.map((f) => Number(/Page (\d+)/.exec(f.label)[1]));
    DEFS.forEach((d, i) => { if (d.expect === 'content' && d.lines && loosePages.includes(i + 1)) R.check(`second choice: full-text page ${i + 1} (${d.name}) is not listed`, false); });
    R.say(`INFO second choice summary: ${(await sheet.locator('[data-split-summary]').innerText().catch(() => '')).trim()}`);
    // back to the default, run it
    await sheet.getByLabel('What counts as blank').selectOption({ index: 0 });
    await delay(300);
    R.say(`INFO back on the default: Leave out checked ${await sheet.getByRole('radio', { name: 'Leave out' }).isChecked()}, keep checked ${await sheet.getByRole('radio', { name: 'Keep at the end of the file before' }).isChecked()}`);
    await sheet.getByRole('radio', { name: 'Leave out' }).check();
    const again = (await readList()).map((f) => Number(/Page (\d+)/.exec(f.label)[1]));
    R.check('the list is the same after switching the choice forth and back', JSON.stringify(again) === JSON.stringify(foundPages), again);
    const out = dirOf('out');
    await chooseFolder(s, sheet, out);
    R.say(`INFO summary before the run: ${(await sheet.locator('[data-split-summary]').innerText().catch(() => '')).trim()}`);
    await splitButton(sheet).click();
    const text = await anyNotice(s, 120000);
    R.say(`INFO notice: ${text}`);
    const names = listing(out);
    const heights = [];
    for (const n of names) for (const sz of inspect(join(out, n)).sizes) heights.push(Math.round(Math.max(sz[0], sz[1])) - 792);
    R.say(`INFO files ${JSON.stringify(names)}; source pages present in the parts: ${JSON.stringify(heights)}`);
    const expected = DEFS.map((_d, i) => i + 1).filter((n) => !foundPages.includes(n));
    R.check('the parts hold exactly the pages that were not listed, in order, each once', JSON.stringify(heights) === JSON.stringify(expected), { heights, expected });
    const lost = DEFS.map((d, i) => ({ d, n: i + 1 })).filter((x) => x.d.expect === 'content' && !heights.includes(x.n));
    R.check('no page with real content is missing from the parts', lost.length === 0, lost.map((x) => `${x.n} ${x.d.name}`));
    R.check('source unchanged', sha(path) === before);
    await closeNotice(s);
  } finally { await s.close(); }
});

await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
