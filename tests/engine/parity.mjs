// Engine parity (handoff item 3) and behavior checks (item 4), driven through the real app.
// Each file is opened in a fresh app with the engine override (localStorage pdfsuite.engine) set to mupdf or pdfjs.
// Captured per run: page count, outline (Bookmarks panel), metadata (Properties panel), page-1 text, page-1 screenshot.
// Which engine really opened the file is read from the Worker constructions during the open.
// Run: node tests/engine/parity.mjs [parity|behavior]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitFor, waitForOutcome, waitForPage, statusText, closeAll, cleanupProfile } from '../e2e/helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, 'corpus');
const DERIVED = join(CORPUS, 'derived');
const OUT = process.env.PARITY_OUT ?? join(process.env.SCRATCH ?? '.', 'parity');
mkdirSync(OUT, { recursive: true });
const mode = process.argv[2] ?? 'parity';

const TRACK_WORKERS = `(() => {
  const RealWorker = window.Worker;
  const log = (window.__workerLog = []);
  function TrackedWorker(url, options) {
    const worker = new RealWorker(url, options);
    const record = { url: String(url), live: true };
    log.push(record);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { record.live = false; terminate(); };
    return worker;
  }
  TrackedWorker.prototype = RealWorker.prototype;
  window.Worker = TrackedWorker;
})();`;

const PARITY_FILES = [
  { name: 'arxiv-attention', path: join(CORPUS, 'arxiv-attention', '1706.03762.pdf') },
  { name: 'irs-fw9', path: join(CORPUS, 'irs-fw9', 'fw9.pdf') },
  { name: 'scanned-gray', path: join(CORPUS, 'scanned-gray', 'perf_images_scan_gray.pdf') },
  { name: 'brochure-images', path: join(CORPUS, 'brochure-images', 'brochure.pdf') },
  { name: 'outlines', path: join(CORPUS, 'outlines', 'nested_outline.pdf') },
  { name: 'xfa', path: join(CORPUS, 'xfa', 'xfa_filled_imm1344e.pdf') },
];

async function openApp(engine) {
  const s = await launch();
  await s.win.addInitScript(TRACK_WORKERS);
  await s.win.reload();
  await s.win.waitForLoadState('domcontentloaded');
  await s.win.waitForSelector('.empty-state');
  if (engine) await s.win.evaluate((e) => localStorage.setItem('pdfsuite.engine', e), engine);
  return s;
}

const workerCount = (win) => win.evaluate(() => (window.__workerLog ?? []).length);
const mupdfWorkersSince = (win, from) =>
  win.evaluate((n) => (window.__workerLog ?? []).slice(n).filter((w) => !/pdf\.?worker|pdfjs/i.test(w.url)).length, from);

async function openPath(s, path) {
  const before = await workerCount(s.win);
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  const outcome = await waitForOutcome(s, { timeoutMs: 120000 });
  const mupdfSpawned = await mupdfWorkersSince(s.win, before);
  return { outcome, engineUsed: mupdfSpawned > 0 ? 'mupdf' : 'pdfjs' };
}

async function readPanel(s, title) {
  await s.win.getByLabel(title, { exact: true }).click();
  const panel = s.win.locator(`aside[aria-label="${title}"]`);
  await panel.waitFor({ timeout: 10000 }).catch(() => undefined);
  await s.win.waitForTimeout(400);
  const text = await panel.innerText().catch(() => '<panel not readable>');
  await s.win.getByRole('button', { name: `Close ${title}`, exact: true }).click().catch(() => undefined);
  await s.win.waitForTimeout(250);
  return text.trim();
}

async function captureFile(file, engine) {
  const s = await openApp(engine);
  try {
    const { outcome, engineUsed } = await openPath(s, file.path);
    const result = { engine: engine ?? 'default', engineUsed, outcome: outcome.kind, message: outcome.text ?? null };
    if (outcome.kind !== 'page') return result;
    await waitForPage(s, 'Page 1 of', { timeoutMs: 60000 }).catch(() => undefined);
    result.status = (await statusText(s.win)).slice(0, 60);
    result.pageCount = Number((result.status.match(/of (\d+)/) ?? [])[1] ?? NaN);
    await s.win.waitForTimeout(1500);
    result.page1Text = (await s.win.locator('.page[data-page-index="0"] .textLayer').innerText().catch(() => '')).trim();
    result.outline = await readPanel(s, 'Bookmarks');
    result.metadata = await readPanel(s, 'Properties');
    const canvas = s.win.locator('.page[data-page-index="0"] .page-canvas').first();
    await canvas.waitFor({ timeout: 30000 });
    const png = await canvas.screenshot();
    const pngPath = join(OUT, `${file.name}-${engine ?? 'default'}.png`);
    writeFileSync(pngPath, png);
    result.pngPath = pngPath;
    return result;
  } finally {
    await s.close();
  }
}

