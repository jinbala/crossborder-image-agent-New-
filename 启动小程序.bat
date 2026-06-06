@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "FRONTEND_DIR=%ROOT%frontend"
set "NO_PAUSE=0"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
if /I "%CI%"=="true" set "NO_PAUSE=1"

cd /d "%ROOT%"

echo CrossBorder Image Agent - Start
echo Project root: %ROOT%
echo.

if not exist "%BACKEND_DIR%\package.json" (
  echo ERROR: backend\package.json was not found.
  echo Please run this script from the project root folder.
  call :pause_if_needed
  exit /b 1
)

if not exist "%FRONTEND_DIR%\package.json" (
  echo ERROR: frontend\package.json was not found.
  echo Please run this script from the project root folder.
  call :pause_if_needed
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Please install Node.js first.
  call :pause_if_needed
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm.cmd was not found in PATH.
  echo Please check your Node.js installation.
  call :pause_if_needed
  exit /b 1
)

if not exist "%BACKEND_DIR%\node_modules" (
  echo ERROR: backend dependencies are not installed.
  echo Run: cd backend ^&^& npm.cmd install
  call :pause_if_needed
  exit /b 1
)

if not exist "%FRONTEND_DIR%\node_modules" (
  echo ERROR: frontend dependencies are not installed.
  echo Run: cd frontend ^&^& npm.cmd install
  call :pause_if_needed
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if %errorlevel%==0 (
  echo ERROR: Port 4000 is already in use.
  echo Close the existing backend service or run the stop script.
  call :pause_if_needed
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if %errorlevel%==0 (
  echo ERROR: Port 5173 is already in use.
  echo Close the existing frontend service or run the stop script.
  call :pause_if_needed
  exit /b 1
)

echo Starting backend on http://localhost:4000 ...
start "CrossBorder Backend" /MIN /D "%BACKEND_DIR%" cmd /k "npm.cmd run dev"

echo Starting frontend on http://localhost:5173 ...
start "CrossBorder Frontend" /MIN /D "%FRONTEND_DIR%" cmd /k "npm.cmd run dev"

echo Waiting for services to start...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 6" >nul 2>nul

echo Opening browser...
start "" "http://localhost:5173/"

echo.
echo Started. Keep the Backend and Frontend windows open while using the app.
echo Backend health: http://localhost:4000/api/health
echo Frontend:       http://localhost:5173/
echo.
echo Started. Launcher window will close automatically. Keep the Backend and Frontend windows open.
call :delay_before_close
endlocal
exit /b 0

:pause_if_needed
if "%NO_PAUSE%"=="1" exit /b 0
pause
exit /b 0

:delay_before_close
if "%NO_PAUSE%"=="1" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2" >nul 2>nul
exit /b 0
