// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyFrames, classifySearch, machineWindow, SATURATED_CPU_PCT } from './frame-validity.mjs';

const quiet = { cpuMax: 45, busiest: { name: 'explorer', pct: 400 } };
const stormCpu = { cpuMax: 92, busiest: { name: 'explorer', pct: 3000 } };
const stormProc = { cpuMax: 50, busiest: { name: 'MsMpEng', pct: 1800 } };
const frame = { end: 3000, gap: 120 };
const loaf = (start, dur, scriptMs) => ({ start, dur, scriptMs });

describe('classifyFrames', () => {
  it('passes when there is no long frame, whatever the machine does', () => {
    expect(classifyFrames({ longFrames: [], loafs: [], machine: stormCpu }).verdict).toBe('pass');
  });
  it('fails at once on a long frame with app work, even on a saturated machine', () => {
    const r = classifyFrames({ longFrames: [frame], loafs: [loaf(2900, 110, 400)], machine: stormCpu });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/app work/);
    expect(classifyFrames({ longFrames: [frame], loafs: [loaf(2900, 110, 90)], machine: quiet }).reason).toMatch(/app work/);
  });
  it('only counts loaf entries that overlap the long frame', () => {
    const r = classifyFrames({ longFrames: [frame], loafs: [loaf(100, 400, 300)], machine: stormCpu });
    expect(r.verdict).toBe('invalid');
  });
  it('allows stretched script time (up to 300 ms) under saturation, but not above', () => {
    expect(classifyFrames({ longFrames: [frame], loafs: [loaf(2900, 110, 250)], machine: stormCpu }).verdict).toBe('invalid');
  });
  it('is invalid when little app work meets a saturated machine (CPU)', () => {
    expect(classifyFrames({ longFrames: [frame], loafs: [loaf(2900, 110, 10)], machine: stormCpu })).toMatchObject({ verdict: 'invalid', saturated: true });
  });
  it('is invalid when one outside process saturates the machine (process)', () => {
    expect(classifyFrames({ longFrames: [frame], loafs: [], machine: stormProc }).verdict).toBe('invalid');
  });
  it('fails when a long frame has no app work and the machine was quiet', () => {
    const r = classifyFrames({ longFrames: [frame], loafs: [], machine: quiet });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/unexplained/);
  });
  it('fails when there is no machine data', () => {
    expect(classifyFrames({ longFrames: [frame], loafs: [], machine: null }).verdict).toBe('fail');
  });
  it('uses the worst long frame: app work in any one of them fails the run', () => {
    const r = classifyFrames({ longFrames: [frame, { end: 5000, gap: 80 }], loafs: [loaf(4950, 80, 70)], machine: quiet });
    expect(r.verdict).toBe('fail');
  });
});

describe('machineWindow', () => {
  const s = (t, cpu, procs) => ({ t, cpu, procs: new Map(Object.entries(procs)) });
  it('takes the CPU peak and the busiest outside process, ignoring the app and idle', () => {
    const w = machineWindow(10000, 12000, [s(9500, 30, { explorer: 100 }), s(10500, 60, { explorer: 700, 'PDF Suite': 900, Idle: 9000 }), s(11500, 55, { node: 300 }), s(20000, 99, { x: 9999 })]);
    expect(w).toMatchObject({ cpuMax: 60, busiest: { name: 'explorer', pct: 700 }, samples: 3 });
  });
  it('returns null with no samples in the window', () => {
    expect(machineWindow(1, 2, [])).toBeNull();
  });
});

describe('classifySearch (search-time windows)', () => {
  const busy = (cpuMax) => ({ cpuMax, busiest: { name: 'MsMpEng', pct: 349 } });
  it('passes when every limit holds, on any machine', () => {
    expect(classifySearch({ ok: true, machine: busy(100) }).verdict).toBe('pass');
    expect(classifySearch({ ok: true, machine: null }).verdict).toBe('pass');
  });
  it('is invalid (repeat), not failed, when a limit is exceeded while total CPU peaked at 75 % or more', () => {
    expect(SATURATED_CPU_PCT).toBe(75);
    expect(classifySearch({ ok: false, machine: busy(75) })).toMatchObject({ verdict: 'invalid', saturated: true });
    expect(classifySearch({ ok: false, machine: busy(100) }).verdict).toBe('invalid');
  });
  it('fails when a limit is exceeded on a quiet machine (the 16 measured runs: quiet peaks were 24 to 39 %)', () => {
    expect(classifySearch({ ok: false, machine: busy(74) }).verdict).toBe('fail');
    expect(classifySearch({ ok: false, machine: busy(39) }).verdict).toBe('fail');
  });
  it('fails when a limit is exceeded and there is no machine data', () => {
    expect(classifySearch({ ok: false, machine: null }).verdict).toBe('fail');
    expect(classifySearch({ ok: false, machine: { cpuMax: null, busiest: null } }).verdict).toBe('fail');
  });
});
