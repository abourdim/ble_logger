// micro:bit BLE Logger
// Rule:
// - if msg < 20 bytes → send AS-IS (no seq, no framing)
// - if msg >= 20 bytes → chunked stop-and-wait with <seq>|<data>

const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // notify
const RX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // write

const BLE_MAX_WRITE_BYTES = 20;
const LINE_END_BYTES = 1; // '\n'
const MAX_SEQ = 1000;

const encoder = new TextEncoder();

// ---------------- DOM ----------------
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const sendBtn = document.getElementById('sendBtn');
const testBtn = document.getElementById('testBtn');
const messageInput = document.getElementById('messageInput');

const logContainer = document.getElementById('logContainer');
const clearLogBtn = document.getElementById('clearLogBtn');
const copyLogBtn = document.getElementById('copyLogBtn');
const exportLogBtn = document.getElementById('exportLogBtn');

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusPill = document.getElementById('statusPill');

// ---------------- BLE STATE ----------------
let device, server, service, notifyChar, writeChar;
let isConnected = false;

// RX buffering (handles notification fragmentation)
let rxBuffer = "";

// stop-and-wait ACK state
let sendInProgress = false;
let awaitingPayload = null;
let awaitingResolve = null;
let awaitingReject = null;
let awaitingTimer = null;

// ---------------- LOGGING ----------------
function ts() {
  const d = new Date();
  return `[${d.toLocaleTimeString()}]`;
}

function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-line ${type}`;
  div.textContent = `${ts()} ${msg}`;
  logContainer.appendChild(div);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function clearLog() {
  logContainer.innerHTML = '';
  log('Log cleared');
}

function getLogText() {
  return Array.from(logContainer.children).map(d => d.textContent).join('\n');
}

async function copyLog() {
  await navigator.clipboard.writeText(getLogText());
  log('Logs copied to clipboard', 'success');
}

function exportLog() {
  const blob = new Blob([getLogText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'microbit-log.txt';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- UI ----------------
function setConnected(v) {
  isConnected = v;
  statusText.textContent = v ? 'Connected' : 'Disconnected';
  statusDot.classList.toggle('connected', v);
  statusPill.classList.toggle('connected', v);

  connectBtn.disabled = v;
  disconnectBtn.disabled = !v;
  sendBtn.disabled = !v;
  if (testBtn) testBtn.disabled = !v;
}

// ---------------- BLE ----------------
async function connect() {
  device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'BBC micro:bit' }],
    optionalServices: [UART_SERVICE_UUID]
  });

  device.addEventListener('gattserverdisconnected', disconnect);

  server = await device.gatt.connect();
  service = await server.getPrimaryService(UART_SERVICE_UUID);

  notifyChar = await service.getCharacteristic(TX_CHAR_UUID);
  writeChar = await service.getCharacteristic(RX_CHAR_UUID);

  await notifyChar.startNotifications();
  notifyChar.addEventListener('characteristicvaluechanged', onNotify);

  rxBuffer = '';
  setConnected(true);
  log('Connected', 'success');
}

function disconnect() {
  setConnected(false);
  abortAck('Disconnected');
  log('Disconnected', 'error');
}

// ---------------- RX (buffered) ----------------
function onNotify(event) {
  let s = '';
  const v = event.target.value;
  for (let i = 0; i < v.byteLength; i++) {
    const b = v.getUint8(i);
    if (b !== 13) s += String.fromCharCode(b);
  }

  rxBuffer += s;

  let nl;
  while ((nl = rxBuffer.indexOf('\n')) !== -1) {
    const line = rxBuffer.slice(0, nl).trim();
    rxBuffer = rxBuffer.slice(nl + 1);
    if (!line) continue;

    log('← ' + line, 'rx');

    if (line.startsWith('ECHO:')) {
      const echoed = line.startsWith('ECHO: ')
        ? line.slice(6)
        : line.slice(5);
      tryResolveAck(echoed);
    }
  }
}

// ---------------- SENDING ----------------
function sendRaw(msg) {
  writeChar.writeValue(encoder.encode(msg + '\n'));
  log('→ ' + msg, 'tx');
}

// stop-and-wait helpers
function abortAck(reason) {
  if (awaitingTimer) clearTimeout(awaitingTimer);
  if (awaitingReject) awaitingReject(new Error(reason));
  awaitingPayload = awaitingResolve = awaitingReject = null;
}

function waitForAck(payload, timeout = 4000) {
  return new Promise((resolve, reject) => {
    awaitingPayload = payload;
    awaitingResolve = resolve;
    awaitingReject = reject;
    awaitingTimer = setTimeout(() => {
      abortAck('ACK timeout');
      reject(new Error('ACK timeout'));
    }, timeout);
  });
}

function tryResolveAck(echoed) {
  if (awaitingResolve && echoed === awaitingPayload) {
    clearTimeout(awaitingTimer);
    const r = awaitingResolve;
    awaitingPayload = awaitingResolve = awaitingReject = null;
    r(true);
  }
}

// MTU-safe chunk sizing
function maxDataLenForSeq(seq) {
  const seqLen = String(seq).length;
  return Math.max(1, (BLE_MAX_WRITE_BYTES - LINE_END_BYTES) - (seqLen + 1));
}

// ---------------- CHUNKED SEND ----------------
async function sendChunked(msg) {
  sendInProgress = true;
  let seq = 0;
  let i = 0;

  while (i < msg.length) {
    const dataLen = maxDataLenForSeq(seq);
    const data = msg.slice(i, i + dataLen);
    const payload = `${seq}|${data}`;

    sendRaw(payload);
    await waitForAck(payload);

    i += dataLen;
    seq = (seq + 1) % (MAX_SEQ + 1);
  }

  sendInProgress = false;
}

// ---------------- MAIN SEND ENTRY ----------------
async function sendMessage() {
  const msg = messageInput.value;
  if (!msg) return;

  const byteLen = encoder.encode(msg).length;

  // 🔑 RULE IMPLEMENTED HERE
  if (byteLen < BLE_MAX_WRITE_BYTES) {
    sendRaw(msg);           // AS-IS, no seq
  } else {
    if (/\s/.test(msg)) {
      log('Long messages must contain NO SPACES', 'error');
      return;
    }
    if (sendInProgress) return;
    await sendChunked(msg);
  }

  messageInput.value = '';
}

// ---------------- TEST ----------------
function makeTestString() {
  let s = '';
  for (let i = 0; i <= 1000; i++) s += i;
  return s;
}

async function runTest() {
  const s = makeTestString();
  log(`TEST start (${s.length} chars)`, 'info');
  const t0 = performance.now();
  await sendChunked(s);
  const dt = (performance.now() - t0) / 1000;
  log(`THROUGHPUT ${(s.length / dt).toFixed(1)} B/s`, 'success');
}

// ---------------- EVENTS ----------------
connectBtn.onclick = connect;
disconnectBtn.onclick = disconnect;
sendBtn.onclick = sendMessage;
messageInput.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };

if (testBtn) testBtn.onclick = runTest;
clearLogBtn.onclick = clearLog;
copyLogBtn.onclick = copyLog;
exportLogBtn.onclick = exportLog;

