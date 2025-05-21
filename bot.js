// WhatsApp Bot for Lead Management
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// Message Queue System
class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxRetries = 2; // Reduced retries
        this.retryDelay = 2000; // Reduced delay to 2 seconds
        this.batchSize = 5; // Process multiple messages at once
    }

    async add(message) {
        this.queue.push({
            ...message,
            retries: 0,
            timestamp: Date.now()
        });
        if (!this.processing) {
            await this.process();
        }
    }

    async process() {
        if (this.processing || this.queue.length === 0) return;
        
        this.processing = true;
        while (this.queue.length > 0) {
            const batch = this.queue.splice(0, this.batchSize);
            await Promise.all(batch.map(message => this.sendMessage(message)));
        }
        this.processing = false;
    }

    async sendMessage(message) {
        try {
            if (!message.sock) {
                throw new Error('No socket connection available');
            }
            await message.sock.sendMessage(message.to, { text: message.text });
        } catch (error) {
            console.error('Error sending message:', error);
            if (message.retries < this.maxRetries) {
                message.retries++;
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                this.queue.unshift(message);
            }
        }
    }
}

// Create message queue instance
const messageQueue = new MessageQueue();

// State Management System
class StateManager {
    constructor() {
        this.stateDir = './state';
        this.backupDir = './state/backups';
        this.maxBackups = 5;
        this.backupInterval = 24 * 60 * 60 * 1000; // 24 hours
        this.initialize();
    }

    initialize() {
        // Create necessary directories
        if (!fs.existsSync(this.stateDir)) {
            fs.mkdirSync(this.stateDir, { recursive: true });
        }
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }

        // Start backup scheduler
        this.scheduleBackup();
    }

    scheduleBackup() {
        setInterval(() => this.createBackup(), this.backupInterval);
    }

    async createBackup() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(this.backupDir, `backup-${timestamp}`);

        try {
            // Create backup directory
            fs.mkdirSync(backupPath, { recursive: true });

            // Copy all state files
            const files = fs.readdirSync(this.stateDir);
            for (const file of files) {
                if (file !== 'backups') {
                    const sourcePath = path.join(this.stateDir, file);
                    const destPath = path.join(backupPath, file);
                    fs.copyFileSync(sourcePath, destPath);
                }
            }

            // Clean up old backups
            this.cleanupOldBackups();

            console.log(`✅ Backup created successfully at ${backupPath}`);
        } catch (error) {
            console.error('Error creating backup:', error);
        }
    }

    cleanupOldBackups() {
        try {
            const backups = fs.readdirSync(this.backupDir)
                .map(file => ({
                    name: file,
                    path: path.join(this.backupDir, file),
                    time: fs.statSync(path.join(this.backupDir, file)).mtime.getTime()
                }))
                .sort((a, b) => b.time - a.time);

            // Remove old backups
            while (backups.length > this.maxBackups) {
                const oldBackup = backups.pop();
                fs.rmSync(oldBackup.path, { recursive: true, force: true });
                console.log(`🧹 Removed old backup: ${oldBackup.name}`);
            }
        } catch (error) {
            console.error('Error cleaning up old backups:', error);
        }
    }

    async saveState(key, data) {
        try {
            const filePath = path.join(this.stateDir, `${key}.json`);
            const backupPath = `${filePath}.bak`;

            // Create backup of existing file
            if (fs.existsSync(filePath)) {
                fs.copyFileSync(filePath, backupPath);
            }

            // Write new data
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

            // Remove backup if write was successful
            if (fs.existsSync(backupPath)) {
                fs.unlinkSync(backupPath);
            }

            return true;
        } catch (error) {
            console.error(`Error saving state for ${key}:`, error);
            // Restore from backup if available
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, filePath);
            }
            return false;
        }
    }

    async loadState(key, defaultValue = {}) {
        try {
            const filePath = path.join(this.stateDir, `${key}.json`);
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                return JSON.parse(data);
            }
            return defaultValue;
        } catch (error) {
            console.error(`Error loading state for ${key}:`, error);
            return defaultValue;
        }
    }
}

// Create state manager instance
const stateManager = new StateManager();

// Rate Limiter
class RateLimiter {
    constructor() {
        this.limits = new Map();
        this.windows = new Map();
        this.defaultLimit = {
            messages: 10,    // 10 messages
            window: 60000,   // per minute
            cooldown: 5000   // 5 seconds between messages
        };
    }

    setLimit(key, limit) {
        this.limits.set(key, {
            ...this.defaultLimit,
            ...limit
        });
    }

