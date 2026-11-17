@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Huiban - Stop

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports = @(3788, 5199); foreach ($port in $ports) { $ids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach ($processId in $ids) { if ($processId) { try { Stop-Process -Id $processId -Force -ErrorAction Stop; Write-Host ('Stopped port ' + $port + ' (PID ' + $processId + ')') } catch { Write-Host ('Could not stop port ' + $port + ' (PID ' + $processId + ')') } } } }"

echo Done. Your data is kept in %USERPROFILE%\.huiban
pause
