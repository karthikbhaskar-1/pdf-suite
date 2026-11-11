// Sign-Off 1.3.1, probe E4: how many real files have the page-tree shape that makes a copied page GAIN /Rotate or /CropBox?
// A copy of page i is inserted under the parent of page i+1. It gains key K when page i has no K (own or inherited) and the
// parent of page i+1 has one (own or inherited).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import * as mu from 'mupdf';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.pdf$/i.test(name) && st.size < 80 * 1024 * 1024) out.push(p);
  }
  return out;
}
it('corpus scan', () => {
  const files = [...walk('tests/engine/corpus'), ...walk('tests/fixtures/out')];
  let scanned = 0;
  let withNodeAttrs = 0;
  const hits: string[] = [];
  for (const file of files) {
    let doc: mu.Document;
    try {
      doc = mu.Document.openDocument(new Uint8Array(readFileSync(file)), 'application/pdf');
      if (doc.needsPassword()) continue;
    } catch {
      continue;
    }
    const pdf = doc.asPDF();
    if (!pdf) continue;
    scanned += 1;
    const n = Math.min(pdf.countPages(), 3000);
    let risky = 0;
    let nodeAttr = false;
    let prev: mu.PDFObject | null = null;
    for (let i = 0; i < n; i++) {
      const page = pdf.findPage(i);
      const parent = page.get('Parent');
      for (const key of ['Rotate', 'CropBox']) {
        let own = false;
        page.forEach((_v: unknown, k: unknown) => {
          if (String(k) === key) own = true;
        });
        if (!own && !page.getInheritable(key).isNull()) nodeAttr = true;
        if (prev && prev.get('Parent').asIndirect() !== parent.asIndirect()) {
          const before = prev.getInheritable(key);
          const gained = parent.getInheritable(key);
          if (before.isNull() && !gained.isNull()) {
            // /Rotate 0 gained is harmless; a CropBox equal to the page's MediaBox is harmless too, but is counted.
            if (!(key === 'Rotate' && gained.asNumber() % 360 === 0)) risky += 1;
          }
        }
      }
      prev = page;
    }
    if (nodeAttr) withNodeAttrs += 1;
    if (risky > 0) hits.push(`${file} (${risky} page boundaries of ${n} pages)`);
    doc.destroy();
  }
  console.log(`E4 corpus: ${scanned} PDFs scanned; ${withNodeAttrs} inherit /Rotate or /CropBox from a /Pages node somewhere; ${hits.length} have a boundary where a copy would gain one:`);
  for (const h of hits.slice(0, 20)) console.log('  ' + h);
});
