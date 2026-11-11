// Independent reader for files written by the app. Uses the mupdf npm package in plain node (not the app's worker code)
// and pdfjs-dist as a second opinion. Usage: node inspect.mjs <file.pdf> [password]
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const num = (o) => (o && !o.isNull() ? o.asNumber() : null);
const arr = (o) => {
  if (!o || o.isNull() || !o.isArray()) return null;
  const out = [];
  for (let i = 0; i < o.length; i++) out.push(Math.round(o.get(i).asNumber() * 100) / 100);
  return out;
};
function inherited(page, key) {
  let node = page;
  for (let hops = 0; hops < 50 && node && !node.isNull(); hops++) {
    const v = node.get(key);
    if (v && !v.isNull()) return v;
    node = node.get('Parent');
  }
  return null;
}

export function inspectMupdf(path, password) {
  const bytes = readFileSync(path);
  const head = bytes.subarray(0, 8).toString('latin1');
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const needs = doc.needsPassword();
  let auth = null;
  if (needs) {
    auth = password ? doc.authenticatePassword(password) : 0;
    if (!auth) return { ok: false, needsPassword: true, size: bytes.length };
  }
  const pdf = doc.asPDF();
  const n = doc.countPages();
  const pages = [];
  for (let i = 0; i < n; i++) {
    const obj = pdf.findPage(i);
    const page = doc.loadPage(i);
    let text = '';
    try {
      text = page.toStructuredText().asText().replace(/\s+/g, ' ').trim().slice(0, 60);
    } catch (e) {
      text = `!text-error ${e.message}`;
    }
    const annots = obj.get('Annots');
    const b = page.getBounds();
    pages.push({
      media: arr(inherited(obj, 'MediaBox')),
      crop: arr(inherited(obj, 'CropBox')),
      rotate: num(inherited(obj, 'Rotate')) ?? 0,
      shown: [Math.round((b[2] - b[0]) * 100) / 100, Math.round((b[3] - b[1]) * 100) / 100],
      annots: annots && !annots.isNull() && annots.isArray() ? annots.length : 0,
      text,
    });
  }
  let outline = null;
  try {
    const flat = [];
    const walk = (items) => {
      for (const it of items ?? []) {
        flat.push({ title: it.title, page: typeof it.page === 'number' ? it.page + 1 : it.page });
        walk(it.down);
      }
    };
    walk(doc.loadOutline());
    outline = flat;
  } catch (e) {
    outline = `!outline-error ${e.message}`;
  }
  const trailer = pdf.getTrailer();
  const enc = trailer.get('Encrypt');
  return {
    ok: true,
    size: bytes.length,
    header: head.trim(),
    eof: /%%EOF\s*$/.test(tail),
    encrypted: !!(enc && !enc.isNull()),
    needsPassword: needs,
    count: n,
    pages,
    outline,
  };
}

export async function inspectPdfjs(path, password) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const task = pdfjs.getDocument({ data, password, verbosity: 0, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100, rotate: page.rotate, text: tc.items.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60) });
  }
  const count = doc.numPages;
  await task.destroy();
  return { count, pages };
}

if (process.argv[1] && process.argv[1].endsWith('inspect.mjs')) {
  const [, , file, password] = process.argv;
  const a = inspectMupdf(file, password);
  console.log(JSON.stringify(a, null, 1));
  if (a.ok) {
    try {
      console.log(JSON.stringify(await inspectPdfjs(file, password), null, 1));
    } catch (e) {
      console.log('pdfjs error: ' + e.message);
    }
  }
}