    async checkLimit(key) {
        const limit = this.limits.get(key) || this.defaultLimit;
        const now = Date.now();
        
        // Initialize window if not exists
        if (!this.windows.has(key)) {
            this.windows.set(key, {
                messages: [],
                lastMessage: 0
            });
        }

        const window = this.windows.get(key);

        // Clean up old messages
        window.messages = window.messages.filter(time => now - time < limit.window);

        // Check if we're in cooldown
        if (now - window.lastMessage < limit.cooldown) {
            return {
                allowed: false,
                waitTime: limit.cooldown - (now - window.lastMessage)
            };
        }

        // Check if we've hit the message limit
        if (window.messages.length >= limit.messages) {
            return {
                allowed: false,
                waitTime: limit.window - (now - window.messages[0])
            };
        }

        // Update window
        window.messages.push(now);
        window.lastMessage = now;

        return { allowed: true };
    }

    async waitForLimit(key) {
        const result = await this.checkLimit(key);
        if (!result.allowed) {
            await new Promise(resolve => setTimeout(resolve, result.waitTime));
            return this.checkLimit(key);
        }
        return result;
    }
}

// Create rate limiter instance
const rateLimiter = new RateLimiter();

// Lead Management System
class LeadManager {
    constructor() {
        this.leads = new Map();
        this.categories = ['High', 'Medium', 'Low'];
        this.statuses = ['New', 'In Progress', 'Closed', 'Lost'];
        this.initialize();
    }

    async initialize() {
        // Load existing leads from state
        const savedLeads = await stateManager.loadState('leads', {});
        for (const [id, lead] of Object.entries(savedLeads)) {
            this.leads.set(id, lead);
        }
    }

    async createLead(data) {
        const id = `LEAD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const lead = {
            id,
            ...data,
            status: 'New',
            category: this.categorizeLead(data),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            history: [{
                action: 'Created',
                timestamp: new Date().toISOString(),
                details: 'Lead created'
            }]
        };

        this.leads.set(id, lead);
        await this.saveLeads();
        return lead;
    }

    categorizeLead(data) {
        // Simple categorization logic - can be enhanced
        if (data.isUrgent || data.amount > 100000) {
            return 'High';
        } else if (data.amount > 50000) {
            return 'Medium';
        }
        return 'Low';
    }

    async updateLead(id, updates) {
        const lead = this.leads.get(id);
        if (!lead) throw new Error('Lead not found');

        const updatedLead = {
            ...lead,
            ...updates,
            updatedAt: new Date().toISOString(),
            history: [
                ...lead.history,
                {
                    action: 'Updated',
                    timestamp: new Date().toISOString(),
                    details: JSON.stringify(updates)
                }
            ]
        };

        this.leads.set(id, updatedLead);
        await this.saveLeads();
        return updatedLead;
    }

    async assignLead(id, assignee) {
        return this.updateLead(id, { assignee });
    }

    async updateStatus(id, status) {
        if (!this.statuses.includes(status)) {
            throw new Error('Invalid status');
        }
        return this.updateLead(id, { status });
    }

    async getLeads(filters = {}) {
        let leads = Array.from(this.leads.values());

        // Apply filters
        if (filters.status) {
            leads = leads.filter(lead => lead.status === filters.status);
        }
        if (filters.category) {
            leads = leads.filter(lead => lead.category === filters.category);
        }
        if (filters.assignee) {
            leads = leads.filter(lead => lead.assignee === filters.assignee);
        }
        if (filters.dateRange) {
            leads = leads.filter(lead => {
                const date = new Date(lead.createdAt);
                return date >= filters.dateRange.start && date <= filters.dateRange.end;
            });
        }

        return leads;
    }

    async getLeadStats() {
        const leads = Array.from(this.leads.values());
        return {
            total: leads.length,
            byStatus: this.statuses.reduce((acc, status) => {
                acc[status] = leads.filter(lead => lead.status === status).length;
                return acc;
            }, {}),
            byCategory: this.categories.reduce((acc, category) => {
                acc[category] = leads.filter(lead => lead.category === category).length;
                return acc;
            }, {}),
            conversionRate: this.calculateConversionRate(leads)
        };
    }

    calculateConversionRate(leads) {
        const closed = leads.filter(lead => lead.status === 'Closed').length;
        const total = leads.length;
        return total > 0 ? (closed / total) * 100 : 0;
    }

    async saveLeads() {
        const leadsObj = Object.fromEntries(this.leads);
        await stateManager.saveState('leads', leadsObj);
    }
}

// Create lead manager instance
const leadManager = new LeadManager();

// OpenRouter API Configuration
const OPENROUTER_API_KEY = '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';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Lead Tracking System
class LeadTracker {
    constructor() {
        this.activeLeads = new Map();
        this.leadHistory = new Map();
        this.messageContext = new Map();
        this.leadIdentifiers = new Map();
        this.leadHandlers = new Map();
        this.identifierIndex = new Map(); // Add index for faster lookups
    }

    // Optimize identifier extraction
    extractIdentifiers(message) {
        const identifiers = {
            phone: null,
            email: null,
            pan: null,
            crm: null,
            opp: null,
            deal: null
        };

        // Use single regex for phone numbers
        const phoneMatch = message.match(/(?:\+91|91)?\s*\d{10}/);
        if (phoneMatch) identifiers.phone = phoneMatch[0].replace(/\D/g, '');

        // Use single regex for email
        const emailMatch = message.match(/[\w\.-]+@[\w\.-]+\.\w+/);
        if (emailMatch) identifiers.email = emailMatch[0];

        // Use single regex for PAN
        const panMatch = message.match(/[A-Z]{5}[0-9]{4}[A-Z]/);
        if (panMatch) identifiers.pan = panMatch[0];

        // Use single regex for IDs
        const idMatch = message.match(/(?:CRM|OPP|DEAL)\s*(?:NO|ID)?:?\s*([A-Z0-9]+)/i);
        if (idMatch) {
            const type = message.match(/(CRM|OPP|DEAL)/i)[1].toLowerCase();
            identifiers[type] = idMatch[1];
        }

        return identifiers;
    }

    // Optimize lead lookup
    getLeadByIdentifier(identifier) {
        // Check index first
        for (const [key, value] of Object.entries(identifier)) {
            if (value && this.identifierIndex.has(value)) {
                return this.getLeadById(this.identifierIndex.get(value));
            }
        }
        return null;
    }

    // Update addLead to maintain index
    addLead(groupId, lead) {
        if (!this.activeLeads.has(groupId)) {
            this.activeLeads.set(groupId, new Set());
        }

        const identifiers = this.extractIdentifiers(lead.message);
        const leadId = `LEAD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const enhancedLead = {
            ...lead,
            id: leadId,
            identifiers,
            status: 'active',
            lastUpdated: new Date().toISOString()
        };

        // Update index
        for (const [key, value] of Object.entries(identifiers)) {
            if (value) {
                this.identifierIndex.set(value, leadId);
            }
        }

        this.activeLeads.get(groupId).add(enhancedLead);
        this.leadIdentifiers.set(leadId, identifiers);
        this.addToHistory(enhancedLead);
        
        return enhancedLead;
    }

