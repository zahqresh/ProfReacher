const $ = (selector) => document.querySelector(selector);
const checkButton = $('#check-button');
const sendButton = $('#send-button');
const stopButton = $('#stop-button');
const taskStatus = $('#task-status');
let status = null;
let job = null;

function setMessage(message, error = false) {
  taskStatus.textContent = message;
  taskStatus.classList.toggle('error', error);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString();
}

function setBusy(busy) {
  checkButton.disabled = busy;
  sendButton.disabled = busy || !status || status.due === 0 || status.remainingToday === 0;
  stopButton.hidden = !busy;
  stopButton.disabled = job?.status === 'stopping';
}

function appendCell(row, value, strong = false, detail = '', column, item) {
  const cell = document.createElement('td');
  if (column.outcome) {
    const select = document.createElement('select');
    for (const [outcome, label] of [
      ['active', 'No outcome'],
      ['interested', 'Interested'],
      ['not_interested', 'Not interested'],
      ['do_not_contact', 'Do not contact'],
    ]) {
      const option = document.createElement('option');
      option.value = outcome;
      option.textContent = label;
      option.selected = outcome === item.outcome;
      select.append(option);
    }
    const save = document.createElement('button');
    save.className = 'button secondary';
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => saveOutcome(item.email, select.value, save));
    cell.append(select, save);
    row.append(cell);
    return cell;
  }
  if (strong) {
    const title = document.createElement('strong');
    title.textContent = value || '';
    cell.append(title);
    if (detail) {
      const secondary = document.createElement('span');
      secondary.textContent = detail;
      cell.append(secondary);
    }
  } else {
    cell.textContent = value || '';
  }
  row.append(cell);
}

function renderTable(target, rows, columns, emptyMessage) {
  target.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyMessage;
    target.append(empty);
    return;
  }

  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.textContent = column.title;
    headerRow.append(cell);
  }
  head.append(headerRow);
  table.append(head);
  const body = document.createElement('tbody');
  for (const item of rows) {
    const row = document.createElement('tr');
    for (const column of columns) {
      const value = column.outcome ? '' : column.value(item);
      appendCell(row, value, column.strong, column.detail ? column.detail(item) : '', column, item);
    }
    body.append(row);
  }
  table.append(body);
  target.append(table);
}

function render(data) {
  status = data;
  $('#sent-count').textContent = data.sent;
  $('#replied-count').textContent = data.inboxChecked ? data.replied : '—';
  $('#due-count').textContent = data.inboxChecked ? data.due : `~${data.due}`;
  $('#followups-sent-count').textContent = data.followUpsSent;
  $('#outcomes-count').textContent = data.outcomes;
  const quota = data.remainingToday ? `${data.remainingToday} sends remain today` : 'daily send cap reached';
  const inboxNote = data.inboxChecked ? '' : ' · inbox check needed to confirm';
  $('#run-summary').textContent = `Wait ${data.followUpDays} days · ${quota}${inboxNote} · ${data.dryRun ? 'safe mode saves drafts' : 'live mode sends email'}`;
  $('#due-meta').textContent = `${data.due} potential`;

  const outcomeColumn = { title: 'Outcome', outcome: true };
  renderTable($('#due-table'), data.candidates, [
    { title: 'Professor', value: (item) => item.name, strong: true, detail: (item) => item.email },
    { title: 'University', value: (item) => item.university || '—' },
    { title: 'Original email', value: (item) => formatDate(item.sentAt) },
    { title: 'Age', value: (item) => `${item.daysSinceSent} days` },
    outcomeColumn,
  ], 'No one currently meets the follow-up criteria.');

  renderTable($('#replies-table'), data.detectedReplies, [
    { title: 'Professor', value: (item) => item.name, strong: true, detail: (item) => item.email },
    { title: 'University', value: (item) => item.university || '—' },
    { title: 'Original email', value: (item) => formatDate(item.sentAt) },
    { title: 'Reply received', value: (item) => formatDate(item.repliedAt), strong: true, detail: (item) => item.subject },
    outcomeColumn,
  ], 'No replies have been detected yet. Use “Check inbox for replies” to scan the configured mailbox.');
  renderTable($('#outcomes-table'), data.recordedOutcomes, [
    { title: 'Professor', value: (item) => item.name, strong: true, detail: (item) => item.email },
    { title: 'University', value: (item) => item.university || '—' },
    { title: 'Outcome', value: (item) => item.outcome.replaceAll('_', ' ') },
    { title: 'Updated', value: (item) => formatDate(item.updatedAt) },
    outcomeColumn,
  ], 'No contact outcomes have been recorded.');
  sendButton.textContent = data.dryRun ? 'Prepare drafts' : 'Send follow-ups';
  setBusy(Boolean(job && ['running', 'stopping'].includes(job.status)));
}

async function saveOutcome(email, outcome, button) {
  button.disabled = true;
  try {
    const response = await fetch('/api/contact-outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, outcome }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save contact outcome.');
    await loadStatus();
    setMessage(outcome === 'active'
      ? `Cleared the saved outcome for ${email}.`
      : `Saved “${outcome.replaceAll('_', ' ')}” for ${email}. This contact will not receive further follow-ups.`);
  } catch (error) {
    setMessage(error.message, true);
    button.disabled = false;
  }
}

async function loadStatus() {
  const response = await fetch('/api/followups');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load follow-up status.');
  render(data);
  setMessage(data.lastInboxCheck
    ? `Last inbox check: ${new Date(data.lastInboxCheck).toLocaleString()}. Sending follow-ups always checks for new replies first.`
    : 'Inbox has not been checked yet. Sending follow-ups will check for replies first.');
}

async function start(action) {
  if (action === 'followups-send' && !status.dryRun) {
    const count = Math.min(status.due, status.remainingToday);
    const confirmed = window.confirm(`This is LIVE MODE. Send follow-up emails to up to ${count} eligible professors? The configured daily sending limit still applies.`);
    if (!confirmed) return;
  }
  setMessage(action === 'followups-sync' ? 'Checking the inbox…' : status.dryRun ? 'Preparing follow-up drafts…' : 'Sending follow-up emails…');
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start the task.');
    job = result.job;
    setBusy(true);
  } catch (error) {
    setMessage(error.message, true);
  }
}

checkButton.addEventListener('click', () => start('followups-sync'));
sendButton.addEventListener('click', () => start('followups-send'));
stopButton.addEventListener('click', async () => {
  setMessage('Stopping the current task…');
  try {
    const response = await fetch('/api/stop', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not stop the task.');
    job = result.job;
    setBusy(true);
  } catch (error) {
    setMessage(error.message, true);
  }
});

const socket = window.appSocket;
socket.on('snapshot', (snapshot) => {
  job = snapshot.job;
  setBusy(Boolean(job && ['running', 'stopping'].includes(job.status)));
});
socket.on('job', async (updatedJob) => {
  job = updatedJob;
  setBusy(Boolean(job && ['running', 'stopping'].includes(job.status)));
  if (!job || !['running', 'stopping'].includes(job.status)) {
    if (job?.action === 'followups-sync') setMessage(job.status === 'completed' ? 'Inbox check completed.' : 'Inbox check did not complete successfully.', job.status !== 'completed');
    else if (job?.action === 'followups-send') setMessage(job.status === 'completed' ? 'Follow-up run completed.' : 'Follow-up run did not complete successfully.', job.status !== 'completed');
    try {
      await loadStatus();
    } catch (error) {
      setMessage(error.message, true);
    }
  }
});
socket.on('notification', (notification) => window.showToast(notification));

loadStatus().catch((error) => setMessage(error.message, true));
