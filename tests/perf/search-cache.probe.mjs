// L5 (1.5.3): JS heap and text bytes after a full search of a text-dense 1,000-page file (about 3,000 characters a page).
//   node tests/perf/make-limit-fixtures.mjs dense 1000      (writes %TEMP%\pdfsuite-limits\dense-1000p.pdf)
//   node tests/perf/search-cache.probe.mjs [pdf] [out.json]  (take the machine lock first)
// Measures, before and after each search: renderer JS heap used (CDP Runtime.getHeapUsage after two forced GCs), Tab and total
// private MB, and the engine's own text cache estimate (textCacheBytes, the A26 copy capped at 16 MB). The search controller's copy
// (B6, no cap) is the JS-heap growth beyond that. Searches: a word that is not in the file (every page is read), a common word
// (every page has hits), then the same common word again (cache already warm).
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, closeAll, cleanupProfile, placeWindow, statusText, waitFor, rendererMemoryMB } from '../e2e/helpers.mjs';
import { copyOf, removeCopy, delay } from '../e2e/matrix-lib.mjs';

const src = process.argv[2] ?? join(tmpdir(), 'pdfsuite-limits', 'dense-1000p.pdf');
const outJson = process.argv[3];
const copy = copyOf(src);
const s = await launch();
const cdp = await s.app.context().newCDPSession(s.win);
const mb = (b) => (b == null ? null : +(b / 1048576).toFixed(1));
const rows = [];
async function snap(label) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  await delay(1000);
  const heap = await cdp.send('Runtime.getHeapUsage');
  const eng = await s.win.evaluate(() => window.__pdfSuiteEngine.memory());
  const m = await rendererMemoryMB(s);
  const row = { label, jsHeapUsedMB: mb(heap.usedSize), jsHeapTotalMB: mb(heap.totalSize), perfMemoryUsedMB: mb(eng.jsHeapBytes), engineTextCacheMB: mb(eng.textCacheBytes), wasmMB: eng.wasmHeapBytes.map((b) => Math.round(b / 1048576)), tabMB: m.byType.Tab, totalTabGpuMB: Math.round(m.privateMB) };
  rows.push(row);
  console.log(JSON.stringify(row));
}
async function search(query) {
  await s.win.keyboard.press('Control+f');
  const box = s.win.getByLabel('Find in document');
  await box.fill('');
  await delay(400);
  const t0 = performance.now();
  await box.fill(query);
  await delay(450); // past the 150 ms typing pause, so 'No matches' is not the state before the scan starts
  const { value } = await waitFor(async () => {
    const t = (await s.win.locator('.search-status').innerText()).trim();
    return /^(No matches|\d+ of \d+)$/.test(t) ? t : null;
  }, { timeoutMs: 120000, label: 'search done' });
  const ms = Math.round(performance.now() - t0);
  console.log(`search "${query}": ${value} in ${ms} ms`);
  return { query, status: value, ms };
}
const searches = [];
try {
  await s.win.waitForSelector('.empty-state');
  await placeWindow(s, { width: 1400, height: 900 });
  await s.setDialogAnswer([copy.path]);
  await s.win.keyboard.press('Control+o');
  await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 1000'), { timeoutMs: 60000, label: 'open' });
  await delay(3000);
  await snap('after open');
  searches.push(await search('qqzzxxkk'));
  await snap('after full search with no hits');
  searches.push(await search('ren'));
  await snap('after search for a common word');
  searches.push(await search('ren'));
  await snap('after the same search again');
  await s.win.keyboard.press('Escape');
  await delay(1500);
  await snap('after closing the find bar');
} catch (error) {
  rows.push({ failed: String(error?.stack ?? error).slice(0, 500) });
} finally {
  await cdp.detach().catch(() => undefined);
  await s.close().catch(() => undefined);
  cleanupProfile(s.profile);
  removeCopy(copy);
  await closeAll();
  const out = { file: src, searches, rows, errors: s.errors.filter((e) => !/favicon/.test(e)).slice(0, 5) };
  console.log(JSON.stringify(out));
  if (outJson) writeFileSync(outJson, JSON.stringify(out, null, 2));
}
