// Shared by the frame-time checks (tests/e2e/bigfile.e2e.mjs, tests/signoff2/perf.probe.mjs, tests/perf/hitch.probe.mjs).
//
// WHY (ticket 1.2.1): a long frame can come from the machine, not the app. When another process saturates the CPU
// (typically explorer.exe storms), the renderer waits on the GPU process and a frame takes 100+ ms while no app code runs.
// Evidence: tests/perf/hitch-ab.probe.mjs runs, 28 + 16 sweeps. Runs with a severe long frame and no app work had, during
// the sweep, total machine CPU 80-100 % (peak of 1 s samples) and explorer.exe at 1740-4154 % of one core. Runs without a
// storm had total CPU <= 65 % and the busiest process <= 968 % of one core.
//
// CLASSIFICATION of one measured window (a "long frame" is a frame gap over 50 ms after the first second, as before):
//   pass     no long frame.
//   fail     a long frame with real app work: the long-animation-frame entries overlapping it hold more than
//            APP_WORK_MAX_MS of script time (the frame limit itself: an app that spends the whole limit in its own
//            script is at fault). While the machine is saturated the limit is APP_WORK_MAX_SATURATED_MS, because
//            script time is wall time and a starved renderer stretches it (ticket 1.2.1 e2e runs under a storm showed
//            scripts of 12-43 ms in some and 248-252 ms in others, with no change in the app). Real app work is not
//            excused by this: it comes back in the rerun, on a quiet machine, and then fails at once. Also fail: a long frame with no app work but no machine saturation either (nothing
//            explains it), or no machine data at all. These fail at once, with no rerun.
//   invalid  a long frame with little app work (scripts <= APP_WORK_MAX_MS) while the machine was saturated by something
//            else: machine CPU peak >= SATURATED_CPU_PCT, or one outside process at >= SATURATED_PROCESS_PCT of one core.
//            The run is NOT a pass. The measurement is repeated, up to MAX_ATTEMPTS in all; if every attempt is
//            invalid the test fails, "machine too busy to measure", naming the busiest process.
// Thresholds sit between the two groups in the data above:
export const APP_WORK_MAX_MS = 50;
export const APP_WORK_MAX_SATURATED_MS = 300;
export const SATURATED_CPU_PCT = 75; // total machine CPU, peak 1 s sample in the window (storms 80-100, quiet <= 65)
export const SATURATED_PROCESS_PCT = 1500; // one outside process, % of one core, peak 1 s sample (storms 1740+, quiet <= 968)
export const MAX_ATTEMPTS = 3;
// The renderer's own CPU time over the window is logged beside every attempt (Electron getAppMetrics) but does not
// decide the verdict: the Tab process includes the PDF worker threads, so it is high in busy and quiet runs alike.

import { spawn } from 'node:child_process';

// ------------------------------------------------------------------ pure classification
/**
 * @param {{ longFrames: {end:number, gap:number}[], loafs: {start:number, dur:number, scriptMs:number}[],
 *           machine: {cpuMax:number|null, busiest:{name:string, pct:number}|null}|null }} w
 *   longFrames: frames over the limit (end time and gap, on the page's performance.now() clock);
 *   loafs: long-animation-frame entries (start time, duration, summed script duration), same clock.
 * @returns {{verdict:'pass'|'fail'|'invalid', reason:string, appWorkMs:number, saturated:boolean}}
 */
export function classifyFrames({ longFrames, loafs, machine }) {
  if (longFrames.length === 0) return { verdict: 'pass', reason: 'no long frame', appWorkMs: 0, saturated: false };
  let appWorkMs = 0;
  for (const f of longFrames) {
    const from = f.end - f.gap;
    const seen = loafs.filter((l) => l.start < f.end && l.start + l.dur > from);
    appWorkMs = Math.max(appWorkMs, seen.reduce((t, l) => t + l.scriptMs, 0));
  }
  const cpuHot = machine?.cpuMax != null && machine.cpuMax >= SATURATED_CPU_PCT;
  const procHot = machine?.busiest != null && machine.busiest.pct >= SATURATED_PROCESS_PCT;
  const saturated = Boolean(cpuHot || procHot);
  if (appWorkMs > (saturated ? APP_WORK_MAX_SATURATED_MS : APP_WORK_MAX_MS)) return { verdict: 'fail', reason: `long frame with app work (${Math.round(appWorkMs)} ms of script)`, appWorkMs, saturated };
  if (!machine) return { verdict: 'fail', reason: 'long frame and no machine data to explain it', appWorkMs, saturated };
  if (!saturated) return { verdict: 'fail', reason: 'long frame with no app work and no machine saturation (unexplained)', appWorkMs, saturated };
  return { verdict: 'invalid', reason: 'long frame with little app work while another process saturated the machine', appWorkMs, saturated };
}

