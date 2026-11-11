// Sign-Off 11, B: Combine with clashing link targets and named destinations, Cancel at half of a large job (also onto an
// existing file), and "Add open files" with unsaved edits in an open tab. Auditor code only.
import { join } from 'node:path';
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import * as mu from 'mupdf';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, open, palette, openCombine, addFiles, rowNames, rowOf, rowsReady, combine, waitNotice, anyNotice, windowOf, sha, delay, waitFor, listing, closeNotice, isDirty, fixture, messagesOf } from '../signoff9/lib9.mjs';
import { namedPdf } from './lib11.mjs';

const R = report('s11-b-combine');

const targets = (p, pageIndex) => p.links[pageIndex].map((l) => (l.target ?? (/^https?:/.test(l.uri) ? l.uri : `?${l.uri}`)));

await R.step('B1 clashing named destinations and internal links', async () => {
  const dir = dirOf('in');
  const a = put(dir, 'Alpha.pdf', namedPdf('Alpha', 4, 3, 4, 2));
  const b = put(dir, 'Beta.pdf', namedPdf('Beta', 5, 2, 5, 4));
  const g = put(dir, 'Gamma.pdf', namedPdf('Gamma', 3, 2, 3, 3, 'dict'));
  const srcG = inspect(g);
  R.say(`INFO source Gamma (old-style /Dests) page 1 link targets ${JSON.stringify(targets(srcG, 0))}`);
  const srcA = inspect(a);
  const srcB = inspect(b);
  R.say(`INFO source Alpha page 1 link targets ${JSON.stringify(targets(srcA, 0))}; outline ${JSON.stringify(srcA.outline.map((o) => [o.title, o.page]))}`);
  R.say(`INFO source Beta page 1 link targets ${JSON.stringify(targets(srcB, 0))}; outline ${JSON.stringify(srcB.outline.map((o) => [o.title, o.page]))}`);
  const srcOk = JSON.stringify(targets(srcA, 0).slice(0, 4)) === '[3,3,4,2]' && JSON.stringify(targets(srcB, 0).slice(0, 4)) === '[2,2,5,4]' && JSON.stringify(targets(srcG, 0).slice(0, 4)) === '[2,2,3,3]';
  R.check('the test files are right: the sources resolve their own names (Alpha 3,3,4,2; Beta 2,2,5,4)', srcOk);
  const before = [sha(a), sha(b)];
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    // run 1: Alpha + Beta, all pages
    let dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b, g], 3);
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    const out1 = join(dirOf('out'), 'AB.pdf');
    await combine(s, dlg, out1);
    R.say(`INFO notice: ${await waitNotice(s, /Combined 3 files/)}`);
    const p = inspect(out1);
    const tg = targets(p, 9);
    R.say(`INFO page 10 (Gamma 1) targets ${JSON.stringify(tg)}`);
    R.check("Gamma links (old-style names) point at Gamma pages (11,11,12,12), or were removed: never at Alpha or Beta", tg.filter((t) => typeof t === "number").every((t) => [11, 12].includes(t)), tg);
    const ta = targets(p, 0);
    const tb = targets(p, 4);
    R.say(`INFO AB.pdf: ${p.pages} pages; page 1 targets ${JSON.stringify(ta)}; page 5 (Beta 1) targets ${JSON.stringify(tb)}`);
    R.say(`INFO AB.pdf outline ${JSON.stringify(p.outline.map((o) => [o.depth, o.title, o.page]))}`);
    const okSet = (got, want) => got.filter((t) => typeof t === 'number').every((t) => want.includes(t));
    R.check('Alpha links in the result point at Alpha pages only (3,3,4,2), or were removed: never elsewhere', okSet(ta, [3, 4, 2]) && !ta.some((t) => typeof t === 'string' && t.startsWith('?')), ta);
    R.check('Beta links in the result point at Beta pages (6,6,9,8), or were removed: never at Alpha pages', okSet(tb, [6, 9, 8]) && !tb.some((t) => typeof t === 'string' && t.startsWith('?')), tb);
    R.say(`INFO link counts kept: Alpha ${ta.length}/5 ${JSON.stringify(ta) === JSON.stringify([3, 3, 4, 2, 'https://example.com/Alpha']) ? '(all exact)' : ''}; Beta ${tb.length}/5 ${JSON.stringify(tb) === JSON.stringify([6, 6, 9, 8, 'https://example.com/Beta']) ? '(all exact)' : ''}`);
    R.check('web links kept on both', ta.includes('https://example.com/Alpha') && tb.includes('https://example.com/Beta'));
    const ob = p.outline.filter((o) => /^Beta (chapter|intro)/.test(o.title));
    const oa = p.outline.filter((o) => /^Alpha (chapter|intro)/.test(o.title));
    R.check('bookmarks: Alpha items point into Alpha (3, 4) and Beta items into Beta (6, 9), or are dropped: never the wrong file', oa.every((o) => [3, 4].includes(o.page)) && ob.every((o) => [6, 9].includes(o.page)), { oa, ob });
    R.check('page text order Alpha 1-4 then Beta 1-5', p.text.join('|') === 'Alpha 1|Alpha 2|Alpha 3|Alpha 4|Beta 1|Beta 2|Beta 3|Beta 4|Beta 5|Gamma 1|Gamma 2|Gamma 3', p.text);
    await closeNotice(s);
    // run 2: Beta first with pages 1,3-4 (its chapter page 2 and intro page 5 left out), then Alpha
    dlg = await openCombine(s);
    await addFiles(s, dlg, [b, a], 2);
    await rowOf(dlg, 'Beta.pdf').getByRole('textbox').first().fill('1, 3-4');
    await delay(500);
    await dlg.getByLabel('Open the new file when it is ready').uncheck().catch(() => undefined);
    const out2 = join(dirOf('out'), 'BA.pdf');
    await combine(s, dlg, out2);
    R.say(`INFO notice: ${await waitNotice(s, /Combined 2 files/)}`);
    const q = inspect(out2);
    const qb = targets(q, 0);
    const qa = targets(q, 3);
    R.say(`INFO BA.pdf: ${q.pages} pages ${JSON.stringify(q.text)}; Beta page targets ${JSON.stringify(qb)}; Alpha page targets ${JSON.stringify(qa)}; outline ${JSON.stringify(q.outline.map((o) => [o.depth, o.title, o.page]))}`);
    R.check('Beta with its named targets left out: those links are removed, the plain link (Beta 4 = page 3) stays; none points at Alpha', qb.filter((t) => typeof t === 'number').every((t) => t === 3), qb);
    R.check('Alpha after Beta: its links point at Alpha pages (6,6,7,5)', okSet(qa, [6, 7, 5]), qa);
    const qob = q.outline.filter((o) => /^Beta (chapter|intro)/.test(o.title));
    R.check('Beta bookmarks to left-out pages are dropped (not re-pointed at another page)', qob.length === 0 || qob.every((o) => o.page === null), qob);
    R.check('inputs unchanged', sha(a) === before[0] && sha(b) === before[1]);
    await closeNotice(s);
  } finally { await s.close(); }
});

