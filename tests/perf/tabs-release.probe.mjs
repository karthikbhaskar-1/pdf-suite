// L7 follow-up (1.5.4): background tabs release memory. Tab + GPU private MB with 10 and 20 open documents, with and without the release,
// then a switch back to every tab (page and zoom kept, page drawn) with the time each takes.
//   node tests/perf/tabs-release.probe.mjs [count=20] [out.json]      (through the queue: --files tests/perf/tabs-release.probe.mjs)
// Phase "before": the release is switched off (idle time 1e9), <count> copies of the 15-page arXiv paper are opened one after another; each gets
//   its own page and zoom. Tab + GPU private MB (median of 3 readings) at 10 and at <count> tabs. Then every tab is shown once (the switch time).
// Phase "after": a new app, the real idle time (60 s). 10 documents are opened, the probe waits 75 s (the sweep runs every 10 s), and measures; then
//   the rest are opened, waits 75 s again and measures. Then every tab is shown once: status must equal the one set at open (page and zoom), the page
//   must be drawn, and the time from the click to the painted page is recorded; the Tab + GPU figure after all tabs were shown again is recorded too.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchTracked, CORPUS, engineState, waitPainted } from '../signoff2/lib.mjs';
import { closeAll, cleanupProfile, placeWindow, statusText, waitFor, rendererMemoryMB } from '../e2e/helpers.mjs';
import { copyOf, removeCopy, delay } from '../e2e/matrix-lib.mjs';

const count = Number(process.argv[2] ?? 20);
const outJson = process.argv[3];
const src = join(CORPUS, 'arxiv-attention', '1706.03762.pdf');
const copies = Array.from({ length: count }, () => copyOf(src));
const rows = [];
const hook = (s, call, arg) => s.win.evaluate(({ call, arg }) => window.__pdfSuiteResidency[call](arg), { call, arg });

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function readMemory(s, label, docs) {
  await delay(2500);
  const tabGpu = [];
  const total = [];
  for (let i = 0; i < 3; i++) {
    const m = await rendererMemoryMB(s);
    tabGpu.push(m.privateMB);
    total.push((await s.metrics()).reduce((t, r) => t + (r.privateKB ?? 0) / 1024, 0));
    if (i < 2) await delay(1000);
  }
  const eng = await engineState(s.win);
  const row = { label, docs, tabGpuPrivateMB: Math.round(median(tabGpu)), tabGpuReadings: tabGpu.map(Math.round), totalPrivateMB: Math.round(median(total)), mupdfWorkersLive: eng.mupdfWorkersLive, released: (await hook(s, 'released')).length };
  rows.push(row);
  console.log(JSON.stringify(row));
  return row;
}

async function openDoc(s, i) {
  await s.setDialogAnswer([copies[i].path]);
  await s.win.keyboard.press('Control+o');
  await waitFor(async () => /^Page 1 of \d+/.test(await statusText(s.win)) && (await s.win.locator('[role="tab"]').count()) >= i + 1, { timeoutMs: 120000, label: `tab ${i + 1}` });
  await s.win.locator('.page-canvas').first().waitFor({ state: 'attached', timeout: 60000 });
  await delay(800);
  // Its own page and zoom, so a tab that comes back can be told from every other.
  const page = 2 + (i % 13);
  const box = s.win.getByLabel('Page number');
  await box.click();
  await box.fill(String(page));
  await box.press('Enter');
  for (let k = 0; k < i % 3; k++) await s.win.keyboard.press('Control+=');
  await waitFor(async () => (await statusText(s.win)).startsWith(`Page ${page} of`), { timeoutMs: 20000, label: `page ${page}` });
  await delay(400);
  return { page, status: await statusText(s.win) };
}

