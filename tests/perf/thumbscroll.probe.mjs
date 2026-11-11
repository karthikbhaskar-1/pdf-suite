// Ticket 1.2.1 probe: a fast scroll of the THUMBNAIL list on the 1,000-page fixture (down and back, 120 steps each way,
// 16 ms apart, as the viewer scroll in tests/e2e/bigfile.e2e.mjs). Records frame gaps, how many thumbnails were painted,
// and Tab+GPU private bytes / working set right after. Run: node tests/perf/thumbscroll.probe.mjs   Env: THUMB_RUNS=6
// Take the machine lock first. Never run under an external timeout.
import { launch, fixture, waitForPage, closeAll, cleanupProfile, rendererMemoryMB } from '../e2e/helpers.mjs';

const RUNS = Number(process.env.THUMB_RUNS ?? 6);
const results = [];
try {
  for (let n = 1; n <= RUNS; n++) {
    const s = await launch();
    try {
      await s.win.waitForSelector('.empty-state');
      await s.setDialogAnswer([fixture('big-1000.pdf')]);
      await s.win.keyboard.press('Control+o');
      await s.win.locator('.page-canvas').first().waitFor({ timeout: 60000 });
      await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
      const rail = s.win.getByRole('button', { name: 'Thumbnails', exact: true }).first();
      if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click();
      await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
      const scroll = await s.win.evaluate(async () => {
        const list = document.querySelector('.thumb-list');
        const gaps = [];
        const timed = [];
        let last = performance.now();
        let running = true;
        const started = performance.now();
        const sample = () => {
          const now = performance.now();
          gaps.push(now - last);
          timed.push({ at: now - started, gap: now - last });
          last = now;
          if (running) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        const max = list.scrollHeight - list.clientHeight;
        const steps = 120;
        for (let i = 0; i <= steps; i++) { list.scrollTop = (max * i) / steps; await new Promise((r) => setTimeout(r, 16)); }
        for (let i = steps; i >= 0; i--) { list.scrollTop = (max * i) / steps; await new Promise((r) => setTimeout(r, 16)); }
        running = false;
        const sorted = [...gaps].sort((a, b) => a - b);
        return {
          frames: gaps.length,
          p95: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(1)),
          worst: Number(Math.max(...gaps).toFixed(1)),
          worstAfter1s: Number(Math.max(...timed.filter((f) => f.at > 1000).map((f) => f.gap)).toFixed(1)),
        };
      });
      const mem = await rendererMemoryMB(s);
      // After the scroll settles, every thumbnail row on screen must show a painted image.
      await s.win.waitForTimeout(1500);
      const blanks = await s.win.evaluate(() => {
        const list = document.querySelector('.thumb-list');
        const r = list.getBoundingClientRect();
        return [...list.querySelectorAll('.thumb')].filter((t) => {
          const b = t.getBoundingClientRect();
          return b.bottom > r.top + 10 && b.top < r.bottom - 10 && t.querySelector('.thumb-blank');
        }).length;
      });
      const row = { run: n, ...scroll, privateMB: Math.round(mem.privateMB), workingSetMB: Math.round(mem.workingSetMB), blankThumbsAfterSettle: blanks };
      results.push(row);
      console.log(`RUN ${n}: ${JSON.stringify(row)}`);
    } finally {
      await s.close();
      cleanupProfile(s.profile);
    }
  }
} finally {
  await closeAll();
  const bad = results.filter((r) => r.worstAfter1s > 50).length;
  console.log(`SUMMARY runs ${results.length}; worst-after-1s > 50 ms in ${bad}; max ws ${Math.max(...results.map((r) => r.workingSetMB))} MB; max private ${Math.max(...results.map((r) => r.privateMB))} MB; blanks ${results.reduce((a, r) => a + r.blankThumbsAfterSettle, 0)}`);
}
