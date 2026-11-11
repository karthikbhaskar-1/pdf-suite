// Perf probe: the mem-user scenario (wheel flings + scrollbar drags on big-1000.pdf) with a per-process breakdown.
// At every checkpoint it records: app.getAppMetrics per process (working set and private bytes), the renderer's own
// report (window.__pdfSuiteEngine.memory), mounted canvases, and a Chromium memory-infra dump (CDP Tracing.requestMemoryDump)
// parsed per process into its top allocators.
//
// Run: node tests/perf/mem-breakdown.probe.mjs [mupdf|pdfjs] [experimentFlagsJSON]
// Env:  PERF_ROUNDS=3  PERF_ARGS="--js-flags=--expose-gc"  PERF_DUMP=1 (memory-infra dumps on)  PERF_OUT=path.json
import { launchTracked, waitForPage, closeAll, cleanupProfile, fixture, engineState } from '../signoff2/lib.mjs';
import { writeFileSync } from 'node:fs';

const engine = process.argv[2] ?? 'mupdf';
const expFlags = process.argv[3] ?? '';
const rounds = Number(process.env.PERF_ROUNDS ?? 3);
const extraArgs = (process.env.PERF_ARGS ?? '').split(' ').filter(Boolean);
const wantDump = process.env.PERF_DUMP === '1';
const file = fixture('big-1000.pdf');
const MB = (b) => Math.round(b / 1048576);

const s = await launchTracked({ args: extraArgs });
let cdp = null;
try {
  cdp = await s.app.context().newCDPSession(s.win);
} catch (e) {
  console.log('no CDP session:', String(e).slice(0, 120));
}

/** Parses memory-infra 'v' events into { pid: { totals, allocators: {name: bytes} } }. */
function parseDumps(events) {
  const out = {};
  for (const ev of events) {
    if (ev.ph !== 'v' || !ev.args?.dumps) continue;
    const d = ev.args.dumps;
    const p = (out[ev.pid] ??= { totals: {}, allocators: {} });
    if (d.process_totals) {
      for (const [k, v] of Object.entries(d.process_totals)) if (typeof v === 'string') p.totals[k] = parseInt(v, 16);
    }
    for (const [name, node] of Object.entries(d.allocators ?? {})) {
      const attrs = node.attrs ?? {};
      const size = attrs.effective_size ?? attrs.size;
      if (!size || size.units !== 'bytes') continue;
      p.allocators[name] = parseInt(size.value, 16);
    }
  }
  return out;
}

/** Sums effective sizes of leaf-ish nodes up to a depth, so numbers are not double counted. */
function rollup(allocators, depth) {
  const sums = {};
  // Only count nodes that have no children in the dump (effective_size of a leaf), rolled up to `depth`.
  const names = Object.keys(allocators);
  const hasChild = new Set();
  for (const n of names) {
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) hasChild.add(parts.slice(0, i).join('/'));
  }
  for (const n of names) {
    if (hasChild.has(n)) continue;
    const key = n.split('/').slice(0, depth).join('/');
    sums[key] = (sums[key] ?? 0) + allocators[n];
  }
  return sums;
}

async function memoryDump() {
  if (!cdp || !wantDump) return null;
  const events = [];
  const onData = (e) => events.push(...e.value);
  cdp.on('Tracing.dataCollected', onData);
  try {
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } },
    });
    const res = await cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed', deterministic: false });
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    if (!res.success) console.log('memory dump reported failure');
  } catch (e) {
    console.log('memory dump failed:', String(e).slice(0, 160));
    return null;
  } finally {
    cdp.off('Tracing.dataCollected', onData);
  }
  return parseDumps(events);
}

const pageReport = () =>
  s.win.evaluate(async () => {
    const eng = (await window.__pdfSuiteEngine?.memory?.()) ?? null;
    let canvases = 0, canvasBytes = 0, sizes = {};
    for (const c of document.querySelectorAll('canvas')) {
      canvases++;
      canvasBytes += c.width * c.height * 4;
      const k = `${c.width}x${c.height}`;
      sizes[k] = (sizes[k] ?? 0) + 1;
    }
    const perf = performance.memory;
    return { eng, canvases, canvasMB: Math.round(canvasBytes / 1048576), sizes, dpr: window.devicePixelRatio, jsHeapMB: perf ? Math.round(perf.usedJSHeapSize / 1048576) : null, jsHeapTotalMB: perf ? Math.round(perf.totalJSHeapSize / 1048576) : null };
  });

