// Unattended test runner for PDF Suite: one long-running process. See scripts/testq/README.md.
//   node scripts/testq/runner.mjs            (normally started hidden by scripts/testq/start.ps1)
// It watches the queue folder, packs worktrees when asked, runs functional test files side by side, runs exclusive
// (timing and memory) files alone while holding the old machine lock, and writes result.json and summary.txt per job.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { entryFor, loadManifest, normaliseFiles, suiteFiles } from './lib/manifest.mjs';
import { limitMsFor, plan } from './lib/scheduler.mjs';
import * as lock from './lib/lock.mjs';
import { foreignAppBusy, killByCommandLine, run } from './lib/proc.mjs';
import { buildSummary, parseFileResult } from './lib/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const selfRoot = resolve(here, '..', '..');
const reporterPath = join(here, 'node-reporter.mjs');
const cfg = loadConfig();

const jobs = []; // runtime jobs (see ingest)
const itemHandles = new Map(); // `${jobId}\0${file}` -> { kill, timedOut }
const prepHandles = new Map(); // worktree -> { kill, timedOut }
let seq = 0;
let fileCounter = 0;
let holdsLock = false;
let lastLockRelease = 0;
const lockOwner = `pdfsuite-testq runner pid ${process.pid}`;
let stopping = false;
let busy = false;
let lastBeat = 0;
let foreignCache = { at: 0, value: false };
const startedAt = Date.now();

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(cfg.runnerLog, line);
  } catch {
    // the log is best effort
  }
};
const writeJson = (p, obj) => {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, p);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);

for (const d of [cfg.dir, cfg.inbox, cfg.jobsDir, cfg.tmpRoot]) mkdirSync(d, { recursive: true });

// ---- Single instance ----------------------------------------------------------------------------------------------
function otherRunnerAlive() {
  try {
    const hb = JSON.parse(readFileSync(cfg.heartbeatFile, 'utf8'));
    if (hb.pid && hb.pid !== process.pid && Date.now() - Date.parse(hb.beat) < 20_000) {
      process.kill(hb.pid, 0);
      return hb.pid;
    }
  } catch {
    // no heartbeat, or that process is gone
  }
  return null;
}

// ---- Ingest -------------------------------------------------------------------------------------------------------
function buildJob(spec, dir) {
  const worktree = resolve(spec.worktree);
  const manifest = loadManifest(worktree, selfRoot);
  let files = [];
  if (spec.suite) files.push(...suiteFiles(manifest, spec.suite));
  if (spec.files?.length) files.push(...normaliseFiles(worktree, spec.files));
  files = [...new Set(files)];
  const items = files.map((file) => {
    const e = entryFor(manifest, file);
    return {
      id: file,
      file,
      cls: e.class === 'functional' ? 'functional' : 'exclusive',
      minutes: e.minutes,
      known: e.known,
      runner: e.runner ?? 'node-test',
      args: e.args ?? [],
      fixtures: e.fixtures ?? [],
      limitMs: limitMsFor(e.minutes, { factor: cfg.limitFactor, floorMinutes: cfg.limitFloorMinutes }),
      status: 'pending',
    };
  });
  // Longest functional files first: the longest one decides the wall time of a parallel run. Exclusive files keep their order after them.
  items.sort((a, b) => (a.cls === b.cls ? (a.cls === 'functional' ? b.minutes - a.minutes : 0) : a.cls === 'functional' ? -1 : 1));
  const needsApp = items.some((i) => i.runner !== 'vitest');
  const wantPack = Boolean(spec.pack);
  return {
    id: spec.id,
    priority: spec.priority === 'ticket' ? 'ticket' : 'measure',
    seq: ++seq,
    worktree,
    wantPack,
    prep: needsApp || wantPack ? 'pending' : 'done',
    prepLimitMs: cfg.prepLimitMinutes * 60_000,
    spec,
    dir,
    logsDir: join(dir, 'logs'),
    rawDir: join(dir, 'raw'),
    who: spec.who ?? 'unknown',
    suite: spec.suite ?? null,
    submittedAt: spec.submittedAt ?? new Date().toISOString(),
    startedAt: null,
    items,
    extraFixtures: [...new Set(items.flatMap((i) => i.fixtures))],
    prepResult: { pack: null, fixtures: null },
  };
}

