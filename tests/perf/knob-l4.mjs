// L4 (1.5.3): bitmap budget 32 / 48 / 64 / 96 MB at three window sizes and three zooms. Per run: Tab+GPU private bytes
// (peak while scrolling, settled after), page re-renders when scrolling back, thumbnail re-renders, scroll frame p95.
// Re-render = a render request for a (page, scale) already requested earlier in the run (counted at the worker post).
import { fixture } from '../e2e/helpers.mjs';
import { MB, launchKnob, openFile, setZoomPercent, openThumbnails, scrollAt, frameStats, withMemorySampling, runRow, closeEverything } from './knob-lib.mjs';

export const SIZES = [
  { name: 'S', width: 1000, height: 700 },
  { name: 'M', width: 1400, height: 900 },
  { name: 'L', width: 1900, height: 1000 },
];
const BUDGETS_MB = [32, 48, 64, 96];
const ZOOMS = [50, 100, 200];
const REPS = 2;

export async function runL4(sizeIndex) {
  const size = SIZES[sizeIndex];
  try {
    for (let rep = 1; rep <= REPS; rep++) {
      for (const zoom of ZOOMS) {
        for (const budgetMB of BUDGETS_MB) {
          await runRow('L4', { size: size.name, window: `${size.width}x${size.height}`, zoom, budgetMB, rep }, {
            launch: () => launchKnob({ knobs: { bitmapBudgetBytes: budgetMB * MB }, size }),
            run: async (s) => {
              await openFile(s, fixture('big-1000.pdf'), 1000);
              await setZoomPercent(s, zoom);
              await openThumbnails(s);
              const vh = await s.win.evaluate(() => document.querySelector('.viewer').clientHeight);
              const speed = vh * 1.2; // 1.2 viewports/s: below the default fast threshold (1.5), so pages render at full scale
              const snap = () => s.win.evaluate(() => window.__rcSnap());
              const { out, peakPrivateMB, settledPrivateMB } = await withMemorySampling(s, async () => {
                const a0 = await snap();
                const down = await scrollAt(s.win, '.viewer', speed, 15000);
                const a1 = await snap();
                const up = await scrollAt(s.win, '.viewer', -speed, 15000);
                const a2 = await snap();
                const thumbSpeed = 1500;
                const tdown = await scrollAt(s.win, '.thumb-list', thumbSpeed, 6000);
                const a3 = await snap();
                const tup = await scrollAt(s.win, '.thumb-list', -thumbSpeed, 6000);
                await s.win.waitForTimeout(1500);
                const a4 = await snap();
                return {
                  pageRendersDown: a1.page - a0.page,
                  pageRendersBack: a2.page - a1.page,
                  pageReRendersBack: a2.pageRepeat - a1.pageRepeat,
                  pageReRendersTotal: a4.pageRepeat - a0.pageRepeat,
                  thumbRendersTotal: a4.thumb - a0.thumb,
                  thumbReRenders: a4.thumbRepeat - a0.thumbRepeat,
                  thumbReRendersOnBack: a4.thumbRepeat - a3.thumbRepeat,
                  scrollDown: frameStats(down),
                  scrollBack: frameStats(up),
                  thumbScroll: frameStats([...tdown, ...tup]),
                };
              });
              const blank = await s.win.evaluate(() => {
                const v = document.querySelector('.viewer'); const vr = v.getBoundingClientRect();
                return [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; }).filter((p) => p.querySelector('.page-placeholder') || p.querySelector('canvas').width === 300).length;
              });
              return { knobs: s.knobsApplied, peakPrivateMB, settledPrivateMB, blankVisibleAfter: blank, ...out };
            },
          });
        }
      }
    }
  } finally {
    await closeEverything();
  }
}
