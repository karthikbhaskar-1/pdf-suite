// Pass/fail criteria of the memory soak (tests/perf/mem-soak.probe.mjs). Pure, so it has a unit test.
//
// WHY it proves a plateau (ticket 1.2.1): the old 8-pass gate judged passes 2-8 and failed on a healthy machine
// (553, 578, 585, 592, 585, 593, 600 MB, slope 6.1), because that is the climb to the plateau, not growth without bound.
// A 40-pass run right after (420, 449, 441, 426, 586 ... 599, 591, 595 ... 616, 614, 622, 606 MB) climbs for about the first
// dozen passes and then stays at 600-620 MB (slope over passes 13-40 near zero, highest reading 622).
// So passes 1-12 are warm-up (only the ceiling applies) and the last 12 passes are judged.
export const MAX_MB = 720;
export const WINDOW = 12;

export const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
export function slope(xs, ys) {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  return xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
}

/**
 * @param {number[]} p private MB per pass (p[0] is pass 1); at least 24 values
 * @param {number} idle the 60 s idle reading
 * The judged window is the last 12 passes (13-24 for 24 passes).
 */
export function soakCriteria(p, idle) {
  if (p.length < 2 * WINDOW) throw new Error(`need at least ${2 * WINDOW} passes, got ${p.length}`);
  const first = p.length - WINDOW + 1;
  const w = p.slice(-WINDOW);
  const xs = w.map((_, i) => first + i);
  const q = WINDOW / 3;
  const c = {
    window: [first, p.length],
    slopeMBPerPass: Number(slope(xs, w).toFixed(2)),
    lateMinusEarlyMB: median(w.slice(-q)) - median(w.slice(0, q)),
    idleMinusLateMedianMB: idle - median(w.slice(-q)),
    maxMB: Math.max(...p, idle),
  };
  c.a = c.slopeMBPerPass < 3;
  c.b = c.lateMinusEarlyMB < 15;
  c.c = c.idleMinusLateMedianMB <= 15;
  c.d = c.maxMB < MAX_MB;
  c.pass = c.a && c.b && c.c && c.d;
  return c;
}
