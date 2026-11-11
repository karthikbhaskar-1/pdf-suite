// Probe H: drag to reorder, the way a user does it: grab a thumbnail that is NOT selected and drag it; then a selected
// one; with Playwright's dragTo and with plain mouse moves. Records the drag events the page saw.
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitFor, delay,
  makeReport, watchToasts, toasts, shot, menuItems, clickRowByIndex,
} from './lib.mjs';

const R = makeReport('h-drag');
const a = copyOf('outline-6.pdf');
let s;

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, a.path, 6);
  await watchToasts(win);
  await win.evaluate(() => {
    window.__drag = [];
    const sel = () => [...document.querySelectorAll('.thumb-selected')].map((el) => el.dataset.uid).join('+');
    for (const type of ['dragstart', 'dragend', 'drop', 'dragenter']) {
      document.addEventListener(type, (e) => {
        const row = e.target instanceof Element ? e.target.closest('.thumb') : null;
        const list = document.querySelector('.thumb-list');
        window.__drag.push(`${type}[row ${row?.dataset.uid ?? '-'} y=${Math.round(e.clientY)} scroll=${Math.round(list?.scrollTop ?? -1)} sel=${sel()}]`);
        if (type === 'dragstart') setTimeout(() => window.__drag.push(`after-dragstart[sel=${sel()}]`), 0);
      }, true);
    }
    let overs = 0;
    document.addEventListener('dragover', () => {
      overs += 1;
      if (overs === 1 || overs % 20 === 0) window.__drag.push(`dragover#${overs}`);
    }, true);
  });
  const events = async () => {
    const e = await win.evaluate(() => window.__drag.splice(0));
    return e.join(' ');
  };
  const order = async () => (await uids(win)).join(',');
  const leftovers = async () => `badges ${await win.locator('.thumb-drag-badge').count()}, drop lines ${await win.locator('.thumb-drop-line').count()}`;
  const deselect = async () => {
    const sel = win.locator('.thumb-selected');
    for (let i = 0; i < 8 && (await sel.count()) > 0; i++) await sel.first().click({ modifiers: ['Control'] });
  };

  /** Moves one row to a position in a list of uids (what a correct drop should give). */
  const moved = (list, from, to) => {
    const l = list.split(',');
    const [m] = l.splice(from, 1);
    l.splice(to, 0, m);
    return l.join(',');
  };
  // Only rows 1 and 2 are fully on screen in the default window, and the top of row 3. Every grab and drop stays there.
  const manualDrag = async (from, to, y = 6) => {
    const src = await win.locator('.thumb').nth(from).boundingBox();
    const dst = await win.locator('.thumb').nth(to).boundingBox();
    const gx = src.x + src.width / 2;
    const gy = src.y + 40;
    await win.mouse.move(gx, gy);
    await win.mouse.down();
    await win.mouse.move(gx + 4, gy + 12, { steps: 3 });
    await win.mouse.move(dst.x + dst.width / 2, dst.y + y, { steps: 12 });
    await delay(150);
    await win.mouse.move(dst.x + dst.width / 2 + 1, dst.y + y + 1, { steps: 2 });
    await win.mouse.up();
    await delay(900);
  };
  const run = async (label, prepare, drag, from, to) => {
    await deselect();
    await win.evaluate(() => { document.querySelector('.thumb-list').scrollTop = 0; });
    await delay(200);
    await prepare();
    const before = await order();
    await events();
    await drag();
    await delay(900);
    const after = await order();
    const want = moved(before, from, to);
    R.check(label, after === want, `${before} -> ${after} (want ${want}) | events: ${await events()} | ${await leftovers()} | last toast "${(await toasts(win)).at(-1) ?? ''}"`);
  };
  const none = async () => undefined;
  const dragTo = (from, to) => () => win.locator('.thumb').nth(from).dragTo(win.locator('.thumb').nth(to), { targetPosition: { x: 60, y: 4 } });

  await run('1. UNSELECTED row 1 dragged onto the top of row 3 (dragTo): lands before row 3', none, dragTo(0, 2), 0, 1);
  await shot(win, 'h-after-drag1');
  await run('2. UNSELECTED row 3 dragged onto the top of row 1 (mouse moves): lands first', none, () => manualDrag(2, 0), 2, 0);
  await run('3. UNSELECTED row 2 dragged onto the top of row 1 (mouse moves): lands first', none, () => manualDrag(1, 0), 1, 0);
  await run('4. SELECTED row 1 (clicked first) dragged onto the top of row 3 (dragTo): lands before row 3', () => win.locator('.thumb').nth(0).click(), dragTo(0, 2), 0, 1);
  await run('5. SELECTED row 2 (clicked first) dragged onto the top of row 1 (mouse moves): lands first', () => win.locator('.thumb').nth(1).click(), () => manualDrag(1, 0), 1, 0);
  await run('6. row 1 selected, UNSELECTED row 2 dragged onto the top of row 1 (mouse moves): row 2 alone lands first', () => win.locator('.thumb').nth(0).click(), () => manualDrag(1, 0), 1, 0);
  await run('7. UNSELECTED row 1 dragged onto the top of row 3 (mouse moves): lands before row 3', none, () => manualDrag(0, 2), 0, 1);

  // 8. The drop line and the badge during a held drag
  await win.locator('.thumb').nth(0).click();
  {
    const src = await win.locator('.thumb').nth(0).boundingBox();
    const dst = await win.locator('.thumb').nth(2).boundingBox();
    await win.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await win.mouse.down();
    await win.mouse.move(src.x + src.width / 2 + 4, src.y + src.height / 2 + 12, { steps: 3 });
    await win.mouse.move(dst.x + dst.width / 2, dst.y + 6, { steps: 10 });
    await delay(200);
    const line = await win.locator('.thumb-drop-line').count();
    const badge = await win.locator('.thumb-drag-badge').allInnerTexts();
    await shot(win, 'h-held-drag');
    R.check('8. while dragging: an accent drop line and a count badge are present', line === 1 && badge.join('') === '1', `drop lines ${line}, badge "${badge.join('')}"`);
    await win.keyboard.press('Escape');
    await win.mouse.up();
    await delay(600);
    R.info(`after Esc during a drag: ${await leftovers()} | events: ${await events()}`);
  }
  const edits = await menuItems(win, 'Edit');
  R.info(`undo label at the end: ${edits[0].label}; toasts: ${(await toasts(win)).join(' | ')}`);
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'h-failure');
} finally {
  await closeAll();
  removeCopy(a);
  process.exitCode = R.summary() ? 1 : 0;
}
