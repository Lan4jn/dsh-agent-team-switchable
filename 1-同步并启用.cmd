@echo off
chcp 65001 >nul
title dsh-team-member-model - sync and enable
rem ASCII-only on purpose: cmd parses this file with the OEM code page, and UTF-8
rem Chinese bytes can break quoting. Chinese output comes from the .ps1 below,
rem which runs after "chcp 65001" has switched the console to UTF-8.
set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0team-member-model.ps1" -Action install
echo.
echo Next: restart DeepSeek Harness (the host reads packages only at startup),
echo then refresh the GUI and open Settings - Team Member Model.
echo.
pause
