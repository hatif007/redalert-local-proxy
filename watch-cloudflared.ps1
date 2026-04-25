$ErrorActionPreference = "SilentlyContinue"

$ServiceName = "cloudflared"
$LogPath     = "C:\redalert-local-proxy\watch-cloudflared-watchdog.log"
$MetricsUrl  = "http://127.0.0.1:20241/metrics"

# Origin: ???? IPv6 ??? fallback
$OriginUrls  = @(
  "http://[::1]:8080/health",
  "http://127.0.0.1:8080/health",
  "http://localhost:8080/health"
)

$PublicUrl   = "https://tunnel.shelter-alert.com/health"

function Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogPath -Value "$ts  $msg"
}

# --- LOCK ??? ????? ??????? ---
$mutexName = "Global\Watch-Cloudflared"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$hasLock = $false
try {
  $hasLock = $mutex.WaitOne(0)
  if (-not $hasLock) { Log "SKIP: already running"; exit 0 }

  function CurlCode($url) {
    $args = @("-g","-s","-o","NUL","-w","%{http_code}","--max-time","4","--connect-timeout","2")
    if ($url -like "https://*") { $args += "--ssl-no-revoke" }
    $args += $url
    $code = & curl.exe @args
    if ([string]::IsNullOrWhiteSpace($code)) { return "000" }
    return $code.Trim()
  }

  function Restart-Cloudflared {
    Log "RESTART: restarting cloudflared"
    & sc.exe stop  $ServiceName | Out-Null
    Start-Sleep 2
    & sc.exe start $ServiceName | Out-Null
  }

  # 1) ???? ??? ????: metrics
  $m = CurlCode $MetricsUrl
  if ($m -eq "200") {
    # ??? ??? ? ?? ?????? ??????
    # (????? ???? ???? ??? ????? ?????? ??)
    Log "OK: metrics 200"
  } else {
    Log "WARN: metrics $m -> restart"
    Restart-Cloudflared
    Start-Sleep 4
    $m2 = CurlCode $MetricsUrl
    if ($m2 -eq "200") { Log "OK: metrics 200 after restart" } else { Log "FAIL: metrics $m2 after restart" }
  }

  # 2) Origin health (?? ????? restart ?-cloudflared)
  $originOk = $false
  foreach ($u in $OriginUrls) {
    if ((CurlCode $u) -eq "200") { $originOk = $true; break }
  }
  if ($originOk) { Log "OK: origin health 200" } else { Log "FAIL: origin health 0 (Origin not reachable)" }

  # 3) Public (????) ? ?? ?? ???????
  if ($PublicUrl) {
    $online = (Test-NetConnection 1.1.1.1 -Port 443 -InformationLevel Quiet)
    if ($online) {
      $pc = CurlCode $PublicUrl
      if ($pc -eq "200") { Log "OK: public health 200" } else { Log "WARN: public health $pc" }
    } else {
      Log "SKIP: no internet -> skip public check"
    }
  }

} finally {
  if ($hasLock) { $mutex.ReleaseMutex() | Out-Null }
  $mutex.Dispose()
}
