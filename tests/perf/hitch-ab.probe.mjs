// DIAGNOSTICS ONLY (ticket 1.2.1): a back-to-back A/B of app builds on the bigfile fast-scroll scenario, with the
// machine's state recorded beside every run. It answers "is the long frame the build or the machine?".
//
//   node tests/perf/hitch-ab.probe.mjs name=path\to\PDF Suite.exe name2=path2 ...     Env: AB_ROUNDS=6 AB_OUT=dir
//
// Each round runs every build once, and the order rotates each round, so all builds see the same machine state.
// Per run (a child process, so the e2e launcher is used unchanged):
//  - the sweep of tests/e2e/bigfile.e2e.mjs (open big-1000.pdf, jump to 1000, scrollTop sweep down and back)
//  - frame gaps, 'longtask' and 'long-animation-frame' entries with script attribution, late timers
//  - CPU seconds the renderer and the GPU process used during the sweep (Electron getAppMetrics cumulativeCPUUsage),
//    so wall time the app did not spend running is visible
//  - afterwards, with the page idle: the worst gap of a 4 ms timer over 600 ms and a fixed CPU loop timed 8 times.
//    Neither involves the app, so they measure the machine as this page's main thread sees it.
// Meanwhile typeperf samples the machine once a second (free memory, paging, total CPU, the busiest known hog).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- one run (child)
async function oneRun() {
  const { launch, fixture, statusText, waitFor, waitForPage, closeAll, cleanupProfile } = await import('../e2e/helpers.mjs');
  const procs = (s) =>
    s.app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpuSec: m.cpu.cumulativeCPUUsage ?? null, wsKB: m.memory.workingSetSize, privKB: m.memory.privateBytes ?? null })),
    );
  const sum = (rows, types, key) => rows.filter((r) => types.includes(r.type)).reduce((t, r) => t + (r[key] ?? 0), 0);
  const report = { wallLaunch: Date.now() };
  const s = await launch();
  try {
    if (process.env.AB_STUB_RECENT === '1') await s.app.evaluate(({ app }) => { app.addRecentDocument = () => undefined; });
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([fixture('big-1000.pdf')]);
    const started = performance.now();
    await s.win.keyboard.press('Control+o');
    await s.win.locator('.page-canvas').first().waitFor({ timeout: 60000 });
    report.firstPageMs = Math.round(performance.now() - started);
    await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
    const box = s.win.getByLabel('Page number');
    await box.click();
    await box.fill('1000');
    await box.press('Enter');
    await waitFor(async () => (await statusText(s.win)).startsWith('Page 1000 of 1000'), { timeoutMs: 30000, label: 'Page 1000 of 1000' });
    if (Number(process.env.AB_SETTLE_MS ?? 0) > 0) await s.win.waitForTimeout(Number(process.env.AB_SETTLE_MS));

    const before = await procs(s);
    report.wallStart = Date.now();
    const scroll = await s.win.evaluate(async () => {
      const viewer = document.querySelector('.viewer');
      const observed = [];
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.entryType === 'longtask') observed.push({ type: 'longtask', start: Math.round(e.startTime), dur: Math.round(e.duration) });
          else
            observed.push({
              type: 'loaf', start: Math.round(e.startTime), dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration),
              renderStart: Math.round(e.renderStart), layoutStart: Math.round(e.styleAndLayoutStart),
              scripts: (e.scripts ?? []).map((sc) => ({ invoker: sc.invoker, fn: sc.sourceFunctionName, url: String(sc.sourceURL).split('/').pop(), dur: Math.round(sc.duration), forcedLayout: Math.round(sc.forcedStyleAndLayoutDuration) })),
            });
        }
      });
      po.observe({ type: 'longtask' });
      po.observe({ type: 'long-animation-frame' });
      const timed = [];
      let last = performance.now();
      let running = true;
      const started = performance.now();
      const sample = () => {
        const now = performance.now();
        timed.push({ at: now - started, gap: now - last });
        last = now;
        if (running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const max = viewer.scrollHeight - viewer.clientHeight;
      const steps = 120;
      const lateTimers = [];
      let prev = performance.now();
      const tick = async () => {
        await new Promise((r) => setTimeout(r, 16));
        const now = performance.now();
        if (now - prev > 50) lateTimers.push({ at: Math.round(now - started), took: Math.round(now - prev) });
        prev = now;
      };
      for (let i = 0; i <= steps; i++) { viewer.scrollTop = (max * i) / steps; await tick(); }
      for (let i = steps; i >= 0; i--) { viewer.scrollTop = (max * i) / steps; await tick(); }
      running = false;
      const elapsed = performance.now() - started;
      await new Promise((r) => setTimeout(r, 50));
      po.disconnect();
      const gaps = timed.map((f) => f.gap).sort((a, b) => a - b);
      const after1s = timed.filter((f) => f.at > 1000);
      const inWindow = (o) => o.start >= started && o.start <= started + elapsed;
      return {
        startedAbs: Math.round(started), elapsed: Math.round(elapsed), frames: timed.length,
        p95: Number(gaps[Math.floor(gaps.length * 0.95)].toFixed(1)),
        worstAfter1s: Number(Math.max(...after1s.map((f) => f.gap)).toFixed(1)),
        longFrames: after1s.filter((f) => f.gap > 50).map((f) => ({ at: Math.round(f.at), gap: Math.round(f.gap) })),
        sumOver50: Math.round(after1s.filter((f) => f.gap > 50).reduce((t, f) => t + f.gap, 0)),
        lateTimers,
        longtasks: observed.filter((o) => o.type === 'longtask' && inWindow(o)),
        loafs: observed.filter((o) => o.type === 'loaf' && inWindow(o)),
      };
    });
    report.wallEnd = Date.now();
    const after = await procs(s);
    Object.assign(report, scroll);
    report.tabCpuSec = Number((sum(after, ['Tab'], 'cpuSec') - sum(before, ['Tab'], 'cpuSec')).toFixed(2));
    report.gpuCpuSec = Number((sum(after, ['GPU'], 'cpuSec') - sum(before, ['GPU'], 'cpuSec')).toFixed(2));
    report.wsMB = Math.round(sum(after, ['Tab', 'GPU'], 'wsKB') / 1024);
    report.privMB = Math.round(sum(after, ['Tab', 'GPU'], 'privKB') / 1024);
    // The machine as this page's main thread sees it, with the app idle.
    await s.win.waitForTimeout(1500);
    report.idle = await s.win.evaluate(async () => {
      let worst = 0;
      let last = performance.now();
      const end = last + 600;
      while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, 4));
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
      }
      const loops = [];
      for (let n = 0; n < 8; n++) {
        const t = performance.now();
        let x = 0;
        for (let i = 0; i < 6e6; i++) x = (x + Math.sqrt(i)) % 1000;
        loops.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 0));
      }
      return { timerWorstMs: Number(worst.toFixed(1)), loopMinMs: Number(Math.min(...loops).toFixed(1)), loopMaxMs: Number(Math.max(...loops).toFixed(1)) };
    });
    report.errors = s.errors.slice(0, 3);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
    await closeAll();
  }
  console.log(`AB_RESULT ${JSON.stringify(report)}`);
}

