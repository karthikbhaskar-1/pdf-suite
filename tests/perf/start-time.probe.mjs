// Z2 (1.5.4): start time of the portable exe and of the installed layout, from launch to window and to first page, N cold starts each.
//   node tests/perf/start-time.probe.mjs <runs> <label=exe> [<label=exe> ...] [--out=file.json]       (take the machine lock first)
//   e.g. node tests/perf/start-time.probe.mjs 10 portable=release/PDF-Suite-Portable-0.1.0-x64.exe installed=release/win-unpacked/PDF\ Suite.exe
// "installed" is the win-unpacked folder: an NSIS install lays down exactly these files; the installer itself is not run, because it
// registers file associations in the user's registry. Each run uses a new profile and opens the arXiv PDF from the command line, in test mode
// (PDFSUITE_E2E=1: no focus steal, no Recent list). Runs alternate between the exes to spread machine drift. "Cold" means a new
// process and profile; the OS file cache is warm after the first run of an exe (it cannot be flushed without administrator rights).
// Marks (ms from spawn): target = the window's page target exists; shell = the app UI is drawn (status bar present); page = status "Page 1 of N"
// and the first page canvas painted. For the portable exe, child = creation time of the self-extracted "PDF Suite.exe" in %TEMP%, so
// child (minus the exe's own start) is the extraction time.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// With no arguments (the test queue runs it that way): 10 starts of release/PDF-Suite-Portable-<version>-x64.exe and of the unzipped
// portable zip in release/zip-test/ (unzip "PDF-Suite-Portable-<version>-x64.zip" there first).
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const rawArgs = process.argv.slice(2);
const defaultExe = (() => { try { return readdirSync(join(ROOT, 'release')).find((n) => /^PDF-Suite-Portable-.*\.exe$/.test(n)); } catch { return undefined; } })();
const args = rawArgs.length ? rawArgs : ['10', `portable=${join(ROOT, 'release', defaultExe ?? 'missing.exe')}`, `zip=${join(ROOT, 'release', 'zip-test', 'PDF Suite.exe')}`];
const runs = Number(args[0]);
const outArg = args.find((a) => a.startsWith('--out='))?.slice(6);
const targets = args.slice(1).filter((a) => !a.startsWith('--')).map((a) => { const i = a.indexOf('='); return { label: a.slice(0, i), exe: resolve(a.slice(i + 1)) }; });
const PDF = join(ROOT, 'tests/engine/corpus/arxiv-attention/1706.03762.pdf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function cdpEval(ws, expression) {
  return new Promise((resolveEval) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); resolveEval(m.result?.result?.value); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

async function oneRun({ label, exe }, index) {
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-start-'));
  const port = 9470 + (index % 20);
  const wall0 = Date.now();
  const t0 = performance.now();
  const child = spawn(exe, [PDF, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, PDFSUITE_E2E: '1' } });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const marks = {};
  let ws = null;
  try {
    for (;;) {
      if (performance.now() - t0 > 60000) throw new Error('timeout 60 s');
      if (!ws) {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
        const page = list?.find((t) => t.type === 'page' && t.url.startsWith('app://'));
        if (page) {
          marks.target = performance.now() - t0;
          ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        } else { await sleep(8); continue; }
      }
      const st = await cdpEval(ws, `(() => { const bar = document.querySelector('.status-bar, footer'); const c = document.querySelector('canvas.page-canvas'); return { shell: !!bar, painted: !!c && c.width !== 300, box: document.querySelector('#status-page-box')?.value ?? '', of: document.querySelector('.status-of')?.textContent ?? '' }; })()`);
      if (st?.shell && marks.shell === undefined) marks.shell = performance.now() - t0;
      if (st?.shell && st.painted && st.box === '1' && /of \d+/.test(st.of)) { marks.page = performance.now() - t0; break; }
      await sleep(15);
    }
    // creation time of each "PDF Suite.exe" process, to split extraction from the app's own start
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='PDF Suite.exe' or Name like 'PDF-Suite-Portable%'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.ExecutablePath }"], { encoding: 'utf8', timeout: 20000 });
      const rows = out.split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).map(([pid, ms, path]) => ({ pid, ms: Number(ms) - wall0, path }));
      const mine = rows.filter((r) => r.ms >= -50);
      marks.procStartsMs = mine.map((r) => ({ at: r.ms, exe: r.path.includes('pdfsuite') || r.path.toLowerCase().includes('\\temp\\') ? 'extracted-or-app' : 'launcher' })).slice(0, 4);
      const extracted = mine.filter((r) => /\\temp\\|\\appdata\\local\\temp/i.test(r.path)).sort((a, b) => a.ms - b.ms)[0];
      if (extracted) marks.child = extracted.ms;
    } catch (e) { marks.procError = String(e.message).slice(0, 80); }
  } catch (error) {
    marks.error = String(error.message ?? error).slice(0, 120);
  } finally {
    try { await cdpEval(ws, 'window.close()'); } catch { /* ignore */ }
    for (let i = 0; i < 80 && !exited; i++) await sleep(250);
    if (!exited) await new Promise((done) => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', done));
    try { ws?.close(); } catch { /* ignore */ }
    await sleep(1500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { label, run: Math.floor(index / targets.length) + 1, ...Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])) };
}

const before = new Set(readdirSync(tmpdir()));
const results = [];
let i = 0;
for (let r = 0; r < runs; r++) {
  for (const t of targets) {
    const row = await oneRun(t, i++);
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
const summary = {};
for (const t of targets) {
  const rows = results.filter((x) => x.label === t.label && !x.error);
  const stat = (k) => { const v = rows.map((x) => x[k]).filter((x) => typeof x === 'number'); return v.length ? { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length } : null; };
  summary[t.label] = { target: stat('target'), shell: stat('shell'), page: stat('page'), child: stat('child'), failed: results.filter((x) => x.label === t.label && x.error).length };
}
console.log(JSON.stringify(summary, null, 2));
const leftover = readdirSync(tmpdir()).filter((n) => !before.has(n) && /pdfsuite|PDF Suite|^[0-9a-f]{8}-/i.test(n));
console.log('new temp entries left behind:', JSON.stringify(leftover));
if (outArg) writeFileSync(outArg, JSON.stringify({ runs, results, summary, leftover }, null, 2));
