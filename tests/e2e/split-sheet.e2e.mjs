// A side sheet narrows the panes. In a split view each pane must keep the page the user was on (and the page box must still say
// it), so that Cut Pages in Half and Overlay "Add" act on that page, not on the page the narrower pane happens to show at the
// old scroll offset (1.3.4 regression: 5 became 3, 6 or 1, 60 ms after the sheet appeared).
// Checked on a 6-page landscape file and on a 6-page file of mixed wide and tall pages (the slice fixture's shape), with scroll
// sync on and off, for every side sheet. Every test ends with its edits saved or dropped by the test-mode quit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mu from 'mupdf';
import { launch, closeAll, open, palette, waitFor, statusText, uids, currentPage, delay, saveNow, assertNoErrors, placeWindow } from './matrix-lib.mjs';

const FIXTURES = mkdtempSync(join(tmpdir(), 'pdfsuite-splitsheet-fx-'));
after(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  return closeAll();
});

function build(sizes) {
  const pdf = new mu.PDFDocument();
  sizes.forEach(([w, h], i) => {
    // A box in the top-right corner (its position differs per page) so the saved overlay can be found.
    pdf.insertPage(i, pdf.addPage([0, 0, w, h], 0, {}, `0 g ${w - 120 - i * 10} ${h - 80} 60 40 re f`));
  });
  const bytes = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
  pdf.destroy();
  return Buffer.from(bytes);
}

const FILES = {
  landscape: join(FIXTURES, 'landscape.pdf'),
  mixed: join(FIXTURES, 'mixed.pdf'),
};
writeFileSync(FILES.landscape, build(Array.from({ length: 6 }, () => [800, 500])));
writeFileSync(FILES.mixed, build([[800, 500], [800, 500], [500, 800], [800, 500], [500, 800], [600, 800]]));
const OVERLAY = join(FIXTURES, 'overlay.pdf');
writeFileSync(OVERLAY, build(Array.from({ length: 6 }, () => [800, 500])));

async function goToPage(win, n) {
  const box = win.locator('footer.status-bar').getByLabel('Go to page');
  await box.fill(String(n));
  await box.press('Enter');
  await waitFor(async () => (await currentPage(win)) === n, { timeoutMs: 10000, label: `page ${n} is current` });
}

/** Opens a sheet through the palette, and checks for half a second that the page box does not move. */
async function sheetKeepsPage(s, command, name, page) {
  await palette(s.win, command);
  const sheet = s.win.getByRole('dialog', { name });
  await sheet.waitFor({ timeout: 10000 });
  for (let i = 0; i < 6; i++) {
    await delay(100);
    assert.equal(await currentPage(s.win), page, `${name}: the page box still says ${page} ${(i + 1) * 100} ms after the sheet opened`);
  }
  return sheet;
}

const SHEETS = [
  ['Pages: Cut pages in half', 'Cut pages in half'],
  ['Pages: Overlay to compare', 'Overlay to compare'],
  ['Pages: Rotate by a custom angle…', 'Rotate pages'],
  ['Pages: Crop…', 'Crop pages'],
  ['Pages: Set page size…', 'Page size'],
  ['Pages: Insert blank page…', 'Insert pages'],
];

