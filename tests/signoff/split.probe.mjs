// Sign-off probe: split orientations and synchronized scrolling, measured from what each pane shows.
import { openFiles, topPage, runCommand, wheelOver, waitFor, closeAll, cleanupProfile, statusText } from './common.mjs';

const log = (...a) => console.log(...a);
const panes = (win) => win.locator('.pane-frame');
const viewerOf = (win, i) => panes(win).nth(i).locator('.viewer');
const both = async (win) => `pane1=${JSON.stringify(await topPage(win, 0))} pane2=${JSON.stringify(await topPage(win, 1))}`;

try {
  // --- A. Same file, vertical split (default), sync on.
  let s = await openFiles(['big-1000.pdf'], ['Page 1 of 1000']);
  await s.win.keyboard.press('Control+\\');
  await waitFor(async () => (await panes(s.win).count()) === 2, { label: 'two panes' });
  await s.win.waitForTimeout(600);
  const fr = await panes(s.win).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
  log(`A. vertical split class=${await s.win.locator('.split').getAttribute('class')} frames=${JSON.stringify(fr)}`);
  log(`A. sync button: ${await s.win.locator('.split-sync').getAttribute('aria-label')}`);
  log(`A. active pane index: ${await panes(s.win).evaluateAll((els) => els.findIndex((e) => e.classList.contains('pane-active')))}`);

  await wheelOver(s.win, viewerOf(s.win, 1), 400, 8);
  log(`A1. wheel over ACTIVE pane 2 (no click): ${await both(s.win)}`);

  await wheelOver(s.win, viewerOf(s.win, 0), 400, 8);
  log(`A2. wheel over INACTIVE pane 1 (no click): ${await both(s.win)}`);

  // Click pane 1 then wheel
  const b0 = await viewerOf(s.win, 0).boundingBox();
  await s.win.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await wheelOver(s.win, viewerOf(s.win, 0), 400, 8);
  log(`A3. click pane 1 then wheel over it: ${await both(s.win)}`);

  // Keyboard PageDown in active pane
  await s.win.keyboard.press('PageDown');
  await s.win.waitForTimeout(600);
  log(`A4. PageDown in active pane 1: ${await both(s.win)}`);

  // --- B. Two parts of the same file with sync: put pane 2 at page 300 with sync off, then turn sync on and scroll pane 2 a little.
  await s.win.locator('.split-sync').click(); // off
  log(`B. sync now: ${await s.win.locator('.split-sync').getAttribute('aria-label')}`);
  const b1 = await viewerOf(s.win, 1).boundingBox();
  await s.win.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await s.win.keyboard.press('Control+g');
  await s.win.keyboard.type('300');
  await s.win.keyboard.press('Enter');
  await s.win.waitForTimeout(800);
  log(`B0. sync off, pane 2 sent to page 300: ${await both(s.win)}`);
  await s.win.locator('.split-sync').click(); // on
  await s.win.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await wheelOver(s.win, viewerOf(s.win, 1), 300, 2);
  log(`B1. sync on, small wheel in pane 2: ${await both(s.win)}  (relative sync would keep pane 1 near its own page; absolute sync jumps it to ~300)`);

  // --- C. Horizontal split.
  await runCommand(s.win, 'Split horizontal');
  await s.win.waitForTimeout(600);
  const frH = await panes(s.win).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
  log(`C. after "Split horizontal": class=${await s.win.locator('.split').getAttribute('class')} frames=${JSON.stringify(frH)}`);
  const pagesVisible = await panes(s.win).evaluateAll((els) => els.map((e) => e.querySelectorAll('.page-canvas').length));
  log(`C. rendered canvases per pane: ${JSON.stringify(pagesVisible)}`);
  const bh = await viewerOf(s.win, 1).boundingBox();
  await s.win.mouse.click(bh.x + bh.width / 2, bh.y + bh.height / 2);
  await wheelOver(s.win, viewerOf(s.win, 1), 500, 6);
  log(`C1. horizontal, wheel in active pane 2: ${await both(s.win)}`);
  log(`C. errors so far: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);

  // --- D. Two different files side by side with sync.
  s = await openFiles(['mixed-sizes-rotated.pdf', 'big-1000.pdf'], ['Page 1 of 8', 'Page 1 of 1000']);
  await s.win.getByRole('tab').filter({ hasText: 'mixed-sizes-rotated.pdf' }).click();
  await s.win.waitForTimeout(400);
  await s.win.keyboard.press('Control+\\');
  await waitFor(async () => (await panes(s.win).count()) === 2, { label: 'two panes' });
  await s.win.getByRole('combobox', { name: 'Document in this pane' }).nth(1).selectOption({ label: 'big-1000.pdf' });
  await s.win.waitForTimeout(1000);
  const names = await s.win.getByRole('combobox', { name: 'Document in this pane' }).evaluateAll((els) => els.map((e) => e.selectedOptions[0].textContent));
  log(`D. panes: ${names.join(' | ')}; sync=${await s.win.locator('.split-sync').getAttribute('aria-label')}`);
  const d1 = await viewerOf(s.win, 1).boundingBox();
  await s.win.mouse.click(d1.x + d1.width / 2, d1.y + d1.height / 2);
  await wheelOver(s.win, viewerOf(s.win, 1), 400, 6);
  log(`D1. wheel in big-1000 pane (active): ${await both(s.win)}`);
  const d0 = await viewerOf(s.win, 0).boundingBox();
  await s.win.mouse.click(d0.x + d0.width / 2, d0.y + d0.height / 2);
  await wheelOver(s.win, viewerOf(s.win, 0), 400, 4);
  log(`D2. click + wheel in mixed pane: ${await both(s.win)}`);
  log(`D. status: ${await statusText(s.win)}`);
  log(`D. errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);
} finally {
  await closeAll();
}
