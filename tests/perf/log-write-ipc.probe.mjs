// L3a addendum (1.5.3): the same log-write sizes as log-write.probe.mjs, timed from the page through the real app (window.pdfSuite.recovery.write:
// the string copy over IPC, the main process, saveAtomic). Take the machine lock first. Writes only to the throw-away test profile.
//   node tests/perf/log-write-ipc.probe.mjs [out.json]
import { writeFileSync } from 'node:fs';
import { launch, closeAll, cleanupProfile } from '../e2e/helpers.mjs';

const s = await launch();
const rows = [];
try {
  await s.win.waitForSelector('.empty-state');
  const res = await s.win.evaluate(async () => {
    const uids = (n) => Array.from({ length: n }, (_, i) => String(i));
    const mk = (steps, large) => {
      const arr = [];
      for (let i = 0; i < steps; i++) arr.push(large ? [{ op: i % 2 ? 'rotate' : 'move', uids: uids(1000) }] : [{ op: 'rotate', uids: [String(i % 1000)], degrees: 90 }]);
      return JSON.stringify({ version: 2, path: 'C:/x.pdf', base: { size: 1, modified: 1 }, stashes: [], steps: arr, seeds: arr.map((_, i) => i * 10) });
    };
    const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    const out = [];
    for (const [shape, large] of [['small', false], ['large', true]]) {
      for (const steps of [1, 100, 1000]) {
        const text = mk(steps, large);
        const reps = large && steps === 1000 ? 30 : 100;
        const t = [];
        for (let r = 0; r < reps; r++) {
          const t0 = performance.now();
          await window.pdfSuite.recovery.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', text);
          t.push(performance.now() - t0);
        }
        out.push({ shape, steps, logKB: +(text.length / 1024).toFixed(1), reps, p50: +pct(t, 0.5).toFixed(1), p95: +pct(t, 0.95).toFixed(1), max: +Math.max(...t).toFixed(1) });
      }
    }
    await window.pdfSuite.recovery.clear('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    return out;
  });
  rows.push(...res);
  for (const r of rows) console.log(JSON.stringify(r));
} finally {
  await s.close().catch(() => undefined);
  cleanupProfile(s.profile);
  await closeAll();
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(rows, null, 2));
}
