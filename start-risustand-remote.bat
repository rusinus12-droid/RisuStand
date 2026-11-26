@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo ======================================================
echo   RisuStand Remote Relay Launcher
echo ======================================================

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed. Please install Node.js LTS from https://nodejs.org
    pause
    exit /b 1
)

if not exist "risustand-relay-server.js" (
    if exist "risustand-relay-server.js.txt" (
        echo [INFO] Found risustand-relay-server.js.txt - renaming to risustand-relay-server.js
        ren "risustand-relay-server.js.txt" "risustand-relay-server.js"
    )
)

if not exist "risustand-relay-server.js" (
    echo [ERROR] risustand-relay-server.js was not found in:
    echo         %cd%
    echo.
    echo Files currently in this folder:
    dir /b
    echo.
    echo Please save risustand-relay-server.js into this exact folder and run again.
    pause
    exit /b 1
)

if not exist ".risustand-token" (
    for /f "usebackq delims=" %%T in (`node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`) do set "GEN_TOK=%%T"
    > ".risustand-token" echo !GEN_TOK!
)

set /p RISU_REMOTE_TOKEN=<".risustand-token"
if not defined PORT set "PORT=8787"

set "TS_IP="
where tailscale >nul 2>&1
if not errorlevel 1 (
    for /f "usebackq delims=" %%I in (`tailscale ip -4 2^>nul`) do (
        if "!TS_IP!"=="" set "TS_IP=%%I"
    )
)

echo.
echo   PC Bridge URL  : http://127.0.0.1:%PORT%
echo   Proxy Router   : http://127.0.0.1:%PORT%/v1/chat/completions
if not "!TS_IP!"=="" (
    echo   iPhone / iPad  : http://!TS_IP!:%PORT%
)
echo   Security Token : %RISU_REMOTE_TOKEN%
echo ======================================================
echo   Keep this window open while using Remote Access.
echo.

node "risustand-relay-server.js"
echo.
pause
