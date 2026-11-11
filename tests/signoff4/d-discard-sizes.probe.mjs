// Probe D (round-1 gap 3): after Discard on the recovery bar, every page must have the size it has in the file, in the
// viewer, the thumbnails and Properties, exactly as a fresh open. Tried with edits that change every size, and with a
// split view open when Discard is pressed. Then a further edit and save on the discarded document.
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, waitFor, delay, newProfileDir, cleanupProfile, forceKill,
  makeReport, watchToasts, toastAfter, menu, sheet, shot, inspect, brief, isDirty, uids, lastScan, currentPageSize, showPanel, statusText, selectAllPages,
} from './lib.mjs';

const R = makeReport('d-discard-sizes');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
const recOf = (profile) => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : []);

/** What a user sees of every page: Properties size, the page's box in the viewer, and its thumbnail row. */
async function layout(win) {
  const ids = await uids(win);
  const tops = (lastScan.tops ?? []).map((t) => Math.round(t));
  const out = { count: ids.length, thumbTops: tops, thumbListHeight: Math.round(lastScan.scrollHeight ?? 0), pages: [] };
  for (let i = 0; i < ids.length; i++) {
    await jumpTo(win, i);
    await waitFor(async () => (await statusText(win)).startsWith(`Page ${i + 1} of`), { timeoutMs: 8000, label: `page ${i + 1} current` });
    const size = await currentPageSize(win);
    await delay(250);
    const box = await win.evaluate((index) => {
      const el = document.querySelector(`.page[data-page-index="${index}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const c = el.querySelector('.page-canvas');
      return { w: Math.round(r.width), h: Math.round(r.height), canvas: c ? `${c.width}x${c.height}` : 'none' };
    }, i);
    const thumb = await win.evaluate(() => {
      const el = document.querySelector('.thumb-current');
      if (!el) return null;
      const img = el.querySelector('canvas, img, .thumb-image');
      const r = (img ?? el).getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    });
    out.pages.push(`${size.width}x${size.height} view ${box ? `${box.w}x${box.h}` : 'none'} thumb ${thumb}`);
  }
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function scenario(label, { split }) {
  const profile = newProfileDir();
  const c = mk('mixed-sizes-rotated.pdf');
  const original = readFileSync(c.path);
  s = await launch({ profile });
  let win = s.win;
  await win.waitForSelector('.empty-state');
  await open(s, c.path, 8);
  await watchToasts(win);
  const fresh = await layout(win);
  R.info(`${label} fresh open: ${JSON.stringify(fresh)}`);

  // Edits that change every size, the order and the count.
  await selectAllPages(win);
  await menu(win, 'Pages', 'Page Size…');
  const d = sheet(win, 'Page size');
  await d.getByRole('radio', { name: 'A4' }).click();
  await d.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
  await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
  await jumpTo(win, 0);
  await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
  await jumpTo(win, 4);
  await toastAfter(win, () => win.keyboard.press('Delete'));
  await waitForCount(win, 7);
  await jumpTo(win, 6);
  await menu(win, 'Pages', 'Insert Grid Page…');
  const ins = sheet(win, 'Insert pages');
  await ins.getByRole('combobox', { name: 'Page size' }).selectOption('legal');
  await toastAfter(win, () => ins.getByRole('button', { name: 'Apply' }).click());
  await waitForCount(win, 8);
  await jumpTo(win, 1);
  await menu(win, 'Pages', 'Crop Pages…');
  const crop = sheet(win, 'Crop pages');
  await crop.getByRole('combobox', { name: 'Units' }).selectOption('in');
  for (const edge of ['Top', 'Bottom', 'Left', 'Right']) await crop.getByRole('spinbutton', { name: `${edge} margin` }).fill('1.5');
  await toastAfter(win, () => crop.getByRole('button', { name: 'Apply' }).click());
  await delay(1500);
  const edited = await layout(win);
  await delay(600);
  await forceKill(s.app);
  await delay(800);
  R.check(`${label} crash: file untouched, log on disk`, readFileSync(c.path).equals(original) && recOf(profile).some((f) => f.endsWith('.json')), recOf(profile).join(','));

  s = await launch({ profile });
  win = s.win;
  await waitFor(async () => /Page \d+ of \d+/.test(await statusText(win)), { timeoutMs: 20000, label: 'a restored tab' });
  const bar = win.locator('.doc-bar', { hasText: 'Recovered unsaved edits' });
  await bar.waitFor({ timeout: 15000 });
  await showPanel(win, 'Thumbnails');
  await win.locator('.thumb').first().waitFor({ timeout: 20000 });
  await watchToasts(win);
  const recovered = await layout(win);
  R.check(`${label} the recovered document shows the edited sizes (so Discard has something to undo)`, same(recovered.pages.map((p) => p.split(' view')[0]), edited.pages.map((p) => p.split(' view')[0])) && !same(recovered.pages, fresh.pages), JSON.stringify(recovered.pages.map((p) => p.split(' view')[0])));
  if (split) {
    await menu(win, 'View', 'Split', 'Vertical');
    await delay(800);
    await jumpTo(win, 7);
    await delay(500);
  }
  await bar.getByRole('button', { name: 'Discard' }).click();
  await waitFor(async () => (await pageCount(win)) === 8 && !(await isDirty(win)), { timeoutMs: 10000, label: 'discarded' });
  await delay(1200);
  if (split) {
    await shot(win, 'd-after-discard-in-split');
    // Both panes must show the file's own sizes: compare the two panes' boxes for the page they show.
    const panes = await win.evaluate(() => [...document.querySelectorAll('.page[data-page-index]')].map((el) => {
      const r = el.getBoundingClientRect();
      return `${el.getAttribute('data-page-index')}:${Math.round(r.width)}x${Math.round(r.height)}`;
    }));
    R.info(`${label} page boxes right after Discard in split view: ${panes.join(' ')}`);
    await menu(win, 'View', 'Split', 'None');
    await delay(800);
  }
  const after = await layout(win);
  R.info(`${label} after Discard: ${JSON.stringify(after)}`);
  R.check(`${label} after Discard: Properties sizes of all 8 pages equal a fresh open`, same(after.pages.map((p) => p.split(' view')[0]), fresh.pages.map((p) => p.split(' view')[0])), JSON.stringify(after.pages.map((p) => p.split(' view')[0])));
  R.check(`${label} after Discard: the viewer's page boxes and the thumbnails equal a fresh open`, same(after.pages, fresh.pages), `after ${JSON.stringify(after.pages)} fresh ${JSON.stringify(fresh.pages)}`);
  R.check(`${label} after Discard: the thumbnail list is laid out as on a fresh open`, same(after.thumbTops, fresh.thumbTops) && after.thumbListHeight === fresh.thumbListHeight, `${after.thumbTops} / ${fresh.thumbTops}`);
  R.check(`${label} after Discard: file untouched, log gone`, readFileSync(c.path).equals(original) && recOf(profile).length === 0);
  // The discarded document goes on working: an edit and a save.
  await jumpTo(win, 7);
  await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
  await jumpTo(win, 4);
  await toastAfter(win, () => win.keyboard.press('Control+d'));
  await waitForCount(win, 9);
  const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
  await delay(600);
  const disk = inspect(c.path);
  R.check(`${label} edit + save after Discard: the file has the 9 right pages`, /^Saved/.test(t) && brief(disk) === '9p [m1,m2,m3,m4,m5,m5,m6/r90,m7/r180,m8]' && JSON.stringify(disk.pages[3].media) === '[0,0,1190.55,841.89]' && JSON.stringify(disk.pages[4].media) === '[0,0,300,300]', `${t} / ${brief(disk)}`);
  R.check(`${label} no console or page errors`, s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
  await s.close();
  cleanupProfile(profile);
}

try {
  await R.step('D1 threw', () => scenario('D1', { split: false }));
  await closeAll();
  await R.step('D2 threw', () => scenario('D2 (split view)', { split: true }));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'd-failure');
} finally {
  await closeAll();
  for (const c of copies) removeCopy(c);
  process.exitCode = R.summary() ? 1 : 0;
}
