@echo off
chcp 65001 >nul
title dsh-team-member-model - uninstall
rem ASCII-only on purpose: see 1-sync-enable.cmd for why.
set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"
echo Uninstall: unregister the bundle and send the package folder to the Recycle Bin
echo (never a permanent delete). The policy file is kept.
echo To merely switch the plugin off, use "2-..." instead.
echo.
set /p OK=Type y to continue:
if /i not "%OK%"=="y" (
	echo Cancelled.
	pause
	exit /b 0
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0team-member-model.ps1" -Action uninstall
echo.
pause
