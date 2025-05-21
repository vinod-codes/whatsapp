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
        this.maxRetries = 2;
        this.retryDelay = 2000;
        this.batchSize = 5;
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
                this.queue.push(message);
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

// Add sister's number constant
const SISTER_NUMBER = '919686693567@s.whatsapp.net';

// Enhanced AI Lead Detection System with OpenRouter
class AILeadDetector {
    constructor() {
        this.confidenceThreshold = 0.7;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
        this.groupPerformance = new Map();
        this.adminNumber = '918123361016@s.whatsapp.net';
        this.sisterNumber = '919686693567@s.whatsapp.net';
        this.quickPatterns = {
            amount: /(?:loan|amount|limit|emi)[\s:]*(\d+(?:\.\d{2})?)[k]?/i,
            name: /(?:name|patient|cx|customer|mr\.?|mrs\.?|ms\.?|dr\.?)[\s:]+([a-zA-Z\s\.]+)/i,
            phone: /(?:phone|mobile|number|contact)[\s:]*(\d{10})/i,
            pan: /(?:pan|pancard)[\s:]*([a-zA-Z0-9]{10})/i,
            urgency: /(?:asap|urgent|immediate|now|today|waiting)/i,
            location: /(?:location|area|branch)[\s:]*([a-zA-Z\s]+)/i,
            loan: /(?:loan|finance|credit|bajaj)[\s:]*([a-zA-Z\s]+)/i,
            purpose: /(?:purpose|for|need)[\s:]*([a-zA-Z\s]+)/i
        };
    }

    async analyzeText(text, groupName, sender) {
        try {
            // Special handling for sister's number
            if (sender === this.sisterNumber) {
                console.log('🔍 Processing lead from sister\'s number');
                const sisterAnalysis = await this.analyzeSisterLead(text);
                this.updateGroupPerformance(groupName, sisterAnalysis);
                return sisterAnalysis;
            }

            // Quick pattern check first
            const quickCheck = this.quickPatternCheck(text);
            if (!quickCheck.isPotentialLead) {
                return {
                    isLead: false,
                    confidence: 0,
                    priority: 'Low',
                    extractedInfo: quickCheck.extractedInfo,
                    reasoning: 'No lead patterns found',
                    isNewLead: false,
                    relatedToExisting: false
                };
            }

            // Try fast AI model first
            try {
                const fastAnalysis = await this.fastAnalysis(text);
                if (fastAnalysis.confidence > 0.8) {
                    this.updateGroupPerformance(groupName, fastAnalysis);
                    return fastAnalysis;
                }
            } catch (error) {
                console.log('Fast analysis failed, trying detailed analysis...');
            }

            // Fallback to detailed analysis if needed
            const detailedAnalysis = await this.detailedAnalysis(text);
            this.updateGroupPerformance(groupName, detailedAnalysis);
            return detailedAnalysis;

        } catch (error) {
            console.error('Error in AI analysis:', error);
            return this.quickPatternCheck(text);
        }
    }

