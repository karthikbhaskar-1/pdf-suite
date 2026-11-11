// Sign-Off 11, E: Combine with the keyboard only; a real (CDP) file drop if this build accepts one; a wording pass on the
// Combine window and the Split sheet against docs/milestone-1.3/1.3-ui-spec.md. Auditor code only.
import { join } from 'node:path';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, open, openSheet, ready, chooseFolder, anyNotice, splitButton, listing, sha, closeNotice, delay, waitFor, windowOf, rowNames, rowsReady, waitNotice, statusText, openCombine } from '../signoff9/lib9.mjs';

const R = report('s11-e-keyboard-wording');

const active = (win) => win.evaluate(() => {
  const e = document.activeElement;
  if (!e) return { tag: 'none' };
  const label = e.getAttribute('aria-label') || (e.labels && e.labels[0] ? e.labels[0].textContent : '') || (e.tagName === 'BUTTON' ? e.textContent : '') || '';
  return { tag: e.tagName, role: e.getAttribute('role') || '', label: label.replace(/\s+/g, ' ').trim().slice(0, 60), type: e.getAttribute('type') || '', page: e.getAttribute('data-page'), inDialog: !!e.closest('[data-combine]'), text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) };
});
async function tabTo(win, pred, { max = 40, shift = false } = {}) {
  for (let i = 0; i < max; i++) {
    const a = await active(win);
    if (pred(a)) return a;
    await win.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
  }
  return null;
}

