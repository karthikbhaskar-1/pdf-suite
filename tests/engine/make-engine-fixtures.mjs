// Builds the derived engine-test fixtures into tests/engine/corpus/derived/ (gitignored with the corpus).
// Inputs: the corpus downloads. Outputs: encrypted, truncated, damaged-xref and letter-spaced PDFs.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import PDFDocument from 'pdfkit';

const here = dirname(fileURLToPath(import.meta.url));

const mupdf = await import('mupdf');
const OUT = join(here, 'corpus', 'derived');
const FW9 = join(here, 'corpus', 'irs-fw9', 'fw9.pdf');
const AES_PASSWORD = 'aes256pw';

mkdirSync(OUT, { recursive: true });

// AES-256 encrypted copy of the fw9 form. Opening needs AES_PASSWORD.
const fw9Bytes = readFileSync(FW9);
const doc = mupdf.Document.openDocument(fw9Bytes, 'application/pdf').asPDF();
const encrypted = doc.saveToBuffer(`encrypt=aes-256,user-password=${AES_PASSWORD},owner-password=${AES_PASSWORD}`).asUint8Array();
writeFileSync(join(OUT, 'aes256-locked.pdf'), encrypted);

// Truncated: the first half of the fw9 bytes (no xref, no trailer).
writeFileSync(join(OUT, 'truncated-half.pdf'), fw9Bytes.subarray(0, Math.floor(fw9Bytes.length / 2)));

// Damaged xref: startxref points at a wrong offset. Trailer and objects are intact.
const damaged = Buffer.from(fw9Bytes);
const tail = damaged.lastIndexOf('startxref');
if (tail > 0) {
  const digits = damaged.subarray(tail + 9).toString('latin1').match(/\d+/);
  if (digits) {
    const at = tail + 9 + damaged.subarray(tail + 9).toString('latin1').indexOf(digits[0]);
    const wrong = String(Number(digits[0]) + 7).padEnd(digits[0].length, '0');
    damaged.write(wrong, at, 'latin1');
  }
}
writeFileSync(join(OUT, 'damaged-xref.pdf'), damaged);

// Letter-spaced text: page 1 holds literal "q w e r t y" glyphs with spaces; page 2 holds "qwerty"
// drawn with wide character spacing, so the glyphs look spaced out on the page.
await new Promise((resolve, reject) => {
  const pdf = new PDFDocument({ size: 'LETTER' });
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  pdf.on('end', () => {
    writeFileSync(join(OUT, 'letter-spaced.pdf'), Buffer.concat(chunks));
    resolve();
  });
  pdf.on('error', reject);
  pdf.fontSize(24).text('q w e r t y literal', 72, 100);
  pdf.addPage();
  pdf.fontSize(24).text('qwerty spaced', 72, 100, { characterSpacing: 9 });
  pdf.end();
});

// CropBox smaller than the MediaBox, and a CropBox larger than the MediaBox (clipped), on the brochure page.
// Both engines must report the page size as CropBox intersected with MediaBox.
const BROCHURE = join(here, 'corpus', 'brochure-images', 'brochure.pdf');
function withCropBox(name, crop) {
  const d = mupdf.Document.openDocument(readFileSync(BROCHURE), 'application/pdf').asPDF();
  const array = d.newArray();
  for (const v of crop) array.push(d.newInteger(v));
  d.findPage(0).put('CropBox', array);
  writeFileSync(join(OUT, name), d.saveToBuffer('').asUint8Array());
}
withCropBox('cropbox-mediabox.pdf', [50, 60, 500, 700]);
withCropBox('cropbox-larger-than-mediabox.pdf', [0, 0, 900, 1000]);

rmSync(join(OUT, '.tmp'), { recursive: true, force: true });
console.log(`wrote derived fixtures to ${OUT}`);
console.log(`aes256 user password: ${AES_PASSWORD}`);
