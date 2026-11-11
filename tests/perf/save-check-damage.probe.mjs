// L8 (1.5.3, design register C5): what does the pre-save page-fingerprint check catch, and what does it cost?
// No app. Uses the real src/engine/mupdf/pageFingerprint.ts (current check) on the same MuPDF WASM the worker uses, and a
// CANDIDATE check (whole content streams + all five boxes + resource and annotation facts) to see if it would close the misses.
// For each damage: open the base bytes, apply the damage with the MuPDF API, fingerprint every page, compare with the clean
// fingerprints of the same bytes (firstMismatch = how the save compares them). "caught" = at least one page differs.
// Timing: fingerprint passes over 1,000-page documents (text fixture, and 1,000 pages x 20 KB and x 100 KB content).
// Run: node --experimental-transform-types --no-warnings tests/perf/save-check-damage.probe.mjs [out.json]
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { pageFingerprints, firstMismatch } from '../../src/engine/mupdf/pageFingerprint.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

// ---- candidate check -------------------------------------------------------------------------------------------------
const FNV = 0x01000193;
const mix = (h, v) => Math.imul((h ^ (v & 0xff)) >>> 0, FNV) >>> 0;
const mixInt = (h, n) => { for (let s = 0; s < 32; s += 8) h = mix(h, n >>> s); return h; };
const mixStr = (h, str) => { for (let i = 0; i < str.length; i++) h = mix(h, str.charCodeAt(i)); return mix(h, 0x7c); };
const mixBytesAll = (h, b) => { h = mixInt(h, b.length); for (let i = 0; i < b.length; i++) h = mix(h, b[i]); return h; };
const mixBox = (h, box) => {
  try {
    if (box.isNull() || !box.isArray()) return mix(h, 0xee);
    for (let i = 0; i < Math.min(4, box.length); i++) h = mixInt(h, Math.round(box.get(i).asNumber() * 100));
  } catch { h = mix(h, 0xef); }
  return h;
};
function candidatePage(page) {
  let h = 0x811c9dc5;
  for (const k of ['MediaBox', 'CropBox']) h = mixBox(h, page.getInheritable(k));
  for (const k of ['TrimBox', 'BleedBox', 'ArtBox']) h = mixBox(h, page.get(k));
  const rot = page.getInheritable('Rotate');
  h = mixInt(h, rot.isNull() ? 0 : (((rot.asNumber() % 360) + 360) % 360));
  const c = page.get('Contents');
  const part = (s) => { if (s.isStream()) h = mixBytesAll(h, s.readRawStream().asUint8Array()); };
  if (!c.isNull()) {
    if (c.isArray()) { h = mixInt(h, c.length); for (let i = 0; i < c.length; i++) part(c.get(i)); } else part(c);
  }
  // resource facts: category names, entry names, and per entry: stream length / BaseFont / dictionary size
  const res = page.getInheritable('Resources');
  if (!res.isNull() && res.isDictionary()) {
    const cats = [];
    res.forEach((v, k) => cats.push([String(k), v]));
    cats.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [cat, dict] of cats) {
      h = mixStr(h, cat);
      const d = dict.isIndirect() ? dict.resolve() : dict;
      if (!d.isDictionary()) continue;
      const ents = [];
      d.forEach((v, k) => ents.push([String(k), v]));
      ents.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      for (const [name, v] of ents) {
        h = mixStr(h, name);
        const o = v.isIndirect() ? v.resolve() : v;
        if (o.isStream()) h = mixInt(h, o.readRawStream().asUint8Array().length);
        else if (o.isDictionary()) {
          const bf = o.get('BaseFont');
          h = mixStr(h, bf.isName() ? bf.asName() : '');
          let n = 0;
          o.forEach(() => n++);
          h = mixInt(h, n);
        }
      }
    }
  }
  const an = page.get('Annots');
  if (!an.isNull() && an.isArray()) {
    h = mixInt(h, an.length);
    for (let i = 0; i < an.length; i++) {
      const a = an.get(i);
      const st = a.get('Subtype');
      h = mixStr(h, st.isName() ? st.asName() : '');
      h = mixBox(h, a.get('Rect'));
      const ct = a.get('Contents');
      h = mixStr(h, ct.isString() ? ct.asString() : '');
      const ap = a.get('AP');
      h = mixInt(h, ap.isNull() ? 0 : 1);
    }
  } else h = mixInt(h, 0xa0);
  return h;
}
function candidateFingerprints(pdf) {
  const out = [];
  for (let i = 0; i < pdf.countPages(); i++) out.push(candidatePage(pdf.findPage(i)));
  return out;
}

