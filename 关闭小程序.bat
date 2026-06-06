@echo off
setlocal
chcp 65001 >nul
set "NO_PAUSE=0"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
if /I "%CI%"=="true" set "NO_PAUSE=1"

echo CrossBorder Image Agent - Stop
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=@(5173,4000); foreach($port in $ports){ $conns=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if(-not $conns){ Write-Host ('Port ' + $port + ': not running'); continue }; $pids=$conns | Select-Object -ExpandProperty OwningProcess -Unique; foreach($processId in $pids){ try { $proc=Get-Process -Id $processId -ErrorAction Stop; Stop-Process -Id $processId -Force; Write-Host ('Port ' + $port + ': stopped PID ' + $processId + ' (' + $proc.ProcessName + ')') } catch { Write-Host ('Port ' + $port + ': failed to stop PID ' + $processId + ' - ' + $_.Exception.Message) } } }"

echo.
echo Stop command finished.
echo.
echo Stop complete. This window will close automatically.
call :delay_before_close
endlocal
exit /b 0

:delay_before_close
if "%NO_PAUSE%"=="1" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2" >nul 2>nul
exit /b 0
