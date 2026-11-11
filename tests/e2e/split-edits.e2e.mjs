// Two split panes on the same document must stay identical while the document is edited: the rendered pages of each
// pane (index, size, and a hash of the pixels) are compared after delete, move and rotate, and the thumbnail count
// follows the page count. Sync scroll is turned on first, so both panes show the same pages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, closeAll, copyOf, removeCopy, open, palette, waitForCount, pageCount, assertNoErrors, waitFor, delay } from './matrix-lib.mjs';

after(closeAll);

const MIXED = 'mixed-sizes-rotated.pdf';

/**
 * What each pane draws: for every rendered page of the pane, its index, its CSS size and a hash of its pixels (sampled
 * every 6 px, so it is cheap). Two panes that show the same document give the same snapshot.
 */
async function snapshot(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('.pane-frame')].map((frame) =>
      [...frame.querySelectorAll('.page')].map((page) => {
        const canvas = page.querySelector('.page-canvas');
        let hash = 'none';
        if (canvas instanceof HTMLCanvasElement && canvas.width > 0) {
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let h = 2166136261;
          for (let y = 0; y < canvas.height; y += 6) {
            for (let x = 0; x < canvas.width; x += 6) {
              const i = (y * canvas.width + x) * 4;
              h = Math.imul(h ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619) >>> 0;
            }
          }
          hash = h.toString(16);
        }
        return {
          index: Number(page.dataset.pageIndex),
          width: Math.round(Number.parseFloat(page.style.width)),
          height: Math.round(Number.parseFloat(page.style.height)),
          hash,
        };
      }),
    ),
  );
}

/** True when both panes drew pages and drew the same thing. Empty panes never count as identical. */
function sameNonEmpty(snap) {
  return !!snap && snap.length === 2 && snap[0].length > 0 && snap[1].length > 0 && JSON.stringify(snap[0]) === JSON.stringify(snap[1]);
}

/** Waits until both panes have drawn pages and show the same snapshot, then returns the snapshots. */
async function waitForIdenticalPanes(win, label) {
  let last;
  await waitFor(
    async () => {
      last = await snapshot(win);
      if (last.length !== 2 || last[0].length === 0) return false;
      return JSON.stringify(last[0]) === JSON.stringify(last[1]);
    },
    { timeoutMs: 30000, intervalMs: 300, label },
  ).catch(() => undefined);
  return last;
}

test('two split panes on the same document stay identical through delete, move and rotate', async () => {
  const copy = copyOf(MIXED);
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, copy.path, 8);
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
    const sync = s.win.locator('.split-sync');
    if ((await sync.getAttribute('aria-label')) === 'Sync scroll: off') await sync.click();
    await delay(800);

    const start = await waitForIdenticalPanes(s.win, 'panes identical after split');
    assert.ok(start && sameNonEmpty(start), `panes identical after the split: ${JSON.stringify(start)?.slice(0, 300)}`);

    // Delete the current page (page 1).
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 7);
    const afterDelete = await waitForIdenticalPanes(s.win, 'panes identical after delete');
    assert.ok(afterDelete && sameNonEmpty(afterDelete), 'the two panes are identical after delete');

    // Move the current page to the end.
    await palette(s.win, 'Pages: Move to the end');
    await delay(800);
    const afterMove = await waitForIdenticalPanes(s.win, 'panes identical after move');
    assert.ok(afterMove && sameNonEmpty(afterMove), 'the two panes are identical after move');

    // Rotate the current page right.
    await palette(s.win, 'Pages: Rotate right 90°');
    await delay(800);
    const afterRotate = await waitForIdenticalPanes(s.win, 'panes identical after rotate');
    assert.ok(afterRotate && sameNonEmpty(afterRotate), 'the two panes are identical after rotate');

    // The thumbnails follow the document too.
    assert.equal(await pageCount(s.win), 7);
    await waitForCount(s.win, 7);
    assertNoErrors(s);
  } finally {
    await s.close();
    removeCopy(copy);
  }
});
