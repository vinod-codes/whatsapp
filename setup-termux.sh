#!/bin/bash

# WhatsApp Bot Setup Script for Termux
# This script sets up everything needed to run the bot

echo "=========================================="
echo "    WhatsApp Bot Setup for Termux"
echo "=========================================="
echo ""

# Update package list
echo "📦 Updating package list..."
pkg update -y

# Install Node.js if not installed
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js..."
    pkg install nodejs -y
else
    echo "✅ Node.js is already installed"
fi

# Install Git if not installed
if ! command -v git &> /dev/null; then
    echo "📦 Installing Git..."
    pkg install git -y
else
    echo "✅ Git is already installed"
fi

# Make the start script executable
chmod +x start-bot.sh

# Install npm dependencies
echo "📦 Installing npm dependencies..."
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 To start the bot, run one of these commands:"
echo "   ./start-bot.sh"
echo "   npm start"
echo "   npm run menu"
echo "   node bot.js"
echo ""
echo "📱 The bot will show a QR code to scan with WhatsApp"
echo ""
