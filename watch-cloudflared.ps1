$svc = "cloudflared"
$metrics = "http://127.0.0.1:20241/metrics"   # אצלך ראינו 20241 עובד
$log = "C:\redalert-local-proxy\watch-cloudflared-watchdog.log"

function Log($msg) {
  $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -Path $log -Value "$ts  $msg"
}

try {
  $s = Get-Service -Name $svc -ErrorAction Stop
} catch {
  Log "ERROR: service '$svc' not found"
  exit 1
}

# אם השירות לא RUNNING -> נרים
if ($s.Status -ne "Running") {
  Log "Service is $($s.Status) -> restarting"
  sc.exe stop $svc | Out-Null
  Start-Sleep 2
  sc.exe start $svc | Out-Null
  Start-Sleep 3
}

# בדיקת בריאות דרך metrics (אם לא מגיב -> restart)
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 $metrics
  if ($r.StatusCode -ne 200) { throw "metrics status $($r.StatusCode)" }
  Log "OK: metrics 200"
} catch {
  Log "BAD: metrics not OK -> restart service. err=$($_.Exception.Message)"
  sc.exe stop $svc | Out-Null
  Start-Sleep 2
  sc.exe start $svc | Out-Null
}
