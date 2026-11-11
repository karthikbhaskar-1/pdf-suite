// Child processes of the runner. Only processes the runner started (and what they started) are ever stopped:
// by process tree from the child's pid, or by the runner's own temp folder in the command line.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

/** Kills a process and everything it started. Used only with pids of the runner's own children. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/** Runs a PowerShell script without blocking the runner. Resolves the trimmed stdout ('' on failure). */
function powershell(script, env = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

/**
 * Stops processes whose command line contains `needle`: leftovers of one test file (its Electron profile is under the
 * file's own temp folder). Refuses a needle that is not inside `mustStartWith`, so it can never match something else.
 */
export async function killByCommandLine(needle, mustStartWith) {
  if (process.platform !== 'win32') return 0;
  if (!needle || !mustStartWith || !needle.toLowerCase().startsWith(mustStartWith.toLowerCase()) || needle.length <= mustStartWith.length) {
    throw new Error(`refusing to kill by command line: ${needle}`);
  }
  const out = await powershell(
    `$n = $env:TESTQ_NEEDLE; $c = 0; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and $_.CommandLine.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $c++ }; Write-Output $c`,
    { TESTQ_NEEDLE: needle },
  );
  return Number.parseInt(out, 10) || 0;
}

/**
 * True when a PDF Suite app process exists that does not belong to the runner (an agent's manual run, a dev copy).
 * App processes are recognised by their executable (PDF Suite.exe or electron.exe) and a path that contains `needle`;
 * the runner's own children are excluded through their temp folder.
 */
export async function foreignAppBusy(needle, ownTmpRoot) {
  if (process.platform !== 'win32') return false;
  const out = await powershell(
    `$n = $env:TESTQ_NEEDLE.ToLower(); $own = $env:TESTQ_OWN.ToLower(); $c = 0;
     Get-CimInstance Win32_Process -Filter "Name='PDF Suite.exe' OR Name='electron.exe'" | ForEach-Object {
       $line = (($_.CommandLine + ' ' + $_.ExecutablePath)).ToLower();
       if ($line.Contains($n) -and -not $line.Contains($own)) { $c++ } };
     Write-Output $c`,
    { TESTQ_NEEDLE: needle, TESTQ_OWN: ownTmpRoot },
  );
  return (Number.parseInt(out, 10) || 0) > 0;
}

/**
 * Starts a command with stdout and stderr appended to `logPath`. Returns { pid, done } where done resolves
 * { code, signal, error } once the process ended. The caller's `kill()` ends its tree.
 */
export function run({ command, args, cwd, env, logPath, shell = false }) {
  const fd = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', fd, fd], shell, detached: process.platform !== 'win32' });
  } finally {
    closeSync(fd);
  }
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error: String(error?.message ?? error) }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { pid: child.pid, done, kill: () => killTree(child.pid) };
}
