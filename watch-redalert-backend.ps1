$Log = "C:\redalert-local-proxy\watch-redalert-backend-watchdog.log"
$Svc = "redalert-backend"
$Url = "http://[::1]:8080/health"

function LogLine($msg) {
  $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -Path $Log -Value "$ts  $msg"
}

try {
  $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
  if ($r.StatusCode -eq 200) {
    LogLine "OK: origin health 200"
    exit 0
  }
  LogLine "WARN: origin health $($r.StatusCode) -> restart $Svc"
} catch {
  LogLine "ERR: origin health failed ($($_.Exception.Message)) -> restart $Svc"
}

sc.exe start $Svc | Out-Null
Start-Sleep 2
exit 0
