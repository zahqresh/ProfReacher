const $ = (selector) => document.querySelector(selector);
const previewSlider = $('#preview-limit');
const sendSlider = $('#send-limit');
const previewButton = $('#preview-button');
const sendButton = $('#send-button');
const stopButton = $('#stop-button');
const logBox = $('#log-box');
const logs = [];
let active = false;
let currentJob = null;
let configReady = false;
let previewProgress = { total: 0, done: 0 };

function showError(message = '') {
  const target = $('#error-message');
  target.textContent = message;
  target.hidden = !message;
}

function setActive(value) {
  active = value;
  previewButton.disabled = value || !configReady;
  sendButton.disabled = value || !configReady;
  previewSlider.disabled = value || !configReady;
  sendSlider.disabled = value || !configReady;
  stopButton.hidden = !value;
  stopButton.disabled = currentJob?.status === 'stopping';
  $('#activity-status').textContent = value ? (currentJob?.status === 'stopping' ? 'Stopping' : 'Running') : 'Ready';
  $('#activity-status').classList.toggle('busy', value);
  $('#progress-area').hidden = !value;
  if (!value) $('#progress-fill').classList.add('indeterminate');
}

function updateProgress(entry) {
  if (!active || !currentJob || currentJob.action !== 'preview') return;
  const totalMatch = entry.text.match(/pending, generating hooks for (\d+)/);
  if (totalMatch) {
    previewProgress = { total: Number(totalMatch[1]), done: 0 };
  } else if (/\brating \d+\/10\b|hook failed/.test(entry.text)) {
    previewProgress.done += 1;
  }
  if (!previewProgress.total) return;
  const percent = Math.min(100, Math.round((previewProgress.done / previewProgress.total) * 100));
  $('#progress-fill').classList.remove('indeterminate');
  $('#progress-fill').style.width = `${percent}%`;
  $('#progress-caption').textContent = `${previewProgress.done} of ${previewProgress.total} hooks processed · ${percent}%`;
}

function renderLogs() {
  logBox.replaceChildren();
  if (!logs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-log';
    empty.textContent = 'Your live activity will appear here.';
    logBox.append(empty);
  } else {
    for (const entry of logs) {
      const row = document.createElement('div');
      row.className = `log-row ${entry.stream}`;
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const text = document.createElement('span');
      text.className = 'log-text';
      text.textContent = entry.text;
      row.append(time, text);
      logBox.append(row);
    }
    logBox.scrollTop = logBox.scrollHeight;
  }
  $('#log-count').textContent = `${logs.length} ${logs.length === 1 ? 'event' : 'events'}`;
}

function appendLog(entry) {
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  renderLogs();
}

async function loadConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Could not read dashboard configuration.');
  const config = await response.json();
  sendSlider.value = String(Math.max(1, Math.min(100, config.dailyLimit)));
  $('#send-value').value = sendSlider.value;
  const pill = $('#mode-pill');
  pill.textContent = config.dryRun ? 'SAFE MODE' : 'LIVE MODE';
  pill.classList.toggle('live', !config.dryRun);
  if (!config.dryRun) {
    $('#task-hint').textContent = 'Live mode is enabled in .env. Starting sends will deliver real emails; you will be asked to confirm.';
  }
  configReady = true;
  setActive(active);
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status');
    const status = await response.json();
    if (!response.ok) throw new Error(status.error || 'Could not load status.');
    $('#eligible').textContent = status.eligibleRows;
    $('#pending').textContent = status.pending;
    $('#hooks-ready').textContent = status.hooksReady;
    $('#sent-today').textContent = status.sentToday;
  } catch (error) {
    showError(error.message);
  }
}

async function start(action) {
  showError('');
  const limit = Number(action === 'preview' ? previewSlider.value : sendSlider.value);
  if (action === 'send' && $('#mode-pill').classList.contains('live')) {
    const confirmed = window.confirm(`This is LIVE MODE. Up to ${limit} emails per day may be sent from your configured account. Continue?`);
    if (!confirmed) return;
  }
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, limit }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start the task.');
    currentJob = result.job;
    previewProgress = { total: 0, done: 0 };
    $('#progress-fill').style.width = '';
    $('#progress-fill').classList.add('indeterminate');
    $('#progress-caption').textContent = action === 'preview' ? 'Preparing hook generation…' : 'Running send cycle…';
    setActive(true);
    $('#activity-status').textContent = 'Running';
  } catch (error) {
    showError(error.message);
  }
}

previewSlider.addEventListener('input', () => { $('#preview-value').value = previewSlider.value; });
sendSlider.addEventListener('input', () => { $('#send-value').value = sendSlider.value; });
previewButton.addEventListener('click', () => start('preview'));
sendButton.addEventListener('click', () => start('send'));
stopButton.addEventListener('click', async () => {
  showError('');
  try {
    const response = await fetch('/api/stop', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not stop the task.');
    currentJob = result.job;
    $('#activity-status').textContent = 'Stopping';
  } catch (error) {
    showError(error.message);
  }
});
$('#clear-button').addEventListener('click', () => { logs.length = 0; renderLogs(); });

const events = new EventSource('/api/events');
events.addEventListener('open', () => {
  $('#connection-dot').classList.add('online');
  $('#connection-label').textContent = 'Local dashboard';
});
events.addEventListener('error', () => {
  $('#connection-dot').classList.remove('online');
  $('#connection-label').textContent = 'Reconnecting';
});
events.addEventListener('snapshot', (event) => {
  const snapshot = JSON.parse(event.data);
  currentJob = snapshot.job;
  logs.splice(0, logs.length, ...(snapshot.logs || []));
  setActive(Boolean(currentJob?.status === 'running' || currentJob?.status === 'stopping'));
  if (currentJob && !active) $('#activity-status').textContent = currentJob.status;
  renderLogs();
});
events.addEventListener('log', (event) => {
  const entry = JSON.parse(event.data);
  appendLog(entry);
  updateProgress(entry);
});
events.addEventListener('job', (event) => {
  currentJob = JSON.parse(event.data);
  setActive(currentJob.status === 'running' || currentJob.status === 'stopping');
  if (!active) {
    $('#activity-status').textContent = currentJob.status;
    refreshStatus();
  }
});

loadConfig().catch((error) => showError(error.message));
refreshStatus();
