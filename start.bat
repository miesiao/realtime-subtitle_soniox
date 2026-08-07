@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo [ERROR] .env not found. Copy .env.example to .env and fill in SONIOX_API_KEY first.
  pause
  exit /b 1
)
start "Soniox Server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:8787
