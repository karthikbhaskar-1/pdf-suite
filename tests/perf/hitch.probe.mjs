// DIAGNOSTICS ONLY (ticket 1.2.1 root-cause probe): repeats the first test of tests/e2e/bigfile.e2e.mjs step for step
// (open big-1000.pdf, jump to page 1000, fast scroll down and back) and records what the long frame is.
//  - in the page: requestAnimationFrame gaps (as the test), PerformanceObserver 'longtask' and 'long-animation-frame'
//    with script attribution, the app's own diag ring buffer, timer drift of the scroll loop
//  - HITCH_TRACE=1: a Chromium trace over the whole run (CDP Tracing), written only for runs that show a long frame
//    (or always with HITCH_TRACE=all)
//  - HITCH_PROFILE=1: a JS CPU profile of the renderer main thread over the scroll
//  - after the scroll: per-process working set and private bytes at once (as the test reads them) and again later,
//    with window.__pdfSuiteEngine.memory() and .diag()
// Run: node tests/perf/hitch.probe.mjs            Env: HITCH_RUNS=6 HITCH_OUT=dir HITCH_SETTLE_MS=0 HITCH_ARGS="..."
import { launch, fixture, statusText, waitFor, waitForPage, closeAll, cleanupProfile } from '../e2e/helpers.mjs';
import { measureValid, startSampler, tally } from '../lib/frame-validity.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNS = Number(process.env.HITCH_RUNS ?? 6);
const OUT = process.env.HITCH_OUT ?? join(process.env.TEMP ?? '.', 'pdfsuite-hitch');
const TRACE = process.env.HITCH_TRACE ?? '';
const PROFILE = process.env.HITCH_PROFILE === '1';
const SETTLE_MS = Number(process.env.HITCH_SETTLE_MS ?? 0);
const EXTRA_ARGS = (process.env.HITCH_ARGS ?? '').split(' ').filter(Boolean);
// HITCH_GATE=1: an in-page shim (probe only) that lets at most one 'render' request reach a worker per animation frame,
// and drops a queued one when its cancel arrives. It imitates a pacing fix at the worker boundary, to test the idea.
const GATE = process.env.HITCH_GATE === '1';
const GATE_SHIM = () => {
  const send = Worker.prototype.postMessage;
  const queue = [];
  let frame = 0;
  const stats = (window.__hitchGate = { sent: 0, dropped: 0, maxQueue: 0 });
  const pump = () => {
    frame = 0;
    const next = queue.shift();
    if (next) { stats.sent += 1; send.call(next.worker, next.message, next.transfer ?? []); }
    if (queue.length > 0) frame = requestAnimationFrame(pump);
  };
  Worker.prototype.postMessage = function (message, transfer) {
    if (message && message.op === 'render') {
      queue.push({ worker: this, message, transfer });
      stats.maxQueue = Math.max(stats.maxQueue, queue.length);
      if (!frame) frame = requestAnimationFrame(pump);
      return;
    }
    if (message && message.op === 'cancel') {
      const at = queue.findIndex((entry) => entry.message.id === message.target);
      if (at >= 0) { queue.splice(at, 1); stats.dropped += 1; return; }
    }
    return send.call(this, message, transfer ?? []);
  };
};
const MEM_ONLY_LATER = process.env.HITCH_MEM_LATER !== '0';
mkdirSync(OUT, { recursive: true });

const FULL_CATEGORIES = [
  'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'v8', 'v8.execute', 'disabled-by-default-v8.gc', 'blink.user_timing', 'toplevel', 'benchmark', 'cc', 'gpu', 'viz',
  'mojom', 'loading', 'latencyInfo', 'disabled-by-default-v8.cpu_profiler', 'blink_gc',
];
// 'light' leaves out the renderer-heavy categories (timeline, CPU profiler), so the run is disturbed less.
const LIGHT_CATEGORIES = (process.env.HITCH_CATS ?? 'toplevel,gpu,viz,cc,benchmark,latencyInfo,mojom,blink.user_timing,v8,disabled-by-default-v8.gc').split(',');
const TRACE_CATEGORIES = TRACE === 'full' ? FULL_CATEGORIES : LIGHT_CATEGORIES;
const KEEP_ALL = process.env.HITCH_TRACE_KEEP === 'all';
const DUMP = process.env.HITCH_DUMP === '1';
const MBb = (b) => Math.round(b / 1048576);

