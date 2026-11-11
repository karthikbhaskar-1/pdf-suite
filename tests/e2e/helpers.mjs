// Shared driver for the Electron e2e tests. Launches the packaged app (release/win-unpacked) with an
// isolated profile, stubs the native file dialog, and records every console error and page error.
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..');
export const EXE = process.env.PDF_SUITE_EXE ?? join(ROOT, 'release', 'win-unpacked', 'PDF Suite.exe');
export const FIX = join(ROOT, 'tests', 'fixtures', 'out');
export const fixture = (name) => join(FIX, name);

/** Every app process launched by these helpers. afterAll in each file calls closeAll(). */
const live = new Set();

/**
 * Every profile this module has handed out or been given. They are removed by closeAll (the end of a test file,
 * which runs after a failure too) and, for anything left over, when the test process exits.
 */
const ownedProfiles = new Set();

export function newProfileDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-'));
  ownedProfiles.add(dir);
  return dir;
}

/**
 * Launches the app. Returns { app, win, errors, dialogPaths, profile, close, metrics }.
 * `errors` collects console errors and uncaught page errors from the main and renderer processes.
 */
export async function launch({ args = [], profile = newProfileDir(), env = {} } = {}) {
  ownedProfiles.add(profile);
  let app;
  try {
    app = await electron.launch({
      executablePath: EXE,
      args: [...args, `--user-data-dir=${profile}`],
      // Test mode: close and quit discard edits silently, and windows never take focus (see electron/main.ts).
      env: { ...process.env, PDFSUITE_E2E: '1', ...env },
      timeout: 60000,
    });
  } catch (error) {
    cleanupProfile(profile);
    throw error;
  }
  live.add(app);
  const errors = [];
  app.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[main] ${m.text()}`);
  });
  app.process().stderr?.on('data', (d) => {
    const text = String(d).trim();
    if (text) errors.push(`[stderr] ${text}`);
  });
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[renderer] ${m.text()}`);
  });
  win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await win.waitForLoadState('domcontentloaded');
  // Stub the native open dialog. The test sets the next answer with setDialogAnswer.
  await app.evaluate(({ dialog }) => {
    globalThis.__pdfSuiteDialogAnswer = [];
    dialog.showOpenDialog = async () => {
      const answer = globalThis.__pdfSuiteDialogAnswer.shift() ?? [];
      return { canceled: answer.length === 0, filePaths: answer };
    };
    // No Save dialog ever appears: a test that saves stubs it again with its own path.
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
  });
  // Closing the app keeps its profile: a test may relaunch with it, and the session lives there. The profile is
  // removed at teardown (closeAll, or the test's own cleanupProfile), never on each close.
  const close = async () => {
    live.delete(app);
    await app.close().catch(() => undefined);
  };
  return {
    app,
    win,
    errors,
    workarounds: [],
    profile,
    close,
    /** Makes the next Open dialog return these paths. */
    setDialogAnswer: (paths) =>
      app.evaluate((_electron, p) => {
        globalThis.__pdfSuiteDialogAnswer.push(p);
      }, paths),
    /** The renderer's own pid and the app's process metrics (memory per process, in KB). */
    metrics: () =>
      app.evaluate(({ app: a }) =>
        a.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, memKB: m.memory.workingSetSize, privateKB: m.memory.privateBytes ?? null, cpu: m.cpu.percentCPUUsage })),
      ),
  };
}

/**
 * Tab + GPU memory in MB. The gate metric is `privateMB` (Electron getAppMetrics memory.privateBytes, owner-approved
 * 2026-11-09); `workingSetMB` is logged beside it. `byType` is private MB per process type. Takes the object returned by launch().
 */
export async function rendererMemoryMB(s) {
  const rows = await s.metrics();
  const gated = rows.filter((r) => r.type === 'Tab' || r.type === 'GPU');
  if (gated.length === 0 || gated.some((r) => r.privateKB == null)) throw new Error('process metrics have no privateBytes for Tab/GPU');
  const byType = {};
  for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + Math.round((r.privateKB ?? 0) / 1024);
  return {
    privateMB: gated.reduce((sum, r) => sum + r.privateKB / 1024, 0),
    workingSetMB: gated.reduce((sum, r) => sum + r.memKB / 1024, 0),
    byType,
  };
}

