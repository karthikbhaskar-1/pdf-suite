// Independent sign-off probe: the shipped portable exe (release/PDF-Suite-Portable-0.1.0-x64.exe) starts, opens a
// real-world PDF from the command line on MuPDF (WASM served from the packaged app), renders, searches, and routes an
// XFA form away from MuPDF. Closed by closing its window (graceful quit); the exe's own tree is killed only as a fallback.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT2, CORPUS, check, summary } from './lib.mjs';

const EXE = join(ROOT2, 'release', 'PDF-Suite-Portable-0.1.0-x64.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-signoff2-'));
const t0 = Date.now();
const child = spawn(EXE, [join(CORPUS, 'arxiv-attention', '1706.03762.pdf'), `--user-data-dir=${profile}`, '--remote-debugging-port=9461'], { stdio: 'ignore', env: { ...process.env, PDFSUITE_E2E: '1' } }); // test mode: the page exposes its diagnostics (window.__pdfSuiteTestMode)
let browser;
let exited = false;
child.on('exit', () => { exited = true; });
try {
  for (let i = 0; i < 120 && !browser; i++) {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9461').catch(() => undefined);
    if (!browser) await sleep(500);
  }
  if (!browser) throw new Error('could not connect over CDP');
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
    if (!page) await sleep(250);
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const status = () => page.locator('.status-bar').innerText().catch(() => '');
  for (let i = 0; i < 120; i++) { if ((await status()).startsWith('Page 1 of 15')) break; await sleep(250); }
  const startedMs = Date.now() - t0;
  let painted = null;
  for (let i = 0; i < 80 && !painted; i++) {
    painted = await page.evaluate(() => {
      const c = document.querySelector('.viewer .page[data-page-index="0"] canvas.page-canvas');
      if (!c || c.width === 300) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0;
      for (let k = 0; k < d.length; k += 16) if (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2] < 200) ink++;
      return { w: c.width, ink: Number((ink / (d.length / 16)).toFixed(4)) };
    });
    if (!painted) await sleep(250);
  }
  const heaps = await page.evaluate(async () => (await window.__pdfSuiteEngine?.wasmHeapBytes?.()) ?? null);
  check('portable exe starts and opens the arXiv PDF from the command line', (await status()).startsWith('Page 1 of 15'), { status: await status(), msFromSpawn: startedMs });
  check('portable exe renders it on MuPDF (one MuPDF document with a WASM heap) with real ink', heaps && heaps.length === 1 && heaps[0] > 0 && painted && painted.ink > 0.01, { heapsMB: heaps?.map((b) => Math.round(b / 1048576)), painted });
  await page.keyboard.press('Control+f');
  await page.getByLabel('Find in document').fill('attention');
  let st = '';
  for (let i = 0; i < 60; i++) { st = (await page.locator('.search-status').innerText()).trim(); if (/^\d+ of \d+$/.test(st)) break; await sleep(250); }
  check('portable exe search works ("attention")', /^\d+ of \d+$/.test(st) && Number(st.split(' of ')[1]) > 20, st);
  await page.screenshot({ path: join(ROOT2, 'tests', 'signoff2', 'portable-arxiv.png') });
  check('portable exe: no console/page errors', errors.length === 0, errors.slice(0, 5));
  // Graceful quit: close the window.
  await page.evaluate(() => window.close()).catch(() => undefined);
  for (let i = 0; i < 40 && !exited; i++) await sleep(250);
  check('portable exe quits when its window is closed', exited, { exited });
} catch (e) {
  check('portable probe ran', false, String(e.stack ?? e).slice(0, 600));
} finally {
  await browser?.close().catch(() => undefined);
  if (!exited) await new Promise((done) => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', done));
  await sleep(1500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exitCode = summary() ? 1 : 0;
}