/** Parses memory-infra 'v' events into { pid: { totals, allocators: {name: bytes} } } (as tests/perf/mem-breakdown.probe.mjs). */
function parseDumps(events) {
  const out = {};
  for (const ev of events) {
    if (ev.ph !== 'v' || !ev.args?.dumps) continue;
    const d = ev.args.dumps;
    const p = (out[ev.pid] ??= { totals: {}, allocators: {} });
    if (d.process_totals) for (const [k, v] of Object.entries(d.process_totals)) if (typeof v === 'string') p.totals[k] = parseInt(v, 16);
    for (const [name, node] of Object.entries(d.allocators ?? {})) {
      const attrs = node.attrs ?? {};
      const size = attrs.effective_size ?? attrs.size;
      if (!size || size.units !== 'bytes') continue;
      p.allocators[name] = parseInt(size.value, 16);
    }
  }
  return out;
}
function rollup(allocators, depth) {
  const sums = {};
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
/** A memory-infra dump taken in its own short trace session, after the timed part of the run. */
async function memoryDump(cdp, metrics) {
  const events = [];
  const onData = (e) => events.push(...e.value);
  cdp.on('Tracing.dataCollected', onData);
  try {
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } } });
    const res = await cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed', deterministic: false });
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    if (!res.success) return { error: 'dump reported failure' };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  } finally {
    cdp.off('Tracing.dataCollected', onData);
  }
  const out = {};
  for (const [pid, d] of Object.entries(parseDumps(events))) {
    const type = metrics.find((m) => m.pid === Number(pid))?.type ?? '?';
    const top = Object.entries(rollup(d.allocators, 2)).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => `${k}=${MBb(v)}`);
    const deep = {};
    for (const [k, v] of Object.entries(rollup(d.allocators, 4))) if (v > 8 * 1048576) deep[k] = MBb(v);
    out[`${type}:${pid}`] = { totals: Object.fromEntries(Object.entries(d.totals).map(([k, v]) => [k, MBb(v)])), top, deep };
  }
  return out;
}

const mb = (kb) => Math.round(kb / 1024);
async function memRows(s) {
  const rows = await s.metrics();
  const out = { wsTabGpu: 0, privTabGpu: 0, procs: [] };
  for (const r of rows) {
    out.procs.push(`${r.type}:${r.pid} ws ${mb(r.memKB)} priv ${mb(r.privateKB ?? 0)}`);
    if (r.type === 'Tab' || r.type === 'GPU') {
      out.wsTabGpu += r.memKB / 1024;
      out.privTabGpu += (r.privateKB ?? 0) / 1024;
    }
  }
  out.wsTabGpu = Math.round(out.wsTabGpu);
  out.privTabGpu = Math.round(out.privTabGpu);
  return out;
}

const engineMem = (win) =>
  win.evaluate(async () => {
    const e = window.__pdfSuiteEngine;
    const memory = await e?.memory?.().catch((x) => String(x));
    const d = await e?.diag?.().catch((x) => String(x));
    return {
      memory,
      liveWorkers: d?.liveWorkers,
      openDocuments: d?.openDocuments,
      renderQueue: d?.renderQueue,
      canvases: [...document.querySelectorAll('canvas')].map((c) => `${c.className}:${c.width}x${c.height}`),
    };
  });

