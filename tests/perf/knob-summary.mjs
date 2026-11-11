// Turns the KNOB rows of queue job logs into markdown tables (for docs/milestone-1.5/measurements.md).
// Run: node tests/perf/knob-summary.mjs <log file>...   (job logs are in %LOCALAPPDATA%\pdfsuite-testq\jobs\<id>\logs\)
import { readFileSync } from 'node:fs';

const rows = process.argv.slice(2).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('KNOB ')).map((l) => JSON.parse(l.slice(5))));
const med = (v) => { const x = v.filter((n) => typeof n === 'number').sort((a, b) => a - b); if (!x.length) return 'n/a'; const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : Math.round(((x[m - 1] + x[m]) / 2) * 10) / 10; };
const group = (list, keyFn) => { const g = new Map(); for (const r of list) { const k = keyFn(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; };
const table = (head, body) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const ok = rows.filter((r) => !r.error);
const bad = rows.filter((r) => r.error);

const l4 = ok.filter((r) => r.sweep === 'L4');
if (l4.length) {
  console.log('L4 (window, zoom, budget): median of reps\n');
  console.log(table(['window', 'zoom %', 'budget MB', 'runs', 'peak private MB', 'settled private MB', 'page re-renders on scroll back', 'page re-renders total', 'thumb re-renders', 'scroll p95 ms', 'frames over 50 ms'],
    [...group(l4, (r) => `${r.window}|${r.zoom}|${r.budgetMB}`).values()].map((v) => [v[0].window, v[0].zoom, v[0].budgetMB, v.length, med(v.map((r) => r.peakPrivateMB)), med(v.map((r) => r.settledPrivateMB)), med(v.map((r) => r.pageReRendersBack)), med(v.map((r) => r.pageReRendersTotal)), med(v.map((r) => r.thumbReRenders)), med(v.map((r) => r.scrollDown.p95)), v.reduce((a, r) => a + r.scrollDown.over50 + r.scrollBack.over50, 0)])));
  console.log();
}
const l6 = rows.filter((r) => r.sweep === 'L6' || r.sweep === 'L6-median');
if (l6.length) {
  console.log('L6\n');
  for (const r of l6) console.log(JSON.stringify(r));
  console.log();
}
const p1 = ok.filter((r) => r.sweep === 'P1');
if (p1.length) {
  console.log('P1 (file, concurrency): median of reps, ms\n');
  console.log(table(['file', 'concurrency', 'runs', 'first page', 'jump to paint', 'drag to paint', 'split open to paint', 'split jump to paint'],
    [...group(p1, (r) => `${r.file}|${r.concurrency}`).values()].map((v) => [v[0].file, v[0].concurrency, v.length, med(v.map((r) => r.firstPageMs)), med(v.map((r) => r.jumpMedianMs)), med(v.map((r) => r.dragMedianMs)), med(v.map((r) => r.splitOpenToPaintedMs)), med(v.map((r) => r.splitJumpMedianMs))])));
  console.log();
}
const p2 = ok.filter((r) => r.sweep === 'P2');
if (p2.length) {
  console.log('P2 (config, speed in viewports/s): median of reps; over50 = frames over 50 ms summed\n');
  const body = [];
  for (const v of group(p2, (r) => r.config).values()) {
    for (const speed of ['v0.8', 'v1.8', 'v6']) {
      const s = v.map((r) => r.summary[speed]);
      body.push([v[0].config, speed.slice(1), v.length, s.reduce((a, x) => a + x.over50, 0), med(s.map((x) => x.p95)), med(s.map((x) => x.paintedMs)), med(s.map((x) => x.sharpMs)), med(s.map((x) => x.renders))]);
    }
  }
  console.log(table(['config', 'speed', 'runs', 'frames over 50 ms', 'p95 ms', 'painted ms after stop', 'sharp ms after stop', 'page renders'], body));
  console.log();
  console.log(table(['config', 'runs', 'drag to painted ms', 'drag to sharp ms'], [...group(p2, (r) => r.config).values()].map((v) => [v[0].config, v.length, med(v.map((r) => r.dragPaintedMs)), med(v.map((r) => r.dragSharpMs))])));
}
if (bad.length) console.log(`\n${bad.length} run(s) failed: ${bad.map((r) => `${r.sweep} ${JSON.stringify({ ...r, error: undefined })}`).join('; ')}`);
