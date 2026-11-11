// Sign-Off 9 (tickets 1.3.2 Split into files, 1.3.3 Combine): shared helpers for the app-level probes. Tester code only.
// Work files live under the OS temp folder pdfsuite-so9 (removed at the end). Nothing edits product code.
import { mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import * as mu from 'mupdf';
import { launch, closeAll, placeWindow, open, palette, waitFor, statusText, saveNow, setSaveAnswer, delay, isDirty } from '../e2e/matrix-lib.mjs';
export { closeAll, open, palette, waitFor, statusText, saveNow, setSaveAnswer, delay, isDirty };
export { fixture } from '../e2e/matrix-lib.mjs';

export const SCRATCH = join(tmpdir(), 'pdfsuite-so9');
export const WORK = join(SCRATCH, `work-${process.pid}`);
mkdirSync(WORK, { recursive: true });
let seq = 0;
export function dirOf(label = 'd') {
  const dir = join(WORK, `${label}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function put(dir, name, bytes) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}
export function wipe() {
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* harmless */ }
}
export const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const listing = (dir) => readdirSync(dir).sort();
export const sizeOf = (path) => statSync(path).size;

export async function start(options = {}) {
  const s = await launch(options);
  await placeWindow(s, { width: 1300, height: 900 });
  return s;
}

export function report(name) {
  const file = join(SCRATCH, `${name}.log`);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(file, `# ${name} ${new Date().toISOString()}\n`);
  const results = [];
  const say = (line) => { console.log(line); appendFileSync(file, line + '\n'); };
  return {
    say,
    check(label, ok, detail = '') { results.push({ label, ok: !!ok }); say(`${ok ? 'PASS ' : 'FAIL '} ${label}${detail !== '' ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); return !!ok; },
    async step(label, fn) {
      try { await fn(); say(`DONE  ${label}`); } catch (e) { results.push({ label: `${label} threw`, ok: false }); say(`FAIL  ${label} :: threw ${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 600)}`); }
    },
    summary() { const failed = results.filter((r) => !r.ok); say(`SUMMARY ${results.length - failed.length}/${results.length} passed`); for (const f of failed) say(`  failed: ${f.label}`); return failed.length; },
  };
}

// ---- PDF building -------------------------------------------------------------------------------------------------------

function addOutline(pdf, outline) {
  const outlines = pdf.createObject();
  const build = (items, parent) => {
    const refs = items.map(() => pdf.createObject());
    let total = 0;
    items.forEach((item, i) => {
      const dict = pdf.newDictionary();
      dict.put('Title', pdf.newString(item.title));
      dict.put('Parent', parent);
      if (i > 0) dict.put('Prev', refs[i - 1]);
      if (i < items.length - 1) dict.put('Next', refs[i + 1]);
      const dest = pdf.newArray();
      dest.push(pdf.findPage(item.page - 1));
      dest.push(pdf.newName('Fit'));
      dict.put('Dest', dest);
      let count = 1;
      if (item.children?.length) {
        const kids = build(item.children, refs[i]);
        dict.put('First', kids.refs[0]);
        dict.put('Last', kids.refs[kids.refs.length - 1]);
        dict.put('Count', kids.total);
        count += kids.total;
      }
      total += count;
      refs[i].writeObject(dict);
    });
    return { refs, total };
  };
  const top = build(outline, outlines);
  const dict = pdf.newDictionary();
  dict.put('Type', pdf.newName('Outlines'));
  dict.put('First', top.refs[0]);
  dict.put('Last', top.refs[top.refs.length - 1]);
  dict.put('Count', top.total);
  outlines.writeObject(dict);
  pdf.getTrailer().get('Root').put('Outlines', outlines);
}

/**
 * Pages 612 x 792 (or w x h). spec per page: { text, lines (many lines), junkKb, noise, note, blank }.
 * Page n has the text "<tag> n" unless the spec overrides it. links: [{ page, url | toPage }], notes: [{ page, text }].
 */
export function buildPdf({ pages, tag = 'Page', w = 612, h = 792, spec = {}, outline = null, links = [], notes = [] }) {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('F1', font);
  const res = pdf.addObject(pdf.newDictionary());
  res.put('Font', fonts);
  const xobjs = pdf.newDictionary();
  res.put('XObject', xobjs);
  let noiseRef = null;
  for (let n = 1; n <= pages; n++) {
    const sp = spec[n] ?? {};
    let body = '';
    if (sp.blank) body = '';
    else if (sp.raw !== undefined) body = sp.raw;
    else if (sp.lines) body = Array.from({ length: sp.lines }, (_v, i) => `BT /F1 12 Tf 60 ${720 - i * 16} Td (${sp.text ?? `${tag} ${n}`} line ${i + 1} of ordinary body text here) Tj ET`).join('\n');
    else body = `BT /F1 14 Tf 60 700 Td (${sp.text ?? `${tag} ${n}`}) Tj ET`.replace(" 700 Td", ` ${h - 60} Td`);
    if (sp.noise) {
      if (!noiseRef) {
        const iw = 425;
        const ih = 550;
        const pm = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, iw, ih], false);
        const px = pm.getPixels();
        const stride = pm.getStride();
        const rnd = randomBytes(iw * ih);
        for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) px[y * stride + x] = 238 + (rnd[y * iw + x] % 7);
        for (let k = 0; k < 12; k++) {
          const x = 60 + Math.floor(Math.random() * (iw - 120));
          const y = 40 + Math.floor(Math.random() * (ih - 80));
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px[(y + dy) * stride + x + dx] = 70;
        }
        noiseRef = pdf.addImage(new mu.Image(pm));
        xobjs.put('Im0', noiseRef);
      }
      body = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    }
    const junk = sp.junkKb ? `\n% ${randomBytes(sp.junkKb * 512).toString('hex')}` : '';
    pdf.insertPage(-1, pdf.addPage([0, 0, w, h], 0, res, body + junk));
  }
  for (const note of notes) {
    const page = pdf.loadPage(note.page - 1);
    const a = page.createAnnotation('Text');
    a.setRect([300, 300, 320, 320]);
    a.setContents(note.text);
    page.update();
  }
  for (const link of links) {
    const page = pdf.loadPage(link.page - 1);
    page.createLink(link.rect ?? [60, 60, 200, 90], link.url ?? `#page=${link.toPage}`);
    page.update();
  }
  if (outline) addOutline(pdf, outline);
  return Buffer.from(pdf.saveToBuffer('garbage=compact').asUint8Array().slice());
}

// ---- Reading a file on disk (MuPDF) ---------------------------------------------------------------------------------------

function walkOutline(doc, items, depth, out) {
  for (const it of items ?? []) {
    let page = null;
    try { page = it.page ?? (it.uri ? doc.resolveLink(it.uri) : null); } catch { page = null; }
    out.push({ title: it.title, depth, page: typeof page === 'number' ? page + 1 : null, uri: it.uri ?? null });
    walkOutline(doc, it.down, depth + 1, out);
  }
}

/** { pages, sizes:[[w,h]], text:[], outline:[{title,depth,page}], links:[[{uri,page}]], notes:[[contents]], widgets: n, needsPassword } */
export function inspect(path, password) {
  const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    if (doc.needsPassword() && password) doc.authenticatePassword(password);
    const out = { pages: doc.countPages(), sizes: [], text: [], links: [], notes: [], widgets: 0, outline: [] };
    for (let i = 0; i < out.pages; i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      out.sizes.push([Math.round((b[2] - b[0]) * 10) / 10, Math.round((b[3] - b[1]) * 10) / 10]);
      const st = page.toStructuredText('');
      out.text.push(st.asText().replace(/\s+/g, ' ').trim());
      st.destroy();
      out.links.push(page.getLinks().map((l) => {
        const uri = l.getURI();
        let target = null;
        try { if (!l.isExternal()) target = doc.resolveLink(uri) + 1; } catch { target = null; }
        return { uri, target };
      }));
      const pdfPage = page.getAnnotations ? page.getAnnotations() : [];
      const notes = [];
      for (const a of pdfPage) {
        const type = a.getType();
        if (type === 'Widget') out.widgets += 1;
        else if (type !== 'Link') notes.push(`${type}:${a.getContents?.() ?? ''}`);
      }
      out.notes.push(notes);
      page.destroy();
    }
    try { walkOutline(doc, doc.loadOutline(), 0, out.outline); } catch { /* none */ }
    return out;
  } finally {
    doc.destroy();
  }
}

/** Rendered pixels of one page (RGB), scale 1: { w, h, rgb }. */
export function render(path, index, scale = 1, password) {
  const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    if (doc.needsPassword() && password) doc.authenticatePassword(password);
    const page = doc.loadPage(index);
    const pm = page.toPixmap([scale, 0, 0, scale, 0, 0], mu.ColorSpace.DeviceRGB, false, true);
    const w = pm.getWidth();
    const h = pm.getHeight();
    const stride = pm.getStride();
    const src = pm.getPixels();
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) rgb.set(src.subarray(y * stride, y * stride + w * 3), y * w * 3);
    pm.destroy();
    page.destroy();
    return { w, h, rgb };
  } finally {
    doc.destroy();
  }
}
export const px = (img, x, y) => [...img.rgb.slice((y * img.w + x) * 3, (y * img.w + x) * 3 + 3)];
export const inkShare = (img) => {
  let n = 0;
  for (let i = 0; i < img.rgb.length; i += 3) if (img.rgb[i] + img.rgb[i + 1] + img.rgb[i + 2] < 600) n++;
  return n / (img.w * img.h);
};