await R.step('E1 Combine with the keyboard only', async () => {
  const dir = dirOf('kb');
  const c = put(dir, 'c.pdf', buildPdf({ pages: 2, tag: 'C' }));
  const a = put(dir, 'a.pdf', buildPdf({ pages: 4, tag: 'A' }));
  const b = put(dir, 'b.pdf', buildPdf({ pages: 3, tag: 'B' }));
  const before = [sha(a), sha(b), sha(c)];
  const out = join(dirOf('out'), 'Keys.pdf');
  const s = await start();
  const win = s.win;
  try {
    await win.waitForSelector('.empty-state');
    // open with the palette, typed
    await win.keyboard.press('Control+k');
    await win.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 5000 });
    await win.keyboard.type('Combine files');
    await delay(500);
    await win.keyboard.press('Enter');
    const dlg = windowOf(win);
    await dlg.waitFor({ timeout: 10000 });
    await delay(300);
    let a0 = await active(win);
    R.check('empty window: focus is on Add files…', a0.inDialog && /Add files/.test(a0.label), a0);
    await s.setDialogAnswer([c, a, b]);
    await win.keyboard.press('Enter');
    await rowsReady(dlg, 3);
    R.say(`INFO rows as added: ${JSON.stringify(await rowNames(dlg))}; focus after adding: ${JSON.stringify(await active(win))}`);
    // one full Tab cycle: the order of stops, and the trap
    const stops = [];
    const first = await active(win);
    for (let i = 0; i < 40; i++) {
      await win.keyboard.press('Tab');
      const x = await active(win);
      stops.push(`${x.inDialog ? '' : 'OUTSIDE:'}${x.role || x.tag.toLowerCase()}:${x.label || x.text}`);
      if (i > 3 && x.tag === first.tag && x.label === first.label && x.role === first.role) break;
    }
    R.say(`INFO Tab stops: ${JSON.stringify(stops)}`);
    R.check('Tab never leaves the Combine window (focus trapped)', !stops.some((x) => x.startsWith('OUTSIDE:')));
    // Sort by name
    R.check('Sort by name can be reached', !!(await tabTo(win, (x) => /Sort by name/.test(x.label))));
    await win.keyboard.press('Enter');
    await delay(300);
    R.check('Sort by name with Enter: a, b, c', JSON.stringify(await rowNames(dlg)) === '["a.pdf","b.pdf","c.pdf"]', await rowNames(dlg));
    // list: move with Alt+arrows
    R.check('the list can be reached', !!(await tabTo(win, (x) => x.role === 'listbox')));
    await win.keyboard.press('Home');
    await win.keyboard.press('Alt+ArrowDown');
    await delay(300);
    const said1 = (await dlg.locator('[data-combine-announce]').innerText()).trim();
    R.check('Alt+Down moves a.pdf to second place and says so', JSON.stringify(await rowNames(dlg)) === '["b.pdf","a.pdf","c.pdf"]' && said1 === 'a.pdf moved to 2 of 3', { rows: await rowNames(dlg), said1 });
    await win.keyboard.press('Alt+End');
    await delay(300);
    const said2 = (await dlg.locator('[data-combine-announce]').innerText()).trim();
    R.check('Alt+End moves it last', JSON.stringify(await rowNames(dlg)) === '["b.pdf","c.pdf","a.pdf"]', { rows: await rowNames(dlg), said2 });
    await win.keyboard.press('Alt+Home');
    await delay(300);
    R.check('Alt+Home moves it first', JSON.stringify(await rowNames(dlg)) === '["a.pdf","b.pdf","c.pdf"]', await rowNames(dlg));
    // Delete removes the focused row (b.pdf)
    await win.keyboard.press('ArrowDown');
    await delay(150);
    await win.keyboard.press('Delete');
    await delay(300);
    R.check('Arrow Down then Delete removes b.pdf', JSON.stringify(await rowNames(dlg)) === '["a.pdf","c.pdf"]', await rowNames(dlg));
    R.say(`INFO focus after Delete: ${JSON.stringify(await active(win))}`);
    // Ctrl+A selects all (read aria-selected), then Home selects a.pdf only
    await tabTo(win, (x) => x.role === 'listbox');
    await win.keyboard.press('Control+a');
    await delay(150);
    const sel = await dlg.locator('[role="option"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-selected')));
    R.check('Ctrl+A selects every row', sel.length === 2 && sel.every((v) => v === 'true'), sel);
    await win.keyboard.press('Home');
    await delay(200);
    // Pages field of the focused row
    await win.keyboard.press('Tab');
    const pf = await active(win);
    R.check('Tab from the list goes to the Pages field of the focused row', pf.tag === 'INPUT' && /Pages/i.test(pf.label), pf);
    await win.keyboard.type('1-3');
    await delay(600);
    // preview
    await win.keyboard.press('Tab');
    const pv = await tabTo(win, (x) => x.page !== null && x.page !== undefined, { max: 3 });
    R.check('next Tab stop is a page of the preview (a checkbox)', !!pv && pv.role === 'checkbox', pv ?? (await active(win)));
    if (pv) {
      R.say(`INFO preview page focused: ${JSON.stringify(pv)}`);
      await win.keyboard.press('Space');
      await delay(500);
      const value = await dlg.locator('[data-row-name="a.pdf"] input[type="text"]').first().inputValue().catch(() => '?');
      const labelNow = (await active(win)).label;
      R.check('Space leaves that page out and rewrites Pages (1-3 without page 1 = "2-3")', value.replace(/\s+/g, '') === '2-3', { value, labelNow });
      R.check('the page says "Page 1, left out"', /Page 1, left out/.test(labelNow), labelNow);
    }
    // options: untick "Open the new file when it is ready" with Space
    const opt = await tabTo(win, (x) => /Open the new file when it is ready/.test(x.label));
    R.check('the Open-when-ready box can be reached', !!opt, await active(win));
    await win.keyboard.press('Space');
    await delay(150);
    R.check('Space unticks it', !(await dlg.getByLabel('Open the new file when it is ready').isChecked()));
    // Combine… with Enter
    const go = await tabTo(win, (x) => /^Combine…$/.test(x.label));
    R.check('Combine… can be reached', !!go, await active(win));
    await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
    await win.keyboard.press('Enter');
    const note = await waitNotice(s, /Combined 2 files/);
    R.say(`INFO notice: ${note}`);
    R.check('done notice is the spec text with Show in folder and Open', /^Combined 2 files into Keys\.pdf \(4 pages\)\./.test(note) && /Show in folder/.test(note) && /Open/.test(note), note);
    const p = inspect(out);
    R.check('the result is a.pdf pages 2-3 then c.pdf 1-2', p.text.join('|') === 'A 2|A 3|C 1|C 2', p.text);
    R.check('inputs unchanged', sha(a) === before[0] && sha(b) === before[1] && sha(c) === before[2]);
    R.say(`INFO focus after the window closed: ${JSON.stringify(await active(win))}`);
    // the notice buttons by keyboard, then Esc on a reopened window
    await closeNotice(s);
    await win.keyboard.press('Control+k');
    await win.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 5000 });
    await win.keyboard.type('Combine files');
    await delay(500);
    await win.keyboard.press('Enter');
    await windowOf(win).waitFor({ timeout: 10000 });
    R.check('after a success the list is empty again', (await rowNames(windowOf(win))).length === 0);
    await win.keyboard.press('Escape');
    await delay(500);
    R.check('Esc closes the window', (await windowOf(win).count()) === 0);
  } finally { await s.close(); }
});

