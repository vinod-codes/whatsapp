#!/bin/bash

# WhatsApp Bot Starter Script for Termux
# This script makes it easy to start the bot from anywhere

echo "=========================================="
echo "    WhatsApp Bot - Lead Management"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "bot.js" ]; then
    echo "❌ Error: bot.js not found!"
    echo "Please run this script from the whatsapp-bot directory"
    echo ""
    echo "To navigate to the bot directory:"
    echo "cd /path/to/whatsapp-bot"
    echo ""
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed!"
    echo "Please install Node.js first:"
    echo "pkg install nodejs"
    echo ""
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

echo "🚀 Starting WhatsApp Bot..."
echo "📱 Scan the QR code when it appears"
echo ""

# Start the bot
node bot.js 