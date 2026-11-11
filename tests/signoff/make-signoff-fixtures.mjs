// Sign-off fixtures: a search-alignment page with known glyph positions, and a heavier 1,000-page file.
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const render = (doc, file) => new Promise((res, rej) => { const s = createWriteStream(join(OUT, file)); doc.pipe(s); s.on('finish', res); s.on('error', rej); doc.end(); });

// 1. Search alignment: each line is one text run; the target word's true x comes from pdfkit's metrics.
{
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

// 2. Heavy 1,000 pages: a full page of body text plus vector shapes on every page.
{
  const doc = new PDFDocument({ size: 'LETTER', autoFirstPage: false });
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ';
  for (let p = 1; p <= 1000; p++) {
    doc.addPage({ margin: 54 });
    doc.fontSize(16).text(`Heavy page ${p}`, { align: 'left' });
    doc.moveDown(0.5).fontSize(9.5).text(para.repeat(11), { align: 'justify' });
    for (let k = 0; k < 40; k++) {
      doc.save().lineWidth(0.5).strokeColor(k % 2 ? '#3366cc' : '#cc6633').circle(80 + (k % 10) * 48, 640 + Math.floor(k / 10) * 30, 12).stroke().restore();
    }
  }
  await render(doc, 'heavy-1000.pdf');
}
console.log(`signoff fixtures in ${OUT}`);