    // Add method to check if lead is being handled
    isLeadBeingHandled(leadId) {
        return this.leadHandlers.has(leadId);
    }

    // Add method to set lead handler
    setLeadHandler(leadId, handler) {
        this.leadHandlers.set(leadId, {
            handler,
            timestamp: Date.now()
        });
    }

    // Add method to check if message is about a handled lead
    isMessageAboutHandledLead(message) {
        const identifiers = this.extractIdentifiers(message);
        for (const [leadId, handler] of this.leadHandlers) {
            const lead = this.getLeadById(leadId);
            if (lead && this.hasMatchingIdentifiers(identifiers, lead.identifiers)) {
                return true;
            }
        }
        return false;
    }

    // Enhanced method to check if a message is related to an existing lead
    isRelatedToExistingLead(groupId, message) {
        const groupContext = this.messageContext.get(groupId) || [];
        const lastMessages = groupContext.slice(-5); // Check last 5 messages

        // Extract identifiers from the message
        const identifiers = this.extractIdentifiers(message);
        
        // Check if any identifier matches an existing lead
        for (const [id, lead] of this.leadIdentifiers) {
            if (this.hasMatchingIdentifiers(identifiers, lead)) {
                return true;
            }
        }

        // Check message context for related discussions
        const messageKeywords = this.extractKeywords(message);
        return lastMessages.some(prevMessage => {
            const prevKeywords = this.extractKeywords(prevMessage);
            return this.calculateSimilarity(messageKeywords, prevKeywords) > 0.7;
        });
    }

    // Get lead by ID
    getLeadById(leadId) {
        for (const [groupId, leads] of this.activeLeads) {
            for (const lead of leads) {
                if (lead.id === leadId) {
                    return lead;
                }
            }
        }
        return null;
    }

    // Add message to context
    addToContext(groupId, message) {
        if (!this.messageContext.has(groupId)) {
            this.messageContext.set(groupId, []);
        }
        const context = this.messageContext.get(groupId);
        context.push(message);
        if (context.length > 10) context.shift(); // Keep last 10 messages
    }

    // Add to lead history
    addToHistory(lead) {
        const key = `${lead.source}-${lead.sender}-${Date.now()}`;
        this.leadHistory.set(key, {
            ...lead,
            timestamp: new Date().toISOString()
        });
    }

    // Check if lead is new
    isNewLead(groupId, lead) {
        const groupLeads = this.activeLeads.get(groupId) || new Set();
        return !Array.from(groupLeads).some(existingLead => 
            this.areLeadsSimilar(existingLead, lead)
        );
    }

