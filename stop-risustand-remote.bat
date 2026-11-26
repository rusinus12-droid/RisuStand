@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

if not defined PORT (
    if exist ".risustand-port" set /p PORT=<".risustand-port"
)
if not defined PORT set "PORT=8787"

echo ======================================================
echo   RisuStand Remote Relay Stop
echo ======================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = [int]($env:PORT); $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -like '*risustand-relay-server.js*' }; if ($procs) { $pids = @(); foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $pids += $p.ProcessId } catch { Write-Host ('[WARN] PID ' + $p.ProcessId + ' 종료 실패: ' + $_.Exception.Message) } }; Start-Sleep -Milliseconds 300; Write-Host ('[OK] RisuStand 중계 서버 종료 완료 (PID: ' + ($pids -join ', ') + ')') } else { Write-Host '[INFO] 실행 중인 RisuStand 중계 서버가 없습니다.' }; $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 }; if ($busy) { foreach ($c in $busy) { $bp = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; Write-Host ('[WARN] 포트 ' + $port + ' 이(가) 다른 프로세스에 의해 사용 중입니다: PID ' + $c.OwningProcess + ' (' + ($bp.ProcessName) + ')') } } else { Write-Host ('[OK] 포트 ' + $port + ' 해제 확인됨') }"

echo.
pause
