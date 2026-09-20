@echo off
setlocal enabledelayedexpansion

set "NODE_CMD="

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "NODE_CMD=node"
    goto :found_node
)

if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
    set "ELECTRON_RUN_AS_NODE=1"
    goto :found_node
)

if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    goto :found_node
)

echo [ERRO] Nao foi possivel encontrar o Node.js nem o executavel do VS Code no sistema.
exit /b 1

:found_node
"%NODE_CMD%" "%~dp0smoke\run-smoke.js" %*
exit /b %ERRORLEVEL%
