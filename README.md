# WhatsApp Lead Monitor Bot

A WhatsApp bot for monitoring and managing leads in Bajaj Finance groups.

## Repository
https://github.com/vinod-codes/whatsapp-messenger.git

## Features
- Monitors all Bajaj Finance groups automatically
- Detects leads in messages
- Sends professional greetings
- Tracks lead statistics
- Vibrates phone for new leads (Android only)
- Sends alerts to admin

## Setup Instructions for Android

### Prerequisites
1. Install Termux from F-Droid
2. Basic understanding of command line

### Installation Steps

1. **Open Termux and update packages:**
```bash
pkg update && pkg upgrade
```

2. **Install required packages:**
```bash
pkg install nodejs
pkg install git
pkg install termux-api
pkg install termux-services
```

3. **Setup storage permissions:**
```bash
termux-setup-storage
```

4. **Clone the repository:**
```bash
cd storage/downloads
git clone https://github.com/vinod-codes/whatsapp-messenger.git
cd whatsapp-messenger
```

5. **Install dependencies:**
```bash
npm install
```

### Running the Bot

1. **Start the bot:**
```bash
node bot.js
```

2. **Scan QR Code:**
- When the QR code appears, scan it with WhatsApp
- Open WhatsApp > Menu > Linked Devices > Link a Device
- Scan the QR code shown in Termux

3. **Bot Features:**
- Automatically monitors all configured groups
- Detects and responds to leads
- Sends greetings to groups
- Tracks lead statistics

4. **To stop the bot:**
- Press Ctrl+C in Termux
- Or select option 4 (Exit) from the menu

### Important Notes
- Keep Termux running in the background
- Don't close Termux while the bot is running
- Make sure your phone doesn't go into deep sleep
- Keep WhatsApp Web active

### Troubleshooting
1. If the bot stops responding:
   - Check if Termux is still running
   - Restart the bot using `node bot.js`

2. If QR code doesn't appear:
   - Delete the `auth_info_baileys` folder
   - Restart the bot

3. If messages aren't being sent:
   - Check your internet connection
   - Make sure WhatsApp Web is active
   - Restart the bot

## Project Structure
```
whatsapp-messenger/
├── bot.js              # Main bot code
├── requirements.txt    # Dependencies
├── start-bot.bat      # Windows start script
└── README.md          # This file
```

## Contributing
1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## Support
For any issues or questions, please contact the developer.

## License
MIT License
