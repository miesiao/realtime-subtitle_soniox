@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo [ERROR] .env not found. Copy .env.example to .env and fill in SONIOX_API_KEY first.
  pause
  exit /b 1
)

rem Kill any process still holding port 8787 so this is a real restart —
rem otherwise a leftover server silently keeps serving while the new
rem "node server.js" below fails to bind and exits unnoticed in its window.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)

start "Soniox Server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:8787
