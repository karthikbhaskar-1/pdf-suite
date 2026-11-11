# Holds a PDF open with no sharing, the way another program does, until a sentinel file appears (or 90 s pass).
param([string]$Path, [string]$Sentinel)
$stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'None')
try {
  Write-Output 'LOCKED'
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Path $Sentinel) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
} finally {
  $stream.Close()
  Write-Output 'RELEASED'
}
