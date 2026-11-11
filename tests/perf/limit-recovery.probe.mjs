// L2 re-pointed (1.5.10): Insert from a source AT the edit limit and just over it, then force-kill and recover.
//   node tests/perf/limit-recovery.probe.mjs [outJson]
// Run it through the queue (exclusive). Fixtures (about 500 MB each) are generated into %TEMP% one at a time and deleted at the end.
//
// The edit limit is 500 MB (MAX_EDIT_BYTES). An Insert/Replace/Overlay source is refused when it is over the limit alone, or when the
// document's saved size plus the source's size is over it. So "at the limit" is a source of exactly (500 MB - the document's size):
// the estimate is then exactly 500 MB and the stash (the recovery copy of the source, MAX_RECOVERY_BYTES = 500 MB) is accepted.
//   1. a source of 500 MB + 1 byte:                 refused alone, with the message (nothing read)
//   2. a source of (500 MB - document) + 1 byte:    refused by the estimate, with the message (nothing read)
//   3. a source of (500 MB - document) bytes:       accepted: attached, stashed in the recovery folder, inserted
//   4. force-kill with the edit unsaved, relaunch on the same profile: "Recovered unsaved edits", Keep, the inserted page is back
// Measured: time of each step, size of the recovery folder, private bytes at the peak, WASM heap.
import { mkdtempSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, closeAll, cleanupProfile, forceKill, statusText, waitFor, placeWindow } from '../e2e/helpers.mjs';
import { palette, showPanel, open } from '../e2e/matrix-lib.mjs';
import { makeLargeFile, removeLargeFile } from '../lib/makeLargeFile.mjs';

const outJson = process.argv[2];
const MB = 1024 * 1024;
const LIMIT = 500 * MB;
const BASE_BYTES = 60_000;
const work = mkdtempSync(join(tmpdir(), 'pdfsuite-l2-1510-'));
const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-l2-profile-'));
const res = { limitBytes: LIMIT, steps: {}, notes: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const free = () => {
  const fs = statfsSync(work);
  return Math.floor((fs.bavail * fs.bsize) / MB);
};
if (free() < 6 * 1024) throw new Error(`not enough free disk (${free()} MB) for the fixtures and the recovery copy`);

function folderBytes(dir) {
  let total = 0;
  try {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      total += name.isDirectory() ? folderBytes(p) : statSync(p).size;
    }
  } catch {
    // The folder may not exist yet.
  }
  return total;
}

const base = makeLargeFile({ path: join(work, 'base.pdf'), bytes: BASE_BYTES, pages: 3, word: 'basedoc' });
const sheet = (win) => win.getByRole('dialog', { name: 'Insert from a PDF' });
const step = async (name, fn) => {
  const t0 = performance.now();
  try {
    res.steps[name] = { ...(await fn()), ms: Math.round(performance.now() - t0) };
  } catch (error) {
    res.steps[name] = { failed: String(error?.message ?? error).slice(0, 400), ms: Math.round(performance.now() - t0) };
  }
  console.log(name, JSON.stringify(res.steps[name]));
};

/** The wasm heap peak and the private bytes of every process, sampled while `fn` runs. */
async function sampled(s, fn) {
  let running = true;
  const peak = { privateMB: 0, wasmMB: 0 };
  const loop = (async () => {
    while (running) {
      try {
        const rows = await s.metrics();
        peak.privateMB = Math.max(peak.privateMB, rows.reduce((t, r) => t + (r.privateKB ?? 0) / 1024, 0));
        const heaps = await s.win.evaluate(async () => (await window.__pdfSuiteEngine?.wasmHeapBytes?.()) ?? null).catch(() => null);
        if (heaps) peak.wasmMB = Math.max(peak.wasmMB, ...heaps.map((b) => b / MB));
      } catch {
        // The app may be gone.
      }
      await sleep(400);
    }
  })();
  try {
    return { value: await fn(), peak };
  } finally {
    running = false;
    await loop;
    peak.privateMB = Math.round(peak.privateMB);
    peak.wasmMB = Math.round(peak.wasmMB);
  }
}

async function openInsertSheet(s) {
  await palette(s.win, 'Pages: Insert pages from a PDF…');
  const dialog = sheet(s.win);
  await dialog.waitFor({ timeout: 10000 });
  return dialog;
}

/** Browse for `path` in the open Insert sheet. Resolves with the toast text (a refusal) or "N pages" (accepted). */
async function browse(s, dialog, path) {
  // Only a toast that was not there before this browse counts (an earlier refusal may still be showing).
  const seen = new Set(await s.win.locator('.toast').allInnerTexts());
  await s.setDialogAnswer([path]);
  await dialog.getByRole('button', { name: 'Browse for a PDF…' }).click();
  const outcome = await waitFor(
    async () => {
      for (const raw of await s.win.locator('.toast').allInnerTexts()) {
        const toast = raw.replace(/\s+/g, ' ').trim();
        if (!seen.has(raw) && /too large to add|past 500 MB/.test(toast)) return { kind: 'refused', text: toast };
      }
      // The sources have 2 pages (the document has 3), so "2 pages" in the sheet is the attached source.
      if (await dialog.getByText(/2 pages/).count()) return { kind: 'attached' };
      return null;
    },
    { timeoutMs: 240000, intervalMs: 100, label: 'the source to be refused or attached' },
  );
  return outcome.value;
}

