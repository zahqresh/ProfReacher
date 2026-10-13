import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';
const maxLogs = 500;
const projectRoot = path.dirname(root);
const envPath = path.join(projectRoot, '.env');
const clients = new Set();
let job = null;
let child = null;
let logHistory = [];

function sendEvent(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(message);
}

function addLog(text, stream = 'stdout') {
  if (!text) return;
  const entry = { time: new Date().toISOString(), text, stream };
  logHistory.push(entry);
  if (logHistory.length > maxLogs) logHistory = logHistory.slice(-maxLogs);
  sendEvent('log', entry);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request, maxBytes = 10_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('Request body is too large.');
  }
  return JSON.parse(body || '{}');
}

function validLocalRequest(request) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!allowedHosts.has(request.headers.host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && allowedHosts.has(parsed.host);
  } catch {
    return false;
  }
}

function requireLocalOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && new Set([`localhost:${port}`, `127.0.0.1:${port}`]).has(parsed.host);
  } catch {
    return false;
  }
}

const secretKeys = new Set(['SMTP_PASS', 'OPENROUTER_API_KEY', 'LANGSEARCH_API_KEY', 'OPENALEX_API_KEY']);
const settingKeys = [
  'PORT', 'SHEET_CSV_URL', 'CSV_PATH', 'CV_PATH', 'PROMPTS_DIR',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'FROM_NAME', 'SUBJECT',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODEL',
  'LANGSEARCH_API_KEY', 'OPENALEX_API_KEY', 'SEARCH_COUNT', 'USE_WEB_SEARCH', 'OPENALEX_ENABLED',
  'DAILY_LIMIT', 'MIN_DELAY_MIN', 'MAX_DELAY_MIN', 'MIN_RATING',
  'SEND_LOW_CONFIDENCE', 'DRY_RUN',
];

function readSettings() {
  const values = {
    PORT: process.env.PORT || '4173',
    SHEET_CSV_URL: '',
    CSV_PATH: './professors.csv',
    CV_PATH: '',
    PROMPTS_DIR: './prompts',
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '465',
    SMTP_USER: '',
    SMTP_PASS: '',
    FROM_NAME: 'Muhammad Hamza',
    SUBJECT: 'CSC 2027 PhD Application Enquiry - Muhammad Hamza',
    OPENROUTER_API_KEY: '',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_MODEL: 'openrouter/free',
    LANGSEARCH_API_KEY: '',
    OPENALEX_API_KEY: '',
    SEARCH_COUNT: '5',
    USE_WEB_SEARCH: 'true',
    OPENALEX_ENABLED: process.env.OPENALEX_ENABLED ?? (process.env.OPENALEX_API_KEY ? 'true' : 'false'),
    DAILY_LIMIT: '20',
    MIN_DELAY_MIN: '4',
    MAX_DELAY_MIN: '11',
    MIN_RATING: '0',
    SEND_LOW_CONFIDENCE: 'false',
    DRY_RUN: 'true',
  };
  for (const key of settingKeys) {
    if (process.env[key] !== undefined) values[key] = process.env[key];
  }
  return values;
}

function escapeEnvValue(value) {
  return `'${String(value)}'`;
}

