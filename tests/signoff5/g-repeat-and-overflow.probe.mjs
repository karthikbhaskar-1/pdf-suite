// Probe G: (1) a command repeated after a typed jump near the end of the file: does the second press act on the same
// page? Probe E saw the page box go from 7 to 8 after one Rotate. No thumbnail is clicked anywhere here.
// (2) The "…" menu at 760 px with the mouse and the keyboard (probe D's selector for the menu was wrong).
import { placeWindow } from '../e2e/helpers.mjs';
import {
  launch, closeAll, cleanupProfile, newProfileDir, delay, inspect, brief, openMore,
  watchToasts, toastCount, toastsSince, waitToast, mk, wipeWork, report,
} from './lib.mjs';

const R = report('g-repeat-and-overflow');
const profile = newProfileDir();
let s;
let win;
const box = () => win.locator('footer.status-bar').getByLabel('Go to page');
const boxNow = () => win.evaluate(() => document.querySelector('#status-page-box')?.value);
async function typePage(n) { await box().fill(String(n)); await box().press('Enter'); await delay(900); }
async function setZoom(z) { const i = win.locator('footer.status-bar').getByLabel('Zoom level'); await i.fill(String(z)); await i.press('Enter'); await delay(700); }
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
const save = async () => { const f = await toastCount(win); await win.keyboard.press('Control+s'); await waitToast(win, f, /^Saved /, 20000); await delay(400); };
const rotations = (path) => inspect(path, undefined, { text: false }).pages.map((p) => p.rotate);

try {
  s = await launch({ profile });
  win = s.win;
  await placeWindow(s, { width: 1400, height: 800 });
  await win.waitForSelector('.empty-state');
  await watchToasts(win);
  const rot = () => win.locator('.top-bar').getByRole('button', { name: 'Rotate right 90°', exact: true });

  for (const zoom of [50, 100]) {
    await R.step(`rotate twice at ${zoom}%`, async () => {
      const c = mk('mixed-sizes-rotated.pdf', `rot${zoom}.pdf`);
      const before = rotations(c.path);
      await openMore(s, c.path, 8, 1);
      await setZoom(zoom);
      await typePage(7);
      const b0 = await boxNow();
      await rot().click(); await delay(1000);
      const b1 = await boxNow();
      await rot().click(); await delay(1000);
      const b2 = await boxNow();
      await save();
      const after = rotations(c.path);
      const delta = after.map((r, i) => (((r - before[i]) % 360) + 360) % 360);
      R.check(`${zoom}%: typed 7, Rotate pressed twice in the toolbar: page 7 turns 180 and no other page turns`, JSON.stringify(delta) === JSON.stringify([0, 0, 0, 0, 0, 0, 180, 0]), `turned ${JSON.stringify(delta)}; page box ${b0} -> ${b1} -> ${b2}`);
    });
    await closeEverything();
  }
  await R.step('delete after a typed jump', async () => {
    const c = mk('outline-6.pdf', 'del.pdf');
    await openMore(s, c.path, 6, 1);
    await setZoom(50);
    await typePage(5);
    const f = await toastCount(win);
    await win.locator('.top-bar').getByRole('button', { name: 'Delete pages', exact: true }).click();
    await delay(1000);
    const b = await boxNow();
    await save();
    const d = inspect(c.path);
    R.check('50%: typed 5, Delete in the toolbar: page 5 is the one deleted', brief(d) === '5p [o1,o2,o3,o4,o6]', `${brief(d)}; page box now ${b}; toasts ${JSON.stringify(await toastsSince(win, f))}`);
  });

  await R.step('overflow at 760', async () => {
    await placeWindow(s, { width: 760, height: 800 });
    await delay(900);
    const more = win.locator('.top-bar').getByRole('button', { name: 'More commands', exact: true });
    await more.click(); await delay(400);
    const dump = await win.evaluate(() => [...document.querySelectorAll('[role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], .menu-dropdown, .tb-menu-list')].filter((el) => el.offsetParent !== null).map((el) => `${el.getAttribute('role') ?? el.className}:${(el.getAttribute('role') === 'menu' ? '' : el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}`));
    R.info(`"…" menu opened with the mouse: ${JSON.stringify(dump)}`);
    const rows = dump.filter((x) => x.startsWith('menuitem'));
    R.check('760 px: the "…" menu lists the collapsed commands (Loupe, Pan and zoom, Page colors, Crop, Page size, more page actions)', ['Loupe', 'Pan', 'Page colors', 'Crop', 'Page size'].every((w) => rows.some((r) => r.includes(w))), JSON.stringify(rows));
    await win.keyboard.press('Escape'); await delay(300);
    const focus = () => win.evaluate(() => { const el = document.activeElement; return el ? { label: el.getAttribute('aria-label'), role: el.getAttribute('role'), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) } : null; });
    // Keyboard only: Tab from the first toolbar button until "…" has the focus.
    await win.locator('.top-bar button').first().focus();
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) { await win.keyboard.press('Tab'); reached = (await focus())?.label === 'More commands'; }
    R.check('760 px: Tab reaches "…"', reached, JSON.stringify(await focus()));
    for (const key of ['Enter', 'ArrowDown']) {
      await win.keyboard.press(key); await delay(300);
      const f1 = await focus();
      await win.keyboard.press('ArrowDown'); await delay(150);
      const f2 = await focus();
      await win.keyboard.press('Escape'); await delay(300);
      const back = await focus();
      R.check(`760 px: ${key} opens "…", Down moves to the next row, Esc closes and focus returns to "…"`, /^menuitem/.test(f1?.role ?? '') && /^menuitem/.test(f2?.role ?? '') && f1.text !== f2.text && back?.label === 'More commands', `first ${JSON.stringify(f1)} second ${JSON.stringify(f2)} after Esc ${JSON.stringify(back)}`);
    }
  });
  await closeEverything();
} catch (err) {
  R.check('probe ran to the end', false, String(err && err.stack ? err.stack : err).slice(0, 600));
} finally {
  await closeAll();
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
