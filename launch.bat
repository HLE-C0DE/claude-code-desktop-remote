@echo off
chcp 65001 >nul 2>&1
title ClaudeCode_Remote - Launcher

echo.
echo ============================================================
echo   ClaudeCode_Remote - Launcher
echo ============================================================
echo.

REM Verifier si PowerShell est disponible
where powershell >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERREUR] PowerShell n'est pas disponible sur ce systeme
    pause
    exit /b 1
)

REM Lancer le script PowerShell
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0launch.ps1"

REM Si le script se termine, faire une pause
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERREUR] Le launcher s'est termine avec une erreur
    pause
)
