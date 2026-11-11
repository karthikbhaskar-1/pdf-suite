// Sign-Off 9, A1: Split by blank pages (which kinds are found, per the calibration), untick, keep/leave out, bookmarks and links in the parts.
import { join } from 'node:path';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, open, openSheet, ready, chooseFolder, waitNotice, splitButton, listing, sha, closeNotice } from './lib9.mjs';

const R = report('a1-blank');
const pdfBytes = () => buildPdf({
  pages: 11,
  spec: {
    1: { lines: 30 }, 2: { blank: true }, 3: { lines: 30 }, 4: { noise: true }, 5: { lines: 30 },
    6: { raw: 'BT /F1 10 Tf 300 40 Td (12) Tj ET' }, 7: { lines: 30 },
    8: { raw: 'BT /F1 12 Tf 60 400 Td (See attached.) Tj ET' }, 9: { lines: 30 }, 10: { blank: true }, 11: { lines: 30 },
  },
  outline: [
    { title: 'Part One', page: 1, children: [{ title: 'One-A', page: 2 }, { title: 'One-B', page: 3 }] },
    { title: 'Part Two', page: 5, children: [{ title: 'Two-A', page: 6 }, { title: 'Two-B', page: 8 }] },
    { title: 'Notice', page: 10 },
    { title: 'Last', page: 11 },
  ],
  links: [
    { page: 1, url: 'https://example.com/ext' }, { page: 1, toPage: 3, rect: [60, 100, 200, 130] },
    { page: 5, toPage: 7 }, { page: 5, toPage: 2, rect: [60, 100, 200, 130] }, { page: 7, toPage: 11 }, { page: 11, toPage: 1 },
  ],
  notes: [{ page: 10, text: 'lone sticky' }, { page: 3, text: 'note three' }],
});

const listItems = (sheet) => sheet.locator('.split-blank-item').evaluateAll((els) => els.map((e) => e.textContent.trim()));
const describe = (p) => `pages ${p.pages} text ${JSON.stringify(p.text.map((t) => t.slice(0, 12)))} outline ${JSON.stringify(p.outline.map((o) => `${o.depth}:${o.title}@${o.page}`))} links ${JSON.stringify(p.links.map((l) => l.map((x) => `${x.uri}>${x.target}`)))} notes ${JSON.stringify(p.notes)}`;

