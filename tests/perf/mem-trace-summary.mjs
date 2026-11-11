// Prints the memory-infra numbers that matter for the thumbnail/GPU question, from a trace written by stress-edit with
// PDFSUITE_TRACE_MEM. Run: node tests/perf/mem-trace-summary.mjs <trace.json> [...]
import { readFileSync } from 'node:fs';
const MB = (b) => (b / 1048576).toFixed(1);
const WANT = [
  ['gpu', 'gpu/shared_images'], ['gpu', 'gpu/gl/textures'], ['gpu', 'skia/gpu_resources'], ['gpu', 'gpu/transfer_cache'],
  ['renderer', 'cc/tile_memory'],
];
for (const file of process.argv.slice(2)) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const events = Array.isArray(raw) ? raw : raw.traceEvents;
  const names = {};
  for (const ev of events) if (ev.ph === 'M' && ev.name === 'process_name') names[ev.pid] = ev.args?.name;
  // Use the last global dump for each process.
  const last = {};
  for (const ev of events) if (ev.ph === 'v' && ev.args?.dumps?.allocators) last[ev.pid] = ev.args.dumps.allocators;
  console.log(`== ${file}`);
  for (const [pid, allocs] of Object.entries(last)) {
    const pname = (names[pid] ?? '').toLowerCase();
    const kind = pname.includes('gpu') ? 'gpu' : pname.includes('renderer') ? 'renderer' : null;
    if (!kind) continue;
    for (const [k, prefix] of WANT) {
      if (k !== kind) continue;
      const rows = Object.entries(allocs).filter(([n]) => n === prefix || n.startsWith(prefix + '/'));
      const top = allocs[prefix];
      const size = (a) => (a?.attrs?.effective_size ?? a?.attrs?.size);
      const val = (a) => { const s = size(a); return s && s.units === 'bytes' ? parseInt(s.value, 16) : 0; };
      const leaves = rows.filter(([n]) => n !== prefix);
      const total = top ? val(top) : leaves.reduce((sum, [, a]) => sum + val(a), 0);
      console.log(`${kind} pid ${pid} ${prefix}: ${MB(total)} MB, ${rows.length} nodes`);
    }
  }
}
