// Harder search-alignment fixture (not shared with the builders' tests): other standard fonts, an embedded
// TrueType font, word spacing, character spacing, a large bold size, two fonts on one line, and a justified
// paragraph line. Expected glyph x positions come from pdfkit's own metrics.
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
const W = 'qwertarget';
const expected = [];
let y = 60;
const add = (label, x, width) => { expected.push({ line: expected.length + 1, label, x, width, y }); y += 40; };

function plain(label, font, size, prefix, suffix, opts = {}) {
  doc.font(font).fontSize(size);
  doc.text(prefix + W + suffix, 72, y, { lineBreak: false, ...opts });
  const cs = opts.characterSpacing ?? 0;
  const ws = opts.wordSpacing ?? 0;
  const spaces = (prefix.match(/ /g) ?? []).length;
  const x = 72 + doc.widthOfString(prefix) + cs * prefix.length + ws * spaces;
  add(label, x, doc.widthOfString(W) + cs * (W.length - 1));
}

plain('Times-Roman 12', 'Times-Roman', 12, 'Quite a fanciful affiliation, WAVY: ', ' follows here.');
plain('Courier 12', 'Courier', 12, 'mono spaced line here: ', ' end');
plain('Embedded Arial 14', 'C:/Windows/Fonts/arial.ttf', 14, 'Embedded AVAWAY To Wo: ', ' kerning test');
plain('Embedded Georgia 13', 'C:/Windows/Fonts/georgia.ttf', 13, 'Georgia illuminating fill: ', ' and more');
plain('Helvetica-Bold 22', 'Helvetica-Bold', 22, 'Big bold MW heading ', '');
plain('Helvetica wordSpacing 6', 'Helvetica', 12, 'Words spread out across this line: ', ' done here', { wordSpacing: 6 });
plain('Helvetica charSpacing 1.5', 'Helvetica', 12, 'Letters spaced apart: ', ' done', { characterSpacing: 1.5 });

// Two fonts on one line.
doc.font('Times-Roman').fontSize(12).text('Mixed WWW ', 72, y, { continued: true, lineBreak: false });
const xTimes = doc.widthOfString('Mixed WWW ');
doc.font('Helvetica').fontSize(12).text(`iiii fonts: ${W} end`, { lineBreak: false });
add('Times then Helvetica', 72 + xTimes + doc.widthOfString('iiii fonts: '), doc.widthOfString(W));

// Justified line: each word is placed at an explicit x, with the extra width spread over the gaps. The
// expected x of the target is then exact. (pdfkit's own justification spreads the width differently, so
// positioning from its widths would be an estimate.)
doc.font('Helvetica').fontSize(11);
const line1 = `Justified text stretches ${W} across the full measure`;
const words = line1.split(' ');
const width1 = 460;
const space = doc.widthOfString(' ');
const natural = words.reduce((sum, w) => sum + doc.widthOfString(w), 0) + space * (words.length - 1);
const gap = (width1 - natural) / (words.length - 1);
let x = 72;
for (const word of words) {
  const at = { x, y };
  doc.text(word, x, at.y, { lineBreak: false });
  if (word === W) expected.push({ line: expected.length + 1, label: 'Justified line (exact)', x: at.x, width: doc.widthOfString(W), y: at.y });
  x += doc.widthOfString(word) + space + gap;
}
await new Promise((res, rej) => { const s = createWriteStream(join(OUT, 'search-align2.pdf')); doc.pipe(s); s.on('finish', res); s.on('error', rej); doc.end(); });
writeFileSync(join(OUT, 'search-align2.json'), JSON.stringify(expected, null, 2));
console.log(JSON.stringify(expected.map((e) => [e.label, e.x.toFixed(1), e.width.toFixed(1)])));