await R.step('E2 a real file drop (through the browser debugger), if this build takes one', async () => {
  const dir = dirOf('drop');
  const a = put(dir, 'drop-a.pdf', buildPdf({ pages: 2, tag: 'DA' }));
  const b = put(dir, 'drop-b.pdf', buildPdf({ pages: 3, tag: 'DB' }));
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    let cdp = null;
    try { cdp = await s.win.context().newCDPSession(s.win); } catch (e) { R.say(`INFO no debugger session: ${String(e.message).slice(0, 120)}`); }
    if (!cdp) { R.say('INFO UNTESTABLE: drop routing could not be driven'); return; }
    const drop = async (x, y, files) => {
      const data = { items: [], files, dragOperationsMask: 1 };
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    };
    let took = false;
    try {
      await drop(500, 400, [a, b]);
      await waitFor(async () => /Page 1 of/.test(await statusText(s.win)), { timeoutMs: 10000, label: 'dropped files opened' });
      took = true;
    } catch (e) { R.say(`INFO the debugger drop did not open the files: ${String(e.message).split('\n')[0].slice(0, 160)}`); }
    if (!took) { R.say('INFO UNTESTABLE: the preload trusts only real drops, and a debugger drop is not accepted as one in this build'); return; }
    await delay(800);
    const toasts = await s.win.locator('.toast').allInnerTexts();
    R.say(`INFO toasts after dropping two PDFs: ${JSON.stringify(toasts)}`);
    R.check('dropping two PDFs opens them and offers "Opened 2 files · Combine them…"', toasts.some((t) => /Opened 2 files/.test(t) && /Combine them…/.test(t)), toasts);
    const offer = s.win.locator('.toast').getByText('Combine them…').first();
    if (await offer.count()) {
      await offer.click();
      const dlg = windowOf(s.win);
      await dlg.waitFor({ timeout: 10000 });
      await rowsReady(dlg, 2);
      R.check('the offer opens Combine with the two dropped files listed', JSON.stringify((await rowNames(dlg)).sort()) === '["drop-a.pdf","drop-b.pdf"]', await rowNames(dlg));
      const c = put(dir, 'drop-c.pdf', buildPdf({ pages: 1, tag: 'DC' }));
      const tabsBefore = await s.win.locator('[role="tab"]').count();
      const box = await dlg.boundingBox();
      await drop(Math.round(box.x + box.width / 3), Math.round(box.y + box.height / 2), [c]);
      await delay(2500);
      R.check('a drop on the Combine window adds to its list and does not open a tab behind it', (await rowNames(dlg)).includes('drop-c.pdf') && (await s.win.locator('[role="tab"]').count()) === tabsBefore, { rows: await rowNames(dlg), tabsBefore, tabsNow: await s.win.locator('[role="tab"]').count() });
      await s.win.keyboard.press('Escape');
    }
  } finally { await s.close(); }
});