async function row(label) {
  const metrics = await s.metrics();
  const by = {};
  for (const m of metrics) {
    const t = by[m.type] ??= { ws: 0, priv: 0, pids: [] };
    t.ws += m.memKB / 1024;
    t.priv += (m.privateKB ?? 0) / 1024;
    t.pids.push(m.pid);
  }
  const procs = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { wsMB: Math.round(v.ws), privMB: Math.round(v.priv), pids: v.pids }]));
  const page = await pageReport();
  const dump = await memoryDump();
  const r = { label, tabPlusGpu: Math.round((by.Tab?.ws ?? 0) + (by.GPU?.ws ?? 0)), procs, page };
  if (dump) {
    r.dump = {};
    for (const [pid, d] of Object.entries(dump)) {
      const type = metrics.find((m) => m.pid === Number(pid))?.type ?? '?';
      const top = Object.entries(rollup(d.allocators, 2)).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${MB(v)}`);
      const deep = {};
      for (const [k, v] of Object.entries(rollup(d.allocators, 4))) if (v > 8 * 1048576) deep[k] = MB(v);
      r.dump[`${type}:${pid}`] = { totals: Object.fromEntries(Object.entries(d.totals).map(([k, v]) => [k, MB(v)])), top, deep };
    }
  }
  return r;
}

const rows = [];
try {
  await s.win.waitForSelector('.empty-state');
  if (engine === 'pdfjs' || expFlags) {
    await s.win.evaluate(({ engine, expFlags }) => {
      if (engine === 'pdfjs') localStorage.setItem('pdfsuite.engine', 'pdfjs');
      if (expFlags) localStorage.setItem('pdfsuite.exp', expFlags);
    }, { engine, expFlags });
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
  }
  rows.push(await row('idle'));
  await s.setDialogAnswer([file]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  await s.win.waitForTimeout(1000);
  rows.push(await row('open'));
  const g = await s.win.locator('.viewer').first().evaluate((v) => { const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, sw: v.offsetWidth - v.clientWidth }; });
  for (let round = 1; round <= rounds; round++) {
    await s.win.mouse.move(g.x + g.w / 2, g.y + g.h / 2);
    for (let i = 0; i < 80; i++) { await s.win.mouse.wheel(0, 700); await s.win.waitForTimeout(20); }
    for (let i = 0; i < 50; i++) { await s.win.mouse.wheel(0, -700); await s.win.waitForTimeout(20); }
    rows.push(await row(`round ${round} after wheel`));
    const tx = g.x + g.w - g.sw / 2;
    for (const f of [0.2, 0.6, 0.95, 0.4]) {
      const top = await s.win.locator('.viewer').first().evaluate((v) => v.scrollTop / (v.scrollHeight - v.clientHeight));
      await s.win.mouse.move(tx, g.y + 20 + top * (g.h - 40));
      await s.win.mouse.down();
      await s.win.mouse.move(tx, g.y + 20 + f * (g.h - 40), { steps: 25 });
      await s.win.mouse.up();
      await s.win.waitForTimeout(1500);
    }
    await s.win.waitForTimeout(2000);
    rows.push(await row(`round ${round}`));
  }
  // Steady state: 8 s of nothing.
  await s.win.waitForTimeout(8000);
  rows.push(await row('settled +8s'));
  const eng = await engineState(s.win);
  const peak = Math.max(...rows.map((r) => r.tabPlusGpu));
  console.log(`\n=== ${engine} ${expFlags} args=${extraArgs.join(' ')} rounds=${rounds} ===`);
  for (const r of rows) {
    const p = r.procs;
    console.log(`${r.label.padEnd(22)} Tab+GPU=${String(r.tabPlusGpu).padStart(4)}  Tab ws/priv=${p.Tab?.wsMB}/${p.Tab?.privMB}  GPU ws/priv=${p.GPU?.wsMB}/${p.GPU?.privMB}  Browser=${p.Browser?.wsMB}  Utility=${p.Utility?.wsMB}  canvases=${r.page.canvases}(${r.page.canvasMB}MB) jsHeap=${r.page.jsHeapMB}/${r.page.jsHeapTotalMB} bitmaps=${r.page.eng ? MB(r.page.eng.bitmaps.budgetBytes) : '-'}MB wasm=${r.page.eng?.wasmHeapBytes?.map(MB)}`);
  }
  console.log('PEAK Tab+GPU', peak, 'engineState', JSON.stringify(eng), 'dpr', rows[0].page.dpr, 'canvas sizes', JSON.stringify(rows.at(-2).page.sizes));
  if (wantDump) {
    for (const r of rows) {
      if (!r.dump) continue;
      console.log(`--- dump @ ${r.label}`);
      for (const [proc, d] of Object.entries(r.dump)) {
        console.log(`  ${proc} totals=${JSON.stringify(d.totals)}`);
        console.log(`    top: ${d.top.join('  ')}`);
        const deep = Object.entries(d.deep).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');
        if (deep) console.log(`    >8MB: ${deep}`);
      }
    }
  }
  if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify({ engine, expFlags, extraArgs, rows, eng }, null, 1));
  if (s.errors.length) console.log('errors:', s.errors.slice(0, 5));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
}