async function oneRun(n) {
  const s = await launch({ args: EXTRA_ARGS });
  const report = { run: n };
  let cdp = null;
  const traceEvents = [];
  try {
    if (TRACE || PROFILE || DUMP) cdp = await s.app.context().newCDPSession(s.win);
    if (TRACE) {
      cdp.on('Tracing.dataCollected', (e) => traceEvents.push(...e.value));
      await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES } });
    }
    const before = await memRows(s);
    await s.win.waitForSelector('.empty-state');
    if (GATE) await s.win.evaluate(GATE_SHIM);
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    const started = performance.now();
    await s.win.keyboard.press('Control+o');
    await s.win.locator('.page-canvas').first().waitFor({ timeout: 60000 });
    report.firstPageMs = Math.round(performance.now() - started);
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
    const afterOpen = await memRows(s);
    report.memBeforeOpenWs = before.wsTabGpu;
    report.memAfterOpenWs = afterOpen.wsTabGpu;

    const box = s.win.getByLabel('Page number');
    await box.click();
    await box.fill('1000');
    await box.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1000 of 1000'), { timeoutMs: 30000, label: 'Page 1000 of 1000' });
    if (SETTLE_MS > 0) await s.win.waitForTimeout(SETTLE_MS);
    if (PROFILE) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
    }

    // A long frame that is the machine's doing (no app work, another process saturating the CPU) is INVALID and measured again (3 attempts).
    const rendererCpu = async () => s.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((t, m) => t + (m.cpu.cumulativeCPUUsage ?? 0), 0));
    const vm = await measureValid({ label: `hitch run ${n}`, win: s.win, rendererCpu, throwOnInvalid: false, measure: async () => {
    const r = await s.win.evaluate(async () => {
      const viewer = document.querySelector('.viewer');
      if (!viewer) return { error: 'no .viewer element' };
      window.__pdfSuiteDiag?.enable?.();
      const observed = [];
      const safe = (fn) => { try { fn(); } catch (e) { observed.push({ type: 'observer-error', message: String(e) }); } };
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.entryType === 'longtask') {
            observed.push({ type: 'longtask', start: Math.round(e.startTime), dur: Math.round(e.duration), name: e.name, attribution: (e.attribution ?? []).map((a) => `${a.name}/${a.containerType}/${a.containerName}`) });
          } else {
            observed.push({
              type: 'loaf', start: Math.round(e.startTime), dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration),
              renderStart: Math.round(e.renderStart), styleAndLayoutStart: Math.round(e.styleAndLayoutStart), firstUIEvent: Math.round(e.firstUIEventTimestamp),
              scripts: (e.scripts ?? []).map((sc) => ({
                invoker: sc.invoker, invokerType: sc.invokerType, fn: sc.sourceFunctionName, url: String(sc.sourceURL).split('/').pop(), char: sc.sourceCharPosition,
                start: Math.round(sc.startTime), dur: Math.round(sc.duration), forcedLayout: Math.round(sc.forcedStyleAndLayoutDuration), pause: Math.round(sc.pauseDuration),
              })),
            });
          }
        }
      });
      safe(() => po.observe({ type: 'longtask', buffered: true }));
      safe(() => po.observe({ type: 'long-animation-frame', buffered: true }));
      const gaps = [];
      let last = performance.now();
      let running = true;
      const started = performance.now();
      performance.mark('hitch-scroll-start');
      const timed = [];
      let step = -1;
      const sample = () => {
        const now = performance.now();
        gaps.push(now - last);
        timed.push({ at: now - started, gap: now - last, step, scrollTop: Math.round(viewer.scrollTop) });
        last = now;
        if (running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const max = viewer.scrollHeight - viewer.clientHeight;
      const t0 = performance.now();
      const steps = 120;
      const timerLate = [];
      let prev = performance.now();
      const tick = async () => {
        await new Promise((r) => setTimeout(r, 16));
        const now = performance.now();
        if (now - prev > 50) timerLate.push({ at: Math.round(now - started), took: Math.round(now - prev), step });
        prev = now;
      };
      for (let i = 0; i <= steps; i++) {
        step = i;
        viewer.scrollTop = (max * i) / steps;
        await tick();
      }
      for (let i = steps; i >= 0; i--) {
        step = 1000 + i;
        viewer.scrollTop = (max * i) / steps;
        await tick();
      }
      running = false;
      performance.mark('hitch-scroll-end');
      const elapsed = performance.now() - t0;
      const sorted = [...gaps].sort((a, b) => a - b);
      const long = timed.filter((f) => f.gap > 30).map((f) => ({ at: Math.round(f.at), gap: Math.round(f.gap), step: f.step, scrollTop: f.scrollTop, absEnd: Math.round(started + f.at) }));
      po.disconnect();
      const diag = window.__pdfSuiteDiag?.events?.(0) ?? [];
      return {
        elapsed, frames: gaps.length, worstFrameMs: Math.max(...gaps),
        worstAfterFirstSecondMs: Math.max(...timed.filter((f) => f.at > 1000).map((f) => f.gap)),
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
        startedAbs: Math.round(started), long, timerLate, observed, diag,
        pageNodes: document.querySelectorAll('.page').length,
      };
    });
    if (r.error) throw new Error(r.error);
    r.longFrames = r.long.filter((f) => f.at > 1000 && f.gap > 50).map((f) => ({ end: f.absEnd, gap: f.gap }));
    return r;
    } });
    report.verdict = vm.verdict;
    report.attempts = vm.attempts.map((a) => ({ n: a.attempt, verdict: a.verdict, reason: a.reason, machine: a.machine, appWorkMs: Math.round(a.appWorkMs), rendererCpuSec: a.rendererCpuSec }));
    if (vm.verdict === 'invalid-final') {
      report.invalidMessage = vm.message;
      report.errors = [vm.message];
      return report;
    }
    const scroll = vm.result;
    const memAtOnce = await memRows(s);
    let profile = null;
    if (PROFILE) profile = (await cdp.send('Profiler.stop')).profile;
    const engineAtOnce = await engineMem(s.win);
    report.scroll = { elapsed: Math.round(scroll.elapsed), frames: scroll.frames, p95: Number(scroll.p95FrameMs.toFixed(1)), worst: Number(scroll.worstFrameMs.toFixed(1)), worstAfter1s: Number(scroll.worstAfterFirstSecondMs.toFixed(1)), startedAbs: scroll.startedAbs };
    report.long = scroll.long;
    report.timerLate = scroll.timerLate;
    report.observed = scroll.observed;
    report.memAtOnce = memAtOnce;
    report.engineAtOnce = engineAtOnce;
    if (GATE) report.gate = await s.win.evaluate(() => window.__hitchGate);
    const hitch = scroll.worstAfterFirstSecondMs > 50;
    const early = scroll.long.some((f) => f.gap > 35);
    report.early = early;
    const spike = memAtOnce.wsTabGpu >= 800;
    report.hitch = hitch;
    report.spike = spike;
    if (MEM_ONLY_LATER) {
      report.memLater = [];
      for (const wait of [250, 750, 2000]) {
        await s.win.waitForTimeout(wait);
        report.memLater.push({ afterMs: wait, ...(await memRows(s)) });
      }
      report.engineLater = await engineMem(s.win);
    }
    if (TRACE) {
      const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Tracing.end');
      await done;
      if (hitch || spike || early || KEEP_ALL) {
        const file = join(OUT, `trace-run${n}.json`);
        writeFileSync(file, JSON.stringify(traceEvents));
        report.traceFile = file;
      }
    }
    if (DUMP) {
      report.dump = await memoryDump(cdp, await s.metrics());
      report.memAfterDump = await memRows(s);
    }
    if (profile && (hitch || process.env.HITCH_PROFILE_ALL === '1')) {
      const file = join(OUT, `profile-run${n}.cpuprofile`);
      writeFileSync(file, JSON.stringify(profile));
      report.profileFile = file;
    }
    writeFileSync(join(OUT, `diag-run${n}.json`), JSON.stringify(scroll.diag));
    report.errors = s.errors.slice(0, 5);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
  return report;
}