await R.step('B2 Cancel at half of a large job, onto an existing file', async () => {
  const dir = dirOf('big');
  const inputs = [];
  for (let i = 1; i <= 6; i++) { const p = join(dir, `big${i}.pdf`); copyFileSync(fixture('big-1000.pdf'), p); inputs.push(p); }
  const brochureDir = join(process.cwd(), 'tests', 'engine', 'corpus', 'brochure-images');
  const brochure = readdirSync(brochureDir).find((n) => n.endsWith('.pdf'));
  if (brochure) { const p = join(dir, 'brochure.pdf'); copyFileSync(join(brochureDir, brochure), p); inputs.push(p); }
  const before = inputs.map(sha);
  const outDir = dirOf('out');
  const target = put(outDir, 'Combined.pdf', buildPdf({ pages: 2, tag: 'Precious' }));
  const targetSha = sha(target);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const journal = join(s.profile, 'jobs-journal.json');
    const runAndCancel = async (label, when) => {
      const dlg = await openCombine(s);
      if ((await dlg.locator('[data-row-id]').count()) === 0) await addFiles(s, dlg, inputs);
      await rowsReady(dlg, inputs.length, 120000);
      R.say(`INFO ${label}: rows ${JSON.stringify(await rowNames(dlg))}; summary ${(await dlg.locator('[data-combine-summary]').innerText()).trim()}`);
      const box = dlg.getByLabel('Open the new file when it is ready');
      if (await box.isChecked()) await box.uncheck();
      await combine(s, dlg, target);
      const bar = s.win.locator('footer[data-job-status="combine"]');
      await bar.waitFor({ timeout: 30000 });
      const seen = new Set();
      let at = null;
      let sawPart = false;
      const t0 = Date.now();
      for (;;) {
        const t = (await bar.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (t) seen.add(t.replace(/\d+/g, 'N'));
        if (listing(outDir).some((n) => /\.part$/.test(n))) sawPart = true;
        const m = /(\d[\d,]*) of (\d[\d,]*) (pages|files)/.exec(t);
        if (when === 'half' && m && Number(m[1].replace(/,/g, '')) >= Number(m[2].replace(/,/g, '')) / 2) { at = t; break; }
        if (when === 'saving' && /saving|checking/.test(t)) { at = t; break; }
        if (!t || Date.now() - t0 > 300000) break;
        await delay(20);
      }
      R.say(`INFO ${label}: phases seen ${JSON.stringify([...seen])}; cancelling at "${at}"; folder then ${JSON.stringify(listing(outDir))}`);
      if (at) await bar.getByRole('button', { name: 'Cancel' }).click({ timeout: 5000 }).catch(() => R.say('INFO cancel click failed (job ended)'));
      const text = await anyNotice(s, 300000);
      await delay(1500);
      const files = listing(outDir);
      R.say(`INFO ${label}: notice "${text}"; folder ${JSON.stringify(files)}; temp file was seen during the run: ${sawPart}; journal ${existsSync(journal) ? readFileSync(journal, 'utf8').slice(0, 120) : 'missing'}`);
      const cancelled = /^Cancelled\. No files were created and your original files were not changed\./.test(text);
      if (cancelled) {
        R.check(`${label}: after Cancel the existing Combined.pdf is byte-identical`, sha(target) === targetSha);
        R.check(`${label}: no partial or temp file in the folder`, JSON.stringify(files) === '["Combined.pdf"]', files);
        R.check(`${label}: the journal lists no temp file`, !existsSync(journal) || readFileSync(journal, 'utf8').trim() === '[]');
      } else {
        R.say(`INFO ${label}: the job was not cancelled in time`);
        R.check(`${label}: finished instead: a complete file`, /^Combined 7 files/.test(text) && inspect(target).pages > 6000, text);
      }
      R.check(`${label}: inputs unchanged`, inputs.every((f, i) => sha(f) === before[i]));
      await closeNotice(s);
      return cancelled;
    };
    const c1 = await runAndCancel('cancel at half', 'half');
    if (c1) {
      const dlg = await openCombine(s);
      R.check('reopening shows the list as it was', JSON.stringify(await rowNames(dlg)) === JSON.stringify(inputs.map((p) => p.split(/[\\/]/).pop())), await rowNames(dlg));
      await s.win.keyboard.press('Escape');
      await delay(400);
    }
    const c2 = sha(target) === targetSha ? await runAndCancel('cancel while saving', 'saving') : false;
    R.say(`INFO cancelled: half ${c1}, saving ${c2}`);
    // now let it finish, to a new name; then check the result
    const dlg = await openCombine(s);
    if ((await dlg.locator('[data-row-id]').count()) === 0) await addFiles(s, dlg, inputs);
    await rowsReady(dlg, inputs.length, 120000);
    const box = dlg.getByLabel('Open the new file when it is ready');
    if (await box.isChecked()) await box.uncheck();
    const done = join(outDir, 'Finished.pdf');
    await combine(s, dlg, done);
    const text = await waitNotice(s, /Combined 7 files|could not|Something|too large|stopped/, 400000);
    R.say(`INFO full run notice: ${text}`);
    const doc = mu.Document.openDocument(readFileSync(done), 'application/pdf');
    const pages = doc.countPages();
    doc.destroy();
    R.check('the run after the cancels succeeds with every page (6000 + the brochure)', /^Combined 7 files into Finished\.pdf/.test(text) && pages > 6000, pages);
    R.check('folder holds the old Combined.pdf (unchanged) and Finished.pdf only', JSON.stringify(listing(outDir)) === '["Combined.pdf","Finished.pdf"]' && sha(target) === targetSha, listing(outDir));
    R.check('inputs unchanged at the end', inputs.every((f, i) => sha(f) === before[i]));
    await closeNotice(s);
  } finally { await s.close(); }
});

