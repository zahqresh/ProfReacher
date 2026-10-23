const $ = (selector) => document.querySelector(selector);
const form = $('#settings-form');
const banner = $('#banner');
const secretKeys = ['OPENROUTER_API_KEY', 'LANGSEARCH_API_KEY', 'OPENALEX_API_KEY', 'SMTP_PASS', 'IMAP_PASS'];

function showBanner(message, isError = false) {
  banner.textContent = message;
  banner.classList.toggle('error', isError);
  banner.classList.add('visible');
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setReport(selector, message, isError = false) {
  const element = $(selector);
  element.textContent = message;
  element.classList.toggle('invalid', isError);
}

function setSourceMode(mode) {
  $('#sheet-source').hidden = mode !== 'sheet';
  $('#csv-source').hidden = mode !== 'csv';
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) {
    if (Array.isArray(result.errors)) throw new Error(result.errors.join('\n'));
    if (result.report?.errors?.length) throw new Error(result.report.errors.join('\n'));
    throw new Error(result.error || 'The request could not be completed.');
  }
  return result;
}

async function loadSettings() {
  const settings = await requestJson('/api/settings');
  for (const [key, value] of Object.entries(settings)) {
    const field = document.getElementById(key);
    if (!field) continue;
    if (secretKeys.includes(key)) {
      $(`#${key}-status`).textContent = value.configured ? 'Saved' : 'Not set';
      continue;
    }
    field.value = value;
  }
  const mode = settings.SHEET_CSV_URL ? 'sheet' : 'csv';
  document.querySelector(`input[name="source-type"][value="${mode}"]`).checked = true;
  setSourceMode(mode);
  setReport('#csv-report', settings.SHEET_CSV_URL ? '' : `Current local source: ${settings.CSV_PATH || './professors.csv'}`);
}

function uploadContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

function showCsvReport(report) {
  const message = `${report.rowCount} data rows · ${report.eligible} eligible · ${report.skipped} skipped${report.duplicates ? ` · ${report.duplicates} duplicate email(s)` : ''}. Columns: ${report.columns.join(', ')}.`;
  setReport('#csv-report', message, !report.valid);
}

async function validateSheet() {
  const url = $('#SHEET_CSV_URL').value.trim();
  setReport('#sheet-report', 'Checking Google Sheet access and columns…');
  try {
    const { report } = await requestJson('/api/validate-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const message = `${report.rowCount} data rows · ${report.eligible} eligible · ${report.skipped} skipped. Required columns are present: ${report.columns.join(', ')}.`;
    setReport('#sheet-report', message);
  } catch (error) {
    setReport('#sheet-report', error.message, true);
  }
}

async function validateCsvFile(file) {
  const content = await file.text();
  return requestJson('/api/validate-csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

async function uploadCsv() {
  const file = $('#csv-file').files[0];
  if (!file) {
    setReport('#csv-report', 'Choose a CSV file first.', true);
    return;
  }
  setReport('#csv-report', 'Checking the CSV format…');
  try {
    const checked = await validateCsvFile(file);
    showCsvReport(checked.report);
    const content = await file.text();
    const saved = await requestJson('/api/upload/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    $('#CSV_PATH').value = saved.path;
    document.querySelector('input[name="source-type"][value="csv"]').checked = true;
    setSourceMode('csv');
    setReport('#csv-report', `${saved.message} ${saved.report.rowCount} rows · ${saved.report.eligible} eligible · ${saved.report.skipped} skipped.`);
  } catch (error) {
    setReport('#csv-report', error.message, true);
  }
}

async function uploadCv() {
  const file = $('#cv-file').files[0];
  if (!file) {
    setReport('#cv-report', 'Choose a PDF file first.', true);
    return;
  }
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    setReport('#cv-report', 'Choose a PDF file.', true);
    return;
  }
  if (file.size > 15_000_000) {
    setReport('#cv-report', 'Choose a PDF smaller than 15 MB.', true);
    return;
  }
  setReport('#cv-report', 'Uploading CV to this computer…');
  try {
    const content = await uploadContent(file);
    const result = await requestJson('/api/upload/cv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    $('#CV_PATH').value = result.path;
    setReport('#cv-report', result.message);
  } catch (error) {
    setReport('#cv-report', error.message, true);
  }
}

function makeSettingsPayload() {
  const data = Object.fromEntries(new FormData(form).entries());
  const sourceMode = form.querySelector('input[name="source-type"]:checked')?.value;
  data.SHEET_CSV_URL = sourceMode === 'sheet' ? $('#SHEET_CSV_URL').value.trim() : '';
  data.CSV_PATH = sourceMode === 'csv' ? $('#CSV_PATH').value.trim() || './professors.csv' : $('#CSV_PATH').value.trim() || './professors.csv';
  for (const key of secretKeys) data[`clear_${key}`] = form.elements[`clear_${key}`].checked;
  return data;
}

form.addEventListener('change', (event) => {
  if (event.target.name === 'source-type') setSourceMode(event.target.value);
  if (event.target.name === 'clear_OPENALEX_API_KEY' && event.target.checked) {
    $('#OPENALEX_ENABLED').value = 'false';
  }
});
$('#OPENALEX_API_KEY').addEventListener('input', (event) => {
  if (event.target.value.trim()) {
    $('#OPENALEX_ENABLED').value = 'true';
  } else if ($('#OPENALEX_API_KEY-status').textContent === 'Not set') {
    $('#OPENALEX_ENABLED').value = 'false';
  }
});
$('#validate-sheet').addEventListener('click', validateSheet);
$('#upload-csv').addEventListener('click', uploadCsv);
$('#upload-cv').addEventListener('click', uploadCv);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = makeSettingsPayload();
  if (payload.SCHEDULE_ENABLED === 'true' && payload.DRY_RUN === 'false'
    && !window.confirm(`Enable automatic LIVE email sending every day at ${payload.SCHEDULE_TIME || 'the selected time'}, up to ${payload.SCHEDULE_DAILY_LIMIT} emails per day? The dashboard must remain open and this cannot be canceled once messages are in progress.`)) {
    return;
  }
  const saveButton = $('#save-button');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  try {
    const result = await requestJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    for (const key of secretKeys) {
      $(`#${key}-status`).textContent = result.secrets[key] ? 'Saved' : 'Not set';
      $(`#${key}`).value = '';
      form.elements[`clear_${key}`].checked = false;
    }
    showBanner(result.message);
    window.showToast({
      type: 'success',
      title: 'Settings saved',
      message: payload.SCHEDULE_ENABLED === 'true'
        ? `Daily campaign is enabled for ${payload.SCHEDULE_TIME} local time.`
        : 'Your configuration was updated.',
    });
  } catch (error) {
    showBanner(error.message, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save settings';
  }
});

const socket = window.appSocket;
socket.on('notification', (notification) => window.showToast(notification));
loadSettings().catch((error) => showBanner(error.message, true));