function persistSettings(updates) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const updatedKeys = new Set();
  const output = lines.map((line) => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (!match || !Object.hasOwn(updates, match[1])) return line;
    const key = match[1];
    updatedKeys.add(key);
    const value = updates[key];
    return `${key}=${escapeEnvValue(value)}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) output.push(`${key}=${escapeEnvValue(value)}`);
  }

  fs.writeFileSync(envPath, output.join('\n').replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 });
  for (const [key, value] of Object.entries(updates)) process.env[key] = String(value);
}

function validateSettings(values) {
  const errors = [];
  if (Object.values(values).some((value) => /[\r\n]/.test(value))) {
    errors.push('Setting values cannot contain line breaks.');
  }
  const dashboardPort = Number(values.PORT);
  if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) {
    errors.push('Dashboard port must be a whole number from 1 to 65535.');
  }
  const sheetUrl = values.SHEET_CSV_URL.trim();
  const csvPath = values.CSV_PATH.trim();
  if (sheetUrl) {
    try {
      const parsed = new URL(sheetUrl);
      const isGoogleSheet = parsed.protocol === 'https:' && parsed.hostname === 'docs.google.com'
        && /\/spreadsheets\/d\/[^/]+/.test(parsed.pathname);
      const isCsv = parsed.protocol === 'https:' && /\.csv(?:$|[?#])/i.test(parsed.pathname + parsed.search);
      if (!['http:', 'https:'].includes(parsed.protocol) || (!isGoogleSheet && !isCsv)) {
        errors.push('Enter a Google Sheets URL or a direct HTTPS CSV URL.');
      }
    } catch {
      errors.push('The Google Sheet / CSV URL is not a valid URL.');
    }
  } else {
    if (!csvPath) errors.push('Choose a Google Sheet URL or a local CSV file.');
    else if (!fs.existsSync(path.resolve(projectRoot, csvPath))) errors.push(`CSV file not found: ${csvPath}. Upload a CSV or enter an existing local path.`);
    else {
      try {
        const report = inspectCsv(fs.readFileSync(path.resolve(projectRoot, csvPath), 'utf8'));
        if (!report.valid) errors.push(...report.errors.map((error) => `CSV format: ${error}`));
      } catch (error) {
        errors.push(`CSV could not be parsed: ${error.message}`);
      }
    }
  }

  const smtpPort = Number(values.SMTP_PORT);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) errors.push('SMTP port must be a number from 1 to 65535.');
  for (const [key, min, max] of [['DAILY_LIMIT', 1, 1000], ['SEARCH_COUNT', 1, 20]]) {
    const value = Number(values[key]);
    if (!Number.isInteger(value) || value < min || value > max) errors.push(`${key} must be a whole number from ${min} to ${max}.`);
  }
  for (const key of ['MIN_DELAY_MIN', 'MAX_DELAY_MIN']) {
    const value = Number(values[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1440) errors.push(`${key} must be from 0 to 1440 minutes.`);
  }
  if (Number(values.MIN_DELAY_MIN) > Number(values.MAX_DELAY_MIN)) errors.push('Minimum delay cannot be greater than maximum delay.');
  const rating = Number(values.MIN_RATING);
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) errors.push('Minimum rating must be from 0 to 10.');
  if (!['true', 'false'].includes(values.DRY_RUN)) errors.push('Choose whether dry-run mode is on or off.');
  if (!['true', 'false'].includes(values.USE_WEB_SEARCH)) errors.push('Choose whether web search is on or off.');
  if (!['true', 'false'].includes(values.OPENALEX_ENABLED)) errors.push('Choose whether OpenAlex research is on or off.');
  if (values.OPENALEX_ENABLED === 'true' && !values.OPENALEX_API_KEY.trim()) {
    errors.push('OpenAlex is enabled but no API key is saved. Add the key or switch OpenAlex off.');
  }
  if (!['true', 'false'].includes(values.SEND_LOW_CONFIDENCE)) errors.push('Choose how low-confidence hooks should be handled.');
  if (!values.SMTP_HOST.trim()) errors.push('SMTP host is required.');
  if (!values.OPENROUTER_MODEL.trim()) errors.push('OpenRouter model is required.');
  if (values.DRY_RUN === 'false' && (!values.SMTP_USER.trim() || !values.SMTP_PASS.trim())) {
    errors.push('Live sending requires an SMTP username and password.');
  }
  if (values.DRY_RUN === 'false' && !values.CV_PATH.trim()) errors.push('Live sending requires a CV file path.');
  if (values.CV_PATH.trim() && !fs.existsSync(path.resolve(projectRoot, values.CV_PATH.trim()))) {
    errors.push(`CV file not found: ${values.CV_PATH}. Upload a PDF or choose an existing path.`);
  }
  if (values.CV_PATH.trim() && fs.existsSync(path.resolve(projectRoot, values.CV_PATH.trim()))) {
    const cvPath = path.resolve(projectRoot, values.CV_PATH.trim());
    const fd = fs.openSync(cvPath, 'r');
    try {
      const signature = Buffer.alloc(5);
      fs.readSync(fd, signature, 0, signature.length, 0);
      if (!signature.equals(Buffer.from('%PDF-'))) errors.push('CV file must be a valid PDF.');
    } finally {
      fs.closeSync(fd);
    }
  }
  const promptsPath = path.resolve(projectRoot, values.PROMPTS_DIR.trim() || './prompts');
  if (!fs.existsSync(promptsPath) || !fs.statSync(promptsPath).isDirectory()) {
    errors.push(`Prompt folder not found: ${values.PROMPTS_DIR}. The prompts directory is required.`);
  } else {
    for (const name of ['system.txt', 'user.txt', 'no_web.txt', 'search_query.txt', 'email_body.txt', 'email_signature.txt']) {
      if (!fs.existsSync(path.join(promptsPath, name))) errors.push(`Prompt file missing: ${path.join(values.PROMPTS_DIR, name)}`);
    }
  }
  return errors;
}

const requiredCsvColumns = ['Name', 'University', 'Email', 'Profile Link', 'Research Interests', 'Applied'];
function inspectCsv(text) {
  const columns = parse(text, { bom: true, skip_empty_lines: true, to_line: 1, trim: true })[0] || [];
  const rows = parse(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  const missing = requiredCsvColumns.filter((column) => !columns.includes(column));
  if (missing.length) {
    return { valid: false, errors: [`Missing required column(s): ${missing.join(', ')}.`], columns, rowCount: rows.length, eligible: 0, skipped: rows.length };
  }
  const eligibleRows = [];
  let skipped = 0;
  for (const row of rows) {
    const email = String(row.Email || '').match(/[^\s;,<>]+@[^\s;,<>]+\.[^\s;,<>]+/);
    const name = String(row.Name || '').trim();
    if (!email || !name || String(row.Applied || '').toUpperCase() === 'TRUE') {
      skipped += 1;
      continue;
    }
    eligibleRows.push(email[0].toLowerCase());
  }
  const unique = new Set(eligibleRows);
  const duplicateCount = eligibleRows.length - unique.size;
  return {
    valid: rows.length > 0 && unique.size > 0,
    errors: rows.length === 0 ? ['CSV has headers but no data rows.'] : unique.size === 0 ? ['No eligible rows found. Add a valid Name and Email, and ensure Applied is not TRUE.'] : [],
    columns,
    rowCount: rows.length,
    eligible: unique.size,
    skipped: skipped + duplicateCount,
    duplicates: duplicateCount,
  };
}

function googleSheetCsvUrl(sheetUrl) {
  const parsed = new URL(sheetUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com' || !parsed.pathname.includes('/spreadsheets/')) {
    throw new Error('Use a Google Sheets link from docs.google.com.');
  }
  const match = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) throw new Error('The link does not look like a Google Sheets spreadsheet URL.');
  const gid = parsed.hash.match(/(?:^#|&)gid=(\d+)/)?.[1] || parsed.searchParams.get('gid');
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}

function startJob(action, limit) {
  const args = action === 'preview' ? ['preview', String(limit)] : ['send'];
  const env = {
    ...process.env,
    ...(action === 'send' ? { DAILY_LIMIT: String(limit) } : {}),
  };

  logHistory = [];
  job = {
    action,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    limit,
  };
  sendEvent('snapshot', { job, logs: logHistory });
  addLog(
    action === 'preview'
      ? `Starting hook preview for up to ${limit} professors.`
      : `Starting send cycle with a daily limit of ${limit}. DRY_RUN=${env.DRY_RUN !== 'false'}.`,
    'system',
  );

  child = spawn(process.execPath, [path.join(root, 'index.js'), ...args], {
    cwd: path.dirname(root),
    env: action === 'status' ? { ...env, STATUS_JSON: '1' } : env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const [stream, output] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    let remainder = '';
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      const lines = (remainder + chunk).split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) addLog(line, stream);
    });
    output.on('end', () => {
      if (remainder) addLog(remainder, stream);
    });
  }

  child.on('error', (error) => addLog(`Could not start mailer: ${error.message}`, 'stderr'));
  child.on('close', (code, signal) => {
    const wasStopped = job?.status === 'stopping';
    if (job) {
      job.status = wasStopped ? 'stopped' : code === 0 ? 'completed' : 'failed';
      job.finishedAt = new Date().toISOString();
      job.exitCode = code;
    }
    if (signal) addLog(`Mailer process ended (${signal}).`, 'system');
    else addLog(`Mailer ${job?.status || 'finished'}${code === null ? '' : ` (exit ${code})`}.`, 'system');
    child = null;
    sendEvent('job', job);
  });
}

async function getStatus() {
  return new Promise((resolve, reject) => {
    const statusProcess = spawn(process.execPath, [path.join(root, 'index.js'), 'status'], {
      cwd: path.dirname(root),
      env: { ...process.env, STATUS_JSON: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    statusProcess.stdout.setEncoding('utf8');
    statusProcess.stderr.setEncoding('utf8');
    statusProcess.stdout.on('data', (chunk) => { output += chunk; });
    statusProcess.stderr.on('data', (chunk) => { errorOutput += chunk; });
    statusProcess.on('error', reject);
    statusProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || `Status command exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('Could not read the mailer status response.'));
      }
    });
  });
}

