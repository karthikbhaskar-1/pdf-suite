// Probe B2: Close All (Ctrl+Shift+W and File > Close All) on a document with unsaved edits. Probe B saw no prompt and no
// close after a sequence of failed saves, an Insert sheet and an undo. This narrows down when that happens.
import { readFileSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, delay, newProfileDir, cleanupProfile, closeAll,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, toasts, isDirty,
  start, promptText, answer, endCleanly,
} from './lib.mjs';

const R = makeReport('b2-close-all');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let x;
let win;
const save = () => toastAfter(win, () => win.keyboard.press('Control+s'));
const focusNow = () => win.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ').join('.')}` : ''}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}` : 'none';
});
/** Tries one way of closing; reports whether the prompt came; answers Cancel. */
async function tryClose(label, how) {
  const n = (await toasts(win)).length;
  const focus = await focusNow();
  await how();
  await delay(700);
  const p = await promptText(x);
  const newToasts = (await toasts(win)).slice(n);
  R.info(`${label}: focus before "${focus}", prompt ${p ? 'shown' : 'NOT shown'}, tabs=${await win.getByRole('tab').count()}, new toasts ${JSON.stringify(newToasts)}`);
  if (p) await answer(x, 'Cancel');
  await delay(300);
  return !!p;
}
async function reset() {
  for (let i = 0; i < 5 && (await win.locator('.empty-state').count()) === 0; i++) {
    await win.keyboard.press('Control+w');
    await delay(600);
    await answer(x, "Don't save");
    await delay(600);
  }
  return (await win.locator('.empty-state').count()) > 0;
}

try {
  const profile = newProfileDir();
  x = await start({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
  win = x.win;
  await win.waitForSelector('.empty-state');

  await R.step('C1 threw', async () => {
    const a = mk('outline-6.pdf');
    await open(x, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    R.check('C1 one edit, Ctrl+Shift+W: asks', await tryClose('C1 Ctrl+Shift+W', () => win.keyboard.press('Control+Shift+w')));
    R.check('C1 one edit, File > Close All: asks', await tryClose('C1 File > Close All', () => menu(win, 'File', 'Close All')));
    R.check('C1 reset', await reset());
  });

  await R.step('C2 threw', async () => {
    const a = mk('outline-6.pdf');
    await open(x, a.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    chmodSync(a.path, 0o444);
    await save();
    R.check('C2 edit + failed save, Ctrl+Shift+W: asks', await tryClose('C2 Ctrl+Shift+W', () => win.keyboard.press('Control+Shift+w')));
    chmodSync(a.path, 0o666);
    R.check('C2 reset', await reset());
  });

  await R.step('C3 threw', async () => {
    // An Insert sheet, then undo, then Close All (no failed save at all).
    const a = mk('outline-6.pdf');
    await open(x, a.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    await menu(win, 'Pages', 'Insert Blank Page…');
    await toastAfter(win, () => sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 8);
    R.check('C3 after the Insert sheet, Ctrl+Shift+W: asks', await tryClose('C3a Ctrl+Shift+W after sheet', () => win.keyboard.press('Control+Shift+w')));
    await win.keyboard.press('Control+z');
    await waitForCount(win, 7);
    await delay(400);
    const u = (await menuItems(win, 'Edit')).slice(0, 2);
    R.info(`C3 after Ctrl+Z: pages=${await pageCount(win)} dirty=${await isDirty(win)} undo="${u[0].label}" redo="${u[1].label}"`);
    const asked = await tryClose('C3b Ctrl+Shift+W after sheet + Ctrl+Z', () => win.keyboard.press('Control+Shift+w'));
    R.check('C3 after the Insert sheet and Ctrl+Z, Ctrl+Shift+W: asks', asked);
    if (!asked) {
      await shot(win, 'b2-c3-no-prompt');
      R.check('C3 … File > Close All from the menu: asks', await tryClose('C3c File > Close All', () => menu(win, 'File', 'Close All')));
      R.check('C3 … Ctrl+W: asks', await tryClose('C3d Ctrl+W', () => win.keyboard.press('Control+w')));
      R.check('C3 … Ctrl+Shift+W once more: asks', await tryClose('C3e Ctrl+Shift+W again', () => win.keyboard.press('Control+Shift+w')));
      await win.locator('.page').first().click({ position: { x: 20, y: 20 } }).catch(() => undefined);
      R.check('C3 … Ctrl+Shift+W after a click on the page: asks', await tryClose('C3f Ctrl+Shift+W after click', () => win.keyboard.press('Control+Shift+w')));
    }
    R.check('C3 reset', await reset());
  });

  await R.step('C4 threw', async () => {
    // Undo alone (no sheet): edit, edit, Ctrl+Z, Close All.
    const a = mk('outline-6.pdf');
    await open(x, a.path, 6);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await win.keyboard.press('Control+z');
    await delay(800);
    R.check('C4 edit, edit, Ctrl+Z, then Ctrl+Shift+W: asks', await tryClose('C4 Ctrl+Shift+W after Ctrl+Z', () => win.keyboard.press('Control+Shift+w')));
    await win.keyboard.press('Control+y');
    await delay(800);
    R.check('C4 then Ctrl+Y, then Ctrl+Shift+W: asks', await tryClose('C4 Ctrl+Shift+W after Ctrl+Y', () => win.keyboard.press('Control+Shift+w')));
    R.check('C4 then Ctrl+Shift+S (Save As, dialog cancelled), then Ctrl+Shift+W: asks', await (async () => {
      await win.keyboard.press('Control+Shift+s');
      await delay(800);
      return tryClose('C4 Ctrl+Shift+W after cancelled Save As', () => win.keyboard.press('Control+Shift+w'));
    })());
    R.check('C4 reset', await reset());
  });
  R.check('no console or page errors', x.errors.filter((e) => !/favicon/.test(e)).length === 0, x.errors.join(' || ').slice(0, 900));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (x && !x.gone) await shot(x.win, 'b2-failure');
} finally {
  await endCleanly(x).catch(() => undefined);
  await closeAll();
  for (const c of copies) {
    try {
      for (const f of readdirSync(c.dir)) chmodSync(join(c.dir, f), 0o666);
    } catch { /* gone */ }
    removeCopy(c);
  }
  process.exitCode = R.summary() ? 1 : 0;
}
