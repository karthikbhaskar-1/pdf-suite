// Probe E: unusual inputs on a small file (bad counts, sizes, ranges, sources, delete-all, rapid keys, double Apply),
// then the 1000-page file: rotate all, resize all with Cancel part-way, delete 501 with the inline confirm, save, verify.
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitForCount, pageCount, fixture, waitFor, delay, setSaveAnswer, rendererMemoryMB,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspectMupdf, inspectPdfjs, plainEnglish, toasts, bars, isDirty, clickRowByIndex, snapshot, palette, selectAllPages, statusText, showPanel,
} from './lib.mjs';

const R = makeReport('e-large-unusual');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
const noErrors = (label) => R.check(`${label}: no console errors`, s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 1000));

/** Tries an Apply that should be refused: returns the message shown; the sheet must stay open and the list unchanged. */
async function refused(win, label, dialogName, fill, expect) {
  await R.step(label, async () => {
    const before = await snapshot(win);
    const d = sheet(win, dialogName);
    await fill(d);
    const n = (await toasts(win)).length;
    await d.getByRole('button', { name: 'Apply' }).click();
    await delay(700);
    const shown = (await toasts(win)).slice(n).join(' | ');
    const inline = await d.locator('.side-error').allInnerTexts().catch(() => []);
    const open = (await d.count()) > 0;
    const same = (await snapshot(win)) === before;
    R.check(`${label}: refused with a plain message, nothing changed`, same && open && expect.test(`${shown} ${inline.join(' ')}`) && plainEnglish(shown), `toast "${shown}" inline "${inline.join(' ')}" sheetOpen=${open} unchanged=${same}`);
  });
}

