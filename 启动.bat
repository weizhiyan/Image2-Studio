@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Huiban

set "BRIDGE_PORT=3788"
set "NODE_HOME="
set "NPM_CMD=npm.cmd"

echo ========================================
echo   Huiban - Windows launcher
echo ========================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %BRIDGE_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo Huiban is already running at http://127.0.0.1:%BRIDGE_PORT%/
  start "" "http://127.0.0.1:%BRIDGE_PORT%/"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 goto use_bundled_or_download
node -e "const v=process.versions.node.split('.').map(Number); process.exit(v[0]>20 || (v[0]===20 && (v[1]>18 || (v[1]===18 && v[2]>=1))) ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto use_bundled_or_download
goto node_ready

:use_bundled_or_download
if exist "%CD%\.runtime\node\node.exe" goto use_bundled
echo Node.js 22 LTS was not found. Downloading a portable runtime...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\ensure-node.ps1" -TargetDir "%CD%\.runtime\node"
if errorlevel 1 goto node_failed

:use_bundled
set "NODE_HOME=%CD%\.runtime\node"
set "PATH=%NODE_HOME%;%PATH%"
set "NPM_CMD=%NODE_HOME%\npm.cmd"

:node_ready
if not defined NODE_HOME goto node_path_ready
set "PATH=%NODE_HOME%;%PATH%"
set "NPM_CMD=%NODE_HOME%\npm.cmd"
:node_path_ready
node --version
if errorlevel 1 goto node_failed

if exist "node_modules" if not exist "node_modules\.bin\vite.cmd" (
  echo Removing node_modules copied from another platform...
  rmdir /s /q "node_modules"
)
if not exist "node_modules\.bin\vite.cmd" (
  echo Installing dependencies. First run may take a few minutes...
  call "%NPM_CMD%" install --no-audit --no-fund
  if errorlevel 1 goto install_failed
)

echo Building frontend and bridge...
call "%NPM_CMD%" run build
if errorlevel 1 goto build_failed

if not exist "logs" mkdir "logs"
echo Starting Huiban on port %BRIDGE_PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','npm start' -WorkingDirectory '%CD%' -RedirectStandardOutput '%CD%\logs\huiban.log' -RedirectStandardError '%CD%\logs\huiban-error.log' -WindowStyle Hidden -PassThru; $p.Id | Set-Content -Encoding ascii '%CD%\logs\huiban.pid'"
if errorlevel 1 goto start_failed

for /l %%i in (1,1,40) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%BRIDGE_PORT%/api/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)
goto start_failed

:ready
start "" "http://127.0.0.1:%BRIDGE_PORT%/"
echo.
echo Huiban is running: http://127.0.0.1:%BRIDGE_PORT%/
echo Stop it by double-clicking "停止.bat".
echo Logs: logs\huiban.log
pause
exit /b 0

:node_failed
echo.
echo Could not find or install Node.js 22 LTS.
echo Install it manually from https://nodejs.org/en/download and run this file again.
pause
exit /b 1

:install_failed
echo.
echo npm install failed. Check your network or proxy, then run this file again.
pause
exit /b 1

:build_failed
echo.
echo Build failed. See the error above.
pause
exit /b 1

:start_failed
echo.
echo Huiban did not start. Check logs\huiban.log and logs\huiban-error.log.
pause
exit /b 1
