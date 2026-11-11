// Waits in the foreground for a queued job, then prints its summary.
//   node scripts/testq/wait.mjs <id> [--max-seconds 540]
// Exit code: 0 the job finished and everything passed; 1 it finished with failures or timeouts (or the job is unknown,
// or the runner is not running); 2 it is still running (call again).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';

const args = process.argv.slice(2);
let id = null;
let maxSeconds = 540;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-seconds') maxSeconds = Number(args[++i]);
  else if (args[i].startsWith('--max-seconds=')) maxSeconds = Number(args[i].split('=')[1]);
  else id = args[i];
}
if (!id || !Number.isFinite(maxSeconds)) {
  console.error('usage: node scripts/testq/wait.mjs <id> [--max-seconds 540]');
  process.exit(1);
}

const cfg = loadConfig();
const jobDir = join(cfg.jobsDir, id);
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runnerAlive = () => {
  const hb = readJson(cfg.heartbeatFile);
  if (hb && !hb.stopped && Date.now() - Date.parse(hb.beat) < 60_000) return true;
  // Just started (no heartbeat yet): the PID file names a live process.
  try {
    const pid = Number.parseInt(readFileSync(cfg.pidFile, 'utf8'), 10);
    if (!hb && pid) {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    // not running
  }
  return false;
};

const deadline = Date.now() + maxSeconds * 1000;
let lastLine = '';
for (;;) {
  const resultPath = join(jobDir, 'result.json');
  if (existsSync(resultPath)) {
    const result = readJson(resultPath);
    const summary = join(jobDir, 'summary.txt');
    process.stdout.write(existsSync(summary) ? readFileSync(summary, 'utf8') : `job ${id}: ${result?.ok ? 'PASS' : 'FAIL'}\n`);
    process.exit(result?.ok ? 0 : 1);
  }
  const queued = existsSync(join(cfg.inbox, `${id}.json`));
  if (!queued && !existsSync(jobDir)) {
    console.error(`wait: unknown job ${id} (queue folder ${cfg.dir})`);
    process.exit(1);
  }
  if (!runnerAlive()) {
    console.error(`wait: the runner is not running, job ${id} will not progress. Start it with scripts/testq/start.ps1`);
    process.exit(1);
  }
  const st = readJson(join(jobDir, 'status.json'));
  lastLine = queued || !st ? `job ${id}: queued, waiting for the runner to pick it up` : `job ${id}: ${st.state}, prep ${st.prep}, ${st.done}/${st.total} files finished${st.running?.length ? `, running now: ${st.running.join(', ')}` : ''}`;
  if (Date.now() >= deadline) {
    console.log(`${lastLine}\nstill running: call wait.mjs ${id} again`);
    process.exit(2);
  }
  await sleep(Math.min(2000, Math.max(100, deadline - Date.now())));
}
