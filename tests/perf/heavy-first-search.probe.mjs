// Measurement only (heavy first-search timing spread, 2026-11-11): why the first search of heavy-1000.pdf measures
// 1.24-1.36 s in most runs and 2.35-2.78 s in some. It asserts nothing and changes no app code.
//   node tests/perf/heavy-first-search.probe.mjs [runs=8] [modes=open,perf] [trace=gc|wasm|none]   (through the test queue; exclusive)
// Each run is a FRESH app (new profile). Modes:
//   open  open the file, wait SETTLE_MS (3 s), Ctrl+F, type the word. Nothing else.
//   quick open the file, type the word as soon as page 1 shows (renders of the first pages / thumbnails still queued).
//   perf  as tests/signoff2/perf.probe.mjs does before its search: two full scroll sweeps, Ctrl+Home, then type the word and
//         jump to pages 250 and 750 while the search runs.
// Per run it prints one JSON line with:
//   phases     typing pause (input event -> first `text` request), worker round trips of the `text` requests, unpack time on the
//              page, time inside MuPDF's stext call and inside postMessage in the worker (as search-phases.probe.mjs), the
//              slowest batches, and the stext time of the first/middle/last third of the pages (uniform stretch or a burst).
//   workers    every MuPDF worker the page started (created, init done), which one got `open`, which ones got `text`; so
//              whether the search ran on the warm spare (ready before `open`) or on a worker that had to start.
//   render     requests by op and priority that overlapped the search, in flight when typing began, and the last reply of
//              render/thumbnail work before typing (is the page still painting during the search).
//   machine    total CPU (os.cpus, 100 ms) and free memory over the search and over the 3 s before it; the typeperf 1 s
//              samples (tests/lib/frame-validity.mjs) with the busiest outside processes; app process CPU seconds over the
//              search by process type (Electron getAppMetrics).
//   gc         V8 GC events and their durations per thread from a Chromium trace of the search window (categories v8,
//              v8.gc, devtools.timeline); with trace=wasm also the v8.wasm events (tier-up / compile on background threads).
//   memory     WASM heap bytes and JS heap before and after the search.
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, freemem } from 'node:os';
import { startSampler } from '../lib/frame-validity.mjs';
import { launch, closeAll, cleanupProfile, statusText, waitFor, waitForPage } from '../e2e/helpers.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const HEAVY = [join(ROOT, 'tests', 'signoff', 'out', 'heavy-1000.pdf'), resolve(ROOT, '..', '..', 'pdf-suite', 'tests', 'signoff', 'out', 'heavy-1000.pdf')].find((p) => existsSync(p));
const RUNS = Number(process.argv[2] ?? process.env.RUNS ?? 8);
const MODES = (process.argv[3] ?? process.env.MODES ?? 'open,perf').split(',');
const TRACE = process.argv[4] ?? process.env.TRACE ?? 'gc';
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 3000);
const WORD = 'Heavy';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (label, value) => console.log(`${label} ${JSON.stringify(value)}`);
const round = (n, d = 0) => (n == null ? null : Number(n.toFixed(d)));

// ---------------------------------------------------------------- page side
const INIT = `(() => {
  const Real = window.Worker;
  const workers = (window.__workers = []);
  const T = (window.__wt = { sent: new Map(), done: [] });
  window.__typedAt = null;
  document.addEventListener('input', (e) => { if (e.target && e.target.getAttribute && e.target.getAttribute('aria-label') === 'Find in document' && window.__typedAt === null) window.__typedAt = performance.now(); }, true);
  function Tracked(url, options) {
    const worker = new Real(url, options);
    const rec = { idx: workers.length, createdAt: performance.now(), initDoneAt: null, openSentAt: null, openDoneAt: null, texts: 0, renders: 0, live: true };
    workers.push(rec);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { rec.live = false; terminate(); };
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (msg, transfer) => {
      if (msg && typeof msg.id === 'number' && msg.id > 0) {
        const t = performance.now();
        T.sent.set(msg.id, { op: msg.op, pri: msg.pri, w: rec.idx, t });
        if (msg.op === 'open') rec.openSentAt = t;
        if (msg.op === 'text') rec.texts += 1;
        if (msg.op === 'render') rec.renders += 1;
      }
      return post(msg, transfer);
    };
    worker.addEventListener('message', (e) => {
      const t0 = performance.now();
      const d = e.data;
      const t1 = performance.now();
      const r = d && typeof d.id === 'number' ? T.sent.get(d.id) : null;
      if (r) {
        T.sent.delete(d.id);
        T.done.push({ op: r.op, pri: r.pri, w: r.w, sent: r.t, recv: t0, unpack: t1 - t0 });
        if (r.op === 'init' && rec.initDoneAt === null) rec.initDoneAt = t0;
        if (r.op === 'open' && rec.openDoneAt === null) rec.openDoneAt = t0;
      }
    });
    return worker;
  }
  Tracked.prototype = Real.prototype;
  window.Worker = Tracked;
  window.__watchSearch = () => new Promise((resolve) => {
    const tick = () => {
      const t = (document.querySelector('.search-status')?.textContent ?? '').trim();
      const now = performance.now();
      // Only the final "n of 1000" ends a run: "No matches" before the scan has read anything is the idle state, not a result.
      if (window.__typedAt !== null && /^\\d+ of 1000$/.test(t)) return resolve({ status: t, doneAt: now });
      if (window.__typedAt !== null && now - window.__typedAt > 60000) return resolve({ timeout: true, status: t, doneAt: now });
      setTimeout(tick, 2);
    };
    tick();
  });
})();`;

