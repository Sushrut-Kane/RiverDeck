@echo off
rem Riverdeck — start the online server by double-clicking this file.
rem Keep the window that opens running while you and your friends play.
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\Coverity\Coverity Static Analysis\node\node.exe" set "NODE_EXE=%ProgramFiles%\Coverity\Coverity Static Analysis\node\node.exe"

if not defined NODE_EXE (
  echo.
  echo Could not find Node.js on this computer.
  echo Install it once from https://nodejs.org then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Starting Riverdeck...
echo.
echo   Open this in your browser:  http://localhost:3000
echo   Keep this window open while you play. Close it to stop the game.
echo.
"%NODE_EXE%" server.js
pause
