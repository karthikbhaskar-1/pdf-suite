// Reads what a finished file run left behind and builds the per-job result and the 10-line summary.
import { existsSync, readFileSync } from 'node:fs';

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const firstLines = (text, n = 4) => String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(0, n);
const tail = (p, n = 6) => readText(p).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n);

/** node --test with the queue reporter: one JSON line per test. */
function parseNodeTest(resultFile, logFile, exit) {
  const rows = readText(resultFile).split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const leaf = rows.filter((r) => r.type === 'test' && !r.skip && !r.todo);
  const failures = leaf.filter((r) => !r.ok).map((r) => ({ name: r.name, error: firstLines(r.error) }));
  const pass = leaf.filter((r) => r.ok).length;
  const skipped = rows.filter((r) => r.type === 'test' && (r.skip || r.todo)).length;
  if (exit.code !== 0 && failures.length === 0) {
    failures.push({ name: '(file did not finish cleanly)', error: [`exit code ${exit.code}${exit.signal ? ` signal ${exit.signal}` : ''}`, ...tail(logFile, 5)] });
  }
  return { pass, fail: failures.length, skipped, failures };
}

/** Probe scripts: PASS/FAIL lines when they print them, otherwise the exit code. */
function parseScript(logFile, exit) {
  const lines = readText(logFile).split(/\r?\n/);
  const passes = lines.filter((l) => /^PASS\b/.test(l)).length;
  const failLines = lines.filter((l) => /^(FAIL|FAILED:)\b/.test(l));
  const failures = failLines.slice(0, 20).map((l) => ({ name: l.slice(0, 160), error: [] }));
  if (exit.code !== 0 && failures.length === 0) {
    failures.push({ name: '(script failed)', error: [`exit code ${exit.code}${exit.signal ? ` signal ${exit.signal}` : ''}`, ...tail(logFile, 5)] });
  }
  return { pass: passes, fail: failures.length, skipped: 0, failures };
}

/** vitest --reporter=json output. */
function parseVitest(resultFile, logFile, exit) {
  let json = null;
  try {
    json = JSON.parse(readText(resultFile));
  } catch {
    // fall through to the exit code
  }
  if (!json) return parseScript(logFile, exit);
  const failures = [];
  for (const f of json.testResults ?? []) {
    for (const t of f.assertionResults ?? []) {
      if (t.status === 'failed') failures.push({ name: `${String(f.name).replace(/^.*[\/]tests?[\/]/, '')} > ${t.fullName ?? t.title}`, error: firstLines((t.failureMessages ?? []).join('\n')) });
    }
    if (f.status === 'failed' && !(f.assertionResults ?? []).some((t) => t.status === 'failed')) failures.push({ name: String(f.name), error: firstLines(f.message) });
  }
  return { pass: json.numPassedTests ?? 0, fail: Math.max(json.numFailedTests ?? 0, failures.length), skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0), failures };
}

export function parseFileResult({ runner, resultFile, logFile, exit, timedOut }) {
  const r = runner === 'vitest' ? parseVitest(resultFile, logFile, exit) : runner === 'script' ? parseScript(logFile, exit) : parseNodeTest(resultFile, logFile, exit);
  if (timedOut) r.failures.unshift({ name: '(timed out)', error: [`killed after the time limit`] });
  return { ...r, status: timedOut ? 'timeout' : r.fail > 0 || exit.code !== 0 ? 'failed' : 'passed' };
}

export function fmtDuration(sec) {
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** At most 10 lines. */
export function buildSummary(result, resultPath) {
  const L = [];
  const files = result.files;
  const count = (st) => files.filter((f) => f.status === st).length;
  const bad = files.filter((f) => f.status !== 'passed');
  L.push(`job ${result.id}  by ${result.who}  ${result.suite ? `suite ${result.suite}` : `${files.length} file(s)`}  worktree ${result.worktreeName}`);
  L.push(`RESULT ${result.ok ? 'PASS' : 'FAIL'}: ${count('passed')}/${files.length} files passed, ${count('failed')} failed, ${count('timeout')} timed out, ${count('skipped')} skipped; ${result.totals.pass} tests passed, ${result.totals.fail} failed; wall ${fmtDuration(result.wallSeconds)}`);
  const prep = result.prep;
  L.push(`prep: pack ${prep.pack === null ? 'not asked' : prep.pack.ok ? `ok ${fmtDuration(prep.pack.seconds)}` : 'FAILED (see ' + prep.pack.log + ')'}, fixtures ${prep.fixtures === null ? 'n/a' : prep.fixtures.ok ? 'ok' : 'FAILED'}`);
  const room = 10 - L.length - 1; // keep one line for the details path
  const shown = [];
  for (const f of bad) {
    if (shown.length >= room) break;
    const first = f.failures[0];
    shown.push(`  ${f.status.toUpperCase()} ${f.file}${f.fail > 1 ? ` (${f.fail} tests)` : ''}: ${first ? `${first.name}${first.error?.[0] ? ' - ' + first.error[0] : ''}` : f.note ?? ''}`.slice(0, 220));
  }
  if (bad.length > shown.length && shown.length) shown[shown.length - 1] = `  ... and ${bad.length - shown.length + 1} more failing files`;
  L.push(...shown);
  L.push(`details: ${resultPath}`);
  return `${L.slice(0, 10).join('\n')}\n`;
}
