// G1 helper: compares memory-infra traces written by mem-trace-soak.probe.mjs (trace-pass<N>.json in a folder) and names the
// allocators that grow. For each process kind (gpu, renderer, browser, other) it sums allocator sizes at two depths of the
// allocator path, then prints the ones that changed most between the first and the last trace.
//   node tests/perf/mem-trace-diff.mjs <outDir> [depth=3] [top=12]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const depth = Number(process.argv[3] ?? 3);
const top = Number(process.argv[4] ?? 12);
const MB = (b) => +(b / 1048576).toFixed(1);
const files = readdirSync(dir).filter((f) => /^trace-pass\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
const val = (a) => {
  const x = a?.attrs?.effective_size ?? a?.attrs?.size;
  return x && x.units === 'bytes' ? parseInt(x.value, 16) : 0;
};
function load(file) {
  const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const events = raw.traceEvents;
  const names = {};
  for (const ev of events) if (ev.ph === 'M' && ev.name === 'process_name') names[ev.pid] = ev.args?.name ?? '';
  const last = {};
  for (const ev of events) if (ev.ph === 'v' && ev.args?.dumps?.allocators) last[ev.pid] = ev.args.dumps.allocators;
  const out = {};
  for (const [pid, allocs] of Object.entries(last)) {
    const pname = (names[pid] ?? '').toLowerCase();
    const kind = pname.includes('gpu') ? 'gpu' : pname.includes('renderer') || pname.includes('tab') ? 'renderer' : pname.includes('browser') ? 'browser' : `other(${pname || pid})`;
    const sums = (out[kind] ??= {});
    // Only the top-most sized allocators of each subtree are summed at the chosen depth, so a parent and its children are not both counted.
    // A node is used when it sits at the chosen depth, or when it is shallower and has no children (a leaf).
    const all = Object.keys(allocs);
    const parents = new Set(all.map((p) => p.split('/').slice(0, -1).join('/')));
    for (const [path, a] of Object.entries(allocs)) {
      const parts = path.split('/');
      if (parts.length === depth || (parts.length < depth && !parents.has(path))) sums[path] = (sums[path] ?? 0) + val(a);
    }
    // Totals the browser reports itself
    for (const key of ['malloc', 'partition_alloc', 'v8', 'blink_gc', 'gpu', 'skia', 'cc', 'shared_memory', 'discardable']) {
      if (allocs[key]) sums[`~${key}`] = (sums[`~${key}`] ?? 0) + val(allocs[key]);
    }
  }
  return out;
}
const traces = files.map((f) => ({ f, data: load(f) }));
if (traces.length === 0) throw new Error(`no trace-pass*.json in ${dir}`);
const first = traces[0];
const lastT = traces.at(-1);
console.log(`traces: ${files.join(', ')}  (depth ${depth})`);
const kinds = [...new Set(traces.flatMap((t) => Object.keys(t.data)))];
for (const kind of kinds) {
  const paths = new Set(traces.flatMap((t) => Object.keys(t.data[kind] ?? {})));
  const rows = [...paths].map((p) => ({ p, v: traces.map((t) => t.data[kind]?.[p] ?? 0) }));
  rows.forEach((r) => (r.d = r.v.at(-1) - r.v[0]));
  rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`\n== ${kind}: biggest changes ${first.f} -> ${lastT.f} (MB at each trace)`);
  for (const r of rows.slice(0, top)) console.log(`${r.d >= 0 ? '+' : ''}${MB(r.d)} MB  ${r.p}  [${r.v.map(MB).join(' / ')}]`);
}
