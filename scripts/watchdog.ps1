$ErrorActionPreference = "SilentlyContinue"

# ---- Simple mutex lock (prevents overlapping runs) ----
$lockPath = "C:\redalert-local-proxy\logs\watchdog.lock"

# If lock exists and is fresh (e.g., < 2 minutes), skip to avoid double restarts
if (Test-Path $lockPath) {
  $ageSec = (New-TimeSpan -Start (Get-Item $lockPath).LastWriteTime -End (Get-Date)).TotalSeconds
  if ($ageSec -lt 120) {
    Write-Host "WATCHDOG=SKIP (lock active)"
    exit 0
  }
}

New-Item -ItemType File -Path $lockPath -Force | Out-Null

try {
  # 1) Run health check
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\redalert-local-proxy\scripts\health_all.ps1
  $code = $LASTEXITCODE

  if ($code -eq 0) {
    Write-Host "WATCHDOG=OK"
    exit 0
  }

  Write-Host "WATCHDOG=FAIL code=$code -> restarting services..."

  function Stop-ServiceHard([string]$svcName, [int]$timeoutSec = 20) {
    sc.exe stop $svcName | Out-Null

    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      $s = (sc.exe query $svcName) | Out-String
      if ($s -match "STATE\s+:\s+\d+\s+STOPPED") { return $true }
      Start-Sleep -Milliseconds 500
    }

    # Still not stopped → try taskkill of node processes spawned by this service (best-effort)
    return $false
  }

  function Start-ServiceSafe([string]$svcName) {
    sc.exe start $svcName | Out-Null
    Start-Sleep -Seconds 2
  }

  # 2) Restart services (local first, then tunnel)
  $stopped = Stop-ServiceHard "redalert-local-proxy" 25
  if (-not $stopped) {
    Write-Host "WATCHDOG=WARN redalert-local-proxy did not stop in time"
  }
  Start-ServiceSafe "redalert-local-proxy"

  $stopped2 = Stop-ServiceHard "cloudflared" 25
  if (-not $stopped2) {
    Write-Host "WATCHDOG=WARN cloudflared did not stop in time"
  }
  Start-ServiceSafe "cloudflared"

  Write-Host "WATCHDOG=RESTARTED"
  exit 0
}
finally {
  # release lock
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}