async function dismissToasts(win) {
  for (const close of await win.locator('.toast .job-notice-close').all()) await close.click().catch(() => undefined);
}

let s;
try {
  s = await launch({ profile });
  await s.win.waitForSelector('.empty-state');
  await placeWindow(s, { width: 1400, height: 900 });
  await open(s, base.path, 3);

  // 1. just over the limit alone
  let dialog = await openInsertSheet(s);
  await step('1 source 500 MB + 1 byte', async () => {
    const f = makeLargeFile({ path: join(work, 'over.pdf'), bytes: LIMIT + 1, pages: 2, word: 'over' });
    try {
      const outcome = await browse(s, dialog, f.path);
      return { sourceBytes: f.bytes, ...outcome };
    } finally {
      removeLargeFile(f);
    }
  });
  await dismissToasts(s.win);

  // 2. just over by the estimate (the document is 60 KB)
  await step('2 source (500 MB - document) + 1 byte', async () => {
    const f = makeLargeFile({ path: join(work, 'estimate.pdf'), bytes: LIMIT - base.bytes + 1, pages: 2, word: 'estimate' });
    try {
      const outcome = await browse(s, dialog, f.path);
      return { sourceBytes: f.bytes, documentBytes: base.bytes, ...outcome };
    } finally {
      removeLargeFile(f);
    }
  });
  await dismissToasts(s.win);

  // 3. at the limit: accepted, stashed, inserted
  const atLimit = makeLargeFile({ path: join(work, 'at-limit.pdf'), bytes: LIMIT - base.bytes, pages: 2, word: 'atlimit' });
  await step('3 source (500 MB - document) attach and stash', async () => {
    const { value, peak } = await sampled(s, async () => {
      const t0 = performance.now();
      const outcome = await browse(s, dialog, atLimit.path);
      const attachedMs = Math.round(performance.now() - t0);
      // The recovery copy is written with the attach: wait until it is complete on disk.
      const stashDone = await waitFor(() => folderBytes(join(profile, 'recovery')) >= atLimit.bytes, { timeoutMs: 120000, intervalMs: 200, label: 'the stash on disk' }).catch(() => null);
      return { ...outcome, sourceBytes: atLimit.bytes, attachedMs, stashMs: stashDone ? Math.round(performance.now() - t0) : null };
    });
    return { ...value, peakPrivateMB: peak.privateMB, peakWasmMB: peak.wasmMB, recoveryFolderBytes: folderBytes(join(profile, 'recovery')), recoveryFolderMB: Math.round(folderBytes(join(profile, 'recovery')) / MB) };
  });
  if (res.steps['3 source (500 MB - document) attach and stash'].kind === 'attached') {
    await step('3b apply: insert page 1 of the source after page 1', async () => {
      await dialog.getByRole('textbox', { name: 'Page range' }).fill('1');
      const t0 = performance.now();
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await waitFor(async () => /Page 1 of 4/.test(await statusText(s.win)), { timeoutMs: 120000, label: 'Page 1 of 4' });
      const bars = await s.win.locator('.doc-bar').allInnerTexts();
      // Let the log be written (it is written at once; this is the time the file takes to show on disk).
      await sleep(2500);
      return { insertMs: Math.round(performance.now() - t0), bars, recoveryFolderMB: Math.round(folderBytes(join(profile, 'recovery')) / MB) };
    });
    // 4. force-kill and recover
    await step('4 force-kill, relaunch, recover', async () => {
      await forceKill(s.app);
      const t0 = performance.now();
      s = await launch({ profile });
      const bar = s.win.getByText(/Recovered unsaved edits/);
      await bar.waitFor({ timeout: 240000 });
      const barMs = Math.round(performance.now() - t0);
      await showPanel(s.win, 'Thumbnails');
      await s.win.getByRole('button', { name: 'Keep', exact: true }).click();
      await waitFor(async () => /of 4/.test(await statusText(s.win)), { timeoutMs: 60000, label: 'Page n of 4 after Keep' });
      return { recoveredBarMs: barMs, pagesAfterKeep: (await statusText(s.win)).match(/of (\d+)/)?.[1], baseFileUnchanged: statSync(base.path).size === BASE_BYTES };
    });
  }
  res.errors = s.errors.filter((e) => !/favicon|quota_database/.test(e));
} catch (error) {
  res.fatal = String(error?.stack ?? error).slice(0, 800);
} finally {
  await s?.close().catch(() => undefined);
  await closeAll();
  cleanupProfile(profile);
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(res, null, 2));
if (outJson) writeFileSync(outJson, JSON.stringify(res, null, 2));
process.exit(res.fatal ? 1 : 0);
