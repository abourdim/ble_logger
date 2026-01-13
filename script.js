// micro:bit BLE Logger — Stop-and-wait, dynamic chunk sizing (MTU-safe), SEQ 0..1000, NO SPACES
// micro:bit code unchanged => we treat echoed payload as ACK.
// Payload format (no spaces): "<seq>|<data>"
// ACK format from micro:bit (observed): "ECHO: <payload>"

const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // notify
const RX_CHAR_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // write

// BLE write payload is typically limited to 20 bytes.
// We append '\n', so: (payload bytes + 1) <= 20  => payload <= 19 bytes.
const BLE_MAX_WRITE_BYTES = 20;
const LINE_END_BYTES = 1; // '\n'

// seq range
const MAX_SEQ = 1000;

// DOM Elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusPill = document.getElementById('statusPill');

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

const logContainer = document.getElementById('logContainer');
const exportLogBtn = document.getElementById('exportLogBtn');

// Clear log button is now expected inside the log card controls.
// If your HTML still has a clearLogBtn elsewhere, this will still pick it up.
const clearLogBtn =
  document.getElementById('clearLogBtn') ||
  document.getElementById('clearLogsBtn') ||
  document.getElementById('clearBtn');

const copyLogBtn = document.getElementById('copyLogBtn');
const testBtn = document.getElementById('testBtn');

// BLE State
let btDevice = null;
let btServer = null;
let uartService = null;
let notifyChar = null;
let writeChar = null;
let isConnected = false;

// RX line buffer (fix notification fragmentation)
let rxBuffer = "";

// ACK state (stop-and-wait)
let sendInProgress = false;
let awaitingPayload = null;
let awaitingResolve = null;
let awaitingReject = null;
let awaitingTimer = null;

// Shared enc/dec
const encoder = new TextEncoder();

// ------------ Logging ------------

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

function getLogText() {
  return Array.from(logContainer.querySelectorAll('.log-line'))
    .map(el => el.textContent)
    .join('\n');
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

  const text = getLogText();
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

async function copyLogToClipboard() {
  try {
    const text = getLogText();
    if (!text) {
      addLogLine('No logs to copy', 'info');
      return;
    }
    await navigator.clipboard.writeText(text);
    addLogLine('Logs copied to clipboard', 'success');
  } catch (e) {
    addLogLine(`Copy failed: ${e.message}`, 'error');
  }
}

// ------------ UI status ------------

function setConnectionStatus(connected) {
  isConnected = connected;

  if (connected) {
    statusDot.classList.add('connected');
    if (statusPill) statusPill.classList.add('connected');
    statusText.textContent = 'Connected';

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    sendBtn.disabled = false;
    if (testBtn) testBtn.disabled = false;

    messageInput.focus();
  } else {
    statusDot.classList.remove('connected');
    if (statusPill) statusPill.classList.remove('connected');
    statusText.textContent = 'Disconnected';

    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    sendBtn.disabled = true;
    if (testBtn) testBtn.disabled = true;
  }
}

// ------------ BLE connect/disconnect ------------

async function connect() {
  try {
    if (!navigator.bluetooth) {
      addLogLine('Web Bluetooth not available in this browser', 'error');
      return;
    }

    addLogLine('Scanning for micro:bit devices...', 'info');

    btDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE_UUID]
    });

    btDevice.addEventListener('gattserverdisconnected', () => {
      addLogLine('Device disconnected', 'error');
      setConnectionStatus(false);
      cleanupBle();
      abortPendingAck('Disconnected');
    });

    addLogLine(`Found: ${btDevice.name || 'Unknown device'}`, 'info');
    addLogLine('Connecting to GATT server...', 'info');

    btServer = await btDevice.gatt.connect();
    uartService = await btServer.getPrimaryService(UART_SERVICE_UUID);

    addLogLine('Getting characteristics...', 'info');
    notifyChar = await uartService.getCharacteristic(TX_CHAR_UUID);
    writeChar = await uartService.getCharacteristic(RX_CHAR_UUID);

    addLogLine(`Notify char: ${notifyChar.uuid}`, 'success');
    addLogLine(`Write char: ${writeChar.uuid}`, 'success');

    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', handleIncomingData);

    rxBuffer = "";
    setConnectionStatus(true);
    addLogLine('Connected successfully!', 'success');
    addLogLine('Ready to send and receive messages', 'info');

    // quick hello
    setTimeout(() => sendMessageDirect('HELLO'), 250);

  } catch (error) {
    addLogLine(`Connection failed: ${error.message}`, 'error');
    console.error('Connection error details:', error);
    setConnectionStatus(false);
    cleanupBle();
    abortPendingAck('Connection failed');
  }
}

