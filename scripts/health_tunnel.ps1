param(
  [string]$Url = "https://tunnel.shelter-alert.com/health",
  [int]$TimeoutSec = 8
)

$curl = "$env:SystemRoot\System32\curl.exe"

$code = & $curl --ssl-revoke-best-effort -fsS `
  --connect-timeout $TimeoutSec --max-time $TimeoutSec `
  -o NUL -w "%{http_code}" $Url

if ($LASTEXITCODE -ne 0) {
  Write-Host "TUNNEL_HEALTH=FAIL curl_exit=$LASTEXITCODE"
  exit 2
}

if ($code -ne "200") {
  Write-Host "TUNNEL_HEALTH=BAD_HTTP http_code=$code"
  exit 3
}

Write-Host "TUNNEL_HEALTH=OK http_code=$code"
exit 0
