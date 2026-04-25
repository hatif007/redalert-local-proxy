$ErrorActionPreference = 'SilentlyContinue'
$log  = 'C:\redalert-local-proxy\watch-cloudflared-watchdog.log'
$host = 'tunnel.shelter-alert.com'

function Log([string]$m){
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Path $log -Encoding utf8
}

while ($true) {
  $okOrigin = (curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8080/health) -eq "200"
  $okPublic = (curl.exe -s -o NUL -w "%{http_code}" --ssl-no-revoke "https://$host/health") -eq "200"
  $okMetrics = (curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:20241/metrics) -eq "200"

  if ($okOrigin -and $okPublic -and $okMetrics) {
    Log "OK: origin health 200 | public health 200 | metrics 200"
  } else {
    Log ("FAIL: origin={0} public={1} metrics={2} -> restart cloudflared" -f $okOrigin, $okPublic, $okMetrics)
    sc.exe stop cloudflared | Out-Null
    Start-Sleep 2
    sc.exe start cloudflared | Out-Null
  }

  Start-Sleep 20
}