// ---- Driving the split sheet --------------------------------------------------------------------------------------------

export const sheetOf = (win) => win.getByRole('dialog', { name: 'Split into files' });
export const noticeOf = (win) => win.locator('[data-job-notice]');
export async function openSheet(s) {
  await palette(s.win, 'Pages: Split into files');
  const sheet = sheetOf(s.win);
  await sheet.waitFor({ timeout: 10000 });
  return sheet;
}
export async function ready(sheet) {
  await sheet.locator('[data-split-source]').waitFor({ timeout: 20000 });
}
export async function chooseFolder(s, sheet, dir) {
  await s.setDialogAnswer([dir]);
  await sheet.getByRole('button', { name: 'Choose folder…' }).click();
  await sheet.locator('[data-split-folder="true"]').waitFor({ timeout: 10000 });
}
export async function waitNotice(s, pattern, timeoutMs = 90000) {
  const notice = noticeOf(s.win);
  await notice.waitFor({ timeout: timeoutMs });
  await waitFor(async () => pattern.test(await notice.innerText().catch(() => '')), { timeoutMs, label: `notice ${pattern}` });
  return (await notice.innerText()).replace(/\s+/g, ' ').trim();
}
export async function anyNotice(s, timeoutMs = 90000) {
  const notice = noticeOf(s.win);
  await notice.waitFor({ timeout: timeoutMs });
  return (await notice.innerText()).replace(/\s+/g, ' ').trim();
}
export const splitButton = (sheet) => sheet.getByRole('button', { name: 'Split', exact: true });
export async function closeNotice(s) {
  const c = s.win.locator('[data-job-notice] .job-notice-close');
  if (await c.count()) await c.click();
}