function ingest(spec, dir) {
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });
  let job;
  try {
    if (!spec.worktree || !existsSync(join(resolve(spec.worktree), 'package.json'))) throw new Error(`worktree not found or not a PDF Suite folder: ${spec.worktree}`);
    job = buildJob(spec, dir);
    if (job.items.length === 0) throw new Error('the job has no files');
  } catch (e) {
    const result = { id: spec.id, who: spec.who, ok: false, state: 'failed', error: String(e.message ?? e), files: [], totals: { pass: 0, fail: 0 }, wallSeconds: 0 };
    writeJson(join(dir, 'result.json'), result);
    writeFileSync(join(dir, 'summary.txt'), `job ${spec.id}  by ${spec.who}\nRESULT FAIL: job rejected: ${result.error}\n`);
    writeJson(join(dir, 'status.json'), { state: 'failed', error: result.error });
    log(`job ${spec.id} rejected: ${result.error}`);
    return;
  }
  jobs.push(job);
  const unknown = job.items.filter((i) => !i.known).map((i) => i.file);
  log(`job ${job.id} queued (${job.priority}, ${job.items.length} files${job.wantPack ? ', pack' : ''}${unknown.length ? `, not in manifest, treated as exclusive: ${unknown.join(' ')}` : ''})`);
  saveStatus(job);
}

function scanInbox() {
  let names = [];
  try {
    names = readdirSync(cfg.inbox).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(cfg.inbox, name);
    let spec;
    try {
      spec = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue; // being written: the submitter renames it into place, so this should not happen; try again next tick
    }
    spec.id = spec.id || basename(name, '.json');
    const dir = join(cfg.jobsDir, spec.id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'job.json'), spec);
    rmSync(p, { force: true });
    ingest(spec, dir);
  }
}

/** After a restart: every job without a result goes back into the queue and starts over. */
function recover() {
  let names = [];
  try {
    names = readdirSync(cfg.jobsDir).sort();
  } catch {
    return;
  }
  for (const id of names) {
    const dir = join(cfg.jobsDir, id);
    if (existsSync(join(dir, 'result.json')) || !existsSync(join(dir, 'job.json'))) continue;
    try {
      const spec = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
      rmSync(join(dir, 'logs'), { recursive: true, force: true });
      rmSync(join(dir, 'raw'), { recursive: true, force: true });
      ingest(spec, dir);
      log(`job ${id} re-queued after a runner restart`);
    } catch (e) {
      log(`job ${id} could not be recovered: ${e.message}`);
    }
  }
}

// ---- Status files -------------------------------------------------------------------------------------------------
function saveStatus(job, state) {
  const done = job.items.filter((i) => i.status === 'done').length;
  const st = state ?? (job.startedAt ? 'running' : 'queued');
  try {
    writeJson(join(job.dir, 'status.json'), {
      state: st,
      submittedAt: job.submittedAt,
      startedAt: job.startedAt,
      prep: job.prep,
      done,
      total: job.items.length,
      running: job.items.filter((i) => i.status === 'running').map((i) => i.file),
      files: Object.fromEntries(job.items.map((i) => [i.file, i.result?.status ?? i.status])),
    });
  } catch (e) {
    log(`status write failed for ${job.id}: ${e.message}`);
  }
}

function finishJobIfDone(job) {
  if (job.finished) return;
  if (job.prep === 'running' || job.prep === 'pending') return;
  if (!job.items.every((i) => i.status === 'done')) return;
  job.finished = true;
  const files = job.items.map((i) => i.result);
  const totals = { pass: files.reduce((s, f) => s + f.pass, 0), fail: files.reduce((s, f) => s + f.fail, 0) };
  const finishedAt = new Date();
  const started = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.submittedAt);
  const ok = files.every((f) => f.status === 'passed') && job.prep !== 'failed';
  const result = {
    id: job.id,
    who: job.who,
    ok,
    state: ok ? 'done' : 'failed',
    suite: job.suite,
    worktree: job.worktree,
    worktreeName: basename(job.worktree),
    priority: job.priority,
    pack: job.wantPack,
    submittedAt: job.submittedAt,
    startedAt: job.startedAt,
    finishedAt: finishedAt.toISOString(),
    waitedSeconds: Math.max(0, Math.round((started - Date.parse(job.submittedAt)) / 1000)),
    wallSeconds: Math.max(0, Math.round((finishedAt.getTime() - started) / 1000)),
    parallel: cfg.parallel,
    prep: job.prepResult,
    totals,
    files,
  };
  writeJson(join(job.dir, 'result.json'), result);
  writeFileSync(join(job.dir, 'summary.txt'), buildSummary(result, join(job.dir, 'result.json')));
  saveStatus(job, ok ? 'done' : 'failed');
  log(`job ${job.id} finished: ${ok ? 'PASS' : 'FAIL'} in ${result.wallSeconds}s`);
  jobs.splice(jobs.indexOf(job), 1);
}