// ------------------------------------------------------------------ machine sampler (typeperf, one sample a second)
const IGNORED = /^(_total|idle|typeperf|conhost|pdf ?suite|electron)$/i;
let sampler = null;

/** Starts the once-a-second machine sampler (idempotent). It is killed when this process exits. */
export function startSampler() {
  if (sampler) return sampler;
  const samples = []; // { t, cpu, procs: Map<name, pct> }
  let header = null;
  let buf = '';
  const child = spawn('typeperf', ['\\Processor(_Total)\\% Processor Time', '\\Process(*)\\% Processor Time', '-si', '1', '-sc', '1800'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const onLine = (line) => {
    const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
    if (cells.length < 3) return;
    if (!header) {
      if (cells[0].startsWith('(PDH')) header = cells.slice(1).map((c) => (c.match(/\\Process\(([^)]*)\)/)?.[1] ?? (/Processor\(_Total\)/.test(c) ? '__cpu' : null)));
      return;
    }
    const m = cells[0].match(/^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?/);
    const t = m ? new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6], m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0).getTime() : Date.now();
    const sample = { t, cpu: null, procs: new Map() };
    cells.slice(1).forEach((c, i) => {
      const name = header[i];
      const v = Number(c);
      if (!name || !Number.isFinite(v)) return;
      if (name === '__cpu') sample.cpu = v;
      else {
        const base = name.replace(/#\d+$/, '');
        sample.procs.set(base, Math.max(sample.procs.get(base) ?? 0, v));
      }
    });
    samples.push(sample);
  };
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n/, '');
      onLine(line);
    }
  });
  child.on('error', () => undefined);
  // The sampler must never keep the test process alive.
  child.unref();
  child.stdout.unref?.();
  process.on('exit', () => { try { child.kill(); } catch { /* already gone */ } });
  sampler = { samples, stop: () => { try { child.kill(); } catch { /* gone */ } sampler = null; } };
  return sampler;
}

/** Machine state over a wall-clock window: peak total CPU and the busiest outside process (the project's own app excluded). */
export function machineWindow(fromMs, toMs, samplesIn = sampler?.samples ?? []) {
  const rows = samplesIn.filter((s) => s.t >= fromMs - 1000 && s.t <= toMs + 1000);
  if (rows.length === 0) return null;
  let cpuMax = null;
  const peak = new Map();
  for (const r of rows) {
    if (r.cpu != null) cpuMax = Math.max(cpuMax ?? 0, r.cpu);
    for (const [n, v] of r.procs) if (!IGNORED.test(n)) peak.set(n, Math.max(peak.get(n) ?? 0, v));
  }
  let busiest = null;
  for (const [name, pct] of peak) if (!busiest || pct > busiest.pct) busiest = { name, pct: Math.round(pct) };
  return { cpuMax: cpuMax == null ? null : Math.round(cpuMax), busiest, samples: rows.length };
}

