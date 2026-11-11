// Probe D: a quick look at the toolbar, the "…" menu and the status bar against docs/milestone-1.2/1.2.2-ui-spec.md at
// three window widths, with the mouse and with the keyboard only. The matrix tests cover this in depth; this is a fresh pair of eyes.
import { placeWindow } from '../e2e/helpers.mjs';
import { join } from 'node:path';
import { launch, closeAll, cleanupProfile, newProfileDir, waitFor, delay, openMore, watchToasts, dup, mk, wipeWork, report, OUT5 } from './lib.mjs';

const R = report('d-spec-pass');
const profile = newProfileDir();
let s;
let win;
const CRITICAL = ['Open', 'Save', 'Undo', 'Redo', 'Find', 'Previous page', 'Next page', 'Theme'];
const snapshot = () => win.evaluate(() => {
  const bar = document.querySelector('.top-bar');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const slots = [...bar.querySelectorAll('.tb-slot')].map((el) => ({ id: el.dataset.slot, priority: el.dataset.priority, hidden: el.classList.contains('tb-collapsed'), ...rect(el) }));
  const buttons = [...bar.querySelectorAll('button, input')].filter((el) => el.offsetParent !== null && !el.closest('.tb-collapsed') && !el.closest('[role="menu"]')).map((el) => ({ tag: el.tagName, label: el.getAttribute('aria-label'), keys: el.getAttribute('aria-keyshortcuts'), svg: el.querySelector('svg') ? Math.round(el.querySelector('svg').getBoundingClientRect().width) : null, text: (el.textContent ?? '').trim().slice(0, 20), ...rect(el) }));
  const st = document.querySelector('footer.status-bar');
  const vis = (sel) => { const el = st.querySelector(sel); return !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0; };
  return {
    inner: innerWidth, bar: rect(bar), barScroll: bar.scrollWidth - bar.clientWidth, slots, buttons,
    overflowShown: !document.querySelector('.tb-overflow').classList.contains('tb-collapsed'),
    status: { ...rect(st), pageBox: vis('#status-page-box'), zoomBox: vis('input[aria-label="Zoom level"]'), slider: vis('.status-slider'), info: vis('.status-info'), fit: vis('.status-fit button'), overflowX: st.scrollWidth - st.clientWidth },
    zoomInTop: [...bar.querySelectorAll('button')].filter((b) => /^Zoom (in|out)$/i.test(b.getAttribute('aria-label') ?? '')).length,
  };
});
async function setWidth(w) {
  await placeWindow(s, { width: w, height: 800 });
  await delay(900);
}
const focusLabel = () => win.evaluate(() => { const el = document.activeElement; return el ? { label: el.getAttribute('aria-label'), inOverflow: !!el.closest('.tb-overflow'), role: el.getAttribute('role'), inMenu: !!el.closest('[role="menu"]'), text: (el.textContent ?? '').trim().slice(0, 30) } : null; });