// ---------------------------------------------------------------- driver
const COUNTERS = [
  '\\Memory\\Available MBytes', '\\Memory\\Pages/sec', '\\Memory\\Pages Input/sec', '\\Memory\\Page Faults/sec',
  '\\Processor(_Total)\\% Processor Time', '\\Process(explorer)\\% Processor Time', '\\System\\Processor Queue Length',
];

function readSamples(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^"\d\d\/\d\d\/\d{4}/.test(l));
  return lines.map((l) => {
    const cells = l.split('","').map((c) => c.replace(/"/g, ''));
    const [date, time] = cells[0].split(' ');
    const [mo, d, y] = date.split('/').map(Number);
    const [h, mi, sec] = time.split(':');
    const t = new Date(y, mo - 1, d, Number(h), Number(mi), Math.floor(Number(sec)), Math.round((Number(sec) % 1) * 1000)).getTime();
    const v = cells.slice(1).map((c) => (c.trim() === '' ? NaN : Number(c)));
    return { t, availMB: v[0], pages: v[1], pagesIn: v[2], faults: v[3], cpu: v[4], explorerCpu: v[5], queue: v[6] };
  });
}

async function driver() {
  const arms = process.argv.slice(2).map((a) => ({ name: a.slice(0, a.indexOf('=')), exe: a.slice(a.indexOf('=') + 1) }));
  if (arms.length === 0) throw new Error('give builds as name=path');
  const rounds = Number(process.env.AB_ROUNDS ?? 6);
  const out = process.env.AB_OUT ?? join(process.env.TEMP ?? '.', 'pdfsuite-ab');
  mkdirSync(out, { recursive: true });
  const csv = join(out, `machine-${Date.now()}.csv`);
  // typeperf ends by itself after -sc samples even if this driver dies; it is also stopped below through its handle.
  const sampler = spawn('typeperf', [...COUNTERS, '-si', '1', '-sc', String(rounds * arms.length * 40 + 60), '-f', 'CSV', '-o', csv, '-y'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => setTimeout(r, 3000));
  const results = [];
  try {
    for (let round = 0; round < rounds; round++) {
      const order = arms.map((_a, i) => arms[(i + round) % arms.length]);
      for (const arm of order) {
        const child = spawnSync(process.execPath, [SELF, '--one'], { env: { ...process.env, PDF_SUITE_EXE: arm.exe, AB_STUB_RECENT: arm.name.includes('norecent') ? '1' : '0' }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
        const line = (child.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('AB_RESULT '));
        const r = line ? JSON.parse(line.slice(10)) : { failed: (child.stderr ?? '').slice(-400) };
        r.arm = arm.name;
        r.round = round + 1;
        results.push(r);
        console.log(`round ${round + 1} ${arm.name.padEnd(4)} ${r.failed ? 'FAILED ' + r.failed : `first ${r.firstPageMs} ms; sweep ${r.elapsed} ms, frames ${r.frames}, p95 ${r.p95}, worst>1s ${r.worstAfter1s}; long frames ${r.longFrames.length} (sum ${r.sumOver50} ms); longtasks ${r.longtasks.length} (max ${Math.max(0, ...r.longtasks.map((t) => t.dur))}); late timers ${r.lateTimers.length}; cpu tab ${r.tabCpuSec}s gpu ${r.gpuCpuSec}s; priv ${r.privMB} ws ${r.wsMB}; idle timer ${r.idle.timerWorstMs} loop ${r.idle.loopMinMs}-${r.idle.loopMaxMs}`}`);
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  } finally {
    await new Promise((r) => setTimeout(r, 1500));
    sampler.kill();
  }
  const samples = readSamples(csv);
  const stat = (r, key, fn) => {
    const rows = samples.filter((sm) => sm.t >= r.wallStart - 1000 && sm.t <= r.wallEnd + 1000).map((sm) => sm[key]).filter((x) => Number.isFinite(x));
    return rows.length ? Math.round(fn(...rows)) : null;
  };
  for (const r of results) {
    if (r.failed) continue;
    // CPU seconds explorer.exe used from the app's launch to the end of the sweep (its % of one core, summed over the 1 s samples).
    r.explorerCpuSec = Number((samples.filter((sm) => sm.t >= r.wallLaunch && sm.t <= r.wallEnd + 500 && Number.isFinite(sm.explorerCpu)).reduce((t, sm) => t + sm.explorerCpu / 100, 0)).toFixed(1));
    r.machine = { availMinMB: stat(r, 'availMB', Math.min), pagesMax: stat(r, 'pages', Math.max), pagesInMax: stat(r, 'pagesIn', Math.max), faultsMax: stat(r, 'faults', Math.max), cpuMax: stat(r, 'cpu', Math.max), explorerCpuMax: stat(r, 'explorerCpu', Math.max), queueMax: stat(r, 'queue', Math.max) };
  }
  writeFileSync(join(out, `ab-${Date.now()}.json`), JSON.stringify(results, null, 1));
  console.log('\nPER RUN, with the machine during the sweep (avail MB min; pages/s, pages-in/s, total CPU %, explorer CPU % of one core, run queue: max)');
  for (const r of results) {
    if (r.failed) continue;
    const m = r.machine;
    console.log(`${String(r.round).padStart(2)} ${r.arm.padEnd(4)} worst>1s ${String(r.worstAfter1s).padStart(6)} sum>50 ${String(r.sumOver50).padStart(5)} sweep ${String(r.elapsed).padStart(5)} tabCpu ${String(r.tabCpuSec).padStart(5)} | avail ${m.availMinMB} pages ${m.pagesMax} in ${m.pagesInMax} cpu ${m.cpuMax}% explorer ${m.explorerCpuMax}% (${r.explorerCpuSec} cpu-s since launch) queue ${m.queueMax} | idle timer ${r.idle.timerWorstMs} loop ${r.idle.loopMinMs}-${r.idle.loopMaxMs}`);
  }
  console.log('\nPER BUILD');
  for (const arm of arms) {
    const rows = results.filter((r) => r.arm === arm.name && !r.failed);
    const bad = rows.filter((r) => r.worstAfter1s > 50);
    const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log(`${arm.name.padEnd(4)} runs ${rows.length}; long frame after 1 s in ${bad.length}; worst ${Math.max(...rows.map((r) => r.worstAfter1s))} ms; median worst ${med(rows.map((r) => r.worstAfter1s))}; median p95 ${med(rows.map((r) => r.p95))}; median sweep ${med(rows.map((r) => r.elapsed))} ms; median tab CPU ${med(rows.map((r) => r.tabCpuSec))} s; median explorer CPU since launch ${med(rows.map((r) => r.explorerCpuSec))} s (max ${Math.max(...rows.map((r) => r.explorerCpuSec))}); max private ${Math.max(...rows.map((r) => r.privMB))} MB`);
  }
  console.log(`machine samples: ${csv}`);
}

if (process.argv.includes('--one')) await oneRun();
else await driver();
