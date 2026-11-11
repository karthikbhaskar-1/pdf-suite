// Sign-Off 7, probe B5: in split view, which page does "Cut: Current page" act on, and does the status bar name that page?
import { join } from 'node:path';
import { closeAll, open, palette, waitForCount, saveNow, delay, pageCount, currentPage, waitFor, uids, copyTo, wipe, report, readPages, openSheet, setOptions, sheetOf, summaryOf, start, FX, sizesOnDisk } from './lib7.mjs';

const R = report('b5-split');
const snap = async (win, label) => {
  const v = await win.evaluate(() => {
    const frames = [...document.querySelectorAll('.pane-frame')];
    return {
      panes: frames.length,
      active: frames.findIndex((f) => f.classList.contains('pane-active')),
      guides: frames.map((f) => [...f.querySelectorAll('[data-cut-guide]')].map((g) => g.getAttribute('data-cut-guide').split(':').pop())),
      focus: (document.activeElement?.closest('.pane-frame') ? 'pane ' + frames.indexOf(document.activeElement.closest('.pane-frame')) : document.activeElement?.tagName + '.' + (document.activeElement?.className ?? '')),
    };
  });
  R.say(`INFO  ${label}: panes ${v.panes}, active pane ${v.active}, focus ${v.focus}, box ${await currentPage(win)} of ${await pageCount(win)}, guides per pane ${JSON.stringify(v.guides)}`);
  return v;
};
const goTo = async (win, n) => {
  const box = win.locator('footer.status-bar').getByLabel('Go to page');
  await box.fill(String(n));
  await box.press('Enter');
  await waitFor(async () => (await currentPage(win)) === n, { timeoutMs: 10000, label: `page ${n}` });
  await delay(700);
};

await R.step('B5 split view', async () => {
  const f = copyTo(join(FX, 'flat5.pdf'), 'b5.pdf');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, f.path, 5);
    const win = s.win;
    const ids = await uids(win);
    await palette(win, 'Split vertical');
    await waitFor(async () => (await win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    await snap(win, 'after Split vertical');
    await goTo(win, 4);
    const before = await snap(win, 'after going to page 4');
    const sheet = await openSheet(s, palette);
    await setOptions(sheet, { scope: 'current' });
    await delay(500);
    const withSheet = await snap(win, 'Cut sheet open, Apply to = Current page');
    const boxAtApply = await currentPage(win);
    const guided = withSheet.guides.flat();
    R.say(`INFO  summary: ${(await summaryOf(sheet)).trim()}; guide drawn on uid(s) ${guided} = page(s) ${guided.map((u) => ids.indexOf(u) + 1)}`);
    await sheet.getByRole('button', { name: 'Apply' }).click();
    await sheetOf(win).waitFor({ state: 'detached', timeout: 30000 });
    await waitForCount(win, 6);
    await snap(win, 'after Apply');
    await saveNow(win);
    const sizes = readPages(f.path).map((p) => `${p.w}x${p.h}`);
    const cutAt = sizes.findIndex((v) => v === '400x500') + 1;
    R.say(`INFO  on disk: ${sizes.join(' ')}`);
    R.check(`the page that was cut (page ${cutAt}) is the page the status bar named when Apply was pressed (page ${boxAtApply})`, cutAt === boxAtApply, `active pane before the sheet ${before.active}`);
    R.check('the guide was drawn on the page that was cut', guided.length > 0 && guided.every((u) => ids.indexOf(u) + 1 === cutAt), `guide on ${guided.map((u) => ids.indexOf(u) + 1)}`);
    // Now the other pane.
    await palette(win, 'Switch pane');
    await delay(600);
    await snap(win, 'after Switch pane');
    const ids2 = await uids(win);
    const box2 = await currentPage(win);
    const sheet2 = await openSheet(s, palette);
    await setOptions(sheet2, { scope: 'current', direction: 'horizontal' });
    await delay(500);
    const w2 = await snap(win, 'second Cut sheet open (Top and bottom, Current page)');
    const box2b = await currentPage(win);
    await sheet2.getByRole('button', { name: 'Apply' }).click();
    await sheetOf(win).waitFor({ state: 'detached', timeout: 30000 });
    await waitForCount(win, 7);
    await saveNow(win);
    const sizes2 = readPages(f.path).map((p) => `${p.w}x${p.h}`);
    const cut2 = sizes2.findIndex((v) => /x250$/.test(v)) + 1;
    R.say(`INFO  on disk: ${sizes2.join(' ')}; box before the sheet ${box2}, with the sheet ${box2b}; guide on page(s) ${w2.guides.flat().map((u) => ids2.indexOf(u) + 1)}`);
    R.check(`second cut: the page cut top/bottom (page ${cut2}) is the page the status bar named (page ${box2b})`, cut2 === box2b);
  } finally {
    await s.close();
  }
});
const failed = R.summary();
await closeAll();
wipe();
process.exit(failed ? 1 : 0);
