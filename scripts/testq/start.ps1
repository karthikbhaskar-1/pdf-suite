# Starts the test runner detached and hidden (no console window), and writes its PID file.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\testq\start.ps1
# Settings come from the environment (PDFSUITE_TESTQ_DIR, PDFSUITE_TESTQ_PARALLEL, PDFSUITE_APP_LOCK, ...); see README.md.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here 'runner.mjs'

$queue = $env:PDFSUITE_TESTQ_DIR
if (-not $queue) { $queue = Join-Path $env:LOCALAPPDATA 'pdfsuite-testq' }
New-Item -ItemType Directory -Force -Path $queue | Out-Null
$pidFile = Join-Path $queue 'runner.pid'

if (Test-Path $pidFile) {
  $old = [int](Get-Content $pidFile -Raw)
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -like '*testq*runner.mjs*') {
    Write-Output "test runner already running (pid $old)"
    exit 0
  }
  Remove-Item $pidFile -Force
}
Remove-Item (Join-Path $queue 'stop') -Force -ErrorAction SilentlyContinue

$node = (Get-Command node -ErrorAction Stop).Source
$out = Join-Path $queue 'runner.out.log'
$err = Join-Path $queue 'runner.err.log'
$p = Start-Process -FilePath $node -ArgumentList @("`"$runner`"") -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Set-Content -Path $pidFile -Value $p.Id -Encoding ascii
Start-Sleep -Milliseconds 1500
if ($p.HasExited) {
  Write-Error "the runner exited at once (code $($p.ExitCode)); see $err"
  exit 1
}
Write-Output "test runner started (pid $($p.Id)); queue $queue"
