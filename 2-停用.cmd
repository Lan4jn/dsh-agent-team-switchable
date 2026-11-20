@echo off
chcp 65001 >nul
title dsh-team-member-model - disable
rem ASCII-only on purpose: see 1-sync-enable.cmd for why.
set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0team-member-model.ps1" -Action disable
echo.
echo Restart DeepSeek Harness to apply. Use "1-..." to enable it again.
echo.
pause
