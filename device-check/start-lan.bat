@echo off
rem ============================================================
rem  Hunan AR - Device Check page, served over HTTPS on the LAN
rem  Just double-click this file, then scan the QR code on the
rem  tablet.  Keep this window open while testing.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set PY="C:\Users\n\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe"

if not exist %PY% (
  echo [ERROR] Python not found at %PY%
  echo Edit this file and point PY to any python 3.8+ install.
  pause
  exit /b 1
)

%PY% -u serve-lan.py --port 8443
echo.
echo Server stopped.
pause