try {
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');
  await watchToasts(win);
  const c = mk('outline-6.pdf', 'spec.pdf');
  await setWidth(1500);
  await openMore(s, c.path, 6, 1);
  await dup(win); // so Undo names an action
  await win.mouse.move(700, 400);

  const all = {};
  for (const width of [1500, 1000, 760]) {
    await R.step(`width ${width}`, async () => {
      await setWidth(width);
      const snap = await snapshot();
      all[width] = snap;
      const labels = snap.buttons.map((b) => b.label ?? `(${b.tag} no label "${b.text}")`);
      R.info(`${width} (inner ${snap.inner}): visible ${JSON.stringify(labels)}`);
      R.info(`${width}: collapsed ${JSON.stringify(snap.slots.filter((x) => x.hidden).map((x) => `${x.id}/${x.priority}`))}; status ${JSON.stringify(snap.status)}`);
      R.check(`${width}: toolbar is 40 px high, one row, nothing spills sideways; status bar is 24 px`, snap.bar.h === 40 && snap.barScroll <= 0 && snap.status.h === 24 && snap.buttons.every((b) => b.y >= snap.bar.y && b.y + b.h <= snap.bar.y + snap.bar.h + 1 && b.x + b.w <= snap.inner + 1), `bar ${JSON.stringify(snap.bar)} scroll ${snap.barScroll} status h ${snap.status.h}`);
      const unnamed = snap.buttons.filter((b) => !b.label);
      R.check(`${width}: every visible toolbar control has a name`, unnamed.length === 0, JSON.stringify(unnamed));
      const missing = CRITICAL.filter((want) => !labels.some((l) => new RegExp(want, 'i').test(l)));
      R.check(`${width}: critical controls are all visible (Open, Save, Undo, Redo, Search, previous/next page, Theme)`, missing.length === 0 && snap.slots.filter((x) => x.priority === 'critical' && x.hidden).length === 0, `missing ${JSON.stringify(missing)}`);
      const hidden = snap.slots.filter((x) => x.hidden);
      const normalsLeft = snap.slots.filter((x) => x.priority === 'normal' && !x.hidden).length;
      R.check(`${width}: high-priority items collapse only after every normal one has`, !(hidden.some((x) => x.priority === 'high') && normalsLeft > 0), `hidden ${hidden.map((x) => x.id)} normals still shown ${normalsLeft}`);
      R.check(`${width}: "…" shows exactly when something is collapsed`, snap.overflowShown === hidden.length > 0, `overflow ${snap.overflowShown}, hidden ${hidden.length}`);
      R.check(`${width}: no zoom buttons in the top bar; page box and zoom box are in the status bar`, snap.zoomInTop === 0 && snap.status.pageBox && snap.status.zoomBox && snap.status.overflowX <= 0, JSON.stringify(snap.status));
      const icons = snap.buttons.filter((b) => b.tag === 'BUTTON' && b.svg !== null && !b.text);
      const off = icons.filter((b) => b.h !== 32 || (b.w !== 32 && b.w < 32) || (b.svg !== 18 && b.svg !== 12));
      R.check(`${width}: icon buttons are 32 px high with 18 px icons`, off.length === 0, JSON.stringify(off.slice(0, 5)));
      await win.screenshot({ path: join(OUT5, `d-${width}.png`) }).catch(() => undefined);
      if (snap.overflowShown) {
        // Mouse: the menu lists what was collapsed.
        const more = win.locator('.tb-overflow button').first();
        await more.click();
        const menu = win.locator('[role="menu"]').last();
        await menu.waitFor({ timeout: 4000 });
        const items = await menu.locator('[role^="menuitem"]').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()));
        R.info(`${width}: "…" menu (mouse): ${JSON.stringify(items)}`);
        R.check(`${width}: the "…" menu has rows for the collapsed items`, items.length >= hidden.length, `${items.length} rows for ${hidden.length} collapsed slots`);
        await win.screenshot({ path: join(OUT5, `d-${width}-menu.png`) }).catch(() => undefined);
        await win.keyboard.press('Escape');
        await delay(200);
        // Keyboard only: Tab to "…", Enter opens, arrows move, Esc closes and focus returns.
        await win.locator('.top-bar button').first().focus();
        let reached = false;
        for (let i = 0; i < 80 && !reached; i++) { await win.keyboard.press('Tab'); reached = (await focusLabel())?.inOverflow === true; }
        R.check(`${width}: Tab reaches "…"`, reached, JSON.stringify(await focusLabel()));
        if (reached) {
          for (const key of ['Enter', 'ArrowDown']) {
            await win.keyboard.press(key);
            await delay(250);
            const open = (await win.locator('[role="menu"]').count()) > 0;
            const f1 = await focusLabel();
            await win.keyboard.press('ArrowDown'); await delay(100);
            const f2 = await focusLabel();
            await win.keyboard.press('Escape'); await delay(250);
            const closed = (await win.locator('.tb-overflow [role="menu"]').count()) === 0;
            const back = await focusLabel();
            R.check(`${width}: ${key} opens "…", Down moves, Esc closes and focus is back on "…"`, open && f1?.inMenu && f2?.inMenu && f1.text !== f2.text && closed && back?.inOverflow === true, `open=${open} first=${JSON.stringify(f1)} second=${JSON.stringify(f2)} closed=${closed} back=${JSON.stringify(back)}`);
          }
        }
      }
    });
  }
  R.check('status bar gives up the slider first, then the document info, then the fit buttons; page box and zoom box stay', (() => {
    const order = [1500, 1000, 760].map((w) => all[w]?.status).filter(Boolean);
    return order.every((st) => st.pageBox && st.zoomBox && !(st.slider && !st.info) && !(st.info && !st.fit) && !(st.slider && !st.fit));
  })(), JSON.stringify([1500, 1000, 760].map((w) => all[w] && { w, slider: all[w].status.slider, info: all[w].status.info, fit: all[w].status.fit })));

  await R.step('tooltips', async () => {
    await setWidth(1500);
    const tipOf = async () => ((await win.locator('[role="tooltip"]').count()) > 0 ? (await win.locator('[role="tooltip"]').first().innerText()).trim() : null);
    const save = win.locator('.top-bar').getByRole('button', { name: /^Save/ }).first();
    await win.mouse.move(700, 400); await delay(300);
    await save.hover(); await delay(250);
    const early = await tipOf();
    await delay(550);
    const late = await tipOf();
    R.check('mouse: the Save tooltip is not there at 250 ms, is there by 800 ms, and reads "Save (Ctrl+S)"', early === null && late === 'Save (Ctrl+S)', `early=${JSON.stringify(early)} late=${JSON.stringify(late)}`);
    const undo = win.locator('.top-bar').getByRole('button', { name: /^Undo/ }).first();
    await undo.hover(); await delay(900);
    const u = await tipOf();
    R.check('the Undo tooltip names the action and the shortcut', /^Undo .*[Dd]uplicate.*\(Ctrl\+Z\)$/.test(u ?? ''), JSON.stringify(u));
    await win.mouse.move(700, 400); await delay(300);
    await save.focus(); await win.keyboard.press('Shift+Tab'); await win.keyboard.press('Tab'); await delay(900);
    const k = await tipOf();
    R.check('keyboard: moving focus onto Save with Tab shows its tooltip', k === 'Save (Ctrl+S)', JSON.stringify(k));
    await win.keyboard.press('Escape');
    const noKeys = (await snapshot()).buttons.filter((b) => b.tag === 'BUTTON' && !b.keys).map((b) => b.label);
    R.info(`toolbar buttons with no aria-keyshortcuts (commands without a shortcut): ${JSON.stringify(noKeys)}`);
  });
  const errs = s.errors.filter((e) => !/favicon/.test(e));
  R.check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 400));
  // Leave nothing unsaved behind.
  await win.keyboard.press('Control+Shift+w'); await delay(500);
  const p = win.getByRole('alertdialog');
  if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
} catch (err) {
  R.check('probe ran to the end', false, String(err && err.stack ? err.stack : err).slice(0, 600));
} finally {
  await closeAll();
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
