// @vitest-environment node
// The old machine lock: removed only by its owner.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { holder, release, tryAcquire } from '../../scripts/testq/lib/lock.mjs';

describe('testq lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'testq-lock-'));
  const lockPath = join(dir, 'app.lock');

  it('is taken once, and released only by its owner', () => {
    expect(tryAcquire(lockPath, 'runner a')).toBe(true);
    expect(tryAcquire(lockPath, 'runner b')).toBe(false);
    expect(holder(lockPath)).toBe('runner a');
    expect(release(lockPath, 'runner b')).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(release(lockPath, 'runner a')).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('never removes another agent lock, even one that took over after ours was lost', () => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner'), 'dev132\n');
    expect(release(lockPath, 'runner a')).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
