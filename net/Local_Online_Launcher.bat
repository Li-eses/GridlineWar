@echo off
title Gridline War - Online Launcher
color 0B

echo ====================================================
echo           Gridline War - Online Launcher
echo ====================================================
echo.

:: Check if port 8000 is in use
netstat -ano | findstr :8000 >nul
if %errorlevel%==0 (
    echo [INFO] Signaling server is already running.
    echo [INFO] Opening the game in your browser...
    if exist "%~dp0..\start.html" start "" "%~dp0..\start.html"
    timeout /t 3 >nul
    exit /b
)

:: Check if main.ts exists
if not exist "%~dp0main.ts" (
    echo [ERROR] main.ts not found. Please keep this file in the same folder as main.ts.
    pause
    exit /b
)

:: Check Deno
set "DENO_PATH=%USERPROFILE%\.deno\bin\deno.exe"
where deno >nul 2>nul
if %errorlevel%==0 (
    set "DENO_CMD=deno"
) else if exist "%DENO_PATH%" (
    set "DENO_CMD=%DENO_PATH%"
    set "PATH=%USERPROFILE%\.deno\bin;%PATH%"
) else (
    echo [SYSTEM] Deno not found. Installing Deno...
    echo.
    powershell -Command "irm https://deno.land/install.ps1 | iex"
    
    if exist "%DENO_PATH%" (
        set "DENO_CMD=%DENO_PATH%"
        set "PATH=%USERPROFILE%\.deno\bin;%PATH%"
        echo.
        echo [SYSTEM] Deno installed successfully!
    ) else (
        echo.
        echo [ERROR] Deno installation failed. Please install manually.
        pause
        exit /b
    )
)

:: Open the game
echo.
echo [SYSTEM] Opening the game...
if exist "%~dp0..\start.html" (
    start "" "%~dp0..\start.html"
) else (
    echo [WARNING] start.html not found in parent directory.
)

echo.
echo ====================================================
echo  [RUNNING] Signaling Server started on port 8000
echo  [NOTE] Please KEEP THIS WINDOW OPEN during the game.
echo         You can minimize this window.
echo ====================================================
echo.

"%DENO_CMD%" run --allow-net "%~dp0main.ts"

echo.
echo [STOPPED] Server stopped.
pause