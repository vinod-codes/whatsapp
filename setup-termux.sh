#!/data/data/com.termux/files/usr/bin/bash

# WhatsApp Auto-Messenger Bot - Termux Setup Script
# This script helps set up the environment in Termux for running the bot

echo "Setting up WhatsApp Auto-Messenger Bot in Termux..."

# Update Termux packages
echo "Updating Termux packages..."
pkg update -y && pkg upgrade -y

# Install required packages
echo "Installing required packages..."
pkg install -y nodejs
pkg install -y termux-api

# Set up storage access
echo "Setting up storage access..."
termux-setup-storage

# Set timezone to IST
echo "Setting timezone to IST..."
pkg install -y tzdata
export TZ='Asia/Kolkata'
echo "export TZ='Asia/Kolkata'" >> ~/.bashrc

# Install PM2 for process management
echo "Installing PM2..."
npm install -g pm2

# Install dependencies
echo "Installing project dependencies..."
npm install

# Create log directories
echo "Creating log directories..."
mkdir -p logs

echo "Setup complete!"
echo "To start the bot, run: node bot.js"
echo "To run in background with PM2, run: pm2 start bot.js --name whatsapp-bot"
echo "To view logs, run: pm2 logs whatsapp-bot"