async function disconnect() {
  try {
    if (notifyChar) await notifyChar.stopNotifications();
    if (btDevice && btDevice.gatt.connected) btDevice.gatt.disconnect();
  } catch (e) {
    console.error(e);
  } finally {
    addLogLine('Disconnected', 'info');
    setConnectionStatus(false);
    cleanupBle();
    abortPendingAck('Disconnected');
  }
}

function cleanupBle() {
  btDevice = null;
  btServer = null;
  uartService = null;
  notifyChar = null;
  writeChar = null;
  rxBuffer = "";
}

// ------------ RX handling (buffered by newline) ------------

function handleIncomingData(event) {
  const value = event.target.value;

  // bytes -> string
  let incoming = '';
  for (let i = 0; i < value.byteLength; i++) {
    const b = value.getUint8(i);
    if (b === 13) continue; // skip CR
    incoming += String.fromCharCode(b);
  }

  rxBuffer += incoming;

  // process complete lines only
  let nl;
  while ((nl = rxBuffer.indexOf('\n')) !== -1) {
    const rawLine = rxBuffer.slice(0, nl);
    rxBuffer = rxBuffer.slice(nl + 1);

    const line = rawLine.trim();
    if (!line) continue;

    addLogLine(`← ${line}`, 'rx');

    // ACK detection: allow both "ECHO:<x>" and "ECHO: <x>"
    if (line.startsWith('ECHO:')) {
      const echoedPayload = line.startsWith('ECHO: ') ? line.slice(6) : line.slice(5);
      tryResolveAck(echoedPayload);
    }
  }
}

// ------------ Sending basics ------------

function sendMessageDirect(message) {
  if (!isConnected || !writeChar) {
    addLogLine('Not connected', 'error');
    return;
  }
  try {
    // always newline-terminated for MakeCode uartReadUntil(NewLine)
    writeChar.writeValue(encoder.encode(message + '\n'));
    addLogLine(`→ ${message}`, 'tx');
  } catch (error) {
    addLogLine(`Send failed: ${error.message}`, 'error');
  }
}

// ------------ Stop-and-wait chunking with dynamic maxDataLenForSeq ------------

function abortPendingAck(reason) {
  if (awaitingTimer) {
    clearTimeout(awaitingTimer);
    awaitingTimer = null;
  }
  if (awaitingReject) {
    const rej = awaitingReject;
    awaitingReject = null;
    awaitingResolve = null;
    awaitingPayload = null;
    rej(new Error(reason || 'Aborted'));
  }
  awaitingReject = null;
  awaitingResolve = null;
  awaitingPayload = null;
}

function waitForAck(payload, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    awaitingPayload = payload;
    awaitingResolve = resolve;
    awaitingReject = reject;

    awaitingTimer = setTimeout(() => {
      awaitingTimer = null;
      awaitingPayload = null;
      awaitingResolve = null;
      awaitingReject = null;
      reject(new Error(`ACK timeout for payload: "${payload}"`));
    }, timeoutMs);
  });
}

function tryResolveAck(echoedPayload) {
  if (!awaitingResolve || awaitingPayload === null) return;
  if (echoedPayload === awaitingPayload) {
    if (awaitingTimer) {
      clearTimeout(awaitingTimer);
      awaitingTimer = null;
    }
    const ok = awaitingResolve;
    awaitingResolve = null;
    awaitingReject = null;
    awaitingPayload = null;
    ok(true);
  }
}

// Compute max safe data length for this seq to stay within BLE 20-byte write
// Constraint: bytes(payload + "\n") <= 20
// payload = "<seq>|<data>"
// bytes(payload) = seqLen + 1 + dataLen  (ASCII digits + '|' + ASCII data)
// so: seqLen + 1 + dataLen + 1 <= 20  => dataLen <= 18 - seqLen
function maxDataLenForSeq(seq) {
  const seqLen = String(seq).length; // 1..4 for 0..1000
  const maxData = (BLE_MAX_WRITE_BYTES - LINE_END_BYTES) - (seqLen + 1); // payload<=19 => data<=19-(seqLen+1)
  // Equivalent to 18 - seqLen when BLE_MAX_WRITE_BYTES=20
  return Math.max(1, maxData);
}