    // Compare two leads for similarity
    areLeadsSimilar(lead1, lead2) {
        const fields = ['phone', 'email', 'amount', 'location'];
        return fields.some(field => {
            if (lead1[field] && lead2[field]) {
                return lead1[field] === lead2[field];
            }
            return false;
        });
    }
}

// Create lead tracker instance
const leadTracker = new LeadTracker();

// Enhanced AI Lead Detection System with OpenRouter
class AILeadDetector {
    constructor() {
        this.confidenceThreshold = 0.7;
        this.cache = new Map(); // Add cache for recent messages
        this.cacheTimeout = 60000; // Cache timeout: 1 minute
    }

    // Add quick pattern check before API call
    quickPatternCheck(text) {
        const patterns = [
            /(?:loan|amount|emi|tenure)/i,
            /(?:customer|client|patient)/i,
            /(?:document|kyc|pan|aadhar)/i,
            /(?:approval|process|check)/i
        ];
        return patterns.some(pattern => pattern.test(text));
    }

    async analyzeText(text) {
        try {
            // Quick pattern check first
            if (!this.quickPatternCheck(text)) {
                return {
                    isLead: false,
                    confidence: 0,
                    priority: 'Low',
                    extractedInfo: {},
                    reasoning: 'No lead patterns found',
                    isNewLead: false,
                    relatedToExisting: false
                };
            }

            // Check cache first
            const cacheKey = text.toLowerCase().trim();
            const cached = this.cache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
                return cached.result;
            }

            // If not in cache, proceed with API call
            const response = await fetch(OPENROUTER_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://github.com/your-repo',
                    'X-Title': 'WhatsApp Lead Detector'
                },
                body: JSON.stringify({
                    model: "anthropic/claude-3-opus-20240229",
                    messages: [
                        {
                            role: "system",
                            content: `You are a lead detection AI specialized in financial services. 
                            Analyze the following message and determine if it's a potential lead.
                            Consider:
                            1. Is this a genuine lead or just casual conversation?
                            2. Does it contain specific financial service needs?
                            3. Is there actionable information?
                            
                            Respond in JSON format:
                            {
                                "isLead": boolean,
                                "confidence": number (0-1),
                                "priority": "High/Medium/Low",
                                "extractedInfo": {
                                    "contact": {
                                        "name": string,
                                        "phone": string,
                                        "email": string
                                    },
                                    "financial": {
                                        "amount": number,
                                        "purpose": string,
                                        "urgency": string
                                    },
                                    "location": {
                                        "city": string,
                                        "area": string
                                    }
                                },
                                "reasoning": "Brief explanation of why this is/isn't a lead",
                                "isNewLead": boolean,
                                "relatedToExisting": boolean
                            }`
                        },
                        {
                            role: "user",
                            content: text
                        }
                    ],
                    temperature: 0.3
                })
            });

            const data = await response.json();
            const analysis = JSON.parse(data.choices[0].message.content);

            // Cache the result
            this.cache.set(cacheKey, {
                result: analysis,
                timestamp: Date.now()
            });

            return analysis;
        } catch (error) {
            console.error('Error in AI analysis:', error);
            return {
                isLead: false,
                confidence: 0,
                priority: 'Low',
                extractedInfo: {},
                reasoning: 'Error in AI analysis',
                isNewLead: false,
                relatedToExisting: false
            };
        }
    }
}

// Create AI lead detector instance
const aiLeadDetector = new AILeadDetector();

// Enhanced Terminal UI
class TerminalUI {
    constructor() {
        this.colors = {
            reset: '\x1b[0m',
            bright: '\x1b[1m',
            dim: '\x1b[2m',
            underscore: '\x1b[4m',
            blink: '\x1b[5m',
            reverse: '\x1b[7m',
            hidden: '\x1b[8m',
            
            fg: {
                black: '\x1b[30m',
                red: '\x1b[31m',
                green: '\x1b[32m',
                yellow: '\x1b[33m',
                blue: '\x1b[34m',
                magenta: '\x1b[35m',
                cyan: '\x1b[36m',
                white: '\x1b[37m'
            },
            
            bg: {
                black: '\x1b[40m',
                red: '\x1b[41m',
                green: '\x1b[42m',
                yellow: '\x1b[43m',
                blue: '\x1b[44m',
                magenta: '\x1b[45m',
                cyan: '\x1b[46m',
                white: '\x1b[47m'
            }
        };
    }

    clearScreen() {
        process.stdout.write('\x1Bc');
    }

    printHeader(text) {
        const width = process.stdout.columns;
        const padding = Math.floor((width - text.length) / 2);
        console.log('\n' + '='.repeat(width));
        console.log(' '.repeat(padding) + this.colors.bright + text + this.colors.reset);
        console.log('='.repeat(width) + '\n');
    }

