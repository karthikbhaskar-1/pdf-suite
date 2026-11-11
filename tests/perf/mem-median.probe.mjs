// Memory gate (ticket 1.2.0, ruling): renderer (Tab) + GPU PRIVATE BYTES PEAK (owner-approved 2026-11-09; working set logged) under aggressive scrolling, as the
// MEDIAN of three runs on MuPDF, must stay under 720 MB. Non-gating companions, in the same session: the settled
// figure (10 s idle, target under 500 MB private) for MuPDF, and pdf.js peak and settled for parity.
// Run: node tests/perf/mem-median.probe.mjs   (about 15 minutes: three MuPDF runs and one pdf.js run)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, summary } from '../signoff2/lib.mjs';

const scenario = fileURLToPath(new URL('./mem-scenario.mjs', import.meta.url));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function run(engine) {
  const child = spawnSync(process.execPath, [scenario, engine], { encoding: 'utf8', timeout: 900000 });
  const line = String(child.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  const result = line ? JSON.parse(line) : { engine, error: String(child.stderr ?? 'no output').slice(0, 300) };
  console.log(JSON.stringify(result));
  return result;
}

const mupdf = [1, 2, 3].map(() => run('mupdf'));
const pdfjs = run('pdfjs');
const peaks = mupdf.map((r) => r.peak).filter((v) => typeof v === 'number');
const settled = mupdf.map((r) => r.settled).filter((v) => typeof v === 'number');
const medianPeak = peaks.length === 3 ? median(peaks) : null;
check('GATE MuPDF Tab+GPU private-bytes peak, median of 3 runs, < 720 MB', medianPeak !== null && medianPeak < 720, { peaks, medianPeak, peakWorkingSets: mupdf.map((r) => r.peakWorkingSet) });
console.log(`COMPANION MuPDF settled (10 s idle), median of 3, target < 600 MB (non-gating): ${settled.length ? median(settled) : 'n/a'} ${JSON.stringify(settled)}`);
console.log(`COMPANION pdf.js same session: peak ${pdfjs.peak ?? 'n/a'} MB, settled ${pdfjs.settled ?? 'n/a'} MB (non-gating parity)`);
process.exitCode = summary() ? 1 : 0;
