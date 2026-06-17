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

let room = '';
let voterId = '';
let mqttClient = null;

// DOM Elements
const votingCard = document.getElementById('voting-card');
const successCard = document.getElementById('success-card');
const surveyForm = document.getElementById('survey-form');
const submitBtn = document.getElementById('submit-btn');
const votedBadgesContainer = document.getElementById('voted-badges');
const editVoteBtn = document.getElementById('edit-vote-btn');
const optionCards = document.querySelectorAll('.option-card');
const checkboxes = document.querySelectorAll('input[type="checkbox"]');

// Initialize Voter Client
function init() {
  const urlParams = new URLSearchParams(window.location.search);
  room = urlParams.get('room');

  if (!room) {
    alert('無效的投票網址。請重新掃描主螢幕的 QR Code。');
    return;
  }

  // Setup unique Voter ID (persisted in localStorage)
  voterId = localStorage.getItem('survey_voter_id');
  if (!voterId) {
    voterId = 'voter_' + Math.random().toString(36).substring(2, 12);
    localStorage.setItem('survey_voter_id', voterId);
  }

  // Set up visual UI triggers for option checkboxes
  checkboxes.forEach(cb => {
    const card = cb.closest('.option-card');
    
    cb.addEventListener('change', () => {
      toggleCardStyle(card, cb.checked);
    });
  });

  // Handle previous vote loading
  const savedVote = localStorage.getItem(`survey_voted_${room}`);
  if (savedVote) {
    try {
      const choices = JSON.parse(savedVote);
      applyChoicesToForm(choices);
      showSuccessScreen(choices);
    } catch (e) {
      console.error('Error parsing saved vote JSON:', e);
      localStorage.removeItem(`survey_voted_${room}`);
    }
  }

  // Handle Form Submission
  surveyForm.addEventListener('submit', handleVoteSubmit);

  // Handle Edit Vote button
  editVoteBtn.addEventListener('click', handleEditVote);

  // Connect to MQTT to listen for Reset signals
  connectMQTT();
}

// Connect to EMQX Public Broker over WebSockets
function connectMQTT() {
  if (typeof mqtt === 'undefined') {
    console.warn('MQTT library is not loaded. Operating in HTTP database sync mode.');
    return;
  }

  try {
    const brokerUrl = 'wss://broker.emqx.io:8084/mqtt';
    const options = {
      clientId: 'ai_survey_voter_' + Math.random().toString(16).substring(2, 8),
      clean: true,
      connectTimeout: 5000,
      reconnectPeriod: 3000
    };

    mqttClient = mqtt.connect(brokerUrl, options);

    mqttClient.on('connect', () => {
      console.log('Connected to MQTT Broker.');
      mqttClient.subscribe(`ai-survey/${room}/vote`);
    });

    mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === 'reset') {
          // Clear local storage vote state
          localStorage.removeItem(`survey_voted_${room}`);
          
          // Reset checkboxes and card styling
          checkboxes.forEach(cb => cb.checked = false);
          optionCards.forEach(card => card.classList.remove('checked'));
          
          // Show the voting card, hide success card
          successCard.style.display = 'none';
          votingCard.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = '提交投票';
        }
      } catch (e) {
        console.error('Error handling MQTT reset message:', e);
      }
    });
  } catch (err) {
    console.error('Error initializing MQTT connection:', err);
  }
}

function toggleCardStyle(card, isChecked) {
  if (isChecked) {
    card.classList.add('checked');
  } else {
    card.classList.remove('checked');
  }
}

// Populate the checkboxes based on saved selections
function applyChoicesToForm(choices) {
  checkboxes.forEach(cb => {
    cb.checked = choices.includes(cb.value);
    const card = cb.closest('.option-card');
    toggleCardStyle(card, cb.checked);
  });
}

// Switch UI from voting form to success screen
function showSuccessScreen(choices) {
  votedBadgesContainer.innerHTML = '';
  if (choices.length === 0) {
    const badge = document.createElement('span');
    badge.className = 'voted-badge';
    badge.textContent = '無 (未勾選任何平臺)';
    badge.style.color = 'var(--text-muted)';
    votedBadgesContainer.appendChild(badge);
  } else {
    choices.forEach(c => {
      const badge = document.createElement('span');
      badge.className = 'voted-badge';
      badge.textContent = c;
      votedBadgesContainer.appendChild(badge);
    });
  }

  votingCard.style.display = 'none';
  successCard.style.display = 'flex';
}

// Handle submit process
async function handleVoteSubmit(e) {
  e.preventDefault();

  // Get selected checkboxes
  const selectedChoices = [];
  checkboxes.forEach(cb => {
    if (cb.checked) {
      selectedChoices.push(cb.value);
    }
  });

  // Validation: Must select 1 to 7 items
  if (selectedChoices.length === 0) {
    alert('請至少選擇 1 個 AI 平臺進行提交！(最多可選 7 個項目)');
    return;
  }

  // Lock UI during submit
  submitBtn.disabled = true;
  submitBtn.textContent = '正在送出投票...';

  // 1. Submit to database (KeyValue API) via Fetch API
  try {
    // Read current database state
    const response = await fetch(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/${room}/votes`);
    const hexData = await response.json();
    
    let dbVotes = {};
    if (hexData && hexData !== '""') {
      const jsonStr = hexToString(hexData);
      if (jsonStr) {
        dbVotes = JSON.parse(jsonStr);
      }
    }

    // Update with voter's choice
    dbVotes[voterId] = selectedChoices;

    // Convert updated state to hex
    const updatedHex = stringToHex(JSON.stringify(dbVotes));

    // Post it back to KeyValue
    await fetch(`https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${room}/votes/${updatedHex}`, {
      method: 'POST',
      headers: {
        'Content-Length': '0'
      }
    });

  } catch (err) {
    console.error('Error submitting vote to KeyValue Database:', err);
    // If the database is completely offline/blocked, we continue with MQTT so live presentation is still active
  }

  // 2. Publish live event via MQTT
  if (typeof mqtt !== 'undefined' && mqttClient && mqttClient.connected) {
    try {
      mqttClient.publish(`ai-survey/${room}/vote`, JSON.stringify({
        type: 'vote',
        voterId: voterId,
        choices: selectedChoices
      }));
    } catch (e) {
      console.error('MQTT publish error:', e);
    }
  }

  // 3. Save state in LocalStorage
  localStorage.setItem(`survey_voted_${room}`, JSON.stringify(selectedChoices));

  // 4. Update UI
  showSuccessScreen(selectedChoices);
}

// Handle clicking edit vote button
function handleEditVote() {
  successCard.style.display = 'none';
  votingCard.style.display = 'block';
  submitBtn.disabled = false;
  submitBtn.textContent = '更新投票';
}

// Start Init
document.addEventListener('DOMContentLoaded', init);