await R.step('B3 Add open files with unsaved edits in an open tab', async () => {
  const dir = dirOf('open');
  const y = put(dir, 'Clean.pdf', buildPdf({ pages: 3, tag: 'Clean' }));
  const x = put(dir, 'Edited.pdf', buildPdf({ pages: 6, tag: 'Edited' }));
  const before = [sha(x), sha(y)];
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, y, 3);
    await open(s, x, 6);
    await palette(s.win, 'Pages: Delete'); // page 1 of Edited.pdf, unsaved
    await waitFor(() => isDirty(s.win), { timeoutMs: 10000, label: 'unsaved' });
    let dlg = await openCombine(s);
    await dlg.getByRole('button', { name: 'Add open files' }).click();
    await rowsReady(dlg, 2);
    const names = await rowNames(dlg);
    const unsaved = await dlg.locator('[data-combine-unsaved] span').allInnerTexts();
    R.say(`INFO rows ${JSON.stringify(names)}; unsaved messages ${JSON.stringify(unsaved)}; Edited row: ${(await rowOf(dlg, 'Edited.pdf').innerText()).replace(/\s+/g, ' ')}`);
    R.check('both open files are listed', names.length === 2 && names.includes('Edited.pdf') && names.includes('Clean.pdf'), names);
    R.check('the spec message names the edited file only, with Save now', JSON.stringify(unsaved) === JSON.stringify(['Edited.pdf has unsaved changes. The saved version will be used.']) && (await dlg.getByRole('button', { name: 'Save now' }).count()) === 1, unsaved);
    R.check('the row shows the saved version (6 pages)', /6 pages/.test(await rowOf(dlg, 'Edited.pdf').innerText()));
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    const out1 = join(dirOf('out'), 'Saved version.pdf');
    await combine(s, dlg, out1);
    R.say(`INFO notice: ${await waitNotice(s, /Combined 2 files|changed|could not|Something/)}`);
    const p = inspect(out1);
    const edited = p.text.filter((t) => /^Edited/.test(t));
    R.check('the result holds the SAVED version: Edited 1-6 and Clean 1-3', edited.join('|') === 'Edited 1|Edited 2|Edited 3|Edited 4|Edited 5|Edited 6' && p.pages === 9, p.text);
    R.check('the files on disk are unchanged and the tab still has its unsaved edit', sha(x) === before[0] && sha(y) === before[1] && (await isDirty(s.win)));
    R.check('the open document still shows 5 pages (the edit is not lost)', /of 5/.test((await s.win.locator('footer').last().innerText()).replace(/\s+/g, ' ')), (await s.win.locator('footer').last().innerText()).replace(/\s+/g, ' ').slice(0, 80));
    await closeNotice(s);
    // Save now, then combine: the edited version
    dlg = await openCombine(s);
    await dlg.getByRole('button', { name: 'Add open files' }).click();
    await rowsReady(dlg, 2);
    await dlg.getByRole('button', { name: 'Save now' }).click();
    await waitFor(async () => (await dlg.locator('[data-combine-unsaved]').count()) === 0, { timeoutMs: 20000, label: 'the unsaved message to go' });
    await delay(1500);
    await rowsReady(dlg, 2);
    R.say(`INFO after Save now: Edited row "${(await rowOf(dlg, 'Edited.pdf').innerText()).replace(/\s+/g, ' ')}"; file changed on disk ${sha(x) !== before[0]}; tab dirty ${await isDirty(s.win)}; messages ${JSON.stringify(await messagesOf(dlg))}`);
    R.check('Save now saves the file (5 pages on disk) and clears the unsaved dot', inspect(x).pages === 5 && !(await isDirty(s.win)));
    R.check('the row now shows 5 pages', /5 pages/.test(await rowOf(dlg, 'Edited.pdf').innerText()), (await rowOf(dlg, 'Edited.pdf').innerText()).replace(/\s+/g, ' '));
    const cb = dlg.getByLabel('Open the new file when it is ready');
    if (await cb.isChecked()) await cb.uncheck();
    const out2 = join(dirOf('out'), 'After save.pdf');
    await combine(s, dlg, out2);
    await delay(500);
    let note = '';
    try { note = await anyNotice(s, 30000); } catch { note = ''; }
    const stillOpen = (await windowOf(s.win).count()) === 1;
    R.say(`INFO after Save now, Combine: notice "${note}"; window open ${stillOpen}; messages ${stillOpen ? JSON.stringify(await messagesOf(windowOf(s.win))) : ''}; out exists ${existsSync(out2)}`);
    if (existsSync(out2)) {
      const q = inspect(out2);
      R.check('after Save now the result holds the edited version (Edited 2-6, then Clean)', q.text.filter((t) => /^Edited/.test(t)).join('|') === 'Edited 2|Edited 3|Edited 4|Edited 5|Edited 6' && q.pages === 8, q.text);
    } else {
      R.check('after Save now: no file, and a clear message (never a mixed or wrong file)', /changed|Try again/.test(note) || stillOpen, note);
    }
    R.check('Clean.pdf unchanged', sha(y) === before[1]);
  } finally { await s.close(); }
});

await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