await R.step('A1 blank pages', async () => {
  const dir = dirOf('src');
  const path = put(dir, 'Blanky.pdf', pdfBytes());
  const before = sha(path);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, 11);
    // ---- default: Blank pages
    let sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Blank pages' }).click();
    await sheet.locator('.split-blank-list').waitFor({ timeout: 60000 });
    const def = await listItems(sheet);
    R.say(`INFO default list: ${JSON.stringify(def)}; summary: ${(await sheet.locator('[data-split-summary]').innerText()).trim()}`);
    R.check('default finds exactly true blank (2) and noise (4)', JSON.stringify(def) === JSON.stringify(['Page 2', 'Page 4']), def);
    R.say(`INFO help: ${(await sheet.locator('[data-split-blank-help]').innerText()).trim()}`);
    const out1 = dirOf('out1');
    await chooseFolder(s, sheet, out1);
    await splitButton(sheet).click();
    R.say(`INFO notice1: ${await waitNotice(s, /Split Blanky\.pdf into/)}`);
    const names1 = listing(out1);
    R.check('default split: 3 files', names1.length === 3, names1);
    const parts1 = names1.map((n) => inspect(join(out1, n)));
    parts1.forEach((p, i) => R.say(`INFO d-part${i + 1}: ${describe(p)}`));
    R.check('default split page counts 1,1,7', JSON.stringify(parts1.map((p) => p.pages)) === '[1,1,7]', parts1.map((p) => p.pages));
    R.check('part 3 starts with page 5 text', /^Page 5 line 1/.test(parts1[2]?.text[0] ?? ''), parts1[2]?.text[0]?.slice(0, 30));
    R.check('part 3 keeps the sticky note of page 10 (its 6th page)', (parts1[2]?.notes[5] ?? []).some((n) => /lone sticky/.test(n)), parts1[2]?.notes);
    R.check('part 2 keeps the note on page 3', (parts1[1]?.notes[0] ?? []).some((n) => /note three/.test(n)), parts1[1]?.notes);
    R.check('source unchanged', sha(path) === before);
    await closeNotice(s);

    // ---- nearly blank, untick page 8
    sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Blank pages' }).click();
    await sheet.locator('.split-blank-list').waitFor({ timeout: 60000 });
    await sheet.getByLabel('What counts as blank').selectOption({ label: 'Blank and nearly blank pages' });
    await sheet.getByText(/^Found \d+ blank or nearly blank pages/).waitFor({ timeout: 10000 });
    const loose = await listItems(sheet);
    R.say(`INFO nearly list: ${JSON.stringify(loose)}`);
    R.check('nearly finds 2,4,6,8,10', JSON.stringify(loose.map((t) => t.replace(/ · has marks/, ''))) === JSON.stringify(['Page 2', 'Page 4', 'Page 6', 'Page 8', 'Page 10']), loose);
    R.check('pages 2 and 4 are not marked has marks; 6, 8 and 10 are', !/has marks/.test(loose[0] + loose[1]) && /has marks/.test(loose[2]) && /has marks/.test(loose[3]) && /has marks/.test(loose[4]), loose);
    R.check('Keep at the end is chosen by itself', await sheet.getByRole('radio', { name: 'Keep at the end of the file before' }).isChecked());
    await sheet.getByLabel('Page 8, starts a new file').uncheck();
    R.say(`INFO summary after untick 8: ${(await sheet.locator('[data-split-summary]').innerText()).trim()}`);
    const out2 = dirOf('out2');
    await chooseFolder(s, sheet, out2);
    await splitButton(sheet).click();
    R.say(`INFO notice2: ${await waitNotice(s, /Split Blanky\.pdf into/)}`);
    const names2 = listing(out2);
    const parts2 = names2.map((n) => inspect(join(out2, n)));
    parts2.forEach((p, i) => R.say(`INFO n-part${i + 1}: ${describe(p)}`));
    R.check('nearly with 8 unticked: pages per file 2,2,2,4,1', JSON.stringify(parts2.map((p) => p.pages)) === '[2,2,2,4,1]', parts2.map((p) => p.pages));
    R.check('kept page 8 ("See attached.") is in part 4', /See attached/.test(parts2[3]?.text.join(' ') ?? ''));
    R.check('blank page kept at the end of the file before: part 1 last page is empty', (parts2[0]?.text[1] ?? 'x') === '', parts2[0]?.text);
    R.check('source unchanged again', sha(path) === before);
    await closeNotice(s);

    // ---- nearly blank, Leave out
    sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Blank pages' }).click();
    await sheet.locator('.split-blank-list').waitFor({ timeout: 60000 });
    await sheet.getByLabel('What counts as blank').selectOption({ label: 'Blank and nearly blank pages' });
    await sheet.getByRole('radio', { name: 'Leave out' }).check();
    R.say(`INFO summary leave-out nearly: ${(await sheet.locator('[data-split-summary]').innerText()).trim()}`);
    const out3 = dirOf('out3');
    await chooseFolder(s, sheet, out3);
    await splitButton(sheet).click();
    await waitNotice(s, /Split Blanky\.pdf into/);
    const parts3 = listing(out3).map((n) => inspect(join(out3, n)));
    R.check('nearly + Leave out: content pages 1,3,5,7,9,11 alone, one page each', JSON.stringify(parts3.map((p) => p.pages)) === '[1,1,1,1,1,1]', parts3.map((p) => p.pages));
    parts3.forEach((p, i) => R.say(`INFO l-part${i + 1}: ${describe(p)}`));
    await closeNotice(s);
  } finally {
    await s.close();
  }
});
await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
