// Probe G: the classic menu bar by keyboard (Alt, F10, mnemonics, arrows, Esc), menu contents against the spec, the Help
// dialogs, the Window menu, the title with a long file name, a read-only XFA form, two tabs, and split view after edits.
import { join } from 'node:path';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitForCount, pageCount, fixture, waitFor, delay, ROOT,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, plainEnglish, toasts, isDirty, snapshot, statusText, showPanel,
} from './lib.mjs';

const R = makeReport('g-menu-keyboard-misc');
const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-so3-'));
const a = copyOf('outline-6.pdf');
let s;

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, a.path, 6);
  await watchToasts(win);
  const rawStep = R.step.bind(R);
  R.step = async (label, fn) => {
    try {
      for (let i = 0; i < 3 && (await win.locator('.menu-dropdown, .menu-button-on').count()) > 0; i++) await win.keyboard.press('Escape');
      await win.mouse.move(760, 520);
      await delay(150);
    } catch { /* the step reports its own failure */ }
    await rawStep(label, fn);
  };

  // ----- Menu contents against the spec
  const spec = {
    File: ['Open', 'Open Recent', 'Save', 'Save As…', 'Extract Pages…', 'Close Tab', 'Close All', 'Document Properties…', 'Exit'],
    Edit: ['Undo', 'Redo', 'Copy', 'Select All', 'Find…', 'Find Next', 'Find Previous', 'Go to Page…', 'Command Palette…'],
    View: ['Zoom In', 'Zoom Out', 'Actual Size', 'Fit Page', 'Fit Width', 'Rotate View', 'Split', 'Loupe', 'Pan and Zoom', 'Panels', 'Page Colors', 'Theme', 'Toolbar', 'Full Screen'],
    Pages: ['Insert Blank Page…', 'Insert Lined Page…', 'Insert Grid Page…', 'Insert from PDF…', 'Delete Pages', 'Rotate Right 90°', 'Rotate Left 90°', 'Rotate 180°', 'Custom Angle…', 'Crop Pages…', 'Auto-Crop', 'Page Size…', 'Duplicate', 'Replace…', 'Reverse'],
    Window: ['Next Tab', 'Previous Tab'],
    Help: ['Keyboard Shortcuts…', 'Open Logs Folder', 'About PDF Suite…'],
  };
  const accelWant = { Save: 'Ctrl+S', 'Save As…': 'Ctrl+Shift+S', Undo: 'Ctrl+Z', 'Delete Pages': 'Delete', Duplicate: 'Ctrl+D', 'Rotate Right 90°': 'Ctrl+Shift+R', 'Rotate Left 90°': 'Ctrl+Shift+L', 'Close Tab': 'Ctrl+W', 'Open…': 'Ctrl+O' };
  for (const [top, want] of Object.entries(spec)) {
    const items = await menuItems(win, top);
    const labels = items.map((i) => i.label);
    const missing = want.filter((w) => !labels.some((l) => l === w || l.startsWith(w)));
    R.check(`${top} menu has the spec items`, missing.length === 0, `missing ${JSON.stringify(missing)} have ${JSON.stringify(labels)}`);
    for (const i of items) if (accelWant[i.label] && !i.accel.includes(accelWant[i.label])) R.check(`${top} ▸ ${i.label} shows ${accelWant[i.label]}`, false, `shows "${i.accel}"`);
  }
  R.info('Pages menu: ' + JSON.stringify((await menuItems(win, 'Pages')).map((i) => `${i.label}${i.accel ? ` [${i.accel}]` : ''}`)));

  // ----- Keyboard access
  await R.step('Alt alone focuses the bar and underlines F E V P W H; Esc gives the focus back', async () => {
    await win.locator('.thumb').first().click();
    // Park the pointer in the middle of the page, away from where the menus drop down.
    await win.mouse.move(760, 520);
    await win.keyboard.press('Alt');
    await delay(200);
    const marks = await win.locator('.menu-tops > .menu-top > button .menu-mn').allInnerTexts();
    R.check('mnemonics underlined', marks.join('') === 'FEVPWH', marks.join(''));
    const focused = await win.evaluate(() => document.activeElement?.textContent ?? '');
    R.check('the File button has the focus', focused === 'File', focused);
    await win.keyboard.press('Escape');
    await delay(150);
    R.check('Esc leaves the bar', (await win.locator('.menu-button-on').count()) === 0 && (await win.evaluate(() => document.activeElement?.closest('.menu-row') === null)));
  });
  await R.step('F10, arrows to Pages, Down opens it, arrows walk past disabled items, Enter runs', async () => {
    await jumpTo(win, 0);
    await win.keyboard.press('F10');
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight');
    await win.keyboard.press('ArrowDown');
    await win.locator('.menu-dropdown[aria-label="Pages"]').waitFor({ timeout: 3000 });
    // Walk down to "Duplicate" and run it with Enter.
    let found = false;
    for (let i = 0; i < 20; i++) {
      const label = await win.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? '');
      if (label === 'Duplicate') {
        found = true;
        break;
      }
      await win.keyboard.press('ArrowDown');
      await delay(40);
    }
    R.check('arrow keys reach Duplicate with real focus', found);
    const t = await toastAfter(win, () => win.keyboard.press('Enter'));
    await waitForCount(win, 7);
    R.check('Enter ran Duplicate from the keyboard', /Duplicated 1 page/.test(t), t);
  });
  await R.step('Alt+P then the item letter runs the item (Delete Pages)', async () => {
    await win.keyboard.press('Alt+p');
    await win.locator('.menu-dropdown[aria-label="Pages"]').waitFor({ timeout: 3000 });
    const letter = await win.locator('.menu-dropdown[aria-label="Pages"] .menu-item', { hasText: 'Delete Pages' }).locator('.menu-mn').innerText();
    const t = await toastAfter(win, () => win.keyboard.press(letter.toLowerCase()));
    await waitForCount(win, 6);
    R.check(`mnemonic "${letter}" ran Delete Pages`, /Deleted 1 page/.test(t), t);
  });
  await R.step('no menu has two items with the same letter', async () => {
    for (const top of Object.keys(spec)) {
      await win.keyboard.press(`Alt+${top[0].toLowerCase()}`);
      try {
        await win.locator(`.menu-dropdown[aria-label="${top}"]`).waitFor({ timeout: 3000 });
      } catch {
        const state = await win.evaluate(() => ({ open: [...document.querySelectorAll('.menu-dropdown')].map((d) => d.getAttribute('aria-label')), on: [...document.querySelectorAll('.menu-button-on')].map((b) => b.textContent), focus: `${document.activeElement?.tagName}.${document.activeElement?.className}`, sheet: document.querySelector('.side-sheet')?.getAttribute('aria-label') ?? null, dialogs: [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map((d) => d.getAttribute('aria-label')) }));
        R.check(`Alt+${top[0]} opens the ${top} menu`, false, JSON.stringify(state));
        await win.keyboard.press('Escape');
        continue;
      }
      const letters = await win.locator(`.menu-dropdown[aria-label="${top}"] > .menu-item .menu-mn, .menu-dropdown[aria-label="${top}"] > .menu-sub-wrap > .menu-item .menu-mn`).allInnerTexts();
      const lower = letters.map((l) => l.toLowerCase());
      R.check(`${top}: mnemonics unique (${letters.join('')})`, new Set(lower).size === lower.length && lower.length > 0);
      await win.keyboard.press('Escape');
      await delay(100);
    }
  });
  await R.step('Alt+E, U undoes; Left/Right move between open menus; submenu opens with Right', async () => {
    await win.keyboard.press('Alt+e');
    await win.locator('.menu-dropdown[aria-label="Edit"]').waitFor({ timeout: 3000 });
    const undo = await win.locator('.menu-dropdown[aria-label="Edit"] .menu-item').first().innerText();
    R.check('Edit menu names the step to undo', /Undo Delete 1 page/.test(undo), undo.replace(/\n/g, ' '));
    await win.keyboard.press('ArrowRight');
    await win.locator('.menu-dropdown[aria-label="View"]').waitFor({ timeout: 3000 });
    await win.keyboard.press('ArrowLeft');
    await win.locator('.menu-dropdown[aria-label="Edit"]').waitFor({ timeout: 3000 });
    await win.keyboard.press('Enter'); // first item: Undo
    await waitForCount(win, 7);
    R.check('Enter on Undo undid the delete', true);
  });
  await R.step('keyboard: Alt+V, Down to Theme, Right opens the submenu, Enter picks Dark', async () => {
    await win.mouse.move(760, 520);
    await delay(300);
    await win.keyboard.press('Alt+v');
    await win.locator('.menu-dropdown[aria-label="View"]').waitFor({ timeout: 3000 });
    const walked = [];
    for (let i = 0; i < 20; i++) {
      const label = await win.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? `(focus on ${document.activeElement?.tagName}.${document.activeElement?.className})`);
      walked.push(label);
      if (label === 'Theme') break;
      await win.keyboard.press('ArrowDown');
      await delay(60);
    }
    R.info(`focus walk in View: ${walked.join(' > ')}`);
    R.check('arrow keys reach the Theme submenu row with real focus', walked.at(-1) === 'Theme');
    await win.keyboard.press('ArrowRight');
    await win.locator('.menu-sub[aria-label="Theme"]').waitFor({ timeout: 3000 });
    const subs = await win.locator('.menu-sub[aria-label="Theme"] .menu-item').allInnerTexts();
    R.check('Theme submenu: System, Light, Dark', ['System', 'Light', 'Dark'].every((x) => subs.some((t) => t.includes(x))), JSON.stringify(subs));
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter'); // Dark
    await delay(400);
    const theme = await win.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className);
    R.info(`theme after choosing Dark from the keyboard: ${theme}`);
    await shot(win, 'g-dark');
  });
  await R.step('mouse: View ▸ Theme ▸ Light (hover opens the submenu)', async () => {
    await menu(win, 'View', 'Theme', 'Light');
    await delay(300);
    R.check('theme is light again', (await win.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className)) !== 'dark');
  });
  await R.step('a pointer resting where a submenu row appears must not take over keyboard navigation', async () => {
    // Find where the "Panels" row of the View menu is, rest the pointer there, close, then open View from the keyboard.
    await win.keyboard.press('Alt+v');
    await win.locator('.menu-dropdown[aria-label="View"]').waitFor({ timeout: 3000 });
    const box = await win.locator('.menu-dropdown[aria-label="View"] .menu-sub-wrap', { hasText: 'Panels' }).boundingBox();
    await win.keyboard.press('Escape');
    await delay(200);
    await win.mouse.move(box.x + 40, box.y + box.height / 2);
    await delay(200);
    await win.keyboard.press('Alt+v');
    await win.locator('.menu-dropdown[aria-label="View"]').waitFor({ timeout: 3000 });
    await delay(300);
    const walked = [];
    for (let i = 0; i < 4; i++) {
      await win.keyboard.press('ArrowDown');
      await delay(80);
      walked.push(await win.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? '?'));
    }
    const subOpen = await win.locator('.menu-sub').count();
    R.info(`pointer resting on the Panels row, View opened with Alt+V, Down x4 focuses: ${walked.join(' > ')} (submenu open: ${subOpen > 0})`);
    R.check('keyboard walk goes Zoom Out > Actual Size > Fit Page > Fit Width, whatever the pointer rests on', walked.join('>') === 'Zoom Out>Actual Size>Fit Page>Fit Width', walked.join(' > '));
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    await win.mouse.move(760, 520);
    await delay(200);
  });

  // ----- Help
  await R.step('Help ▸ Keyboard Shortcuts and About', async () => {
    await menu(win, 'Help', 'Keyboard Shortcuts…');
    const k = win.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    await k.waitFor({ timeout: 3000 });
    const text = await k.innerText();
    R.check('shortcuts dialog lists the organizer keys', ['Ctrl+S', 'Ctrl+Z', 'Ctrl+D', 'Delete', 'Ctrl+Shift+R', 'Alt+Up'].every((x) => text.includes(x)), text.replace(/\n/g, ' ').slice(0, 300));
    await win.keyboard.press('Escape');
    await menu(win, 'Help', 'About PDF Suite…');
    const about = win.getByRole('dialog', { name: 'About PDF Suite' });
    await about.waitFor({ timeout: 3000 });
    const at = await about.innerText();
    R.check('About: version, MuPDF AGPL, pdf.js Apache, no Adobe', /version \d+\.\d+\.\d+/.test(at) && /MuPDF/.test(at) && /Affero|AGPL/.test(at) && /pdf\.js/.test(at) && /Apache/.test(at) && !/adobe|acrobat/i.test(at), at.replace(/\n/g, ' '));
    await win.keyboard.press('Escape');
    R.check('Esc closes the Help dialog', (await about.count()) === 0);
  });
  const bodyText = await win.evaluate(() => document.body.innerText);
  R.check('no "Adobe" or "Acrobat" anywhere in the window', !/adobe|acrobat/i.test(bodyText));

  // ----- Two tabs, Window menu, a long file name
  await R.step('second tab: Window menu lists both, the dot marks the unsaved one, edits stay in their own tab', async () => {
    const longName = join(dir, `A very long file name that goes on and on ${'and on '.repeat(18)}final.pdf`);
    copyFileSync(fixture('mixed-sizes-rotated.pdf'), longName);
    await open(s, longName, 8);
    const items = (await menuItems(win, 'Window')).map((i) => i.label);
    R.check('Window menu lists both tabs, • on the unsaved one', items.some((l) => /outline-6\.pdf/.test(l) && l.includes('•')) && items.some((l) => /A very long file name/.test(l) && !l.includes('•')), JSON.stringify(items.map((l) => l.slice(0, 40))));
    const boxes = await win.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const t = r('.menu-title');
      const m = r('.menu-tops');
      const w = r('.menu-window-space');
      const tail = r('.menu-title-tail');
      return { title: [t.left, t.right], menus: [m.left, m.right], space: [w.left, w.right], tail: tail ? [tail.left, tail.right] : null, width: innerWidth };
    });
    R.check('long title does not overlap the menus or the window buttons', boxes.title[0] >= boxes.menus[1] - 1 && boxes.title[1] <= boxes.space[0] + 1 && boxes.tail && boxes.tail[1] <= boxes.space[0] + 1, JSON.stringify(boxes));
    await shot(win, 'g-long-title');
    // Undo in the clean tab must do nothing to the other tab.
    const edits = await menuItems(win, 'Edit');
    R.check('the clean tab has nothing to undo', edits[0].disabled && edits[0].label === 'Undo', edits[0].label);
    await win.keyboard.press('Control+z');
    await delay(400);
    await menu(win, 'Window', 'Next Tab');
    await waitFor(async () => /of 7/.test(await statusText(win)), { timeoutMs: 8000, label: 'back on the first tab with 7 pages' });
    R.check('first tab kept its 7 pages and unsaved state', await isDirty(win));
    // A sheet belongs to one document: switching tabs closes it.
    await showPanel(win, 'Thumbnails');
    await menu(win, 'Pages', 'Page Size…');
    await sheet(win, 'Page size').waitFor({ timeout: 3000 });
    await win.keyboard.press('Control+Tab');
    await waitFor(async () => /of 8/.test(await statusText(win)), { timeoutMs: 8000, label: 'second tab' });
    R.check('switching tabs closes the open sheet', (await sheet(win, 'Page size').count()) === 0);
    await win.keyboard.press('Control+w');
    await waitFor(async () => (await win.getByRole('tab').count()) === 1, { timeoutMs: 8000, label: 'one tab' });
  });

  // ----- Split view after edits
  await R.step('split view on an edited document: both panes follow edits', async () => {
    await waitFor(async () => /of 7/.test(await statusText(win)), { timeoutMs: 8000, label: 'first tab' });
    await menu(win, 'View', 'Split', 'Vertical');
    await waitFor(async () => (await win.locator('.pane, .viewer-pane, [data-pane-id]').count()) >= 2, { timeoutMs: 8000, label: 'two panes' }).catch(() => undefined);
    await showPanel(win, 'Thumbnails');
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 8);
    await delay(800);
    const pagesPerPane = await win.evaluate(() => {
      const scrollers = [...document.querySelectorAll('.page')].reduce((map, el) => {
        const pane = el.closest('[data-pane-id], .pane, .viewer-pane, .viewer') ?? document.body;
        map.set(pane, (map.get(pane) ?? 0) + 1);
        return map;
      }, new Map());
      return [...scrollers.values()];
    });
    R.info(`drawn page elements per pane after an edit in split view: ${JSON.stringify(pagesPerPane)}`);
    await shot(win, 'g-split-after-edit');
    await menu(win, 'View', 'Split', 'None');
    R.check('split view: no errors after an edit', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 600));
  });

  // ----- XFA form: read-only
  await R.step('XFA form: organizer commands are greyed out with the plain reason', async () => {
    const xfa = join(ROOT, 'tests', 'engine', 'corpus', 'xfa', 'xfa_filled_imm1344e.pdf');
    if (!existsSync(xfa)) {
      R.info('no XFA file in the corpus: not checked');
      return;
    }
    const copy = join(dir, 'form.pdf');
    copyFileSync(xfa, copy);
    await s.setDialogAnswer([copy]);
    await win.keyboard.press('Control+o');
    await waitFor(async () => (await win.getByRole('tab').count()) === 2 && /Page 1 of \d+/.test(await statusText(win)) && !/of 8/.test(await statusText(win)), { timeoutMs: 40000, label: 'XFA open' });
    await delay(1500);
    const items = await menuItems(win, 'Pages');
    R.check('XFA: every Pages item is disabled', items.every((i) => i.disabled), JSON.stringify(items.filter((i) => !i.disabled).map((i) => i.label)));
    R.check('XFA: the tooltip says why', items.every((i) => i.title === 'This form can be viewed but not edited yet.'), JSON.stringify([...new Set(items.map((i) => i.title))]));
    const before = await statusText(win);
    await win.keyboard.press('Delete');
    await win.keyboard.press('Control+d');
    await delay(600);
    R.check('XFA: Delete and Ctrl+D do nothing', (await statusText(win)) === before);
    await win.keyboard.press('Control+w');
  });

  const all = await toasts(win);
  R.check('every toast is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'g-failure');
} finally {
  await closeAll();
  removeCopy(a);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = R.summary() ? 1 : 0;
}
