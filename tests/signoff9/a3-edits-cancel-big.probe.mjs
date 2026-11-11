// Sign-Off 9, A3: Split with unsaved edits (also made while the sheet is open), Cancel early and late, a 1,000-page file while scrolling.
import { join } from 'node:path';
import { copyFileSync } from 'node:fs';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, open, palette, openSheet, ready, chooseFolder, waitNotice, anyNotice, splitButton, listing, sha, closeNotice, waitFor, delay, isDirty, statusText, fixture, noticeOf } from './lib9.mjs';

const R = report('a3-edits-cancel-big');

await R.step('A3a an edit made while the sheet is open', async () => {
  const dir = dirOf('src');
  const path = put(dir, 'Live.pdf', buildPdf({ pages: 6 }));
  const before = sha(path);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 6);
    const sheet = await openSheet(s);
    await ready(sheet);
    R.check('clean document: the sheet shows the settings', (await sheet.getByLabel('Pages in each file').count()) === 1);
    await sheet.getByLabel('Pages in each file').fill('2');
    // delete page 1 through the palette while the sheet is open
    await palette(s.win, 'Pages: Delete');
    await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'unsaved' });
    let saw = false;
    try { await sheet.getByText('Save your changes first? Split works from the saved file.').waitFor({ timeout: 8000 }); saw = true; } catch { saw = false; }
    R.check('the sheet flips to "Save your changes first?" when the document is edited while it is open', saw, (await sheet.innerText().catch(() => 'sheet gone')).slice(0, 200));
    R.check('the file on disk is unchanged', sha(path) === before);
    // Cancel: nothing happens to the file, and no files
    const out = dirOf('out');
    const cancel = sheet.getByRole('button', { name: 'Cancel' });
    if (await cancel.count()) await cancel.first().click();
    await delay(500);
    R.check('Cancel closes the sheet', (await sheet.count()) === 0);
    R.check('document still has its unsaved edit and the file is unchanged', (await isDirty(s.win)) && sha(path) === before);
    // reopen: asks again; save and continue
    const sheet2 = await openSheet(s);
    await sheet2.getByText('Save your changes first? Split works from the saved file.').waitFor({ timeout: 10000 });
    await sheet2.getByRole('button', { name: 'Save and continue' }).click();
    await ready(sheet2);
    R.check('the edit is saved now', sha(path) !== before);
    R.say(`INFO source line: ${(await sheet2.locator('[data-split-source]').innerText()).trim()}`);
    await sheet2.getByLabel('Pages in each file').fill('2');
    await chooseFolder(s, sheet2, out);
    await splitButton(sheet2).click();
    R.say(`INFO notice: ${await waitNotice(s, /Split Live\.pdf into/)}`);
    const parts = listing(out).map((n) => inspect(join(out, n)));
    R.check('parts hold the 5 remaining pages: 2,2,1 and page 1 is gone', JSON.stringify(parts.map((p) => p.pages)) === '[2,2,1]' && parts[0].text[0] === 'Page 2', parts.map((p) => p.text));
    await closeNotice(s);
  } finally { await s.close(); }
});

await R.step('A3b Cancel early (in the sheet): no files, no change', async () => {
  const dir = dirOf('src');
  const path = put(dir, 'Early.pdf', buildPdf({ pages: 6 }));
  const before = sha(path);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 6);
    const out = dirOf('out');
    let sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByLabel('Pages in each file').fill('2');
    await chooseFolder(s, sheet, out);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await delay(600);
    R.check('Cancel button closes the sheet, folder empty', (await sheet.count()) === 0 && listing(out).length === 0);
    sheet = await openSheet(s);
    await ready(sheet);
    await chooseFolder(s, sheet, out);
    await s.win.keyboard.press('Escape');
    await delay(600);
    R.check('Esc closes the sheet, folder empty', (await sheet.count()) === 0 && listing(out).length === 0);
    R.check('source unchanged and not dirty', sha(path) === before && !(await isDirty(s.win)));
    // Cancel right after Split (immediately)
    sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByLabel('Pages in each file').fill('1');
    await chooseFolder(s, sheet, out);
    await splitButton(sheet).click();
    const bar = s.win.locator('footer[data-job-status="split"]');
    let cancelled = false;
    try { await bar.getByRole('button', { name: 'Cancel' }).click({ timeout: 1500 }); cancelled = true; } catch { cancelled = false; }
    const text = await anyNotice(s, 30000);
    R.say(`INFO quick cancel clicked=${cancelled}, notice: ${text}`);
    await delay(500);
    R.check('quick cancel: either cancelled with no files or finished completely (never partial)', (cancelled && /Cancelled/.test(text) && listing(out).length === 0) || (/Split Early\.pdf into 6 files/.test(text) && listing(out).length === 6), { text, files: listing(out) });
    R.check('source unchanged', sha(path) === before);
  } finally { await s.close(); }
});

