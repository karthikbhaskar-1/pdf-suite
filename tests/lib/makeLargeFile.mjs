// Makes a valid PDF of an exact byte size, fast, for the file-size limit tests (1.5.10). Pure Node, no app.
//
// The pages are small and real (each shows "<word> page <n>" so search and scroll have something to find). The bulk of the file is
// ONE unreferenced stream object after the pages (never read by any viewer), so a 520 MB file is written in about a second and opens
// like a small one apart from the reading of the bytes. The cross-reference table is exact, so no viewer has to repair the file.
//
//   const file = makeLargeFile({ path, bytes: 520 * 1024 * 1024, pages: 12 });   // file.bytes === the size asked for, exactly
//
// Big generated files are NEVER committed: write them to a temp folder and delete them after the run (removeLargeFile).
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const PAD_CHUNK = 8 * 1024 * 1024;

function pageStream(word, n) {
  return `BT /F1 36 Tf 72 700 Td (${word} page ${n}) Tj ET\n`;
}

/**
 * The parts before the pad object, as one string, and the offsets of every object (the pad object's included, which follows
 * straight after).
 */
function build(pages, word) {
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pages }, (_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    const contents = 5 + 2 * i;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    const text = pageStream(word, i + 1);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}endstream`);
  }
  const header = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  let body = header;
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  return { body, offsets, padNumber: objects.length + 1 };
}

/** Writes the file and returns { path, bytes, pages }. `bytes` is exact. */
export function makeLargeFile({ path, bytes, pages = 12, word = 'limitneedle' }) {
  mkdirSync(dirname(path), { recursive: true });
  const { body, offsets, padNumber } = build(pages, word);
  const objectCount = padNumber; // objects 1..padNumber
  const padHead = (length) => `${padNumber} 0 obj\n<< /Length ${length} >>\nstream\n`;
  const padTail = '\nendstream\nendobj\n';
  // Find the pad length that makes the whole file exactly `bytes`. The number of digits of the length and of the xref offset
  // change the size by a byte or two, so it is solved by trying.
  const layoutFor = (length) => {
    const padOffset = body.length;
    const padEnd = padOffset + padHead(length).length + length + padTail.length;
    let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
    for (const offset of [...offsets, padOffset]) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    const trailer = `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${padEnd}\n%%EOF\n`;
    return { xref, trailer, total: padEnd + xref.length + trailer.length };
  };
  let length = bytes - body.length - 400;
  if (length < 0) throw new Error(`a file of ${bytes} bytes is too small for ${pages} pages`);
  for (let i = 0; i < 10; i++) {
    const layout = layoutFor(length);
    if (layout.total === bytes) break;
    length += bytes - layout.total;
  }
  const layout = layoutFor(length);
  if (layout.total !== bytes) throw new Error(`could not reach exactly ${bytes} bytes (got ${layout.total})`);
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, Buffer.from(body, 'latin1'));
    writeSync(fd, Buffer.from(padHead(length), 'latin1'));
    const chunk = Buffer.alloc(Math.min(PAD_CHUNK, Math.max(1, length)), 0x78); // "x"
    for (let left = length; left > 0; left -= chunk.length) writeSync(fd, chunk, 0, Math.min(chunk.length, left));
    writeSync(fd, Buffer.from(padTail + layout.xref + layout.trailer, 'latin1'));
  } finally {
    closeSync(fd);
  }
  const size = statSync(path).size;
  if (size !== bytes) throw new Error(`wrote ${size} bytes, wanted ${bytes}`);
  return { path, bytes: size, pages };
}

/** Deletes a generated file (and does not complain when it is gone). */
export function removeLargeFile(file) {
  try {
    rmSync(typeof file === 'string' ? file : file.path, { force: true });
  } catch {
    // Nothing more can be done: a temp file left behind is harmless.
  }
}
