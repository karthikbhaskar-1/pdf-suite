// Shared helpers for the 1.2.1 organizer, save/recovery, stress and menu matrix. Not a test file (no .e2e suffix).
// Everything goes through the real UI of the packaged app via helpers.mjs. Files are copied into a temp folder first.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { statusText, waitFor, fixture } from './helpers.mjs';
import { coverage } from './scan-coverage.mjs';

export { fixture, statusText, waitFor, launch, closeAll, forceKill, cleanupProfile, newProfileDir, placeWindow, testOrigin, ROOT } from './helpers.mjs';

/** A fresh copy of a fixture (by file name in tests/fixtures/out, or an absolute path) in its own temp folder. */
export function copyOf(name) {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-matrix-'));
  const path = join(dir, name.split(/[\\/]/).pop());
  copyFileSync(/^[A-Za-z]:|^\//.test(name) ? name : fixture(name), path);
  return { dir, path };
}

export function removeCopy(copy) {
  rmSync(copy.dir, { recursive: true, force: true });
}

/** Page count from the status bar ("Page 1 of 8"), or -1. */
export async function pageCount(win) {
  const match = /of (\d+)/.exec(await statusText(win));
  return match ? Number(match[1]) : -1;
}

/** Current page number from the status bar. */
export async function currentPage(win) {
  const match = /Page (\d+) of/.exec(await statusText(win));
  return match ? Number(match[1]) : -1;
}

/** Timing of the last uids() scan: the longest wait, in ms, for the rows of a scroll step to be drawn. */
export const lastScan = { maxLateMs: 0, steps: 0 };

/**
 * The uids of all pages in list order (the thumbnail list draws only the rows near the view, so it is scrolled).
 * At each step the scan waits (up to 2 s) until the drawn rows cover the visible range, judged from the rows' real tops and
 * heights and the list's scrollHeight (see scan-coverage.mjs): rows of any height, and lists shorter than the viewport.
 * Late rows are helper timing and are waited for. Rows still missing after 2 s fail with "APP: thumbnail rows not rendered".
 */
export async function uids(win) {
  const out = await win.evaluate(async ({ coverageSource }) => {
    const coverage = new Function(`return ${coverageSource}`)();
    const list = document.querySelector('.thumb-list');
    if (!list) return { ids: [], tops: [], maxLateMs: 0, steps: 0 };
    const seen = new Map();
    let maxLateMs = 0;
    let steps = 0;
    const drawn = () =>
      [...list.querySelectorAll('.thumb')]
        .map((el) => ({ top: Number.parseFloat(el.style.top), height: el.offsetHeight, uid: el.dataset.uid }))
        .sort((x, y) => x.top - y.top);
    // The rows' coordinate space is the .thumb-sheet, whose height is the real content height. list.scrollHeight is never
    // below clientHeight, so for a list shorter than the viewport it would claim empty space after the last row.
    const contentHeight = () => list.querySelector('.thumb-sheet')?.offsetHeight ?? list.scrollHeight;
    const step = Math.max(120, list.clientHeight / 2);
    const maxScroll = Math.max(0, contentHeight() - list.clientHeight);
    const positions = [];
    for (let y = 0; y < maxScroll; y += step) positions.push(y);
    positions.push(maxScroll);
    for (const y of positions) {
      list.scrollTop = y;
      const start = performance.now();
      const from = list.scrollTop;
      const view = { from, to: Math.min(from + list.clientHeight, contentHeight()), scrollHeight: contentHeight() };
      let rows = drawn();
      let result = coverage(rows, view);
      while (!result.covered) {
        if (performance.now() - start > 2000) {
          const rendered = rows.map((r) => r.uid);
          throw new Error(
            `APP: thumbnail rows not rendered after 2000 ms: scrollTop ${from}, visible ${view.from}..${view.to}, content height ${view.scrollHeight}, list scrollHeight ${list.scrollHeight}, clientHeight ${list.clientHeight}, missing ranges ${JSON.stringify(result.missing)}, rendered uids [${rendered.slice(0, 3)}..${rendered.slice(-3)}] (${rendered.length} rows, tops ${rows[0]?.top}..${rows.at(-1)?.top}, heights ${rows[0]?.height}..${rows.at(-1)?.height})`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
        rows = drawn();
        result = coverage(rows, { ...view, from: list.scrollTop, to: Math.min(list.scrollTop + list.clientHeight, contentHeight()), scrollHeight: contentHeight() });
      }
      maxLateMs = Math.max(maxLateMs, performance.now() - start);
      steps++;
      for (const r of rows) seen.set(r.top, r.uid);
    }
    list.scrollTop = 0;
    const entries = [...seen.entries()].sort((a, b) => a[0] - b[0]);
    return { ids: entries.map((entry) => entry[1]), tops: entries.map((entry) => entry[0]), maxLateMs, steps, scrollHeight: contentHeight() };
  }, { coverageSource: coverage.toString() });
  lastScan.maxLateMs = out.maxLateMs;
  lastScan.steps = out.steps;
  lastScan.tops = out.tops;
  lastScan.scrollHeight = out.scrollHeight;
  return out.ids;
}

export async function waitForCount(win, count, label = `${count} pages`) {
  await waitFor(async () => (await pageCount(win)) === count && (await uids(win)).length === count, { timeoutMs: 30000, label });
}

/** Shows a rail panel (Thumbnails, Properties, Bookmarks) if it is not already open. */
export async function showPanel(win, name) {
  const button = win.getByRole('button', { name, exact: true }).first();
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
}

/** Opens a file through Ctrl+O and the stubbed Open dialog, then waits for its first page and the thumbnails. */
export async function open(s, path, pages) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  await waitFor(async () => (await statusText(s.win)).startsWith(`Page 1 of ${pages}`), { timeoutMs: 30000, label: `Page 1 of ${pages}` });
  await showPanel(s.win, 'Thumbnails');
  await s.win.locator('.thumb').first().waitFor({ timeout: 20000 });
}

/** Runs a command through the palette (Ctrl+K), by its exact label. Returns when the palette has closed. */
export async function palette(win, label) {
  await win.keyboard.press('Control+k');
  const dialog = win.getByRole('dialog', { name: 'Command palette' });
  await dialog.waitFor({ timeout: 5000 });
  const input = dialog.getByPlaceholder('Type a command');
  await input.fill(label);
  // Enter runs the top result, so wait until the list shows the command before pressing it.
  await waitFor(async () => (await dialog.getByRole('option').first().innerText().catch(() => '')).includes(label), {
    timeoutMs: 5000,
    label: `palette lists "${label}"`,
  });
  await input.press('Enter');
  await waitFor(async () => (await win.getByRole('dialog', { name: 'Command palette' }).count()) === 0, { timeoutMs: 5000, label: 'palette closed' });
}

/** Makes thumbnail `index` the current page by a plain click. */
export async function jumpTo(win, index) {
  await clickRowByIndex(win, index);
  await waitFor(async () => (await win.locator('.thumb-current').count()) === 1, { timeoutMs: 10000, label: 'current page' });
}

/** Page size from Properties ("Size" row of the Current page section), in points. */
export async function currentPageSize(win) {
  await showPanel(win, 'Properties');
  const handle = await win.waitForFunction(
    () => {
      const row = [...document.querySelectorAll('.props-row')].find((r) => r.innerText.trim().split('\n')[0].trim() === 'Size');
      return row ? row.innerText : null;
    },
    undefined,
    { timeout: 10000 },
  );
  const match = /([\d.]+) × ([\d.]+) pt/.exec(await handle.jsonValue());
  assert.ok(match, 'a size is shown in Properties');
  await showPanel(win, 'Thumbnails');
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Pixel statistics of the rendered page canvas: the share of dark pixels in the whole page, and in four 5% corner
 * squares. Used for grid-line visibility and for "no content clipped at a corner".
 */
export async function canvasStats(win) {
  // The canvas of the CURRENT page: the first .page-canvas in the DOM can belong to another page.
  const index = (await currentPage(win)) - 1;
  return win.evaluate((pageIndex) => {
    const canvas = document.querySelector(`.page[data-page-index="${pageIndex}"] .page-canvas`);
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const { width: w, height: h } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const dark = (x, y) => {
      const i = (y * w + x) * 4;
      return data[i] + data[i + 1] + data[i + 2] < 750;
    };
    // The page frame (a few pixels at each edge) is not content, so the share is taken inside a 4 px inset.
    const inset = 4;
    let darkCount = 0;
    for (let y = inset; y < h - inset; y++) for (let x = inset; x < w - inset; x++) if (dark(x, y)) darkCount++;
    const cw = Math.floor(w * 0.05);
    const ch = Math.floor(h * 0.05);
    const corner = (x0, y0) => {
      let n = 0;
      for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) if (dark(x, y)) n++;
      return n;
    };
    return {
      width: w,
      height: h,
      darkShare: darkCount / ((w - 2 * inset) * (h - 2 * inset)),
      corners: [corner(0, 0), corner(w - cw, 0), corner(0, h - ch), corner(w - cw, h - ch)],
    };
  }, index);
}

/** Reads every CropBox value in a PDF file on disk, as arrays of numbers (point values in file order). */
export function cropBoxesOnDisk(path) {
  const text = readFileSync(path).toString('latin1');
  return [...text.matchAll(/\/CropBox\s*\[\s*([-\d.\s]+?)\s*\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}

/** Page count of a file on disk, from page objects (same method as organizer.e2e.mjs). */
export function pagesOnDisk(path) {
  const text = readFileSync(path).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/** Ctrl+S on the active document. Saves in place; no Save dialog is shown for a file that already has a path. */
export async function saveNow(win) {
  await win.keyboard.press('Control+s');
  await waitFor(async () => (await win.locator('.tab-dirty').count()) === 0, { timeoutMs: 20000, label: 'the unsaved dot to clear' });
}

/** The active tab's dirty dot. */
export async function isDirty(win) {
  return (await win.locator('.tab-dirty').count()) > 0;
}

/** Asserts that no console or page error was recorded (favicon noise excluded). */
export function assertNoErrors(s) {
  assert.deepEqual(s.errors.filter((e) => !/favicon/.test(e)), []);
}

/**
 * assertNoErrors for a test that force-kills the app and relaunches it on the same profile. Chromium prints "Could not open the
 * quota database, resetting." when it starts after an unclean exit: that is Chromium's own recovery from the kill, not an app
 * error, so exactly that line is ignored here and nothing else. (If it ever coincided with a lost session snapshot, that would
 * be a real failure: each of these tests asserts that the restored tab and its recovery come back after the relaunch.)
 */
export function assertNoErrorsAfterKill(s) {
  assert.deepEqual(
    s.errors.filter((e) => !/favicon/.test(e) && !/quota_database\.cc.*Could not open the quota database, resetting/.test(e)),
    [],
  );
}

/** Stubs the native Save dialog so the next call returns `filePath`. */
export async function setSaveAnswer(s, filePath) {
  await s.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, filePath);
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrolls the thumbnail list in steps until the row with `uid` is drawn (rows are drawn only near the view), then clicks
 * it. `modifiers` is passed to the click, e.g. ['Shift'].
 */
export async function clickRowByIndex(win, index, modifiers = []) {
  const uid = (await uids(win))[index];
  assert.ok(uid !== undefined, `row ${index} exists`);
  // The scan above recorded each row's real top. Scroll to where the row must be and wait up to 2 s for it to be drawn.
  const found = await win.evaluate(async ({ target, at }) => {
    const list = document.querySelector('.thumb-list');
    list.scrollTop = Math.max(0, at - list.clientHeight / 2);
    const start = performance.now();
    while (!list.querySelector(`.thumb[data-uid="${target}"]`) && performance.now() - start < 2000) await new Promise((r) => setTimeout(r, 20));
    return list.querySelector(`.thumb[data-uid="${target}"]`) !== null;
  }, { target: uid, at: lastScan.tops[index] ?? 0 });
  assert.ok(found, `APP: thumbnail rows not rendered: row ${index} (uid ${uid}) is not drawn after scrolling the whole list`);
  await win.locator(`.thumb[data-uid="${uid}"]`).click({ modifiers });
  return uid;
}

/** Selects every page: a click on the first row and a Shift-click on the last. */
export async function selectAllPages(win) {
  const n = (await uids(win)).length;
  await clickRowByIndex(win, 0);
  if (n > 1) await clickRowByIndex(win, n - 1, ['Shift']);
}
/** Waits until the current thumbnail is a newly added page (uid starting with "n"). */
export async function waitForNewCurrent(win) {
  await waitFor(async () => ((await win.locator('.thumb-current').getAttribute('data-uid').catch(() => '')) ?? '').startsWith('n'), {
    timeoutMs: 10000,
    label: 'current page is an inserted page',
  });
}