    printLead(lead) {
        console.log(this.colors.fg.cyan + '🔔 NEW LEAD DETECTED!' + this.colors.reset);
        console.log(this.colors.fg.yellow + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + this.colors.reset);
        
        // Priority indicator
        const priorityColor = {
            'High': this.colors.fg.red,
            'Medium': this.colors.fg.yellow,
            'Low': this.colors.fg.green
        }[lead.priority];
        
        console.log(`${priorityColor}Priority: ${lead.priority}${this.colors.reset}`);
        console.log(`${this.colors.fg.cyan}Confidence: ${(lead.confidence * 100).toFixed(1)}%${this.colors.reset}`);
        
        // Extracted information
        if (lead.extractedInfo) {
            console.log('\n' + this.colors.bright + 'Extracted Information:' + this.colors.reset);
            for (const [key, value] of Object.entries(lead.extractedInfo)) {
                console.log(`${this.colors.fg.magenta}${key}:${this.colors.reset} ${value}`);
            }
        }
        
        console.log(this.colors.fg.yellow + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + this.colors.reset + '\n');
    }

    printStats(stats) {
        console.log(this.colors.fg.cyan + '📊 LEAD STATISTICS' + this.colors.reset);
        console.log(this.colors.fg.yellow + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + this.colors.reset);
        
        console.log(`${this.colors.fg.green}Total Leads: ${stats.total}${this.colors.reset}`);
        console.log(`${this.colors.fg.blue}Conversion Rate: ${stats.conversionRate.toFixed(1)}%${this.colors.reset}`);
        
        console.log('\n' + this.colors.bright + 'By Status:' + this.colors.reset);
        for (const [status, count] of Object.entries(stats.byStatus)) {
            console.log(`${this.colors.fg.magenta}${status}:${this.colors.reset} ${count}`);
        }
        
        console.log('\n' + this.colors.bright + 'By Category:' + this.colors.reset);
        for (const [category, count] of Object.entries(stats.byCategory)) {
            console.log(`${this.colors.fg.magenta}${category}:${this.colors.reset} ${count}`);
        }
        
        console.log(this.colors.fg.yellow + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + this.colors.reset + '\n');
    }

    printMenu(options) {
        console.log(this.colors.fg.cyan + '📱 MENU OPTIONS' + this.colors.reset);
        console.log(this.colors.fg.yellow + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + this.colors.reset);
        
        options.forEach((option, index) => {
            console.log(`${this.colors.fg.green}${index + 1}.${this.colors.reset} ${option}`);
        });
        
        console.log(this.colors.fg.yellow + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + this.colors.reset + '\n');
    }

    printError(error) {
        console.log(this.colors.fg.red + '❌ ERROR: ' + error + this.colors.reset);
    }

    printSuccess(message) {
        console.log(this.colors.fg.green + '✅ ' + message + this.colors.reset);
    }

    printWarning(message) {
        console.log(this.colors.fg.yellow + '⚠️ ' + message + this.colors.reset);
    }
}

// Create terminal UI instance
const terminalUI = new TerminalUI();

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
    'Bajaj Finance+Smiles.ai',  // Added new group
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
];

