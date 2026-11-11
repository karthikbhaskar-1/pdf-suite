// The old machine lock: a directory made with mkdir (atomic), with an `owner` file. Agents that do not use the queue yet
// still take it before every app run, so the runner holds it while an exclusive file runs.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function tryAcquire(lockPath, owner) {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeFileSync(join(lockPath, 'owner'), `${owner}\n`);
  } catch {
    // the directory itself is the lock
  }
  return true;
}

/**
 * Removes the lock only when its owner file holds exactly `owner` (what tryAcquire wrote). A lock that belongs to
 * somebody else is never removed, however old it looks. Returns true when it was removed.
 */
export function release(lockPath, owner) {
  if (holder(lockPath) !== String(owner).trim()) return false;
  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

export function holder(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    return readFileSync(join(lockPath, 'owner'), 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
