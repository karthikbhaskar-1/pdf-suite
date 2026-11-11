// Downloads the test PDFs that cannot be redistributed with the source into the git-ignored corpus folders.
// Usage: node scripts/download-test-corpus.mjs [--force]
// Files that already exist are skipped. A failed download is reported and does not stop the others.
// After the downloads, run `node tests/engine/make-engine-fixtures.mjs` to build the derived engine fixtures.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each entry: where the file goes (relative to the repo root) and its public source. url null = source not recorded. */
export const CORPUS = [
  { path: 'tests/engine/corpus/arxiv-attention/1706.03762.pdf', url: 'https://arxiv.org/pdf/1706.03762' },
  { path: 'tests/trial/corpus/arxiv/arxiv.pdf', url: 'https://arxiv.org/pdf/1706.03762' },
  { path: 'tests/engine/corpus/irs-fw9/fw9.pdf', url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' },
  { path: 'tests/trial/corpus/irs-fw9/fw9.pdf', url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' },
  {
    path: 'tests/trial/corpus/tracemonkey/tracemonkey.pdf',
    url: 'https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/tracemonkey.pdf',
  },
  // IRCC form IMM 1344 E (XFA form). The tests use a filled copy named xfa_filled_imm1344e.pdf; this downloads the blank
  // public form. Fill it in standard software, or substitute any XFA PDF, if the filled-form tests fail.
  {
    path: 'tests/engine/corpus/xfa/xfa_filled_imm1344e.pdf',
    url: 'https://www.canada.ca/content/dam/ircc/migration/ircc/english/pdf/kits/forms/imm1344e.pdf',
  },
  // Not recorded in the docs: where these came from. Put a suitable file at the path, or add its URL here.
  // brochure.pdf: an image-heavy brochure of about 73 MB (used by memory and CropBox tests).
  { path: 'tests/engine/corpus/brochure-images/brochure.pdf', url: null },
  { path: 'tests/engine/corpus/images-misc/images.pdf', url: null },
  { path: 'tests/engine/corpus/scanned-gray/perf_images_scan_gray.pdf', url: null },
  { path: 'tests/engine/corpus/outlines/nested_outline.pdf', url: null },
];

async function main() {
  const force = process.argv.includes('--force');
  const summary = { downloaded: 0, skipped: 0, failed: 0, manual: 0 };

  for (const item of CORPUS) {
    const dest = join(root, item.path);
    if (existsSync(dest) && !force) {
      console.log(`skip     ${item.path} (exists)`);
      summary.skipped++;
      continue;
    }
    if (!item.url) {
      console.log(`MANUAL   ${item.path} (no public source recorded; add the file yourself)`);
      summary.manual++;
      continue;
    }
    try {
      const res = await fetch(item.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      console.log(`ok       ${item.path} (${bytes.length} bytes)`);
      summary.downloaded++;
    } catch (err) {
      console.log(`FAILED   ${item.path} from ${item.url}: ${err.message}`);
      summary.failed++;
    }
  }
  console.log(JSON.stringify(summary));
  process.exitCode = summary.failed ? 1 : 0;
}

// Run only when executed directly, so importing CORPUS does not start downloads.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