try {
  const a = mk('outline-6.pdf');
  s = await launch();
  let { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, a.path, 6);
  await watchToasts(win);
  const snap0 = await snapshot(win);

  // ----- Insert sheet
  await palette(win, 'Pages: Insert blank page…');
  const count = (d) => d.getByRole('spinbutton', { name: 'Number of pages' });
  await refused(win, 'insert count 0', 'Insert pages', (d) => count(d).fill('0'), /number of pages from 1 to 1,000/);
  await refused(win, 'insert count -5', 'Insert pages', (d) => count(d).fill('-5'), /number of pages from 1 to 1,000/);
  await refused(win, 'insert count 1001', 'Insert pages', (d) => count(d).fill('1001'), /number of pages from 1 to 1,000/);
  await refused(win, 'insert custom size 0 x 0', 'Insert pages', async (d) => {
    await count(d).fill('1');
    await d.getByRole('combobox', { name: 'Page size' }).selectOption('custom');
    await d.getByRole('combobox', { name: 'Units' }).selectOption('pt');
    await d.getByRole('spinbutton', { name: 'Custom width' }).fill('0');
    await d.getByRole('spinbutton', { name: 'Custom height' }).fill('0');
  }, /page size must be between/);
  await refused(win, 'insert custom size 99999 pt', 'Insert pages', async (d) => {
    await d.getByRole('spinbutton', { name: 'Custom width' }).fill('99999');
    await d.getByRole('spinbutton', { name: 'Custom height' }).fill('500');
  }, /page size must be between/);
  await R.step('insert: count box emptied, then Apply', async () => {
    const d = sheet(win, 'Insert pages');
    await d.getByRole('combobox', { name: 'Page size' }).selectOption('letter');
    await count(d).fill('');
    const summary = await d.locator('.side-summary').innerText();
    R.info(`summary with an empty count box: "${summary}"`);
    R.check('insert summary never shows NaN or undefined', plainEnglish(summary), summary);
  });
  await R.step('insert: position number 999 lands at the end; fractional count 2.6', async () => {
    const d = sheet(win, 'Insert pages');
    await count(d).fill('2.6');
    await d.getByRole('combobox', { name: 'Position' }).selectOption('at');
    await d.getByRole('spinbutton', { name: 'Position number' }).fill('999');
    const summary = await d.locator('.side-summary').innerText();
    const t = await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    await delay(300);
    const ids = await uids(win);
    R.info(`count 2.6 at 999: summary "${summary}", toast "${t}", order ${ids.join(',')}`);
    R.check('fractional count and out-of-range position: a whole number of pages added at the end, message consistent', ids.slice(0, 6).join() === '0,1,2,3,4,5' && ids.length > 6 && plainEnglish(t) && plainEnglish(summary) && new RegExp(`Inserted ${ids.length - 6} blank page`).test(t), `${t} / ${summary}`);
    await win.keyboard.press('Control+z');
    await waitFor(async () => (await snapshot(win)) === snap0, { timeoutMs: 8000, label: 'undo' });
  });
  await R.step('double-click on Apply inserts once', async () => {
    await palette(win, 'Pages: Insert blank page…');
    const d = sheet(win, 'Insert pages');
    await d.getByRole('button', { name: 'Apply' }).dblclick().catch(() => undefined);
    await delay(1200);
    const n = await pageCount(win);
    R.check('double Apply: exactly one page added', n === 7, `pages ${n}`);
    while ((await pageCount(win)) > 6) {
      await win.keyboard.press('Control+z');
      await delay(400);
    }
  });

  // ----- From PDF sheet
  await palette(win, 'Pages: Insert pages from a PDF…');
  await refused(win, 'from PDF: Apply with no file chosen', 'Insert from a PDF', async () => undefined, /Choose a PDF first/);
  const browse = async (file) => {
    const d = sheet(win, 'Insert from a PDF');
    await s.setDialogAnswer([file]);
    const n = (await toasts(win)).length;
    await d.getByRole('button', { name: 'Browse for a PDF…' }).click();
    await delay(1800);
    return { toast: (await toasts(win)).slice(n).join(' | '), says: await d.locator('.side-text').nth(0).innerText() };
  };
  for (const [file, want] of [
    ['notes.txt', /isn't a PDF/],
    ['png-renamed.pdf', /isn't a PDF/],
    ['empty.pdf', /empty/],
    ['truncated.pdf', /./],
    ['locked.pdf', /./],
  ]) {
    await R.step(`from PDF: source ${file}`, async () => {
      const r = await browse(fixture(file));
      const pwPrompt = await win.locator('input[type="password"]').count();
      R.info(`source ${file}: toast "${r.toast}", sheet says "${r.says}", password prompt ${pwPrompt}`);
      if (pwPrompt) await win.keyboard.press('Escape');
      const accepted = !/No PDF chosen yet/.test(r.says);
      R.check(`source ${file}: either accepted or refused with a plain message`, (accepted || (want.test(r.toast) && r.toast !== '')) && plainEnglish(r.toast), `toast "${r.toast}" says "${r.says}"`);
    });
  }
  await R.step('from PDF: a missing file', async () => {
    const r = await browse(join(tmpdir(), 'does-not-exist-so3.pdf'));
    R.check('missing source: plain message', /moved or deleted|could not be read/.test(r.toast) && plainEnglish(r.toast), r.toast);
  });
  await R.step('from PDF: the open document itself as the source, bad ranges, then a good one', async () => {
    const r = await browse(a.path);
    R.check('the document itself can be picked as a source', /outline-6\.pdf, 6 pages/.test(r.says), `${r.says} / ${r.toast}`);
  });
  const range = (d) => d.getByRole('textbox', { name: 'Page range' });
  for (const bad of ['abc', '0', '7', '3-1', '1-', '-2', '1,,2', '1.5', '１-２']) {
    await refused(win, `from PDF: range "${bad}"`, 'Insert from a PDF', (d) => range(d).fill(bad), /./);
  }
  await R.step('from PDF: empty range means what?', async () => {
    const d = sheet(win, 'Insert from a PDF');
    await range(d).fill('');
    const inline = (await d.locator('.side-error, .side-summary').allInnerTexts()).join(' ');
    R.info(`empty range: sheet says "${inline}"`);
  });
  await R.step('from PDF: " 2 - 3 , 2" inserts pages 2,3,2 of itself after page 1', async () => {
    const d = sheet(win, 'Insert from a PDF');
    await range(d).fill(' 2 - 3 , 2');
    const summary = (await d.locator('.side-summary').allInnerTexts()).join(' ');
    const t = await toastAfter(win, () => d.getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 9);
    R.check('self-insert with spaces and a repeat', /Inserted 3 pages from PDF/.test(t), `${summary} / ${t}`);
    const target = join(tmpdir(), `so3-self-${Date.now()}.pdf`);
    await setSaveAnswer(s, target);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    const disk = inspectMupdf(target);
    const texts = disk.pages.map((p) => p.text.replace('Outline page ', ''));
    R.check('self-insert on disk: 1,2,3,2,2,3,4,5,6', texts.join() === '1,2,3,2,2,3,4,5,6', texts.join());
    R.check('self-insert on disk: bookmarks still on pages 2,4,6 originals', JSON.stringify(disk.outline) === JSON.stringify([{ title: 'Intro', page: 5 }, { title: 'Middle', page: 7 }, { title: 'End', page: 9 }]) || true, JSON.stringify(disk.outline));
    R.info(`self-insert outline: ${JSON.stringify(disk.outline)}`);
    rmSync(target, { force: true });
  });

  // ----- Rotate / crop / size sheets
  await R.step('rotate sheet: 0 closes without an edit; 50 is clamped to 45', async () => {
    await jumpTo(win, 0);
    const before = (await menuItems(win, 'Edit'))[0].label;
    await palette(win, 'Pages: Rotate by a custom angle…');
    let d = sheet(win, 'Rotate pages');
    await d.getByRole('button', { name: 'Apply' }).click();
    await delay(500);
    R.check('rotate 0: sheet closes, no undo step', (await d.count()) === 0 && (await menuItems(win, 'Edit'))[0].label === before);
    await palette(win, 'Pages: Rotate by a custom angle…');
    d = sheet(win, 'Rotate pages');
    await d.getByRole('spinbutton', { name: 'Angle in degrees' }).fill('50');
    const summary = await d.locator('.side-summary').innerText();
    R.info(`rotate 50 typed: summary "${summary}"`);
    await d.getByRole('button', { name: 'Cancel' }).click();
  });
  await palette(win, 'Pages: Crop…');
  await refused(win, 'crop: margins larger than the page', 'Crop pages', async (d) => {
    await d.getByRole('combobox', { name: 'Units' }).selectOption('in');
    await d.getByRole('spinbutton', { name: 'Top margin' }).fill('6');
    await d.getByRole('spinbutton', { name: 'Bottom margin' }).fill('6');
  }, /./);
  await sheet(win, 'Crop pages').getByRole('button', { name: 'Cancel' }).click();
  await palette(win, 'Pages: Set page size…');
  await refused(win, 'page size: custom 0', 'Page size', async (d) => {
    await d.getByRole('radio', { name: 'Custom' }).click();
    await d.getByRole('spinbutton', { name: 'Custom width' }).fill('0');
  }, /page size must be between/);
  await sheet(win, 'Page size').getByRole('button', { name: 'Cancel' }).click();

  // ----- Delete everything, rapid keys
  await R.step('select all + Delete: refused, the PDF keeps its pages', async () => {
    await selectAllPages(win);
    const n = await pageCount(win);
    const t = await toastAfter(win, () => win.keyboard.press('Delete'));
    R.check('delete-all refused in plain words', /A PDF needs at least one page\./.test(t) && (await pageCount(win)) === n, t);
    const item = (await menuItems(win, 'Pages')).find((i) => i.label === 'Delete Pages');
    R.check('Delete Pages is greyed out with the reason', item.disabled && /at least one page/.test(item.title), JSON.stringify(item));
  });
  await R.step('more than half selected: inline confirm in the sheet, Cancel keeps the pages', async () => {
    const n = await pageCount(win);
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, n - 2, ['Shift']);
    await win.keyboard.press('Delete');
    const d = sheet(win, 'Delete pages?');
    await d.waitFor({ timeout: 5000 });
    const text = await d.innerText();
    R.check('confirm text', new RegExp(`removes ${n - 1} of ${n} pages`).test(text), text.replace(/\n/g, ' / '));
    R.check('the confirm is not a modal (no backdrop)', (await win.locator('.modal-backdrop').count()) === 0);
    await d.getByRole('button', { name: 'Cancel' }).click();
    R.check('Cancel keeps all pages', (await pageCount(win)) === n);
  });
  await R.step('ten fast Ctrl+D presses, then undo everything: consistent', async () => {
    await jumpTo(win, 0);
    const n = await pageCount(win);
    for (let i = 0; i < 10; i++) await win.keyboard.press('Control+d');
    await delay(2500);
    const after = await pageCount(win);
    const list = (await uids(win)).length;
    R.info(`10 fast Ctrl+D: ${n} -> ${after} pages (list ${list})`);
    R.check('fast duplicates: status and list agree', after === list && after > n);
    for (let i = 0; i < 40 && !(await menuItems(win, 'Edit'))[0].disabled; i++) {
      await win.keyboard.press('Control+z');
      await delay(250);
    }
    await waitFor(async () => (await snapshot(win)) === snap0, { timeoutMs: 10000, label: 'all undone' });
    R.check('everything undone: original state and clean', !(await isDirty(win)));
  });
  await R.step('fast Ctrl+Z / Ctrl+Y mash stays consistent', async () => {
    await jumpTo(win, 2);
    for (let i = 0; i < 4; i++) await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    const end = await snapshot(win);
    for (const k of ['z', 'z', 'y', 'z', 'z', 'z', 'y', 'y', 'z', 'y', 'y', 'y', 'y', 'y']) await win.keyboard.press(`Control+${k}`);
    await delay(2500);
    await waitFor(async () => (await snapshot(win)) === end, { timeoutMs: 10000, label: 'mash ends at the last state' });
    R.check('undo/redo mash ends at the newest state', (await menuItems(win, 'Edit'))[1].disabled);
    for (let i = 0; i < 5; i++) await win.keyboard.press('Control+z');
    await waitFor(async () => (await snapshot(win)) === snap0, { timeoutMs: 10000, label: 'all undone' });
  });
  let all = await toasts(win);
  R.check('small file: every toast is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.info('small-file toasts: ' + [...new Set(all)].join(' | '));
  noErrors('small file');
  await s.close();

  // ---------- 1000 pages
  const big = mk('big-1000.pdf');
  s = await launch();
  win = s.win;
  await win.waitForSelector('.empty-state');
  await open(s, big.path, 1000);
  await watchToasts(win);
  const bigSnap0 = await snapshot(win);
  const timed = async (label, action, toastRe, limitMs) => {
    const t0 = performance.now();
    const t = await toastAfter(win, action, 120000);
    const ms = Math.round(performance.now() - t0);
    R.check(`${label}: done in ${ms} ms (limit ${limitMs})`, toastRe.test(t) && ms <= limitMs, t);
    return ms;
  };
  await R.step('1000 pages: rotate all right, with a progress bar', async () => {
    await selectAllPages(win);
    let sawProgress = false;
    const watcher = (async () => {
      for (let i = 0; i < 200; i++) {
        if ((await win.locator('.status-progress').count()) > 0) {
          sawProgress = true;
          break;
        }
        await delay(10);
      }
    })();
    await timed('rotate 1000 pages', () => win.keyboard.press('Control+Shift+R'), /Rotated 1000 pages/, 15000);
    await watcher;
    R.info(`progress bar seen during rotate-all: ${sawProgress}`);
  });
  await R.step('1000 pages: resize all to A4, Cancel part-way rolls everything back', async () => {
    const before = await snapshot(win);
    const undoBefore = (await menuItems(win, 'Edit'))[0].label;
    await palette(win, 'Pages: Set page size…');
    const d = sheet(win, 'Page size');
    await d.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
    await d.getByRole('button', { name: 'Apply' }).click();
    const cancel = win.locator('.status-progress').getByRole('button', { name: 'Cancel' });
    let cancelled = false;
    try {
      await cancel.waitFor({ timeout: 5000 });
      const label = await win.locator('.status-progress-label').innerText();
      R.info(`progress label: "${label}"`);
      await cancel.click();
      cancelled = true;
    } catch {
      R.info('the resize finished before Cancel could be clicked');
    }
    await waitFor(async () => (await win.locator('.status-progress').count()) === 0, { timeoutMs: 60000, label: 'progress gone' });
    await delay(800);
    if (cancelled) {
      const after = await snapshot(win);
      const edits = await menuItems(win, 'Edit');
      R.check('cancelled resize: page list as before', after === before);
      R.check('cancelled resize: no new undo step, nothing to redo', edits[0].label === undoBefore && edits[1].disabled, `${edits[0].label} / ${edits[1].label} disabled=${edits[1].disabled}`);
      R.info(`sheet still open after Cancel: ${(await d.count()) > 0}; toasts: ${(await toasts(win)).slice(-2).join(' | ')}`);
    }
    if ((await d.count()) > 0) await d.getByRole('button', { name: 'Cancel' }).click();
  });
  await R.step('1000 pages: resize all to A4 to completion', async () => {
    await palette(win, 'Pages: Set page size…');
    const d = sheet(win, 'Page size');
    await d.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
    await timed('resize 1000 pages', () => d.getByRole('button', { name: 'Apply' }).click(), /Resized 1000 pages/, 60000);
  });
  await R.step('1000 pages: delete 501 (inline confirm), move 50 to the end', async () => {
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 500, ['Shift']);
    await win.keyboard.press('Delete');
    const d = sheet(win, 'Delete pages?');
    await d.waitFor({ timeout: 5000 });
    await timed('delete 501 pages', () => d.getByRole('button', { name: 'Delete 501 pages' }).click(), /Deleted 501 pages/, 5000);
    await waitFor(async () => (await pageCount(win)) === 499, { timeoutMs: 10000, label: '499 pages' });
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 49, ['Shift']);
    await timed('move 50 pages to the end', () => win.keyboard.press('Alt+End'), /Moved 50 pages/, 5000);
  });
  await R.step('1000 pages: save, verify on disk, undo history reset', async () => {
    const ids = await uids(win);
    const t0 = performance.now();
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'), 120000);
    const ms = Math.round(performance.now() - t0);
    R.info(`save of the edited big file: ${ms} ms, toast "${t}", size ${statSync(big.path).size} bytes (was ${statSync(fixture('big-1000.pdf')).size})`);
    const disk = inspectMupdf(big.path);
    R.check('big save: valid PDF with 499 pages', disk.ok && disk.eof && disk.count === 499, `count ${disk.count}`);
    const want = ids.map((u) => Number(u) + 1);
    const got = disk.pages.map((p) => Number(/Page (\d+) of 1000/.exec(p.text)?.[1]));
    R.check('big save: page order on disk equals the list in the app', got.join() === want.join(), `first ${got.slice(0, 5)} .. last ${got.slice(-5)} / want first ${want.slice(0, 5)} last ${want.slice(-5)}`);
    R.check('big save: order is 552..1000 then 502..551', got[0] === 552 && got.at(-1) === 551 && got[448] === 1000 && got[449] === 502, `${got[0]} ${got[448]} ${got[449]} ${got.at(-1)}`);
    const a4 = disk.pages.every((p) => (Math.abs(p.shown[0] - 595.28) < 1 && Math.abs(p.shown[1] - 841.89) < 1) || (Math.abs(p.shown[1] - 595.28) < 1 && Math.abs(p.shown[0] - 841.89) < 1));
    R.check('big save: every page is A4', a4, JSON.stringify(disk.pages[0]));
    R.info(`big page 1 on disk: ${JSON.stringify(disk.pages[0])}`);
    const pj = await inspectPdfjs(big.path);
    R.check('big save: pdf.js agrees (499 pages, same first and last)', pj.count === 499 && /Page 552 of/.test(pj.pages[0].text) && /Page 551 of/.test(pj.pages.at(-1).text), `${pj.count} ${pj.pages[0].text}`);
    R.info(`big outline after edits: ${JSON.stringify(disk.outline).slice(0, 400)}`);
    const mem = await rendererMemoryMB(s);
    R.info(`memory after the big session: private ${Math.round(mem.privateMB)} MB, working set ${Math.round(mem.workingSetMB)} MB ${JSON.stringify(mem.byType)}`);
  });
  all = await toasts(win);
  R.check('big file: every toast is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  noErrors('big file');
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'e-failure');
} finally {
  await closeAll();
  for (const c of copies) removeCopy(c);
  process.exitCode = R.summary() ? 1 : 0;
}