// ---- Prep: pack and fixtures --------------------------------------------------------------------------------------
async function runPrep(worktree, jobIds, pack) {
  const group = jobs.filter((j) => jobIds.includes(j.id));
  const lead = group[0];
  const now = Date.now();
  for (const j of group) {
    j.prep = 'running';
    j.prepStartedAt = now;
    j.prepPack = pack;
    j.startedAt ??= new Date().toISOString();
    saveStatus(j);
  }
  const handle = { kill: () => {}, timedOut: false };
  prepHandles.set(worktree, handle);
  const result = { pack: null, fixtures: null };
  let ok = true;
  try {
    if (pack) {
      const logPath = join(lead.logsDir, 'pack.log');
      const t0 = Date.now();
      const comspec = process.env.ComSpec || 'cmd.exe';
      const p = process.platform === 'win32' ? run({ command: comspec, args: ['/d', '/s', '/c', 'npm run desktop:pack'], cwd: worktree, env: process.env, logPath }) : run({ command: 'npm', args: ['run', 'desktop:pack'], cwd: worktree, env: process.env, logPath });
      handle.kill = p.kill;
      const exit = await p.done;
      const exe = join(worktree, 'release', 'win-unpacked', 'PDF Suite.exe');
      const packOk = exit.code === 0 && !handle.timedOut && (process.platform !== 'win32' || existsSync(exe));
      result.pack = { ok: packOk, seconds: Math.round((Date.now() - t0) / 1000), log: logPath, exitCode: exit.code, timedOut: handle.timedOut };
      ok = packOk;
    }
    // Fixture generators: the common one, plus the ones files name in the manifest ("fixtures": [...]).
    const generators = ['tests/fixtures/make-fixtures.mjs', ...new Set(group.flatMap((j) => j.extraFixtures))];
    for (const rel of generators) {
      const fx = join(worktree, rel);
      if (!ok || !existsSync(fx)) continue;
      const logPath = join(lead.logsDir, 'fixtures.log');
      const p = run({ command: process.execPath, args: [fx], cwd: worktree, env: process.env, logPath });
      handle.kill = p.kill;
      const exit = await p.done;
      result.fixtures = { ok: exit.code === 0 && (result.fixtures?.ok ?? true), log: logPath };
      ok = exit.code === 0;
    }
  } catch (e) {
    ok = false;
    result.error = String(e.message ?? e);
  }
  prepHandles.delete(worktree);
  for (const j of group) {
    j.prepResult = { pack: pack ? result.pack : j.wantPack ? result.pack : null, fixtures: result.fixtures };
    j.prep = ok ? 'done' : 'failed';
    j.prepPack = false;
    if (!ok) {
      for (const item of j.items) {
        item.status = 'done';
        item.result = { file: item.file, class: item.cls, status: 'skipped', pass: 0, fail: 0, skipped: 0, durationSec: 0, log: null, failures: [], note: 'not run: pack or fixtures failed' };
      }
    }
    saveStatus(j);
    finishJobIfDone(j);
  }
  log(`prep ${basename(worktree)} ${ok ? 'ok' : 'FAILED'} (pack ${pack ? 'yes' : 'no'}) for ${jobIds.join(', ')}`);
  kick();
}

