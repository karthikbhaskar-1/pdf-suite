// L7 and G2 (1.5.3 / 1.5.4): private bytes per extra tab, and GPU contexts and memory per open document.
//   node tests/perf/tabs-memory.probe.mjs <kind> <count> [out.json]      (take the machine lock first)
//   kind arxiv   : <count> copies of the 15-page arXiv paper (tests/engine/corpus/arxiv-attention), each a different path
//   kind big     : <count> copies of tests/fixtures/out/big-1000.pdf (1,000 pages each)
//   kind brochure: <count> copies of the image-heavy brochure corpus file
//   kind xfa     : one XFA form (pdf.js path); count ignored
// After each open (new tab, which becomes the active one) the probe waits 3 s and records private MB per process type (all processes),
// live MuPDF workers, WASM heaps, and, at counts 1, 2, 5, 10 and 20, one memory-infra trace to count the GPU process's shared-image clients
// (one per worker that makes bitmaps on its own canvas, G2) and its malloc total. Then it activates tab 1 again and records once more.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchTracked, check, ROOT2, CORPUS, engineState } from '../signoff2/lib.mjs';
import { closeAll, cleanupProfile, placeWindow, statusText, waitFor, rendererMemoryMB } from '../e2e/helpers.mjs';
import { copyOf, removeCopy, delay } from '../e2e/matrix-lib.mjs';

const kind = process.argv[2] ?? 'arxiv';
const count = Number(process.argv[3] ?? 5);
const outJson = process.argv[4];
const SOURCES = {
  arxiv: [join(CORPUS, 'arxiv-attention', '1706.03762.pdf'), 15],
  brochure: [join(CORPUS, 'brochure-images', 'brochure.pdf'), null],
  big: [join(ROOT2, 'tests', 'fixtures', 'out', 'big-1000.pdf'), 1000],
  xfa: [join(CORPUS, 'xfa', 'xfa_filled_imm1344e.pdf'), null],
};
const [src] = SOURCES[kind];
const n = count;
const TRACE_AT = new Set([1, 2, 5, 10, 20]);
const copies = Array.from({ length: n }, () => copyOf(src));
const s = await launchTracked();
const rows = [];

async function traceGpu() {
  const cdp = await s.app.context().newCDPSession(s.win);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  try {
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } } });
    await cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed', deterministic: false });
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  const names = {};
  for (const ev of events) if (ev.ph === 'M' && ev.name === 'process_name') names[ev.pid] = ev.args?.name ?? '';
  const last = {};
  for (const ev of events) if (ev.ph === 'v' && ev.args?.dumps?.allocators) last[ev.pid] = ev.args.dumps.allocators;
  const val = (a) => { const x = a?.attrs?.effective_size ?? a?.attrs?.size; return x && x.units === 'bytes' ? parseInt(x.value, 16) : 0; };
  for (const [pid, allocs] of Object.entries(last)) {
    if (!(names[pid] ?? '').toLowerCase().includes('gpu')) continue;
    const clients = new Set();
    for (const k of Object.keys(allocs)) { const m = /^gpu\/shared_images\/(client_0x[0-9a-f]+)/i.exec(k); if (m) clients.add(m[1]); }
    const gl = new Set();
    for (const k of Object.keys(allocs)) { const m = /^gpu\/gl\/context_group_(0x[0-9a-f]+)|^gpu\/(command_buffer_memory\/client_0x[0-9a-f]+)/i.exec(k); if (m) gl.add(m[1] ?? m[2]); }
    const top = (name) => val(allocs[name]);
    return {
      sharedImageClients: clients.size,
      commandBufferOrGlGroups: gl.size,
      sharedImagesMB: +(top('gpu/shared_images') / 1048576).toFixed(1),
      gpuMallocMB: +(top('malloc') / 1048576).toFixed(1),
      gpuTopLevel: Object.keys(allocs).filter((k) => !k.includes('/')).slice(0, 20),
    };
  }
  return null;
}

async function record(label, docs) {
  await delay(3000);
  const m = await rendererMemoryMB(s);
  const all = (await s.metrics()).reduce((t, r) => t + (r.privateKB ?? 0) / 1024, 0);
  const eng = await engineState(s.win);
  const row = { label, docs, totalPrivateMB: Math.round(all), tabGpuPrivateMB: Math.round(m.privateMB), byTypeMB: m.byType, mupdfWorkersLive: eng.mupdfWorkersLive, wasmMB: eng.wasmMB, pdfjsWorkersEver: eng.pdfjsWorkersEver };
  if (TRACE_AT.has(docs) && label.startsWith('open')) row.gpuTrace = await traceGpu();
  rows.push(row);
  console.log(JSON.stringify(row));
}

try {
  await s.win.waitForSelector('.empty-state');
  await placeWindow(s, { width: 1400, height: 900 });
  await record('baseline (no document)', 0);
  for (let i = 1; i <= n; i++) {
    await s.setDialogAnswer([copies[i - 1].path]);
    await s.win.keyboard.press('Control+o');
    const t0 = Date.now();
    await waitFor(async () => /^Page 1 of \d+/.test(await statusText(s.win)) && (await s.win.locator('.tab').count()) >= i, { timeoutMs: 120000, label: `tab ${i}` });
    await s.win.locator('.page-canvas').first().waitFor({ state: 'attached', timeout: 60000 }); await delay(1500);
    if (kind === 'xfa') {
      // scroll a little so pages render
      await s.win.mouse.move(700, 450);
      for (let k = 0; k < 6; k++) { await s.win.mouse.wheel(0, 600); await delay(150); }
    }
    await record(`open ${i}`, i);
    rows.at(-1).openMs = Date.now() - t0;
  }
  if (n > 1) {
    await s.win.locator('.tab').first().click();
    await record('after activating tab 1', n);
  }
  const errs = s.errors.filter((e) => !/favicon/.test(e));
  rows.push({ errors: errs.slice(0, 5) });
} catch (error) {
  rows.push({ failed: String(error?.stack ?? error).slice(0, 500) });
  console.log(rows.at(-1).failed);
} finally {
  await s.close().catch(() => undefined);
  cleanupProfile(s.profile);
  copies.forEach(removeCopy);
  await closeAll();
  if (outJson) {
    mkdirSync(join(outJson, '..'), { recursive: true });
    writeFileSync(outJson, JSON.stringify({ kind, count: n, rows }, null, 2));
  }
}
