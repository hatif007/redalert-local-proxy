$ErrorActionPreference = 'SilentlyContinue'
$log = 'C:\redalert-local-proxy\watch-redalert-backend-watchdog.log'

function Log([string]$m){
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Path $log -Encoding utf8
}

while ($true) {
  $code = (curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8080/health)

  if ($code -eq "200") {
    Log "OK: backend /health 200"
  } else {
    Log "FAIL: backend /health $code -> restart red-alert-backend"
    sc.exe stop red-alert-backend | Out-Null
    Start-Sleep 2
    sc.exe start red-alert-backend | Out-Null
  }

  Start-Sleep 60
}