const server = http.createServer(async (request, response) => {
  if (!validLocalRequest(request)) {
    sendJson(response, 403, { error: 'This dashboard only accepts requests from its local address.' });
    return;
  }

  const url = new URL(request.url || '/', `http://${host}:${port}`);
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(path.join(root, 'dashboard.html')).pipe(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(path.join(root, 'dashboard.js')).pipe(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/settings') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(path.join(root, 'settings.html')).pipe(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/settings.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(path.join(root, 'settings.js')).pipe(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/professors-template.csv') {
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="professors-template.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end('Name,University,Email,Profile Link,Research Interests,Applied\nProfessor Name,Example University,professor@example.edu,https://example.edu/profile,machine learning,FALSE\n');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/settings') {
    const settings = readSettings();
    const responseSettings = {};
    for (const [key, value] of Object.entries(settings)) {
      responseSettings[key] = secretKeys.has(key) ? { configured: Boolean(value) } : value;
    }
    sendJson(response, 200, responseSettings);
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!requireLocalOrigin(request)) {
      sendJson(response, 403, { error: 'A same-origin local request is required.' });
      return;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/settings') {
    if (child) {
      sendJson(response, 409, { error: 'Stop the running task before changing settings.' });
      return;
    }
    try {
      const body = await readBody(request, 100_000);
      const current = readSettings();
      const values = {};
      for (const key of settingKeys) {
        if (secretKeys.has(key)) {
          const clear = body[`clear_${key}`] === true;
          const provided = typeof body[key] === 'string' ? body[key].trim() : '';
          values[key] = clear ? '' : provided || current[key];
        } else {
          values[key] = typeof body[key] === 'string' ? body[key].trim() : current[key];
        }
      }
      const errors = validateSettings(values);
      if (errors.length) {
        sendJson(response, 400, { errors });
        return;
      }
      persistSettings(values);
      sendJson(response, 200, {
        saved: true,
        message: Number(values.PORT) === port
          ? 'Settings saved to your local .env file.'
          : 'Settings saved to your local .env file. Restart the dashboard for the new port to take effect.',
        secrets: Object.fromEntries([...secretKeys].map((key) => [key, Boolean(values[key])])),
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof SyntaxError ? 'Invalid JSON request.' : error.message });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/upload/csv') {
    if (child) {
      sendJson(response, 409, { error: 'Stop the running task before uploading a CSV.' });
      return;
    }
    try {
      const body = await readBody(request, 6_000_000);
      if (typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > 4_000_000) {
        sendJson(response, 400, { error: 'Choose a CSV smaller than 4 MB.' });
        return;
      }
      const report = inspectCsv(body.content);
      if (!report.valid) {
        sendJson(response, 400, { report });
        return;
      }
      fs.writeFileSync(path.join(projectRoot, 'professors.csv'), body.content, 'utf8');
      sendJson(response, 200, {
        path: './professors.csv',
        report,
        message: 'CSV checked and saved locally. Save settings to select it as your source.',
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof SyntaxError ? 'Invalid upload request.' : `CSV could not be parsed: ${error.message}` });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/upload/cv') {
    if (child) {
      sendJson(response, 409, { error: 'Stop the running task before uploading a CV.' });
      return;
    }
    try {
      const body = await readBody(request, 22_000_000);
      if (typeof body.content !== 'string' || body.content.length > 20_000_000) {
        sendJson(response, 400, { error: 'Choose a PDF smaller than 15 MB.' });
        return;
      }
      const content = Buffer.from(body.content, 'base64');
      if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        sendJson(response, 400, { error: 'The selected CV is not a valid PDF file.' });
        return;
      }
      if (content.length > 15_000_000) {
        sendJson(response, 400, { error: 'Choose a PDF smaller than 15 MB.' });
        return;
      }
      fs.writeFileSync(path.join(projectRoot, 'uploaded-cv.pdf'), content, { mode: 0o600 });
      sendJson(response, 200, {
        path: './uploaded-cv.pdf',
        message: 'CV saved locally. Save settings to use it for live email attachments.',
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof SyntaxError ? 'Invalid upload request.' : error.message });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/validate-csv') {
    try {
      const body = await readBody(request, 6_000_000);
      if (typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > 4_000_000) {
        sendJson(response, 400, { error: 'Choose a CSV smaller than 4 MB.' });
        return;
      }
      const report = inspectCsv(body.content);
      sendJson(response, report.valid ? 200 : 400, { report });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof SyntaxError ? 'Invalid validation request.' : `CSV could not be parsed: ${error.message}` });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/validate-sheet') {
    try {
      const body = await readBody(request, 10_000);
      if (typeof body.url !== 'string' || !body.url.trim()) {
        sendJson(response, 400, { error: 'Enter a Google Sheets link first.' });
        return;
      }
      const exportUrl = googleSheetCsvUrl(body.url.trim());
      const result = await fetch(exportUrl, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (!result.ok) {
        sendJson(response, 400, { error: `Google Sheets returned ${result.status}. Make sure the sheet is shared as “Anyone with the link can view”.` });
        return;
      }
      const text = await result.text();
      if ((result.headers.get('content-type') || '').includes('text/html') || text.trimStart().startsWith('<')) {
        sendJson(response, 400, { error: 'Google returned a web page instead of CSV. Set the sheet to “Anyone with the link can view”, then check it again.' });
        return;
      }
      const report = inspectCsv(text);
      sendJson(response, report.valid ? 200 : 400, { report });
    } catch (error) {
      sendJson(response, 400, {
        error: error.name === 'TimeoutError'
          ? 'Google Sheets took too long to respond. Try again.'
          : `Could not validate the sheet: ${error.message}`,
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/config') {
    sendJson(response, 200, {
      dryRun: process.env.DRY_RUN !== 'false',
      dailyLimit: Number(process.env.DAILY_LIMIT) || 20,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    try {
      sendJson(response, 200, await getStatus());
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify({ job, logs: logHistory })}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/run') {
    if (child) {
      sendJson(response, 409, { error: 'A task is already running.' });
      return;
    }
    try {
      const body = await readBody(request);
      const { action, limit } = body;
      if (!['preview', 'send'].includes(action)) {
        sendJson(response, 400, { error: 'Choose preview or send.' });
        return;
      }
      const min = action === 'preview' ? 1 : 1;
      const max = action === 'preview' ? 100 : 100;
      if (!Number.isInteger(limit) || limit < min || limit > max) {
        sendJson(response, 400, { error: `Limit must be a whole number from ${min} to ${max}.` });
        return;
      }
      startJob(action, limit);
      sendJson(response, 202, { job });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof SyntaxError ? 'Invalid JSON request.' : error.message });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/stop') {
    if (!child || !job || job.status !== 'running') {
      sendJson(response, 409, { error: 'There is no running task to stop.' });
      return;
    }
    job.status = 'stopping';
    sendEvent('job', job);
    addLog('Stop requested. The current task is being interrupted; completed progress is saved.', 'system');
    child.kill();
    sendJson(response, 202, { job });
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

server.listen(port, host, () => {
  console.log(`CSC Mailer dashboard: http://${host}:${port}`);
  console.log('This server is bound to loopback and is only accessible on this computer.');
});

server.on('error', (error) => {
  console.error(`Could not start dashboard: ${error.message}`);
  process.exitCode = 1;
});
