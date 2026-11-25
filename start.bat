@echo off
setlocal enabledelayedexpansion
echo ====================================================
echo   PetroBlend Enterprise ERP - Windows Local Startup
echo ====================================================

if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo Created .env from .env.example
    )
)

if not exist "data" mkdir data
if not exist "uploads" mkdir uploads
if not exist "backups" mkdir backups

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js 20+ is required. Install from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing application dependencies...
    call npm install
)

echo Building frontend and starting ERP server on http://localhost:3000 ...
start "" "http://localhost:3000"
call npm run dev