/** Inside each MuPDF worker: stext call time per page, postMessage time. Returns how many workers were patched. */
async function patchWorkers(win) {
  let patched = 0;
  for (const w of win.workers()) {
    const ok = await w.evaluate(() => {
      const M = globalThis.$libmupdf_wasm_Module;
      if (!M || typeof M._wasm_new_stext_page_from_page !== 'function') return false;
      if (globalThis.__wk) return true;
      const K = (globalThis.__wk = { stext: [], postMs: 0, postN: 0, postTextMs: 0, postTextN: 0, heapBefore: M.HEAPU8 ? M.HEAPU8.length : null });
      const real = M._wasm_new_stext_page_from_page;
      M._wasm_new_stext_page_from_page = function (...a) { const t = performance.now(); try { return real.apply(this, a); } finally { K.stext.push(performance.now() - t); } };
      const post = self.postMessage.bind(self);
      self.postMessage = (msg, transfer) => {
        const t = performance.now();
        try { return post(msg, transfer); } finally {
          const d = performance.now() - t; K.postMs += d; K.postN += 1;
          if (msg && Array.isArray(msg.result) && msg.result[0] && (Array.isArray(msg.result[0].runs) || msg.result[0].packed || msg.result[0].lines)) { K.postTextMs += d; K.postTextN += 1; }
        }
      };
      return true;
    }).catch(() => false);
    if (ok) patched += 1;
  }
  return patched;
}
async function workerCounters(win, reset) {
  const rows = [];
  for (const w of win.workers()) {
    const k = await w.evaluate((reset) => {
      const K = globalThis.__wk; if (!K) return null;
      const M = globalThis.$libmupdf_wasm_Module;
      const copy = { stext: K.stext.slice(), postMs: K.postMs, postN: K.postN, postTextMs: K.postTextMs, postTextN: K.postTextN, heapBefore: K.heapBefore, heapNow: M && M.HEAPU8 ? M.HEAPU8.length : null, origin: performance.timeOrigin };
      if (reset) { K.stext.length = 0; K.postMs = 0; K.postN = 0; K.postTextMs = 0; K.postTextN = 0; K.heapBefore = copy.heapNow; }
      return copy;
    }, reset).catch(() => null);
    if (k && (k.stext.length > 0 || k.postN > 0)) rows.push(k);
  }
  return rows;
}
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const sum = (a) => a.reduce((t, v) => t + v, 0);
function summariseWorker(rows) {
  if (!rows.length) return null;
  // Take the worker with the most stext calls (the document's).
  const k = rows.sort((a, b) => b.stext.length - a.stext.length)[0];
  const n = k.stext.length;
  const third = Math.max(1, Math.floor(n / 3));
  return {
    workersWithStext: rows.length, stextN: n, stextMs: round(sum(k.stext)), stextP50: round(pct(k.stext, 0.5), 2), stextP95: round(pct(k.stext, 0.95), 2), stextMax: round(Math.max(0, ...k.stext), 1),
    over5ms: k.stext.filter((v) => v > 5).length,
    thirdsMs: [round(sum(k.stext.slice(0, third))), round(sum(k.stext.slice(third, 2 * third))), round(sum(k.stext.slice(2 * third)))],
    postMs: round(k.postMs), postN: k.postN, postTextMs: round(k.postTextMs), postTextN: k.postTextN,
    wasmHeapMB: [k.heapBefore == null ? null : round(k.heapBefore / 1048576), k.heapNow == null ? null : round(k.heapNow / 1048576)],
  };
}

