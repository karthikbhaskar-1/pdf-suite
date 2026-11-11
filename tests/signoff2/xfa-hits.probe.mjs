// Re-audit probe: where do XFA search highlights land? For each hit, the text of the HTML-layer elements under the
// highlight centre (highlight layer made click-through for the hit test).
import { join } from 'node:path';
import { CORPUS, ROOT2, launchTracked, openPath, check, summary, waitFor, closeAll, cleanupProfile } from './lib.mjs';

const s = await launchTracked();
try {
  await s.win.waitForSelector('.empty-state');
  await openPath(s, join(CORPUS, 'xfa', 'xfa_filled_imm1344e.pdf'), 'Page 1 of 7', 60000);
  await s.win.waitForTimeout(2500);
  const out = {};
  for (const word of ['Grandparent', 'Euler', 'Brunswick', 'sponsor']) {
    await s.win.keyboard.press('Control+f');
    await s.win.getByLabel('Find in document').fill(word);
    await waitFor(async () => /^\d+ of \d+$|No matches/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 20000 });
    await s.win.waitForTimeout(800);
    const total = Number(((await s.win.locator('.search-status').innerText()).trim().split(' of ')[1]) || 0);
    const hits = [];
    for (let i = 0; i < Math.min(total, 8); i++) {
      await s.win.waitForTimeout(700);
      hits.push(await s.win.evaluate((w) => {
        const h = document.querySelector('.search-hit-current');
        if (!h) return { none: true };
        const r = h.getBoundingClientRect();
        h.parentElement.style.pointerEvents = 'none';
        const pts = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5]];
        const texts = pts.map(([fx, fy]) => {
          const els = document.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy);
          const e = els.find((x) => x.closest('.html-layer'));
          return e ? (e.value || e.textContent || '').trim().slice(0, 50) : null;
        });
        return { page: h.closest('.page')?.dataset.pageIndex, size: [Math.round(r.width), Math.round(r.height)], texts, ok: texts.some((t) => t && t.toLowerCase().includes(w.toLowerCase())) };
      }, word));
      await s.win.keyboard.press('F3');
    }
    out[word] = { total, onTarget: hits.filter((h) => h.ok).length, checked: hits.length, hits };
    await s.win.keyboard.press('Escape');
  }
  console.log(JSON.stringify(out));
  for (const [w, r] of Object.entries(out)) check(`XFA search "${w}": every checked highlight sits over text containing the word`, r.checked > 0 && r.onTarget === r.checked, { total: r.total, onTarget: r.onTarget, checked: r.checked, first: r.hits.slice(0, 3) });
} catch (e) {
  check('probe ran', false, String(e.stack ?? e).slice(0, 600));
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
