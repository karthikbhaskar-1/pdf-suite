// L3a (1.5.3): time of one edit-log write with 1, 100 and 1,000 steps. No app. Uses the real EditLog (snapshot of the file it
// would write: JSON.stringify of the log) and the real saveAtomic of the main process (temp file, fsync, rename), on the
// same drive as the recovery folder (%TEMP% is on C:, like %APPDATA%). Two step shapes:
//   small: the steps a person makes (rotate 1 page, delete 3, move 5): a few uids each
//   large: every step names 1,000 uids (select all, rotate/move): the heaviest a step can be
// IPC between the page and the main process is NOT in this number (it needs the app; see L1/L7 run for it).
// Run: node --experimental-transform-types tests/perf/log-write.probe.mjs [out.json]
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EditLog } from '../../src/features/recovery/editLog.ts';
import { saveAtomic } from '../../electron/lib/atomicWrite.ts';

const REPEAT = 200;
const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-l3a-'));
const uids = (n, from = 0) => Array.from({ length: n }, (_, i) => String(from + i));
const small = (i) => [[{ op: 'rotate', uids: [String(i % 1000)], degrees: 90 }], [{ op: 'delete', uids: uids(3, i % 900) }], [{ op: 'move', uids: uids(5, i % 900), beforeUid: String((i * 7) % 1000) }]][i % 3];
const large = (i) => [{ op: i % 2 ? 'rotate' : 'move', uids: uids(1000), ...(i % 2 ? { degrees: 90 } : { beforeUid: null }) }];

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = (xs) => ({ p50: +pct(xs, 0.5).toFixed(2), p95: +pct(xs, 0.95).toFixed(2), max: +Math.max(...xs).toFixed(2), min: +Math.min(...xs).toFixed(2) });

const results = [];
for (const [shape, make] of [['small', small], ['large', large]]) {
  for (const steps of [1, 100, 1000]) {
    const target = join(dir, 'log.json');
    // stringify only: flush() with a port that discards the text. Full write: flush() with the real saveAtomic.
    const mk = (write) => { const l = new EditLog('k', 'C:/x.pdf', { size: 1, modified: 1 }, { write, writeStash: async () => {}, clear: async () => {} }); for (let i = 0; i < steps; i++) l.record(make(i), i * 10); clearTimeout(l.timer); return l; };
    let bytes = 0;
    const logS = mk(async (_k, text) => { bytes = text.length; });
    const logW = mk(async (_k, text) => saveAtomic(target, new TextEncoder().encode(text)));
    const stringify = [], total = [];
    const reps = shape === 'large' && steps === 1000 ? 60 : REPEAT;
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now(); await logS.flush(); stringify.push(performance.now() - t0);
      const t1 = performance.now(); await logW.flush(); total.push(performance.now() - t1);
    }
    const atomic = total.map((t, i) => Math.max(0, t - stringify[i]));
    const text = { length: bytes };
    results.push({ shape, steps, logKB: +(text.length / 1024).toFixed(1), flushStringifyMs: stat(stringify), saveAtomicMsApprox: stat(atomic), fullFlushMs: stat(total), reps });
    console.log(JSON.stringify(results.at(-1)));
  }
}
rmSync(dir, { recursive: true, force: true });
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify({ repeat: REPEAT, results }, null, 2));
