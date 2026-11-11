// Sign-Off 7 (ticket 1.3.1): shared helpers for the app-level probes; the reading and comparing code is the tester's (tests/signoff6/lib.mjs).
// Nothing here edits product code. Work files live under the OS temp folder, in a folder removed at the end.
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mu from 'mupdf';
export * from '../e2e/matrix-lib.mjs';
export { setSaveAnswer } from '../e2e/matrix-lib.mjs';

export const SCRATCH = join(tmpdir(), 'pdfsuite-so7');
export const WORK = join(SCRATCH, `work-${process.pid}`);
mkdirSync(WORK, { recursive: true });
let seq = 0;
export function newFile(name, bytes) {
  const dir = join(WORK, String(++seq));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (bytes) writeFileSync(path, bytes);
  return { dir, path };
}
export function copyTo(src, name) {
  const f = newFile(name);
  copyFileSync(src, f.path);
  return f;
}
export function wipe() {
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* harmless */ }
}

export function report(name) {
  const file = join(SCRATCH, `${name}.log`);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(file, `# ${name} ${new Date().toISOString()}\n`);
  const results = [];
  const say = (line) => { console.log(line); appendFileSync(file, line + '\n'); };
  return {
    say,
    check(label, ok, detail = '') { results.push({ label, ok: !!ok }); say(`${ok ? 'PASS ' : 'FAIL '} ${label}${detail ? ` :: ${detail}` : ''}`); return !!ok; },
    async step(label, fn) {
      try { await fn(); say(`DONE  ${label}`); } catch (e) { results.push({ label: `${label} threw`, ok: false }); say(`FAIL  ${label} :: threw ${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 500)}`); }
    },
    summary() { const failed = results.filter((r) => !r.ok); say(`SUMMARY ${results.length - failed.length}/${results.length} passed`); for (const f of failed) say(`  failed: ${f.label}`); return failed.length; },
  };
}

// ---- PDF building ----
export function numbers(pdf, values) {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}
/** Asymmetric content: boxes in all quarters, a word in each half. */
export function content(tag, w = 800, h = 500) {
  const s = w / 800;
  const t = h / 500;
  const r = (x, y, a, b) => `${x * s} ${y * t} ${a * s} ${b * t} re f`;
  return [
    '0 g', r(20, 20, 100, 40), r(680, 440, 100, 40), r(390, 100, 20, 300), r(150, 120, 30, 30), r(600, 300, 60, 20), r(250, 400, 40, 10),
    `BT /F1 ${Math.max(2, 40 * Math.min(s, t))} Tf ${60 * s} ${250 * t} Td (ALPHA ${tag}) Tj ET`,
    `BT /F1 ${Math.max(2, 40 * Math.min(s, t))} Tf ${520 * s} ${250 * t} Td (OMEGA ${tag}) Tj ET`,
  ].join('\n');
}
export function buildPdf(specs, extra) {
  const pdf = new mu.PDFDocument();
  const font = pdf.newDictionary();
  font.put('Type', pdf.newName('Font'));
  font.put('Subtype', pdf.newName('Type1'));
  font.put('BaseFont', pdf.newName('Helvetica'));
  const resources = pdf.newDictionary();
  const fonts = pdf.newDictionary();
  fonts.put('F1', pdf.addObject(font));
  resources.put('Font', fonts);
  specs.forEach((spec, i) => {
    pdf.insertPage(i, pdf.addPage(spec.media, spec.rotate ?? 0, resources, spec.content));
    if (spec.crop) pdf.findPage(i).put('CropBox', numbers(pdf, spec.crop));
  });
  if (extra) extra(pdf);
  const bytes = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
  pdf.destroy();
  return Buffer.from(bytes);
}

