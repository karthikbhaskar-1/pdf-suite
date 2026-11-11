// Generates the PDF fixtures used by the e2e tests into tests/fixtures/out/.
// Run: npm run fixtures   (also run automatically by test:e2e)
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import PDFDocument from 'pdfkit';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = join(here, 'out');
export const KNOWN_WORD = 'zephyrbloom';
export const BIG_PAGES = 1000;
export const LOCK_PASSWORD = 'test123';

mkdirSync(OUT, { recursive: true });

/** Writes a pdfkit document to a file and resolves when it is flushed. */
function render(doc, file) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(join(OUT, file));
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.end();
  });
}

async function bigTextPdf() {
  const doc = new PDFDocument({ size: 'LETTER', autoFirstPage: false, info: { Title: 'Big 1000 page fixture' } });
  let chapter = null;
  for (let p = 1; p <= BIG_PAGES; p++) {
    doc.addPage();
    // A chapter every 100 pages, each with one section, so the outline has two levels.
    if ((p - 1) % 100 === 0) {
      chapter = doc.outline.addItem(`Chapter ${(p - 1) / 100 + 1} (page ${p})`);
      chapter.addItem(`Section at page ${p}`);
    }
    doc.fontSize(14).text(`Page ${p} of ${BIG_PAGES}. Known word: ${KNOWN_WORD}. Filler line for layout.`, 72, 72);
    doc.fontSize(10).text(`Second line on page ${p}, no match here.`, 72, 100);
  }
  await render(doc, 'big-1000.pdf');
}

async function lockedPdf() {
  const doc = new PDFDocument({
    size: 'LETTER',
    userPassword: LOCK_PASSWORD,
    ownerPassword: 'owner-not-test',
    info: { Title: 'Locked fixture' },
  });
  doc.fontSize(20).text(`Locked document. Password is ${LOCK_PASSWORD}. Secret word: ${KNOWN_WORD}.`, 72, 72);
  await render(doc, 'locked.pdf');
}

/**
 * Four text lines in Helvetica at known positions. The true x and width of each target word come from
 * pdfkit's glyph metrics, and are written to search-align.json for the search highlight test.
 */
async function searchAlignPdf() {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
  const lines = [
    'Known word: zephyrbloom. Filler line for layout.',
    'The committee will illuminate little filling details in its final report about qwertarget today.',
    'WWW MMM WWW MMM WWW MMM WWW: qwertarget then some more ordinary words follow here.',
    'iiii llll iiii llll iiii llll iiii llll iiii llll iiii llll: qwertarget and the rest.',
  ];
  const expected = [];
  let y = 72;
  doc.font('Helvetica').fontSize(12);
  for (const line of lines) {
    doc.text(line, 72, y, { lineBreak: false });
    const word = line.includes('zephyrbloom') ? 'zephyrbloom' : 'qwertarget';
    const prefix = line.slice(0, line.indexOf(word));
    expected.push({ line: expected.length + 1, word, x: 72 + doc.widthOfString(prefix), width: doc.widthOfString(word), y });
    y += 30;
  }
  await render(doc, 'search-align.pdf');
  writeFileSync(join(OUT, 'search-align.json'), JSON.stringify(expected, null, 2));
}

async function mixedPdf() {
  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: 'Mixed sizes' } });
  const specs = [
    { size: 'LETTER', label: 'Letter portrait' },
    { size: 'A4', label: 'A4 portrait' },
    { size: [612, 792], label: 'Letter as explicit points' },
    { size: 'A3', layout: 'landscape', label: 'A3 landscape' },
    { size: [300, 300], label: 'Small square' },
    { size: 'LETTER', label: 'Letter rotated 90', rotate: 90 },
    { size: 'A5', label: 'A5 rotated 180', rotate: 180 },
    { size: [500, 900], label: 'Tall custom rotated 270', rotate: 270 },
  ];
  specs.forEach((spec, i) => {
    doc.addPage({ size: spec.size, layout: spec.layout ?? 'portrait' });
    doc.fontSize(18).text(`Page ${i + 1}: ${spec.label}`, 40, 40);
    if (spec.rotate) doc.page.dictionary.data.Rotate = spec.rotate;
  });
  await render(doc, 'mixed-sizes-rotated.pdf');
}

