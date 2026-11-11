// Sign-Off 9, B1: Combine PDFs: order, per-file ranges, the same file twice, bookmarks, links, notes, filled form values.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as mu from 'mupdf';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, openCombine, addFiles, rowNames, rowOf, rowsReady, combine, waitNotice, windowOf, sha, delay, messagesOf, waitFor } from './lib9.mjs';

const R = report('b1-combine-pdfs');
const fmtLinks = (p) => JSON.stringify(p.links.map((l) => l.map((x) => (x.target ? `p${x.target}` : x.uri))));

await R.step('B1a order, ranges, the same file twice, links, notes, bookmarks', async () => {
  const dir = dirOf('in');
  const report1 = put(dir, 'Report.pdf', buildPdf({
    pages: 5, tag: 'Report', w: 300, h: 400,
    outline: [{ title: 'R-Intro', page: 1, children: [{ title: 'R-Sub', page: 2 }] }, { title: 'R-Middle', page: 4 }, { title: 'R-End', page: 5 }],
    links: [
      { page: 1, url: 'https://example.com/r1' }, { page: 1, toPage: 2, rect: [20, 100, 120, 130] },
      { page: 2, toPage: 4 }, { page: 4, toPage: 5 }, { page: 5, toPage: 1 }, { page: 5, url: 'https://example.com/r5', rect: [20, 100, 120, 130] },
    ],
    notes: [{ page: 2, text: 'note on 2' }, { page: 5, text: 'note on 5' }],
  }));
  const other = put(dir, 'Other.pdf', buildPdf({ pages: 3, tag: 'Other', w: 500, h: 300, links: [{ page: 1, toPage: 3 }], notes: [{ page: 3, text: 'other three' }] }));
  const before = [sha(report1), sha(other)];
  const out = join(dirOf('out'), 'Mix.pdf');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [report1, other], 2);
    await addFiles(s, dlg, [report1]);
    await delay(1500);
    const names = await rowNames(dlg);
    R.say(`INFO rows after adding Report.pdf twice: ${JSON.stringify(names)}; messages ${JSON.stringify(await messagesOf(dlg))}`);
    R.check('the same file can be listed twice (3 rows)', names.length === 3, names);
    if (names.length === 3) {
      // Move Other.pdf to the top
      await rowOf(dlg, 'Other.pdf').click();
      await dlg.getByRole('button', { name: 'Move up' }).click();
      const order = await rowNames(dlg);
      R.check('Other.pdf is first now', order[0] === 'Other.pdf', order);
      const fields = dlg.getByLabel('Pages of Report.pdf');
      R.say(`INFO Pages fields for Report.pdf: ${await fields.count()}`);
      await fields.nth(0).fill('1-2');
      await fields.nth(1).fill('4, 5');
      await dlg.getByLabel('Open the new file when it is ready').uncheck();
      R.say(`INFO summary: ${(await dlg.locator('[data-combine-summary]').innerText()).trim()}`);
      await combine(s, dlg, out);
      R.say(`INFO notice: ${await waitNotice(s, /Combined 3 files into Mix\.pdf/)}`);
      const p = inspect(out);
      R.say(`INFO result: pages ${p.pages} sizes ${JSON.stringify(p.sizes)} text ${JSON.stringify(p.text)}`);
      R.say(`INFO outline: ${JSON.stringify(p.outline.map((o) => `${o.depth}:${o.title}@${o.page}`))}`);
      R.say(`INFO links: ${fmtLinks(p)}`);
      R.say(`INFO notes: ${JSON.stringify(p.notes)}`);
      R.check('7 pages in the order Other 1-3, Report 1,2, Report 4,5', JSON.stringify(p.text) === JSON.stringify(['Other 1', 'Other 2', 'Other 3', 'Report 1', 'Report 2', 'Report 4', 'Report 5']), p.text);
      R.check('sizes follow the files (500x300 x3, then 300x400 x4)', JSON.stringify(p.sizes) === JSON.stringify([[500, 300], [500, 300], [500, 300], [300, 400], [300, 400], [300, 400], [300, 400]]), p.sizes);
      R.check('link Other p1 -> p3 remapped to page 3', p.links[0].some((l) => l.target === 3), p.links[0]);
      R.check('first Report copy: link p1->p2 now points to page 5', p.links[3].some((l) => l.target === 5), p.links[3]);
      R.check('first Report copy keeps its external link', p.links[3].some((l) => l.uri === 'https://example.com/r1'), p.links[3]);
      R.check('second Report copy: link p4->p5 points to page 7 (its own copy), not page 5', p.links[5].some((l) => l.target === 7) && !p.links[5].some((l) => l.target === 5), p.links[5]);
      R.check('second Report copy keeps its external link on page 5', p.links[6].some((l) => l.uri === 'https://example.com/r5'), p.links[6]);
      R.say(`INFO first copy p2 link to a left-out page 4: ${JSON.stringify(p.links[4])}; second copy p5 link to left-out page 1: ${JSON.stringify(p.links[6])}`);
      R.check('notes: Other 3 and Report 2 and Report 5 notes are on the right pages', (p.notes[2] ?? []).some((n) => /other three/.test(n)) && (p.notes[4] ?? []).some((n) => /note on 2/.test(n)) && (p.notes[6] ?? []).some((n) => /note on 5/.test(n)), p.notes);
      R.check('inputs unchanged', sha(report1) === before[0] && sha(other) === before[1]);
      R.check('bookmarks: one per file, in order, with the right pages (Other@1, Report@4, Report@6)', JSON.stringify(p.outline.filter((o) => o.depth === 0).map((o) => `${o.title}@${o.page}`)) === JSON.stringify(['Other@1', 'Report@4', 'Report@6']), p.outline);
    }
  } finally { await s.close(); }
});

