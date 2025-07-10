#!/bin/bash

# WhatsApp Bot Super-Simple Setup Script for Termux
# This script sets up everything needed to run the bot, even for first-time users

set -e

banner() {
  echo "=========================================="
  echo "    WhatsApp Bot Setup for Termux"
  echo "=========================================="
  echo ""
}

banner

# 1. Ask for storage permission (needed for file access)
echo "🔑 Granting storage permission (needed for file access)..."
termux-setup-storage || true
sleep 1

# 2. Update package list
echo "📦 Updating package list..."
pkg update -y || { echo '❌ Failed to update packages. Check your internet connection.'; exit 1; }

# 3. Install all required packages in one go
echo "📦 Installing required packages (nodejs, git, curl, python, build-essential)..."
pkg install -y nodejs git curl python build-essential || { echo '❌ Failed to install dependencies. Try running the script again.'; exit 1; }

# 4. Make the start script executable
chmod +x start-bot.sh || true

# 5. Install npm dependencies
echo "📦 Installing npm dependencies..."
if [ -f package.json ]; then
  npm install || { echo '❌ npm install failed. Try running npm install manually.'; exit 1; }
else
  echo '❌ package.json not found! Make sure you are in the bot directory.'
  exit 1
fi

# 6. Final instructions
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
echo "If you see any errors above, try running the script again or check your internet connection."
echo "If you still face issues, run: pkg upgrade -y && npm install"
echo ""
