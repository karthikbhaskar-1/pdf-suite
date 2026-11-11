// @vitest-environment node
// Scheduler of the unattended test queue (scripts/testq). Fake jobs and a fake clock: nothing is started.
import { describe, expect, it } from 'vitest';
import { limitMsFor, plan } from '../../scripts/testq/lib/scheduler.mjs';

const MIN = 60_000;

/** A job with files given as 'name:class:minutes'. */
function job(id, { priority = 'ticket', seq, worktree = 'W1', pack = false, files }) {
  return {
    id,
    priority,
    seq,
    worktree,
    wantPack: pack,
    prep: 'pending',
    items: files.map((spec) => {
      const [name, cls = 'functional', minutes = '1'] = spec.split(':');
      return { id: name, cls: cls === 'x' ? 'exclusive' : 'functional', status: 'pending', minutes: Number(minutes), limitMs: Number(minutes) * 3 * MIN };
    }),
  };
}

/**
 * Runs the scheduler against a fake world until every job is finished. Item and prep durations come from the files'
 * minutes (prep: prepMinutes). Returns the event log and the peak numbers.
 */
function simulate(jobs, { parallel = 3, packLimit = 1, prepMinutes = 3, foreign = () => false, lock = 'free', hang = new Set() } = {}) {
  let now = 0;
  let lockState = lock; // 'free' | 'ours' | 'other'
  const log = [];
  const finishAt = new Map(); // `${jobId}/${itemId}` -> time
  const prepFinishAt = new Map(); // worktree -> time
  const prepJobs = new Map(); // worktree -> job ids
  let peakFunctional = 0;
  let peakExclusiveOverlap = 0;
  const packs = [];
  const state = { parallel, packLimit, jobs };
  const killed = new Set();

  const runningCount = () => jobs.flatMap((j) => j.items).filter((i) => i.status === 'running').length;
  for (let guard = 0; guard < 10_000; guard++) {
    // Settle: apply actions until none start anything.
    for (let inner = 0; inner < 50; inner++) {
      const actions = plan({ ...state, now, lock: lockState, foreignBusy: foreign });
      let changed = false;
      for (const a of actions) {
        if (a.type === 'acquire-lock') {
          lockState = 'ours';
          log.push({ t: now, e: 'lock' });
          changed = true;
        } else if (a.type === 'release-lock') {
          lockState = 'free';
          log.push({ t: now, e: 'unlock' });
          changed = true;
        } else if (a.type === 'prep') {
          for (const id of a.jobIds) {
            const j = jobs.find((x) => x.id === id);
            j.prep = 'running';
            j.prepStartedAt = now;
            j.prepPack = a.pack;
          }
          prepJobs.set(a.worktree, a.jobIds);
          prepFinishAt.set(a.worktree, now + prepMinutes * MIN);
          if (a.pack) packs.push({ worktree: a.worktree, jobs: a.jobIds, t: now });
          log.push({ t: now, e: 'prep', worktree: a.worktree, pack: a.pack, jobs: a.jobIds });
          changed = true;
        } else if (a.type === 'start') {
          const j = jobs.find((x) => x.id === a.jobId);
          const item = j.items.find((x) => x.id === a.itemId);
          item.status = 'running';
          item.startedAt = now;
          finishAt.set(`${j.id}/${item.id}`, hang.has(item.id) ? Infinity : now + item.minutes * MIN);
          log.push({ t: now, e: 'start', job: j.id, item: item.id, cls: item.cls });
          const all = jobs.flatMap((x) => x.items).filter((i) => i.status === 'running');
          peakFunctional = Math.max(peakFunctional, all.filter((i) => i.cls === 'functional').length);
          if (item.cls === 'exclusive') peakExclusiveOverlap = Math.max(peakExclusiveOverlap, all.length - 1 + prepFinishAt.size * 0);
          changed = true;
        } else if (a.type === 'kill') {
          const j = jobs.find((x) => x.id === a.jobId);
          const item = j.items.find((x) => x.id === a.itemId);
          if (!killed.has(`${j.id}/${item.id}`)) {
            killed.add(`${j.id}/${item.id}`);
            finishAt.set(`${j.id}/${item.id}`, now);
            item.timedOut = true;
            log.push({ t: now, e: 'timeout', job: j.id, item: item.id });
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    // Is any prep running while a file runs? (must never happen on the same worktree)
    for (const [w] of prepFinishAt) {
      const filesOnWorktree = jobs.filter((j) => j.worktree === w).flatMap((j) => j.items).filter((i) => i.status === 'running');
      if (filesOnWorktree.length) log.push({ t: now, e: 'VIOLATION prep overlaps files', worktree: w });
    }
    // Advance the clock to the next finish.
    const times = [...finishAt.entries()].filter(([k]) => {
      const [jid, iid] = k.split('/');
      return jobs.find((j) => j.id === jid).items.find((i) => i.id === iid).status === 'running';
    }).map(([, t]) => t);
    times.push(...prepFinishAt.values());
    // A hanging item is only released by its timeout.
    for (const j of jobs) for (const i of j.items) if (i.status === 'running' && i.limitMs) times.push(i.startedAt + i.limitMs + 1);
    const next = Math.min(...times.filter((t) => Number.isFinite(t) && t >= now));
    if (!Number.isFinite(next)) break;
    now = next;
    for (const [k, t] of [...finishAt.entries()]) {
      if (t <= now) {
        const [jid, iid] = k.split('/');
        const item = jobs.find((j) => j.id === jid).items.find((i) => i.id === iid);
        if (item.status === 'running') {
          item.status = 'done';
          log.push({ t: now, e: 'end', job: jid, item: iid });
        }
        finishAt.delete(k);
      }
    }
    for (const [w, t] of [...prepFinishAt.entries()]) {
      if (t <= now) {
        for (const id of prepJobs.get(w)) {
          const j = jobs.find((x) => x.id === id);
          j.prep = 'done';
          j.prepPack = false;
        }
        prepFinishAt.delete(w);
        log.push({ t: now, e: 'prep-done', worktree: w });
      }
    }
    if (jobs.every((j) => j.items.every((i) => i.status === 'done')) && lockState !== 'ours') break;
    if (jobs.every((j) => j.items.every((i) => i.status === 'done'))) {
      // one last settle so the lock is released
      const a = plan({ ...state, now, lock: lockState, foreignBusy: foreign });
      if (a.some((x) => x.type === 'release-lock')) lockState = 'free';
      break;
    }
  }
  return { log, now, peakFunctional, packs, lockState, runningCount, peakExclusiveOverlap };
}

const starts = (r) => r.log.filter((e) => e.e === 'start');

describe('functional files run side by side', () => {
  it('never exceeds the parallel limit and uses all of it', () => {
    const files = Array.from({ length: 9 }, (_, i) => `f${i}`);
    const r = simulate([job('A', { seq: 1, files })], { parallel: 3 });
    expect(r.peakFunctional).toBe(3);
    // 9 one-minute files, 3 at a time, after a 3-minute prep: 3 + 3 minutes.
    expect(r.now).toBe(6 * MIN);
    expect(r.log.some((e) => String(e.e).startsWith('VIOLATION'))).toBe(false);
  });

  it('shares the slots across jobs of different worktrees', () => {
    const a = job('A', { seq: 1, worktree: 'W1', files: ['a1', 'a2'] });
    const b = job('B', { seq: 2, worktree: 'W2', files: ['b1', 'b2'] });
    const r = simulate([a, b], { parallel: 3, packLimit: 2 });
    expect(r.peakFunctional).toBe(3);
  });

  it('parallel 1 is the old serial behaviour', () => {
    const r = simulate([job('A', { seq: 1, files: ['a', 'b', 'c'] })], { parallel: 1, prepMinutes: 0 });
    expect(r.peakFunctional).toBe(1);
    expect(r.now).toBe(3 * MIN);
  });
});

describe('exclusive files', () => {
  it('wait for the machine to be empty and then run alone, holding the lock', () => {
    const j = job('A', { seq: 1, files: ['f1:f:2', 'f2:f:2', 'x1:x:1', 'f3:f:1'] });
    const r = simulate([j], { parallel: 3, prepMinutes: 0 });
    const x1 = r.log.find((e) => e.e === 'start' && e.item === 'x1');
    // x1 may not start before f1 and f2 ended (t = 2 min), and f3 (ordered after it) waits for it.
    expect(x1.t).toBe(2 * MIN);
    const f3 = r.log.find((e) => e.e === 'start' && e.item === 'f3');
    expect(f3.t).toBe(3 * MIN);
    expect(r.log.findIndex((e) => e.e === 'lock')).toBeLessThan(r.log.findIndex((e) => e.e === 'start' && e.item === 'x1'));
    // Nothing starts while x1 runs.
    const during = r.log.filter((e) => e.e === 'start' && e.t > x1.t && e.t < x1.t + MIN);
    expect(during).toEqual([]);
    expect(r.lockState).toBe('free');
  });

  it('are not started while a foreign PDF Suite process is running', () => {
    const j = job('A', { seq: 1, files: ['x1:x:1'] });
    let calls = 0;
    const plans = [];
    const s = { parallel: 3, packLimit: 1, jobs: [j], now: 0, lock: 'ours', foreignBusy: () => (calls++, true) };
    j.prep = 'done';
    plans.push(plan(s));
    expect(plans[0].some((a) => a.type === 'start')).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it('wait while another agent holds the old lock, and ask for it only when the machine is empty', () => {
    const j = job('A', { seq: 1, files: ['f1:f:2', 'x1:x:1'] });
    j.prep = 'done';
    const base = { parallel: 3, packLimit: 1, jobs: [j], now: 0, foreignBusy: () => false };
    // f1 is still running: no lock request yet.
    j.items[0].status = 'running';
    j.items[0].startedAt = 0;
    expect(plan({ ...base, lock: 'free' })).toEqual([]);
    j.items[0].status = 'done';
    expect(plan({ ...base, lock: 'other' })).toEqual([]);
    expect(plan({ ...base, lock: 'free' })).toEqual([{ type: 'acquire-lock' }]);
    expect(plan({ ...base, lock: 'ours' })).toEqual([{ type: 'start', jobId: 'A', itemId: 'x1' }]);
  });

  it('give the lock back when nothing exclusive is left', () => {
    const j = job('A', { seq: 1, files: ['f1'] });
    j.prep = 'done';
    expect(plan({ parallel: 3, packLimit: 1, jobs: [j], now: 0, lock: 'ours', foreignBusy: () => false }).map((a) => a.type)).toEqual(['start', 'release-lock']);
  });

  it('keeps the lock between two exclusive files, and gives it back when something else is running', () => {
    const j = job('A', { seq: 1, files: ['x1:x:1', 'x2:x:1'] });
    j.prep = 'done';
    j.items[0].status = 'done';
    const base = { parallel: 3, packLimit: 1, jobs: [j], now: 0, lock: 'ours', foreignBusy: () => true };
    // x2 is waiting (foreign process still running): the lock stays ours, nothing is released and nothing starts.
    expect(plan(base)).toEqual([]);
    expect(plan({ ...base, foreignBusy: () => false })).toEqual([{ type: 'start', jobId: 'A', itemId: 'x2' }]);
  });

  it('is not starved by a stream of functional files queued behind it', () => {
    const a = job('A', { seq: 1, priority: 'measure', files: ['f1:f:3', 'x1:x:1'] });
    const b = job('B', { seq: 2, priority: 'measure', files: ['g1:f:1', 'g2:f:1', 'g3:f:1', 'g4:f:1'] });
    const r = simulate([a, b], { parallel: 3, prepMinutes: 0 });
    const x1 = r.log.find((e) => e.e === 'start' && e.item === 'x1');
    expect(x1.t).toBe(3 * MIN); // right after f1 and the two g files that were already running
    expect(r.log.filter((e) => e.e === 'start' && e.item.startsWith('g')).length).toBe(4);
  });
});

describe('priorities', () => {
  it('a ticket job goes before an earlier measure job', () => {
    const measure = job('M', { seq: 1, priority: 'measure', files: ['m1:f:1', 'm2:f:1', 'm3:f:1', 'm4:f:1'] });
    const ticket = job('T', { seq: 2, priority: 'ticket', worktree: 'W2', files: ['t1:f:1', 't2:f:1', 't3:f:1', 't4:f:1'] });
    const r = simulate([measure, ticket], { parallel: 2, prepMinutes: 0, packLimit: 2 });
    const order = starts(r).map((e) => e.item);
    expect(order.slice(0, 4).every((n) => n.startsWith('t'))).toBe(true);
  });

  it('an exclusive ticket file goes before functional measure files', () => {
    const measure = job('M', { seq: 1, priority: 'measure', files: ['m1:f:1', 'm2:f:1'] });
    const ticket = job('T', { seq: 2, priority: 'ticket', worktree: 'W2', files: ['tx:x:1'] });
    measure.prep = 'done';
    ticket.prep = 'done';
    const actions = plan({ parallel: 3, packLimit: 1, jobs: [measure, ticket], now: 0, lock: 'free', foreignBusy: () => false });
    expect(actions).toEqual([{ type: 'acquire-lock' }]); // the measure files wait behind the ticket's exclusive file
  });

  it('keeps submission order inside one priority', () => {
    const a = job('A', { seq: 1, priority: 'measure', files: ['a1:f:1'] });
    const b = job('B', { seq: 2, priority: 'measure', worktree: 'W2', files: ['b1:f:1'] });
    const r = simulate([b, a], { parallel: 1, prepMinutes: 0, packLimit: 2 });
    expect(starts(r).map((e) => e.item)).toEqual(['a1', 'b1']);
  });
});

describe('pack and fixtures', () => {
  it('packs once for several jobs of the same worktree', () => {
    const a = job('A', { seq: 1, pack: true, files: ['a1', 'a2'] });
    const b = job('B', { seq: 2, pack: true, files: ['b1', 'b2'] });
    const r = simulate([a, b], { parallel: 3 });
    expect(r.packs.length).toBe(1);
    expect(r.packs[0].jobs.sort()).toEqual(['A', 'B']);
  });

  it('packs two worktrees one after the other when the pack limit is 1, together when it is 2', () => {
    const mk = () => [
      job('A', { seq: 1, pack: true, worktree: 'W1', files: ['a1'] }),
      job('B', { seq: 2, pack: true, worktree: 'W2', files: ['b1'] }),
    ];
    const serial = simulate(mk(), { packLimit: 1, prepMinutes: 3 });
    expect(serial.log.filter((e) => e.e === 'prep').map((e) => e.t)).toEqual([0, 3 * MIN]);
    const both = simulate(mk(), { packLimit: 2, prepMinutes: 3 });
    expect(both.log.filter((e) => e.e === 'prep').map((e) => e.t)).toEqual([0, 0]);
  });

  it('never runs files of a worktree while it is being packed, and waits for them before packing again', () => {
    const a = job('A', { seq: 1, pack: false, files: ['a1:f:5'] });
    a.prep = 'done';
    const b = job('B', { seq: 2, pack: true, files: ['b1:f:1'] });
    const r = simulate([a, b], { parallel: 3, prepMinutes: 2 });
    const prep = r.log.find((e) => e.e === 'prep');
    const a1End = r.log.find((e) => e.e === 'end' && e.item === 'a1');
    expect(prep.t).toBeGreaterThanOrEqual(a1End.t);
    expect(r.log.some((e) => String(e.e).startsWith('VIOLATION'))).toBe(false);
  });

  it('a job without a pack still gets its fixtures prepared (prep with pack false)', () => {
    const r = simulate([job('A', { seq: 1, pack: false, files: ['a1'] })], { prepMinutes: 0 });
    expect(r.log.find((e) => e.e === 'prep').pack).toBe(false);
    expect(r.packs.length).toBe(0);
  });

  it('a failed prep removes the job from planning', () => {
    const a = job('A', { seq: 1, files: ['a1'] });
    a.prep = 'failed';
    expect(plan({ parallel: 3, packLimit: 1, jobs: [a], now: 0, lock: 'free', foreignBusy: () => false })).toEqual([]);
  });
});

describe('timeouts', () => {
  it('limit is the manifest minutes times 3, with a floor', () => {
    expect(limitMsFor(5)).toBe(15 * MIN);
    expect(limitMsFor(0.2)).toBe(2 * MIN);
    expect(limitMsFor(undefined)).toBe(15 * MIN);
  });

  it('kills a file that runs past its limit and carries on with the rest', () => {
    const j = job('A', { seq: 1, files: ['stuck:f:1', 'ok1:f:1', 'ok2:f:1'] });
    const r = simulate([j], { parallel: 1, prepMinutes: 0, hang: new Set(['stuck']) });
    const t = r.log.find((e) => e.e === 'timeout');
    expect(t.item).toBe('stuck');
    expect(t.t).toBeGreaterThanOrEqual(3 * MIN);
    expect(starts(r).map((e) => e.item)).toEqual(['stuck', 'ok1', 'ok2']);
  });

  it('asks to kill a running prep past its limit', () => {
    const j = job('A', { seq: 1, pack: true, files: ['a1'] });
    j.prep = 'running';
    j.prepPack = true;
    j.prepStartedAt = 0;
    j.prepLimitMs = 10 * MIN;
    expect(plan({ parallel: 3, packLimit: 1, jobs: [j], now: 11 * MIN, lock: 'free', foreignBusy: () => false })).toEqual([{ type: 'kill-prep', worktree: 'W1', reason: 'timeout' }]);
  });
});

describe('lock-for-all mode (the runner works only while it owns the old machine lock)', () => {
  const mk = () => {
    const j = job('A', { seq: 1, files: ['f1', 'f2', 'x1:x:1'] });
    j.prep = 'done';
    return j;
  };
  const base = (j, extra) => ({ parallel: 3, packLimit: 1, jobs: [j], now: 0, foreignBusy: () => false, lockAll: true, ...extra });

  it('takes the lock before any functional file starts', () => {
    expect(plan(base(mk(), { lock: 'free' }))).toEqual([{ type: 'acquire-lock' }]);
  });

  it('starts nothing while another agent holds the lock', () => {
    expect(plan(base(mk(), { lock: 'other' }))).toEqual([]);
  });

  it('does not take the lock again during the cooldown after giving it back', () => {
    expect(plan(base(mk(), { lock: 'free', cooldown: true }))).toEqual([]);
  });

  it('starts functional files in parallel once the lock is ours, and keeps it while they run', () => {
    const actions = plan(base(mk(), { lock: 'ours' }));
    expect(actions.map((a) => a.type)).toEqual(['start', 'start']);
  });

  it('gives the lock back when idle, and not while something runs', () => {
    const idle = job('A', { seq: 1, files: ['f1'] });
    idle.prep = 'done';
    idle.items[0].status = 'done';
    expect(plan(base(idle, { lock: 'ours' }))).toEqual([{ type: 'release-lock' }]);
    const running = job('B', { seq: 2, files: ['f1'] });
    running.prep = 'done';
    running.items[0].status = 'running';
    running.items[0].startedAt = 0;
    expect(plan(base(running, { lock: 'ours' }))).toEqual([]);
  });

  it('an exclusive file still waits for the machine to be empty even though the lock is ours', () => {
    const j = mk();
    j.items[0].status = 'running';
    j.items[0].startedAt = 0;
    j.items[1].status = 'done';
    expect(plan(base(j, { lock: 'ours' }))).toEqual([]);
    j.items[0].status = 'done';
    expect(plan(base(j, { lock: 'ours' }))).toEqual([{ type: 'start', jobId: 'A', itemId: 'x1' }]);
  });

  it('keeps first-come-first-served order inside a priority', () => {
    const a = job('A', { seq: 1, priority: 'measure', worktree: 'W1', files: ['a1'] });
    const b = job('B', { seq: 2, priority: 'measure', worktree: 'W2', files: ['b1'] });
    a.prep = 'done';
    b.prep = 'done';
    const actions = plan({ parallel: 1, packLimit: 1, jobs: [b, a], now: 0, lock: 'ours', foreignBusy: () => false, lockAll: true });
    expect(actions).toEqual([{ type: 'start', jobId: 'A', itemId: 'a1' }]);
  });
});
