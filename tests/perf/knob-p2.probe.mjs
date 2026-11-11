// P2 (1.5.4): fast-scroll threshold 1.0 / 1.5 / 2.5 (A8), settle 80 / 120 / 200 (A9), low scale 0.5 / 0.67 (A11), and one
// "viewer is still" time against three (A9 120, A14 80, A29 150 set to 120 each). One knob moves at a time from the defaults;
// the default config is run in the same session. Per run and scroll speed (0.8, 1.8, 6 viewports/s, 3 s down from a fresh
// spot): frames over 50 ms during the scroll and p95, ms from stop until every visible page is painted, and until all are
// sharp (>= 90% of full width); page render requests; then 2 scrollbar drags (drag-to-paint). 3 reps, interleaved.
// One exclusive job; about 25 minutes.
import { fixture } from '../e2e/helpers.mjs';
import { launchKnob, openFile, scrollAt, frameStats, timeToPaint, dragThumb, median, runRow, closeEverything } from './knob-lib.mjs';

const CONFIGS = [
  { name: 'default', knobs: {} },
  { name: 'fast1.0', knobs: { fastViewportsPerSecond: 1.0 } },
  { name: 'fast2.5', knobs: { fastViewportsPerSecond: 2.5 } },
  { name: 'settle80', knobs: { settleMs: 80 } },
  { name: 'settle200', knobs: { settleMs: 200 } },
  { name: 'low0.67', knobs: { lowScaleFactor: 0.67 } },
  { name: 'still-one-120', knobs: { settleMs: 120, dragPauseMs: 120, layerSettleMs: 120 } },
];
const SPEEDS = [0.8, 1.8, 6];
const REPS = 3;

try {
  for (let rep = 1; rep <= REPS; rep++) {
    for (const config of CONFIGS) {
      await runRow('P2', { config: config.name, rep }, {
        launch: () => launchKnob({ knobs: config.knobs, size: { width: 1400, height: 900 } }),
        run: async (s) => {
          await openFile(s, fixture('big-1000.pdf'), 1000);
          const vh = await s.win.evaluate(() => document.querySelector('.viewer').clientHeight);
          const rows = [];
          let spot = 0.1;
          for (const speed of SPEEDS) {
            for (let k = 0; k < 2; k++) {
              spot += 0.11;
              await s.win.evaluate((f) => { const v = document.querySelector('.viewer'); v.scrollTop = (v.scrollHeight - v.clientHeight) * f; }, spot);
              await timeToPaint(s.win);
              await s.win.waitForTimeout(600);
              const r0 = (await s.win.evaluate(() => window.__rcSnap())).page;
              const gaps = await scrollAt(s.win, '.viewer', vh * speed, 3000);
              const t = await timeToPaint(s.win);
              const r1 = (await s.win.evaluate(() => window.__rcSnap())).page;
              rows.push({ speed, ...frameStats(gaps), paintedMs: t.paintedMs, sharpMs: t.sharpMs, renders: r1 - r0 });
            }
          }
          const drags = [];
          for (const f of [0.35, 0.75]) {
            await dragThumb(s, f);
            drags.push(await timeToPaint(s.win));
            await s.win.waitForTimeout(800);
          }
          const by = (speed) => rows.filter((r) => r.speed === speed);
          const summary = {};
          for (const speed of SPEEDS) {
            summary[`v${speed}`] = {
              over50: by(speed).reduce((a, r) => a + r.over50, 0),
              p95: median(by(speed).map((r) => r.p95)),
              paintedMs: median(by(speed).map((r) => r.paintedMs)),
              sharpMs: median(by(speed).map((r) => r.sharpMs)),
              renders: median(by(speed).map((r) => r.renders)),
            };
          }
          return { knobs: s.knobsApplied, summary, dragPaintedMs: median(drags.map((d) => d.paintedMs)), dragSharpMs: median(drags.map((d) => d.sharpMs)), detail: rows };
        },
      });
    }
  }
} finally {
  await closeEverything();
}
