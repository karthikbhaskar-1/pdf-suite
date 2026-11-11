# Test queue (unattended test runs)

One long-running runner process runs PDF Suite tests for everybody. Nobody has to watch a test run: submit a job, then wait with short foreground calls.

## Use it (two commands)

```
node scripts/testq/submit.mjs --worktree <path> --suite core --pack --who dev132 [--files a,b] [--priority ticket]
node scripts/testq/wait.mjs <job id> [--max-seconds 540]
```

`submit` records the commit and whether the tree was dirty in job.json, and refuses (exit 3, nothing queued) a `--suite core|heavy|full` run when an earlier clean passing job of the same worktree already covered that half and nothing relevant changed since. Override with `--force "<reason>"` (recorded in job.json); `--files` jobs are never guarded.

`submit` prints the job id (and nothing else on stdout). `wait` blocks in the foreground until the job is done or the maximum is reached, then prints `summary.txt` (10 lines) and exits:

| exit | meaning |
|---|---|
| 0 | job finished, everything passed |
| 1 | job finished with failures or timeouts (or: unknown job, runner not running) |
| 2 | still running: call `wait` again |

An agent waits with repeated `wait` calls of under 10 minutes. The orchestrator can run one `wait` as a background command and get notified when it exits.

### Submit options

- `--worktree <path>`: the worktree to test (its own `release/win-unpacked` is used, and its own `tests/testq-manifest.json`).
- `--suite unit|core|heavy|full`: `unit` = vitest and the node unit files; `core` = every functional e2e file; `heavy` = every exclusive e2e file and gate probe (perf probe, blank-page diagnostic, memory soak; not the long diagnostics marked `"suite": false`); `full` = all three.
- `--files a,b`: explicit files (relative to the worktree), alone or added to a suite. Probes run as scripts, `*.e2e.mjs` with `node --test`.
- `--pack`: run `npm run desktop:pack` in the worktree first. One pack per worktree at a time; jobs of one worktree that wait together share one pack. Without `--pack` the existing build is used. The test fixtures (`tests/fixtures/make-fixtures.mjs`) are always regenerated before e2e files.
- `--who <name>`: shown in the summary.
- `--priority ticket|measure` (default `measure`): ticket jobs go before measure jobs.

## What the runner does

- **The old shared lock.** The runner works only while it owns the old mkdir lock (`PDFSUITE_APP_LOCK`). When a job is waiting and an agent that has not switched over holds the lock, the runner waits for it, takes it (writing its own owner name), runs, and gives it back when it is idle (then waits 15 s before taking it again, so waiting agents get in). So no legacy run overlaps a queue run. The runner removes the lock only when the owner file holds its own name; it never removes a lock because it looks old. `PDFSUITE_TESTQ_LOCK_ALL=0` limits the lock to exclusive files.
- **Functional files** run side by side (up to `PDFSUITE_TESTQ_PARALLEL`) while the runner owns the lock. **Exclusive files** (timing, frame times, memory, first-page time, soak, and mixed files) run only when nothing else is running: no functional file, no pack, no foreign PDF Suite process. While an exclusive file is next in order, nothing queued behind it starts, so it is not starved.
- **Order**: `ticket` before `measure`, then first come first served (submission order) within a priority. Inside one job the longest functional files start first.
- **Time limit** per file: the manifest minutes x 3 (at least 2 minutes). A file past its limit has its own process tree stopped and is recorded as `timeout`.
- **Clean-up**: every file gets its own `TEMP`/`TMP` folder under the queue folder, so its Electron profiles (`pdfsuite-e2e-*`) are removed afterwards even after a crash or a kill. Leftover processes are found only by that folder in their command line. The runner never stops anything by image name and never touches processes it did not start.
- **Results** per job, in `<queue>/jobs/<id>/`: `result.json` (per file: status, pass/fail counts, failing test names with the first error lines, duration, expected minutes, log path), `summary.txt`, `status.json` (progress), `logs/` (one log per file, plus `pack.log`).

## The manifest

`tests/testq-manifest.json` lists each file with `class` (`functional` or `exclusive`), expected `minutes`, `kind` (`unit`, `e2e`, `probe`) and, for exclusive files, `why`. A file that is not listed is treated as exclusive with 5 minutes. A file is exclusive if it uses `tests/lib/frame-validity.mjs`, measures ms or MB against a limit, or uses the perf/memory helpers; a file that mixes functional checks with such a check is exclusive. If a functional file is found to fail only when run in parallel, mark it `exclusive` in the manifest and say why in `why`; do not change the test. `tests/lib/testq-manifest.test.mjs` checks that every e2e file is listed.

## Start and stop

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\testq\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\testq\stop.ps1
```

`start.ps1` starts the runner detached and hidden (no console window) and writes `<queue>/runner.pid`. `stop.ps1` asks the runner to stop (it ends its own running test processes and frees the lock), then stops only the PID in that file, and only if that process is the runner. A job that was running when the runner stopped is put back in the queue and starts over when the runner is next started. The runner writes `runner.json` (heartbeat) and `runner.log` in the queue folder.

## Settings (environment variables)

| variable | default |
|---|---|
| `PDFSUITE_TESTQ_DIR` | `%LOCALAPPDATA%\pdfsuite-testq` |
| `PDFSUITE_TESTQ_PARALLEL` | 3 (functional files at once) |
| `PDFSUITE_TESTQ_PACKS` | 1 (packs at once, across worktrees) |
| `PDFSUITE_APP_LOCK` | `<queue>\app.lock` (the old shared mkdir lock) |
| `PDFSUITE_TESTQ_LOCK_ALL` | on; `0` = only exclusive files take the lock |
| `PDFSUITE_TESTQ_LOCK_COOLDOWN_SEC` | 15 |
| `PDFSUITE_TESTQ_LIMIT_FACTOR`, `PDFSUITE_TESTQ_LIMIT_FLOOR_MIN` | 3, 2 (per-file limit = minutes x factor, at least the floor) |
| `PDFSUITE_TESTQ_PACK_LIMIT_MIN` | 25 |
| `PDFSUITE_TESTQ_POLL_MS` | 1000 |

Set them before `start.ps1` (the runner reads them once). `submit` and `wait` read `PDFSUITE_TESTQ_DIR` as well, so they must see the same value as the runner.

## Files

`runner.mjs` (the process), `submit.mjs`, `wait.mjs`, `start.ps1`, `stop.ps1`, `node-reporter.mjs` (JSON test reporter for `node --test`), `lib/repeat-guard.mjs` (pure repeat rules; `tests/lib/testq-repeat-guard.test.mjs`), `lib/scheduler.mjs` (pure scheduling rules; unit-tested in `tests/lib/testq-scheduler.test.mjs`), `lib/manifest.mjs`, `lib/proc.mjs`, `lib/lock.mjs`, `lib/report.mjs`, `lib/config.mjs`. Node standard library only.
