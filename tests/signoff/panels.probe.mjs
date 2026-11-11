// Sign-off probe: Properties adapts to the clicked item (document / page), Bookmarks is a hierarchy that
// navigates, Thumbnails jump and select ranges.
import { openFiles, topPage, waitFor, waitForPage, statusText, closeAll, cleanupProfile } from './common.mjs';

const log = (...a) => console.log(...a);

try {
  let s = await openFiles(['mixed-sizes-rotated.pdf'], ['Page 1 of 8']);
  await s.win.getByRole('button', { name: 'Properties', exact: true }).click();
  const props = s.win.getByRole('complementary', { name: 'Properties', exact: true });
  await props.waitFor({ timeout: 5000 });
  const cur = async () => {
    const t = await props.locator('section[aria-label="Current page"]').innerText().catch(() => '(no Current page section)');
    return t.replace(/\s+/g, ' ').trim();
  };
  const sections = async () => props.locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  log(`P0 sections: ${JSON.stringify(await sections())}`);
  log(`P0 document: ${(await props.locator('section[aria-label="Document"]').innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  log(`P0 current: ${await cur()}`);
  // Zoom out so several pages are on screen.
  for (let i = 0; i < 5; i++) await s.win.keyboard.press('Control+-');
  await s.win.waitForTimeout(800);
  log(`P1 status: ${await statusText(s.win)}; top page ${JSON.stringify(await topPage(s.win))}`);
  const visible = await s.win.locator('.viewer .page').evaluateAll((els) => {
    const v = document.querySelector('.viewer').getBoundingClientRect();
    return els.filter((e) => { const r = e.getBoundingClientRect(); return r.top < v.bottom && r.bottom > v.top; }).map((e) => Number(e.dataset.pageIndex) + 1);
  });
  log(`P1 pages on screen: ${JSON.stringify(visible)}`);
  const target = visible[visible.length - 1];
  // Left-click the last visible page.
  const tp = s.win.locator(`.viewer .page[data-page-index="${target - 1}"]`);
  const tb = await tp.boundingBox();
  await s.win.mouse.click(tb.x + tb.width / 2, tb.y + Math.min(tb.height / 2, 20));
  await s.win.waitForTimeout(500);
  log(`P2 after LEFT-CLICK on page ${target}: ${await cur()} | sections ${JSON.stringify(await sections())}`);
  // Right-click the last visible page -> Properties.
  await s.win.mouse.click(tb.x + tb.width / 2, tb.y + Math.min(tb.height / 2, 20), { button: 'right' });
  await s.win.getByRole('menuitem', { name: /^Properties/ }).click();
  await s.win.waitForTimeout(500);
  log(`P3 after RIGHT-CLICK page ${target} > Properties: ${await cur()}`);
  // Size check vs. the page's spec: page 4 is A3 landscape, page 5 small square.
  // Click on the empty viewer background (not a page) -> should describe the document only?
  const vb = await s.win.locator('.viewer').boundingBox();
  await s.win.mouse.click(vb.x + 5, vb.y + vb.height - 5);
  await s.win.waitForTimeout(400);
  log(`P4 after clicking viewer background: sections ${JSON.stringify(await sections())}; ${await cur()}`);
  log(`P errors: ${JSON.stringify(s.errors)}`);

  // Thumbnails: Ctrl+click selection while Properties is docked? Only one dock at a time -> open thumbnails.
  await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
  const rows = s.win.locator('.thumb[role="option"]');
  await rows.first().waitFor({ timeout: 10000 });
  log(`T0 thumbnail rows drawn: ${await rows.count()}; canvases: ${await s.win.locator('.thumb canvas').count()}`);
  await s.win.waitForTimeout(1000);
  log(`T0b canvases after 1s: ${await s.win.locator('.thumb canvas').count()}`);
  await s.win.locator('.thumb-list').evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await s.win.waitForTimeout(600);
  const row7 = s.win.locator('.thumb[role="option"]').filter({ has: s.win.locator('.thumb-label', { hasText: /^7$/ }) });
  await row7.click();
  await s.win.waitForTimeout(600);
  log(`T1 plain click thumb 7: status ${await statusText(s.win)}; viewer top ${JSON.stringify(await topPage(s.win))}; aria-current=${await row7.getAttribute('aria-current')}`);
  await s.win.getByRole('button', { name: 'Properties', exact: true }).click();
  await props.waitFor({ timeout: 5000 });
  log(`T1b Properties after thumb 7 click: ${await cur()}`);
  await s.close();
  cleanupProfile(s.profile);

  // ---------- Bookmarks hierarchy & thumbnails on 1000 pages ----------
  s = await openFiles(['big-1000.pdf'], ['Page 1 of 1000']);
  await s.win.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  const tree = s.win.getByRole('tree', { name: 'Bookmarks', exact: true });
  await tree.waitFor({ timeout: 5000 });
  const levels = async () => tree.getByRole('treeitem').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-level')}:${e.getAttribute('aria-expanded')}:${e.innerText.replace(/[▸▾]/g, '').trim()}`));
  log(`B0 tree items: ${JSON.stringify(await levels())}`);
  await s.win.getByRole('button', { name: /^Expand Chapter 3/ }).click();
  await s.win.waitForTimeout(300);
  log(`B1 after expanding Chapter 3: ${JSON.stringify((await levels()).filter((t) => t.startsWith('2:')))}`);
  await tree.getByRole('button', { name: /^Section at page 201$/ }).click();
  await waitForPage(s, 'Page 201 of 1000', { timeoutMs: 10000 }).catch(() => undefined);
  log(`B2 click "Section at page 201": status ${await statusText(s.win)}`);
  // Keyboard: focus Chapter 5, Right expands, Down goes to child, Enter jumps.
  await tree.getByRole('button', { name: /^Chapter 5/ }).focus();
  await s.win.keyboard.press('ArrowRight');
  await s.win.keyboard.press('ArrowRight');
  await s.win.keyboard.press('Enter');
  await s.win.waitForTimeout(500);
  log(`B3 keyboard Right,Right,Enter on Chapter 5: status ${await statusText(s.win)}; focused ${await s.win.evaluate(() => document.activeElement?.textContent)}`);

  await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
  const rows2 = s.win.locator('.thumb[role="option"]');
  await rows2.first().waitFor({ timeout: 10000 });
  log(`T2 1000-page thumbnails: rows in DOM ${await rows2.count()}; sheet height ${await s.win.locator('.thumb-sheet').evaluate((e) => e.style.height)}`);
  // Scroll thumbnails to the end and click the last one.
  await s.win.locator('.thumb-list').evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await s.win.waitForTimeout(800);
  const last = s.win.locator('.thumb[role="option"]').last();
  log(`T3 last row label ${await last.locator('.thumb-label').innerText()}`);
  await last.click();
  await waitForPage(s, 'Page 1000 of 1000', { timeoutMs: 10000 }).catch(() => undefined);
  log(`T3 after click: status ${await statusText(s.win)}`);
  // Range selection with Shift.
  const prevRow = s.win.locator('.thumb[role="option"]').nth(-4);
  await prevRow.click({ modifiers: ['Shift'] });
  const sel = await s.win.locator('[role="option"][aria-selected="true"] .thumb-label').allInnerTexts();
  log(`T4 Shift-click 3 rows above: selected ${sel.join(',')}`);
  await s.win.waitForTimeout(1500);
  const thumbPix = await s.win.locator('.thumb canvas').count();
  log(`T5 thumb canvases rendered near end: ${thumbPix}`);
  log(`B/T errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);
} finally {
  await closeAll();
}
