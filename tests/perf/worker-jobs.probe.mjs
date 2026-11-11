// P6 (1.5.4): the longest worker job on record, and what the app does when a worker is stuck in a loop.
//   node tests/perf/worker-jobs.probe.mjs <out.json> [part=A|B|AB]       (take the machine lock first)
// Part A: turns on the app's own trace (window.__pdfSuiteDiag, test mode), then runs the heaviest jobs we have (big-1000 edits: delete 500,
//         rotate all, resize all to A4 and wait for it to finish, undo; 1,000 MB image and text files: open, delete, save) and lists the longest
//         `req.ok` / `req.fail` requests per op from the trace (client.ts logs op and ms for every worker request).
// Part B: a worker stuck in a loop. There is no hang hook in the product yet (the plan adds one after the 1.3 merges), so the worker's JS is
//         paused through the Chrome DevTools protocol (Debugger.pause on each worker target), which is a stuck loop as far as the page can tell.
//         It records what the viewer, an edit, a save and closing the tab do, and for how long.
import { statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, closeAll, cleanupProfile, placeWindow, statusText, waitFor } from '../e2e/helpers.mjs';
import { copyOf, removeCopy, palette, showPanel, delay, selectAllPages, pageCount, currentPageSize, waitForCount, open as openDoc } from '../e2e/matrix-lib.mjs';

const outJson = process.argv[2];
const part = process.argv[3] ?? 'AB';
const LIM = join(tmpdir(), 'pdfsuite-limits');
const result = { partA: null, partB: null };

async function enableDiag(s) {
  await s.win.evaluate(() => window.__pdfSuiteDiag?.enable());
}
async function jobRows(s) {
  const ev = (await s.win.evaluate(() => window.__pdfSuiteDiag?.events(0) ?? [])).filter((e) => e.name === 'req.ok' || e.name === 'req.fail');
  const byOp = {};
  for (const e of ev) {
    const o = (byOp[e.data.op] ??= { n: 0, maxMs: 0, ok: 0, fail: 0, slowest: [] });
    o.n++;
    e.name === 'req.ok' ? o.ok++ : o.fail++;
    o.maxMs = Math.max(o.maxMs, e.data.ms);
    o.slowest.push(e.data.ms);
  }
  for (const o of Object.values(byOp)) o.slowest = o.slowest.sort((a, b) => b - a).slice(0, 5);
  return byOp;
}

async function partA() {
  const runs = [];
  // big-1000 with heavy edits
  {
    const copy = copyOf('big-1000.pdf');
    const s = await launch();
    try {
      await s.win.waitForSelector('.empty-state');
      await placeWindow(s, { width: 1400, height: 900 });
      await enableDiag(s);
      await openDoc(s, copy.path, 1000);
      await selectAllPages(s.win);
      const t = performance.now();
      await palette(s.win, 'Pages: Rotate right 90°');
      await s.win.locator('.toast', { hasText: 'Rotated' }).first().waitFor({ timeout: 180000 });
      const rotateAllMs = Math.round(performance.now() - t);
      const t2 = performance.now();
      await palette(s.win, 'Pages: Set page size…');
      const dialog = s.win.getByRole('dialog', { name: 'Page size' });
      await dialog.waitFor();
      await dialog.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: 'A4' }).click();
      await dialog.getByRole('combobox', { name: 'Apply to' }).selectOption('all');
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await waitFor(async () => (await s.win.locator('progress, [role="progressbar"]').count()) > 0, { timeoutMs: 60000, label: 'progress shows' }).catch(() => undefined);
      await waitFor(async () => (await s.win.locator('progress, [role="progressbar"]').count()) === 0, { timeoutMs: 300000, label: 'resize finished' });
      const resizeAllMs = Math.round(performance.now() - t2);
      await s.win.keyboard.press('Control+s');
      await waitFor(async () => (await s.win.locator('.tab-dirty').count()) === 0, { timeoutMs: 120000, label: 'saved' });
      runs.push({ scenario: 'big-1000: rotate all, resize all to A4, save', rotateAllMs, resizeAllMs, ops: await jobRows(s) });
    } catch (e) {
      runs.push({ scenario: 'big-1000 heavy edits', failed: String(e.message).slice(0, 200), ops: await jobRows(s).catch(() => null) });
    } finally {
      await s.close().catch(() => undefined); cleanupProfile(s.profile); removeCopy(copy); await closeAll();
    }
  }
  for (const f of ['image-1000MB.pdf', 'text-1000MB.pdf', 'image-500MB.pdf']) {
    const copy = copyOf(join(LIM, f));
    const s = await launch();
    try {
      await s.win.waitForSelector('.empty-state');
      await placeWindow(s, { width: 1400, height: 900 });
      await enableDiag(s);
      await s.setDialogAnswer([copy.path]);
      await s.win.keyboard.press('Control+o');
      await waitFor(async () => /^Page 1 of \d+/.test(await statusText(s.win)), { timeoutMs: 240000, label: 'open' });
      await showPanel(s.win, 'Thumbnails');
      await s.win.locator('.thumb').first().waitFor({ timeout: 60000 });
      await s.win.locator('.thumb').first().click();
      await palette(s.win, 'Pages: Delete');
      await delay(1500);
      await s.win.keyboard.press('Control+s');
      await delay(20000);
      runs.push({ scenario: `${f}: open, delete page 1, save`, ops: await jobRows(s) });
    } catch (e) {
      runs.push({ scenario: f, failed: String(e.message).slice(0, 200), ops: await jobRows(s).catch(() => null) });
    } finally {
      await s.close().catch(() => undefined); cleanupProfile(s.profile); removeCopy(copy); await closeAll();
    }
  }
  const overall = {};
  for (const r of runs) for (const [op, o] of Object.entries(r.ops ?? {})) if (!overall[op] || o.maxMs > overall[op].maxMs) overall[op] = { maxMs: o.maxMs, in: r.scenario };
  return { runs, longestPerOp: Object.fromEntries(Object.entries(overall).sort((a, b) => b[1].maxMs - a[1].maxMs)) };
}

