// Independent reader check: extract page-1 text from the edited PDFs with pdf.js (a second
// parser, separate from MuPDF) and confirm the reversed word is present and the original is gone
// from that line. Run after edit-spike.mjs. Reads tests/trial/results/1.2.0.json.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = JSON.parse(fs.readFileSync(path.join(HERE, "results", "1.2.0.json"), "utf8"));
const out = [];
for (const f of results.files) {
  if (!f.editedFile || !f.word) continue;
  const data = new Uint8Array(fs.readFileSync(path.join(HERE, f.editedFile)));
  const doc = await pdfjs.getDocument({ data, disableWorker: true, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(" ");
  out.push({
    id: f.id,
    reversedFound: text.includes(f.word.reversed),
    originalFoundOnPage1: new RegExp(`\b${f.word.original}\b`).test(text),
  });
  await doc.destroy();
}
for (const r of out) console.log(JSON.stringify(r));