// ---------------------------------------------------------------- machine side
function startCpuSampler() {
  const rows = [];
  let prev = cpus().map((c) => ({ ...c.times }));
  const timer = setInterval(() => {
    const now = cpus().map((c) => ({ ...c.times }));
    let busy = 0; let total = 0;
    now.forEach((t, i) => {
      const p = prev[i];
      const idle = t.idle - p.idle;
      const all = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + idle;
      busy += all - idle; total += all;
    });
    prev = now;
    rows.push({ t: Date.now(), pct: total > 0 ? (100 * busy) / total : 0, freeMB: freemem() / 1048576 });
  }, 100);
  return { rows, stop: () => clearInterval(timer) };
}
const cpuWindow = (rows, from, to) => {
  const r = rows.filter((x) => x.t >= from && x.t <= to);
  if (!r.length) return null;
  return { avg: round(sum(r.map((x) => x.pct)) / r.length), peak: round(Math.max(...r.map((x) => x.pct))), n: r.length };
};
/** Busiest outside processes over a window from the typeperf samples (frame-validity.mjs): top three by peak % of one core. */
function outsideProcs(samples, from, to) {
  const rows = samples.filter((s) => s.t >= from - 1000 && s.t <= to + 1000);
  if (!rows.length) return null;
  const peak = new Map(); const mine = new Map();
  let cpuPeak = 0;
  for (const r of rows) {
    if (r.cpu != null) cpuPeak = Math.max(cpuPeak, r.cpu);
    for (const [n, v] of r.procs) {
      if (/^(_total|idle|typeperf)$/i.test(n)) continue;
      const bucket = /^(pdf ?suite|electron|conhost)$/i.test(n) ? mine : peak;
      bucket.set(n, Math.max(bucket.get(n) ?? 0, v));
    }
  }
  const top = [...peak].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, p]) => `${name}:${Math.round(p)}`);
  const app = [...mine].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name, p]) => `${name}:${Math.round(p)}`);
  return { samples: rows.length, cpuPeak1s: round(cpuPeak), outsideTop: top, appProcs: app };
}
const appCpu = (s) => s.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpuSec: m.cpu.cumulativeCPUUsage ?? 0 })));
const appCpuDelta = (a, b) => {
  const by = {};
  const pa = new Map(a.map((x) => [x.pid, x.cpuSec]));
  for (const x of b) by[x.type] = round((by[x.type] ?? 0) + x.cpuSec - (pa.get(x.pid) ?? 0), 2);
  return by;
};

// ---------------------------------------------------------------- trace (GC, wasm) of the search window
async function startTrace(cdp, kind) {
  if (kind === 'none') return null;
  const events = [];
  const included = ['v8', 'v8.gc', 'devtools.timeline'];
  if (kind === 'wasm') included.push('v8.wasm', 'v8.wasm.detailed', 'disabled-by-default-v8.compile');
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  try {
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: included, excludedCategories: ['*'] } });
    return { events, cdp };
  } catch (e) { return { events, cdp, error: String(e.message ?? e).slice(0, 160) }; }
}
async function endTrace(t) {
  if (!t) return null;
  if (t.error) return { error: t.error };
  try {
    const done = new Promise((r) => t.cdp.once('Tracing.tracingComplete', r));
    await t.cdp.send('Tracing.end');
    await Promise.race([done, delay(15000)]);
  } catch (e) { return { error: String(e.message ?? e).slice(0, 160) }; }
  const names = new Map();
  for (const e of t.events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name ?? '?');
  const open = new Map();
  const agg = new Map();
  const add = (key, name, dur) => { const k = `${key}|${name}`; const a = agg.get(k) ?? { thread: key, name, n: 0, ms: 0, max: 0 }; a.n += 1; a.ms += dur / 1000; a.max = Math.max(a.max, dur / 1000); agg.set(k, a); };
  const interesting = /GC|Scavenge|MinorGC|MajorGC|wasm|Wasm|TurboFan|Liftoff|Compile|TierUp|Tier/i;
  for (const e of t.events) {
    if (!interesting.test(e.name)) continue;
    const key = `${names.get(`${e.pid}:${e.tid}`) ?? 'thread'}#${e.pid}:${e.tid}`;
    if (e.ph === 'X' && e.dur != null) add(key, e.name, e.dur);
    else if (e.ph === 'B') { const k = `${key}|${e.name}`; (open.get(k) ?? open.set(k, []).get(k)).push(e.ts); }
    else if (e.ph === 'E') { const k = `${key}|${e.name}`; const st = open.get(k); if (st && st.length) add(key, e.name, e.ts - st.pop()); }
  }
  const gcRows = [...agg.values()].filter((a) => /GC|Scavenge/i.test(a.name) && !/wasm/i.test(a.name));
  const wasmRows = [...agg.values()].filter((a) => /wasm|TurboFan|Liftoff|TierUp|Compile/i.test(a.name) || /wasm/i.test(a.thread));
  const fmt = (rows, limit) => rows.sort((a, b) => b.ms - a.ms).slice(0, limit).map((a) => `${a.thread.replace(/#.*/, '')} ${a.name} n=${a.n} ${round(a.ms, 1)}ms max=${round(a.max, 1)}`);
  const gcTotal = round(sum(gcRows.filter((a) => /^(MinorGC|MajorGC)$/.test(a.name)).map((a) => a.ms)), 1);
  return { events: t.events.length, gcTotalMs: gcTotal, gc: fmt(gcRows, 8), wasm: fmt(wasmRows, 10) };
}