const all = [];
startSampler();
try {
  for (let i = 1; i <= RUNS; i++) {
    const r = await oneRun(i);
    all.push(r);
    if (r.verdict === 'invalid-final') { console.log(`RUN ${i}: INVALID: ${r.invalidMessage}`); continue; }
    console.log(`RUN ${i} (${r.verdict}, ${r.attempts.length} attempt(s)): firstPage ${r.firstPageMs} ms; scroll ${JSON.stringify(r.scroll)}; HITCH=${r.hitch} SPIKE=${r.spike}`);
    console.log(`  long frames: ${JSON.stringify(r.long)}`);
    if (r.gate) console.log(`  gate: ${JSON.stringify(r.gate)}`);
    console.log(`  late timers: ${JSON.stringify(r.timerLate)}`);
    for (const o of r.observed) console.log(`  ${JSON.stringify(o)}`);
    console.log(`  mem at once: ws ${r.memAtOnce.wsTabGpu} priv ${r.memAtOnce.privTabGpu} :: ${r.memAtOnce.procs.join(' | ')}`);
    console.log(`  engine at once: ${JSON.stringify(r.engineAtOnce)}`);
    for (const m of r.memLater ?? []) console.log(`  mem +${m.afterMs} ms: ws ${m.wsTabGpu} priv ${m.privTabGpu} :: ${m.procs.join(' | ')}`);
    if (r.engineLater) console.log(`  engine later: ${JSON.stringify(r.engineLater)}`);
    if (r.dump) for (const [proc, d] of Object.entries(r.dump)) console.log(`  dump ${proc}: ${JSON.stringify(d)}`);
    if (r.traceFile) console.log(`  trace: ${r.traceFile}`);
    if (r.profileFile) console.log(`  profile: ${r.profileFile}`);
    if (r.errors?.length) console.log(`  errors: ${JSON.stringify(r.errors)}`);
  }
} finally {
  await closeAll();
  writeFileSync(join(OUT, `summary-${Date.now()}.json`), JSON.stringify(all, null, 1));
  const hitches = all.filter((r) => r.hitch).length;
  const spikes = all.filter((r) => r.spike).length;
  const verdicts = (v) => all.filter((r) => (v === 'invalid' ? r.verdict === 'invalid-final' : r.verdict === v)).length;
  console.log(`
FRAME-VALIDITY SUMMARY runs ${all.length}: pass ${verdicts('pass')}, fail ${verdicts('fail')}, invalid on all attempts ${verdicts('invalid')}; invalid attempts in all ${tally.invalid}`);
  console.log(`\nSUMMARY runs ${all.length}; long frame after 1 s in ${hitches}; working set >= 800 MB at once in ${spikes}`);
}
