// Sign-Off 9, A2: Split by bookmarks (nested, odd names), by size (one page over the limit), names that already exist.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, open, openSheet, ready, chooseFolder, waitNotice, splitButton, listing, sha, sizeOf, closeNotice } from './lib9.mjs';

const R = report('a2-bookmarks-size-names');

await R.step('A2a bookmarks with odd names', async () => {
  const long = 'L'.repeat(200);
  const dir = dirOf('src');
  const path = put(dir, 'Odd.pdf', buildPdf({
    pages: 10,
    outline: [
      { title: 'Intro', page: 2, children: [{ title: 'Intro child', page: 3 }, { title: 'Deep', page: 4, children: [{ title: 'Deeper', page: 5 }] }] },
      { title: 'Intro', page: 6 },
      { title: 'AUX', page: 7 },
      { title: 'What/why? "now"', page: 8 },
      { title: 'End. ', page: 9 },
      { title: long, page: 10 },
    ],
    links: [{ page: 2, toPage: 4 }, { page: 2, toPage: 8, rect: [60, 100, 200, 130] }, { page: 6, url: 'https://example.com/k' }],
  }));
  const before = sha(path);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 10);
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Bookmarks' }).click();
    await sheet.getByText(/top-level bookmarks/).waitFor({ timeout: 15000 });
    R.say(`INFO bookmarks line: ${(await sheet.getByText(/top-level bookmarks/).first().innerText()).trim()}; example: ${(await sheet.locator('[data-split-example]').innerText()).trim()}; summary: ${(await sheet.locator('[data-split-summary]').innerText()).trim()}`);
    const out = dirOf('out');
    await chooseFolder(s, sheet, out);
    await splitButton(sheet).click();
    R.say(`INFO notice: ${await waitNotice(s, /Split Odd\.pdf into|could not|wrong|Something/)}`);
    const names = listing(out);
    R.say(`INFO names: ${JSON.stringify(names.map((n) => (n.length > 90 ? `${n.slice(0, 40)}...(${n.length})` : n)))}`);
    R.check('7 files (Start + 6 top-level)', names.length === 7, names.length);
    R.check('all names are distinct and legal on Windows', new Set(names.map((n) => n.toLowerCase())).size === names.length && names.every((n) => !/[<>:"/\\|?*]/.test(n) && !/[ .]\.pdf$/i.test(n) && !/^(CON|AUX|NUL|PRN)(\.| - |$)/i.test(n.replace(/^Odd - \d+ /, ''))), names);
    let total = 0;
    names.forEach((n) => {
      const p = inspect(join(out, n));
      total += p.pages;
      R.say(`INFO ${n.slice(0, 45)}: pages ${p.pages} first ${p.text[0]} outline ${JSON.stringify(p.outline.map((o) => `${o.depth}:${o.title.slice(0, 12)}@${o.page}`))} links ${JSON.stringify(p.links.map((l) => l.map((x) => `${x.uri}>${x.target}`)))}`);
    });
    R.check('all 10 pages are in the parts exactly once', total === 10, total);
    const intro = names.find((n) => /02 Intro\.pdf$/.test(n));
    if (intro) {
      const p = inspect(join(out, intro));
      R.check('Intro part: nested bookmarks kept with depth', p.outline.length === 4 && p.outline[3]?.depth === 2, p.outline);
      R.check('Intro part: link to page 4 became page 3 of this part', p.links[0].some((l) => l.target === 3), p.links[0]);
      R.say(`INFO Intro part link to page 8 (in another file): ${JSON.stringify(p.links[0])}`);
    } else R.check('Intro part exists', false, names);
    R.check('source unchanged', sha(path) === before);
  } finally { await s.close(); }
});

await R.step('A2b size: one page over the limit', async () => {
  const dir = dirOf('src');
  const spec = {};
  for (let i = 1; i <= 12; i++) spec[i] = { junkKb: 10 };
  spec[5] = { junkKb: 260 };
  const path = put(dir, 'Heavy.pdf', buildPdf({ pages: 12, spec }));
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 12);
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'File size' }).click();
    await sheet.getByLabel('Largest file').fill('100');
    await sheet.getByLabel('Size unit').selectOption('KB');
    const out = dirOf('out');
    await chooseFolder(s, sheet, out);
    await splitButton(sheet).click();
    const note = await waitNotice(s, /Split Heavy\.pdf into \d+ files\./);
    R.say(`INFO notice: ${note}`);
    const names = listing(out);
    let pages = 0;
    const over = [];
    for (const n of names) {
      const sz = sizeOf(join(out, n));
      const pc = inspect(join(out, n)).pages;
      pages += pc;
      R.say(`INFO ${n}: ${sz} bytes, ${pc} pages`);
      if (sz > 100 * 1024) over.push(n);
    }
    R.check('no page lost', pages === 12, pages);
    R.check('exactly one part is over the limit and the notice names it and page 5', over.length === 1 && note.includes(over[0].replace(/\.pdf$/, '')) && /Page 5 is larger than 100 KB by itself/.test(note), { over, note });
  } finally { await s.close(); }
});

await R.step('A2c names that already exist are never overwritten', async () => {
  const dir = dirOf('src');
  const path = put(dir, 'Names.pdf', buildPdf({ pages: 6 }));
  const out = dirOf('out');
  const keep = ['Names - part 01.pdf', 'Names - part 01 (2).pdf', 'Names - PART 02.pdf', 'names - part 03.PDF'];
  keep.forEach((n) => writeFileSync(join(out, n), `precious ${n}`));
  const before = keep.map((n) => sha(join(out, n)));
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 6);
    const sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByLabel('Pages in each file').fill('2');
    await chooseFolder(s, sheet, out);
    await splitButton(sheet).click();
    R.say(`INFO notice: ${await waitNotice(s, /Split Names\.pdf into/)}`);
    const names = listing(out);
    R.say(`INFO folder: ${JSON.stringify(names)}`);
    R.check('the four old files are byte-identical', keep.every((n, i) => sha(join(out, n)) === before[i]));
    R.check('three new files made', names.length === 7, names.length);
    const newOnes = names.filter((n) => !keep.includes(n));
    R.say(`INFO new: ${JSON.stringify(newOnes)}`);
    R.check('each new file is a real 2-page PDF', newOnes.every((n) => { try { return inspect(join(out, n)).pages === 2; } catch { return false; } }), newOnes);
    await closeNotice(s);
  } finally { await s.close(); }
});
await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