// ---- base document ---------------------------------------------------------------------------------------------------
function longContent(bytes) {
  const lines = [];
  let n = 0;
  let i = 0;
  while (n < bytes) {
    const s = `${(i * 7) % 600} ${(i * 13) % 780} 3 2 re f\n`;
    lines.push(s);
    n += s.length;
    i++;
  }
  return lines.join('');
}
function buildBase() {
  const doc = new mupdf.PDFDocument();
  const helv = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const times = doc.addSimpleFont(new mupdf.Font('Times-Roman'));
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 64, 64], false);
  pm.clear(200);
  const img = doc.addImage(new mupdf.Image(pm));
  const resText = { Font: { F1: helv, F2: times }, XObject: { Im1: img } };
  const text = (n) => `BT /F1 14 Tf 72 700 Td (Page ${n} Helvetica) Tj ET BT /F2 12 Tf 72 680 Td (Times line) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q`;
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resText, text(1))); // p1: fonts, image
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resText, longContent(600 * 1024))); // p2: 600 KB content stream
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resText, text(3))); // p3: annotations
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resText, text(4))); // p4: Contents as an array of two 300 KB streams
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resText, text(5))); // p5: form XObject, ExtGState, TrimBox
  const p3 = doc.findPage(2);
  const link = doc.addObject(doc.newDictionary());
  link.put('Type', doc.newName('Annot'));
  link.put('Subtype', doc.newName('Link'));
  link.put('Rect', [72, 600, 200, 620]);
  const note = doc.addObject(doc.newDictionary());
  note.put('Type', doc.newName('Annot'));
  note.put('Subtype', doc.newName('Text'));
  note.put('Rect', [300, 600, 320, 620]);
  note.put('Contents', doc.newString('a note'));
  const annots = doc.newArray();
  annots.push(link);
  annots.push(note);
  p3.put('Annots', annots);
  const p4 = doc.findPage(3);
  const a = doc.addStream(longContent(300 * 1024), {});
  const b = doc.addStream(longContent(300 * 1024) + '\n', {});
  const arr = doc.newArray();
  arr.push(a);
  arr.push(b);
  p4.put('Contents', arr);
  const p5 = doc.findPage(4);
  p5.put('TrimBox', [10, 10, 600, 780]);
  const form = doc.addStream('0 0 50 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50] });
  const res5 = p5.get('Resources');
  res5.get('XObject').put('Fm1', form);
  const gs = doc.addObject(doc.newDictionary());
  gs.put('CA', 0.5);
  res5.put('ExtGState', doc.newDictionary());
  res5.get('ExtGState').put('GS1', gs);
  return doc.saveToBuffer('garbage=compact,compress=no').asUint8Array().slice();
}
const baseBytes = buildBase();
const open = () => mupdf.Document.openDocument(baseBytes.slice(), 'application/pdf').asPDF();

