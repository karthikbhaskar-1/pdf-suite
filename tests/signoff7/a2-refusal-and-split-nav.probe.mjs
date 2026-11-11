// Sign-Off 7: (1) what the user sees when the cut of boundary-crop.pdf is refused; the file must stay as it was.
// (2) split view: does "Go to page 4" from the status bar hold?
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeAll, open, palette, delay, pageCount, currentPage, waitFor, isDirty, copyTo, wipe, report, openSheet, setOptions, sheetOf, start, FX, statusText } from './lib7.mjs';

const R = report('a2-refusal-and-split-nav');
await R.step('cut of all three pages of boundary-crop.pdf (not a refusal: all three are wide)', async () => {
  const f = copyTo(join(FX, 'boundary-crop.pdf'), 'refuse.pdf');
  const before = readFileSync(f.path);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, f.path, 3);
    const sheet = await openSheet(s, palette);
    await setOptions(sheet, { scope: 'wide' });
    await sheet.getByRole('button', { name: 'Apply' }).click();
    await delay(2500);
    const sheetOpen = (await sheetOf(s.win).count()) > 0;
    const texts = (await s.win.locator('.toast, [role="alert"], [role="status"], .side-error').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    R.say(`INFO  after Apply: sheet open ${sheetOpen}; pages ${await pageCount(s.win)}; dirty ${await isDirty(s.win)}; messages: ${[...new Set(texts)].join(' | ').slice(0, 400)}`);
    R.check('a refused cut leaves 3 pages, a clean document and the file untouched', (await pageCount(s.win)) === 3 && !(await isDirty(s.win)) && readFileSync(f.path).equals(before));
  } finally {
    await s.close();
  }
});
await R.step('split nav', async () => {
  const f = copyTo(join(FX, 'flat5.pdf'), 'nav.pdf');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, f.path, 5);
    const box = s.win.locator('footer.status-bar').getByLabel('Go to page');
    const go = async (n) => { await box.fill(String(n)); await box.press('Enter'); await delay(300); const a = await currentPage(s.win); await delay(2000); return [a, await currentPage(s.win)]; };
    R.say(`INFO  one pane: go to 4 -> box after 0.3 s and 2.3 s: ${await go(4)}`);
    await go(1);
    await palette(s.win, 'Split vertical');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    await delay(2000);
    const r = await go(4);
    R.say(`INFO  split view: go to 4 -> box after 0.3 s and 2.3 s: ${r}; status "${await statusText(s.win)}"`);
    R.check('split view: Go to page 4 holds', r[1] === 4, String(r));
  } finally {
    await s.close();
  }
});
const failed = R.summary();
await closeAll();
wipe();
process.exit(failed ? 1 : 0);
