# Stops the test runner: only the PID in its PID file, and only if that process is the runner.
# It first asks the runner to stop (a `stop` file): the runner ends its own running test processes, frees the machine
# lock and exits. If it has not exited after 60 seconds, that one PID is stopped.
$ErrorActionPreference = 'Stop'
$queue = $env:PDFSUITE_TESTQ_DIR
if (-not $queue) { $queue = Join-Path $env:LOCALAPPDATA 'pdfsuite-testq' }
$pidFile = Join-Path $queue 'runner.pid'
if (-not (Test-Path $pidFile)) { Write-Output 'no runner PID file: nothing to stop'; exit 0 }
$target = [int](Get-Content $pidFile -Raw)
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$target" -ErrorAction SilentlyContinue
if (-not $proc -or $proc.CommandLine -notlike '*testq*runner.mjs*') {
  Remove-Item $pidFile -Force
  Write-Output "pid $target is not the test runner (already stopped); PID file removed"
  exit 0
}
Set-Content -Path (Join-Path $queue 'stop') -Value 'stop' -Encoding ascii
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (-not (Get-Process -Id $target -ErrorAction SilentlyContinue)) { break }
}
if (Get-Process -Id $target -ErrorAction SilentlyContinue) {
  Stop-Process -Id $target -Force
  Write-Output "runner (pid $target) did not stop by itself and was stopped"
} else {
  Write-Output "runner (pid $target) stopped"
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $queue 'stop') -Force -ErrorAction SilentlyContinue