for (const kind of ['landscape', 'mixed']) {
  for (const sync of [true, false]) {
    test(`split view, ${kind} file, scroll sync ${sync ? 'on' : 'off'}: every side sheet keeps the page of the pane with the focus`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-splitsheet-'));
      const path = join(dir, 'doc.pdf');
      copyFileSync(FILES[kind], path);
      const s = await launch();
      try {
        await placeWindow(s, { width: 1300, height: 900 });
        await s.win.waitForSelector('.empty-state');
        await open(s, path, 6);
        await palette(s.win, 'Split vertical');
        await waitFor(async () => (await s.win.locator('.viewer').count()) === 2, { timeoutMs: 10000, label: 'two panes' });
        if (!sync) await palette(s.win, 'Sync scroll between panes');
        const panes = s.win.locator('.viewer');
        const focusPane = async (n) => {
          await panes.nth(n).click({ position: { x: 20, y: 20 } });
          await delay(400);
        };
        // Pane 1 on page 2, pane 2 on page 5, and the focus in pane 2.
        await focusPane(0);
        await goToPage(s.win, 2);
        await focusPane(1);
        await goToPage(s.win, 5);
        const peerBefore = await panes.nth(0).evaluate((el) => el.scrollTop);
        for (const [command, name] of SHEETS) {
          const sheet = await sheetKeepsPage(s, command, name, 5);
          await s.win.keyboard.press('Escape');
          await sheet.waitFor({ state: 'detached', timeout: 10000 });
          // Closing the sheet widens the panes again: the page is still the page the user was on.
          await delay(400);
          assert.equal(await currentPage(s.win), 5, `${name}: the page box says 5 after the sheet closed`);
          // The Overlay sheet starts a compare: leave it before the next one.
          if (name === 'Overlay to compare') assert.equal(await s.win.locator('[data-compare-bar]').count(), 0, 'Esc left the compare');
          // The page box follows the user again: scroll the pane to its top and the box says page 1, then go back to page 5.
          await panes.nth(1).evaluate((el) => {
            el.scrollTop = 0;
          });
          await waitFor(async () => (await currentPage(s.win)) === 1, { timeoutMs: 5000, label: `${name}: the page box follows a scroll after the sheet closed` });
          await goToPage(s.win, 5);
        }
        if (!sync) {
          // Without sync the other pane was not moved by any of it.
          assert.equal(await panes.nth(0).evaluate((el) => el.scrollTop), peerBefore, 'the other pane did not move');
        }

        // The page that Cut acts on is the page the box says.
        const sheet = await sheetKeepsPage(s, 'Pages: Cut pages in half', 'Cut pages in half', 5);
        await sheet.getByLabel('Apply to').selectOption('current');
        await delay(300);
        assert.equal(await currentPage(s.win), 5);
        await sheet.getByRole('button', { name: 'Apply' }).click();
        await sheet.waitFor({ state: 'detached', timeout: 20000 });
        await waitFor(async () => (await uids(s.win)).length === 7, { timeoutMs: 20000, label: '7 pages' });
        assert.equal((await uids(s.win)).findIndex((uid) => uid.startsWith('n')) - 1, 4, 'Cut cut page 5');
        await s.win.keyboard.press('Control+z');
        await waitFor(async () => (await uids(s.win)).length === 6, { timeoutMs: 10000, label: 'undone' });
        assert.equal(await currentPage(s.win), 5);

        // The page that Add overlay acts on is the page the box says: its overlay shows in the saved file on page 5 only.
        await s.setDialogAnswer([OVERLAY]);
        const compare = await sheetKeepsPage(s, 'Pages: Overlay to compare', 'Overlay to compare', 5);
        await compare.getByRole('button', { name: 'Choose a PDF…' }).click();
        await compare.locator('[data-compare-file]').getByText('overlay.pdf · 6 pages').waitFor({ timeout: 20000 });
        await delay(300);
        assert.equal(await currentPage(s.win), 5);
        await compare.getByRole('button', { name: 'Add overlay to pages' }).click();
        await s.win.locator('.toast', { hasText: 'Added the overlay to 1 page' }).waitFor({ timeout: 20000 });
        await saveNow(s.win);
        // Overlay page 5 (the same box as base page 5, drawn again) on page 5: page 5 now holds the overlay's own page-5 content.
        const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
        try {
          const text = (i) => {
            const page = doc.loadPage(i);
            const stext = page.toStructuredText('');
            const out = stext.asText();
            stext.destroy();
            return out;
          };
          assert.equal(doc.countPages(), 6);
          assert.ok(text(0) !== undefined);
          // The overlaid page has a Form XObject in its resources; the other pages do not.
          const pdf = doc.asPDF();
          const hasForm = (i) => {
            const res = pdf.findPage(i).getInheritable('Resources');
            const xo = res.isNull() ? null : res.get('XObject');
            return xo !== null && !xo.isNull() && xo.isDictionary();
          };
          const marked = [0, 1, 2, 3, 4, 5].filter(hasForm);
          assert.deepEqual(marked, [4], 'only page 5 got the overlay');
        } finally {
          doc.destroy();
        }
        assertNoErrors(s);
      } finally {
        await s.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
