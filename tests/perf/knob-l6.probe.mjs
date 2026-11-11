// L6 (1.5.3, design-register A16): Tab+GPU private-bytes memory at screen scale 1.5 and 2 against the machine's own scale.
// The scale is the test-only knob screenScale (Chromium --force-device-scale-factor, test mode only). Every result carries
// the scale the page really saw (window.devicePixelRatio). Same scenario as the 720 MB gate (mem-scenario.mjs), median of 3.
// One exclusive job; about 30 minutes.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenario = fileURLToPath(new URL('./mem-scenario.mjs', import.meta.url));
const median = (v) => { const x = v.filter((n) => typeof n === 'number').sort((a, b) => a - b); const m = Math.floor(x.length / 2); return x.length ? (x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2) : null; };
function run(scale) {
  const env = { ...process.env };
  if (scale) env.PDFSUITE_TEST_KNOBS = JSON.stringify({ screenScale: scale }); else delete env.PDFSUITE_TEST_KNOBS;
  const child = spawnSync(process.execPath, [scenario, 'mupdf'], { encoding: 'utf8', timeout: 900000, env });
  const line = String(child.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  const result = line ? JSON.parse(line) : { error: String(child.stderr ?? 'no output').slice(0, 300) };
  const row = { sweep: 'L6', requestedScale: scale ?? 'none (machine scale)', ...result };
  console.log(`KNOB ${JSON.stringify(row)}`);
  return row;
}
const rows = [];
rows.push(run(null));
for (const scale of [1.5, 2]) for (let i = 0; i < 3; i++) rows.push(run(scale));
for (const key of ['none (machine scale)', 1.5, 2]) {
  const r = rows.filter((x) => x.requestedScale === key);
  console.log(`KNOB ${JSON.stringify({ sweep: 'L6-median', requestedScale: key, dpr: r.map((x) => x.dpr), medianPeakPrivateMB: median(r.map((x) => x.peak)), medianSettledPrivateMB: median(r.map((x) => x.settled)), peaks: r.map((x) => x.peak) })}`);
}
