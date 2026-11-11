// 1,000-page stress through the UI: select and delete 500 pages, move 50, rotate all, resize all with progress and a
// Cancel part-way (must roll back fully), then undo everything. Timings and renderer+GPU memory are printed (private bytes < 720 MB; working set logged).
// Selection on a 1,000-page list uses the thumbnail rows that exist after a scroll, so it is slower than a human's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { launch, closeAll, copyOf, removeCopy, open, palette, uids, waitForCount, pageCount, currentPageSize, canvasStats, assertNoErrors, waitFor, delay, clickRowByIndex, selectAllPages } from './matrix-lib.mjs';
import { rendererMemoryMB } from './helpers.mjs';

after(closeAll);

const BIG = 'big-1000.pdf';

/** Scrolls the thumbnail list so that the row with uid `index` is drawn, then returns true when it is. */
async function scrollToUid(win, index) {
  return win.evaluate(async (target) => {
    const list = document.querySelector('.thumb-list');
    const rows = [...list.querySelectorAll('.thumb')];
    const rowH = rows.length > 1 ? Number.parseFloat(rows[1].style.top) - Number.parseFloat(rows[0].style.top) : 120;
    list.scrollTop = Math.max(0, target * rowH - list.clientHeight / 2);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 40));
      if (list.querySelector(`.thumb[data-uid="${target}"]`)) return true;
    }
    return false;
  }, index);
}

/** Shift-clicks the row `index` (after scrolling to it) to extend the selection from the first selected row. */
async function shiftClickUid(win, index) {
  await scrollToUid(win, index);
  await win.locator(`.thumb[data-uid="${index}"]`).click({ modifiers: ['Shift'] });
}

/**
 * Hard limit for an edit to be visible on screen: from the command to the page list drawn with the new order. Measured
 * with a cheap check of the first or last drawn row (no full-list scan), so the time is the app's, not the test's.
 */
const VISIBLE_LIMIT_MS = 1000;

/** The uid of the first (or last) page row drawn, after scrolling to that end. Null when no row is drawn yet. */
async function edgeUid(win, end) {
  return win.evaluate(async (which) => {
    const list = document.querySelector('.thumb-list');
    if (!list) return null;
    list.scrollTop = which === 'last' ? list.scrollHeight : 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rows = [...list.querySelectorAll('.thumb')];
    if (rows.length === 0) return null;
    const top = (el) => Number.parseFloat(el.style.top);
    const edge = rows.reduce((a, b) => ((which === 'last' ? top(b) > top(a) : top(b) < top(a)) ? b : a));
    return edge.dataset.uid ?? null;
  }, end);
}

/** Private + working-set text for one reading, for the logs. */
const fmt = (m) => `private ${Math.round(m.privateMB)} / ws ${Math.round(m.workingSetMB)} MB`;
const round = (m) => ({ private: Math.round(m.privateMB), ws: Math.round(m.workingSetMB) });

/**
 * State snapshot for diagnosing an undo that does not land: page count, the Edit menu's Undo/Redo labels (the menu is
 * opened and closed again), the last toast and document.activeElement. Never throws.
 */
