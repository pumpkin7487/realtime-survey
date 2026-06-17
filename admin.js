// Helper to convert string to Hex (to prevent ASP.NET path validation errors on keyvalue.immanuel.co)
function stringToHex(str) {
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    const hexVal = charCode.toString(16);
    hex += hexVal.padStart(2, '0');
  }
  return hex;
}

// Helper to convert Hex to string
function hexToString(hex) {
  if (!hex) return '';
  // Strip quotes if they are returned by the API
  if (hex.startsWith('"') && hex.endsWith('"')) {
    hex = hex.slice(1, -1);
  }
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    const part = hex.substr(i, 2);
    const charCode = parseInt(part, 16);
    if (!isNaN(charCode)) {
      str += String.fromCharCode(charCode);
    }
  }
  return str;
}

// Global Application State
// Format: { voterId1: ["ChatGPT", "Gemini"], voterId2: ["Claude"] }
let votesState = {};
let room = '';
let mqttClient = null;
let lastDatabaseStateStr = '';

const platformsList = ['ChatGPT', 'Gemini', 'NotebookLM', 'Claude', 'Typeless', 'Codex', 'Antigravity'];

// DOM Elements
const totalVotersEl = document.getElementById('total-voters');
const totalVotesEl = document.getElementById('total-votes');
const statusDotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const qrCodeEl = document.getElementById('qr-code');
const voterUrlInput = document.getElementById('voter-url-input');
const copyUrlBtn = document.getElementById('copy-url-btn');
const resetBtn = document.getElementById('reset-btn');

// Initialize Dashboard
async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  room = urlParams.get('room');

  // If no room is specified, fetch an AppKey from the API to use as room ID
  if (!room) {
    statusTextEl.textContent = '正在初始化調查室...';
    try {
      const response = await fetch('https://keyvalue.immanuel.co/api/KeyVal/GetAppKey');
      const key = await response.json(); // returns e.g. "sgsnurhg"
      window.location.search = `?room=${key}`;
    } catch (err) {
      console.error('Failed to initialize room ID:', err);
      // Generate fallback local room ID if service is down
      const fallbackRoom = Math.random().toString(36).substring(2, 10);
      window.location.search = `?room=${fallbackRoom}`;
    }
    return;
  }

  // Setup Dynamic QR Code & Voter Url
  const url = new URL(window.location.href);
  let path = url.pathname;
  if (path.endsWith('index.html')) {
    path = path.slice(0, -'index.html'.length);
  }
  if (!path.endsWith('/')) {
    path += '/';
  }
  url.pathname = path + 'vote.html';
  url.search = `?room=${room}`;
  const voterUrl = url.toString();
  
  voterUrlInput.value = voterUrl;
  qrCodeEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(voterUrl)}`;

  // Set initial UI states
  updateUI();

  // Load current votes from database
  await fetchLatestVotes();

  // Initialize MQTT connection
  connectMQTT();

  // Setup backup polling interval (every 3 seconds)
  setInterval(fetchLatestVotes, 3000);

  // Setup event listeners
  copyUrlBtn.addEventListener('click', copyVoterUrl);
  resetBtn.addEventListener('click', confirmReset);
}

// Fetch current votes from KeyValue API
async function fetchLatestVotes() {
  try {
    const response = await fetch(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/${room}/votes`);
    const hexData = await response.json();
    
    // Check if empty or not set
    if (!hexData || hexData === '""') {
      return;
    }

    if (hexData === lastDatabaseStateStr) {
      return; // No change
    }
    lastDatabaseStateStr = hexData;

    const jsonStr = hexToString(hexData);
    if (jsonStr) {
      const dbVotes = JSON.parse(jsonStr);
      // Merge dbVotes into votesState by voter ID
      let stateChanged = false;
      for (const voterId in dbVotes) {
        if (JSON.stringify(votesState[voterId]) !== JSON.stringify(dbVotes[voterId])) {
          votesState[voterId] = dbVotes[voterId];
          stateChanged = true;
        }
      }
      // Check if some voter was deleted in DB (like a reset)
      for (const voterId in votesState) {
        if (!dbVotes[voterId]) {
          delete votesState[voterId];
          stateChanged = true;
        }
      }

      if (stateChanged) {
        updateUI();
      }
    }
  } catch (err) {
    console.error('Error fetching votes from KeyValue API:', err);
  }
}

