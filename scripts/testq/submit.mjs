// Puts a test job into the queue and prints its id (only the id goes to stdout).
//   node scripts/testq/submit.mjs --worktree <path> --suite core --pack --who dev132 [--files a,b] [--priority ticket]
// Suites: unit, core (all functional e2e), heavy (all exclusive), full. --files adds explicit files (relative to the worktree).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { SUITES } from './lib/manifest.mjs';
import { decide } from './lib/repeat-guard.mjs';

const args = process.argv.slice(2);
const opts = { pack: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--pack') opts.pack = true;
  else if (a.startsWith('--') && a.includes('=')) opts[a.slice(2, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
  else if (a.startsWith('--')) opts[a.slice(2)] = args[++i];
  else fail(`unexpected argument ${a}`);
}

function fail(msg) {
  console.error(`submit: ${msg}`);
  console.error('usage: node scripts/testq/submit.mjs --worktree <path> --suite unit|core|heavy|full [--files a,b] [--pack] --who <name> [--priority ticket|measure] [--force "<reason>"]');
  process.exit(1);
}

const cfg = loadConfig();
if (!opts.worktree) fail('--worktree is required');
const worktree = resolve(opts.worktree);
if (!existsSync(join(worktree, 'package.json'))) fail(`not a PDF Suite folder: ${worktree}`);
if (!opts.suite && !opts.files) fail('give --suite or --files');
if (opts.suite && !SUITES.includes(opts.suite)) fail(`unknown suite "${opts.suite}"`);
const priority = opts.priority ?? 'measure';
if (priority !== 'ticket' && priority !== 'measure') fail('--priority is ticket or measure');
const who = String(opts.who ?? 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24) || 'unknown';

const git = (...a) => execFileSync('git', ['-C', worktree, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
let commit = null;
let dirty = null;
try {
  commit = git('rev-parse', 'HEAD').trim();
  dirty = git('status', '--porcelain', '--untracked-files=no').trim().length > 0;
} catch { /* not a git folder: recorded as null, the guard then allows */ }

// Repeat guard: no second core/heavy/full run on code that already passed (docs/ORCHESTRATION-RULES.md section 5).
if (opts.suite && opts.suite !== 'unit' && !opts.files && !opts.force && commit) {
  const covers = { core: ['core', 'full'], heavy: ['heavy', 'full'] };
  const lastPass = { core: null, heavy: null };
  const changedPaths = { core: null, heavy: null };
  let ids = [];
  try { ids = readdirSync(cfg.jobsDir).sort().reverse(); } catch { /* no jobs yet */ }
  for (const half of ['core', 'heavy']) {
    if (opts.suite !== half && opts.suite !== 'full') continue;
    for (const jid of ids) {
      try {
        const jd = join(cfg.jobsDir, jid);
        const res = JSON.parse(readFileSync(join(jd, 'result.json'), 'utf8'));
        const spec0 = JSON.parse(readFileSync(join(jd, 'job.json'), 'utf8'));
        if (res.ok !== true || !spec0.commit || spec0.dirty !== false || !covers[half].includes(spec0.suite)) continue;
        try { git('merge-base', '--is-ancestor', spec0.commit, 'HEAD'); } catch { continue; }
        lastPass[half] = { id: jid };
        changedPaths[half] = git('diff', '--name-only', spec0.commit).split('\n').map((l) => l.trim()).filter(Boolean);
        break;
      } catch { /* unreadable job: skip */ }
    }
  }
  const verdict = decide({ suite: opts.suite, lastPass, changedPaths });
  if (!verdict.allow) {
    console.error(`submit: refused: ${verdict.reason}`);
    console.error('submit: to run it anyway: --force "<reason>"');
    process.exit(3);
  }
}

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const id = `${stamp}-${who}-${Math.random().toString(36).slice(2, 6)}`;
const spec = {
  id,
  worktree,
  suite: opts.suite ?? null,
  files: opts.files ? String(opts.files).split(',').map((s) => s.trim()).filter(Boolean) : [],
  pack: Boolean(opts.pack),
  who,
  priority,
  commit,
  dirty,
  force: opts.force ? String(opts.force) : null,
  submittedAt: d.toISOString(),
};

mkdirSync(cfg.inbox, { recursive: true });
const tmp = join(cfg.inbox, `${id}.tmp`);
writeFileSync(tmp, JSON.stringify(spec, null, 2));
renameSync(tmp, join(cfg.inbox, `${id}.json`)); // the runner only reads *.json, so it never sees a half-written job

try {
  const hb = JSON.parse(readFileSync(cfg.heartbeatFile, 'utf8'));
  if (hb.stopped || Date.now() - Date.parse(hb.beat) > 30_000) console.error('submit: warning: the runner does not look alive (start it with scripts/testq/start.ps1)');
} catch {
  if (!existsSync(cfg.pidFile)) console.error('submit: warning: no runner found (start it with scripts/testq/start.ps1)');
}
console.log(id);
