@echo off
title WhatsApp Bot - Lead Management

REM WhatsApp Bot Global Command for Windows
REM This script can be run from anywhere to start the bot

set BOT_DIR=

REM Check common locations
if exist "%USERPROFILE%\whatsapp-bot\bot.js" (
    set BOT_DIR=%USERPROFILE%\whatsapp-bot
) else if exist "%USERPROFILE%\Downloads\whatsapp-bot\bot.js" (
    set BOT_DIR=%USERPROFILE%\Downloads\whatsapp-bot
) else if exist "C:\whatsapp-bot\bot.js" (
    set BOT_DIR=C:\whatsapp-bot
) else if exist ".\bot.js" (
    set BOT_DIR=%CD%
) else (
    echo ❌ WhatsApp bot not found!
    echo.
    echo Please clone the repository first:
    echo git clone https://github.com/vinod-codes/whatsapp.git
    echo.
    echo Or navigate to the bot directory and run:
    echo node bot.js
    echo.
    pause
    exit /b 1
)

REM Navigate to bot directory
cd /d "%BOT_DIR%"

echo ==========================================
echo     WhatsApp Bot - Lead Management
echo ==========================================
echo 📍 Bot location: %BOT_DIR%
echo.

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