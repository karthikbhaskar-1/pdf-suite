// Probe C: the current page after jumps (the new currentAnchor rule in the scroll path). The page box, the thumbnail
// highlight, the status-bar page info and Properties must agree after jumps to first, last and middle pages, at several
// zooms and fit modes, in a file with mixed page sizes, a one-page file and a 1000-page file. Ordinary wheel scrolling
// must still count pages up and down. A page command after a jump must act on the page the box names (checked on disk).
import { placeWindow } from '../e2e/helpers.mjs';
import {
  launch, closeAll, cleanupProfile, newProfileDir, waitFor, pageCount, delay, showPanel, isDirty, inspect, openMore, fixture,
  watchToasts, toastCount, waitToast, mk, wipeWork, report,
} from './lib.mjs';

const R = report('c-current-page');
const profile = newProfileDir();
let s;
let win;
const box = () => win.locator('footer.status-bar').getByLabel('Go to page');
/** Reads the page box, info and zoom, and finds the highlighted thumbnail. The thumbnail list draws only the rows in view and
 * does not follow the current page by itself, so it is scrolled to where page `hint` should be (then scanned if short). */
const read = (hint) => win.evaluate(async (want) => {
  const boxValue = Number.parseInt(document.querySelector('#status-page-box')?.value ?? '', 10);
  const total = Number.parseInt((document.querySelector('.status-of')?.textContent ?? '').replace(/\D+/g, ''), 10) || 1;
  const list = document.querySelector('.thumb-list');
  const label = () => { const cur = list ? list.querySelectorAll('.thumb-current') : []; return cur.length === 1 ? Number.parseInt(cur[0].querySelector('.thumb-label')?.textContent ?? '', 10) : cur.length === 0 ? null : `x${cur.length}`; };
  const pause = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 70)));
  let thumb = label();
  if (thumb === null && list) {
    const sheet = list.querySelector('.thumb-sheet');
    const H = sheet ? sheet.offsetHeight : list.scrollHeight;
    const max = Math.max(0, H - list.clientHeight);
    const target = Number.isFinite(want) ? want : boxValue;
    const guess = ((target - 1) / total) * H - list.clientHeight / 2;
    const tries = [0, -1, 1, -2, 2, -3, 3].map((k) => Math.min(max, Math.max(0, guess + k * list.clientHeight * 0.8)));
    if (total <= 60) for (let y = 0; y <= max; y += Math.max(100, list.clientHeight * 0.8)) tries.push(y), tries.push(max);
    for (const y of tries) { list.scrollTop = y; await pause(); thumb = label(); if (thumb !== null) break; }
  }
  return {
    box: boxValue,
    thumb,
    info: document.querySelector('.status-info')?.textContent?.trim() ?? '',
    zoom: document.querySelector('input[aria-label="Zoom level"]')?.value ?? '',
  };
}, hint);
/** Scrolls the thumbnail list so the row of page n is drawn, then clicks it. */
async function clickThumb(n) {
  await win.evaluate(async (want) => {
    const list = document.querySelector('.thumb-list');
    const total = Number.parseInt((document.querySelector('.status-of')?.textContent ?? '').replace(/\D+/g, ''), 10) || 1;
    const sheet = list.querySelector('.thumb-sheet');
    const H = sheet ? sheet.offsetHeight : list.scrollHeight;
    const max = Math.max(0, H - list.clientHeight);
    const has = () => [...list.querySelectorAll('.thumb-label')].some((l) => l.textContent.trim() === String(want));
    for (let y = 0; y <= max + 1 && !has(); y += Math.max(100, list.clientHeight * 0.7)) { list.scrollTop = Math.min(max, y); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80))); }
  }, n);
  await win.locator('.thumb', { has: win.locator('.thumb-label', { hasText: new RegExp(`^${n}$`) }) }).click({ timeout: 5000 });
}
/** Puts the mouse over the page area (the text layer covers the canvas, so a locator hover would wait for ever). */
async function overPage() {
  const bb = await win.locator('.page-canvas').first().boundingBox();
  const vh = await win.evaluate(() => innerHeight);
  await win.mouse.move(bb.x + Math.min(200, bb.width / 2), Math.min(vh - 120, Math.max(bb.y + 60, 200)));
}
async function settle(n) {
  try { await waitFor(async () => (await win.evaluate(() => Number.parseInt(document.querySelector('#status-page-box')?.value ?? '', 10))) === n, { timeoutMs: 1500, intervalMs: 40, label: 'box' }); } catch { /* reported by the caller */ }
  await delay(350);
  return read(n);
}
async function typePage(n) { await box().fill(String(n)); await box().press('Enter'); }
async function setZoom(z) {
  if (z === 'fitPage' || z === 'fitWidth') await win.locator('footer.status-bar').getByRole('button', { name: z === 'fitPage' ? 'Fit page' : 'Fit width', exact: true }).click();
  else { const i = win.locator('footer.status-bar').getByLabel('Zoom level'); await i.fill(String(z)); await i.press('Enter'); }
  await delay(700);
}
async function closeEverything() {
  for (let i = 0; i < 6; i++) {
    if ((await win.getByRole('tab').count()) === 0) return;
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+Shift+w');
    await delay(400);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(400);
  }
}
const propsSize = async () => {
  await showPanel(win, 'Properties');
  await delay(400);
  const t = await win.evaluate(() => [...document.querySelectorAll('.props-row')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter((x) => /^(Size|Rotation|Page)/i.test(x)).join(' | '));
  await showPanel(win, 'Thumbnails');
  await delay(300);
  return t;
};

try {
  s = await launch({ profile });
  win = s.win;
  await placeWindow(s, { width: 1400, height: 800 });
  await win.waitForSelector('.empty-state');
  await watchToasts(win);

  // ---------- 8 pages of mixed sizes and rotations
  await R.step('mixed', async () => {
    const c = mk('mixed-sizes-rotated.pdf', 'mixed.pdf');
    const disk = inspect(c.path, undefined, { text: false });
    await openMore(s, c.path, 8, 1);
    await showPanel(win, 'Thumbnails');
    // Reference: in Fit page every page comes to the top, so the info text there is the page's own.
    await setZoom('fitPage');
    const ref = {};
    const pref = {};
    for (let n = 1; n <= 8; n++) { await typePage(n); const r = await settle(n); ref[n] = r.info; if (r.box !== n || r.thumb !== n) R.check(`reference pass: page ${n} in Fit page`, false, JSON.stringify(r)); }
    for (const n of [1, 7, 8]) { await typePage(n); await settle(n); pref[n] = await propsSize(); }
    R.info(`reference info texts: ${JSON.stringify(ref)}`);
    R.info(`reference Properties: ${JSON.stringify(pref)}`);
    R.info(`disk: ${disk.pages.map((p, i) => `${i + 1}:${p.media?.slice(2).join('x')}/r${p.rotate}`).join(' ')}`);
    R.check('the 8 pages give at least 4 different info texts (so the info can tell pages apart)', new Set(Object.values(ref)).size >= 4, `${new Set(Object.values(ref)).size} distinct`);

    let total = 0;
    const wrong = [];
    const one = async (zoom, how, n, act) => {
      await act();
      const r = await settle(n);
      total++;
      if (r.box !== n || r.thumb !== n || r.info !== ref[n]) wrong.push(`${zoom}/${how} -> ${n}: box ${r.box}, thumbnail ${r.thumb}, info "${r.info}" (want "${ref[n]}")`);
    };
    for (const zoom of ['fitPage', 'fitWidth', 25, 50, 100, 200, 400]) {
      await typePage(1);
      await setZoom(zoom);
      for (const n of [8, 1, 7, 4, 8, 6, 2, 8, 5, 3]) await one(zoom, 'typed', n, () => typePage(n));
      await typePage(6); await settle(6);
      const next = win.locator('.top-bar').getByRole('button', { name: 'Next page', exact: true });
      const prev = win.locator('.top-bar').getByRole('button', { name: 'Previous page', exact: true });
      await one(zoom, 'Next', 7, () => next.click());
      await one(zoom, 'Next', 8, () => next.click());
      if (await next.isEnabled()) await one(zoom, 'Next at the end', 8, () => next.click());
      await one(zoom, 'Previous', 7, () => prev.click());
      await one(zoom, 'Previous', 6, () => prev.click());
      for (const n of [8, 7, 1]) await one(zoom, 'thumbnail click', n, () => clickThumb(n));
      // Properties agrees for the last two pages and the first.
      for (const n of [8, 7, 1]) { await typePage(n); await settle(n); const p = await propsSize(); total++; if (p !== pref[n]) wrong.push(`${zoom}/Properties after typed ${n}: "${p}" (want "${pref[n]}")`); const r = await read(); if (r.box !== n) wrong.push(`${zoom}: page box moved to ${r.box} after opening Properties on page ${n}`); }
    }
    R.check(`mixed sizes, 7 zoom settings: page box, thumbnail highlight, page info and Properties agree after every jump (${total} jumps)`, wrong.length === 0, wrong.slice(0, 12).join(' ;; ') + (wrong.length > 12 ? ` ... and ${wrong.length - 12} more` : ''));

    // Ordinary wheel scrolling at two zooms: the page number only goes up on the way down and only down on the way up.
    for (const zoom of [50, 100]) {
      await typePage(1); await setZoom(zoom); await typePage(1); await settle(1);
      await overPage();
      const down = []; const mism = [];
      for (let i = 0; i < 120; i++) { await win.mouse.wheel(0, 240); await delay(110); const r = await read(); down.push(r.box); if (r.thumb !== r.box) { await delay(250); const r2 = await read(); if (r2.thumb !== r2.box) mism.push(`down step ${i}: box ${r2.box} thumbnail ${r2.thumb}`); } if (down.length > 6 && down.slice(-6).every((v) => v === 8)) break; }
      const up = [];
      for (let i = 0; i < 120; i++) { await win.mouse.wheel(0, -240); await delay(110); const r = await read(); up.push(r.box); if (up.length > 6 && up.slice(-6).every((v) => v === 1)) break; }
      const mono = (a, dir) => a.every((v, i) => i === 0 || (dir > 0 ? v >= a[i - 1] : v <= a[i - 1]));
      const seen = [...new Set(down)].join(',');
      R.check(`wheel scrolling at ${zoom}%: counts up to 8 and back down to 1 with no jump backwards; thumbnail follows`, mono(down, 1) && down.at(-1) === 8 && mono(up, -1) && up.at(-1) === 1 && mism.length === 0, `down saw ${seen}; up saw ${[...new Set(up)].join(',')}; ${mism.slice(0, 4).join('; ')}`);
      R.info(`wheel at ${zoom}%: pages seen on the way down: ${seen}`);
    }

    // After a jump to the last page, a small scroll up lets go of the jump: the box follows the top of the view again.
    await setZoom(50); await typePage(8); const at8 = await settle(8);
    await overPage(); await win.mouse.wheel(0, -120); await delay(500);
    const after = await read();
    R.info(`50%: jump to 8 shows ${at8.box}; one wheel notch up shows box ${after.box}, thumbnail ${after.thumb}`);
    R.check('after a jump and a small scroll, box and thumbnail still agree', after.box === after.thumb, JSON.stringify(after));
    await typePage(8); await settle(8); await setZoom(200); const z = await read();
    R.info(`jump to 8 at 50%, then zoom to 200%: box ${z.box}, thumbnail ${z.thumb}, info "${z.info}" (page 8 info is "${ref[8]}")`);
    R.check('after a jump and a zoom change, box, thumbnail and info still agree with each other', z.box === z.thumb && z.info === ref[z.box], JSON.stringify(z));
  });
  await closeEverything();

  // ---------- a page command after a jump acts on the page the box names
  await R.step('command after jump', async () => {
    const c = mk('mixed-sizes-rotated.pdf', 'rotate.pdf');
    const before = inspect(c.path, undefined, { text: false }).pages.map((p) => p.rotate);
    await openMore(s, c.path, 8, 1);
    await showPanel(win, 'Thumbnails');
    await setZoom(50);
    const rot = win.locator('.thumb-toolbar').getByRole('button', { name: 'Rotate right 90°' });
    await typePage(7); await settle(7);
    await rot.click(); await delay(900);
    await typePage(8); await settle(8);
    await rot.click(); await delay(900); await rot.click(); await delay(900);
    const from = await toastCount(win);
    await win.keyboard.press('Control+s');
    const t = await waitToast(win, from, /^Saved /, 20000);
    await delay(400);
    const after = inspect(c.path, undefined, { text: false }).pages.map((p) => p.rotate);
    const delta = after.map((r, i) => (((r - before[i]) % 360) + 360) % 360);
    R.check('at 50%: typed 7 + Rotate, typed 8 + Rotate twice, Save: on disk only page 7 turned 90 and page 8 turned 180', !!t && JSON.stringify(delta) === JSON.stringify([0, 0, 0, 0, 0, 0, 90, 180]), `before ${before} after ${after} delta ${delta} toast=${JSON.stringify(t)} dirty=${await isDirty(win)}`);
  });
  await closeEverything();

  // ---------- one page
  await R.step('one page', async () => {
    const name = ['margins-white.pdf', 'search-align.pdf', 'annotated-links.pdf'].find((f) => inspect(fixture(f), undefined, { text: false }).count === 1);
    if (!name) { R.info('no one-page fixture found: skipped'); return; }
    const c = mk(name, 'single.pdf');
    await openMore(s, c.path, 1, 1);
    await showPanel(win, 'Thumbnails');
    const wrong = [];
    for (const zoom of ['fitPage', 'fitWidth', 50, 100, 400]) {
      await setZoom(zoom);
      for (const typed of [1, 5, 0, 1]) { await typePage(typed); await delay(450); const r = await read(); if (r.box !== 1 || r.thumb !== 1) wrong.push(`${zoom}: typed ${typed} -> box ${r.box}, thumbnail ${r.thumb}`); }
      await overPage(); await win.mouse.wheel(0, 2000); await delay(300); await win.mouse.wheel(0, -2000); await delay(300);
      const r = await read(); if (r.box !== 1 || r.thumb !== 1) wrong.push(`${zoom}: after scrolling -> box ${r.box}, thumbnail ${r.thumb}`);
    }
    R.check(`one-page file (${name}): always page 1 of 1 at 5 zoom settings, typed 1, 5 and 0, and after scrolling`, wrong.length === 0 && (await pageCount(win)) === 1, wrong.join(' ;; '));
  });
  await closeEverything();

  // ---------- 1000 pages
  await R.step('1000 pages', async () => {
    const c = mk('big-1000.pdf', 'big.pdf');
    await openMore(s, c.path, 1000, 1);
    await showPanel(win, 'Thumbnails');
    const wrong = [];
    let total = 0;
    for (const zoom of ['fitPage', 100, 25]) {
      await setZoom(zoom);
      for (const n of [1000, 1, 500, 999, 1000, 2, 998, 1000]) {
        await typePage(n);
        let r = await settle(n);
        if (r.thumb !== n) { await delay(900); r = await read(n); }
        total++;
        if (r.box !== n || r.thumb !== n) wrong.push(`${zoom} -> ${n}: box ${r.box}, thumbnail ${r.thumb}`);
      }
    }
    R.check(`1000-page file: page box and thumbnail highlight agree after ${total} jumps (first, last, middle, next to last) at 3 zoom settings`, wrong.length === 0, wrong.slice(0, 10).join(' ;; '));
  });
  await closeEverything();
  const errs = s.errors.filter((e) => !/favicon/.test(e));
  R.check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 400));
} catch (err) {
  R.check('probe ran to the end', false, String(err && err.stack ? err.stack : err).slice(0, 600));
} finally {
  await closeAll();
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
