// Sign-off gaps: split sync moves both panes from either pane and keeps their gap; Properties follows the
// clicked page, thumbnail and right-click; search highlights sit on the matched glyphs at 100% and 400%.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launch, fixture, statusText, waitFor, waitForPage, closeAll, cleanupProfile } from './helpers.mjs';

after(closeAll);

async function openFile(s, name, status) {
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([fixture(name)]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, status, { timeoutMs: 60000 });
}

/** Goes to a page through the page box, as a user does. Acts on the focused pane. */
async function gotoPage(s, number) {
  const box = s.win.getByLabel('Page number');
  await box.click();
  await box.fill(String(number));
  await box.press('Enter');
}

/** Wheel over one viewer (by its order on screen), then wait for the scroll and the sync to settle. */
async function wheelOver(win, viewerIndex, dy, times) {
  const viewer = win.locator('.viewer').nth(viewerIndex);
  const b = await viewer.boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let k = 0; k < times; k++) {
    await win.mouse.wheel(0, dy);
    await win.waitForTimeout(60);
  }
  await win.waitForTimeout(800);
}

/**
 * Page-relative position of the top of each viewer on screen: the index of the page at the top, plus the
 * fraction of that page above the top edge. One page is 1, so this does not depend on zoom or on rotation.
 */
function positionsOf(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('.viewer')].map((v) => {
      const vr = v.getBoundingClientRect();
      const pages = [...v.querySelectorAll('.page')].sort((a, b) => Number(a.dataset.pageIndex) - Number(b.dataset.pageIndex));
      for (const p of pages) {
        const r = p.getBoundingClientRect();
        if (r.bottom > vr.top + 1) return Number(p.dataset.pageIndex) + (vr.top - r.top) / r.height;
      }
      return Number.NaN;
    }),
  );
}