async function diagnostics(s, label) {
  const info = {};
  try { info.pageCount = await pageCount(s.win); } catch (e) { info.pageCount = `error ${e.message}`; }
  try {
    info.page = await s.win.evaluate(() => ({
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent?.trim()),
      dialogs: [...document.querySelectorAll('[role="dialog"], .side-sheet')].map((d) => d.getAttribute('aria-label') ?? d.className),
      active: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className).slice(0, 60)}[${document.activeElement.getAttribute('aria-label') ?? ''}]` : null,
    }));
    info.lastToast = info.page.toasts.at(-1) ?? null;
  } catch (e) { info.page = `error ${e.message}`; }
  try {
    const ids = await uids(s.win);
    const nums = ids.map(Number).filter((n) => !Number.isNaN(n));
    const gaps = [];
    for (let i = 1; i < nums.length && gaps.length < 8; i++) if (nums[i] !== nums[i - 1] + 1) gaps.push(`${nums[i - 1]}->${nums[i]}`);
    info.scan = { rows: ids.length, first: ids.slice(0, 3), last: ids.slice(-3), gaps, listScrollHeight: await s.win.evaluate(() => document.querySelector('.thumb-list')?.scrollHeight) };
  } catch (e) { info.scan = `error ${e.message}`; }
  try {
    await s.win.getByRole('menuitem', { name: 'Edit', exact: true }).first().click({ timeout: 3000 });
    info.editMenu = await s.win.locator('.menu-dropdown[aria-label="Edit"] [role="menuitem"]').evaluateAll((els) => els.map((e) => e.textContent?.trim()).filter((t) => /^(Undo|Redo)/.test(t ?? '')));
    await s.win.keyboard.press('Escape');
  } catch (e) { info.editMenu = `error ${e.message}`; }
  console.log(`diagnostics ${label}: ${JSON.stringify(info)}`);
  return info;
}

/** Puts the focus in the document so Ctrl+Z reaches the app's key handler (it ignores INPUT, SELECT and TEXTAREA targets). */
async function focusDocument(s) {
  await s.win.keyboard.press('Escape'); // closes an open menu or sheet, if any
  await delay(150);
  const info = await s.win.evaluate(() => {
    const before = document.activeElement?.tagName ?? null;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && r.width > 0 && r.height > 0;
    };
    const open = [...document.querySelectorAll('[role="dialog"], .side-sheet, [role="menu"]')].filter(visible).length;
    return { before, after: document.activeElement?.tagName ?? null, openOverlays: open };
  });
  assert.equal(info.openOverlays, 0, `no dialog, sheet or menu is open before Ctrl+Z: ${JSON.stringify(info)}`);
  assert.ok(info.after === 'BODY', `focus is in the document, not a control, before Ctrl+Z: ${JSON.stringify(info)}`);
}

/** Where the memory is: per process type (MB) and the renderer's own report (bitmaps, text cache, JS heap, WASM heaps). */
async function memoryDetail(s) {
  const types = {};
  for (const r of await s.metrics()) types[r.type] = (types[r.type] ?? 0) + Math.round(r.memKB / 1024);
  const eng = await s.win.evaluate(() => window.__pdfSuiteEngine?.memory?.()).catch(() => null);
  const mb = (b) => (b == null ? null : Math.round(b / 1048576));
  return JSON.stringify({ types, bitmaps: eng && { pg: eng.bitmaps.pageCount, pgMB: mb(eng.bitmaps.pageBytes), th: eng.bitmaps.thumbCount, thMB: mb(eng.bitmaps.thumbBytes) }, textMB: eng && mb(eng.textCacheBytes), jsMB: eng && mb(eng.jsHeapBytes), wasmMB: eng && eng.wasmHeapBytes.map(mb) });
}

/**
 * Test-only memory trace (PDFSUITE_TRACE_MEM=<output path>): one detailed Chromium memory-infra dump through a CDP session
 * of the test, written as JSON to the path. The app and its preload have no trace code. Summary:
 * node tests/perf/mem-trace-summary.mjs <path>.
 */
async function traceMemory(s, outPath, label) {
  if (!outPath) return;
  const file = outPath.replace(/(\.json)?$/, `-${label}.json`);
  const cdp = await s.app.context().newCDPSession(s.win);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  try {
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } },
    });
    await cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed', deterministic: false });
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    writeFileSync(file, JSON.stringify({ traceEvents: events }));
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

test('1,000 pages: delete 500 selected, move 50, rotate all, resize all, cancel the resize, undo everything', async () => {
  const copy = copyOf(BIG);
  const s = await launch();
  const timings = {};
  const memory = {};
  const t0 = Date.now();
  try {
    await s.win.waitForSelector('.empty-state');
    const openStart = Date.now();
    await open(s, copy.path, 1000);
    timings.open = Date.now() - openStart;
    memory.afterOpen = await rendererMemoryMB(s);
    console.log(`memory afterOpen: ${fmt(memory.afterOpen)}`);

    // Delete 500: pages 1 to 500 (uids 0 to 499). Exactly half is not "more than half", so no inline confirm is asked.
    await clickRowByIndex(s.win, 0);
    const selStart = Date.now();
    // Shift-click the last page of the range, so the range covers uids 0..499.
    await shiftClickUid(s.win, 499);
    timings.select500 = Date.now() - selStart;
    // Only the drawn rows carry the class, so the check is that the selection reached the rows near 499.
    assert.ok((await s.win.locator('.thumb-selected').count()) > 0, 'the selection range is drawn');
    const delStart = performance.now();
    await palette(s.win, 'Pages: Delete');
    // Visible on screen: the count is 500 and the first drawn row is original page 501 (uid 500).
    await waitFor(async () => (await pageCount(s.win)) === 500 && (await edgeUid(s.win, 'first')) === '500', {
      timeoutMs: 30000,
      label: '500 pages drawn after the delete',
    });
    timings.delete500 = Math.round(performance.now() - delStart);
    assert.ok(timings.delete500 <= VISIBLE_LIMIT_MS, `a 500-page delete is visible within ${VISIBLE_LIMIT_MS} ms (took ${timings.delete500} ms)`);
    // The whole list, checked once after the timed step (scrolling through 500 rows is slow in the test, not the app).
    await waitForCount(s.win, 500, '500 pages after the delete');
    assert.equal((await uids(s.win))[0], '500', 'the first remaining page is original page 501');

    // Move 50: select the first 50 remaining pages, then move them to the end.
    // After the delete the list is the original pages 501 onwards, so positions are used, not the original uids.
    await clickRowByIndex(s.win, 0);
    await clickRowByIndex(s.win, 49, ['Shift']);
    const moveStart = performance.now();
    await palette(s.win, 'Pages: Move to the end');
    // Visible on screen: the last drawn row is uid 549, the last of the 50 moved pages (uids 500 to 549 after the delete).
    await waitFor(async () => (await edgeUid(s.win, 'last')) === '549', { timeoutMs: 30000, label: 'moved block drawn at the end' });
    timings.move50 = Math.round(performance.now() - moveStart);
    assert.ok(timings.move50 <= VISIBLE_LIMIT_MS, `a 50-page move is visible within ${VISIBLE_LIMIT_MS} ms (took ${timings.move50} ms)`);
    await waitFor(async () => (await uids(s.win)).slice(-1)[0] === '549', { timeoutMs: 120000, label: 'moved block at the end' });

    // Rotate all: select all pages and rotate right.
    await selectAllPages(s.win);
    const rotStart = Date.now();
    await palette(s.win, 'Pages: Rotate right 90°');
    await s.win.locator('.toast', { hasText: 'Rotated' }).first().waitFor({ timeout: 120000 });
    timings.rotateAll = Date.now() - rotStart;
    await waitFor(async () => (await currentPageSize(s.win)).width > 790, { timeoutMs: 60000, label: 'rotated page is landscape' });

    // Resize all with progress, then Cancel part-way: the document must come back to its state before the resize.
    const beforeResize = await currentPageSize(s.win);
    await selectAllPages(s.win);
    await palette(s.win, 'Pages: Set page size…');
    const dialog = s.win.getByRole('dialog', { name: 'Page size' });
    await dialog.waitFor();
    await dialog.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: 'A4' }).click();
    await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    const cancel = s.win.getByRole('button', { name: 'Cancel', exact: true }).last();
    await waitFor(async () => (await cancel.count()) > 0 && (await s.win.locator('progress, [role="progressbar"]').count()) > 0, {
      timeoutMs: 60000,
      label: 'progress bar with Cancel',
    });
    await cancel.click();
    await waitFor(async () => (await s.win.locator('progress, [role="progressbar"]').count()) === 0, { timeoutMs: 60000, label: 'progress gone' });
    await delay(800);
    const afterCancel = await currentPageSize(s.win);
    assert.deepEqual(afterCancel, beforeResize, 'Cancel rolls the resize back: the page size is the same as before');
    assert.equal(await pageCount(s.win), 1000 - 500, 'the page count is unchanged by the cancelled resize');
    memory.afterEdits = await rendererMemoryMB(s);
    console.log(`memory afterEdits: ${fmt(memory.afterEdits)} byType(private) ${JSON.stringify(memory.afterEdits.byType)}`);
    console.log(`detail afterEdits: ${await memoryDetail(s)}`);
    await traceMemory(s, process.env.PDFSUITE_TRACE_MEM, 'afterEdits');

    // Undo everything: rotate, move, delete (three steps).
    await diagnostics(s, 'before undo');
    for (let i = 0; i < 3; i++) {
      await focusDocument(s);
      await s.win.keyboard.press('Control+z');
      await delay(1500);
      console.log(`detail undo${i + 1}: ${fmt(await rendererMemoryMB(s))}`);
    }
    console.log(`detail beforeCount: ${fmt(await rendererMemoryMB(s))}`);
    await waitForCount(s.win, 1000, '1000 pages after undo');
    console.log(`detail afterCount: ${fmt(await rendererMemoryMB(s))}`);
    assert.equal((await uids(s.win))[0], '0', 'the first page is original page 1 again');
    const back = await currentPageSize(s.win);
    assert.deepEqual(back, { width: 612, height: 792 }, 'page 1 is Letter portrait again');

    // Blank check on a few visible pages: a page of text is never blank.
    await s.win.locator('.thumb').first().click();
    await delay(400);
    const stats = await canvasStats(s.win);
    assert.ok(stats && stats.darkShare > 0, 'page 1 renders with content, not a blank');

    memory.end = await rendererMemoryMB(s);
    console.log(`detail end: ${await memoryDetail(s)}`);
    await traceMemory(s, process.env.PDFSUITE_TRACE_MEM, 'end');
    timings.total = Date.now() - t0;
    await delay(5000);
    memory.settled = await rendererMemoryMB(s);
    console.log(`stress timings (ms): ${JSON.stringify(timings)}`);
    console.log(`stress Tab+GPU memory (MB, private = gate, ws = logged): ${JSON.stringify({ afterOpen: round(memory.afterOpen), afterEdits: round(memory.afterEdits), end: round(memory.end), settled: round(memory.settled) })} (settled = 5 s after the end, logged only)`);
    assert.ok(memory.afterEdits.privateMB < 720 && memory.end.privateMB < 720, `Tab+GPU private bytes under 720 MB: ${fmt(memory.afterEdits)} / ${fmt(memory.end)}`);
    assertNoErrors(s);
  } catch (error) {
    await diagnostics(s, 'on failure').catch(() => undefined);
    throw error;
  } finally {
    await s.close();
    removeCopy(copy);
  }
});