async function partB() {
  const copy = copyOf('big-1000.pdf');
  const s = await launch();
  const out = { observations: [] };
  const note = (k, v) => { out.observations.push({ k, ...v }); console.log('B', k, JSON.stringify(v)); };
  try {
    await s.win.waitForSelector('.empty-state');
    await placeWindow(s, { width: 1400, height: 900 });
    await openDoc(s, copy.path, 1000);
    await delay(1500);
    // Pause every worker through DevTools: browser-level session, then attach to each worker target.
    const browser = s.app.context().browser();
    const cdp = browser ? await browser.newBrowserCDPSession() : await s.app.context().newCDPSession(s.win);
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const workers = targets.filter((t) => t.type === 'worker' || t.type === 'service_worker');
    note('targets', { all: targets.map((t) => t.type), workers: workers.length });
    let paused = 0;
    for (const w of workers) {
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: w.targetId, flatten: false });
        const send = (id, method, params = {}) => cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
        await send(1, 'Debugger.enable');
        await send(2, 'Debugger.pause');
        paused++;
      } catch (e) { note('pause failed', { error: String(e.message).slice(0, 120) }); }
    }
    note('paused workers', { paused });
    await delay(1000);
    // 1) the viewer: jump far away, so pages need new renders.
    const box = s.win.getByLabel('Page number');
    const t1 = performance.now();
    await box.click(); await box.fill('700'); await box.press('Enter');
    await delay(15000);
    const placeholders = await s.win.evaluate(() => document.querySelectorAll('.viewer .page-placeholder').length);
    const status = await statusText(s.win);
    const uiAlive = await s.win.evaluate(() => new Promise((r) => { const t = performance.now(); requestAnimationFrame(() => r(Math.round(performance.now() - t))); }));
    note('viewer after jump, 15 s', { placeholdersVisible: placeholders, status, nextFrameMs: uiAlive, message: await s.win.locator('.tab-message').allInnerTexts() });
    // 2) an edit while stuck
    await showPanel(s.win, 'Thumbnails');
    const t2 = performance.now();
    await s.win.locator('.thumb').first().click().catch(() => undefined);
    await palette(s.win, 'Pages: Rotate right 90°').catch((e) => note('palette', { error: String(e.message).slice(0, 100) }));
    await delay(20000);
    note('edit while stuck, 20 s', { dirty: (await s.win.locator('.tab-dirty').count()) > 0, toasts: await s.win.locator('.toast').allInnerTexts(), progress: await s.win.locator('progress, [role="progressbar"]').count(), status: await statusText(s.win) });
    // 3) closing the tab
    const t3 = performance.now();
    await s.win.locator('.tab-close').first().click();
    const closed = await waitFor(async () => (await s.win.locator('.page-canvas').count()) === 0, { timeoutMs: 60000, label: 'tab closed' }).then(() => true).catch(() => false);
    note('close tab with a stuck worker', { closed, ms: Math.round(performance.now() - t3), prompt: await s.win.getByRole('dialog').allInnerTexts() });
    out.verdict = 'see observations';
  } catch (e) {
    out.failed = String(e.stack ?? e).slice(0, 500);
  } finally {
    await s.close().catch(() => undefined); cleanupProfile(s.profile); removeCopy(copy); await closeAll();
  }
  return out;
}

if (part.includes('A')) { result.partA = await partA(); console.log(JSON.stringify(result.partA.longestPerOp)); }
if (part.includes('B')) result.partB = await partB();
if (outJson) writeFileSync(outJson, JSON.stringify(result, null, 2));