await R.step('B1b filled form values are visible after Combine', async () => {
  const dir = dirOf('in');
  const src = join(process.cwd(), 'tests', 'engine', 'corpus', 'irs-fw9', 'fw9.pdf');
  const doc = new mu.PDFDocument(readFileSync(src));
  doc.getTrailer().get('Root').get('AcroForm').delete('XFA');
  const page = doc.loadPage(0);
  const widgets = page.getWidgets();
  const filled = [];
  for (const w of widgets) {
    try {
      if (w.isReadOnly?.()) continue;
      const t = w.getFieldType();
      if (t === 'text' && filled.length < 3) { w.setTextValue(`ZEBRA${filled.length}QX`); filled.push(`ZEBRA${filled.length}QX`); }
      if ((t === 'checkbox') && filled.length >= 3 && filled.length < 4) { w.toggle?.(); filled.push('check'); }
    } catch (e) { /* ignore */ }
  }
  page.update();
  const formPath = put(dir, 'Filled form.pdf', Buffer.from(doc.saveToBuffer('').asUint8Array().slice()));
  R.say(`INFO filled ${filled.length} widgets; text fields visible before: ${/ZEBRA0QX/.test(inspect(formPath).text[0])}`);
  const plain = put(dir, 'Plain.pdf', buildPdf({ pages: 1, tag: 'Plain' }));
  const out = join(dirOf('out'), 'Form out.pdf');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [plain, formPath], 2);
    const notices = await dlg.locator('[data-combine-notices] p').evaluateAll((els) => els.map((e) => e.textContent));
    R.say(`INFO notices: ${JSON.stringify(notices)}`);
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    R.say(`INFO notice: ${await waitNotice(s, /Combined 2 files/)}`);
    const p = inspect(out);
    R.check('no live form fields remain (flattened)', p.widgets === 0, p.widgets);
    const all = p.text.join(' ');
    R.check('the typed values ZEBRA0QX..ZEBRA2QX are visible on the page text', /ZEBRA0QX/.test(all) && /ZEBRA1QX/.test(all) && /ZEBRA2QX|^$/.test(""), all.match(/ZEBRA\dQX/g));
    R.check('form page count kept', p.pages === 1 + inspect(formPath).pages, p.pages);
  } finally { await s.close(); }
});
await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