// Add special group rules
const specialGroupRules = {
    'Bajaj Finance+Smiles.ai': {
        skipLocations: ['hyderabad', 'hyd', 'hitech city', 'gachibowli', 'secunderabad']
    }
};

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
        name: /(?:name|patient|cx|customer)[\s:]+([a-zA-Z\s]+)/i,
        phone: /(?:phone|mobile|number|contact)[\s:]*(\d{10})/i,
        email: /[\w\.-]+@[\w\.-]+\.\w+/i,
        pan: /(?:pan|pancard)[\s:]*([a-zA-Z0-9]{10})/i
    },
    loanInfo: {
        amount: /(?:amount|loan|limit)[\s:]*(\d+(?:\.\d{2})?)[k]?/i,
        tenure: /(?:tenure|scheme)[\s:]*(\d+)\/(\d+)/i,
        emi: /(?:emi|monthly)[\s:]*(\d+(?:\.\d{2})?)/i,
        topup: /(?:top\s*up|additional|more)[\s:]*(\d+(?:\.\d{2})?)[k]?/i
    },
    location: {
        branch: /(?:branch|area)[\s:]*([a-zA-Z\s]+)/i,
        city: /(?:city|location)[\s:]*([a-zA-Z\s]+)/i
    },
    urgency: {
        immediate: /(?:asap|urgent|immediate|now|today|waiting)/i,
        followup: /(?:follow\s*up|update|status|progress)/i
    },
    status: {
        existing: /(?:existing|current|old)[\s:]*customer/i,
        new: /(?:new|fresh)[\s:]*customer/i,
        approved: /(?:approved|eligible|available)/i,
        rejected: /(?:rejected|not\s*approved|not\s*eligible)/i
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
    let leadDetails = {
        hasCustomerInfo: false,
        hasLoanInfo: false,
        hasLocationInfo: false,
        isUrgent: false,
        isExistingCustomer: false,
        isNewCustomer: false,
        status: null,
        confidence: 0
    };
    
    // Check for customer information
    if (leadPatterns.customerInfo.name.test(msg) || 
        leadPatterns.customerInfo.phone.test(msg) || 
        leadPatterns.customerInfo.email.test(msg) ||
        leadPatterns.customerInfo.pan.test(msg)) {
        isLead = true;
        leadDetails.hasCustomerInfo = true;
        leadDetails.confidence += 0.3;
    }
    
    // Check for loan information
    if (leadPatterns.loanInfo.amount.test(msg) || 
        leadPatterns.loanInfo.tenure.test(msg) || 
        leadPatterns.loanInfo.emi.test(msg) ||
        leadPatterns.loanInfo.topup.test(msg)) {
        isLead = true;
        leadDetails.hasLoanInfo = true;
        leadDetails.confidence += 0.3;
    }
    
    // Check for location information
    if (leadPatterns.location.branch.test(msg) || 
        leadPatterns.location.city.test(msg)) {
        isLead = true;
        leadDetails.hasLocationInfo = true;
        leadDetails.confidence += 0.2;
    }
    
    // Check for urgency indicators
    if (leadPatterns.urgency.immediate.test(msg)) {
        leadDetails.isUrgent = true;
        leadDetails.confidence += 0.1;
    }
    
    // Check for customer status
    if (leadPatterns.status.existing.test(msg)) {
        leadDetails.isExistingCustomer = true;
        leadDetails.confidence += 0.1;
    } else if (leadPatterns.status.new.test(msg)) {
        leadDetails.isNewCustomer = true;
        leadDetails.confidence += 0.1;
    }
    
    // Check for approval status
    if (leadPatterns.status.approved.test(msg)) {
        leadDetails.status = 'approved';
    } else if (leadPatterns.status.rejected.test(msg)) {
        leadDetails.status = 'rejected';
    }
    
    // Check for follow-up indicators
    if (leadPatterns.urgency.followup.test(msg)) {
        leadDetails.requiresFollowup = true;
    }
    
    // Only consider it a lead if confidence is above threshold
    isLead = isLead && leadDetails.confidence >= 0.3;
    
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

// Update notification methods to be more professional
const notificationMethods = {
    // Sound notification using node-notifier
    sound: async (leadDetails) => {
        try {
            const notifier = require('node-notifier');
            
            // Play sound notification
            notifier.notify({
                title: '🔔 New Lead',
                message: 'New lead detected in group',
                sound: true,
                wait: true
            });
            
            console.log('🔊 Lead notification played');
        } catch (error) {
            console.error('Error playing notification:', error);
        }
    },

    // Desktop notification
    desktop: async (leadDetails) => {
        try {
            const notifier = require('node-notifier');
            
            notifier.notify({
                title: '🔔 New Lead',
                message: 'New lead detected in group',
                icon: path.join(__dirname, 'icon.png'),
                sound: true,
                wait: true
            });
            
            console.log('📱 Lead notification sent');
        } catch (error) {
            console.error('Error sending notification:', error);
        }
    }
};

// Function to send notifications for new leads
async function sendLeadNotifications(leadDetails) {
    // Try all available notification methods
    await Promise.all([
        notificationMethods.sound(leadDetails),
        notificationMethods.desktop(leadDetails)
    ]);
}

// Function to play sound notification on Android
async function playSoundNotification(leadDetails) {
    try {
        const { exec } = require('child_process');
        const platform = process.platform;

        if (platform === 'android') {
            console.log('🔊 Playing beep notification...');
            
            // Use Termux's beep command for a simple beep sound
            const command = 'termux-beep';
            
            await new Promise((resolve, reject) => {
                exec(command, (error) => {
                    if (error) {
                        console.error('Beep notification error:', error);
                        reject(error);
                    } else {
                        console.log('🔊 Beep notification played successfully');
                        resolve();
                    }
                });
            });
        } else {
            console.log(`[Beep notification skipped - only works on Android]`);
        }
    } catch (error) {
        console.error('Error in playSoundNotification:', error);
    }
}

// Replace the old vibrateForLead function with the new notification system
async function notifyNewLead(leadDetails) {
    try {
        // First try vibration if on Android
        if (process.platform === 'android' && vibrateOnNewLeads) {
            await vibrateForLead(leadDetails);
        }
        
        // Then play sound notification
        await playSoundNotification(leadDetails);
        
    } catch (error) {
        console.error('Error in notifyNewLead:', error);
    }
}

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

// Function to log leads to a file
function logLead(source, message, leadDetails) {
    try {
        const now = new Date();
        const timestamp = now.toLocaleString();
        const logEntry = `\n========================================\n` +
                        `📅 Date: ${timestamp}\n` +
                        `📱 Source: ${source}\n` +
                        `💬 Message: ${message}\n` +
                        `📊 Lead Details: ${JSON.stringify(leadDetails, null, 2)}\n` +
                        `========================================\n`;

        // Create logs directory if it doesn't exist
        const logsDir = './logs';
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Append to leads log file
        const logFile = path.join(logsDir, 'leads_log.txt');
        fs.appendFileSync(logFile, logEntry, 'utf8');
        console.log('✅ Lead logged successfully');
    } catch (error) {
        console.error('Error logging lead:', error);
    }
}

// Function to get group ID from name
async function getGroupId(sock, groupName) {
    try {
        // Get all groups the bot is part of
        const groups = await sock.groupFetchAllParticipating();
        
        // Find the group that matches the name
        for (const [id, group] of Object.entries(groups)) {
            if (group.subject === groupName || group.subject.includes(groupName)) {
                return id;
            }
        }
        return null;
    } catch (error) {
        console.error('Error getting group ID:', error);
        return null;
    }
}

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
                                            const groupId = await getGroupId(sock, group);
                                            if (groupId) {
                                                await sock.sendMessage(groupId, { text: greeting });
                                                console.log(`✅ Greeting sent to: ${group}`);
                                            } else {
                                                console.log(`❌ Could not find group: ${group}`);
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
            console.log('\n========================================');
            console.log('🔐 NEW QR CODE GENERATED');
            console.log('========================================');
            console.log('Scan this QR code to authenticate:');
            qrcode.generate(qr, { small: true });
            console.log('If QR code is not visible, restart the bot or try a different terminal');
            console.log('========================================\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isConflict = lastDisconnect?.error?.output?.payload?.message === 'conflict';
            
            console.log('\n========================================');
            console.log('❌ CONNECTION CLOSED');
            console.log('========================================');
            console.log('Reason:', lastDisconnect?.error?.message);

            if (isConflict) {
                console.log('\n⚠️ CONFLICT DETECTED: Another instance is running or WhatsApp is logged in elsewhere');
                console.log('Please follow these steps:');
                console.log('1. Close all other instances of the bot');
                console.log('2. Log out of WhatsApp Web on other devices');
                console.log('3. Clear auth files: rm -rf auth_info_baileys/*');
                console.log('4. Restart the bot: node bot.js\n');
                process.exit(1);
            }

            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            if (shouldReconnect) {
                console.log('\n🔄 Attempting to reconnect...');
                console.log('A new QR code will be generated if needed');
                console.log('========================================\n');
                startWhatsAppBot();
            } else {
                console.log('\n❌ Not reconnecting - logged out');
                console.log('Please restart the bot to generate a new QR code');
                console.log('========================================\n');
                process.exit(1);
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
        if (isProcessingMessage) {
            terminalUI.printWarning("Already processing a message, skipping...");
            return;
        }

        isProcessingMessage = true;

        try {
            for (const message of messages) {
                // Skip if message has been processed already
                const messageId = message.key.id;
                if (processedMessages.has(messageId)) {
                    continue;
                }

                // Mark message as processed
                processedMessages.set(messageId, Date.now());

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

                if (isGroup) {
                    try {
                        // Get group metadata
                        const groupMetadata = await sock.groupMetadata(message.key.remoteJid);
                        const groupName = groupMetadata.subject;

                        // Strictly check if this is a monitored group
                        const isMonitoredGroup = groupsToMonitor.includes(groupName);
                        
                        // Skip if not a monitored group - no logging or processing
                        if (!isMonitoredGroup) {
                            continue;
                        }

                        // Skip if monitoring is disabled
                        if (!global.botState.isMonitoring) {
                            continue;
                        }

                        // Get sender info
                        let senderName = "Unknown";
                        if (message.key.participant) {
                            const [senderNumber] = message.key.participant.split('@');
                            senderName = senderNumber;
                        }

                        // Add message to context
                        leadTracker.addToContext(message.key.remoteJid, messageContent);

                        // Check if message is related to existing lead
                        if (leadTracker.isRelatedToExistingLead(message.key.remoteJid, messageContent)) {
                            terminalUI.printWarning(`Message appears to be related to an existing lead - skipping response`);
                            continue;
                        }

                        // Use AI to analyze the message
                        const leadAnalysis = await aiLeadDetector.analyzeText(messageContent);

                        // Only proceed if it's a new lead
                        if (leadAnalysis.isLead && leadAnalysis.isNewLead) {
                            terminalUI.printLead(leadAnalysis);

                            // Create lead in the lead management system
                            const lead = await leadManager.createLead({
                                ...leadAnalysis.extractedInfo,
                                source: `Group: ${groupName}`,
                                sender: senderName,
                                message: messageContent,
                                priority: leadAnalysis.priority
                            });

                            // Add to lead tracker
                            leadTracker.addLead(message.key.remoteJid, lead);

                            // Update lead statistics
                            global.botState.updateLeadStats(leadAnalysis.priority === 'High');

                            // Log the lead
                            logLead(`Group: "${groupName}"`, messageContent, leadAnalysis);

                            // Send notifications
                            await notifyNewLead(leadAnalysis);
                            await sendLeadAlert(sock, `Group: ${groupName}`, messageContent, leadAnalysis);

                            // Send "Checking" message
                            await messageQueue.add({
                                sock,
                                to: message.key.remoteJid,
                                text: "Checking team"
                            });

                            // Show updated statistics
                            const stats = await leadManager.getLeadStats();
                            terminalUI.printStats(stats);
                        }
                    } catch (error) {
                        terminalUI.printError(`Error processing group message: ${error.message}`);
                    }
                } else {
                    // Skip all direct messages - no processing or logging
                    continue;
                }
            }
        } catch (error) {
            terminalUI.printError(`Error processing messages: ${error.message}`);
        } finally {
            isProcessingMessage = false;
        }
    });

    return sock;
}

// Update handleLeadResponse function to only respond once with "Checking team"
async function handleLeadResponse(sock, message) {
    const messageContent = message.message?.conversation ||
                          message.message?.extendedTextMessage?.text ||
                          message.message?.imageMessage?.caption ||
                          '';

    if (!messageContent) return;

    // Get group metadata if it's a group message
    let groupName = '';
    if (message.key.remoteJid.endsWith('@g.us')) {
        try {
            const groupMetadata = await sock.groupMetadata(message.key.remoteJid);
            groupName = groupMetadata.subject;
        } catch (error) {
            console.error('Error getting group metadata:', error);
        }
    }

    // Check for special group rules
    if (groupName && specialGroupRules[groupName]) {
        const rules = specialGroupRules[groupName];
        const messageLower = messageContent.toLowerCase();
        
        // Check if message contains any of the skip locations
        if (rules.skipLocations.some(location => messageLower.includes(location.toLowerCase()))) {
            console.log(`Skipping response for ${groupName} - Location is in skip list`);
            return;
        }
    }

    // Extract identifiers from message
    const identifiers = leadTracker.extractIdentifiers(messageContent);
    
    // Check if message is about a lead being handled by someone else
    if (leadTracker.isMessageAboutHandledLead(messageContent)) {
        console.log('Message is about a lead being handled by someone else - skipping response');
        return;
    }
    
    // Check if this is a follow-up to an existing lead
    const existingLead = leadTracker.getLeadByIdentifier(identifiers);
    
    if (existingLead) {
        // Skip if lead is already being handled by someone else
        if (leadTracker.isLeadBeingHandled(existingLead.id)) {
            console.log('Lead is already being handled - skipping response');
            return;
        }

        // Update lead status based on message content
        if (messageContent.toLowerCase().includes('approved')) {
            leadTracker.updateLeadStatus(existingLead.id, 'approved');
        } else if (messageContent.toLowerCase().includes('rejected')) {
            leadTracker.updateLeadStatus(existingLead.id, 'rejected');
        } else {
            leadTracker.updateLeadStatus(existingLead.id, 'in_progress', {
                lastMessage: messageContent
            });
        }
        
        // Set the current handler for this lead
        leadTracker.setLeadHandler(existingLead.id, message.key.remoteJid);
        
        // No response for existing leads
        return;
    } else {
        // New lead - process as before
        const leadAnalysis = await aiLeadDetector.analyzeText(messageContent);
        if (leadAnalysis.isLead) {
            const lead = await leadManager.createLead({
                ...leadAnalysis.extractedInfo,
                source: message.key.remoteJid,
                message: messageContent
            });
            
            const newLead = leadTracker.addLead(message.key.remoteJid, lead);
            // Set the current handler for this new lead
            leadTracker.setLeadHandler(newLead.id, message.key.remoteJid);
            
            // Only send "Checking team" for new leads
            await messageQueue.add({
                sock,
                to: message.key.remoteJid,
                text: "Checking team"
            });

            // Send notifications for new leads only
            await notifyNewLead(leadAnalysis);
        }
    }
}

// Start the bot
startWhatsAppBot().then((sock) => {
    // Start the test menu in parallel (non-blocking)
    setTimeout(() => startTestMenu(sock), 2000);
});