// ---- Driving Combine ------------------------------------------------------------------------------------------------------

export const windowOf = (win) => win.getByRole('dialog', { name: 'Combine files' });
export const rowNames = (dlg) => dlg.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-name')));
export const rowOf = (dlg, name) => dlg.locator(`[data-row-name="${name}"]`).first();
export const messagesOf = (dlg) => dlg.locator('[data-combine-message]').evaluateAll((els) => els.map((e) => e.querySelector('span').textContent));
export async function openCombine(s) {
  await palette(s.win, 'Pages: Combine files');
  const dlg = windowOf(s.win);
  await dlg.waitFor({ timeout: 10000 });
  return dlg;
}
export async function rowsReady(dlg, count, timeoutMs = 40000) {
  await waitFor(async () => (await dlg.locator('[data-row-id]').count()) === count && (await dlg.getByText('Reading…').count()) === 0, { timeoutMs, label: `${count} rows read` });
}
export async function addFiles(s, dlg, paths, expectRows) {
  await s.setDialogAnswer(paths);
  await dlg.getByRole('button', { name: 'Add files…' }).click();
  if (expectRows !== undefined) await rowsReady(dlg, expectRows);
}
export async function combine(s, dlg, out) {
  await setSaveAnswer(s, out);
  await dlg.getByRole('button', { name: 'Combine…' }).click();
}