await R.step('E3 wording: Combine window', async () => {
  const dir = dirOf('w');
  const a = put(dir, 'Report.pdf', buildPdf({ pages: 12, tag: 'R' }));
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const dlg = await openCombine(s);
    const empty = (await dlg.innerText()).replace(/\s+/g, ' ').trim();
    R.say(`INFO Combine window, empty: ${empty}`);
    for (const t of ['Combine files', 'Add files…', 'Add open files', 'Remove', 'Move up', 'Move down', 'Sort by name', 'Add the files you want to combine. Drop them here, or choose Add files…', 'Add a bookmark for each file', 'Picture pages', 'Text pages', 'Open the new file when it is ready', 'Cancel', 'Combine…']) R.check(`Combine window shows "${t}"`, empty.includes(t));
    const selects = await dlg.locator('select').evaluateAll((els) => els.map((e) => ({ label: e.getAttribute('aria-label') || (e.labels && e.labels[0] ? e.labels[0].textContent.trim() : ''), value: e.options[e.selectedIndex].textContent, options: [...e.options].map((o) => o.textContent) })));
    R.say(`INFO selects: ${JSON.stringify(selects)}`);
    R.check('Picture pages: default "Same size as the picture", then A4, Letter', selects.some((x) => JSON.stringify(x.options) === '["Same size as the picture","A4","Letter"]' && x.value === 'Same size as the picture'), selects);
    R.check('Text pages: default Letter, then A4', selects.some((x) => JSON.stringify(x.options) === '["Letter","A4"]' && x.value === 'Letter'), selects);
    R.check('both check boxes are on by default', (await dlg.getByLabel('Add a bookmark for each file').isChecked()) && (await dlg.getByLabel('Open the new file when it is ready').isChecked()));
    R.check('Add open files is off with no document open; Combine… is off with an empty list', (await dlg.getByRole('button', { name: 'Add open files' }).isDisabled()) && (await dlg.getByRole('button', { name: 'Combine…' }).isDisabled()));
    await s.setDialogAnswer([a]);
    await dlg.getByRole('button', { name: 'Add files…' }).click();
    await rowsReady(dlg, 1);
    R.say(`INFO row: ${(await dlg.locator('[data-row-id]').first().innerText()).replace(/\s+/g, ' ')}; summary: ${(await dlg.locator('[data-combine-summary]').innerText()).trim()}`);
    R.check('summary reads "1 file · 12 pages · <size>"', /^1 file · 12 pages · [\d.,]+ (KB|MB|bytes)$/.test((await dlg.locator('[data-combine-summary]').innerText()).trim()), (await dlg.locator('[data-combine-summary]').innerText()).trim());
    const field = dlg.locator('[data-row-id] input[type="text"]').first();
    R.say(`INFO Pages field placeholder "${await field.getAttribute('placeholder')}", label "${await field.getAttribute('aria-label')}"`);
    await field.fill('40');
    await delay(500);
    R.say(`INFO range error for "40": ${(await dlg.locator('[data-combine-range-error]').allInnerTexts()).join(' | ')}; Combine off: ${await dlg.getByRole('button', { name: 'Combine…' }).isDisabled()}`);
    R.check('a bad range shows a message under the field and turns Combine… off', (await dlg.locator('[data-combine-range-error]').count()) === 1 && (await dlg.getByRole('button', { name: 'Combine…' }).isDisabled()));
    await s.win.keyboard.press('Escape');
  } finally { await s.close(); }
});