/**
 * Four Letter pages. Page N has, all well-formed: a text note "note N" with its popup, a yellow highlight over the title
 * with the contents "highlight N", a URI link to https://example.test/pN, and a black box. That is 4 annotations a page
 * (Text, Popup, Highlight, Link). The note and highlight texts are real PDF strings (pdfkit writes a plain JS string as a
 * NAME, which for text with a space is not parseable, so they are wrapped in String objects). Object dictionaries are
 * uncompressed.
 */
async function annotatedLinksPdf() {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, compress: false, info: { Title: 'Annotated and linked' } });
  for (let p = 1; p <= 4; p++) {
    if (p > 1) doc.addPage();
    doc.fontSize(24).text(`Annotated page ${p}`, 72, 72);
    doc.rect(72, 200, 200, 60).fill('#000000');
    // Rects are in PDF space (origin bottom left, page 792 high).
    const note = doc.ref({ Type: 'Annot', Subtype: 'Text', Rect: [72, 472, 92, 492], Border: [0, 0, 0], C: [1, 0.8, 0], Contents: new String(`note ${p}`), Name: 'Note', Open: false, F: 4 });
    const popup = doc.ref({ Type: 'Annot', Subtype: 'Popup', Rect: [100, 400, 300, 490], Border: [0, 0, 0], Parent: note, Open: false });
    note.data.Popup = popup;
    const highlight = doc.ref({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [72, 690, 300, 722],
      Border: [0, 0, 0],
      C: [1, 1, 0],
      QuadPoints: [72, 722, 300, 722, 72, 690, 300, 690],
      Contents: new String(`highlight ${p}`),
      F: 4,
    });
    for (const ref of [note, popup, highlight]) {
      doc.page.annotations.push(ref);
      ref.end();
    }
    doc.link(72, 400, 200, 30, `https://example.test/p${p}`);
  }
  await render(doc, 'annotated-links.pdf');
}

/**
 * Letter pages with a black rectangle that leaves exactly 72 pt of white on every side (x 72 to 540, y 72 to 720).
 * Auto-crop should give a CropBox of [72 72 540 720] in PDF points.
 */
async function marginsPdf() {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: 'Known white margins' } });
  for (let p = 1; p <= 2; p++) {
    if (p > 1) doc.addPage();
    doc.rect(72, 72, 468, 648).fill('#000000');
  }
  await render(doc, 'margins-white.pdf');
}

/** Six Letter pages, each with its number, and outline entries on pages 2 ("Intro"), 4 ("Middle") and 6 ("End"). */
async function outlinePdf() {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: 'Outline fixture' } });
  for (let p = 1; p <= 6; p++) {
    if (p > 1) doc.addPage();
    doc.fontSize(28).text(`Outline page ${p}`, 72, 72);
    if (p === 2) doc.outline.addItem('Intro');
    if (p === 4) doc.outline.addItem('Middle');
    if (p === 6) doc.outline.addItem('End');
  }
  await render(doc, 'outline-6.pdf');
}

/** Returns a tiny valid PNG (solid colour) as bytes. */
function tinyPng(width = 64, height = 64) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(0); // filter type: none
    for (let x = 0; x < width; x++) rows.push(x < width / 2 ? 0xc0 : 0x30, 0x40, 0xe0);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  await bigTextPdf();
  await lockedPdf();
  await mixedPdf();
  await annotatedLinksPdf();
  await marginsPdf();
  await outlinePdf();

  // Truncated: the first half of a valid PDF, so the cross-reference table and end-of-file are gone.
  const whole = readFileSync(join(OUT, 'mixed-sizes-rotated.pdf'));
  writeFileSync(join(OUT, 'truncated.pdf'), whole.subarray(0, Math.floor(whole.length / 2)));

  // A PNG with a .pdf extension.
  writeFileSync(join(OUT, 'png-renamed.pdf'), tinyPng());

  // Zero bytes.
  writeFileSync(join(OUT, 'empty.pdf'), Buffer.alloc(0));

  // Non-PDF files a user can pick: a text file and a real PNG.
  writeFileSync(join(OUT, 'notes.txt'), 'Just some text, not a PDF.\n');
  writeFileSync(join(OUT, 'picture.png'), tinyPng());

  await searchAlignPdf();

  console.log(`fixtures written to ${OUT}`);
}

// Only run when executed directly, so tests can import the constants.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
export { main as makeFixtures };
