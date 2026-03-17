$ErrorActionPreference = "Stop"

& C:\redalert-local-proxy\scripts\health_local.ps1
$local = $LASTEXITCODE

& C:\redalert-local-proxy\scripts\health_tunnel.ps1
$tunnel = $LASTEXITCODE

if ($local -ne 0 -or $tunnel -ne 0) {
  Write-Host "HEALTH_ALL=FAIL local=$local tunnel=$tunnel"
  exit 10
}

Write-Host "HEALTH_ALL=OK"
exit 0