/** Renderer-side pixel diff of two PNG screenshots. Pixels differ when any channel moves by more than the tolerance. */
async function diffPngs(pathA, pathB) {
  const s = await openApp(null);
  try {
    const toUrl = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
    return await s.win.evaluate(async ([a, b]) => {
      const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
      const [A, B] = [await load(a), await load(b)];
      const sizes = [[A.width, A.height], [B.width, B.height]];
      const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height);
      const pixels = (img) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const pa = pixels(A), pb = pixels(B);
      let loose = 0, exact = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
        if (d > 16) loose++;
        if (d > 0) exact++;
      }
      const total = w * h;
      return { sizes, pctLoose: (loose / total) * 100, pctExact: (exact / total) * 100 };
    }, [toUrl(pathA), toUrl(pathB)]);
  } finally {
    await s.close();
  }
}

const norm = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const words = (t) => new Set(norm(t).split(' ').filter(Boolean));
function jaccard(a, b) {
  const A = words(a), B = words(b);
  if (A.size === 0 && B.size === 0) return 1;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size;
}

async function runParity() {
  const rows = [];
  for (const file of PARITY_FILES) {
    const m = await captureFile(file, 'mupdf');
    const p = await captureFile(file, 'pdfjs');
    const row = { file: file.name, mupdf: m, pdfjs: p };
    if (m.pngPath && p.pngPath) row.diff = await diffPngs(m.pngPath, p.pngPath);
    row.pageCountMatch = m.pageCount === p.pageCount;
    row.outlineMatch = m.outline === p.outline;
    row.metadataMatch = m.metadata === p.metadata;
    row.textExact = norm(m.page1Text ?? '') === norm(p.page1Text ?? '');
    row.textJaccard = jaccard(m.page1Text ?? '', p.page1Text ?? '');
    rows.push(row);
    console.log(JSON.stringify({ ...row, mupdf: { ...m, page1Text: undefined }, pdfjs: { ...p, page1Text: undefined } }));
  }
  // XFA file with no override: it should route to pdf.js and still show something.
  const xfa = await captureFile(PARITY_FILES.find((f) => f.name === 'xfa'), null);
  console.log('XFA default route: ' + JSON.stringify({ ...xfa, page1Text: undefined }));
  writeFileSync(join(OUT, 'parity.json'), JSON.stringify({ rows, xfa }, null, 2));
}

async function runBehavior() {
  const results = {};
  // Truncated and damaged files, default engine.
  for (const name of ['truncated-half.pdf', 'damaged-xref.pdf']) {
    const r = await captureFile({ name: name.replace('.pdf', ''), path: join(DERIVED, name) }, null);
    results[name] = { engineUsed: r.engineUsed, outcome: r.outcome, message: r.message, pageCount: r.pageCount ?? null };
    console.log(name, JSON.stringify(results[name]));
  }
  // AES-256 with a password: no password, wrong password, then right password.
  {
    const s = await openApp(null);
    try {
      await s.setDialogAnswer([join(DERIVED, 'aes256-locked.pdf')]);
      await s.win.keyboard.press('Control+o');
      const dlg = s.win.getByRole('dialog').filter({ has: s.win.getByLabel('Password', { exact: true }) });
      await dlg.waitFor({ timeout: 30000 });
      const err = async () => (await dlg.locator('[role="alert"]').count()) ? (await dlg.locator('[role="alert"]').innerText()).trim() : null;
      await dlg.getByLabel('Password', { exact: true }).fill('wrong-pw');
      await dlg.getByLabel('Password', { exact: true }).press('Enter');
      await waitFor(async () => (await err()) !== null, { timeoutMs: 20000, label: 'wrong password error' }).catch(() => undefined);
      const wrongMsg = await err();
      await dlg.getByLabel('Password', { exact: true }).fill('aes256pw');
      await dlg.getByLabel('Password', { exact: true }).press('Enter');
      const outcome = await waitForOutcome(s, { timeoutMs: 120000 });
      await waitForPage(s, 'Page 1 of', { timeoutMs: 60000 }).catch(() => undefined);
      results['aes256-locked.pdf'] = { wrongPasswordMessage: wrongMsg, correctPassword: outcome.kind, status: (await statusText(s.win)).slice(0, 40) };
      console.log('aes256', JSON.stringify(results['aes256-locked.pdf']));
    } finally {
      await s.close();
    }
  }
  // Letter-spaced text: search for "q w e r t" and "qwert" in the letter-spaced fixture.
  {
    const s = await openApp(null);
    try {
      const { outcome } = await openPath(s, join(DERIVED, 'letter-spaced.pdf'));
      await waitForPage(s, 'Page 1 of 2', { timeoutMs: 60000 }).catch(() => undefined);
      const hits = {};
      for (const q of ['q w e r t', 'qwert', 'qwerty', 'spaced']) {
        await s.win.keyboard.press('Control+f');
        const box = s.win.getByLabel('Find in document', { exact: true });
        await box.fill(q);
        await box.press('Enter');
        await s.win.waitForTimeout(1200);
        hits[q] = (await s.win.locator('.search-status').innerText().catch(() => '')).trim();
        await s.win.keyboard.press('Escape');
        await s.win.waitForTimeout(200);
      }
      results['letter-spaced.pdf'] = { outcome: outcome.kind, search: hits };
      console.log('letter-spaced', JSON.stringify(results['letter-spaced.pdf']));
    } finally {
      await s.close();
    }
  }
  writeFileSync(join(OUT, 'behavior.json'), JSON.stringify(results, null, 2));
}

try {
  if (mode === 'parity') await runParity();
  else await runBehavior();
} finally {
  await closeAll();
}
