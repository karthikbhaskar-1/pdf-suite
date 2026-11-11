// P1 (1.5.4): render concurrency 1 against 2 (design-register A3), real priorities. Per run: first page (Ctrl+O to pixels),
// jump-to-paint (4 jumps), drag-to-paint (4 scrollbar-thumb drags, real mouse), split view (open, then a jump in one pane:
// time until both panes are painted). Files: big-1000 (light) and heavy-1000 (image-heavy). Runs alternate 1, 2, 1, 2.
// One exclusive job; about 25 minutes.
import { join } from 'node:path';
import { fixture, ROOT } from '../e2e/helpers.mjs';
import { launchKnob, waitFor, waitForPage, timeToPaint, dragThumb, median, runRow, closeEverything } from './knob-lib.mjs';

const FILES = [
  { key: 'big', path: fixture('big-1000.pdf') },
  { key: 'heavy', path: join(ROOT, 'tests', 'signoff', 'out', 'heavy-1000.pdf') },
];
const REPS = 5;
const ARM_FIRST_PAINT = `(() => {
  window.__fp = { key: null, paint: null };
  window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'o' && window.__fp.key === null) window.__fp.key = performance.now(); }, true);
  const poll = () => {
    const c = document.querySelector('.viewer .page[data-page-index="0"] canvas.page-canvas');
    if (c && c.width !== 300 && !c.parentElement.querySelector('.page-placeholder')) {
      const d = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data;
      let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
      if (opaque > 0) { window.__fp.paint = performance.now(); return; }
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
})();`;

try {
  for (const file of FILES) {
    for (let rep = 1; rep <= REPS; rep++) {
      for (const concurrency of rep % 2 ? [1, 2] : [2, 1]) {
        await runRow('P1', { file: file.key, concurrency, rep }, {
          launch: async () => {
            const s = await launchKnob({ knobs: { concurrency }, size: { width: 1400, height: 900 } });
            await s.win.addInitScript(ARM_FIRST_PAINT);
            await s.win.reload();
            await s.win.waitForSelector('.empty-state');
            return s;
          },
          run: async (s) => {
            await s.setDialogAnswer([file.path]);
            await s.win.keyboard.press('Control+o');
            await waitFor(async () => s.win.evaluate(() => window.__fp.paint), { timeoutMs: 60000, label: 'first paint' });
            const fp = await s.win.evaluate(() => window.__fp);
            await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
            await s.win.waitForTimeout(1500);
            const jumps = [];
            for (const f of [0.137, 0.512, 0.888, 0.3]) {
              await s.win.evaluate((f) => { const v = document.querySelector('.viewer'); v.scrollTop = (v.scrollHeight - v.clientHeight) * f; }, f);
              jumps.push(await timeToPaint(s.win));
              await s.win.waitForTimeout(1200);
            }
            const drags = [];
            for (const f of [0.2, 0.6, 0.95, 0.4]) {
              await dragThumb(s, f);
              drags.push(await timeToPaint(s.win));
              await s.win.waitForTimeout(1200);
            }
            await s.win.keyboard.press('Control+\\');
            const tSplit = Date.now();
            await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000 });
            const both = () => s.win.evaluate(async () => {
              const vs = [...document.querySelectorAll('.viewer')];
              const t0 = performance.now();
              for (;;) {
                await new Promise((r) => requestAnimationFrame(r));
                const ok = vs.every((v) => { const vr = v.getBoundingClientRect(); const vis = [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top + 20 && r.top < vr.bottom - 20; }); return vis.length && vis.every((p) => p.querySelector('canvas').width !== 300); });
                if (ok) return Math.round(performance.now() - t0);
                if (performance.now() - t0 > 10000) return null;
              }
            });
            const splitOpenMs = (await both()) !== null ? Date.now() - tSplit : null;
            const splitJumps = [];
            for (const f of [0.45, 0.8]) {
              await s.win.evaluate((f) => { const v = document.querySelectorAll('.viewer')[0]; v.scrollTop = (v.scrollHeight - v.clientHeight) * f; }, f);
              splitJumps.push(await both());
              await s.win.waitForTimeout(1200);
            }
            return {
              knobs: s.knobsApplied,
              firstPageMs: Math.round(fp.paint - fp.key),
              jumpPaintedMs: jumps.map((j) => j.paintedMs), jumpMedianMs: median(jumps.map((j) => j.paintedMs)),
              dragPaintedMs: drags.map((j) => j.paintedMs), dragMedianMs: median(drags.map((j) => j.paintedMs)),
              splitOpenToPaintedMs: splitOpenMs, splitJumpBothPaintedMs: splitJumps, splitJumpMedianMs: median(splitJumps),
            };
          },
        });
      }
    }
  }
} finally {
  await closeEverything();
}
