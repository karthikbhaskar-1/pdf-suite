import { describe, expect, it } from 'vitest';
import { CrashLoopGuard, CRASH_LOOP_NOTICE } from './crashLoop';

describe('CrashLoopGuard (1.5.1 M5)', () => {
  it('the first crash reloads as usual; the second within 60 s trips the guard', () => {
    const guard = new CrashLoopGuard();
    expect(guard.recordCrash(0)).toBe(true);
    expect(guard.tripped(0)).toBe(false);
    expect(guard.recordCrash(30_000)).toBe(false);
    expect(guard.tripped(30_000)).toBe(true);
  });

  it('two crashes more than 60 s apart do not trip it', () => {
    const guard = new CrashLoopGuard();
    expect(guard.recordCrash(0)).toBe(true);
    expect(guard.recordCrash(60_001)).toBe(true);
    expect(guard.tripped(60_001)).toBe(false);
    expect(guard.recordCrash(100_000)).toBe(false);
  });

  it('reset forgets the crashes', () => {
    const guard = new CrashLoopGuard();
    guard.recordCrash(0);
    guard.recordCrash(1);
    guard.reset();
    expect(guard.tripped(2)).toBe(false);
    expect(guard.recordCrash(3)).toBe(true);
  });

  it('the notice says the edits are kept', () => {
    expect(CRASH_LOOP_NOTICE).toMatch(/unsaved edits are kept/);
  });
});
