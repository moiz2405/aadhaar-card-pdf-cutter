@echo off
rem ID Card Cutter + Resume Maker - one-click launcher
setlocal

set "NODE=C:\Program Files\nodejs\node.exe"
set "PORT=8080"

if not exist "%NODE%" (
  echo [ERROR] Node.js not found at "%NODE%"
  echo Install Node.js from https://nodejs.org or edit this file to point to node.exe
  echo.
  pause
  exit /b 1
)

rem OPEN_BROWSER=1 tells the server to open the browser only after it's ready.
set "OPEN_BROWSER=1"
set "PORT=%PORT%"

cd /d "%~dp0"

echo Starting ID Card Cutter + Resume Maker...
echo URL: http://127.0.0.1:%PORT%
echo.

"%NODE%" server.js

echo.
echo Server stopped.
pause
