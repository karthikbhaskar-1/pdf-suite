// Measures Extract output size: app method (graftPage per page) vs one shared PDFGraftMap. Plain node, no app.
import * as mu from 'mupdf';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

function makeShared(n) {
  const doc = new mu.PDFDocument();
  const w = 500, h = 500;
  const pix = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels(); crypto.randomFillSync(px); // incompressible
  const img = doc.addImage(new mu.Image(pix));
  const font = doc.addSimpleFont(new mu.Font('Times-Roman'));
  const res = doc.addObject(doc.newDictionary());
  const fd = doc.newDictionary(); fd.put('F1', font); res.put('Font', fd);
  const xd = doc.newDictionary(); xd.put('Im1', img); res.put('XObject', xd);
  for (let i = 0; i < n; i++) {
    const c = `q 400 0 0 400 100 300 cm /Im1 Do Q BT /F1 24 Tf 100 200 Td (Page ${i + 1} shared image and font) Tj ET`;
    const page = doc.addPage([0, 0, 612, 792], 0, res, c);
    doc.insertPage(-1, page);
  }
  return doc.saveToBuffer('garbage=compact').asUint8Array().slice();
}

function count(bytes) {
  const d = mu.Document.openDocument(bytes, 'application/pdf');
  const n = d.countObjects(); let fonts = 0, images = 0, fontFiles = 0;
  for (let i = 1; i < n; i++) {
    const o = d.newIndirect(i, 0).resolve();
    const t = o.get('Type'), s = o.get('Subtype');
    if (t.isName() && t.asName() === 'Font') fonts++;
    if (o.isStream() && s.isName() && s.asName() === 'Image') images++;
    if (o.isDictionary() && (o.get('FontFile').isIndirect() || o.get('FontFile2').isIndirect() || o.get('FontFile3').isIndirect())) fontFiles++;
  }
  return { fonts, images, fontFiles };
}

function extract(srcBytes, positions, shared) {
  const pdf = mu.Document.openDocument(srcBytes, 'application/pdf');
  const out = new mu.PDFDocument();
  try {
    if (shared) { const map = out.newGraftMap(); for (const p of positions) map.graftPage(out.countPages(), pdf, p); }
    else for (const p of positions) out.graftPage(out.countPages(), pdf, p);
    return out.saveToBuffer('garbage=compact').asUint8Array().slice();
  } finally { out.destroy(); }
}

function sample(n) { const s = new Set([0, n - 1, Math.floor(n / 2), Math.floor(n / 3)]); return [...s].filter((i) => i < n); }
function compare(a, b) {
  const A = mu.Document.openDocument(a, 'application/pdf'), B = mu.Document.openDocument(b, 'application/pdf');
  const na = A.countPages(), nb = B.countPages();
  if (na !== nb) return { ok: false, why: `pages ${na} vs ${nb}` };
  let sizes = true, pixels = true;
  for (let i = 0; i < na; i++) { if (A.loadPage(i).getBounds().join() !== B.loadPage(i).getBounds().join()) sizes = false; }
  for (const i of sample(na)) {
    const r = (d) => d.loadPage(i).toPixmap(mu.Matrix.scale(0.15, 0.15), mu.ColorSpace.DeviceRGB, false, true).getPixels().slice();
    const pa = r(A), pb = r(B);
    if (Buffer.compare(Buffer.from(pa), Buffer.from(pb)) !== 0) pixels = false;
  }
  return { ok: sizes && pixels, pages: na, sizes, pixels };
}

const cases = [
  ['big-1000 (text, shared fonts)', fs.readFileSync(path.join(root, 'tests/fixtures/out/big-1000.pdf'))],
  ['shared-img+font 100p', makeShared(100)],
  ['arxiv-attention', fs.readFileSync(path.join(root, 'tests/engine/corpus/arxiv-attention/1706.03762.pdf'))],
];
const rows = [];
for (const [name, src] of cases) {
  const total = mu.Document.openDocument(src, 'application/pdf').countPages();
  const srcC = count(src);
  for (const k of [1, 10, 50, 100, total]) {
    if (k > total || (k === 50 && name !== 'arxiv-attention')) continue;
    const pos = Array.from({ length: k }, (_, i) => i);
    const a = extract(src, pos, false), b = extract(src, pos, true);
    const ca = count(a), cb = count(b), cmp = compare(a, b);
    rows.push({ name, srcPages: total, srcBytes: src.length, srcObjs: srcC, k, app: a.length, shared: b.length, ratio: +(a.length / b.length).toFixed(2), appObjs: ca, sharedObjs: cb, equiv: cmp });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
fs.writeFileSync(path.join(outDir, 'extract-size.json'), JSON.stringify(rows, null, 1));