// ---- Reading a file on disk ----
export function readPages(path) {
  const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    const out = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      try {
        const b = page.getBounds();
        const w = Math.round(b[2] - b[0]);
        const h = Math.round(b[3] - b[1]);
        const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, w, h], false);
        pixmap.clear(255);
        const device = new mu.DrawDevice([1, 0, 0, 1, -b[0], -b[1]], pixmap);
        page.run(device, mu.Matrix.identity);
        device.close();
        device.destroy();
        const stride = pixmap.getStride();
        const source = pixmap.getPixels();
        const px = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) px.set(source.subarray(y * stride, y * stride + w), y * w);
        pixmap.destroy();
        const st = page.toStructuredText('');
        const text = st.asText().replace(/\s+/g, ' ').trim();
        st.destroy();
        out.push({ w, h, exactW: b[2] - b[0], exactH: b[3] - b[1], px, text });
      } finally { page.destroy(); }
    }
    return out;
  } finally { doc.destroy(); }
}
export function sub(image, rect) {
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(v));
  const w = x1 - x0;
  const h = y1 - y0;
  const px = new Uint8Array(Math.max(0, w * h));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = image.px[(y0 + y) * image.w + x0 + x];
  return { w, h, px };
}
export function halvesOf(w, h, cut, at, first = 'left') {
  if (cut === 'horizontal') return [[0, 0, w, h * at], [0, h * at, w, h]];
  const left = [0, 0, w * at, h];
  const right = [w * at, 0, w, h];
  return first === 'right' ? [right, left] : [left, right];
}
/** Expected images after cutting: step is null (keep) or { cut, at, first }. */
export function expectedImages(images, plan) {
  const out = [];
  images.forEach((img, i) => {
    const st = plan[i];
    if (!st) out.push({ ...img, label: `p${i + 1}` });
    else {
      const [a, b] = halvesOf(img.w, img.h, st.cut, st.at ?? 0.5, st.first);
      out.push({ ...sub(img, a), label: `p${i + 1}a` }, { ...sub(img, b), label: `p${i + 1}b` });
    }
  });
  return out;
}
/** Compares a saved file to expected images; returns a list of problems (empty = fine). Pixel tolerance: up to 0.2 % of pixels differ (cut on non-integer points). */
export function compare(savedPath, expected, tol = 0.002) {
  const saved = readPages(savedPath);
  const problems = [];
  if (saved.length !== expected.length) problems.push(`page count ${saved.length}, expected ${expected.length}`);
  for (let i = 0; i < Math.min(saved.length, expected.length); i++) {
    const g = saved[i];
    const e = expected[i];
    if (Math.abs(g.w - e.w) > 1 || Math.abs(g.h - e.h) > 1) { problems.push(`page ${i + 1} (${e.label}) is ${g.w}x${g.h}, expected ${e.w}x${e.h}`); continue; }
    let diff = 0;
    const n = Math.min(g.px.length, e.px.length);
    for (let k = 0; k < n; k++) if (Math.abs(g.px[k] - e.px[k]) > 100) diff++;
    if (diff > Math.max(4, n * tol)) problems.push(`page ${i + 1} (${e.label}) shows wrong pixels (${diff} of ${n} differ)`);
  }
  return { problems, saved };
}
export const planAll = (n, step) => Array.from({ length: n }, () => step);
export const planOnly = (n, idx, step) => Array.from({ length: n }, (_u, i) => (idx.includes(i) ? step : null));
export const VERT = { cut: 'vertical', at: 0.5, first: 'left' };
export const HORZ = { cut: 'horizontal', at: 0.5, first: 'left' };

// ---- Driving the sheet ----
export const sheetOf = (win) => win.getByRole('dialog', { name: 'Cut pages in half' });
export async function openSheet(s, palette) {
  await palette(s.win, 'Pages: Cut pages in half');
  await sheetOf(s.win).waitFor({ timeout: 10000 });
  return sheetOf(s.win);
}
export async function setOptions(sheet, { direction, percent, order, scope }) {
  if (direction) await sheet.getByRole('radio', { name: direction === 'vertical' ? 'Left and right' : 'Top and bottom' }).click();
  if (percent !== undefined) await sheet.getByLabel('Cut position in percent').fill(String(percent));
  if (order) await sheet.getByRole('radio', { name: order === 'right' ? 'Right page first' : 'Left page first' }).click();
  if (scope) await sheet.getByLabel('Apply to').selectOption(scope);
}
export const summaryOf = (sheet) => sheet.locator('[data-cut-summary]').innerText();

// ---- Sign-Off 7 additions ----
import { launch as launchApp, placeWindow as place } from '../e2e/helpers.mjs';
export const FX = join(SCRATCH, 'fx');
/** Launches the app and puts its window on the test display (the owner's second monitor). */
export async function start(options = {}) {
  const s = await launchApp(options);
  await place(s, { width: 1300, height: 900 });
  return s;
}
/** What the thumbnail list shows: per row its uid, whether it is selected and whether it is the current page. */
export async function rows(win) {
  return win.evaluate(() => [...document.querySelectorAll('.thumb-list .thumb')]
    .map((el) => ({ top: Number.parseFloat(el.style.top), uid: el.dataset.uid, selected: el.classList.contains('thumb-selected') || el.getAttribute('aria-selected') === 'true', current: el.classList.contains('thumb-current') }))
    .sort((a, b) => a.top - b.top));
}
export const selectedIdx = async (win) => (await rows(win)).flatMap((r, i) => (r.selected ? [i + 1] : []));
export const currentIdx = async (win) => (await rows(win)).findIndex((r) => r.current) + 1;
export const sizesOnDisk = (path) => readPages(path).map((p) => `${p.w}x${p.h}`).join(' ');
