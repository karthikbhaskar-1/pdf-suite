// Sign-off probe: search highlight alignment on the harder fixture, at 100% and 400%, plus a rotated page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, ROOT, fixture, waitFor, waitForPage, statusText, closeAll, cleanupProfile } from './common.mjs';

const OUT = join(ROOT, 'tests', 'signoff', 'out');
const log = (...a) => console.log(...a);
try {
  const expected = JSON.parse(readFileSync(join(OUT, 'search-align2.json'), 'utf8'));
  let s = await launch();
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([join(OUT, 'search-align2.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1');
  // Fit width, then 400%.
  for (const mode of ['fit', 'z400']) {
    if (mode === 'fit') await s.win.keyboard.press('Control+1');
    else { await s.win.locator('select').filter({ has: s.win.locator('option', { hasText: '400%' }) }).first().selectOption({ label: '400%' }).catch(async () => { for (let i = 0; i < 3; i++) await s.win.keyboard.press('Control+='); }); }
    await s.win.waitForTimeout(800);
    const zoom = Number((await statusText(s.win)).match(/(\d+)%/)[1]) / 100;
    await s.win.keyboard.press('Control+f');
    await s.win.getByLabel('Find in document').fill('qwertarget');
    await waitFor(async () => (await s.win.locator('.search-hit').count()) >= expected.length, { timeoutMs: 15000, label: 'all highlights' }).catch(() => undefined);
    await s.win.waitForTimeout(800);
    const hits = await s.win.locator('.search-hit').evaluateAll((els) => {
      const page = document.querySelector('.page[data-page-index="0"]').getBoundingClientRect();
      return els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left - page.left, y: r.top - page.top, w: r.width, h: r.height }; });
    });
    log(`zoom ${Math.round(zoom * 100)}%: ${hits.length} highlights (expected ${expected.length}); status "${(await s.win.locator('.search-status').innerText()).trim()}"`);
    hits.sort((a, b) => a.y - b.y);
    for (const e of expected) {
      // Match each expected line to the highlight whose vertical centre is nearest the line.
      const h = hits.map((h) => ({ ...h, d: Math.abs(h.y / zoom - e.y) })).sort((a, b) => a.d - b.d)[0];
      if (!h || h.d > 20) { log(`  ${e.label}: NO highlight near y=${e.y}`); continue; }
      const dx = h.x / zoom - e.x;
      const dw = h.w / zoom - e.width;
      log(`  ${e.label.padEnd(28)} left edge ${dx >= 0 ? '+' : ''}${dx.toFixed(1)}pt (${((dx / e.width) * 100).toFixed(0)}%), width ${dw >= 0 ? '+' : ''}${dw.toFixed(1)}pt (${((dw / e.width) * 100).toFixed(0)}%)`);
    }
    await s.win.keyboard.press('Escape');
  }
  // Horizontal reveal at 400%: step through matches with the view starting at the far left.
  await s.win.locator('.viewer').first().evaluate((e) => { e.scrollLeft = 0; });
  await s.win.keyboard.press('Control+f');
  await s.win.getByLabel('Find in document').fill('qwertarget');
  await s.win.waitForTimeout(800);
  const vb = await s.win.locator('.viewer').first().boundingBox();
  const seen = [];
  for (let i = 0; i < expected.length; i++) {
    await s.win.waitForTimeout(350);
    const c = await s.win.locator('.search-hit-current').boundingBox().catch(() => null);
    const inside = c && c.x >= vb.x - 1 && c.x + c.width <= vb.x + vb.width + 1 && c.y >= vb.y - 1 && c.y + c.height <= vb.y + vb.height + 1;
    seen.push(inside ? 'in' : 'OUT');
    await s.win.keyboard.press('F3');
  }
  log(`400% current-match on screen, match by match: ${seen.join(' ')}`);
  await s.win.screenshot({ path: join(ROOT, 'tests', 'signoff', 'align2-400.png') });
  log(`errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);

  // Rotated pages: the highlight should sit on the rotated text.
  s = await launch();
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 8');
  await s.win.keyboard.press('Control+f');
  await s.win.getByLabel('Find in document').fill('rotated 90');
  await s.win.waitForTimeout(2500);
  log(`rotated: status "${(await s.win.locator('.search-status').innerText()).trim()}"`);
  await s.win.screenshot({ path: join(ROOT, 'tests', 'signoff', 'rotated90.png') });
  log(`rotated errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);
} finally {
  await closeAll();
}