// ---- damages ---------------------------------------------------------------------------------------------------------
const pg = (pdf, i) => pdf.findPage(i);
const rawOf = (stream) => stream.readRawStream().asUint8Array().slice();
const flip = (stream, at) => {
  const b = rawOf(stream);
  b[at] = b[at] === 0x31 ? 0x32 : 0x31;
  stream.writeRawStream(b);
};
const damages = [
  ['asked', 'drop an image (remove it from the page resources)', (pdf) => { pg(pdf, 0).get('Resources').get('XObject').delete('Im1'); }],
  ['asked', 'drop an image (replace its pixels, same length)', (pdf) => {
    const im = pg(pdf, 0).get('Resources').get('XObject').get('Im1');
    const b = rawOf(im);
    for (let i = 0; i < b.length; i += 7) b[i] ^= 0x55;
    im.writeRawStream(b);
  }],
  ['asked', 'swap a font (rename BaseFont, same length)', (pdf) => { pg(pdf, 0).get('Resources').get('Font').get('F1').put('BaseFont', pdf.newName('Helvetice')); }],
  ['asked', 'swap a font (page uses the other font object)', (pdf) => { const f = pg(pdf, 0).get('Resources').get('Font'); f.put('F1', f.get('F2')); }],
  ['asked', 'remove an annotation (delete one of two)', (pdf) => { pg(pdf, 2).get('Annots').delete(1); }],
  ['asked', 'remove all annotations of a page', (pdf) => { pg(pdf, 2).delete('Annots'); }],
  ['asked', 'change an annotation (move its Rect)', (pdf) => { pg(pdf, 2).get('Annots').get(1).put('Rect', [301, 600, 321, 620]); }],
  ['asked', 'change an annotation (its note text, same length)', (pdf) => { pg(pdf, 2).get('Annots').get(1).put('Contents', pdf.newString('a nota')); }],
  ['asked', 'change the middle of a long content stream (byte at 300 KB of 600 KB)', (pdf) => flip(pg(pdf, 1).get('Contents'), 300 * 1024)],
  ['asked', 'change a long content stream just after the 64 KB head (byte at 70 KB)', (pdf) => flip(pg(pdf, 1).get('Contents'), 70 * 1024)],
  ['asked', 'change the middle of the 2nd stream of a Contents array (byte at 150 KB of 300 KB)', (pdf) => flip(pg(pdf, 3).get('Contents').get(1), 150 * 1024)],
  ['asked', 'change TrimBox', (pdf) => { pg(pdf, 4).put('TrimBox', [20, 20, 590, 770]); }],
  ['extra', 'add an ArtBox', (pdf) => { pg(pdf, 4).put('ArtBox', [30, 30, 580, 760]); }],
  ['extra', 'change a form XObject the page draws (same length)', (pdf) => flip(pg(pdf, 4).get('Resources').get('XObject').get('Fm1'), 0)],
  ['extra', 'change an ExtGState (opacity 0.5 to 0.4)', (pdf) => { pg(pdf, 4).get('Resources').get('ExtGState').get('GS1').put('CA', 0.4); }],
  ['control', 'change the first byte of a content stream', (pdf) => { const s = pg(pdf, 1).get('Contents'); const b = rawOf(s); b[0] = 0x58; s.writeRawStream(b); }],
  ['control', 'change the last byte of a content stream', (pdf) => { const s = pg(pdf, 1).get('Contents'); const b = rawOf(s); b[b.length - 1] = 0x58; s.writeRawStream(b); }],
  ['control', 'change a content stream length (append a byte)', (pdf) => { const s = pg(pdf, 1).get('Contents'); const b = rawOf(s); const n = new Uint8Array(b.length + 1); n.set(b); n[b.length] = 0x20; s.writeRawStream(n); }],
  ['control', 'rotate a page', (pdf) => { pg(pdf, 0).put('Rotate', 90); }],
  ['control', 'change MediaBox', (pdf) => { pg(pdf, 0).put('MediaBox', [0, 0, 595, 842]); }],
  ['control', 'add a CropBox', (pdf) => { pg(pdf, 0).put('CropBox', [10, 10, 500, 700]); }],
  ['control', 'delete a page', (pdf) => { pdf.deletePage(2); }],
  ['control', 'move a page', (pdf) => { const a = pdf.findPage(0); pdf.deletePage(0); pdf.insertPage(3, a); }],
];

