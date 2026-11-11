// Probe G: drag to reorder in the Thumbnails panel (one page, then a multi-selection), Alt+Home / Alt+End, the thumbnail
// right-click menu and the panel's icon row; with undo/redo between, then save and an independent read of the file.
import {
  launch, closeAll, copyOf, removeCopy, open, waitForCount, pageCount, delay,
  makeReport, watchToasts, toastAfter, menuItems, shot, inspect, brief, toasts, isDirty, uids, plainEnglish, clickRowByIndex,
} from './lib.mjs';

const R = makeReport('g-drag-context');
const copy = copyOf('outline-6.pdf');
let s;
const order = async (win) => (await uids(win)).join('');

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, copy.path, 6);
  await watchToasts(win);
  const row = (uid) => win.locator(`.thumb[data-uid="${uid}"]`);
  let held = '';
  async function drag(fromUid, toUid, where) {
    const sb = await row(fromUid).boundingBox();
    const db = await row(toUid).boundingBox();
    const ty = where === 'top' ? db.y + 8 : db.y + db.height - 8;
    await win.mouse.move(sb.x + sb.width / 2, sb.y + 60);
    await win.mouse.down();
    await win.mouse.move(sb.x + sb.width / 2 + 3, sb.y + 68, { steps: 4 });
    await win.mouse.move(db.x + db.width / 2, ty, { steps: 15 });
    await delay(150);
    await win.mouse.move(db.x + db.width / 2 + 1, ty + (where === 'top' ? 1 : -1));
    held = `drop lines ${await win.locator('.thumb-drop-line').count()}, badge "${await win.locator('.thumb-drag-badge').first().innerText().catch(() => '')}"`;
    await win.mouse.up();
  }

  await R.step('drag one page threw', async () => {
    // Page 4 (uid 3) dropped on the upper part of page 2 (uid 1): 0 3 1 2 4 5
    const t = await toastAfter(win, () => drag('1', '0', 'top'));
    R.info(`while dragging one page: ${held}`);
    await delay(500);
    R.check('drag page 2 above page 1 (real mouse press, moves, release)', (await order(win)) === '102345', `${await order(win)} toast "${t}"`);
    await win.keyboard.press('Control+z');
    await delay(700);
    R.check('undo of the drag restores the order', (await order(win)) === '012345', await order(win));
    await win.keyboard.press('Control+y');
    await delay(700);
    R.check('redo of the drag', (await order(win)) === '102345', await order(win));
  });

  await R.step('drag a selection threw', async () => {
    // Select pages at rows 0 and 2 (uids 0 and 1) with Ctrl+click, drag them below the last row: 3 2 4 5 0 1
    await clickRowByIndex(win, 1);
    await clickRowByIndex(win, 2, ['Control']);
    const t = await toastAfter(win, () => drag('0', '1', 'top'));
    R.info(`while dragging two pages: ${held}`);
    R.check('while dragging a selection: an accent drop line and a badge with the page count', /drop lines 1, badge "2"/.test(held), held);
    await delay(500);
    R.check('drag two selected pages (rows 2 and 3) to the top keeps their order', (await order(win)) === '021345', `${await order(win)} toast "${t}"`);
  });

  await R.step('Alt+Home / Alt+End threw', async () => {
    await clickRowByIndex(win, 3); // uid 5
    await win.keyboard.press('Alt+Home');
    await delay(700);
    const a = await order(win);
    await clickRowByIndex(win, 1); // uid 3
    await win.keyboard.press('Alt+End');
    await delay(700);
    const b = await order(win);
    R.check('Alt+Home moves the page first; Alt+End moves it last', a === '302145' && b === '321450', `${a} then ${b}`);
  });

  await R.step('right-click menu threw', async () => {
    await row('2').click({ button: 'right' });
    await delay(400);
    const items = await win.locator('[role="menu"] [role="menuitem"], .context-menu button, .menu-popup button').allInnerTexts();
    R.info(`thumbnail right-click menu: ${JSON.stringify(items.map((i) => i.replace(/\s+/g, ' ').trim()))}`);
    const want = ['Insert blank', 'from a PDF', 'Duplicate', 'Replace', 'Rotate', 'Crop', 'Extract', 'Delete'];
    const text = items.join(' | ');
    R.check('the thumbnail right-click menu has Insert blank / from PDF, Duplicate, Replace, Rotate, Crop, Extract, Delete', want.every((w) => new RegExp(w, 'i').test(text)), text.replace(/\s+/g, ' '));
    const dup = win.getByText('Duplicate', { exact: true }).last();
    const t = await toastAfter(win, () => dup.click());
    await waitForCount(win, 7);
    R.check('Duplicate from the right-click menu acts on the clicked page', /Duplicated 1 page/.test(t) && /(^|,)2,n[0-9]+(,|$)/.test((await uids(win)).join(',')), (await uids(win)).join(','));
  });

  await R.step('panel icon row threw', async () => {
    const tools = await win.locator('.thumb-tool').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent));
    R.info(`thumbnail panel icon row: ${JSON.stringify(tools)}`);
    await clickRowByIndex(win, 0); // uid 5
    const del = win.locator('.thumb-tool').filter({ has: win.locator(':scope') }).nth(1);
    const label = await del.getAttribute('aria-label');
    const t = await toastAfter(win, () => del.click());
    R.info(`second icon "${label}" -> toast "${t}"`);
    R.check('the panel icon row has Insert, Delete, Rotate, Extract and More', tools.length >= 5 && ['insert', 'delete', 'rotate', 'extract', 'more'].every((w) => tools.some((x) => new RegExp(w, 'i').test(x ?? ''))), JSON.stringify(tools));
  });

  await R.step('save threw', async () => {
    const ids = await uids(win);
    const want = ids.map((u) => (u.startsWith('n') ? 'o3' : `o${Number(u) + 1}`)).join(',');
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(600);
    const d = inspect(copy.path);
    R.check('saved file has the pages in the order on screen', /^Saved/.test(t) && brief(d).replace(/\/r\d+/g, '') === `${ids.length}p [${want}]` && !(await isDirty(win)), `${brief(d)} want ${want}`);
    R.check('bookmarks still point at their own pages (Intro → Outline page 2, Middle → 4, End → 6)', Array.isArray(d.outline) && d.outline.every((o) => { const n = { Intro: 2, Middle: 4, End: 6 }[o.title]; return typeof o.page === 'number' && d.pages[o.page - 1]?.text === `Outline page ${n}`; }), JSON.stringify(d.outline));
  });
  const all = await toasts(win);
  R.check('every toast is plain English', all.every(plainEnglish), all.join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'g-failure');
} finally {
  await closeAll();
  removeCopy(copy);
  process.exitCode = R.summary() ? 1 : 0;
}
