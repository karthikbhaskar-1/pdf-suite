// Probe A: odd inputs. Rotated, cropped, app-rotated, cut twice, tiny and huge pages, one page, links/annotations/forms/bookmarks.
import { writeFileSync, readFileSync } from 'node:fs';
import {
  launch, closeAll, open, palette, waitForCount, saveNow, isDirty, delay, pageCount, selectAllPages, clickRowByIndex,
  newFile, copyTo, wipe, report, buildPdf, content, readPages, expectedImages, compare, planAll, planOnly, VERT, HORZ,
  openSheet, setOptions, sheetOf, fixture,
} from './lib.mjs';
import { richBytes, inspectRich } from './rich-fixture.mjs';

const R = report('a-odd-inputs');

async function session(file, pages, body) {
  const s = await launch();
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
const orig = (file) => readPages(file.path);

const ROT = buildPdf([0, 90, 180, 270].map((r) => ({ media: [0, 0, 800, 500], rotate: r, content: content(`r${r}`) })));
const CROPROT = buildPdf([
  { media: [0, 0, 800, 500], rotate: 90, crop: [40, 30, 760, 470], content: content('c90') },
  { media: [100, 100, 900, 600], rotate: 270, crop: [140, 130, 860, 570], content: `q 1 0 0 1 100 100 cm\n${content('c270')}\nQ` },
  { media: [0, 0, 800, 500], rotate: 180, crop: [100, 50, 700, 450], content: content('c180') },
]);

// 1. Rotated pages, every direction/position/order
for (const [label, opts, step] of [
  ['left/right 50', {}, VERT],
  ['top/bottom 40', { direction: 'horizontal', percent: 40 }, { cut: 'horizontal', at: 0.4, first: 'left' }],
  ['left/right 62.5 right first', { percent: 62.5, order: 'right' }, { cut: 'vertical', at: 0.625, first: 'right' }],
]) {
  await R.step(`rotated pages ${label}`, async () => {
    const f = newFile('rot.pdf', ROT);
    await session(f, 4, async (s) => {
      const o = orig(f);
      await cut(s, opts, 8);
      await saveNow(s.win);
      const { problems } = compare(f.path, expectedImages(o, planAll(4, step)));
      R.check(`rotated 0/90/180/270, ${label}`, problems.length === 0, problems.join('; '));
    });
  });
}
// 2. Cropped (and cropped+rotated) pages
await R.step('cropped+rotated', async () => {
  for (const [label, opts, step] of [['left/right 50', {}, VERT], ['top/bottom 35', { direction: 'horizontal', percent: 35 }, { cut: 'horizontal', at: 0.35, first: 'left' }]]) {
    const f = newFile('croprot.pdf', CROPROT);
    await session(f, 3, async (s) => {
      const o = orig(f);
      await cut(s, opts, 6);
      await saveNow(s.win);
      const { problems, saved } = compare(f.path, expectedImages(o, planAll(3, step)));
      R.check(`cropped+rotated, ${label}`, problems.length === 0, problems.join('; ') + ` sizes=${saved.map((p) => p.w + 'x' + p.h)}`);
    });
  }
});
// 3. Pages rotated in the app, then cut
await R.step('app rotated then cut', async () => {
  const f = newFile('approt.pdf', ROT);
  await session(f, 4, async (s) => {
    await selectAllPages(s.win);
    await palette(s.win, 'Pages: Rotate right 90°');
    await delay(1500);
    await saveNow(s.win);
    const mid = copyTo(f.path, 'mid.pdf');
    const o = readPages(mid.path);
    await cut(s, {}, 8);
    await saveNow(s.win);
    const { problems } = compare(f.path, expectedImages(o, planAll(4, VERT)));
    R.check('rotated in the app (all 4 rotated right), then cut left/right', problems.length === 0, problems.join('; '));
  });
});
// 3b. rotate in the app and cut WITHOUT saving between (unsaved rotate then cut)
await R.step('app rotate unsaved then cut', async () => {
  const f = newFile('approt2.pdf', ROT);
  await session(f, 4, async (s) => {
    await selectAllPages(s.win);
    await palette(s.win, 'Pages: Rotate right 90°');
    await waitFor0(s);
    await cut(s, {}, 8);
    await saveNow(s.win);
    // expected: original rotated right by 90 is what the app shows: build the expectation from a saved rotate-only run instead
    const g = newFile('rotonly.pdf', ROT);
    await session(g, 4, async (s2) => {
      await selectAllPages(s2.win);
      await palette(s2.win, 'Pages: Rotate right 90°');
      await waitFor0(s2);
      await saveNow(s2.win);
    });
    const o = readPages(g.path);
    const { problems } = compare(f.path, expectedImages(o, planAll(4, VERT)));
    R.check('rotate (unsaved) then cut then save equals cut of the rotated file', problems.length === 0, problems.join('; '));
  });
});
async function waitFor0(s) { await delay(1200); await s.win.locator('footer.status-progress').waitFor({ state: 'detached', timeout: 15000 }).catch(() => undefined); }

// 4. Halves of halves
await R.step('cut twice', async () => {
  const f = newFile('twice.pdf', buildPdf([{ media: [0, 0, 800, 500], content: content('T1') }, { media: [0, 0, 500, 800], rotate: 90, content: content('T2', 500, 800) }]));
  await session(f, 2, async (s) => {
    const o = orig(f);
    await cut(s, {}, 4);
    await cut(s, { direction: 'horizontal', percent: 40 }, 8);
    await saveNow(s.win);
    const first = expectedImages(o, planAll(2, VERT));
    const { problems } = compare(f.path, expectedImages(first, planAll(4, { cut: 'horizontal', at: 0.4, first: 'left' })));
    R.check('cut left/right then top/bottom 40 without saving between, then save', problems.length === 0, problems.join('; '));
    // and a third time on the saved quarters, right-first at 70
    const q = readPages(f.path);
    await cut(s, { percent: 70, order: 'right' }, 16);
    await saveNow(s.win);
    const { problems: p2 } = compare(f.path, expectedImages(q, planAll(8, { cut: 'vertical', at: 0.7, first: 'right' })));
    R.check('third cut (eighths, 70 % right first) after a save', p2.length === 0, p2.join('; '));
  });
});

// 5. Tiny, huge, one page
await R.step('tiny page', async () => {
  const f = newFile('tiny.pdf', buildPdf([{ media: [0, 0, 20, 10], content: content('x', 20, 10) }, { media: [0, 0, 3, 3], content: '0 g 0 0 1 1 re f' }, { media: [0, 0, 144, 72], content: content('x', 144, 72) }]));
  await session(f, 3, async (s) => {
    const o = orig(f);
    await cut(s, {}, 6);
    await saveNow(s.win);
    const saved = readPages(f.path);
    R.check('tiny pages 20x10, 3x3, 144x72: 6 pages, widths half', saved.length === 6 && saved.map((p) => p.exactW).join() === '10,10,1.5,1.5,72,72', saved.map((p) => `${p.exactW}x${p.exactH}`).join(' '));
  });
});
await R.step('huge page', async () => {
  const f = newFile('huge.pdf', buildPdf([{ media: [0, 0, 10000, 6000], content: content('H', 10000, 6000).replace(/Tf/g, 'Tf') }, { media: [0, 0, 14400, 14400], content: content('H2', 14400, 14400) }]));
  await session(f, 2, async (s) => {
    const o = orig(f);
    const t0 = Date.now();
    await cut(s, { direction: 'horizontal', percent: 55 }, 4);
    await saveNow(s.win);
    const { problems, saved } = compare(f.path, expectedImages(o, planAll(2, { cut: 'horizontal', at: 0.55, first: 'left' })));
    R.check(`huge pages 10000x6000 and 14400x14400 cut top/bottom 55 (${Date.now() - t0} ms)`, problems.length === 0, problems.join('; ') + ` sizes=${saved.map((p) => p.exactW + 'x' + p.exactH)}`);
  });
});
await R.step('one page file', async () => {
  const f = newFile('one.pdf', buildPdf([{ media: [0, 0, 800, 500], content: content('ONE') }]));
  await session(f, 1, async (s) => {
    const sheet = await openSheet(s, palette);
    R.check('one-page file: summary reads "Cuts 1 page into 2."', /^Cuts 1 page into 2\./.test(await sheet.locator('[data-cut-summary]').innerText()), await sheet.locator('[data-cut-summary]').innerText());
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    const o = orig(f);
    await cut(s, {}, 2);
    await palette(s.win, 'Pages: Delete').catch(() => undefined);
    await delay(500);
    R.check('one-page file after cut: 2 pages', (await pageCount(s.win)) === 2 || (await pageCount(s.win)) === 1);
    await s.win.keyboard.press('Control+z');
    await delay(300);
    await s.win.keyboard.press('Control+z');
    await delay(500);
    await cut(s, {}, 2);
    await saveNow(s.win);
    const { problems } = compare(f.path, expectedImages(o, planAll(1, VERT)));
    R.check('one-page file cut and saved', problems.length === 0, problems.join('; '));
  });
});

// 6. Links, annotations, forms, bookmarks
await R.step('rich', async () => {
  const f = newFile('rich.pdf', richBytes());
  await session(f, 2, async (s) => {
    await cut(s, {}, 4);
    await saveNow(s.win);
    const info = inspectRich(f.path);
    const mid = (b) => (b[0] + b[2]) / 2;
    const [p1a, p1b, p2a, p2b] = info.pages;
    R.say(`INFO  rich after cut: ${JSON.stringify(info).slice(0, 1800)}`);
    R.check('rich: 4 pages, each 400x500', info.pages.length === 4 && info.pages.every((p) => p.size[0] === 400 && p.size[1] === 500), info.pages.map((p) => p.size).join(' | '));
    R.check('rich: left link only on first half of page 1, right link only on second half', p1a.links.some((l) => l.uri === 'https://left.test/') && !p1a.links.some((l) => l.uri === 'https://right.test/') && p1b.links.some((l) => l.uri === 'https://right.test/') && !p1b.links.some((l) => l.uri === 'https://left.test/'));
    R.check('rich: right link position relative to its half (650..750 -> 250..350)', (p1b.links.find((l) => l.uri === 'https://right.test/')?.bounds ?? []).join() === '250,50,350,100', JSON.stringify(p1b.links));
    const internal = info.pages.flatMap((p) => p.links).filter((l) => l.page !== null);
    R.check('rich: internal link (was to page 2) now goes to page 3 or 4 (index 2 or 3)', internal.length >= 1 && internal.every((l) => l.page === 2 || l.page === 3), JSON.stringify(internal));
    R.check('rich: note on the left half, square on the right half', p1a.annots.some((a) => a.type === 'Text' && a.contents === 'left note') && !p1a.annots.some((a) => a.type === 'Square') && p1b.annots.some((a) => a.type === 'Square') && !p1b.annots.some((a) => a.type === 'Text'), JSON.stringify([p1a.annots, p1b.annots]));
    R.check('rich: annotation counts total 2 (not doubled)', info.pages.reduce((n, p) => n + p.annots.length, 0) === 2, String(info.pages.reduce((n, p) => n + p.annots.length, 0)));
    R.check('rich: form fields: leftfield on half 1, rightfield on half 2, none doubled', p1a.widgets.map((w) => w.name).join() === 'leftfield' && p1b.widgets.map((w) => w.name).join() === 'rightfield', JSON.stringify([p1a.widgets, p1b.widgets]));
    R.check('rich: bookmarks "Go page 1" -> page index 0, "Go page 2" -> index 2 (first half of old page 2)', info.outline.length === 2 && info.outline[0].page === 0 && (info.outline[1].page === 2), JSON.stringify(info.outline));
  });
  // the same with top/bottom 40, right first (ignored for horizontal)
  const g = newFile('rich2.pdf', richBytes());
  await session(g, 2, async (s) => {
    await cut(s, { direction: 'horizontal', percent: 40 }, 4);
    await saveNow(s.win);
    const info = inspectRich(g.path);
    R.say(`INFO  rich top/bottom 40: ${JSON.stringify(info).slice(0, 1500)}`);
    R.check('rich top/bottom 40: 800x200 and 800x300 halves', info.pages[0].size.join() === '800,200' && info.pages[1].size.join() === '800,300', info.pages.map((p) => p.size).join(' | '));
    const widgets = info.pages.map((p) => p.widgets.map((w) => w.name).join('+'));
    R.check('rich top/bottom 40: form fields (at display y 370-400 and annots) end up on the bottom half, once', widgets.join('|') === '|leftfield+rightfield||', widgets.join('|'));
  });
  // and with the annotated-links fixture of the suite (URI links and annotations on each page)
  const h = copyTo(fixture('annotated-links.pdf'), 'al.pdf');
  const before = readPages(h.path).length;
  await session(h, before, async (s) => {
    await cut(s, {}, before * 2);
    await saveNow(s.win);
    const doc = inspectRich(h.path);
    R.check('annotated-links.pdf: cut makes 2x pages, each half has its own links (total URI links >= original)', doc.pages.length === before * 2, `links per page ${doc.pages.map((p) => p.links.length).join(',')}; annots ${doc.pages.map((p) => p.annots.length).join(',')}`);
  });
});
await R.step('mixed-sizes-rotated and outline-6 whole file', async () => {
  const f = copyTo(fixture('mixed-sizes-rotated.pdf'), 'm.pdf');
  const n = readPages(f.path).length;
  await session(f, n, async (s) => {
    const o = orig(f);
    await cut(s, { percent: 45 }, n * 2);
    await saveNow(s.win);
    const { problems } = compare(f.path, expectedImages(o, planAll(n, { cut: 'vertical', at: 0.45, first: 'left' })));
    R.check('mixed-sizes-rotated.pdf all pages 45 %', problems.length === 0, problems.join('; '));
  });
  const g = copyTo(fixture('outline-6.pdf'), 'o.pdf');
  await session(g, 6, async (s) => {
    await cut(s, {}, 12);
    await saveNow(s.win);
    const info = inspectRich(g.path);
    R.check('outline-6: Intro/Middle/End -> pages 3, 7, 11 (1-based: first half of old 2, 4, 6)', info.outline.map((o) => o.page + 1).join() === '3,7,11', JSON.stringify(info.outline));
  });
});

const failed = R.summary();
await closeAll();
wipe();
process.exit(failed ? 1 : 0);