// ---- Files --------------------------------------------------------------------------------------------------------
function commandFor(job, item, resultFile) {
  const worktree = job.worktree;
  if (item.runner === 'vitest') {
    return { command: process.execPath, args: [join(worktree, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${resultFile}`, ...item.args] };
  }
  if (item.runner === 'script') return { command: process.execPath, args: [item.file, ...item.args] };
  return {
    command: process.execPath,
    args: ['--test', '--test-concurrency=1', '--test-timeout=600000', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${pathToFileURL(reporterPath).href}`, `--test-reporter-destination=${resultFile}`, item.file, ...item.args],
  };
}

async function runItem(job, item) {
  item.status = 'running';
  item.startedAt = Date.now();
  job.startedAt ??= new Date().toISOString();
  const key = `${job.id}\0${item.file}`;
  const handle = { kill: () => {}, timedOut: false };
  itemHandles.set(key, handle);
  saveStatus(job);
  const tmpDir = join(cfg.tmpRoot, `f${++fileCounter}`);
  mkdirSync(tmpDir, { recursive: true });
  const base = `${String(job.items.indexOf(item) + 1).padStart(2, '0')}-${slug(item.file)}`;
  const logPath = join(job.logsDir, `${base}.log`);
  const resultFile = join(job.rawDir, `${base}.jsonl`);
  const { command, args } = commandFor(job, item, resultFile);
  log(`start ${job.id} ${item.file} (${item.cls})`);
  let exit;
  try {
    const p = run({ command, args, cwd: job.worktree, env: { ...process.env, TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir, PDFSUITE_TESTQ: '1' }, logPath });
    handle.kill = p.kill;
    exit = await p.done;
  } catch (e) {
    exit = { code: null, error: String(e.message ?? e) };
  }
  // Leftovers of this file only: anything whose command line points into its own temp folder.
  try {
    await killByCommandLine(tmpDir + sep, cfg.tmpRoot);
  } catch (e) {
    log(`cleanup scan failed: ${e.message}`);
  }
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
  const parsed = parseFileResult({ runner: item.runner, resultFile, logFile: logPath, exit, timedOut: handle.timedOut });
  if (exit.error) parsed.failures.unshift({ name: '(could not start)', error: [exit.error] });
  item.result = {
    file: item.file,
    class: item.cls,
    status: parsed.status,
    pass: parsed.pass,
    fail: parsed.fail,
    skipped: parsed.skipped,
    durationSec: Math.round((Date.now() - item.startedAt) / 100) / 10,
    expectedMinutes: item.minutes,
    limitMinutes: Math.round(item.limitMs / 600) / 100,
    exitCode: exit.code,
    log: logPath,
    failures: parsed.failures.slice(0, 20),
  };
  item.status = 'done';
  itemHandles.delete(key);
  log(`end ${job.id} ${item.file}: ${parsed.status} (${item.result.pass} pass, ${item.result.fail} fail, ${item.result.durationSec}s)`);
  saveStatus(job);
  finishJobIfDone(job);
  kick();
}

// ---- Scheduling loop ----------------------------------------------------------------------------------------------
function lockState() {
  if (holdsLock) return 'ours';
  return lock.holder(cfg.lockPath) ? 'other' : 'free';
}

/** Cached answer; while it is stale the check runs in the background and the answer is "busy" (the safe side). */
function foreignBusy() {
  if (Date.now() - foreignCache.at < 3000) return foreignCache.value;
  if (!foreignCache.pending) {
    foreignCache.pending = true;
    foreignAppBusy(cfg.foreignNeedle, cfg.tmpRoot)
      .catch((e) => {
        log(`foreign check failed: ${e.message}`);
        return false;
      })
      .then((value) => {
        foreignCache = { at: Date.now(), value, pending: false };
        kick();
      });
  }
  return true;
}

function tick() {
  if (busy) return;
  busy = true;
  try {
    scanInbox();
    for (let round = 0; round < 20; round++) {
      const state = { now: Date.now(), parallel: cfg.parallel, packLimit: cfg.packLimit, lock: lockState(), foreignBusy, jobs, lockAll: cfg.lockAll, cooldown: Date.now() - lastLockRelease < cfg.lockCooldownSec * 1000 && lastLockRelease > 0 };
      let actions = plan(state);
      if (stopping) actions = actions.filter((a) => a.type === 'release-lock');
      let changed = false;
      for (const a of actions) {
        if (a.type === 'acquire-lock') {
          if (lock.tryAcquire(cfg.lockPath, lockOwner)) {
            holdsLock = true;
            changed = true;
            log('machine lock taken');
          }
        } else if (a.type === 'release-lock') {
          if (holdsLock) {
            lock.release(cfg.lockPath, lockOwner);
            holdsLock = false;
            lastLockRelease = Date.now();
            changed = true;
            log('machine lock released');
          }
        } else if (a.type === 'prep') {
          const group = jobs.filter((j) => a.jobIds.includes(j.id));
          for (const j of group) j.prep = 'running'; // so the next planning round sees it
          runPrep(a.worktree, a.jobIds, a.pack);
          changed = true;
        } else if (a.type === 'start') {
          const job = jobs.find((j) => j.id === a.jobId);
          const item = job?.items.find((i) => i.id === a.itemId);
          if (item && item.status === 'pending') {
            item.status = 'running'; // so the next planning round sees it
            runItem(job, item).catch((e) => {
              log(`runItem crashed for ${job.id} ${item.file}: ${e.stack ?? e}`);
              item.result ??= { file: item.file, class: item.cls, status: 'failed', pass: 0, fail: 1, skipped: 0, durationSec: 0, log: null, failures: [{ name: '(runner error)', error: [String(e.message ?? e)] }] };
              item.status = 'done';
              itemHandles.delete(`${job.id}\0${item.file}`);
              finishJobIfDone(job);
              kick();
            });
            changed = true;
          }
        } else if (a.type === 'kill') {
          const h = itemHandles.get(`${a.jobId}\0${a.itemId}`);
          if (h && !h.timedOut) {
            h.timedOut = true;
            log(`time limit reached: ${a.jobId} ${a.itemId}; stopping its processes`);
            h.kill();
          }
        } else if (a.type === 'kill-prep') {
          const h = prepHandles.get(a.worktree);
          if (h && !h.timedOut) {
            h.timedOut = true;
            log(`time limit reached for prep of ${a.worktree}`);
            h.kill();
          }
        }
      }
      if (!changed) break;
    }
    beat();
  } catch (e) {
    log(`tick error: ${e.stack ?? e}`);
  } finally {
    busy = false;
  }
}

let kickTimer = null;
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    tick();
  }, 50);
}

