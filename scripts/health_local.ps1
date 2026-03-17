param(
  [string]$Url = "http://127.0.0.1:3000/health",
  [int]$TimeoutSec = 4
)

$curl = "$env:SystemRoot\System32\curl.exe"

$code = & $curl -fsS `
  --connect-timeout $TimeoutSec --max-time $TimeoutSec `
  -o NUL -w "%{http_code}" $Url

if ($LASTEXITCODE -ne 0) { Write-Host "LOCAL_HEALTH=FAIL curl_exit=$LASTEXITCODE"; exit 2 }
if ($code -ne "200") { Write-Host "LOCAL_HEALTH=BAD_HTTP http_code=$code"; exit 3 }

Write-Host "LOCAL_HEALTH=OK http_code=$code"
exit 0
