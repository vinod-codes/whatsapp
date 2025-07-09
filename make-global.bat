@echo off
title Make WhatsApp Bot Global

REM Make WhatsApp Bot Command Global for Windows
REM This script makes the bot command available from anywhere

echo ==========================================
echo     Making WhatsApp Bot Global
echo ==========================================
echo.

REM Get current directory
set CURRENT_DIR=%CD%

REM Check if we're in the bot directory
if not exist "bot.js" (
    echo ❌ Error: Please run this script from the whatsapp-bot directory
    echo Navigate to the bot directory first:
    echo cd path\to\whatsapp-bot
    echo.
    pause
    exit /b 1
)

echo 🔗 Creating global command...

REM Add to PATH environment variable
setx PATH "%PATH%;%CURRENT_DIR%"

REM Create a copy in a common location
if not exist "C:\whatsapp-bot" mkdir "C:\whatsapp-bot"
copy "whatsapp-bot.bat" "C:\whatsapp-bot\whatsapp-bot.bat"

echo ✅ Global command created for Windows
echo.
echo 🎉 Setup complete!
echo.
echo Now you can run the bot from anywhere using:
echo    whatsapp-bot
echo.
echo The command will automatically:
echo    📍 Find the bot directory
echo    📦 Install dependencies if needed
echo    🚀 Start the bot
echo    📱 Show QR code for WhatsApp
echo.
echo Note: You may need to restart your command prompt
echo for the changes to take effect.
echo.
pause 