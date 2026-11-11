// Scheduler for the test queue: a pure function. It looks at the jobs and what is running and says what to do next.
// It never starts a process or reads a clock, so tests/lib/testq-scheduler.test.mjs can drive it with fake jobs.
//
// Rules
//  - With `lockAll` (the default in the runner) it only starts work while it owns the old machine lock (see plan()).
//  - A job has a "prep" step (pack the worktree if asked, then regenerate the fixtures) and file items.
//    Prep runs once per worktree at a time. Jobs of the same worktree that are waiting for prep share one prep
//    (so one pack serves every queued job of that worktree). Prep waits until no file of that worktree is running,
//    and no file of that worktree starts while its prep runs or while a pack ordered before it is waiting.
//  - Functional files run side by side, at most `parallel` at a time, across jobs.
//  - An exclusive file runs alone: nothing else (file or prep) is running, no foreign PDF Suite process is running,
//    and the shared machine lock is ours. While an exclusive file is the next one in order, nothing ordered after it
//    starts (the machine drains), so it cannot starve.
//  - Order: priority (ticket before measure), then submission order, then the item's place in its job.
//  - A running item past its limit gets a kill action.

export const PRIORITY_RANK = { ticket: 0, measure: 1 };

/** Order key of an entry: [rank, seq, index]. Prep uses index -1 so it sorts before its job's files. */
function keyOf(job, index) {
  return [PRIORITY_RANK[job.priority] ?? 1, job.seq, index];
}

