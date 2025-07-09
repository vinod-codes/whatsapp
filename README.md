# WhatsApp Bot - Lead Management

A powerful WhatsApp automation bot for lead management, built with Baileys and Node.js.

## 🚀 Quick Start

### For Termux (Android):

1. **Clone the repository:**
   ```bash
   git clone https://github.com/vinod-codes/whatsapp.git
   cd whatsapp
   ```

2. **Run setup script:**
   ```bash
   chmod +x setup-termux.sh
   ./setup-termux.sh
   ```

3. **Start the bot:**
   ```bash
   ./start-bot.sh
   ```
   OR
   ```bash
   npm start
   ```
   OR
   ```bash
   npm run menu
   ```

### For Windows:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/vinod-codes/whatsapp.git
   cd whatsapp
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the bot:**
   ```bash
   start-bot.bat
   ```
   OR
   ```bash
   npm start
   ```

## 📱 Easy Commands

After setup, you can use these simple commands:

### Termux:
```bash
./start-bot.sh    # Start with checks
npm start         # Quick start
npm run menu      # Start bot
npm run bot       # Alternative start
```

### Windows:
```bash
start-bot.bat     # Start with checks
npm start         # Quick start
npm run menu      # Start bot
```

## 🔧 Features

- **📤 Mass Messaging:** Send messages to groups and contacts
- **📇 Contact Management:** Add, remove, and manage contacts
- **📝 Pre-written Messages:** Group and personal message templates
- **🔍 Lead Detection:** AI-powered lead detection
- **📊 Lead Management:** Track and manage leads
- **🔄 Auto Responses:** Automatic responses to leads
- **📱 QR Code Authentication:** Easy WhatsApp login

## 📋 Menu Options

1. **📤 Mass Message to Groups** - Send messages to selected groups
2. **📬 Message Saved Contacts** - Send messages to saved contacts
3. **📁 View Saved Groups / Contacts** - View your saved lists
4. **📝 Use Pre-written Messages** - Manage message templates
5. **👥 Manage Groups** - Select groups for messaging
6. **📇 Manage Contacts** - Add/remove contacts
7. **🔐 Logout & Clear Session** - Clear WhatsApp session
8. **❌ Exit** - Close the bot

## 📝 Message Types

### Group Messages (Respectful):
- Professional tone with 🙏 and "Respected team"
- Suitable for group communications

### Personal Messages (Simple):
- Direct and simple communication
- Suitable for individual contacts

## 🔐 Authentication

1. Run the bot
2. Scan the QR code with WhatsApp
3. The bot will connect automatically

## 📁 File Structure

```
whatsapp-bot/
├── bot.js                 # Main bot file
├── start-bot.sh          # Termux start script
├── start-bot.bat         # Windows start script
├── setup-termux.sh       # Termux setup script
├── package.json          # Dependencies
├── mass-groups.json      # Saved groups
├── mass-contacts.json    # Saved contacts
├── group-messages.json   # Group message templates
├── personal-messages.json # Personal message templates
└── state/               # Bot state files
```

## 🛠️ Troubleshooting

### Common Issues:

1. **Node.js not found:**
   ```bash
   pkg install nodejs  # Termux
   # Download from nodejs.org for Windows
   ```

2. **Dependencies not installed:**
   ```bash
   npm install
   ```

3. **Permission denied:**
   ```bash
   chmod +x start-bot.sh
   chmod +x setup-termux.sh
   ```

4. **QR code not showing:**
   - Restart the bot
   - Clear auth folder: `rm -rf auth_info_baileys`

## 📞 Support

For issues or questions, please check the GitHub repository or create an issue.

## 📄 License

This project is licensed under the ISC License.

---

**Made with ❤️ for WhatsApp automation**