/** Starts a second process with the given args and returns its exit code and stdout. Used for single-instance tests. */
export function runSecondInstance(args, profile) {
  return new Promise((resolveRun) => {
    const child = spawn(EXE, [...args, `--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveRun({ code, out });
    });
  });
}

/** Kills the process tree of the app (used to simulate a crash). Returns when the process has exited. */
export function forceKill(app) {
  const pid = app.process().pid;
  return new Promise((done) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', () => done());
  });
}

/** Waits until `fn` returns a truthy value, or throws after `timeoutMs`. Returns the value and the elapsed ms. */
export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 50, label = 'condition' } = {}) {
  const started = performance.now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = undefined;
    }
    if (value) return { value, ms: performance.now() - started };
    if (performance.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Reads the status bar as "Page 1 of 1000 · 100%". Since 1.2.2 the page number and the zoom are editable boxes, whose
 * values innerText does not include, so the text is put together from the boxes. While no file is open, or a long edit
 * shows its progress, the bar has no such boxes and its plain text is returned.
 */
export async function statusText(win) {
  return (
    await win
      .evaluate(() => {
        const bar = document.querySelector('.status-bar, footer');
        if (!bar) return '';
        const page = bar.querySelector('#status-page-box');
        const total = bar.querySelector('.status-of');
        const zoom = bar.querySelector('input[aria-label="Zoom level"]');
        if (page && total && zoom) return `Page ${page.value} ${total.textContent} · ${zoom.value}`;
        return bar.innerText;
      })
      .catch(() => '')
  ).trim();
}

/**
 * Waits for the status bar to show `statusPrefix`. No workaround: a freshly opened file must
 * become the active pane by itself, and the tests rely on that.
 */
export async function waitForPage(s, statusPrefix, { timeoutMs = 30000 } = {}) {
  const started = performance.now();
  for (;;) {
    const status = await statusText(s.win);
    if (status.startsWith(statusPrefix)) return performance.now() - started;
    if (performance.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for status "${statusPrefix}", last status "${status}"`);
    }
    await s.win.waitForTimeout(100);
  }
}

/** Waits for the viewer to show a rendered page or an inline error message. Returns the text of whichever came first. */
export async function waitForOutcome(s, { timeoutMs = 30000 } = {}) {
  const started = performance.now();
  for (;;) {
    // Errors are the .tab-message with role="alert". The loading line is role="status", so it is skipped.
    const message = s.win.locator('.tab-message[role="alert"]');
    if ((await message.count()) > 0) return { kind: 'message', text: (await message.first().innerText()).trim(), ms: performance.now() - started };
    if ((await s.win.locator('.page-canvas').count()) > 0) return { kind: 'page', ms: performance.now() - started };
    if (performance.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms with no page or message`);
    await s.win.waitForTimeout(100);
  }
}

/** Closes every app this module launched, then removes the profiles it owns. Call it in afterAll. */
export async function closeAll() {
  await Promise.all([...live].map((app) => app.close().catch(() => undefined)));
  live.clear();
  for (const dir of ownedProfiles) cleanupProfile(dir);
  ownedProfiles.clear();
}

// A profile left behind by a test that never reached its teardown (a crash, or a killed run) is removed at exit.
process.on('exit', () => {
  for (const dir of ownedProfiles) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing more can be done at exit.
    }
  }
});

export function cleanupProfile(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // The app may still hold a file open for a moment. A leftover temp folder is harmless.
  }
}

/**
 * The top-left point for a test window: 20 px inside the work area of the test display (the first non-primary monitor,
 * or the primary when there is only one or PDFSUITE_E2E_DISPLAY=primary).
 */
export async function testOrigin(s) {
  return s.app.evaluate(({ screen }) => {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const d = process.env.PDFSUITE_E2E_DISPLAY === 'primary' ? primary : (all.find((x) => x.id !== primary.id) ?? primary);
    return { x: d.workArea.x + 20, y: d.workArea.y + 20 };
  });
}

/** Moves and sizes the app window onto the test display. The size is the caller's; only the position is chosen here. Never raises or focuses the window. */
export async function placeWindow(s, { width, height }) {
  const { x, y } = await testOrigin(s);
  await s.app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), { x, y, width, height });
}