await R.step('E4 wording: Split sheet', async () => {
  const dir = dirOf('w2');
  const path = put(dir, 'Report.pdf', buildPdf({ pages: 12, tag: 'R' }));
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 12);
    const sheet = await openSheet(s);
    await ready(sheet);
    const text = async () => (await sheet.innerText()).replace(/\s+/g, ' ').trim();
    let t = await text();
    R.say(`INFO Split sheet, page count: ${t}`);
    for (const x of ['Split into files', 'Split by', 'Page count', 'File size', 'Blank pages', 'Bookmarks', 'Pages in each file', 'Save in', 'No folder chosen yet', 'Choose folder…', 'File name', 'Cancel', 'Split']) R.check(`Split sheet shows "${x}"`, t.includes(x));
    R.check('source line "Report.pdf · 12 pages · <size>"', /Report\.pdf · 12 pages · [\d.,]+ (KB|MB)/.test(t));
    R.check('default: Page count, 10 pages in each file, file name "Report"', (await sheet.getByRole('radio', { name: 'Page count' }).isChecked()) && (await sheet.getByLabel('Pages in each file').inputValue()) === '10' && (await sheet.getByLabel('File name').inputValue()) === 'Report');
    R.check('example and count: "Report - part 01.pdf … Report - part 02.pdf", "Makes 2 files."', t.includes('Report - part 01.pdf … Report - part 02.pdf') && t.includes('Makes 2 files.'), t.slice(-260));
    R.check('the "(2)" line', t.includes('If a file with that name is already there, the new one gets “(2)”. Nothing is replaced.'));
    R.check('Split is off until a folder is chosen', await splitButton(sheet).isDisabled());
    await sheet.getByLabel('Pages in each file').fill('12');
    await delay(300);
    R.check('pages = all pages: "Enter a whole number from 1 to 11."', (await text()).includes('Enter a whole number from 1 to 11.'), (await sheet.locator('[data-split-error]').allInnerTexts()).join('|'));
    await sheet.getByLabel('Pages in each file').fill('5');
    await sheet.getByLabel('File name').fill('');
    await delay(300);
    R.check('empty name: "Enter a name for the new files."', (await text()).includes('Enter a name for the new files.'));
    await sheet.getByLabel('File name').fill('a*b');
    await delay(300);
    R.check('bad character: the spec message', (await text()).includes('A file name can\'t contain \\ / : * ? " < > |'), (await sheet.locator('[data-split-error]').allInnerTexts()).join('|'));
    await sheet.getByLabel('File name').fill('Report');
    await sheet.getByRole('radio', { name: 'File size' }).click();
    await delay(400);
    t = await text();
    R.say(`INFO File size: ${t}`);
    R.check('file size on a small file: "This document is already smaller than 10 MB, so there is nothing to split."', t.includes('This document is already smaller than 10 MB, so there is nothing to split.'));
    await sheet.getByLabel('Size unit').selectOption('KB');
    await sheet.getByLabel('Largest file').fill('50');
    await delay(300);
    R.check('under 100 KB: "Enter a size of at least 100 KB."', (await text()).includes('Enter a size of at least 100 KB.'), (await sheet.locator('[data-split-error]').allInnerTexts()).join('|'));
    await sheet.getByRole('radio', { name: 'Bookmarks' }).click();
    await delay(400);
    R.check('no bookmarks: "This document has no bookmarks to split by."', (await text()).includes('This document has no bookmarks to split by.'));
    await sheet.getByRole('radio', { name: 'Blank pages' }).click();
    await sheet.getByText(/No blank pages were found|Found \d+ blank/).first().waitFor({ timeout: 60000 });
    t = await text();
    R.say(`INFO Blank pages: ${t}`);
    R.check('no blank pages: the spec message', t.includes('No blank pages were found. Try “Blank and nearly blank pages”, or split another way.'));
    await sheet.getByRole('radio', { name: 'Page count' }).click();
    await sheet.getByLabel('Pages in each file').fill('5');
    const out = dirOf('out');
    await chooseFolder(s, sheet, out);
    R.say(`INFO folder line: ${(await sheet.locator('[data-split-folder]').innerText()).trim().slice(-60)}; title attr holds the full path: ${(await sheet.locator('[data-split-folder]').getAttribute('title')) === out}`);
    R.check('Makes 3 files.', (await text()).includes('Makes 3 files.'));
    await splitButton(sheet).click();
    const note = await anyNotice(s, 60000);
    R.check('done notice "Split Report.pdf into 3 files." with Show in folder', /^Split Report\.pdf into 3 files\./.test(note) && /Show in folder/.test(note), note);
    R.check('files named as the example', JSON.stringify(listing(out)) === '["Report - part 01.pdf","Report - part 02.pdf","Report - part 03.pdf"]', listing(out));
    await closeNotice(s);
  } finally { await s.close(); }
});

await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
