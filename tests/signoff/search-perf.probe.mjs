// Sign-off probe: (1) search highlight sits over the matched word (compared with pdfkit's exact glyph
// metrics); (2) a heavier 1,000-page file opens fast and scrolls smoothly with real wheel input.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launch, ROOT, waitFor, waitForPage, statusText, closeAll, cleanupProfile, topPage } from './common.mjs';

const OUT = join(ROOT, 'tests', 'signoff', 'out');
const log = (...a) => console.log(...a);

try {
  // ---------- 1. Highlight alignment ----------
  const expected = JSON.parse(readFileSync(join(OUT, 'search-align.json'), 'utf8'));
  let s = await launch();
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([join(OUT, 'search-align.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1');
  for (const zoomKeys of [0, 3]) {
    for (let i = 0; i < zoomKeys; i++) await s.win.keyboard.press('Control+=');
    await s.win.waitForTimeout(500);
    const zoom = Number((await statusText(s.win)).match(/(\d+)%/)[1]) / 100;
    for (const word of ['zephyrbloom', 'qwertarget']) {
      await s.win.keyboard.press('Control+f');
      await s.win.getByLabel('Find in document').fill(word);
      await s.win.waitForTimeout(1200);
      const hits = await s.win.locator('.search-hit').evaluateAll((els) => {
        const page = document.querySelector('.page[data-page-index="0"]').getBoundingClientRect();
        return els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left - page.left, y: r.top - page.top, w: r.width, h: r.height }; });
      });
      const exp = expected.filter((e) => e.word === word);
      hits.sort((a, b) => a.y - b.y);
      hits.forEach((h, i) => {
        const e = exp[i];
        if (!e) return;
        const dx = h.x / zoom - e.x;
        log(`  zoom ${Math.round(zoom * 100)}% "${word}" line ${e.line}: highlight x=${(h.x / zoom).toFixed(1)}pt w=${(h.w / zoom).toFixed(1)}pt; true x=${e.x.toFixed(1)}pt w=${e.width.toFixed(1)}pt; offset ${dx.toFixed(1)}pt (${(dx / e.width * 100).toFixed(0)}% of the word width)`);
      });
    }
  }
  log(`  status line: ${(await s.win.locator('.search-status').innerText()).trim()}`);
  await s.win.screenshot({ path: join(ROOT, 'tests', 'signoff', 'search-align-shot.png') });
  await s.close();
  cleanupProfile(s.profile);

  // ---------- 2. Heavy 1,000 pages ----------
  const heavy = join(OUT, 'heavy-1000.pdf');
  log(`heavy-1000.pdf size ${(statSync(heavy).size / 1e6).toFixed(1)} MB`);
  s = await launch();
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([heavy]);
  const t0 = performance.now();
  await s.win.keyboard.press('Control+o');
  await s.win.locator('.page-canvas').first().waitFor({ timeout: 60000 });
  const firstCanvas = performance.now() - t0;
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  log(`  first page canvas ${firstCanvas.toFixed(0)} ms; status ${(performance.now() - t0).toFixed(0)} ms`);
  // Real wheel scrolling for ~4 s while sampling frames.
  await s.win.evaluate(() => {
    window.__gaps = []; let last = performance.now(); window.__run = true;
    const f = () => { const n = performance.now(); window.__gaps.push(n - last); last = n; if (window.__run) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  const vb = await s.win.locator('.viewer').boundingBox();
  await s.win.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  for (let i = 0; i < 80; i++) { await s.win.mouse.wheel(0, 400); await s.win.waitForTimeout(40); }
  const frames = await s.win.evaluate(() => { window.__run = false; const g = [...window.__gaps].sort((a, b) => a - b); return { n: g.length, p50: g[Math.floor(g.length / 2)], p95: g[Math.floor(g.length * 0.95)], worst: g[g.length - 1], over50: g.filter((x) => x > 50).length }; });
  log(`  wheel scroll 80 x 400px: frames ${frames.n}, p50 ${frames.p50.toFixed(0)} ms, p95 ${frames.p95.toFixed(0)} ms, worst ${frames.worst.toFixed(0)} ms, frames >50ms: ${frames.over50}`);
  const afterWheel = performance.now();
  const visibleRendered = async () => s.win.evaluate(() => {
    const v = document.querySelector('.viewer').getBoundingClientRect();
    const pages = [...document.querySelectorAll('.viewer .page')].filter((p) => { const r = p.getBoundingClientRect(); return r.top < v.bottom && r.bottom > v.top; });
    return { visible: pages.length, rendered: pages.filter((p) => p.querySelector('.page-canvas')).length };
  });
  log(`  right after wheel stop: ${JSON.stringify(await visibleRendered())}, top ${JSON.stringify(await topPage(s.win))}`);
  await waitFor(async () => { const r = await visibleRendered(); return r.visible > 0 && r.visible === r.rendered; }, { timeoutMs: 10000, label: 'visible pages rendered' });
  log(`  visible pages sharp ${(performance.now() - afterWheel).toFixed(0)} ms after the wheel stopped`);
  // Jump to 1000 and drag the scrollbar-equivalent (programmatic) to the middle.
  const j0 = performance.now();
  await s.win.keyboard.press('Control+g'); await s.win.keyboard.type('1000'); await s.win.keyboard.press('Enter');
  await waitForPage(s, 'Page 1000 of 1000');
  await waitFor(async () => { const r = await visibleRendered(); return r.visible > 0 && r.visible === r.rendered; }, { timeoutMs: 10000, label: 'p1000 rendered' });
  log(`  jump to 1000 and render: ${(performance.now() - j0).toFixed(0)} ms`);
  await s.win.keyboard.press('Control+f');
  await s.win.getByLabel('Find in document').fill('commodo');
  const q0 = performance.now();
  await waitFor(async () => /of \d+$/.test((await s.win.locator('.search-status').innerText()).trim()) && !/pages/.test(await s.win.locator('.search-status').innerText()), { timeoutMs: 120000, label: 'search done' });
  log(`  search "commodo" across 1000 heavy pages: "${(await s.win.locator('.search-status').innerText()).trim()}" in ${(performance.now() - q0).toFixed(0)} ms`);
  const m = await s.metrics();
  log(`  memory: ${m.map((x) => `${x.type} ${Math.round(x.memKB / 1024)}MB`).join(', ')}`);
  log(`  errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);
} finally {
  await closeAll();
}