/** Shows every tab once, in order. Returns the checks and the time (ms) from the click to the painted page. */
async function revisit(s, expected, label) {
  const result = [];
  for (let i = 0; i < expected.length; i++) {
    const releasedBefore = (await hook(s, 'released')).length;
    const t0 = Date.now();
    await s.win.getByRole('tab').nth(i).click();
    let same = false;
    let painted = false;
    try {
      await waitFor(async () => (await statusText(s.win)) === expected[i].status, { timeoutMs: 30000, label: `tab ${i + 1} status` });
      same = true;
      const p = await waitPainted(s.win, expected[i].page - 1, 30000);
      painted = p.value.ink > 0.001;
    } catch (error) {
      console.log(`  tab ${i + 1}: ${String(error?.message ?? error).slice(0, 160)}; status now ${JSON.stringify(await statusText(s.win))}, wanted ${JSON.stringify(expected[i].status)}`);
    }
    const ms = Date.now() - t0;
    const releasedAfter = (await hook(s, 'released')).length;
    const resume = await hook(s, 'lastResume');
    result.push({ tab: i + 1, ms, sameStatus: same, painted, reopened: releasedAfter < releasedBefore, reopenMs: releasedAfter < releasedBefore ? (resume?.ms ?? null) : null, changed: releasedAfter < releasedBefore ? resume?.changed : null });
    await delay(300);
  }
  const wrong = result.filter((r) => !r.sameStatus || !r.painted);
  const times = result.map((r) => r.ms);
  const woke = result.filter((r) => r.reopened && r.reopenMs !== null);
  const row = { label, tabs: result.length, wrong: wrong.length, switchMsMedian: median(times), switchMsMax: Math.max(...times), reopened: result.filter((r) => r.reopened).length, reopenMsMedian: woke.length ? median(woke.map((r) => r.reopenMs)) : null, reopenMsMax: woke.length ? Math.max(...woke.map((r) => r.reopenMs)) : null, changed: result.filter((r) => r.changed).length, byTab: result.map((r) => `${r.tab}:${r.ms}${r.sameStatus && r.painted ? '' : '!'}`).join(' ') };
  rows.push(row);
  console.log(JSON.stringify(row));
}

async function phase(name, run) {
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await placeWindow(s, { width: 1400, height: 900 });
    await run(s);
    const errs = s.errors.filter((e) => !/favicon/.test(e));
    rows.push({ label: `${name}: errors`, errors: errs.slice(0, 5) });
  } catch (error) {
    rows.push({ label: `${name}: failed`, failed: String(error?.stack ?? error).slice(0, 600) });
    console.log(rows.at(-1).failed);
  } finally {
    await s.close().catch(() => undefined);
    cleanupProfile(s.profile);
  }
}

try {
  const half = Math.min(10, count);
  await phase('before', async (s) => {
    await hook(s, 'setIdleMs', 1e9); // the release is off
    await readMemory(s, 'before: baseline (no document)', 0);
    const expected = [];
    for (let i = 0; i < count; i++) {
      expected.push(await openDoc(s, i));
      if (i + 1 === half || i + 1 === count) await readMemory(s, `before: ${i + 1} tabs open`, i + 1);
    }
    await revisit(s, expected, 'before: every tab shown once (all workers live)');
  });
  await phase('after', async (s) => {
    // The idle time is the real one (60 s); the sweep runs by itself every 10 s.
    await readMemory(s, 'after: baseline (no document)', 0);
    const expected = [];
    for (let i = 0; i < count; i++) {
      expected.push(await openDoc(s, i));
      if (i + 1 === half || i + 1 === count) {
        await delay(75_000);
        await readMemory(s, `after: ${i + 1} tabs open, 75 s later`, i + 1);
      }
    }
    await revisit(s, expected, 'after: every tab shown once (released tabs reopen)');
    await readMemory(s, 'after: every tab shown again, 3 s later', count);
  });
} finally {
  copies.forEach(removeCopy);
  await closeAll();
  if (outJson) {
    mkdirSync(join(outJson, '..'), { recursive: true });
    writeFileSync(outJson, JSON.stringify({ count, rows }, null, 2));
  }
}
const failed = rows.filter((r) => r.failed || (r.wrong ?? 0) > 0);
if (failed.length) process.exitCode = 1;
