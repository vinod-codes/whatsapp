#!/bin/bash

# Make WhatsApp Bot Command Global
# This script makes the bot command available from anywhere

echo "=========================================="
echo "    Making WhatsApp Bot Global"
echo "=========================================="
echo ""

# Get current directory
CURRENT_DIR="$(pwd)"

# Check if we're in the bot directory
if [ ! -f "bot.js" ]; then
    echo "❌ Error: Please run this script from the whatsapp-bot directory"
    echo "Navigate to the bot directory first:"
    echo "cd /path/to/whatsapp-bot"
    echo ""
    exit 1
fi

# Make the global command executable
chmod +x whatsapp-bot

# Create a symbolic link in /data/data/com.termux/files/usr/bin/
echo "🔗 Creating global command..."
if [ -d "/data/data/com.termux/files/usr/bin" ]; then
    # Termux environment
    sudo ln -sf "$CURRENT_DIR/whatsapp-bot" /data/data/com.termux/files/usr/bin/whatsapp-bot
    echo "✅ Global command created for Termux"
elif [ -d "/usr/local/bin" ]; then
    # Linux environment
    sudo ln -sf "$CURRENT_DIR/whatsapp-bot" /usr/local/bin/whatsapp-bot
    echo "✅ Global command created for Linux"
else
    echo "⚠️  Could not create global command automatically"
    echo "You can manually create an alias in your shell profile:"
    echo ""
    echo "Add this line to ~/.bashrc or ~/.zshrc:"
    echo "alias whatsapp-bot='$CURRENT_DIR/whatsapp-bot'"
    echo ""
    echo "Then run: source ~/.bashrc"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Now you can run the bot from anywhere using:"
echo "   whatsapp-bot"
echo ""
echo "The command will automatically:"
echo "   📍 Find the bot directory"
echo "   📦 Install dependencies if needed"
echo "   🚀 Start the bot"
echo "   📱 Show QR code for WhatsApp"
echo "" 