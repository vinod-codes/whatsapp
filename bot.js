// WhatsApp Bot for Lead Management
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// Configure logger - set to warn level to reduce verbosity
const logger = pino({
    level: 'warn',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
        },
    },
});

// Store for tracking processed messages to prevent duplicates
const processedMessages = new Map(); // Changed to Map to store timestamp with message ID

// File paths for persistent storage
const STATE_DIR = './state';
const LAST_GREETING_FILE = `${STATE_DIR}/last_greeting.json`;
const LAST_RESPONSE_FILE = `${STATE_DIR}/last_response.json`;
const MESSAGES_PER_DAY_FILE = `${STATE_DIR}/messages_per_day.json`;
const LAST_MESSAGE_DATE_FILE = `${STATE_DIR}/last_message_date.json`;

// Create state directory if it doesn't exist
if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
}

// Helper function to load state from file
function loadStateFromFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return new Map(Object.entries(JSON.parse(data)));
        }
    } catch (error) {
        console.error(`Error loading state from ${filePath}:`, error);
    }
    return new Map();
}

// Helper function to save state to file
function saveStateToFile(map, filePath) {
    try {
        const obj = Object.fromEntries(map);
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error saving state to ${filePath}:`, error);
    }
}

// Store for tracking when the last greeting was sent to each group
const lastGreetingSent = loadStateFromFile(LAST_GREETING_FILE);

// Store for tracking when the last test response was sent to each contact
// This prevents sending multiple test responses in a short time
const lastTestResponseSent = loadStateFromFile(LAST_RESPONSE_FILE);

// Store for tracking the number of messages sent per day in each group
// This limits the number of messages to 3 per day in each group
const messagesPerDayInGroup = loadStateFromFile(MESSAGES_PER_DAY_FILE);

// Store for tracking the date when messages were sent to each group
// This resets the counter when the day changes
const lastMessageDateInGroup = loadStateFromFile(LAST_MESSAGE_DATE_FILE);

// Map to track if we've already sent a response to a specific message ID
// This prevents duplicate responses to the same message
// Also stores timestamp for cleanup after 24 hours
const respondedToMessages = new Map();

// Flag to track if we're currently processing a message
// This prevents concurrent processing of the same message
let isProcessingMessage = false;

// Flag to track if we're currently sending a response
// This prevents sending multiple responses at the same time
let isSendingResponse = false;

// Maximum number of greeting messages to send per day in each group
// This only applies to greeting messages, not "Checking" messages
const MAX_GREETINGS_PER_DAY_IN_GROUP = 2;

// Updated: Full list of groups to monitor
const groupsToMonitor = [
    'Bajaj + Isha',
    'Bajaj+ Lakme Rajajinagar',
    'Bajaj+ Baby sience',
    'Bajaj + Cozmo BiIS',
    'Bajaj-Rehamo',
    'Bajaj+ Priya hearing',
    'Bajaj+ Hsn',
    'Bajaj +Partha Dasarahalli',
    'Bajaj + Ad gro (OZIVIT)',
    'Vice +bajaj rajaji nagar',
    'Bajaj +Rehabilations specialist',
    'Headz + Bajaj Finserv',
    'Bajaj + Nethradama Rajajinagar',
    'Bajaj+ Team Nathia',
    'Partha+Bajaj Bangalore',
    'Orane + Bajaj finserv',
    'Bajaj+ Dr Shetty',
    'Bajaj + Dr Agarwal rajaji nagar',
    'Bajaj -LC Group Bangalore',
    'Bajaj Finance+Smiles.ai'
];

// Enhanced professional greetings with more options
const professionalGreetings = {
    morning: [
        "Good Morning Team! ☀️ Let's kickstart the day with some fresh leads. Please share any available leads, and we'll close them ASAP! 💪",
        "Good Morning Team! Welcome to a brand-new month! 🌟 Let's start strong—please share any leads, and we'll process them with 100% strike rate. Let's do this! ✅",
        "Good Morning Team! We're close to hitting our targets! 🎯 Please share any leads available, and we'll ensure they're closed swiftly. Let's finish strong together! 🙌"
    ],
    afternoon: [
        "Good Afternoon Team! Hope you're having a great day. Kindly share any leads available, and we'll get them processed quickly. Let's make it happen! 🚀",
        "Good Afternoon Team! It's midweek, and we're in high gear! 🔥 Kindly share any leads available, and we'll close them as fast as possible. Teamwork makes the dream work! 💪",
        "Hello Team! Let's keep the momentum going! 🚀 Please share any leads on hand, and we'll get them done ASAP. Your efforts make all the difference! 💼"
    ],
    evening: [
        "Good Evening Team! 🌙 As we wrap up the day, please share any leads you have. We're ready to close them ASAP. Your support is key! 🙌",
        "Hi Team! Good Evening! 😊 Just a quick nudge—please share any leads you've got. We're ready to take them on and close them ASAP. Thank you! ✌️",
        "Good Evening Team! Let's finish the day strong! Share any leads, and we'll process them first thing tomorrow. Your contribution matters! 🌟"
    ],
    weekend: [
        "Good Afternoon Team! It's the weekend, and we're fired up! 🔥 Please share any leads available, and we'll ensure they're handled with 100% commitment. Let's crush it! ✅",
        "Happy Weekend Team! 🌞 Let's make the most of it! Share any leads, and we'll process them with full dedication. Weekend warriors unite! 💪",
        "Weekend Greetings Team! 🎉 Keep the leads coming! We're here to process them with maximum efficiency. Let's make this weekend count! 🚀"
    ],
    monthEnd: [
        "Good Morning Respected Team! 💐 Only a few days left this month—let's make it count! Share maximum leads, and we'll close them with full speed. Thank you for your support! 🙏",
        "Team! Month-end push is on! 🎯 Share all available leads, and we'll process them with priority. Let's end this month on a high note! 💪",
        "Final Days of the Month! 🌟 Let's give it our all! Share your leads, and we'll ensure they're closed successfully. Together we can do it! 🙌"
    ]
};

// Enhanced lead detection patterns
const leadPatterns = {
    customerInfo: {
        name: /(?:name|pt name|customer name)[\s:]+([^\n]+)/i,
        phone: /(?:ph\.?\s*no|mobile|number|contact)[\s:]+(\d{10,})/i,
        email: /(?:email|gmail|mail)[\s:]+([^\s@]+@[^\s@]+\.[^\s@]+)/i
    },
    loanInfo: {
        amount: /(?:loan|amount|rs\.?|total)[\s:]+(?:of|is)?\s*(\d+(?:,\d+)*(?:\.\d+)?)/i,
        tenure: /(?:tenure|duration)[\s:]+(\d+)\s*(?:months|years?)/i,
        emi: /(?:emi|monthly)[\s:]+(?:of|is)?\s*(\d+(?:,\d+)*(?:\.\d+)?)/i
    },
    location: {
        branch: /(?:branch|location|area)[\s:]+([^\n]+)/i,
        city: /(?:city|town)[\s:]+([^\n]+)/i
    }
};

// Enhanced vibration patterns
const vibrationPatterns = {
    newLead: {
        duration: 1000,
        pattern: [500, 200, 500] // Vibrate, pause, vibrate
    },
    urgentLead: {
        duration: 1500,
        pattern: [300, 100, 300, 100, 300] // Three quick vibrations
    }
};

// Test lead templates
const testLeadTemplates = {
    basic: {
        name: "Test Customer",
        phone: "9876543210",
        loan: "50,000",
        branch: "Bangalore"
    },
    urgent: {
        name: "Urgent Customer",
        phone: "9876543211",
        loan: "1,00,000",
        branch: "Rajajinagar",
        urgency: "ASAP"
    },
    weekend: {
        name: "Weekend Customer",
        phone: "9876543212",
        loan: "75,000",
        branch: "Marathahalli",
        timing: "Weekend"
    },
    monthEnd: {
        name: "Month End Customer",
        phone: "9876543213",
        loan: "2,00,000",
        branch: "HSR Layout",
        timing: "Month End"
    }
};

// Function to format test lead
function formatTestLead(template) {
    return `Name: ${template.name}
Phone: ${template.phone}
Loan: ${template.loan}
Branch: ${template.branch}
${template.urgency ? `Urgency: ${template.urgency}` : ''}
${template.timing ? `Timing: ${template.timing}` : ''}`;
}

// Function to get appropriate greeting based on time and date
function getTimeBasedGreeting() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    const date = now.getDate();
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    
    // Check if it's weekend (Saturday = 6, Sunday = 0)
    if (day === 0 || day === 6) {
        const weekendGreetings = professionalGreetings.weekend;
        return weekendGreetings[Math.floor(Math.random() * weekendGreetings.length)];
    }
    
    // Check if it's month end (last 3 days of the month)
    if (date >= lastDayOfMonth - 2) {
        const monthEndGreetings = professionalGreetings.monthEnd;
        return monthEndGreetings[Math.floor(Math.random() * monthEndGreetings.length)];
    }
    
    // Regular time-based greetings
    let timeOfDay;
    if (hour < 12) {
        timeOfDay = 'morning';
    } else if (hour < 17) {
        timeOfDay = 'afternoon';
    } else {
        timeOfDay = 'evening';
    }
    
    const greetings = professionalGreetings[timeOfDay];
    return greetings[Math.floor(Math.random() * greetings.length)];
}

// Enhanced lead detection function
function isLeadMessage(message) {
    if (!message) return false;
    
    const msg = message.toLowerCase();
    let isLead = false;
    let leadDetails = {};
    
    // Check for customer information
    if (leadPatterns.customerInfo.name.test(msg) || 
        leadPatterns.customerInfo.phone.test(msg) || 
        leadPatterns.customerInfo.email.test(msg)) {
        isLead = true;
        leadDetails.hasCustomerInfo = true;
    }
    
    // Check for loan information
    if (leadPatterns.loanInfo.amount.test(msg) || 
        leadPatterns.loanInfo.tenure.test(msg) || 
        leadPatterns.loanInfo.emi.test(msg)) {
        isLead = true;
        leadDetails.hasLoanInfo = true;
    }
    
    // Check for location information
    if (leadPatterns.location.branch.test(msg) || 
        leadPatterns.location.city.test(msg)) {
        isLead = true;
        leadDetails.hasLocationInfo = true;
    }
    
    // Check for urgency indicators
    const urgentKeywords = ['asap', 'urgent', 'immediate', 'now', 'today'];
    if (urgentKeywords.some(keyword => msg.includes(keyword))) {
        leadDetails.isUrgent = true;
    }
    
    return { isLead, leadDetails };
}

// Test contacts (kept for reference but no longer used)
// Now all leads get responses based on time rules
const testContacts = [
    "918123361016@s.whatsapp.net",  // Vinod's number
    "919686693567@s.whatsapp.net"   // Pooja's number
];

// Set to false to disable alerts for new leads
const sendLeadAlerts = false;

// Set to true to make the phone vibrate on new leads (only works on Termux)
const vibrateOnNewLeads = true;

// Vibration duration in milliseconds
const vibrationDuration = 1000;

// Function to vibrate phone for lead notification
async function vibrateForLead(leadDetails) {
    try {
        if (!vibrateOnNewLeads) return;

        const { exec } = require('child_process');
        const platform = process.platform;

        if (platform === 'android') {
            console.log('📳 Vibrating for lead notification...');
            
            // Choose vibration pattern based on lead details
            const pattern = leadDetails.isUrgent ? 
                vibrationPatterns.urgentLead : 
                vibrationPatterns.newLead;
            
            // Execute vibration pattern
            for (let i = 0; i < pattern.pattern.length; i++) {
                if (i % 2 === 0) { // Vibrate
                    await new Promise(resolve => {
                        exec(`termux-vibrate -d ${pattern.pattern[i]}`, (error) => {
                            if (error) {
                                console.error('Vibration error:', error);
                            }
                            resolve();
                        });
                    });
                } else { // Pause
                    await new Promise(resolve => setTimeout(resolve, pattern.pattern[i]));
                }
            }
            
            console.log('📳 Vibration pattern completed');
        } else {
            console.log(`[Vibration skipped - only works on Android]`);
        }
    } catch (error) {
        console.error('Error in vibrateForLead:', error);
    }
}

// Function to send lead alert to admin
async function sendLeadAlert(sock, source, message, leadDetails) {
    if (!sendLeadAlerts) {
        console.log(`📵 Lead alert skipped (alerts are disabled)`);
        return; // Skip if alerts are disabled
    }

    try {
        const now = new Date();
        const formattedTime = now.toLocaleTimeString();
        const formattedDate = now.toLocaleDateString();

        // Create a formatted alert message
        const alertMessage = `🔔 *NEW LEAD DETECTED!*\n\n` +
                           `📅 *Date:* ${formattedDate}\n` +
                           `⏰ *Time:* ${formattedTime}\n` +
                           `📱 *Source:* ${source}\n\n` +
                           `💬 *Message:*\n${message}\n\n` +
                           `📊 *Lead Details:*\n${JSON.stringify(leadDetails)}\n\n` +
                           `_Respond directly to the lead in the original chat._`;

        // Send the alert to admin
        await sock.sendMessage(adminNumber, { text: alertMessage });
        console.log(`Lead alert sent to admin: ${adminNumber}`);
    } catch (error) {
        console.error('Error sending lead alert:', error);
    }
}

// Test groups for greeting testing
const testGroups = [
    'Bajaj + Isha',
    'Bajaj+ Lakme Rajajinagar',
    'Bajaj+ Baby sience'
];

// === Main Control Menu ===
function startTestMenu(sock) {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    const sisterNumber = '919686693567@s.whatsapp.net';

    // Track menu state
    let isMonitoring = true;
    let leadStats = {
        totalLeads: 0,
        todayLeads: 0,
        urgentLeads: 0
    };

    function showMenu() {
        console.log('\n========================================');
        console.log('         WHATSAPP LEAD MONITOR          ');
        console.log('========================================');
        console.log('1. Send Greetings');
        console.log('2. View Lead Statistics');
        console.log('3. View Active Groups');
        console.log('4. Exit');
        console.log('========================================');
        rl.question('\nChoose an option: ', async (answer) => {
            switch(answer) {
                case '1':
                    console.log('\n========================================');
                    console.log('            SEND GREETINGS              ');
                    console.log('========================================');
                    console.log('1. Send to Sister');
                    console.log('2. Send to All Groups');
                    console.log('3. Back to Main Menu');
                    console.log('========================================');
                    rl.question('\nSelect target: ', async (target) => {
                        if (target === '3') {
                            showMenu();
                            return;
                        }

                        console.log('\n========================================');
                        console.log('            GREETING TYPES            ');
                        console.log('========================================');
                        console.log('1. Morning Greeting');
                        console.log('2. Afternoon Greeting');
                        console.log('3. Evening Greeting');
                        console.log('4. Weekend Greeting');
                        console.log('5. Month-End Greeting');
                        console.log('6. Back to Previous Menu');
                        console.log('========================================');
                        rl.question('\nSelect greeting type: ', async (type) => {
                            if (type === '6') {
                                showMenu();
                                return;
                            }

                            let greeting;
                            switch(type) {
                                case '1':
                                    greeting = professionalGreetings.morning[0];
                                    break;
                                case '2':
                                    greeting = professionalGreetings.afternoon[0];
                                    break;
                                case '3':
                                    greeting = professionalGreetings.evening[0];
                                    break;
                                case '4':
                                    greeting = professionalGreetings.weekend[0];
                                    break;
                                case '5':
                                    greeting = professionalGreetings.monthEnd[0];
                                    break;
                                default:
                                    console.log('Invalid option.');
                                    showMenu();
                                    return;
                            }

                            try {
                                if (target === '1') {
                                    // Send to sister
                                    await sock.sendMessage(sisterNumber, { text: greeting });
                                    console.log('✅ Greeting sent to sister!');
                                } else if (target === '2') {
                                    // Send to all groups
                                    console.log('\nSending greetings to all groups...');
                                    for (const group of groupsToMonitor) {
                                        try {
                                            const groupId = await sock.groupGetIdFromInviteLink(group);
                                            if (groupId) {
                                                await sock.sendMessage(groupId, { text: greeting });
                                                console.log(`✅ Greeting sent to: ${group}`);
                                            }
                                        } catch (e) {
                                            console.log(`❌ Failed to send to ${group}: ${e.message}`);
                                        }
                                    }
                                    console.log('\n✅ Greeting distribution completed!');
                                }
                            } catch (e) {
                                console.log('❌ Failed to send greeting:', e.message);
                            }
                            showMenu();
                        });
                    });
                    break;

                case '2':
                    console.log('\n========================================');
                    console.log('           LEAD STATISTICS             ');
                    console.log('========================================');
                    console.log(`📊 Total Leads: ${leadStats.totalLeads}`);
                    console.log(`📈 Today's Leads: ${leadStats.todayLeads}`);
                    console.log(`⚠️ Urgent Leads: ${leadStats.urgentLeads}`);
                    console.log('========================================\n');
                    showMenu();
                    break;

                case '3':
                    console.log('\n========================================');
                    console.log('           ACTIVE GROUPS              ');
                    console.log('========================================');
                    groupsToMonitor.forEach((group, index) => {
                        console.log(`${index + 1}. ${group}`);
                    });
                    console.log('========================================\n');
                    showMenu();
                    break;

                case '4':
                    console.log('\n========================================');
                    console.log('           SHUTTING DOWN              ');
                    console.log('========================================');
                    console.log('Thank you for using WhatsApp Lead Monitor');
                    console.log('========================================\n');
                    rl.close();
                    process.exit(0);
                    break;

                default:
                    console.log('Invalid option.');
                    showMenu();
            }
        });
    }

    // Export the state for use in message handling
    global.botState = {
        isMonitoring,
        updateLeadStats: (isUrgent) => {
            leadStats.totalLeads++;
            leadStats.todayLeads++;
            if (isUrgent) leadStats.urgentLeads++;
        }
    };

    showMenu();
}

