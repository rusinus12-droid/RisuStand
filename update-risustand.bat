@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ======================================================
echo   RisuStand Updater
echo   * Close the relay server window before updating.
echo ======================================================

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed. Please install Node.js LTS from https://nodejs.org
    pause
    exit /b 1
)

node "risustand-updater.cjs" --apply %*
echo.
pause
