// Settings of the test queue, all from environment variables with neutral defaults.
import { join } from 'node:path';

export function queueDir(env = process.env) {
  if (env.PDFSUITE_TESTQ_DIR) return env.PDFSUITE_TESTQ_DIR;
  const base = env.LOCALAPPDATA ?? env.XDG_STATE_HOME ?? join(env.HOME ?? env.USERPROFILE ?? '.', '.local', 'state');
  return join(base, 'pdfsuite-testq');
}

export function loadConfig(env = process.env) {
  const dir = queueDir(env);
  const int = (name, def) => {
    const n = Number.parseInt(env[name] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const num = (name, def) => {
    const n = Number.parseFloat(env[name] ?? '');
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    dir,
    inbox: join(dir, 'inbox'),
    jobsDir: join(dir, 'jobs'),
    tmpRoot: join(dir, 't'), // short on purpose: Chromium profiles live below it
    pidFile: join(dir, 'runner.pid'),
    heartbeatFile: join(dir, 'runner.json'),
    stopFile: join(dir, 'stop'),
    runnerLog: join(dir, 'runner.log'),
    /** The shared machine lock that agents without the queue still use. */
    lockPath: env.PDFSUITE_APP_LOCK || join(dir, 'app.lock'),
    parallel: int('PDFSUITE_TESTQ_PARALLEL', 3),
    packLimit: int('PDFSUITE_TESTQ_PACKS', 1),
    pollMs: int('PDFSUITE_TESTQ_POLL_MS', 1000),
    /** Per-file time limit = manifest minutes x factor, at least floor minutes. */
    limitFactor: num('PDFSUITE_TESTQ_LIMIT_FACTOR', 3),
    limitFloorMinutes: num('PDFSUITE_TESTQ_LIMIT_FLOOR_MIN', 2),
    prepLimitMinutes: int('PDFSUITE_TESTQ_PACK_LIMIT_MIN', 25),
    /** The runner owns the old lock for all its work (default). 0: only exclusive files take the lock. */
    lockAll: env.PDFSUITE_TESTQ_LOCK_ALL !== '0',
    /** Seconds to wait after giving the lock back before taking it again for new work (lets waiting agents in). */
    lockCooldownSec: num('PDFSUITE_TESTQ_LOCK_COOLDOWN_SEC', 15),
    /** A foreign PDF Suite process is recognised by this text in its path or command line (case-insensitive). */
    foreignNeedle: (env.PDFSUITE_TESTQ_FOREIGN_NEEDLE || 'pdf-suite').toLowerCase(),
  };
}
