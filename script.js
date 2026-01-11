// micro:bit BLE Simple Logger - WITH CORRECT UUIDs
// Your micro:bit's specific UUIDs
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID = '6e408083-b5a3-f393-e0a9-e50e24dcca9e';  // Your notify char
const RX_CHAR_UUID = '6e408082-b5a3-f393-e0a9-e50e24dcca9e';  // Your write char

// DOM Elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusPill = document.getElementById('statusPill');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const logContainer = document.getElementById('logContainer');
const clearLogBtn = document.getElementById('clearLogBtn');
const exportLogBtn = document.getElementById('exportLogBtn');

// BLE State
let btDevice = null;
let btServer = null;
let uartService = null;
let notifyChar = null;
let writeChar = null;
let isConnected = false;

// ------------ Logging Functions ------------

function getTimestamp() {
    const now = new Date();
    return `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`;
}

function addLogLine(text, type = 'info') {
    const timestamp = getTimestamp();
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerHTML = `<span class="timestamp">${timestamp}</span>${text}`;
    
    logContainer.appendChild(line);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function clearLog() {
    logContainer.innerHTML = '';
    addLogLine('Log cleared', 'info');
}

function exportLog() {
    if (!logContainer.children.length) {
        addLogLine('No logs to export', 'info');
        return;
    }
    
    const text = Array.from(logContainer.querySelectorAll('.log-line'))
        .map(el => el.textContent)
        .join('\n');
    
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `microbit-log-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    addLogLine('Log exported', 'success');
}

// ------------ Connection Management ------------

function setConnectionStatus(connected) {
    isConnected = connected;
    
    // Update UI
    if (connected) {
        statusDot.classList.add('connected');
        if (statusPill) statusPill.classList.add('connected');
        statusText.textContent = 'Connected';
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        sendBtn.disabled = false;
        messageInput.focus();
    } else {
        statusDot.classList.remove('connected');
        if (statusPill) statusPill.classList.remove('connected');
        statusText.textContent = 'Disconnected';
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        sendBtn.disabled = true;
    }
}

async function connect() {
    try {
        if (!navigator.bluetooth) {
            addLogLine('Web Bluetooth not available in this browser', 'error');
            return;
        }
        
        addLogLine('Scanning for micro:bit devices...', 'info');
        
        // Request Bluetooth device - include your specific UUIDs
        btDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'BBC micro:bit' }],
            optionalServices: [UART_SERVICE_UUID, TX_CHAR_UUID, RX_CHAR_UUID]
        });
        
        // Handle disconnection
        btDevice.addEventListener('gattserverdisconnected', () => {
            addLogLine('Device disconnected', 'error');
            setConnectionStatus(false);
        });
        
        addLogLine(`Found: ${btDevice.name || 'Unknown device'}`, 'info');
        addLogLine('Connecting to GATT server...', 'info');
        
        // Connect to GATT server
        btServer = await btDevice.gatt.connect();
        
        addLogLine('Getting UART service...', 'info');
        uartService = await btServer.getPrimaryService(UART_SERVICE_UUID);
        
        addLogLine('Getting characteristics with YOUR UUIDs...', 'info');
        
        // Get the SPECIFIC characteristics for YOUR micro:bit
        try {
            notifyChar = await uartService.getCharacteristic(TX_CHAR_UUID);
            addLogLine(`Got notify char: ${notifyChar.uuid}`, 'success');
        } catch (e) {
            addLogLine(`Could not get notify char (${TX_CHAR_UUID}): ${e.message}`, 'error');
            // Fallback: try to get any notify characteristic
            const chars = await uartService.getCharacteristics();
            for (const char of chars) {
                if (char.properties.notify || char.properties.indicate) {
                    notifyChar = char;
                    addLogLine(`Fallback notify char: ${char.uuid}`, 'info');
                    break;
                }
            }
        }
        
        try {
            writeChar = await uartService.getCharacteristic(RX_CHAR_UUID);
            addLogLine(`Got write char: ${writeChar.uuid}`, 'success');
        } catch (e) {
            addLogLine(`Could not get write char (${RX_CHAR_UUID}): ${e.message}`, 'error');
            // Fallback: try to get any write characteristic
            const chars = await uartService.getCharacteristics();
            for (const char of chars) {
                if (char.properties.write || char.properties.writeWithoutResponse) {
                    writeChar = char;
                    addLogLine(`Fallback write char: ${char.uuid}`, 'info');
                    break;
                }
            }
        }
        
        if (!notifyChar || !writeChar) {
            addLogLine('ERROR: Could not get required characteristics', 'error');
            addLogLine('Available characteristics:', 'info');
            const allChars = await uartService.getCharacteristics();
            allChars.forEach((char, index) => {
                addLogLine(`  ${index + 1}. UUID: ${char.uuid}, Properties: ${JSON.stringify(char.properties)}`, 'info');
            });
            setConnectionStatus(false);
            return;
        }
        
        // Start notifications
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', handleIncomingData);
        
        setConnectionStatus(true);
        addLogLine('Connected successfully!', 'success');
        addLogLine('Ready to send and receive messages', 'info');
        
        // Test connection
        setTimeout(() => {
            sendMessageDirect('HELLO');
        }, 500);
        
    } catch (error) {
        addLogLine(`Connection failed: ${error.message}`, 'error');
        console.error('Connection error details:', error);
        setConnectionStatus(false);
    }
}

async function disconnect() {
    try {
        if (notifyChar) {
            await notifyChar.stopNotifications();
        }
        if (btDevice && btDevice.gatt.connected) {
            btDevice.gatt.disconnect();
        }
    } catch (error) {
        console.error('Error during disconnect:', error);
    } finally {
        addLogLine('Disconnected', 'info');
        setConnectionStatus(false);
        btDevice = null;
        btServer = null;
        uartService = null;
        notifyChar = null;
        writeChar = null;
    }
}

// ------------ Data Handling ------------

function handleIncomingData(event) {
    const value = event.target.value;
    let text = '';
    
    // Convert bytes to string
    for (let i = 0; i < value.byteLength; i++) {
        const charCode = value.getUint8(i);
        if (charCode === 13) continue; // Skip carriage return
        text += String.fromCharCode(charCode);
    }
    
    // Handle each line
    text.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed) {
            addLogLine(`← ${trimmed}`, 'rx');
        }
    });
}

function sendMessageDirect(message) {
    if (!isConnected || !writeChar) {
        addLogLine('Not connected', 'error');
        return;
    }
    
    try {
        // Send message - YOUR micro:bit expects \n at the end
        const encoder = new TextEncoder();
        const data = encoder.encode(message + '\n');
        writeChar.writeValue(data);
        
        // Log sent message
        addLogLine(`→ ${message}`, 'tx');
        
    } catch (error) {
        addLogLine(`Send failed: ${error.message}`, 'error');
    }
}

async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) {
        addLogLine('Message is empty', 'info');
        return;
    }
    
    sendMessageDirect(message);
    
    // Clear input
    messageInput.value = '';
    messageInput.focus();
}

// ------------ Event Listeners ------------

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

sendBtn.addEventListener('click', sendMessage);

messageInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        sendMessage();
    }
});

clearLogBtn.addEventListener('click', clearLog);
exportLogBtn.addEventListener('click', exportLog);

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    addLogLine('Logger ready. Click "Connect to micro:bit" to begin.', 'info');
    
    // Check if Web Bluetooth is available
    if (!navigator.bluetooth) {
        addLogLine('⚠️ Web Bluetooth API is not available in this browser', 'error');
        connectBtn.disabled = true;
        sendBtn.disabled = true;
    }
    
    // Auto-focus input on load
    messageInput.focus();
});