function beat() {
  const now = Date.now();
  if (now - lastBeat < 3000) return;
  lastBeat = now;
  try {
    writeJson(cfg.heartbeatFile, {
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      beat: new Date(now).toISOString(),
      parallel: cfg.parallel,
      lock: holdsLock ? 'ours' : lock.holder(cfg.lockPath) ?? 'free',
      queued: jobs.map((j) => ({ id: j.id, priority: j.priority, prep: j.prep, done: j.items.filter((i) => i.status === 'done').length, total: j.items.length })),
      running: jobs.flatMap((j) => j.items.filter((i) => i.status === 'running').map((i) => `${j.id}: ${i.file}`)),
    });
  } catch {
    // the next beat will do
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${reason}); ending ${itemHandles.size} running file(s) and ${prepHandles.size} prep(s)`);
  for (const h of itemHandles.values()) h.kill();
  for (const h of prepHandles.values()) h.kill();
  await sleep(1500);
  try {
    await killByCommandLine(cfg.tmpRoot + sep, cfg.tmpRoot);
  } catch {
    // best effort
  }
  if (holdsLock) lock.release(cfg.lockPath, lockOwner);
  rmSync(cfg.stopFile, { force: true });
  rmSync(cfg.pidFile, { force: true });
  try {
    writeJson(cfg.heartbeatFile, { pid: process.pid, beat: new Date(0).toISOString(), stopped: true });
  } catch {
    // ignore
  }
  log('stopped');
  process.exit(0);
}

// ---- Main ---------------------------------------------------------------------------------------------------------
const other = otherRunnerAlive();
if (other) {
  console.error(`another test runner is already running (pid ${other})`);
  process.exit(1);
}
writeFileSync(cfg.pidFile, String(process.pid));
log(`runner started pid ${process.pid}; queue ${cfg.dir}; parallel ${cfg.parallel}; lock ${cfg.lockPath}`);
beat();
// Orphans of an earlier crashed runner: only processes under this queue's own temp root.
try {
  await killByCommandLine(cfg.tmpRoot + sep, cfg.tmpRoot);
  for (const n of readdirSync(cfg.tmpRoot)) rmSync(join(cfg.tmpRoot, n), { recursive: true, force: true });
} catch (e) {
  log(`startup cleanup: ${e.message}`);
}
recover();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack ?? e}`));
setInterval(() => {
  if (existsSync(cfg.stopFile)) shutdown('stop requested');
  else tick();
}, cfg.pollMs);
tick();