// Connect to EMQX Public Broker over WebSockets
function connectMQTT() {
  const brokerUrl = 'wss://broker.emqx.io:8084/mqtt';
  const options = {
    clientId: 'ai_survey_dashboard_' + Math.random().toString(16).substring(2, 8),
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 3000
  };

  statusTextEl.textContent = '連線至即時伺服器...';
  
  mqttClient = mqtt.connect(brokerUrl, options);

  mqttClient.on('connect', () => {
    console.log('Connected to MQTT Broker.');
    statusDotEl.classList.add('active');
    statusTextEl.textContent = '即時連線中 (穩定)';
    mqttClient.subscribe(`ai-survey/${room}/vote`);
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === 'vote' && payload.voterId && Array.isArray(payload.choices)) {
        // Update local state
        votesState[payload.voterId] = payload.choices;
        updateUI();
      } else if (payload.type === 'reset') {
        votesState = {};
        updateUI();
      }
    } catch (e) {
      console.error('Error handling incoming MQTT message:', e);
    }
  });

  mqttClient.on('error', (err) => {
    console.error('MQTT connection error:', err);
    statusDotEl.classList.remove('active');
    statusTextEl.textContent = '連線出錯 (已切換至備用同步模式)';
  });

  mqttClient.on('close', () => {
    console.log('MQTT connection closed.');
    statusDotEl.classList.remove('active');
    statusTextEl.textContent = '連線中斷 (備用同步模式已啟用)';
  });
}

// Update the statistics and progress bars on the page
function updateUI() {
  const totalVoters = Object.keys(votesState).length;
  totalVotersEl.textContent = totalVoters;

  // Initialize brand vote counters
  const counts = {};
  platformsList.forEach(p => counts[p] = 0);

  let totalVotes = 0;
  for (const voterId in votesState) {
    const choices = votesState[voterId];
    if (Array.isArray(choices)) {
      choices.forEach(choice => {
        if (counts[choice] !== undefined) {
          counts[choice]++;
          totalVotes++;
        }
      });
    }
  }

  totalVotesEl.textContent = totalVotes;

  // Update DOM elements for each platform
  platformsList.forEach(p => {
    const count = counts[p];
    const percentage = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0;
    
    const idSuffix = p.toLowerCase();
    
    // Percentage display text
    const pctEl = document.getElementById(`pct-${idSuffix}`);
    if (pctEl) pctEl.textContent = `${percentage}%`;

    // Count display text
    const cntEl = document.getElementById(`cnt-${idSuffix}`);
    if (cntEl) cntEl.textContent = `(${count} 人)`;

    // Animating the progress bar
    const barEl = document.getElementById(`bar-${idSuffix}`);
    if (barEl) {
      barEl.style.width = `${percentage}%`;
    }
  });
}

// Copy Voter URL to Clipboard
function copyVoterUrl() {
  voterUrlInput.select();
  voterUrlInput.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(voterUrlInput.value)
    .then(() => {
      const originalText = copyUrlBtn.textContent;
      copyUrlBtn.textContent = '已複製!';
      copyUrlBtn.classList.remove('btn-secondary');
      copyUrlBtn.classList.add('btn-primary');
      setTimeout(() => {
        copyUrlBtn.textContent = originalText;
        copyUrlBtn.classList.remove('btn-primary');
        copyUrlBtn.classList.add('btn-secondary');
      }, 2000);
    })
    .catch(err => {
      console.error('Could not copy text: ', err);
    });
}

// Confirm and Reset Poll
async function confirmReset() {
  const password = prompt('請輸入重置密碼：');
  if (password === null) {
    return; // Cancelled
  }
  if (password !== '0515') {
    alert('密碼錯誤，拒絕重置！');
    return;
  }

  if (!confirm('確定要清空所有的投票數據嗎？此操作無法還原。')) {
    return;
  }

  // Clear in-memory state
  votesState = {};
  updateUI();

  // Reset database state using keyvalue.immanuel.co
  try {
    const emptyState = {};
    const hexStr = stringToHex(JSON.stringify(emptyState));
    
    // Write empty state to DB
    const res = await fetch(`https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${room}/votes/${hexStr}`, {
      method: 'POST',
      headers: {
        'Content-Length': '0'
      }
    });
    console.log('Database reset status:', await res.json());
  } catch (err) {
    console.error('Error resetting DB:', err);
  }

  // Broadcast reset event via MQTT
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(`ai-survey/${room}/vote`, JSON.stringify({ type: 'reset' }), { retain: false });
  }
}

// Start Init
document.addEventListener('DOMContentLoaded', init);
