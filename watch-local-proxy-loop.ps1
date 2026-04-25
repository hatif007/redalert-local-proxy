$ErrorActionPreference = 'SilentlyContinue'

$svc = 'redalert-local-proxy'
$log = 'C:\redalert-local-proxy\watch-local-proxy.log'
$lock = 'C:\redalert-local-proxy\watch-local-proxy.lock'
$healthUrl = 'http://127.0.0.1:3000/health'

function Log([string]$m){
  (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m | Add-Content $log -Encoding utf8
}

function GetSvcState(){
  try{
    $s = (sc.exe query $svc | Select-String 'STATE').ToString()
    if ($s -match 'RUNNING') { return 'RUNNING' }
    if ($s -match 'START_PENDING') { return 'START_PENDING' }
    if ($s -match 'STOP_PENDING') { return 'STOP_PENDING' }
    if ($s -match 'STOPPED') { return 'STOPPED' }
    return 'UNKNOWN'
  } catch { return 'UNKNOWN' }
}

function StartSvc(){
  sc.exe start $svc | Out-Null
}

function StopSvc(){
  sc.exe stop $svc | Out-Null
}

function HttpCode([string]$url){
  try { return & curl.exe -s -o NUL -w "%{http_code}" --max-time 5 --connect-timeout 3 $url } catch { return "000" }
}

# lock נגד כפילות
if (Test-Path $lock) { exit 0 }
New-Item -ItemType File -Force -Path $lock | Out-Null

try{
  Log "WATCHDOG START"
  $pendingSince = $null
  $lastRestart  = (Get-Date).AddYears(-1)

  while($true){

    $state = GetSvcState

    # אם השירות ב-PENDING יותר מדי זמן -> ריסטארט
    if ($state -in @('START_PENDING','STOP_PENDING')) {
      if (-not $pendingSince) { $pendingSince = Get-Date }
      if (((Get-Date) - $pendingSince).TotalSeconds -gt 90) {
        Log "WARN: service stuck in $state > 90s -> restart"
        StopSvc; Start-Sleep 2; StartSvc; Start-Sleep 3
        $pendingSince = $null
        $lastRestart = Get-Date
      }
      Start-Sleep 5
      continue
    } else {
      $pendingSince = $null
    }

    # אם STOPPED -> להרים
    if ($state -ne 'RUNNING') {
      Log "WARN: service not RUNNING ($state) -> start"
      StartSvc
      Start-Sleep 3
    }

    # בדיקת בריאות מקומית בלבד
    $h = HttpCode $healthUrl
    if ($h -ne '200') {
      # backoff קטן שלא נטחן
      if (((Get-Date) - $lastRestart).TotalSeconds -lt 20) {
        Log "FAIL: health $h but restarted recently -> wait"
      } else {
        Log "FAIL: health $h -> restart service"
        StopSvc; Start-Sleep 2; StartSvc; Start-Sleep 3
        $lastRestart = Get-Date
      }
    } else {
      Log "OK: health 200"
    }

    Start-Sleep 30
  }
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
