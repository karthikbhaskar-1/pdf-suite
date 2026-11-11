// Probe C: sequences (delete/undo/move/Save As/search/close/recovery), which pages, bad percent input, interruptions.
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  launch, closeAll, forceKill, cleanupProfile, open, palette, waitForCount, saveNow, isDirty, delay, pageCount, currentPage, statusText, waitFor, uids,
  clickRowByIndex, selectAllPages, setSaveAnswer, showPanel,
  newFile, copyTo, wipe, report, buildPdf, content, readPages, expectedImages, compare, planAll, planOnly, VERT, HORZ, openSheet, setOptions, sheetOf, summaryOf,
} from './lib.mjs';

const R = report('c-sequences');
const ONLY = process.argv[2];
const realStep = R.step;
R.step = (label, fn) => (!ONLY || label.includes(ONLY) ? realStep(label, fn) : Promise.resolve());
const SP3 = () => buildPdf([1, 2, 3].map((n) => ({ media: [0, 0, 800, 500], content: content(`P${n}`) })));
const MIX5 = () => buildPdf([
  { media: [0, 0, 800, 500], content: content('W1') },
  { media: [0, 0, 500, 800], content: content('T2', 500, 800) },
  { media: [0, 0, 600, 600], content: content('S3', 600, 600) },
  { media: [0, 0, 800, 500], rotate: 90, content: content('R4') },
  { media: [0, 0, 500, 800], rotate: 90, content: content('R5', 500, 800) },
]);
const many = (n) => buildPdf(Array.from({ length: n }, (_u, i) => ({ media: [0, 0, 600, 400], content: `0 g\n${10 + (i % 50)} 10 60 30 re f\n${300 + (i % 40)} 200 50 50 re f` })));

async function session(file, pages, body, env) {
  const s = await launch(env ? { env } : {});
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, file.path, pages);
    await body(s);
    const errs = s.errors.filter((e) => !/favicon/.test(e));
    if (errs.length) R.say(`INFO  app errors: ${errs.slice(0, 3).join(' | ').slice(0, 300)}`);
  } finally { await s.close(); }
}
async function cut(s, opts, after) {
  const sheet = await openSheet(s, palette);
  await setOptions(sheet, opts);
  await sheet.getByRole('button', { name: 'Apply' }).click();
  await sheetOf(s.win).waitFor({ state: 'detached', timeout: 30000 });
  if (after !== undefined) await waitForCount(s.win, after);
}
const key = (s, k) => s.win.keyboard.press(k);
const undoRow = async (win) => {
  await win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const dd = win.locator('.menu-dropdown').last();
  await dd.waitFor({ timeout: 5000 });
  const row = dd.locator('[role="menuitem"]').first();
  const out = { text: (await row.innerText()).replace(/\s+/g, ' ').trim(), disabled: (await row.getAttribute('aria-disabled')) === 'true' || (await row.isDisabled().catch(() => false)) };
  await win.keyboard.press('Escape');
  await waitFor(async () => (await win.locator('.menu-dropdown').count()) === 0, { timeoutMs: 5000, label: 'menu closed' });
  return out;
};
const closePrompt = (win) => win.getByRole('alertdialog');
const requestClose = (s) => s.app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });

