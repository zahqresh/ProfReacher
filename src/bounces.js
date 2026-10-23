const $ = (selector) => document.querySelector(selector);
const scanButton = $('#scan-button');
let activeJob = null;

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function showError(message) {
  $('#scan-status').textContent = message;
  $('#scan-status').classList.add('error');
}

function render(data) {
  const bounces = data.bounces || [];
  const sent = data.sent || 0;
  const noBounceRate = sent ? Math.max(0, 100 - (bounces.length / sent * 100)) : null;
  $('#sent-count').textContent = sent;
  $('#bounce-count').textContent = bounces.length;
  $('#delivery-rate').textContent = noBounceRate === null ? '—' : `${noBounceRate.toFixed(1)}%`;
  $('#excluded-count').textContent = bounces.length;
  $('#scan-info').textContent = data.lastInboxCheck
    ? `Last checked ${formatDate(data.lastInboxCheck)} · scans run from the sent email date onward`
    : 'Inbox scan has not run yet.';

  const table = $('#bounce-table');
  table.replaceChildren();
  if (!bounces.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = data.inboxChecked ? 'No confirmed delivery failures found.' : 'Run an inbox scan to look for delivery failures.';
    table.append(empty);
    return;
  }

  const grid = document.createElement('table');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  for (const label of ['Professor / recipient', 'University', 'Bounce received', 'Failure detail']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    heading.append(cell);
  }
  head.append(heading);
  grid.append(head);
  const body = document.createElement('tbody');
  for (const bounce of bounces) {
    const row = document.createElement('tr');
    for (const value of [bounce.name, bounce.university || '—', formatDate(bounce.bouncedAt), bounce.reason || bounce.subject || 'Delivery failure']) {
      const cell = document.createElement('td');
      cell.textContent = value || '—';
      if (value === (bounce.reason || bounce.subject || 'Delivery failure')) cell.className = 'reason';
      row.append(cell);
    }
    body.append(row);
  }
  grid.append(body);
  table.append(grid);
}

async function refresh() {
  const response = await fetch('/api/bounces');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load bounce status.');
  render(data);
}

scanButton.addEventListener('click', async () => {
  scanButton.disabled = true;
  $('#scan-status').textContent = 'Checking your inbox for delivery failure notices…';
  $('#scan-status').classList.remove('error');
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'followups-sync' }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start inbox scan.');
    activeJob = result.job;
  } catch (error) {
    showError(error.message);
    scanButton.disabled = false;
  }
});

const socket = window.appSocket;
socket.on('snapshot', ({ job }) => {
  activeJob = job;
  scanButton.disabled = Boolean(job && ['running', 'stopping'].includes(job.status));
});
socket.on('job', async (job) => {
  activeJob = job;
  const busy = job && ['running', 'stopping'].includes(job.status);
  scanButton.disabled = Boolean(busy);
  if (!busy) {
    $('#scan-status').textContent = job?.status === 'completed' ? 'Mailbox scan completed.' : 'Mailbox scan ended.';
    try {
      await refresh();
    } catch (error) {
      showError(error.message);
    }
  }
});
socket.on('notification', (notification) => window.showToast(notification));
refresh().catch((error) => showError(error.message));