// ------------------------------------------------------------------ page side
/** Run in the page (win.evaluate) before the measured window: collects long-animation-frame entries. */
export const PAGE_LOAF_START = () => {
  window.__vLoafs = window.__vLoafs ?? [];
  window.__vLoafs.length = 0;
  if (!window.__vLoafObs) {
    try {
      window.__vLoafObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__vLoafs.push({ start: e.startTime, dur: e.duration, scriptMs: (e.scripts ?? []).reduce((t, sc) => t + sc.duration, 0) });
      });
      window.__vLoafObs.observe({ type: 'long-animation-frame', buffered: false });
    } catch { window.__vLoafObs = null; }
  }
};
/** Run in the page after the window: the entries, after letting the observer deliver pending ones. */
export const PAGE_LOAF_READ = async () => {
  await new Promise((r) => setTimeout(r, 100));
  const pending = window.__vLoafObs?.takeRecords?.() ?? [];
  for (const e of pending) window.__vLoafs.push({ start: e.startTime, dur: e.duration, scriptMs: (e.scripts ?? []).reduce((t, sc) => t + sc.duration, 0) });
  return window.__vLoafs.slice();
};

/** Long frames of a rAF gap series: [{at (ms since started), gap}], as the tests count them (gap over 50 ms after the first second). */
export const longFramesOf = (timed, startedAbs) => timed.filter((f) => f.at > 1000 && f.gap > 50).map((f) => ({ end: startedAbs + f.at, gap: f.gap }));

// ------------------------------------------------------------------ the measurement loop
export const tally = { pass: 0, fail: 0, invalid: 0, invalidFinal: 0 };

/**
 * Runs `measure()` (which returns the test's result object with `longFrames` [{end, gap}] on the page's performance.now()
 * clock) and classifies the window. An invalid attempt is logged and measured again, up to MAX_ATTEMPTS attempts in all.
 * Returns { result, verdict, attempts } where verdict is 'pass' or 'fail' (the caller's own assertions then judge the
 * numbers as before) or 'invalid-final' when every attempt was invalid (only with throwOnInvalid: false; otherwise it throws).
 * @param {{label:string, win:any, measure:()=>Promise<any>, rendererCpu?:()=>Promise<number>, throwOnInvalid?:boolean}} o
 */
export async function measureValid({ label, win, measure, rendererCpu, throwOnInvalid = true }) {
  startSampler();
  const attempts = [];
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    await win.evaluate(PAGE_LOAF_START);
    const cpu0 = rendererCpu ? await rendererCpu().catch(() => null) : null;
    const t0 = Date.now();
    const result = await measure();
    const t1 = Date.now();
    const cpu1 = rendererCpu ? await rendererCpu().catch(() => null) : null;
    const loafs = await win.evaluate(PAGE_LOAF_READ).catch(() => []);
    await new Promise((r) => setTimeout(r, 1200)); // let the sampler deliver the last second of the window
    const machine = machineWindow(t0, t1);
    const c = classifyFrames({ longFrames: result.longFrames ?? [], loafs, machine });
    const rec = { attempt: n, ...c, machine, rendererCpuSec: cpu0 != null && cpu1 != null ? Number((cpu1 - cpu0).toFixed(2)) : null, windowMs: t1 - t0, worstLongFrameMs: Math.max(0, ...(result.longFrames ?? []).map((f) => f.gap)) };
    attempts.push(rec);
    console.log(`  frame-validity [${label}] attempt ${n}/${MAX_ATTEMPTS}: ${c.verdict.toUpperCase()} (${c.reason}); long frames ${(result.longFrames ?? []).length}, worst ${Math.round(rec.worstLongFrameMs)} ms, app script ${Math.round(c.appWorkMs)} ms; machine cpu peak ${machine?.cpuMax ?? '?'} %, busiest outside ${machine?.busiest ? `${machine.busiest.name} ${machine.busiest.pct} %` : '?'}; renderer cpu ${rec.rendererCpuSec ?? '?'} s`);
    if (c.verdict !== 'invalid') {
      tally[c.verdict] += 1;
      tally.invalid += attempts.length - 1;
      return { result, verdict: c.verdict, attempts };
    }
  }
  tally.invalid += attempts.length;
  tally.invalidFinal += 1;
  const busy = attempts.map((a) => a.machine?.busiest).filter(Boolean).sort((a, b) => b.pct - a.pct)[0];
  const msg = `machine too busy to measure: all ${MAX_ATTEMPTS} attempts of "${label}" had a long frame with no app work while the machine was saturated (busiest process: ${busy ? `${busy.name} at ${busy.pct} % of one core` : 'unknown'}; total CPU peak ${Math.max(...attempts.map((a) => a.machine?.cpuMax ?? 0))} %)`;
  if (throwOnInvalid) throw new Error(msg);
  return { result: null, verdict: 'invalid-final', attempts, message: msg };
}

