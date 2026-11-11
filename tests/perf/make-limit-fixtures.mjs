// Fixture generator for the 1.5.3 limit runs (L1, L5, L7). Streams a plain PDF to disk, so a 1 GB file needs little memory.
// Big generated files are NEVER committed: write them to a temp folder (default %TEMP%\pdfsuite-limits) and delete them after the run.
//
//   node tests/perf/make-limit-fixtures.mjs image <MB> [outDir]   image-heavy: scanned-style pages, one JPEG (about 4-7 MB, 2480x3508) per page
//   node tests/perf/make-limit-fixtures.mjs text  <MB> [outDir]   text-heavy: pages with 100 KB of uncompressed text operators each (about 16x denser than a book page)
//   node tests/perf/make-limit-fixtures.mjs dense <pages> [outDir] L5: <pages> pages of 3,000-character book text (about 50 lines of 60 characters), real words
//
// MB means MiB (1,048,576 bytes). The file size reaches the target to within one page.
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as mupdf from 'mupdf';

const [kind, amountArg, outArg] = process.argv.slice(2);
const amount = Number(amountArg);
if (!['image', 'text', 'dense'].includes(kind) || !(amount > 0)) {
  console.error('usage: make-limit-fixtures.mjs image|text <MB> | dense <pages> [outDir]');
  process.exit(2);
}
const outDir = outArg ?? join(tmpdir(), 'pdfsuite-limits');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, kind === 'dense' ? `dense-${amount}p.pdf` : `${kind}-${amount}MB.pdf`);

// A small deterministic PRNG, so a fixture is the same every time.
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const SYL = ['ba', 'ke', 'li', 'mo', 'ru', 'sta', 'ren', 'dor', 'fin', 'gal', 'hu', 'jo', 'tra', 'ven', 'wi', 'xe', 'yo', 'zan', 'pre', 'con'];
const WORDS = Array.from({ length: 3000 }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => SYL[Math.floor(rnd() * SYL.length)]).join(''));
const word = () => WORDS[Math.floor(rnd() * WORDS.length)];
const line = (chars) => { let s = ''; while (s.length < chars) s += `${word()} `; return s.slice(0, chars).replace(/[()\\]/g, ''); };

/** Content stream of a text page: `lines` lines of `chars` characters in Helvetica. */
function textContent(lines, chars, fontSize) {
  const parts = ['BT /F1 ' + fontSize + ' Tf'];
  for (let i = 0; i < lines; i++) { const rows = Math.floor(740 / (fontSize + 1.5)); parts.push(`1 0 0 1 ${(36 + Math.floor(i / rows) * 0.4).toFixed(1)} ${(780 - (i % rows) * (fontSize + 1.5)).toFixed(1)} Tm (${line(chars)}) Tj`); }
  parts.push('ET');
  return parts.join('\n');
}

// JPEG sources for the image kind: a few distinct noisy 2480x3508 pages (A4 at 300 dpi).
function makeJpegs(count) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const w = 2480, h = 3508;
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    const px = pm.getPixels();
    for (let y = 0; y < h; y++) {
      const base = y * w * 3;
      for (let x = 0; x < w; x++) {
        const i = base + x * 3;
        const n = (rnd() * 70) | 0;
        px[i] = ((x + k * 40) >> 4) + n;
        px[i + 1] = ((y + k * 25) >> 4) + n;
        px[i + 2] = (((x + y) >> 5) + n + k * 30) & 255;
      }
    }
    out.push(pm.asJPEG(85));
  }
  return out;
}

const target = kind === 'dense' ? 0 : amount * 1048576;
const stream = createWriteStream(outPath);
let offset = 0;
const offsets = [];
async function write(buf) {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'latin1') : buf;
  offset += b.length;
  if (!stream.write(b)) await once(stream, 'drain');
}
const beginObj = async (n) => { offsets[n] = offset; await write(`${n} 0 obj\n`); };

// Object numbers: 1 catalog, 2 pages, 3 font, then per page: (page, contents[, image]).
const perPage = kind === 'image' ? 3 : 2;
const pageObj = (i) => 4 + i * perPage;
const jpegs = kind === 'image' ? makeJpegs(4) : null;
const textPage = kind === 'dense' ? () => textContent(50, 60, 11) : () => textContent(Math.floor(100 * 1024 / 103), 70, 6);
// A text page costs about 100 KB; compute pages from the target, then write. The page tree needs the count up front.
let pages;
if (kind === 'dense') pages = amount;
else if (kind === 'text') pages = Math.max(1, Math.round(target / (97500)));
else pages = Math.max(1, Math.round(target / (jpegs.reduce((s, j) => s + j.length, 0) / jpegs.length + 400)));

await write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
await beginObj(1); await write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
await beginObj(2);
await write(`<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>\nendobj\n`);
await beginObj(3); await write('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
const cache = [];
for (let i = 0; i < pages; i++) {
  const p = pageObj(i);
  const res = kind === 'image' ? '/Font << /F1 3 0 R >> /XObject << /Im0 ' + (p + 2) + ' 0 R >>' : '/Font << /F1 3 0 R >>';
  const box = kind === 'image' ? '[0 0 595 842]' : '[0 0 612 792]';
  await beginObj(p);
  await write(`<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Resources << ${res} >> /Contents ${p + 1} 0 R >>\nendobj\n`);
  let content;
  if (kind === 'image') content = `q 595 0 0 842 0 0 cm /Im0 Do Q BT /F1 10 Tf 20 20 Td (scan ${i + 1}) Tj ET`;
  else {
    // 16 distinct text pages are reused in rotation, with the page number stamped, so building stays fast.
    const slot = i % 16;
    cache[slot] ??= textPage();
    content = cache[slot] + `\nBT /F1 8 Tf 300 20 Td (page ${i + 1}) Tj ET`;
  }
  await beginObj(p + 1);
  await write(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n`);
  await write(content);
  await write('\nendstream\nendobj\n');
  if (kind === 'image') {
    const jpg = jpegs[i % jpegs.length];
    await beginObj(p + 2);
    await write(`<< /Type /XObject /Subtype /Image /Width 2480 /Height 3508 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    await write(Buffer.from(jpg.buffer, jpg.byteOffset, jpg.length));
    await write('\nendstream\nendobj\n');
  }
}
const count = 4 + pages * perPage;
const xrefAt = offset;
let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
await write(xref + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
stream.end();
await once(stream, 'finish');
console.log(JSON.stringify({ path: outPath, pages, bytes: statSync(outPath).size, mb: +(statSync(outPath).size / 1048576).toFixed(1) }));
