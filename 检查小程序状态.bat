@echo off
setlocal
chcp 65001 >nul
set "NO_PAUSE=0"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
if /I "%CI%"=="true" set "NO_PAUSE=1"

echo CrossBorder Image Agent - Status
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$backend=$false; $frontend=$false; try { $r=Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 300){ $backend=$true } } catch {}; try { $r=Invoke-WebRequest -Uri 'http://localhost:5173/' -UseBasicParsing -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 300){ $frontend=$true } } catch {}; if($backend){ Write-Host 'Backend: running  http://localhost:4000/api/health' } else { Write-Host 'Backend: not running' }; if($frontend){ Write-Host 'Frontend: running http://localhost:5173/' } else { Write-Host 'Frontend: not running' }"

echo.
call :pause_if_needed
endlocal
exit /b 0

:pause_if_needed
if "%NO_PAUSE%"=="1" exit /b 0
pause
exit /b 0