export function compareKeys(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * state = {
 *   now: ms, parallel: number, packLimit: number,
 *   lock: 'free' | 'ours' | 'other',
 *   foreignBusy: () => boolean,            // another PDF Suite app run exists that is not ours (only asked when needed)
 *   jobs: [{ id, priority, seq, worktree, wantPack, prep: 'pending'|'running'|'done'|'failed',
 *            prepStartedAt?, prepLimitMs?, prepPack? (true while this job's prep includes a pack),
 *            items: [{ id, cls: 'functional'|'exclusive', status: 'pending'|'running'|'done', startedAt?, limitMs }] }]
 * }
 * Returns an ordered list of actions:
 *   { type: 'prep', worktree, jobIds, pack }          start prep for these jobs (they become 'running')
 *   { type: 'start', jobId, itemId }                  start a file
 *   { type: 'acquire-lock' }                          take the machine lock (the caller re-plans afterwards)
 *   { type: 'release-lock' }                          give the machine lock back
 *   { type: 'kill', jobId, itemId, reason: 'timeout' }
 *   { type: 'kill-prep', worktree, reason: 'timeout' }
 */
export function plan(state) {
  if (!state.lockAll) return planCore(state);
  // Lock-for-all mode: the runner works only while it owns the old machine lock, so no agent that still uses the lock
  // can run beside it. It takes the lock when there is something to start, holds it while anything runs, and gives it
  // back when it is idle. Exclusive files still wait for the machine to empty (and for foreign processes).
  if (state.lock !== 'ours') {
    const wouldDo = planCore({ ...state, lock: 'ours' }).some((a) => a.type === 'start' || a.type === 'prep');
    if (!wouldDo || state.lock === 'other' || state.cooldown) return [];
    return [{ type: 'acquire-lock' }];
  }
  const actions = planCore(state).filter((a) => a.type !== 'release-lock');
  const busy = state.jobs.some((j) => j.prep === 'running' || j.items.some((i) => i.status === 'running'));
  if (!busy && !actions.some((a) => a.type === 'start' || a.type === 'prep')) actions.push({ type: 'release-lock' });
  return actions;
}

function planCore(state) {
  const { now, parallel, packLimit, lock } = state;
  const actions = [];
  const jobs = state.jobs.filter((j) => j.prep !== 'failed');

  // Timeouts first. They do not free anything until the runner reports the item finished.
  const preppingWorktrees = new Set();
  let packsRunning = 0;
  for (const job of jobs) {
    if (job.prep === 'running') {
      if (!preppingWorktrees.has(job.worktree)) {
        preppingWorktrees.add(job.worktree);
        if (job.prepPack) packsRunning++;
        if (job.prepLimitMs && now - job.prepStartedAt > job.prepLimitMs) actions.push({ type: 'kill-prep', worktree: job.worktree, reason: 'timeout' });
      }
    }
    for (const item of job.items) {
      if (item.status === 'running' && item.limitMs && now - item.startedAt > item.limitMs) {
        actions.push({ type: 'kill', jobId: job.id, itemId: item.id, reason: 'timeout' });
      }
    }
  }

  const running = []; // { job, item }
  for (const job of jobs) for (const item of job.items) if (item.status === 'running') running.push({ job, item });
  const runningByWorktree = new Map();
  const bump = (w, n) => runningByWorktree.set(w, (runningByWorktree.get(w) ?? 0) + n);
  for (const r of running) bump(r.job.worktree, 1);
  let runningFiles = running.length;
  let prepsRunning = preppingWorktrees.size;
  const exclusiveRunning = running.some((r) => r.item.cls === 'exclusive');

  // Candidate entries in order.
  const entries = [];
  const prepGroups = new Map(); // worktree -> { key, jobs: [] } for jobs waiting for prep
  for (const job of jobs) {
    if (job.prep === 'pending') {
      const key = keyOf(job, -1);
      const g = prepGroups.get(job.worktree);
      if (!g) prepGroups.set(job.worktree, { worktree: job.worktree, key, jobs: [job] });
      else {
        g.jobs.push(job);
        if (compareKeys(key, g.key) < 0) g.key = key;
      }
    }
    job.items.forEach((item, index) => {
      if (item.status === 'pending') entries.push({ kind: 'item', key: keyOf(job, index), job, item });
    });
  }
  for (const g of prepGroups.values()) entries.push({ kind: 'prep', key: g.key, group: g });
  entries.sort((a, b) => compareKeys(a.key, b.key));

  // The first waiting exclusive file whose prep is done reserves the machine: nothing after it starts.
  const reserve = entries.find((e) => e.kind === 'item' && e.item.cls === 'exclusive' && e.job.prep === 'done');
  const prepKeyByWorktree = new Map();
  for (const g of prepGroups.values()) prepKeyByWorktree.set(g.worktree, g.key);

  let startedAnything = false;

  if (!exclusiveRunning) {
    for (const e of entries) {
      if (reserve && compareKeys(e.key, reserve.key) > 0) break;
      if (e.kind === 'prep') {
        const w = e.group.worktree;
        if (preppingWorktrees.has(w) || (runningByWorktree.get(w) ?? 0) > 0) continue;
        const pack = e.group.jobs.some((j) => j.wantPack);
        if (pack && packsRunning >= packLimit) continue;
        // An exclusive file ahead of this prep has not been reached (it would have stopped the loop), so go.
        actions.push({ type: 'prep', worktree: w, jobIds: e.group.jobs.map((j) => j.id), pack });
        preppingWorktrees.add(w);
        prepsRunning++;
        if (pack) packsRunning++;
        startedAnything = true;
        continue;
      }
      const { job, item } = e;
      if (item.cls === 'exclusive') {
        if (job.prep !== 'done') continue;
        if (runningFiles > 0 || prepsRunning > 0 || startedAnything) break; // wait for the machine to empty
        if (lock === 'other') break;
        if (state.foreignBusy && state.foreignBusy()) break;
        if (lock === 'free') {
          actions.push({ type: 'acquire-lock' });
          break;
        }
        actions.push({ type: 'start', jobId: job.id, itemId: item.id });
        runningFiles++;
        bump(job.worktree, 1);
        startedAnything = true;
        break; // nothing else starts beside an exclusive file
      }
      // functional
      if (job.prep !== 'done') continue;
      const w = job.worktree;
      if (preppingWorktrees.has(w)) continue;
      const prepKey = prepKeyByWorktree.get(w);
      if (prepKey && compareKeys(prepKey, e.key) < 0) continue; // a pack or fixture run is queued ahead of this file
      if (runningFiles >= parallel) continue;
      actions.push({ type: 'start', jobId: job.id, itemId: item.id });
      runningFiles++;
      bump(w, 1);
      startedAnything = true;
    }
  }

  // Give the machine lock back when no exclusive file is running or about to start.
  const startsExclusive = actions.some(
    (a) => a.type === 'start' && jobs.find((j) => j.id === a.jobId)?.items.find((i) => i.id === a.itemId)?.cls === 'exclusive',
  );
  const acquiring = actions.some((a) => a.type === 'acquire-lock');
  // Keep it only while the machine is idle and an exclusive file is waiting (for example for the foreign-process check):
  // giving it back and taking it again would let another agent in between.
  const idle = runningFiles === 0 && prepsRunning === 0 && !startedAnything;
  if (lock === 'ours' && !exclusiveRunning && !startsExclusive && !acquiring && !(idle && reserve)) actions.push({ type: 'release-lock' });
  return actions;
}

/** Per-file time limit: the manifest minutes times 3 (5 minutes when unknown), never below `floorMinutes`. */
export function limitMsFor(minutes, { factor = 3, floorMinutes = 2, unknownMinutes = 5 } = {}) {
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : unknownMinutes;
  return Math.round(Math.max(m * factor, floorMinutes) * 60_000);
}