await R.step('A3c Cancel late on a 1,000-page file (1,000 files)', async () => {
  const dir = dirOf('src');
  const path = join(dir, 'big.pdf');
  copyFileSync(fixture('big-1000.pdf'), path);
  const before = sha(path);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 1000);
    for (let round = 1; round <= 2; round++) {
      const out = dirOf(`out${round}`);
      const sheet = await openSheet(s);
      await ready(sheet);
      await sheet.getByLabel('Pages in each file').fill('1');
      await chooseFolder(s, sheet, out);
      await splitButton(sheet).click();
      const bar = s.win.locator('footer[data-job-status="split"]');
      await bar.waitFor({ timeout: 20000 });
      // Watch the bar; cancel in the saving phase (round 1: first "saving file" seen; round 2: the last quarter, or checking).
      const seen = new Set();
      let target = null;
      const t0 = Date.now();
      for (;;) {
        const t = (await bar.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (t) seen.add(t.replace(/\d+/g, 'N'));
        const m = /saving file (\d+) of (\d+)/.exec(t);
        if (round === 1 && m) { target = t; break; }
        if (round === 2 && (/checking/.test(t) || (m && Number(m[1]) > 900))) { target = t; break; }
        if (!t || Date.now() - t0 > 120000) break;
        await delay(15);
      }
      R.say(`INFO round ${round}: phases seen ${JSON.stringify([...seen])}; cancelling at "${target}"`);
      if (target) await bar.getByRole('button', { name: 'Cancel' }).click({ timeout: 5000 }).catch(() => R.say('INFO cancel click failed (job ended)'));
      const text = await anyNotice(s, 120000);
      await delay(800);
      const files = listing(out);
      R.say(`INFO round ${round}: notice "${text}", files in folder ${files.length}, leftovers ${JSON.stringify(files.filter((f) => !/^big - part \d+\.pdf$/.test(f)).slice(0, 5))}`);
      R.check(`round ${round}: cancelled leaves nothing, or the job had already finished with all 1000 files`, (/Cancelled/.test(text) && files.length === 0) || (/Split big\.pdf into 1000 files/.test(text) && files.length === 1000), { text, files: files.length });
      await closeNotice(s);
    }
    R.check('source unchanged', sha(path) === before);
  } finally { await s.close(); }
});

await R.step('A3d 1,000 pages: scroll the viewer during the blank search and during a split', async () => {
  const dir = dirOf('src');
  const path = join(dir, 'big2.pdf');
  copyFileSync(fixture('big-1000.pdf'), path);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 1000);
    await s.win.evaluate(() => {
      window.__gaps = [];
      let last = performance.now();
      const tick = (t) => { window.__gaps.push(t - last); last = t; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const scrollSome = async (label, steps) => {
      await s.win.mouse.move(380, 450);
      await s.win.evaluate(() => { window.__gaps.length = 0; });
      const pages = [];
      for (let i = 0; i < steps; i++) {
        await s.win.mouse.wheel(0, 900);
        await delay(40);
        if (i % 10 === 0) pages.push(await statusText(s.win));
      }
      const gaps = await s.win.evaluate(() => window.__gaps.slice());
      const max = Math.max(...gaps);
      const p95 = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.95)];
      R.say(`INFO ${label}: scrolled ${steps} wheel steps, status samples ${JSON.stringify(pages.map((p) => p.slice(0, 18)))}, frame gaps max ${Math.round(max)} ms p95 ${Math.round(p95)} ms`);
      return { max, pages };
    };
    // blank search
    let sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Blank pages' }).click();
    const r1 = await scrollSome('during blank search', 25);
    const looking = await sheet.getByText(/Looking for blank pages/).count();
    R.say(`INFO still looking after scrolling: ${looking > 0}`);
    await sheet.getByText(/No blank pages were found|Found \d+ blank/).waitFor({ timeout: 120000 });
    R.say(`INFO search result: ${(await sheet.getByText(/No blank pages were found|Found \d+ blank/).first().innerText()).trim()}`);
    R.check('the page number followed the scrolling during the search', new Set(r1.pages).size > 2, r1.pages);
    // split by 100 pages with scrolling
    await sheet.getByRole('radio', { name: 'Page count' }).click();
    await sheet.getByLabel('Pages in each file').fill('100');
    const out = dirOf('out');
    await chooseFolder(s, sheet, out);
    await splitButton(sheet).click();
    const r2 = await scrollSome('during split', 40);
    const note = await waitNotice(s, /Split big2\.pdf into 10 files\./, 120000);
    R.say(`INFO notice: ${note}`);
    const names = listing(out);
    R.check('10 files, 100 pages each, in order', names.length === 10 && names.every((n) => inspect(join(out, n)).pages === 100), names);
    const last = inspect(join(out, names[9]));
    R.say(`INFO last part first page text: ${last.text[0]}, last: ${last.text[99]}`);
    R.say(`INFO scroll during split pages: ${JSON.stringify(r2.pages.map((p) => p.slice(0, 18)))}`);
    await closeNotice(s);
  } finally { await s.close(); }
});
await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
