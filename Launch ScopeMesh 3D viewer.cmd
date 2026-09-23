@echo off
setlocal
title ScopeMesh 3D viewer Launcher
cd /d "%~dp0app"

where npm >nul 2>&1
if errorlevel 1 (
  echo ScopeMesh 3D viewer needs Node.js and npm, but npm was not found.
  echo Install Node.js, then double-click this launcher again.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4173/api/datasets' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if errorlevel 1 (
  if not exist "node_modules\" (
    echo Installing ScopeMesh 3D viewer dependencies for the first launch...
    call npm install
    if errorlevel 1 (
      echo.
      echo Dependency installation failed. See the error above.
      pause
      exit /b 1
    )
  )

  echo Starting ScopeMesh 3D viewer...
  start "ScopeMesh 3D viewer Server - close this window to stop" /min cmd.exe /k "cd /d ""%~dp0app"" && npm run start:watch"
)

echo Waiting for ScopeMesh 3D viewer to be ready...
powershell.exe -NoProfile -Command "$deadline = (Get-Date).AddSeconds(30); do { try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4173/api/datasets' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
  echo.
  echo ScopeMesh 3D viewer did not start within 30 seconds.
  echo Check the minimized ScopeMesh 3D viewer Server window for details.
  pause
  exit /b 1
)

if /I not "%~1"=="--no-browser" start "" "http://127.0.0.1:4173"
exit /b 0