// ---------------------------------------------------------------- one run
const sampler = startSampler();
const cpuSampler = startCpuSampler();

async function sweep(win) {
  await win.evaluate(async () => {
    const viewer = document.querySelector('.viewer');
    const max = viewer.scrollHeight - viewer.clientHeight;
    for (let i = 0; i <= 120; i++) { viewer.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
    for (let i = 120; i >= 0; i--) { viewer.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
  });
}

async function runOne(index, mode) {
  const s = await launch();
  const row = { run: index, mode };
  try {
    const launchedAt = Date.now();
    await s.win.addInitScript(INIT);
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
    await delay(1500);
    await s.setDialogAnswer([HEAVY]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
    const pageShownNodeAt = Date.now();
    if (mode === 'open') await delay(SETTLE_MS);
    if (mode === 'perf') {
      await delay(1000); await sweep(s.win); await delay(800); await sweep(s.win); await delay(1500);
      await s.win.keyboard.press('Control+Home').catch(() => undefined);
    }
    const cdp = await s.app.context().newCDPSession(s.win);
    await cdp.send('Performance.enable');
    row.workersPatched = await patchWorkers(s.win);
    await s.win.keyboard.press('Control+f');
    const find = s.win.getByLabel('Find in document');
    await find.waitFor({ timeout: 5000 });
    await delay(mode === 'quick' ? 0 : 700);
    await workerCounters(s.win, true);

    // State just before typing: requests in flight, last render reply, engine memory.
    const before = await s.win.evaluate(async () => {
      const inflight = {};
      for (const r of window.__wt.sent.values()) { const k = `${r.op}/${r.pri ?? '-'}`; inflight[k] = (inflight[k] ?? 0) + 1; }
      const lastRender = window.__wt.done.filter((d) => d.op === 'render').reduce((m, d) => Math.max(m, d.recv), 0);
      const lastAny = window.__wt.done.reduce((m, d) => Math.max(m, d.recv), 0);
      const eng = window.__pdfSuiteEngine ? await window.__pdfSuiteEngine.memory() : null;
      const draw = window.__pdfSuiteDrawStats ? { ...window.__pdfSuiteDrawStats } : null;
      return { now: performance.now(), inflight, sinceLastRenderMs: lastRender ? Math.round(performance.now() - lastRender) : null, sinceLastReplyMs: lastAny ? Math.round(performance.now() - lastAny) : null, wasmMB: eng ? eng.wasmHeapBytes.map((b) => Math.round(b / 1048576)) : null, jsHeapMB: eng && eng.jsHeapBytes != null ? Math.round(eng.jsHeapBytes / 1048576) : null, draw, thumbCanvases: document.querySelectorAll('[class*="thumb"] canvas').length };
    });
    const mark = before.now;
    const watch = s.win.evaluate(() => window.__watchSearch());
    const trace = await startTrace(cdp, TRACE);
    if (trace) await delay(400);
    const cpu0 = await appCpu(s);
    const perf0 = (await cdp.send('Performance.getMetrics')).metrics;
    const n0 = Date.now();
    await find.fill(WORD);
    if (mode === 'perf') {
      const box = s.win.getByLabel('Page number');
      for (const p of [250, 750]) {
        await box.click(); await box.fill(String(p)); await box.press('Enter');
        await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${p} of`), { timeoutMs: 10000, label: 'nav' });
      }
    }
    const seen = await watch;
    const n1 = Date.now();
    const perf1 = (await cdp.send('Performance.getMetrics')).metrics;
    const cpu1 = await appCpu(s);
    const traceSummary = await endTrace(trace);

    const page = await s.win.evaluate((mark) => ({
      typedAt: window.__typedAt, workers: window.__workers.map((w) => ({ ...w })),
      done: window.__wt.done.filter((d) => d.sent >= mark - 5).map((d) => ({ op: d.op, pri: d.pri, w: d.w, sent: d.sent, recv: d.recv, unpack: d.unpack })),
      sizesPending: [...window.__wt.sent.values()].filter((r) => r.op === 'sizes').length,
    }), mark);
    const after = await s.win.evaluate(async () => { const eng = window.__pdfSuiteEngine ? await window.__pdfSuiteEngine.memory() : null; return { wasmMB: eng ? eng.wasmHeapBytes.map((b) => Math.round(b / 1048576)) : null, jsHeapMB: eng && eng.jsHeapBytes != null ? Math.round(eng.jsHeapBytes / 1048576) : null }; });
    const wk = summariseWorker(await workerCounters(s.win, false));

    // ---- phases (page clock)
    const typed = page.typedAt ?? mark;
    const texts = page.done.filter((d) => d.op === 'text').sort((a, b) => a.sent - b.sent);
    const firstSent = texts.length ? texts[0].sent : null;
    const lastRecv = texts.length ? Math.max(...texts.map((d) => d.recv)) : null;
    const rt = texts.map((d) => d.recv - d.sent);
    const third = Math.max(1, Math.floor(rt.length / 3));
    const metric = (m, n) => m.find((x) => x.name === n)?.value ?? 0;
    const byOp = {};
    for (const d of page.done) {
      if (d.recv < typed - 5) continue;
      const k = `${d.op}${d.op === 'render' || d.op === 'sizes' ? '/pri' + d.pri : ''}`;
      const o = (byOp[k] ??= { n: 0, roundTripMs: 0 });
      o.n += 1; o.roundTripMs += d.recv - d.sent;
    }
    for (const o of Object.values(byOp)) o.roundTripMs = Math.round(o.roundTripMs);
    const docWorker = page.workers.find((w) => w.openSentAt !== null) ?? null;
    const textWorkers = [...new Set(texts.map((d) => d.w))];
    row.status = seen.status;
    row.valid = /^[1-9]\d* of 1000$/.test(seen.status) && texts.length >= 60 && !seen.timeout;
    if (!row.valid) row.invalidReason = `status "${seen.status}", ${texts.length} text batches`;
    row.totalMs = round(seen.doneAt - typed);
    row.nodeMs = n1 - n0;
    row.phases = {
      typingPauseMs: firstSent == null ? null : round(firstSent - typed),
      textBatches: texts.length, textRoundTripMs: round(sum(rt)), textWallMs: firstSent == null ? null : round(lastRecv - firstSent),
      batchP50: round(pct(rt, 0.5)), batchP95: round(pct(rt, 0.95)), batchMax: round(Math.max(0, ...rt)),
      batchThirdsMs: [round(sum(rt.slice(0, third))), round(sum(rt.slice(third, 2 * third))), round(sum(rt.slice(2 * third)))],
      unpackMs: round(sum(texts.map((d) => d.unpack))), unpackMax: round(Math.max(0, ...texts.map((d) => d.unpack)), 1),
      afterLastReplyMs: lastRecv == null ? null : round(seen.doneAt - lastRecv),
      mainTaskMs: round((metric(perf1, 'TaskDuration') - metric(perf0, 'TaskDuration')) * 1000), mainScriptMs: round((metric(perf1, 'ScriptDuration') - metric(perf0, 'ScriptDuration')) * 1000),
      worker: wk,
    };
    const now = Date.now();
    row.workers = {
      list: page.workers.map((w) => ({ idx: w.idx, createdMs: round(w.createdAt), initDoneMs: round(w.initDoneAt), openSentMs: round(w.openSentAt), openDoneMs: round(w.openDoneAt), texts: w.texts, renders: w.renders })),
      docWorker: docWorker ? docWorker.idx : null,
      docWorkerWasReady: docWorker ? docWorker.initDoneAt !== null && docWorker.initDoneAt <= docWorker.openSentAt : null,
      docWorkerCreatedBeforeOpenMs: docWorker ? round(docWorker.openSentAt - docWorker.createdAt) : null,
      textWorkers,
      openRoundTripMs: docWorker ? round(docWorker.openDoneAt - docWorker.openSentAt) : null,
      secondsSinceOpenAtTyping: round((typed - (docWorker?.openDoneAt ?? typed)) / 1000, 1),
    };
    row.render = {
      overlappedSearch: byOp,
      inflightBeforeTyping: before.inflight, sinceLastRenderMs: before.sinceLastRenderMs, sinceLastReplyMs: before.sinceLastReplyMs,
      sizesPending: page.sizesPending, thumbCanvases: before.thumbCanvases, draw: before.draw,
    };
    row.machine = {
      cpuSearch: cpuWindow(cpuSampler.rows, n0, n1), cpuBefore3s: cpuWindow(cpuSampler.rows, n0 - 3000, n0),
      freeMBAtSearch: round(cpuSampler.rows.filter((x) => x.t >= n0).map((x) => x.freeMB)[0] ?? 0),
      typeperf: outsideProcs(sampler.samples, n0, n1), typeperfBefore: outsideProcs(sampler.samples, n0 - 4000, n0 - 1500),
      appCpuSec: appCpuDelta(cpu0, cpu1),
      appCpuSecPerWall: round(sum(Object.values(appCpuDelta(cpu0, cpu1))) / ((n1 - n0) / 1000), 2),
    };
    row.gc = traceSummary;
    row.memory = { beforeWasmMB: before.wasmMB, afterWasmMB: after.wasmMB, beforeJsMB: before.jsHeapMB, afterJsMB: after.jsHeapMB };
    row.errors = s.errors.slice(0, 3);
    row.sinceLaunchS = round((pageShownNodeAt - launchedAt) / 1000, 1);
  } catch (e) {
    row.failed = String(e.stack ?? e).slice(0, 600);
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(s.profile);
  }
  return row;
}

const rows = [];
try {
  if (!HEAVY) throw new Error('heavy-1000.pdf not found (tests/signoff/out, run tests/signoff/make-signoff-fixtures.mjs)');
  await delay(2500); // typeperf starts
  out('[heavy] config', { runs: RUNS, modes: MODES, trace: TRACE, settleMs: SETTLE_MS, file: HEAVY, cpuCores: cpus().length, freeMB: Math.round(freemem() / 1048576) });
  for (const mode of MODES) {
    for (let i = 1; i <= RUNS; i++) {
      const row = await runOne(i, mode);
      rows.push(row);
      out(`[heavy] run ${mode} ${i}`, row);
    }
  }
  const lines = rows.map((r) => `${r.mode} #${r.run}: total ${r.totalMs} ms | pause ${r.phases?.typingPauseMs} | textWall ${r.phases?.textWallMs} | stext ${r.phases?.worker?.stextMs} | unpack ${r.phases?.unpackMs} | tail ${r.phases?.afterLastReplyMs} | doc worker ${r.workers?.docWorker} ready=${r.workers?.docWorkerWasReady} | cpu avg/peak ${r.machine?.cpuSearch?.avg}/${r.machine?.cpuSearch?.peak} | appCPUs ${r.machine?.appCpuSecPerWall} | gc ${r.gc?.gcTotalMs} | outside ${r.machine?.typeperf?.outsideTop?.[0]}${r.failed ? ' | FAILED' : ''}`);
  console.log('[heavy] SUMMARY\n' + lines.join('\n'));
  try {
    const dir = join(ROOT, 'tests', 'perf', 'out'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `heavy-first-search-${Date.now()}.json`), JSON.stringify(rows, null, 1));
  } catch { /* the log has everything */ }
} catch (e) {
  console.log(`PROBE FAILED ${String(e.stack ?? e).slice(0, 900)}`);
  process.exitCode = 1;
} finally {
  cpuSampler.stop();
  sampler.stop();
  await closeAll();
}
