// Probe G2: dragging a multi-selection in the Thumbnails panel with a real mouse press, moves and release.
// Probe G saw no move for a two-page selection; this repeats it in several shapes and records what the panel showed.
import {
  launch, closeAll, copyOf, removeCopy, open, delay,
  makeReport, watchToasts, shot, toasts, uids, clickRowByIndex,
} from './lib.mjs';

const R = makeReport('g2-drag-selection');
const copy = copyOf('outline-6.pdf');
let s;

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, copy.path, 6);
  await watchToasts(win);
  const row = (uid) => win.locator(`.thumb[data-uid="${uid}"]`);
  const order = async () => (await uids(win)).join('');
  const selected = () => win.locator('.thumb-selected').evaluateAll((els) => els.map((el) => el.dataset.uid).join(''));
  const geometry = await win.evaluate(() => {
    const list = document.querySelector('.thumb-list');
    const r = list.getBoundingClientRect();
    return { listTop: Math.round(r.top), listBottom: Math.round(r.bottom), rows: [...list.querySelectorAll('.thumb')].map((el) => { const b = el.getBoundingClientRect(); return `${el.dataset.uid}:${Math.round(b.top)}-${Math.round(b.bottom)}`; }) };
  });
  R.info(`panel geometry: ${JSON.stringify(geometry)}`);

  async function drag(fromUid, toUid, where, grabDy = 60) {
    await win.evaluate(() => { document.querySelector('.thumb-list').scrollTop = 0; });
    await delay(200);
    const sb = await row(fromUid).boundingBox();
    const db = await row(toUid).boundingBox();
    const ty = where === 'top' ? db.y + 8 : db.y + db.height - 8;
    const selBefore = await selected();
    await win.mouse.move(sb.x + sb.width / 2, sb.y + grabDy);
    await win.mouse.down();
    await win.mouse.move(sb.x + sb.width / 2 + 3, sb.y + grabDy + 8, { steps: 4 });
    await win.mouse.move(db.x + db.width / 2, ty, { steps: 15 });
    await delay(200);
    await win.mouse.move(db.x + db.width / 2 + 1, ty + (where === 'top' ? 1 : -1));
    const held = `selected before "${selBefore}", while held: selected "${await selected()}", drop lines ${await win.locator('.thumb-drop-line').count()}, badge "${await win.locator('.thumb-drag-badge').first().innerText().catch(() => '')}"`;
    await win.mouse.up();
    await delay(1200);
    return held;
  }
  async function attempt(label, select, from, to, where, want) {
    const before = await order();
    await select();
    const n = (await toasts(win)).length;
    const held = await drag(from, to, where);
    const after = await order();
    const t = (await toasts(win)).slice(n).join(' | ');
    R.check(label, after === want, `${before} -> ${after} (want ${want}); ${held}; toast "${t}"`);
    if (after !== want) await shot(win, `g2-${label.slice(0, 2)}`);
    // Back to 012345 for the next attempt.
    for (let i = 0; i < 3 && (await order()) !== '012345'; i++) {
      await win.keyboard.press('Control+z');
      await delay(700);
    }
  }

  await attempt('1. control: one unselected page, row 2 above row 1', async () => {}, '1', '0', 'top', '102345');
  await attempt('2. Ctrl-click rows 2 and 3, drag row 2 above row 1', async () => { await clickRowByIndex(win, 1); await clickRowByIndex(win, 2, ['Control']); }, '1', '0', 'top', '120345');
  await attempt('3. Ctrl-click rows 2 and 3, drag row 3 above row 1', async () => { await clickRowByIndex(win, 1); await clickRowByIndex(win, 2, ['Control']); }, '2', '0', 'top', '120345');
  await attempt('4. Shift-click rows 1 to 2, drag row 1 below row 3', async () => { await clickRowByIndex(win, 0); await clickRowByIndex(win, 1, ['Shift']); }, '0', '2', 'bottom', '201345');
  await attempt('5. Shift-click rows 1 to 2, drag row 2 below row 3', async () => { await clickRowByIndex(win, 0); await clickRowByIndex(win, 1, ['Shift']); }, '1', '2', 'bottom', '201345');
  await attempt('6. Ctrl-click rows 1 and 3 (not neighbours), drag row 3 below row 2: both land together after row 2', async () => { await clickRowByIndex(win, 0); await clickRowByIndex(win, 2, ['Control']); }, '2', '1', 'bottom', '102345');
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'g2-failure');
} finally {
  await closeAll();
  removeCopy(copy);
  process.exitCode = R.summary() ? 1 : 0;
}
