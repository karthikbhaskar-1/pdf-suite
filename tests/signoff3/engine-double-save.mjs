// Not an app run: plain node + the mupdf package. Question: after one incremental saveToBuffer whose bytes are thrown
// away (the write to disk failed), does a second incremental saveToBuffer still contain the edit?
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const file = process.argv[2];
const bytes = readFileSync(file);
const count = (buf) => {
  const d = mupdf.Document.openDocument(buf, 'application/pdf');
  const n = d.countPages();
  const rot = d.asPDF().findPage(0).getInheritable('Rotate');
  const r = rot.isNull() ? 0 : rot.asNumber();
  d.destroy();
  return `${n} pages, page 1 /Rotate ${r}`;
};

for (const journal of [false, true]) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF();
  if (journal) doc.enableJournal();
  if (journal) doc.beginOperation('edit');
  // The edit: a quarter turn of page 1, and a copy of page 1 appended (what Duplicate and Rotate do).
  const page = doc.findPage(0);
  page.put('Rotate', 90);
  const copy = doc.addObject(doc.newDictionary());
  for (const key of ['Type', 'MediaBox', 'Contents', 'Resources', 'Parent']) {
    const v = page.get(key);
    if (!v.isNull()) copy.put(key, v);
  }
  doc.insertPage(-1, copy);
  if (journal) doc.endOperation();
  console.log(`journal=${journal}: in memory: ${doc.countPages()} pages; canBeSavedIncrementally=${doc.canBeSavedIncrementally()}`);
  const first = doc.saveToBuffer('incremental').asUint8Array().slice();
  console.log(`  1st incremental save (bytes thrown away, as after a failed write): ${first.length} bytes -> ${count(first)}`);
  const second = doc.saveToBuffer('incremental').asUint8Array().slice();
  console.log(`  2nd incremental save (the retry):                                  ${second.length} bytes -> ${count(second)}`);
  const full = doc.saveToBuffer('garbage=compact').asUint8Array().slice();
  console.log(`  a full save after that:                                           ${full.length} bytes -> ${count(full)}`);
  console.log(`  original file: ${bytes.length} bytes -> ${count(bytes)}`);
}
