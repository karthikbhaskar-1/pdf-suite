// Probe H2: is a plain drag of a thumbnail reliable? Fresh sessions (first drag right after open), then many drags in
// one session. Rows are addressed by what is on screen (sorted by their top), never by DOM order.
import {
  launch, closeAll, copyOf, removeCopy, open, uids, delay,
  makeReport, watchToasts, toasts, shot,
} from './lib.mjs';

const R = makeReport('h2-drag-repeat');
const a = copyOf('outline-6.pdf');
let s;

/** The uid of the row at a visual position (0 = top), and a locator for it. */
async function rowAt(win, index) {
  const uid = await win.evaluate((i) => {
    const rows = [...document.querySelectorAll('.thumb-list .thumb')].sort((x, y) => parseFloat(x.style.top) - parseFloat(y.style.top));
    return rows[i]?.dataset.uid ?? null;
  }, index);
  return { uid, loc: win.locator(`.thumb[data-uid="${uid}"]`) };
}
async function instrument(win) {
  await win.evaluate(() => {
    window.__pdfSuiteDiag?.enable();
    window.__drag = [];
    const sel = () => [...document.querySelectorAll('.thumb-selected')].map((el) => el.dataset.uid).join('+');
    for (const type of ['dragstart', 'dragend', 'drop', 'dragleave']) {
      document.addEventListener(type, (e) => {
        const row = e.target instanceof Element ? e.target.closest('.thumb') : null;
        const list = document.querySelector('.thumb-list');
        window.__drag.push(`${type}[row ${row?.dataset.uid ?? '-'} y=${Math.round(e.clientY)} scroll=${Math.round(list?.scrollTop ?? -1)} sel=${sel()} prevented=${e.defaultPrevented}]`);
      }, true);
      // The same event after the app's own handlers ran (bubble phase on window).
      window.addEventListener(type, (e) => window.__drag.push(`${type}:after[prevented=${e.defaultPrevented} line=${document.querySelectorAll('.thumb-drop-line').length}]`));
    }
    let overs = 0;
    window.addEventListener('dragover', (e) => {
      overs += 1;
      window.__drag.push(`dragover#${overs}[y=${Math.round(e.clientY)} prevented=${e.defaultPrevented}]`);
    });
  });
}
const drain = (win) => win.evaluate(() => ({ drag: window.__drag.splice(0), diag: (window.__pdfSuiteDiag?.events() ?? []).filter((e) => /runEdits|apply\./.test(e.name)).map((e) => `${e.name}${e.data ? JSON.stringify(e.data) : ''}`) }));
const clearDiag = (win) => win.evaluate(() => window.__pdfSuiteDiag?.clear());

async function oneDrag(win, from, to, label, how) {
  const before = (await uids(win)).join(',');
  await win.evaluate(() => { document.querySelector('.thumb-list').scrollTop = 0; });
  await delay(150);
  await clearDiag(win);
  await win.evaluate(() => window.__drag.splice(0));
  const src = await rowAt(win, from);
  const dst = await rowAt(win, to);
  if (how === 'dragTo') {
    await src.loc.dragTo(dst.loc, { targetPosition: { x: 60, y: 4 } });
  } else {
    const sb = await src.loc.boundingBox();
    const db = await dst.loc.boundingBox();
    const gx = sb.x + sb.width / 2;
    const gy = sb.y + 60;
    await win.mouse.move(gx, gy);
    await win.mouse.down();
    await win.mouse.move(gx + 3, gy + 8, { steps: 4 });
    await win.mouse.move(db.x + db.width / 2, db.y + 8, { steps: 15 });
    await delay(120);
    await win.mouse.move(db.x + db.width / 2 + 1, db.y + 9);
    await win.mouse.up();
  }
  await delay(1000);
  const after = (await uids(win)).join(',');
  const l = before.split(',');
  const [m] = l.splice(from, 1);
  l.splice(to > from ? to - 1 : to, 0, m);
  const want = l.join(',');
  const d = await drain(win);
  const ok = after === want;
  R.check(`${label}: row ${from + 1} (uid ${src.uid}) onto the top of row ${to + 1} (${how})`, ok, ok ? `${before} -> ${after}` : `${before} -> ${after} (want ${want})\n      events: ${d.drag.join(' ')}\n      trace: ${d.diag.join(' | ')}\n      toast: "${(await toasts(win)).at(-1) ?? ''}" badges ${await win.locator('.thumb-drag-badge').count()} lines ${await win.locator('.thumb-drop-line').count()}`);
  return ok;
}

try {
  // Fresh sessions: the first thing the user does is drag page 1 below page 2.
  let firstOk = 0;
  const FRESH = 6;
  for (let trial = 1; trial <= FRESH; trial++) {
    s = await launch();
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 6);
    await watchToasts(s.win);
    await instrument(s.win);
    if (trial > 3) await delay(2000);
    if (await oneDrag(s.win, 0, 2, `fresh session ${trial}${trial > 3 ? ' (after a 2 s pause)' : ' (at once)'}`, trial % 2 ? 'dragTo' : 'mouse')) firstOk += 1;
    if (trial < FRESH) await s.close();
  }
  R.info(`first drag after open worked in ${firstOk} of ${FRESH} fresh sessions`);

  // One session, many drags, unselected and selected, both ways.
  const { win } = s;
  let ok = 0;
  let total = 0;
  for (let i = 0; i < 12; i++) {
    const sel = win.locator('.thumb-selected');
    for (let k = 0; k < 6 && (await sel.count()) > 0; k++) await sel.first().click({ modifiers: ['Control'] });
    const down = i % 2 === 0;
    const from = down ? 0 : 1;
    const to = down ? 2 : 0;
    const selectedFirst = i % 4 >= 2;
    if (selectedFirst) await (await rowAt(win, from)).loc.click();
    total += 1;
    if (await oneDrag(win, from, to, `repeat ${i + 1} (${selectedFirst ? 'selected first' : 'not selected'})`, i % 3 === 0 ? 'dragTo' : 'mouse')) ok += 1;
  }
  R.info(`repeated drags in one session: ${ok} of ${total} moved the page`);
  await shot(win, 'h2-end');
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'h2-failure');
} finally {
  await closeAll();
  removeCopy(a);
  process.exitCode = R.summary() ? 1 : 0;
}