const cleanCurrent = pageFingerprints(open());
const cleanCand = candidateFingerprints(open());
const resaved = mupdf.Document.openDocument(open().saveToBuffer('garbage=compact').asUint8Array().slice(), 'application/pdf').asPDF();
const sanity = {
  currentEqualAfterCompactResave: firstMismatch(cleanCurrent, pageFingerprints(resaved)) === -1,
  candidateEqualAfterCompactResave: firstMismatch(cleanCand, candidateFingerprints(resaved)) === -1,
};
console.log('sanity', JSON.stringify(sanity));
const rows = [];
for (const [group, name, fn] of damages) {
  const pdf = open();
  try {
    fn(pdf);
  } catch (e) {
    rows.push({ group, name, applied: false, error: String(e.message ?? e) });
    console.log(`NOT APPLIED ${name}: ${e.message}`);
    continue;
  }
  const cur = firstMismatch(cleanCurrent, pageFingerprints(pdf)) !== -1;
  const cand = firstMismatch(cleanCand, candidateFingerprints(pdf)) !== -1;
  rows.push({ group, name, current: cur, candidate: cand });
  console.log(`${cur ? 'CAUGHT' : 'MISSED'} (candidate ${cand ? 'caught' : 'MISSED'})  [${group}] ${name}`);
}

// ---- timing ----------------------------------------------------------------------------------------------------------
function heavyDoc(pages, kb) {
  const doc = new mupdf.PDFDocument();
  const helv = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const res = { Font: { F1: helv } };
  const body = longContent(kb * 1024);
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, `% ${i}\n` + body));
  return doc;
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function timeIt(label, pdf, repeat = 5) {
  const out = {};
  for (const [kind, fn] of [['current', pageFingerprints], ['candidate', candidateFingerprints]]) {
    fn(pdf);
    const t = [];
    for (let i = 0; i < repeat; i++) {
      const t0 = performance.now();
      fn(pdf);
      t.push(performance.now() - t0);
    }
    out[kind] = { medianMs: +median(t).toFixed(0), minMs: +Math.min(...t).toFixed(0), maxMs: +Math.max(...t).toFixed(0) };
  }
  console.log(label, JSON.stringify(out));
  return { label, pages: pdf.countPages(), ...out };
}
const timings = [];
timings.push(timeIt('big-1000.pdf (text, 1,000 pages, 0.6 MB)', mupdf.Document.openDocument(readFileSync(join(ROOT, 'tests/fixtures/out/big-1000.pdf')), 'application/pdf').asPDF()));
timings.push(timeIt('synthetic 1,000 pages x 20 KB content (20 MB)', heavyDoc(1000, 20)));
timings.push(timeIt('synthetic 1,000 pages x 100 KB content (100 MB)', heavyDoc(1000, 100), 3));
for (const [label, rel] of [
  ['corpus arxiv-attention', 'tests/engine/corpus/arxiv-attention/1706.03762.pdf'],
  ['corpus brochure-images', 'tests/engine/corpus/brochure-images/brochure.pdf'],
  ['corpus scanned-gray', 'tests/engine/corpus/scanned-gray/perf_images_scan_gray.pdf'],
  ['corpus images-misc', 'tests/engine/corpus/images-misc/images.pdf'],
  ['corpus irs-fw9', 'tests/engine/corpus/irs-fw9/fw9.pdf'],
]) {
  const p = join(ROOT, rel);
  if (existsSync(p)) timings.push(timeIt(label, mupdf.Document.openDocument(readFileSync(p), 'application/pdf').asPDF(), 9));
}
const asked = rows.filter((r) => r.group === 'asked');
const summary = { sanity, damages: rows, timings, counts: { asked: asked.length, askedCaughtCurrent: asked.filter((r) => r.current).length, askedCaughtCandidate: asked.filter((r) => r.candidate).length } };
console.log(JSON.stringify(summary.counts));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(summary, null, 2));