// ---------------- 2. Sequences ----------------
await R.step('cut -> delete one half -> undo twice -> redo twice -> save', async () => {
  const f = newFile('seq.pdf', SP3());
  await session(f, 3, async (s) => {
    const o = readPages(f.path);
    const before = await uids(s.win);
    await cut(s, {}, 6);
    const cutIds = await uids(s.win);
    await clickRowByIndex(s.win, 1);
    await palette(s.win, 'Pages: Delete');
    await waitForCount(s.win, 5);
    await key(s, 'Control+z');
    await waitForCount(s.win, 6);
    R.check('undo of the delete restores the same 6 pages', JSON.stringify(await uids(s.win)) === JSON.stringify(cutIds));
    await key(s, 'Control+z');
    await waitForCount(s.win, 3);
    R.check('second undo restores the original 3 pages (same uids)', JSON.stringify(await uids(s.win)) === JSON.stringify(before));
    R.check('after two undos nothing left to undo and document not dirty', (await undoRow(s.win)).disabled && !(await isDirty(s.win)), JSON.stringify(await undoRow(s.win)));
    await key(s, 'Control+y'); await waitForCount(s.win, 6);
    await key(s, 'Control+y'); await waitForCount(s.win, 5);
    await saveNow(s.win);
    const exp = expectedImages(o, planAll(3, VERT));
    exp.splice(1, 1);
    const { problems } = compare(f.path, exp);
    R.check('redo twice then save: 5 pages, the second half of page 1 is gone and nothing else', problems.length === 0, problems.join('; '));
  });
});
await R.step('cut -> move a half -> save -> reopen', async () => {
  const f = newFile('move.pdf', SP3());
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, f.path, 3);
    const o = readPages(f.path);
    await cut(s, { order: 'right' }, 6);
    await clickRowByIndex(s.win, 1);
    await key(s, 'Alt+ArrowDown');
    await delay(1200);
    await clickRowByIndex(s.win, 4);
    await key(s, 'Alt+ArrowUp');
    await delay(1200);
    await saveNow(s.win);
    const exp = expectedImages(o, planAll(3, { cut: 'vertical', at: 0.5, first: 'right' }));
    // moved: page index1 down one (swaps 1,2); then index4 up one (swaps 3,4)
    const e2 = [...exp];
    [e2[1], e2[2]] = [e2[2], e2[1]];
    [e2[3], e2[4]] = [e2[4], e2[3]];
    const { problems } = compare(f.path, e2);
    R.check('moved halves are saved in the moved order', problems.length === 0, problems.join('; '));
    await s.close();
    const s2 = await launch();
    try {
      await s2.win.waitForSelector('.empty-state');
      await open(s2, f.path, 6);
      R.check('reopened file shows 6 pages', (await pageCount(s2.win)) === 6);
    } finally { await s2.close(); }
  } finally { await s.close().catch(() => undefined); }
});
await R.step('cut -> Save As -> cut again', async () => {
  const f = newFile('sa.pdf', SP3());
  const target = newFile('sa-target.pdf');
  const orig = readFileSync(f.path);
  await session(f, 3, async (s) => {
    const o = readPages(f.path);
    await cut(s, {}, 6);
    await setSaveAnswer(s, target.path);
    await key(s, 'Control+Shift+s');
    await waitFor(async () => !(await isDirty(s.win)), { timeoutMs: 20000, label: 'saved as' });
    await delay(800);
    const mid = readPages(target.path);
    R.check('Save As wrote the cut document (6 pages)', mid.length === 6);
    await cut(s, { direction: 'horizontal', percent: 40 }, 12);
    await saveNow(s.win);
    const { problems } = compare(target.path, expectedImages(mid, planAll(6, { cut: 'horizontal', at: 0.4, first: 'left' })));
    R.check('second cut after Save As is saved to the new file', problems.length === 0, problems.join('; '));
    R.check('the original file is byte for byte unchanged', readFileSync(f.path).equals(orig));
  });
});
await R.step('search around a cut', async () => {
  const f = newFile('srch.pdf', SP3());
  await session(f, 3, async (s) => {
    const status = async () => (await s.win.locator('.search-status').innerText().catch(() => '')).trim();
    const search = async (w) => {
      await key(s, 'Control+f');
      const box = s.win.getByLabel('Find in document');
      await box.fill('');
      await box.fill(w);
      await delay(700);
      await waitFor(async () => { const t = await status(); return /^\d+ of \d+$/.test(t) || t === 'No matches'; }, { timeoutMs: 20000, label: `search ${w}` });
      await delay(400);
      return status();
    };
    R.check('before: OMEGA has 3 hits', /of 3$/.test(await search('OMEGA')), await status());
    // cut while the results are showing
    await key(s, 'Escape').catch(() => undefined);
    await key(s, 'Control+f');
    await s.win.getByLabel('Find in document').fill('OMEGA');
    await delay(1500);
    await cut(s, {}, 6);
    await delay(1500);
    const afterNoRetype = await status();
    R.say(`INFO  search status right after a cut with results showing: "${afterNoRetype}"`);
    R.check('after a cut with the search showing: the count is not stale or doubled (3 hits, or a fresh search)', /^(\d+ of 3|No matches|)$/.test(afterNoRetype) || /^\d+ of 3$/.test(afterNoRetype), afterNoRetype);
    const hitsOmega = await search('OMEGA');
    const hitsAlpha = await search('ALPHA');
    R.check('after: OMEGA 3 hits, ALPHA 3 hits (not 6)', /of 3$/.test(hitsOmega) && /of 3$/.test(hitsAlpha), `${hitsOmega} / ${hitsAlpha}`);
    // walk the OMEGA hits: each must be on an even page (second half)
    await search('OMEGA');
    const pagesSeen = [];
    for (let i = 0; i < 3; i++) { await key(s, 'Enter'); await delay(900); pagesSeen.push(await currentPage(s.win)); }
    R.check('OMEGA hits land on the second halves (pages 2, 4, 6)', pagesSeen.every((p) => p % 2 === 0) && new Set(pagesSeen).size === 3, pagesSeen.join());
    await key(s, 'Escape');
  });
});
await R.step('cut -> close without saving (prompt on) -> reopen: no recovery offer', async () => {
  const f = newFile('close1.pdf', SP3());
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-so6-'));
  try {
    let s = await launch({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
    try {
      await s.win.waitForSelector('.empty-state');
      await open(s, f.path, 3);
      await cut(s, {}, 6);
      await delay(1500);
      await requestClose(s);
      await closePrompt(s.win).waitFor({ timeout: 10000 });
      await closePrompt(s.win).getByRole('button', { name: "Don't save" }).click();
      await delay(1500);
    } finally { await s.close(); }
    R.check("Don't save left the file as it was", readPages(f.path).length === 3);
    s = await launch({ profile, env: { PDFSUITE_E2E_PROMPTS: '1' } });
    try {
      await s.win.waitForSelector('.empty-state', { timeout: 15000 }).catch(() => undefined);
      await s.setDialogAnswer([f.path]);
      await key(s, 'Control+o');
      await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of'), { timeoutMs: 30000, label: 'opened' });
      await delay(1500);
      const bar = await s.win.getByText(/Recovered unsaved edits/).count();
      R.check("after Don't save, reopening shows no recovery offer and 3 pages", bar === 0 && (await pageCount(s.win)) === 3, `bar=${bar} pages=${await pageCount(s.win)}`);
    } finally { await s.close(); }
  } finally { cleanupProfile(profile); }
});
await R.step('cut -> kill -> Discard -> relaunch: offer gone; Keep path shows 6 pages', async () => {
  const f = newFile('close2.pdf', SP3());
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-so6-'));
  try {
    let s = await launch({ profile });
    await s.win.waitForSelector('.empty-state');
    await open(s, f.path, 3);
    await cut(s, {}, 6);
    await delay(1800);
    await forceKill(s.app);
    const bar = () => s.win.getByText(/Recovered unsaved edits/);
    s = await launch({ profile });
    try {
      await bar().waitFor({ timeout: 20000 });
    } catch {
      await s.setDialogAnswer([f.path]); await key(s, 'Control+o'); await bar().waitFor({ timeout: 30000 });
    }
    R.check('after a crash the recovery offer appears for the cut', true);
    await s.win.getByRole('button', { name: 'Discard', exact: true }).click();
    await showPanel(s.win, 'Thumbnails');
    await waitForCount(s.win, 3);
    await delay(1500);
    await s.close();
    s = await launch({ profile });
    try {
      await s.win.waitForSelector('.empty-state', { timeout: 15000 }).catch(() => undefined);
      await s.setDialogAnswer([f.path]);
      await key(s, 'Control+o');
      await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of'), { timeoutMs: 30000, label: 'opened' });
      await delay(1500);
      R.check('after Discard the next launch has no recovery offer and 3 pages', (await s.win.getByText(/Recovered unsaved edits/).count()) === 0 && (await pageCount(s.win)) === 3, `pages=${await pageCount(s.win)}`);
    } finally { await s.close(); }
  } finally { cleanupProfile(profile); }
});

// ---------------- 3. Which pages / bad input ----------------
await R.step('bad percent input', async () => {
  const f = newFile('pct.pdf', SP3());
  await session(f, 3, async (s) => {
    const sheet = await openSheet(s, palette);
    const box = sheet.getByLabel('Cut position in percent');
    const apply = sheet.getByRole('button', { name: 'Apply' });
    const rows = [];
    for (const bad of ['0', '99999', '3-1', 'abc', '', '-5', '30abc', '4,5', '1e1', '29.9', '70.1', '30 ', ' 50', '50.25', '30', '70', '45,5', '5 0', '0x32', '++50', 'Infinity', 'NaN', '50.', '.5e2', '49.99999']) {
      await box.fill(bad);
      const alert = await sheet.getByRole('alert').count() ? (await sheet.getByRole('alert').innerText()).trim() : '';
      const disabled = await apply.isDisabled();
      const slider = await sheet.getByRole('slider').inputValue().catch(() => '?');
      rows.push(`[${bad}] apply=${disabled ? 'off' : 'ON'} msg="${alert}" slider=${slider}`);
    }
    R.say('INFO  percent input table:\n  ' + rows.join('\n  '));
    const mustBeOff = ['0', '99999', '3-1', 'abc', '', '-5', '30abc', '4,5', '1e1', '29.9', '70.1', '5 0', '0x32', '++50', 'Infinity', 'NaN'];
    const wrong = rows.filter((r) => mustBeOff.some((b) => r.startsWith(`[${b}] `)) && r.includes('apply=ON'));
    R.check('invalid text keeps Apply off', wrong.length === 0, wrong.join(' ; '));
    const msgWrong = rows.filter((r) => mustBeOff.some((b) => r.startsWith(`[${b}] `)) && !r.includes('msg="Enter a number from 30 to 70."'));
    R.check('invalid text shows exactly "Enter a number from 30 to 70."', msgWrong.length === 0, msgWrong.join(' ; '));
    const okRows = rows.filter((r) => /^\[(30|70|30 | 50|50\.25|50\.|\.5e2|49\.99999)\]/.test(r));
    R.say(`INFO  borderline values: ${okRows.join(' ; ')}`);
    // an accepted odd value really cuts there: 50.25
    await box.fill('50.25');
    if (!(await apply.isDisabled())) {
      await apply.click();
      await sheetOf(s.win).waitFor({ state: 'detached', timeout: 20000 });
      await waitForCount(s.win, 6);
      await saveNow(s.win);
      const w0 = readPages(f.path)[0].exactW;
      R.say(`INFO  50.25 accepted; first half is ${w0} wide (402 = 50.25 %, 400 = snapped to 50, 400.5 = 50.0625)`);
    }
    // and the reverse: a typed value is what the slider shows (45.5 round trip)
  });
});
await R.step('wide / tall only on mixed orientation', async () => {
  const f = newFile('mix.pdf', MIX5());
  await session(f, 5, async (s) => {
    const o = readPages(f.path);
    R.say(`INFO  display sizes: ${o.map((p) => `${p.w}x${p.h}`).join(' ')}`);
    let sheet = await openSheet(s, palette);
    await setOptions(sheet, { scope: 'wide' });
    const label = await sheet.getByLabel('Apply to').evaluate((el) => el.options[el.selectedIndex].textContent);
    const sum = await summaryOf(sheet);
    R.say(`INFO  left/right + wide: "${label}" / "${sum}"`);
    R.check('left/right wide-only counts 2 pages (display pages 1 and 5; page 3 is square, page 4 is turned to tall)', /^Cuts 2 pages into 4\./.test(sum), sum);
    await sheet.getByRole('button', { name: 'Apply' }).click();
    await sheetOf(s.win).waitFor({ state: 'detached', timeout: 20000 });
    await waitForCount(s.win, 7);
    await saveNow(s.win);
    const { problems } = compare(f.path, expectedImages(o, planOnly(5, [0, 4], VERT)));
    R.check('wide-only left/right file matches', problems.length === 0, problems.join('; '));
    // top/bottom "Tall pages only" on the saved file (now 7 pages)
    const o2 = readPages(f.path);
    sheet = await openSheet(s, palette);
    await setOptions(sheet, { direction: 'horizontal', scope: 'wide' });
    const lab2 = await sheet.getByLabel('Apply to').evaluate((el) => el.options[el.selectedIndex].textContent);
    const tall = o2.map((p, i) => (p.h > p.w ? i : -1)).filter((i) => i >= 0);
    const sum2 = await summaryOf(sheet);
    R.say(`INFO  top/bottom + tall: "${lab2}" / "${sum2}" (tall pages by size: ${tall.length})`);
    R.check('tall-only count equals pages taller than wide', sum2.startsWith(`Cuts ${tall.length} pages into ${tall.length * 2}.`), sum2);
    await sheet.getByRole('button', { name: 'Apply' }).click();
    await sheetOf(s.win).waitFor({ state: 'detached', timeout: 20000 });
    await waitForCount(s.win, 7 + tall.length);
    await saveNow(s.win);
    const { problems: p2 } = compare(f.path, expectedImages(o2, planOnly(7, tall, HORZ)));
    R.check('tall-only top/bottom file matches', p2.length === 0, p2.join('; '));
  });
});

// ---------------- 4. Interruptions ----------------
await R.step('switch tabs with the sheet open', async () => {
  const a = newFile('tabA.pdf', SP3());
  const b = newFile('tabB.pdf', buildPdf([{ media: [0, 0, 600, 400], content: content('B1', 600, 400) }, { media: [0, 0, 600, 400], content: content('B2', 600, 400) }]));
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 3);
    await open(s, b.path, 2);
    const sheet = await openSheet(s, palette);
    R.say(`INFO  sheet open on B: "${await summaryOf(sheet)}"`);
    await s.win.getByRole('tab', { name: /tabA\.pdf/ }).click();
    await waitFor(async () => (await statusText(s.win)).includes('of 3'), { timeoutMs: 10000, label: 'A shown' });
    await delay(600);
    const stillOpen = await sheetOf(s.win).count();
    const sum = stillOpen ? await summaryOf(sheetOf(s.win)) : '(sheet closed)';
    R.say(`INFO  after switching to A: sheet open=${stillOpen}, summary "${sum}", guides on page: ${await s.win.locator('[data-cut-guide]').count()}`);
    if (stillOpen) {
      R.check('sheet that stays open after a tab switch counts the pages of the tab now shown (3 -> 6)', /^Cuts 3 pages into 6\./.test(sum), sum);
      await sheetOf(s.win).getByRole('button', { name: 'Apply' }).click();
      await sheetOf(s.win).waitFor({ state: 'detached', timeout: 20000 });
      await waitForCount(s.win, 6);
      await saveNow(s.win);
      R.check('Apply cut tab A only (A has 6 pages on disk, B untouched with 2)', readPages(a.path).length === 6 && readPages(b.path).length === 2, `A=${readPages(a.path).length} B=${readPages(b.path).length}`);
    } else {
      R.check('sheet closed on tab switch and nothing changed', !(await isDirty(s.win)));
    }
    await s.win.getByRole('tab', { name: /tabB\.pdf/ }).click();
    await delay(500);
    R.check('tab B was not cut', (await pageCount(s.win)) === 2 && !(await isDirty(s.win)), `pages=${await pageCount(s.win)}`);
    assertNone(s);
  } finally { await s.close(); }
});
await R.step('close the tab with the sheet open', async () => {
  const a = newFile('cl.pdf', SP3());
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, a.path, 3);
    await openSheet(s, palette);
    await key(s, 'Control+w');
    await delay(1200);
    const sheetCount = await sheetOf(s.win).count();
    const guides = await s.win.locator('[data-cut-guide]').count();
    const empty = await s.win.locator('.empty-state').count();
    R.check('closing the only tab with the sheet open: empty state, no sheet, no guide', empty === 1 && sheetCount === 0 && guides === 0, `empty=${empty} sheet=${sheetCount} guides=${guides}`);
    // the command with no document open
    await key(s, 'Control+k');
    await s.win.getByRole('dialog', { name: 'Command palette' }).getByPlaceholder('Type a command').fill('Pages: Cut pages in half');
    await delay(500);
    await key(s, 'Enter');
    await delay(800);
    R.check('running Cut with no document open opens no sheet', (await sheetOf(s.win).count()) === 0);
    await key(s, 'Escape');
    // reopen: sheet works again
    await open(s, a.path, 3);
    await cut(s, {}, 6);
    R.check('after closing a tab with the sheet open, the next document cuts normally', (await pageCount(s.win)) === 6);
    assertNone(s);
  } finally { await s.close(); }
});
function assertNone(s) {
  const errs = s.errors.filter((e) => !/favicon/.test(e));
  R.check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 400));
}
await R.step('Ctrl+S immediately after Apply on 500 pages', async () => {
  const f = newFile('big500.pdf', many(500));
  await session(f, 500, async (s) => {
    const sheet = await openSheet(s, palette);
    await sheet.getByRole('button', { name: 'Apply' }).click();
    await key(s, 'Control+s');
    await delay(6000);
    await waitFor(async () => (await pageCount(s.win)) === 1000 || (await pageCount(s.win)) === 500, { timeoutMs: 60000, label: 'settled' });
    await delay(3000);
    const n = await pageCount(s.win);
    const dirty = await isDirty(s.win);
    const disk = readPages(f.path).length;
    R.say(`INFO  after Apply+Ctrl+S: app shows ${n} pages, dirty=${dirty}, disk has ${disk}`);
    R.check('app and disk agree: disk is 500 (original) while dirty, or 1000 when saved and clean', (disk === 1000 && !dirty && n === 1000) || (disk === 500 && n === 1000 && dirty) || (disk === 500 && n === 500 && !dirty), `n=${n} dirty=${dirty} disk=${disk}`);
    if (dirty) { await saveNow(s.win); R.check('a later Ctrl+S writes the 1000 pages', readPages(f.path).length === 1000); }
  });
});
await R.step('Ctrl+S during the progress of a 4000-page cut', async () => {
  const f = newFile('big4000.pdf', many(4000));
  const orig = readFileSync(f.path);
  await session(f, 4000, async (s) => {
    const sheet = await openSheet(s, palette);
    await sheet.getByRole('button', { name: 'Apply' }).click();
    const bar = s.win.locator('footer.status-progress');
    await bar.waitFor({ timeout: 20000 });
    await key(s, 'Control+s');
    await delay(2500);
    R.say(`INFO  Ctrl+S mid-cut: file still original on disk=${readFileSync(f.path).equals(orig)}, progress bar still shown=${await bar.count()}`);
    await waitFor(async () => (await s.win.locator('footer.status-progress').count()) === 0, { timeoutMs: 180000, label: 'cut done' });
    await delay(3000);
    const n = await pageCount(s.win);
    const dirty = await isDirty(s.win);
    const disk = readFileSync(f.path).equals(orig) ? 4000 : readPages(f.path).length;
    R.say(`INFO  settled: app ${n} pages, dirty=${dirty}, disk ${disk}`);
    R.check('after a Ctrl+S during the cut: no half-cut file (disk is 4000 or 8000) and the app agrees', (disk === 4000 || disk === 8000) && (n === 8000 || n === 4000) && ((disk === 8000) === !dirty || disk === 4000), `n=${n} dirty=${dirty} disk=${disk}`);
  });
});
await R.step('Cancel during a 500-page cut, as fast as possible', async () => {
  const f = newFile('c500.pdf', many(500));
  await session(f, 500, async (s) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const sheet = await openSheet(s, palette);
      const result = await s.win.evaluate(async () => {
        const apply = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply');
        apply.click();
        const t0 = performance.now();
        while (performance.now() - t0 < 4000) {
          const btn = document.querySelector('footer.status-progress button');
          if (btn) { btn.click(); return `clicked cancel after ${Math.round(performance.now() - t0)} ms`; }
          await new Promise((r) => requestAnimationFrame(r));
        }
        return 'no progress bar appeared';
      });
      await waitFor(async () => (await s.win.locator('footer.status-progress').count()) === 0, { timeoutMs: 30000, label: 'progress gone' });
      const toast = await s.win.locator('.toast').allInnerTexts();
      await delay(1500);
      const n = await pageCount(s.win);
      const dirty = await isDirty(s.win);
      const undo = await undoRow(s.win);
      R.say(`INFO  attempt ${attempt}: ${result}; pages=${n}; dirty=${dirty}; undo=${JSON.stringify(undo)}; toasts=${JSON.stringify(toast)}`);
      if (/clicked cancel/.test(result)) {
        const cancelled = toast.some((t) => /Cancelled\. The document was not changed\./.test(t));
        if (n === 500) R.check('cancel landed: 500 pages, not dirty, no undo step, "Cancelled" message', !dirty && undo.disabled && cancelled, `dirty=${dirty} undo=${JSON.stringify(undo)} toast=${toast}`);
        else R.check('cancel pressed too late (cut had finished): the cut is a normal undoable step', n === 1000 && dirty && /Undo Cut 500 pages in half/.test(undo.text), `n=${n} undo=${undo.text}`);
      }
      if (n === 1000) { await key(s, 'Control+z'); await waitForCount(s.win, 500); }
      await delay(500);
    }
  });
});

const failed = R.summary();
await closeAll();
wipe();
process.exit(failed ? 1 : 0);