function makeFramesNoSpaces(msg) {
  // IMPORTANT: micro:bit does .trim() before echoing in your firmware.
  // So avoid leading/trailing spaces in each frame. User requested "no spaces" anyway.
  // This function assumes msg contains no spaces. If it can contain spaces, encode it first.
  const frames = [];
  let seq = 0;
  let i = 0;

  while (i < msg.length) {
    const dataLen = maxDataLenForSeq(seq);
    const data = msg.slice(i, i + dataLen);
    frames.push({ seq, payload: `${seq}|${data}` });
    i += dataLen;
    seq = (seq + 1) % (MAX_SEQ + 1);
  }

  return frames;
}

async function sendChunkedSeqStopAndWait(fullMessage) {
  if (!isConnected || !writeChar) {
    addLogLine('Not connected', 'error');
    return { ok: false, bytes: 0, ms: 0, frames: 0 };
  }
  if (sendInProgress) {
    addLogLine('Send already in progress', 'error');
    return { ok: false, bytes: 0, ms: 0, frames: 0 };
  }

  sendInProgress = true;

  // "bytes" measured here is raw message bytes (not headers/newlines)
  const rawBytes = encoder.encode(fullMessage).length;
  const frames = makeFramesNoSpaces(fullMessage);

  const t0 = performance.now();
  try {
    addLogLine(`Chunked send: ${frames.length} frame(s), dynamic dataLen via maxDataLenForSeq()`, 'info');

    for (let k = 0; k < frames.length; k++) {
      const { payload } = frames[k];
      sendMessageDirect(payload);
      await waitForAck(payload);
    }

    const t1 = performance.now();
    return { ok: true, bytes: rawBytes, ms: (t1 - t0), frames: frames.length };
  } catch (e) {
    addLogLine(`Chunked send failed: ${e.message}`, 'error');
    return { ok: false, bytes: rawBytes, ms: 0, frames: frames.length };
  } finally {
    sendInProgress = false;
    awaitingPayload = null;
    awaitingResolve = null;
    awaitingReject = null;
    if (awaitingTimer) {
      clearTimeout(awaitingTimer);
      awaitingTimer = null;
    }
  }
}

// ------------ Test string + throughput ------------

function makeTestString0to1000() {
  let s = "";
  for (let i = 0; i <= 1000; i++) s += String(i);
  return s; // no spaces
}

async function runThroughputTest() {
  if (!isConnected) {
    addLogLine('Not connected', 'error');
    return;
  }
  if (sendInProgress) {
    addLogLine('Send in progress; try again later', 'error');
    return;
  }

  const test = makeTestString0to1000();
  addLogLine(`TEST start: sending sequence 0..1000 (len=${test.length})`, 'info');

  const res = await sendChunkedSeqStopAndWait(test);
  if (!res.ok) return;

  const seconds = res.ms / 1000;
  const bps = res.bytes / seconds;
  const kbps = bps / 1024;

  addLogLine(
    `THROUGHPUT: ${res.bytes} bytes in ${seconds.toFixed(3)} s = ${bps.toFixed(1)} B/s (${kbps.toFixed(2)} KiB/s), frames=${res.frames}`,
    'success'
  );
}

// ------------ UI actions ------------

async function sendMessage() {
  const message = messageInput.value;
  if (!message || !message.trim()) {
    addLogLine('Message is empty', 'info');
    return;
  }

  // enforce "no spaces" requirement for this protocol
  const trimmed = message.trim();
  if (/\s/.test(trimmed)) {
    addLogLine('Refused: message contains whitespace. This protocol requires NO SPACES.', 'error');
    return;
  }

  // Short message: still frame it as "0|data" (fits for typical short inputs)
  // If it doesn't fit, it will go through chunked sender.
  const seq0Payload = `0|${trimmed}`;
  const seq0MaxData = maxDataLenForSeq(0);

  if (trimmed.length <= seq0MaxData) {
    sendMessageDirect(seq0Payload);
  } else {
    await sendChunkedSeqStopAndWait(trimmed);
  }

  messageInput.value = '';
  messageInput.focus();
}

// ------------ Event listeners ------------

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') sendMessage();
});

if (clearLogBtn) clearLogBtn.addEventListener('click', clearLog);
if (exportLogBtn) exportLogBtn.addEventListener('click', exportLog);
if (copyLogBtn) copyLogBtn.addEventListener('click', copyLogToClipboard);
if (testBtn) testBtn.addEventListener('click', runThroughputTest);

// Init
window.addEventListener('DOMContentLoaded', () => {
  addLogLine('Logger ready. Click "Connect" to begin.', 'info');

  if (!navigator.bluetooth) {
    addLogLine('⚠️ Web Bluetooth API is not available in this browser', 'error');
    connectBtn.disabled = true;
    sendBtn.disabled = true;
    if (testBtn) testBtn.disabled = true;
  }

  setConnectionStatus(false);
  messageInput.focus();
});

