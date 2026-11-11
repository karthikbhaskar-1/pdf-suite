#!/usr/bin/env bash
# Runs probes one after another under the shared app lock. Usage: run.sh probeA.mjs [probeB.mjs ...]
L="${PDFSUITE_APP_LOCK:-${TMPDIR:-/tmp}/pdfsuite-app.lock}"
[ -z "${PDFSUITE_APP_LOCK:-}" ] && echo "WARNING: PDFSUITE_APP_LOCK is not set; using the default lock folder $L. Agents sharing this PC must set it to the shared lock path." >&2
cd "$(dirname "$0")/../.."
until mkdir "$L" 2>/dev/null; do sleep 15; done
echo signoff > "$L/owner"
trap 'rm -rf "$L"' EXIT
for p in "$@"; do
  echo "=== $p $(date +%H:%M:%S)"
  node "tests/signoff5/$p" 2>&1 | tail -n 200
  echo "=== exit ${PIPESTATUS[0]} $(date +%H:%M:%S)"
done