test('split sync: scrolling either pane moves the other by the same page amount, and a 285-page gap is kept', async () => {
  const s = await launch();
  try {
    await openFile(s, 'big-1000.pdf', 'Page 1 of 1000');
    await s.win.keyboard.press('Control+\\');
    await s.win.locator('.pane-frame').nth(1).waitFor({ timeout: 10000 });
    const syncButton = s.win.locator('.split-sync');
    assert.equal(await syncButton.getAttribute('aria-label'), 'Sync scroll: on', 'sync is on after a split');

    // A. Start from the active pane (2), then from pane 1, by wheel. Both panes must move, and by the same amount.
    await waitFor(async () => (await positionsOf(s.win)).every(Number.isFinite), { timeoutMs: 10000, label: 'both panes show a page' });
    const start = await positionsOf(s.win);
    await wheelOver(s.win, 1, 400, 6);
    const afterPane2 = await positionsOf(s.win);
    const pane2Moved = afterPane2[1] - start[1];
    const pane1MovedA = afterPane2[0] - start[0];
    console.log(`  measured: from pane 2: pane 2 moved ${pane2Moved.toFixed(3)} pages, pane 1 moved ${pane1MovedA.toFixed(3)} pages`);
    assert.ok(pane2Moved > 1, `pane 2 moved ${pane2Moved} pages`);
    assert.ok(Math.abs(pane1MovedA - pane2Moved) < 0.05, `pane 1 moved ${pane1MovedA} pages, pane 2 moved ${pane2Moved}`);

    await wheelOver(s.win, 0, -200, 3);
    const afterPane1 = await positionsOf(s.win);
    const pane1Moved = afterPane1[0] - afterPane2[0];
    const pane2MovedB = afterPane1[1] - afterPane2[1];
    console.log(`  measured: from pane 1: pane 1 moved ${pane1Moved.toFixed(3)} pages, pane 2 moved ${pane2MovedB.toFixed(3)} pages`);
    assert.ok(pane1Moved < -0.5, `pane 1 moved ${pane1Moved} pages (up)`);
    assert.ok(Math.abs(pane2MovedB - pane1Moved) < 0.05, `pane 2 moved ${pane2MovedB} pages, pane 1 moved ${pane1Moved}`);

    // B. Gap. Sync off while the panes are put far apart: pane 1 at page 15, pane 2 at page 300.
    await syncButton.click();
    assert.equal(await syncButton.getAttribute('aria-label'), 'Sync scroll: off');
    await s.win.locator('.viewer').nth(0).click({ position: { x: 20, y: 20 } });
    await gotoPage(s, 15);
    await waitForPage(s, 'Page 15 of 1000', { timeoutMs: 10000 });
    await s.win.locator('.viewer').nth(1).click({ position: { x: 20, y: 20 } });
    await gotoPage(s, 300);
    await waitForPage(s, 'Page 300 of 1000', { timeoutMs: 10000 });
    await s.win.waitForTimeout(500);
    const [p1, p2] = await positionsOf(s.win);
    const gapBefore = p2 - p1;
    console.log(`  measured: sync off, pane 1 at ${p1.toFixed(2)}, pane 2 at ${p2.toFixed(2)}, gap ${gapBefore.toFixed(2)} pages`);
    assert.ok(Math.abs(gapBefore - 285) < 0.2, `gap before sync ${gapBefore}`);

    // Turning sync on copies nothing: the gap is still 285 pages.
    await syncButton.click();
    await s.win.waitForTimeout(500);
    const [q1, q2] = await positionsOf(s.win);
    assert.ok(Math.abs(q2 - q1 - 285) < 0.2, `gap right after sync on ${q2 - q1}`);

    // Changing the split to stacked panes resizes both panes. The gap must still be 285 pages.
    await s.win.keyboard.press('Control+k');
    await s.win.getByLabel('Type a command').fill('Split horizontal');
    await s.win.keyboard.press('Enter');
    await s.win.waitForTimeout(800);
    const [h1, h2] = await positionsOf(s.win);
    console.log(`  measured: after Split horizontal, pane 1 ${h1.toFixed(2)}, pane 2 ${h2.toFixed(2)}, gap ${(h2 - h1).toFixed(2)} pages`);
    assert.ok(Math.abs(h2 - h1 - 285) < 0.2, `gap after changing the split direction ${h2 - h1}`);

    // Scroll pane 1 (not the active one), then pane 2, then pane 1 again: the gap must stay 285 pages.
    for (const [viewer, dy, times] of [[0, 300, 4], [1, -300, 3], [0, 400, 2]]) {
      const before = await positionsOf(s.win);
      await wheelOver(s.win, viewer, dy, times);
      const after = await positionsOf(s.win);
      const gap = after[1] - after[0];
      console.log(`  measured: wheel pane ${viewer + 1}: pane 1 ${after[0].toFixed(2)}, pane 2 ${after[1].toFixed(2)}, gap ${gap.toFixed(2)}`);
      assert.ok(Math.abs(after[0] - before[0]) > 0.5, `pane 1 should move when pane ${viewer + 1} is scrolled`);
      assert.ok(Math.abs(gap - 285) < 0.1, `gap after scrolling pane ${viewer + 1}: ${gap}`);
    }
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('Properties describes the page clicked in the viewer, the thumbnail clicked, and the right-clicked page', async () => {
  const s = await launch();
  try {
    await openFile(s, 'big-1000.pdf', 'Page 1 of 1000');
    await s.win.getByRole('button', { name: 'Properties', exact: true }).click();
    const props = s.win.getByRole('complementary', { name: 'Properties', exact: true });
    await props.waitFor({ timeout: 5000 });
    const number = async () => (await props.locator('section[aria-label="Current page"] dd, section[aria-label="Selected page"] dd').first().innerText()).trim();

    assert.equal(await number(), '1', 'nothing picked: the page at the top is described');
    await gotoPage(s, 500);
    await waitForPage(s, 'Page 500 of 1000', { timeoutMs: 10000 });
    await s.win.waitForTimeout(300);
    assert.equal(await number(), '500', 'after Go to page 500 with nothing picked, the current page is described');

    // Zoom out so several pages are on screen. Then click a page below the one at the top of the view, so the
    // clicked page differs from the page the viewer is showing. The panel must follow the click.
    await gotoPage(s, 6);
    await waitForPage(s, 'Page 6 of 1000', { timeoutMs: 10000 });
    for (let i = 0; i < 4; i++) await s.win.keyboard.press('Control+-');
    await waitFor(async () => (await visiblePages(s.win)).length >= 2, { timeoutMs: 10000, label: 'two pages on screen' });
    const onScreen = await visiblePages(s.win);
    const clicked = onScreen[onScreen.length - 1];
    console.log(`  measured: pages on screen ${JSON.stringify(onScreen)}; clicking page ${clicked}`);
    await clickPage(s.win, clicked);
    await waitFor(async () => (await number()) === String(clicked), { timeoutMs: 5000, label: `Properties shows page ${clicked} after clicking it` });
    // A picked page stays picked when the view moves; only a tab or document change clears it.
    await gotoPage(s, 8);
    await waitForPage(s, 'Page 8 of 1000', { timeoutMs: 10000 });
    await s.win.waitForTimeout(300);
    assert.equal(await number(), String(clicked), 'the picked page stays described after Go to page 8');

    // Click thumbnail 7.
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
    // The thumbnail list is virtualized: row 7 is only in the DOM once the list has scrolled near it.
    const thumb7 = s.win.locator('.thumb[role="option"]').filter({ has: s.win.locator('.thumb-label', { hasText: /^7$/ }) });
    await waitFor(
      async () => {
        if ((await thumb7.count()) > 0) return true;
        await s.win.locator('.thumb-list').evaluate((e) => {
          e.scrollTop += 120;
        });
        return false;
      },
      { timeoutMs: 10000, label: 'thumbnail 7 drawn' },
    );
    await thumb7.click();
    await waitForPage(s, 'Page 7 of 1000', { timeoutMs: 10000 });
    await s.win.getByRole('button', { name: 'Properties', exact: true }).click();
    await waitFor(async () => (await number()) === '7', { timeoutMs: 5000, label: 'Properties shows page 7 after clicking thumbnail 7' });

    // Right-click page 3 and choose Properties.
    await gotoPage(s, 3);
    await waitForPage(s, 'Page 3 of 1000', { timeoutMs: 10000 });
    await rightClickPage(s.win, 3);
    await s.win.getByRole('menuitem', { name: /^Properties/ }).click();
    await waitFor(async () => (await number()) === '3', { timeoutMs: 5000, label: 'Properties shows page 3 after right-click > Properties' });
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

/** Page numbers (1-based) of the pages that are on screen in the viewer, top to bottom. */
function visiblePages(win) {
  return win.evaluate(() => {
    const v = document.querySelector('.viewer').getBoundingClientRect();
    return [...document.querySelectorAll('.viewer .page')]
      .filter((p) => {
        const r = p.getBoundingClientRect();
        return r.top < v.bottom - 40 && r.bottom > v.top + 40;
      })
      .map((p) => Number(p.dataset.pageIndex) + 1)
      .sort((a, b) => a - b);
  });
}

/** A point on a page that is on screen in the viewer, in client coordinates. */
async function pointOnPage(win, pageNumber) {
  const page = await win.locator(`.viewer .page[data-page-index="${pageNumber - 1}"]`).boundingBox();
  const viewer = await win.locator('.viewer').first().boundingBox();
  const y = Math.min(page.y + page.height - 20, Math.max(page.y + 20, viewer.y + 40));
  return { x: page.x + page.width / 2, y };
}

async function clickPage(win, pageNumber) {
  const p = await pointOnPage(win, pageNumber);
  await win.mouse.click(p.x, p.y);
}

async function rightClickPage(win, pageNumber) {
  const p = await pointOnPage(win, pageNumber);
  await win.mouse.click(p.x, p.y, { button: 'right' });
}

/** Sets the zoom by typing it into the status bar's zoom box (the zoom controls moved there in 1.2.2), so a test never depends on the zoom a document opens at. */
async function setZoomPercent(win, percent) {
  const box = win.getByLabel('Zoom level');
  await box.fill(String(percent));
  await box.press('Enter');
  await waitFor(async () => (await statusText(win)).includes(`${percent}%`), { timeoutMs: 5000, label: `zoom ${percent}%` });
  await win.waitForTimeout(500);
}

test('search highlights cover the matched glyphs within 10% of the word width, at fit-page (opening zoom), 100% and 400% zoom', async () => {
  const s = await launch();
  try {
    const expected = JSON.parse(readFileSync(fixture('search-align.json'), 'utf8'));
    await openFile(s, 'search-align.pdf', 'Page 1 of 1');
    // The document opens at fit-page; that zoom is measured first, then 100% and 400% are set explicitly.
    for (const zoomTo of ['opening', 100, 400]) {
      if (zoomTo !== 'opening') await setZoomPercent(s.win, zoomTo);
      await s.win.waitForTimeout(500);
      for (const word of ['zephyrbloom', 'qwertarget']) {
        await s.win.keyboard.press('Control+f');
        await s.win.getByLabel('Find in document').fill(word);
        const want = expected.filter((e) => e.word === word).length;
        await waitFor(async () => (await s.win.locator('.search-hit').count()) === want, { timeoutMs: 10000, label: `${want} highlights for ${word}` });
        // Fit-page re-fits when the find bar changes the viewer height, so the zoom is read after it has settled.
        await s.win.waitForTimeout(500);
        const zoom = Number((await statusText(s.win)).match(/(\d+)%/)[1]) / 100;
        const hits = await s.win.locator('.search-hit').evaluateAll((els) => {
          const page = document.querySelector('.page[data-page-index="0"]').getBoundingClientRect();
          return els.map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.left - page.left, y: r.top - page.top, w: r.width, h: r.height };
          });
        });
        // Highlights in pt, in the same order as the expected words (top to bottom).
        hits.sort((a, b) => a.y - b.y);
        const exp = expected.filter((e) => e.word === word).sort((a, b) => a.y - b.y);
        exp.forEach((e, i) => {
          const h = hits[i];
          const x = h.x / zoom;
          const w = h.w / zoom;
          const y = h.y / zoom;
          const height = h.h / zoom;
          console.log(`  ${Math.round(zoom * 100)}% "${word}" line ${e.line}: highlight x ${x.toFixed(1)} w ${w.toFixed(1)}; glyph box x ${e.x.toFixed(1)} w ${e.width.toFixed(1)}`);
          assert.ok(Math.abs(x - e.x) <= 0.1 * e.width, `left edge off by ${(x - e.x).toFixed(2)} pt for "${word}" at ${zoom * 100}%`);
          assert.ok(Math.abs(w - e.width) <= 0.1 * e.width, `width off by ${(w - e.width).toFixed(2)} pt for "${word}" at ${zoom * 100}%`);
          // Vertical overlap with the line of text (12 pt type).
          assert.ok(y < e.y + 12 && y + height > e.y, `highlight at y ${y.toFixed(1)} does not sit on the line at ${e.y}`);
        });
        await s.win.keyboard.press('Escape');
      }
    }
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});

test('at 400% zoom the current search match is scrolled into view horizontally, one match after another', async () => {
  const s = await launch();
  try {
    await openFile(s, 'search-align.pdf', 'Page 1 of 1');
    await setZoomPercent(s.win, 400);
    const zoom = Number((await statusText(s.win)).match(/(\d+)%/)[1]) / 100;
    assert.equal(zoom, 4, `zoom is ${zoom * 100}%`);
    // Start with the page scrolled to the left, so the matches on the right are outside the viewer.
    await s.win.locator('.viewer').first().evaluate((e) => {
      e.scrollLeft = 0;
    });
    await s.win.keyboard.press('Control+f');
    await s.win.getByLabel('Find in document').fill('qwertarget');
    await waitFor(async () => (await s.win.locator('.search-hit').count()) === 3, { timeoutMs: 10000, label: '3 matches for qwertarget' });
    const viewer = await s.win.locator('.viewer').first().boundingBox();
    const scrolledRight = [];
    for (let step = 0; step < 3; step++) {
      await waitFor(async () => (await s.win.locator('.search-hit-current').count()) === 1, { timeoutMs: 5000, label: 'current match' });
      await s.win.waitForTimeout(300);
      const cur = await s.win.locator('.search-hit-current').boundingBox();
      scrolledRight.push(await s.win.locator('.viewer').first().evaluate((e) => Math.round(e.scrollLeft)));
      console.log(`  match ${step + 1}: x ${Math.round(cur.x)}..${Math.round(cur.x + cur.width)}, viewer x ${Math.round(viewer.x)}..${Math.round(viewer.x + viewer.width)}`);
      assert.ok(cur.x >= viewer.x - 1 && cur.x + cur.width <= viewer.x + viewer.width + 1, `current match ${step + 1} is outside the viewer horizontally`);
      await s.win.keyboard.press('F3');
    }
    assert.ok(scrolledRight.some((x) => x > 0), 'the viewer scrolled horizontally to reach a match');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
});