// ------------------------------------------------------------------ search-time windows (heavy first search spread, 2026-11-11)
// WHY: on the text-dense heavy-1000.pdf the first search measured 1.24-1.47 s on a quiet machine and 2.4-2.8 s when the machine was
// saturated (docs/milestone-1.5/measurements.md, "Heavy first search spread": 16 fresh-app runs, every slow run had total CPU peak
// 99-100 % and average 78-100 % with MsMpEng, node, python or esbuild busy; every fast run had peak <= 39 %; MuPDF's time per page
// was stretched evenly, 1.6 ms against 0.9 ms; the app's own work was the same). Same rule as the frame checks:
//   pass     the timings are within their limits (a saturated machine cannot make a search faster, so this stands).
//   invalid  a limit is exceeded while total machine CPU peaked at SATURATED_CPU_PCT or more. Not a failure: measured again, up
//            to MAX_ATTEMPTS in all (each attempt is a fresh app, because a repeat in the same app reads cached text).
//   fail     a limit is exceeded on a machine that was not saturated, or there is no machine data. All attempts invalid = fail,
//            "machine too busy to measure".
/** @param {{ok:boolean, machine:{cpuMax:number|null, busiest:{name:string,pct:number}|null}|null}} w */
export function classifySearch({ ok, machine }) {
  if (ok) return { verdict: 'pass', reason: 'within the limits', saturated: Boolean(machine?.cpuMax != null && machine.cpuMax >= SATURATED_CPU_PCT) };
  if (!machine || machine.cpuMax == null) return { verdict: 'fail', reason: 'over a limit and no machine data to explain it', saturated: false };
  if (machine.cpuMax >= SATURATED_CPU_PCT) return { verdict: 'invalid', reason: `over a limit while total CPU peaked at ${machine.cpuMax} % (>= ${SATURATED_CPU_PCT} %)`, saturated: true };
  return { verdict: 'fail', reason: `over a limit on a quiet machine (CPU peak ${machine.cpuMax} %)`, saturated: false };
}

/**
 * Runs `run(attemptNumber)` (one whole search measurement, in a fresh app from attempt 2 on; returns the result object) and
 * `judge(result)` (true when every limit holds). Classifies each attempt by the machine over its window and repeats invalid ones.
 * Returns { result, verdict: 'pass'|'fail'|'invalid-final', attempts, machine }; the attempts carry CPU peak and busiest outside process.
 * @param {{label:string, run:(n:number)=>Promise<any>, judge:(r:any)=>boolean}} o
 */
export async function measureSearchValid({ label, run, judge }) {
  startSampler();
  const attempts = [];
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const t0 = Date.now();
    const result = await run(n);
    const t1 = Date.now();
    await new Promise((r) => setTimeout(r, 1200)); // let the sampler deliver the last second of the window
    const machine = machineWindow(t0, t1);
    const c = classifySearch({ ok: judge(result), machine });
    attempts.push({ attempt: n, verdict: c.verdict, reason: c.reason, cpuPeak: machine?.cpuMax ?? null, busiestOutside: machine?.busiest ?? null, windowMs: t1 - t0, result, machine });
    console.log(`  search-validity [${label}] attempt ${n}/${MAX_ATTEMPTS}: ${c.verdict.toUpperCase()} (${c.reason}); machine cpu peak ${machine?.cpuMax ?? '?'} %, busiest outside ${machine?.busiest ? `${machine.busiest.name} ${machine.busiest.pct} %` : '?'}`);
    if (c.verdict !== 'invalid') {
      tally[c.verdict] += 1;
      tally.invalid += n - 1;
      return { result, verdict: c.verdict, attempts, machine };
    }
  }
  tally.invalid += attempts.length;
  tally.invalidFinal += 1;
  return { result: attempts[attempts.length - 1].result, verdict: 'invalid-final', attempts, machine: attempts[attempts.length - 1].machine };
}