    async fastAnalysis(text) {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://github.com/your-repo',
                'X-Title': 'WhatsApp Lead Detector'
            },
            body: JSON.stringify({
                model: "anthropic/claude-3-haiku-20240307",
                messages: [
                    {
                        role: "system",
                        content: `Analyze this message for potential loan leads. Look for:
                        1. Customer details (name, phone, PAN)
                        2. Loan information (amount, purpose, urgency)
                        3. Location details
                        4. Any special requirements
                        
                        Respond in JSON:
                        {
                            "isLead": boolean,
                            "confidence": number (0-1),
                            "priority": "High/Medium/Low",
                            "extractedInfo": {
                                "contact": {
                                    "name": string,
                                    "phone": string,
                                    "email": string,
                                    "pan": string
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
                            "reasoning": "Brief explanation",
                            "isNewLead": boolean,
                            "relatedToExisting": boolean
                        }`
                    },
                    {
                        role: "user",
                        content: text
                    }
                ],
                temperature: 0.1,
                max_tokens: 200
            })
        });

        const data = await response.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Invalid API response');
        }
        return JSON.parse(data.choices[0].message.content);
    }

    async detailedAnalysis(text) {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://github.com/your-repo',
                'X-Title': 'WhatsApp Lead Detector'
            },
            body: JSON.stringify({
                model: "anthropic/claude-3-haiku-20240307",
                messages: [
                    {
                        role: "system",
                        content: `Perform detailed analysis of this message for loan leads. Consider:
                        1. All customer details (name, phone, PAN, email)
                        2. Complete loan information (amount, purpose, tenure, EMI)
                        3. Location and branch details
                        4. Urgency and timeline
                        5. Special requirements or conditions
                        6. Document requirements
                        7. Previous loan history
                        
                        Respond in JSON:
                        {
                            "isLead": boolean,
                            "confidence": number (0-1),
                            "priority": "High/Medium/Low",
                            "extractedInfo": {
                                "contact": {
                                    "name": string,
                                    "phone": string,
                                    "email": string,
                                    "pan": string
                                },
                                "financial": {
                                    "amount": number,
                                    "purpose": string,
                                    "urgency": string,
                                    "tenure": string,
                                    "emi": number
                                },
                                "location": {
                                    "city": string,
                                    "area": string,
                                    "branch": string
                                },
                                "documents": string[],
                                "requirements": string[],
                                "history": string
                            },
                            "reasoning": "Detailed explanation",
                            "isNewLead": boolean,
                            "relatedToExisting": boolean
                        }`
                    },
                    {
                        role: "user",
                        content: text
                    }
                ],
                temperature: 0.1,
                max_tokens: 300
            })
        });

        const data = await response.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Invalid API response');
        }
        return JSON.parse(data.choices[0].message.content);
    }

    quickPatternCheck(text) {
        const extractedInfo = {
            contact: {},
            financial: {},
            location: {}
        };

        let isPotentialLead = false;
        let confidence = 0;

        // Check for amount
        const amountMatch = text.match(this.quickPatterns.amount);
        if (amountMatch) {
            extractedInfo.financial.amount = parseFloat(amountMatch[1]) * 1000;
            isPotentialLead = true;
            confidence += 0.3;
        }

        // Check for name
        const nameMatch = text.match(this.quickPatterns.name);
        if (nameMatch) {
            extractedInfo.contact.name = nameMatch[1].trim();
            isPotentialLead = true;
            confidence += 0.2;
        }

        // Check for phone
        const phoneMatch = text.match(this.quickPatterns.phone);
        if (phoneMatch) {
            extractedInfo.contact.phone = phoneMatch[1];
            isPotentialLead = true;
            confidence += 0.2;
        }

        // Check for PAN
        const panMatch = text.match(this.quickPatterns.pan);
        if (panMatch) {
            extractedInfo.contact.pan = panMatch[1];
            isPotentialLead = true;
            confidence += 0.1;
        }

        // Check for loan purpose
        const purposeMatch = text.match(this.quickPatterns.purpose);
        if (purposeMatch) {
            extractedInfo.financial.purpose = purposeMatch[1].trim();
            isPotentialLead = true;
            confidence += 0.1;
        }

        // Check for loan type
        const loanMatch = text.match(this.quickPatterns.loan);
        if (loanMatch) {
            extractedInfo.financial.loanType = loanMatch[1].trim();
            isPotentialLead = true;
            confidence += 0.1;
        }

        // Check for urgency
        if (this.quickPatterns.urgency.test(text)) {
            extractedInfo.financial.urgency = 'High';
            confidence += 0.1;
        }

        // Check for location
        const locationMatch = text.match(this.quickPatterns.location);
        if (locationMatch) {
            extractedInfo.location.area = locationMatch[1].trim();
            isPotentialLead = true;
            confidence += 0.1;
        }

        return {
            isLead: isPotentialLead,
            confidence,
            priority: confidence > 0.6 ? 'High' : confidence > 0.3 ? 'Medium' : 'Low',
            extractedInfo,
            reasoning: 'Quick pattern check',
            isNewLead: true,
            relatedToExisting: false
        };
    }

    async analyzeSisterLead(text) {
        try {
            // First do a quick pattern check
            const quickCheck = this.quickPatternCheck(text);
            if (!quickCheck.isPotentialLead) {
                return quickCheck;
            }

            const response = await fetch(OPENROUTER_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://github.com/your-repo',
                    'X-Title': 'WhatsApp Lead Detector'
                },
                body: JSON.stringify({
                    model: "anthropic/claude-3-haiku-20240307",
                    messages: [
                        {
                            role: "system",
                            content: `Analyze this lead from a trusted source. Consider:
                            1. All contact details
                            2. Financial information
                            3. Urgency level
                            4. Special requirements
                            
                            Respond in JSON:
                            {
                                "isLead": boolean,
                                "confidence": number (0-1),
                                "priority": "High/Medium/Low",
                                "extractedInfo": {
                                    "contact": {
                                        "name": string,
                                        "phone": string,
                                        "email": string,
                                        "pan": string
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
                                "reasoning": "Brief explanation",
                                "isNewLead": boolean,
                                "relatedToExisting": boolean
                            }`
                        },
                        {
                            role: "user",
                            content: text
                        }
                    ],
                    temperature: 0.1,
                    max_tokens: 200
                })
            });

            const data = await response.json();
            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                throw new Error('Invalid API response');
            }

            const analysis = JSON.parse(data.choices[0].message.content);
            
            // Enhance confidence for sister's leads
            analysis.confidence = Math.min(1, analysis.confidence + 0.2);
            analysis.priority = 'High';
            analysis.isNewLead = true;
            
            return analysis;
        } catch (error) {
            console.error('Error in sister lead analysis:', error);
            // Return quick check results as fallback
            return this.quickPatternCheck(text);
        }
    }

    async sendStrategyUpdate(sock, groupName, strategy) {
        try {
            if (!sock || !sock.sendMessage) {
                console.error('Invalid socket for sending strategy update');
                return;
            }

            const message = `📊 *Strategy Update for ${groupName}*\n\n` +
                          `🎯 *Focus Areas:*\n${strategy.focusAreas.join('\n')}\n\n` +
                          `💡 *Recommendations:*\n${strategy.recommendations.join('\n')}\n\n` +
                          `⚡ *Priority Actions:*\n${strategy.priorityActions.join('\n')}`;

            await sock.sendMessage(this.adminNumber, { text: message });
        } catch (error) {
            console.error('Error sending strategy update:', error);
        }
    }

    updateGroupPerformance(groupName, analysis) {
        if (!this.groupPerformance.has(groupName)) {
            this.groupPerformance.set(groupName, {
                totalLeads: 0,
                highPriorityLeads: 0,
                mediumPriorityLeads: 0,
                lowPriorityLeads: 0,
                conversionRate: 0,
                averageAmount: 0,
                totalAmount: 0,
                specialties: new Map(),
                documentTypes: new Map(),
                lastUpdated: new Date()
            });
        }

        const stats = this.groupPerformance.get(groupName);
        stats.totalLeads++;
        
        // Update priority counts
        if (analysis.priority === 'High') stats.highPriorityLeads++;
        else if (analysis.priority === 'Medium') stats.mediumPriorityLeads++;
        else stats.lowPriorityLeads++;

        // Update financial metrics
        if (analysis.extractedInfo?.financial?.amount) {
            stats.totalAmount += analysis.extractedInfo.financial.amount;
            stats.averageAmount = stats.totalAmount / stats.totalLeads;
        }

        stats.lastUpdated = new Date();

        // Send strategy update if sock is available
        const strategy = this.getGroupStrategy(groupName);
        if (strategy && global.sock) {
            this.sendStrategyUpdate(global.sock, groupName, strategy);
        }
    }

    getGroupStrategy(groupName) {
        const stats = this.groupPerformance.get(groupName);
        if (!stats) return null;

        const strategy = {
            focusAreas: [],
            recommendations: [],
            priorityActions: []
        };

        // Analyze performance patterns
        const highPriorityRatio = stats.highPriorityLeads / stats.totalLeads;
        const avgAmount = stats.averageAmount;

        // Determine focus areas based on performance
        if (highPriorityRatio > 0.3) {
            strategy.focusAreas.push('High-value leads');
            strategy.recommendations.push('Maintain focus on high-priority leads');
        } else {
            strategy.focusAreas.push('Lead quality improvement');
            strategy.recommendations.push('Focus on identifying high-priority leads');
        }

        // Add specialty-based recommendations
        const topSpecialties = Array.from(stats.specialties.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
        
        if (topSpecialties.length > 0) {
            strategy.focusAreas.push(`Top specialties: ${topSpecialties.map(s => s[0]).join(', ')}`);
            strategy.recommendations.push('Maintain strong relationships with these specialty departments');
        }

        // Add document-based recommendations
        const commonDocs = Array.from(stats.documentTypes.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
        
        if (commonDocs.length > 0) {
            strategy.focusAreas.push(`Common documents: ${commonDocs.map(d => d[0]).join(', ')}`);
            strategy.recommendations.push('Ensure quick processing of these document types');
        }

        // Add priority actions
        if (avgAmount > 100000) {
            strategy.priorityActions.push('Focus on high-value loan processing');
        }
        if (stats.conversionRate < 0.5) {
            strategy.priorityActions.push('Improve lead conversion rate');
        }

        return strategy;
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
    'Bajaj + Dr Agarwal rajji nagar',
    'Bajaj + Dr Shetty',
    'Orane + Bajaj finserv',
    'Partha+Bajaj Bangalore',
    'Bajaj + Nethradama Rajajinagar',
    'Headz + Bajaj FINSERV',
    'Bajaj +REHABILITATIONS specialist',
    'Bajaj + Ad gro (OZIVIT)',
    'Bajaj+ Priya hearing',
    'Bajaj-Rehamo',
    'Bajaj+ Baby sience',
    'Bajaj+ LAKME RAJJINAGAR',
    'Bajaj + Isha',
    'VASAN EYE CARE + BAJAJ FINSERV',
    'LC Rok + bajaj',
    'Bajaj Fin and SleepMed',
    'Bajaj+Partha Dasarahalli',
    'Vlcc + bajaj rajji nagar',
    'Bajaj + Cozmo BLIS',
    'Bajaj Finance+Smiles.ai'  // Special group with Hyderabad rule
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
        await sock.sendMessage(aiLeadDetector.adminNumber, { text: alertMessage });
        console.log(`Lead alert sent to admin: ${aiLeadDetector.adminNumber}`);
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

                // Get message content and type
                let messageContent = '';
                let messageType = 'text';
                let mediaInfo = null;
                let combinedContent = '';

                // Extract text content
                if (message.message?.conversation) {
                    messageContent = message.message.conversation;
                    combinedContent = messageContent;
                } else if (message.message?.extendedTextMessage?.text) {
                    messageContent = message.message.extendedTextMessage.text;
                    combinedContent = messageContent;
                }

                // Handle media content
                if (message.message?.imageMessage) {
                    messageType = 'image';
                    const caption = message.message.imageMessage.caption || '';
                    mediaInfo = {
                        type: 'image',
                        mimetype: message.message.imageMessage.mimetype,
                        url: message.message.imageMessage.url
                    };
                    combinedContent = `${messageContent}\n[Image: ${caption}]`;
                } else if (message.message?.documentMessage) {
                    messageType = 'document';
                    const fileName = message.message.documentMessage.fileName || '';
                    mediaInfo = {
                        type: 'document',
                        mimetype: message.message.documentMessage.mimetype,
                        fileName: fileName,
                        url: message.message.documentMessage.url
                    };
                    combinedContent = `${messageContent}\n[Document: ${fileName}]`;
                }

                // Skip empty messages
                if (!combinedContent) continue;

                // Get sender information
                const sender = message.key.participant || message.key.remoteJid;

                // Check if message is from a group
                const isGroup = message.key.remoteJid.endsWith('@g.us');

                if (isGroup) {
                    try {
                        // Get group metadata
                        const groupMetadata = await sock.groupMetadata(message.key.remoteJid);
                        const groupName = groupMetadata.subject;

                        // Strictly check if this is a monitored group
                        const isMonitoredGroup = groupsToMonitor.includes(groupName);
                        
                        // Skip if not a monitored group
                        if (!isMonitoredGroup) {
                            continue;
                        }

                        // Skip if monitoring is disabled
                        if (!global.botState.isMonitoring) {
                            continue;
                        }

                        // Check if we've already responded to this lead
                        if (leadTracker.hasCheckedLead(messageId, message.key.remoteJid)) {
                            console.log('Already responded to this lead, skipping...');
                            continue;
                        }

                        // Check if message is about an existing lead
                        if (leadTracker.isMessageAboutExistingLead(combinedContent, message.key.remoteJid)) {
                            console.log('Message is about an existing lead, skipping...');
                            continue;
                        }

                        // Get sender info
                        let senderName = "Unknown";
                        if (message.key.participant) {
                            const [senderNumber] = message.key.participant.split('@');
                            senderName = senderNumber;
                        }

                        // Add message to context
                        leadTracker.addToContext(message.key.remoteJid, combinedContent);

                        // Use AI to analyze the combined content
                        const leadAnalysis = await aiLeadDetector.analyzeText(combinedContent, groupName, sender);

                        // Only proceed if it's a new lead
                        if (leadAnalysis.isLead && leadAnalysis.isNewLead) {
                            terminalUI.printLead(leadAnalysis);

                            // Create lead in the lead management system
                            const lead = await leadManager.createLead({
                                ...leadAnalysis.extractedInfo,
                                source: `Group: ${groupName}`,
                                sender: senderName,
                                message: combinedContent,
                                messageType: messageType,
                                mediaInfo: mediaInfo,
                                priority: leadAnalysis.priority
                            });

                            // Add to lead tracker
                            leadTracker.addLead(message.key.remoteJid, lead);
                            leadTracker.markLeadAsChecked(messageId, message.key.remoteJid);

                            // Update lead statistics
                            global.botState.updateLeadStats(leadAnalysis.priority === 'High');

                            // Log the lead
                            logLead(`Group: "${groupName}"`, combinedContent, leadAnalysis);

                            // Send notifications
                            await notifyNewLead(leadAnalysis);
                            await sendLeadAlert(sock, `Group: ${groupName}`, combinedContent, leadAnalysis);

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
                    // Handle direct messages from sister's number
                    if (sender === SISTER_NUMBER) {
                        await handleLeadResponse(sock, message);
                    }
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

// Optimize lead response handling
async function handleLeadResponse(sock, message) {
    let messageContent = '';
    let messageType = 'text';

    // Extract text content
    if (message.message?.conversation) {
        messageContent = message.message.conversation;
    } else if (message.message?.extendedTextMessage?.text) {
        messageContent = message.message.extendedTextMessage.text;
    }

    // Skip if no text content
    if (!messageContent) {
        console.log('Skipping: No text content in message');
        return;
    }

    // Get sender information
    const sender = message.key.participant || message.key.remoteJid;

    // Special handling for sister's number
    if (sender === SISTER_NUMBER) {
        console.log('\n========================================');
        console.log('📱 Message from Sister\'s Number:');
        console.log('========================================');
        console.log(`💬 Content: ${messageContent}`);
        console.log('========================================\n');

        // Basic lead pattern check
        const isLead = checkForLeadPatterns(messageContent);

        if (isLead) {
            // Send "Checking team" response to the sender
            await sock.sendMessage(sender, { text: "Checking team" });
            console.log('✅ Sent "Checking team" response');
            
            // Log to console only
            console.log('Lead detected in message:', messageContent);
        } else {
            console.log('Message is not a lead, skipping');
        }
    }
}

// Simple function to check for lead patterns
function checkForLeadPatterns(text) {
    const patterns = {
        // Customer Identifiers
        name: /(?:name|patient|customer|cx|pt\s*name)[\s:]+([a-zA-Z\s\.]+)/i,
        
        // Contact Information
        phone: /(?:phone|contact|number|mobile\s*number|ph\.?\s*no)[\s:]*(\d{10})/i,
        
        // Email and Other Identifiers
        email: /(?:email|mail\s*id)[\s:]*([\w\.-]+@[\w\.-]+\.\w+)/i,
        
        // Loan and Plan Details
        amount: /(?:loan\s*amount|amount|plan|scheme|tenure)[\s:]*(\d+(?:\.\d{2})?)[k]?/i,
        
        // Customer Status
        status: /(?:existing\s*customer|new\s*customer)/i,
        
        // Location and Service Context
        location: /(?:branch|clinic|area)[\s:]*([a-zA-Z\s]+)/i,
        
        // Additional Context
        context: /(?:details|lead\s*is\s*from|please\s*check|kindly\s*check|eligibility\s*check)/i,

        // Numbers that might be amounts
        potentialAmount: /\b\d{4,6}\b/,
        
        // Time periods
        timePeriod: /\b\d+\s*(?:months?|years?|days?)\b/i
    };

    // Check for essential lead components
    const hasContactInfo = patterns.name.test(text) || patterns.phone.test(text) || patterns.email.test(text);
    const hasFinancialInfo = patterns.amount.test(text) || patterns.potentialAmount.test(text);
    const hasLocationInfo = patterns.location.test(text);
    const hasContext = patterns.context.test(text);
    const hasStatus = patterns.status.test(text);
    const hasTimePeriod = patterns.timePeriod.test(text);

    // A message is considered a lead if it has:
    // 1. Contact information (name/phone/email) OR
    // 2. Financial information (amount/potential amount) OR
    // 3. Location information OR
    // 4. Context phrases OR
    // 5. Customer status OR
    // 6. Time period with a number
    return hasContactInfo || hasFinancialInfo || hasLocationInfo || hasContext || hasStatus || hasTimePeriod;
}

// Start the bot
startWhatsAppBot().then((sock) => {
    // Start the test menu in parallel (non-blocking)
    setTimeout(() => startTestMenu(sock), 2000);
});
