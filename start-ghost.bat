@echo off
title GHOST HOST
cd /d "%~dp0"
color 0B
echo.
echo   ==============================
echo    GHOST HOST  -  starting...
echo    Panel: http://localhost:3000
echo   ==============================
echo.
:loop
node server.js
echo.
echo   [%date% %time%] Server band ho gaya. 5 second me restart...
timeout /t 5 /nobreak >nul
goto loop
