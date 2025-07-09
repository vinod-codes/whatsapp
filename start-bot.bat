@echo off
title WhatsApp Bot - Lead Management

echo ==========================================
echo     WhatsApp Bot - Lead Management
echo ==========================================
echo.

REM Check if we're in the right directory
if not exist "bot.js" (
    echo ❌ Error: bot.js not found!
    echo Please run this script from the whatsapp-bot directory
    echo.
    echo To navigate to the bot directory:
    echo cd path\to\whatsapp-bot
    echo.
    pause
    exit /b 1
)

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Error: Node.js is not installed!
    echo Please install Node.js first from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Check if dependencies are installed
if not exist "node_modules" (
    echo 📦 Installing dependencies...
    npm install
    echo.
)

echo 🚀 Starting WhatsApp Bot...
echo 📱 Scan the QR code when it appears
echo.

REM Start the bot
node bot.js

pause 