// Main function to start the WhatsApp bot
async function startWhatsAppBot() {
    // Authentication state
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Create WhatsApp socket connection
    const sock = makeWASocket({
        auth: state,
        logger: logger,
    });

    // Handle connection events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // If QR code is received, display it
        if (qr) {
            console.log('Scan this QR code to authenticate:');
            qrcode.generate(qr, { small: true });
            console.log('If QR code is not visible, restart the bot or try a different terminal');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            console.log('Connection closed due to:', lastDisconnect?.error?.message);

            if (shouldReconnect) {
                console.log('Reconnecting...');
                startWhatsAppBot();
            } else {
                console.log('Not reconnecting.');
            }
        } else if (connection === 'open') {
            console.log('\n========================================');
            console.log('         CONNECTION ESTABLISHED         ');
            console.log('========================================');
            console.log('📱 MONITORING GROUPS:');
            groupsToMonitor.forEach((group, index) => {
                console.log(`   ${index + 1}. ${group}`);
            });
            console.log('\n🔍 MONITORING KEYWORDS:');
            console.log('   • Leads, clients, contacts');
            console.log('   • Cases, approvals, payments');
            console.log('   • CRM entries, OPP numbers');
            console.log('   • Bajaj Finance related terms');
            console.log('\n📝 MESSAGE LOGGING:');
            console.log('   • All messages will be displayed below');
            console.log('   • Lead information logged to leads_log.txt');
            console.log('========================================\n');

            // Check if we're on Android and remind about Termux API
            if (process.platform === 'android' && vibrateOnNewLeads) {
                console.log('\n⚠️ IMPORTANT: For vibration to work on Android, you need Termux API');
                console.log('Run these commands in Termux if you haven\'t already:');
                console.log('1. pkg update && pkg upgrade');
                console.log('2. pkg install termux-api termux-services');
                console.log('3. termux-setup-storage');
            }

            console.log('========================================\n');
        }
    });

    // Save credentials whenever they're updated
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        // Use a lock to prevent concurrent processing
        if (isProcessingMessage) {
            console.log("⏳ Already processing a message, skipping...");
            return;
        }

        isProcessingMessage = true;

        try {
            for (const message of messages) {
                // Skip if message has been processed already (prevent duplicates)
                const messageId = message.key.id;
                if (processedMessages.has(messageId)) {
                    console.log(`⏭️ Skipping already processed message: ${messageId}`);
                    continue;
                }

                // Mark message as processed with current timestamp
                const now = Date.now();
                processedMessages.set(messageId, now);
                console.log(`✅ Processing message: ${messageId}`);

                // Clean up old messages (older than 24 hours) to prevent memory leaks
                const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
                for (const [id, timestamp] of processedMessages.entries()) {
                    if (now - timestamp > ONE_DAY_MS) {
                        processedMessages.delete(id);
                        console.log(`🧹 Removed old message from history: ${id}`);
                    }
                }

                // Skip messages sent by the bot itself
                if (message.key.fromMe) continue;

                // Get message content
                const messageContent = message.message?.conversation ||
                                      message.message?.extendedTextMessage?.text ||
                                      message.message?.imageMessage?.caption ||
                                      '';

                // Skip empty messages
                if (!messageContent) continue;

                // Check if message is from a group
                const isGroup = message.key.remoteJid.endsWith('@g.us');

                // For group messages, check if it's from a monitored group
                if (isGroup) {
                    try {
                        // Get group metadata
                        const groupMetadata = await sock.groupMetadata(message.key.remoteJid);
                        const groupName = groupMetadata.subject;

                        // Skip if monitoring is disabled
                        if (!global.botState.isMonitoring) {
                            console.log('⏸️ Lead monitoring is currently disabled');
                            return;
                        }

                        // Get sender info if available
                        let senderName = "Unknown";
                        if (message.key.participant) {
                            try {
                                const [senderNumber] = message.key.participant.split('@');
                                senderName = senderNumber;
                            } catch (e) {
                                // Just use the default if there's an error
                            }
                        }

                        // Always log all messages from all groups for visibility
                        const timestamp = new Date().toLocaleTimeString();
                        console.log(`\n[${timestamp}] 📱 GROUP MESSAGE:`);
                        console.log(`📝 Group: ${groupName}`);
                        console.log(`👤 Sender: ${senderName}`);
                        console.log(`💬 Message: ${messageContent}`);
                        console.log(`------------------------------------------`);

                        // We no longer need to check for test contacts
                        // All leads will get responses based on time rules

                        // Check if this is a monitored group
                        const isMonitoredGroup = groupsToMonitor.includes(groupName) ||
                                                groupsToMonitor.some(name => groupName.includes(name));

                        if (isMonitoredGroup) {
                            console.log(`✅ This is a monitored group!`);

                            // Check if message appears to be a lead
                            const leadResult = isLeadMessage(messageContent);

                            // Only proceed if it's a lead message
                            if (leadResult.isLead) {
                                console.log(`🔔 LEAD DETECTED in message!`);
                                console.log(`📊 Lead Details:`, leadResult.leadDetails);

                                // Update lead statistics
                                global.botState.updateLeadStats(leadResult.leadDetails.isUrgent);

                                // Log the message with enhanced details
                                logLead(`Group: "${groupName}"`, messageContent, leadResult.leadDetails);

                                // Vibrate with appropriate pattern
                                await vibrateForLead(leadResult.leadDetails);

                                // Send alert to admin with enhanced details
                                await sendLeadAlert(sock, `Group: ${groupName}`, messageContent, leadResult.leadDetails);

                                // Send time-based greeting
                                const greeting = getTimeBasedGreeting();
                                await sock.sendMessage(message.key.remoteJid, { text: greeting });
                                console.log(`✉️ Time-based greeting sent: "${greeting}"`);

                                // Send a "Checking" message for all leads, not just test contacts
                                {
                                    // Check if we've already responded to this specific message
                                    if (respondedToMessages.has(message.key.id)) {
                                        console.log(`⏱️ Skipping response - already responded to this message ID: ${message.key.id}`);
                                        return;
                                    }

                                    // Clean up old responded messages (older than 24 hours)
                                    const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
                                    const currentTime = Date.now();
                                    for (const [id, timestamp] of respondedToMessages.entries()) {
                                        if (currentTime - timestamp > ONE_DAY_MS) {
                                            respondedToMessages.delete(id);
                                            console.log(`🧹 Removed old response record: ${id}`);
                                        }
                                    }

                                    const now = new Date().getTime();
                                    const lastResponse = lastTestResponseSent.get(message.key.remoteJid) || 0;
                                    const minutesSinceLastResponse = (now - lastResponse) / (1000 * 60);

                                    // Only send a response if it's been at least 60 minutes (1 hour) since the last one
                                    // or if this is the first lead from this contact in this group
                                    if (minutesSinceLastResponse >= 60 || lastResponse === 0) {
                                        // Check if we're already sending a response
                                        if (isSendingResponse) {
                                            console.log(`⏳ Already sending a response, skipping...`);
                                            return;
                                        }

                                        // Check daily message limit for this group
                                        const today = new Date().toDateString();
                                        const lastDate = lastMessageDateInGroup.get(message.key.remoteJid) || '';
                                        let messageCount = 0;

                                        // Reset counter if day has changed
                                        if (lastDate !== today) {
                                            messagesPerDayInGroup.set(message.key.remoteJid, 0);
                                            lastMessageDateInGroup.set(message.key.remoteJid, today);
                                        }

                                        // Get current message count for today
                                        messageCount = messagesPerDayInGroup.get(message.key.remoteJid) || 0;

                                        // For "Checking" messages, we don't apply the daily limit
                                        // We only use the 1-hour cooldown between messages

                                        try {
                                            isSendingResponse = true;
                                            const testResponse = "Checking team";
                                            await sock.sendMessage(message.key.remoteJid, { text: testResponse });
                                            console.log(`✉️ Test response sent: "${testResponse}"`);

                                            // Update the last response time
                                            lastTestResponseSent.set(message.key.remoteJid, now);
                                            saveStateToFile(lastTestResponseSent, LAST_RESPONSE_FILE);

                                            // Mark this message as responded to with timestamp
                                            respondedToMessages.set(message.key.id, Date.now());

                                            // Increment the daily message counter
                                            messagesPerDayInGroup.set(message.key.remoteJid, messageCount + 1);
                                            saveStateToFile(messagesPerDayInGroup, MESSAGES_PER_DAY_FILE);

                                            // Update the last message date
                                            lastMessageDateInGroup.set(message.key.remoteJid, today);
                                            saveStateToFile(lastMessageDateInGroup, LAST_MESSAGE_DATE_FILE);

                                            console.log(`📊 "Checking" message sent (1-hour cooldown applies)`);
                                        } finally {
                                            isSendingResponse = false;
                                        }

                                        // Limit the size of respondedToMessages set to prevent memory leaks
                                        if (respondedToMessages.size > 1000) {
                                            const iterator = respondedToMessages.values();
                                            for (let i = 0; i < 200; i++) {
                                                respondedToMessages.delete(iterator.next().value);
                                            }
                                        }
                                    } else {
                                        console.log(`⏱️ Skipping response - last response was ${minutesSinceLastResponse.toFixed(1)} minutes ago`);
                                    }
                                }

                                // For regular leads, check time-based rules
                                const now = new Date().getTime();
                                const lastGreeting = lastGreetingSent.get(message.key.remoteJid) || 0;
                                const hoursSinceLastGreeting = (now - lastGreeting) / (1000 * 60 * 60);

                                // Only send greeting if it's been at least 1 hour since the last one
                                if (hoursSinceLastGreeting >= 1) {
                                    // Check daily message limit for this group
                                    const today = new Date().toDateString();
                                    const lastDate = lastMessageDateInGroup.get(message.key.remoteJid) || '';
                                    let messageCount = 0;

                                    // Reset counter if day has changed
                                    if (lastDate !== today) {
                                        messagesPerDayInGroup.set(message.key.remoteJid, 0);
                                        lastMessageDateInGroup.set(message.key.remoteJid, today);
                                    }

                                    // Get current message count for today
                                    messageCount = messagesPerDayInGroup.get(message.key.remoteJid) || 0;

                                    // Check if we've reached the daily limit for greetings
                                    if (messageCount >= MAX_GREETINGS_PER_DAY_IN_GROUP) {
                                        console.log(`⚠️ Daily greeting limit (${MAX_GREETINGS_PER_DAY_IN_GROUP} times per day) reached for this group. Skipping greeting.`);
                                        return;
                                    }

                                    const greeting = getTimeBasedGreeting();

                                    // Only send greeting if within allowed hours (9 AM - 5 PM)
                                    if (greeting && global.botState.isGreeting) {
                                        await sock.sendMessage(message.key.remoteJid, { text: greeting });
                                        console.log(`✉️ Greeting sent: "${greeting}"`);
                                        lastGreetingSent.set(message.key.remoteJid, now);
                                        saveStateToFile(lastGreetingSent, LAST_GREETING_FILE);

                                        // Increment the daily message counter
                                        messagesPerDayInGroup.set(message.key.remoteJid, messageCount + 1);
                                        saveStateToFile(messagesPerDayInGroup, MESSAGES_PER_DAY_FILE);

                                        // Update the last message date
                                        lastMessageDateInGroup.set(message.key.remoteJid, today);
                                        saveStateToFile(lastMessageDateInGroup, LAST_MESSAGE_DATE_FILE);

                                        console.log(`📊 Greeting message count for today: ${messageCount + 1}/${MAX_GREETINGS_PER_DAY_IN_GROUP}`);
                                    }
                                }
                            } else {
                                console.log(`❌ No lead keywords detected in this message`);
                            }
                        } else {
                            console.log(`❌ Not a monitored group`);
                        }
                    } catch (error) {
                        console.error('Error processing group message:', error);
                    }
                } else {
                    // Handle direct messages
                    // Get sender info
                    const [senderNumber] = message.key.remoteJid.split('@');

                    // Skip if monitoring is disabled
                    if (!global.botState.isMonitoring) {
                        console.log('⏸️ Lead monitoring is currently disabled');
                        return;
                    }

                    // Always log all direct messages for visibility
                    const timestamp = new Date().toLocaleTimeString();
                    console.log(`\n[${timestamp}] 📱 DIRECT MESSAGE:`);
                    console.log(`👤 Sender: ${senderNumber}`);
                    console.log(`💬 Message: ${messageContent}`);
                    console.log(`------------------------------------------`);

                    // We no longer need to check for test contacts
                    // All leads will get responses based on time rules

                    // Check if it's a lead message
                    const leadResult = isLeadMessage(messageContent);

                    // Only proceed if it's a lead message
                    if (leadResult.isLead) {
                        console.log(`🔔 LEAD DETECTED in direct message!`);
                        console.log(`📊 Lead Details:`, leadResult.leadDetails);

                        // Log the message with enhanced details
                        logLead(`Contact: "${message.key.remoteJid}"`, messageContent, leadResult.leadDetails);

                        // Vibrate with appropriate pattern
                        await vibrateForLead(leadResult.leadDetails);

                        // Send alert to admin with enhanced details
                        await sendLeadAlert(sock, `Direct Message: ${message.key.remoteJid}`, messageContent, leadResult.leadDetails);

                        // Send a "Checking" message for all leads, not just test contacts
                        {
                            // Check if we've already responded to this specific message
                            if (respondedToMessages.has(message.key.id)) {
                                console.log(`⏱️ Skipping response - already responded to this message ID: ${message.key.id}`);
                                return;
                            }

                            // Clean up old responded messages (older than 24 hours)
                            const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
                            const currentTime = Date.now();
                            for (const [id, timestamp] of respondedToMessages.entries()) {
                                if (currentTime - timestamp > ONE_DAY_MS) {
                                    respondedToMessages.delete(id);
                                    console.log(`🧹 Removed old response record: ${id}`);
                                }
                            }

                            const now = new Date().getTime();
                            const lastResponse = lastTestResponseSent.get(message.key.remoteJid) || 0;
                            const minutesSinceLastResponse = (now - lastResponse) / (1000 * 60);

                            // Only send a response if it's been at least 60 minutes (1 hour) since the last one
                            // or if this is the first lead from this contact
                            if (minutesSinceLastResponse >= 60 || lastResponse === 0) {
                                // Check if we're already sending a response
                                if (isSendingResponse) {
                                    console.log(`⏳ Already sending a response, skipping...`);
                                    return;
                                }

                                try {
                                    isSendingResponse = true;
                                    const testResponse = "Checking team";
                                    await sock.sendMessage(message.key.remoteJid, { text: testResponse });
                                    console.log(`✉️ Test response sent: "${testResponse}"`);

                                    // Update the last response time
                                    lastTestResponseSent.set(message.key.remoteJid, now);
                                    saveStateToFile(lastTestResponseSent, LAST_RESPONSE_FILE);

                                    // Mark this message as responded to with timestamp
                                    respondedToMessages.set(message.key.id, Date.now());
                                } finally {
                                    isSendingResponse = false;
                                }

                                // We now clean up old messages based on timestamp instead of size
                            } else {
                                console.log(`⏱️ Skipping response - last response was ${minutesSinceLastResponse.toFixed(1)} minutes ago`);
                            }
                        }

                        // For regular leads, check time-based rules
                        const now = new Date().getTime();
                        const lastGreeting = lastGreetingSent.get(message.key.remoteJid) || 0;
                        const hoursSinceLastGreeting = (now - lastGreeting) / (1000 * 60 * 60);

                        // Only send greeting if it's been at least 1 hour since the last one
                        if (hoursSinceLastGreeting >= 1) {
                            const greeting = getTimeBasedGreeting();

                            // Only send greeting if within allowed hours (9 AM - 5 PM)
                            if (greeting && global.botState.isGreeting) {
                                await sock.sendMessage(message.key.remoteJid, { text: greeting });
                                console.log(`✉️ Greeting sent: "${greeting}"`);
                                lastGreetingSent.set(message.key.remoteJid, now);
                                saveStateToFile(lastGreetingSent, LAST_GREETING_FILE);
                            }
                        }
                    } else {
                        console.log(`❌ No lead keywords detected in this direct message`);
                    }
                }
            }
        } catch (error) {
            console.error('Error processing messages:', error);
        } finally {
            // Release the lock
            isProcessingMessage = false;
        }
    });

    return sock;
}

// Start the bot
startWhatsAppBot().then((sock) => {
    // Start the test menu in parallel (non-blocking)
    setTimeout(() => startTestMenu(sock), 2000);
});
