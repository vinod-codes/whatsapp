/**
 * Test script for WhatsApp Auto-Messenger Bot
 * 
 * This script tests the lead detection functionality
 * without connecting to WhatsApp.
 */

const { isLeadMessage } = require('./bot');

async function testLeadDetection() {
    console.log('Running lead detection tests...');
    
    // Test cases for text-based leads
    const textTestCases = [
        { text: 'Customer submitted loan documents', expected: true, description: 'Basic lead with keywords' },
        { text: 'Need files for loan application', expected: true, description: 'Need + files + loan' },
        { text: 'Please submit the KYC documents', expected: true, description: 'Submit + KYC + documents' },
        { text: 'Can you send the contract details?', expected: true, description: 'Send + contract + details' },
        { text: 'Good morning everyone', expected: false, description: 'Greeting without lead keywords' },
        { text: 'How are you doing today?', expected: false, description: 'General conversation' },
        { text: 'The weather is nice', expected: false, description: 'Unrelated topic' },
        { text: 'Need help with something', expected: false, description: 'Need without document terms' }
    ];
    
    // Run text test cases
    for (const testCase of textTestCases) {
        const result = await isLeadMessage(testCase.text, null);
        const passed = result === testCase.expected;
        
        console.log(`${passed ? '✅' : '❌'} ${testCase.description}: "${testCase.text}" => ${result} (Expected: ${testCase.expected})`);
    }
    
    console.log('\nTests completed!');
}

// Run the tests
testLeadDetection();
