import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import nodemailer from 'nodemailer';
import { searchOpenAlexProfessor } from './openalex.js';
import { createOpenRouterClient } from './openrouter.js';
import { getDueFollowUps, isContactSuppressed, normalizeEmailMap, syncReplies } from './reply-tracking.js';

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const cfg = {
  sheetUrl: env.SHEET_CSV_URL || '',
  csvPath: env.CSV_PATH || './professors.csv',
  cvPath: env.CV_PATH || '',
  promptsDir: env.PROMPTS_DIR || './prompts',
  smtpHost: env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: num(env.SMTP_PORT, 465),
  user: env.SMTP_USER || '',
  pass: env.SMTP_PASS || '',
  imapHost: env.IMAP_HOST || 'imap.gmail.com',
  imapPort: num(env.IMAP_PORT, 993),
  imapUser: env.IMAP_USER || env.SMTP_USER || '',
  imapPass: env.IMAP_PASS || env.SMTP_PASS || '',
  followUpDays: num(env.FOLLOW_UP_DAYS, 7),
  fromName: env.FROM_NAME || 'Muhammad Hamza',
  subject: env.SUBJECT || 'CSC 2027 PhD Application Enquiry - Muhammad Hamza',
  apiKey: env.OPENROUTER_API_KEY || '',
  baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  model: env.OPENROUTER_MODEL || 'openrouter/free',
  langKey: env.LANGSEARCH_API_KEY || '',
  openAlexKey: env.OPENALEX_API_KEY || '',
  searchCount: num(env.SEARCH_COUNT, 5),
  useWeb: env.USE_WEB_SEARCH !== 'false',
  useOpenAlex: env.OPENALEX_ENABLED === 'true' && Boolean(env.OPENALEX_API_KEY),
  dailyLimit: num(env.DAILY_LIMIT, 20),
  minDelay: num(env.MIN_DELAY_MIN, 1),
  maxDelay: num(env.MAX_DELAY_MIN, 3),
  minRating: num(env.MIN_RATING, 0),
  sendLow: env.SEND_LOW_CONFIDENCE === 'true',
  dryRun: env.DRY_RUN !== 'false',
};

const STATE_FILE = 'state.json';
const HOOKS_FILE = 'hooks.json';
const LOG_FILE = 'sent_log.csv';

const log = (...a) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

// ---------------------------------------------------------------- prompts (external files)
// Prompts are re-read on every use, so you can edit prompts/*.txt while the app is running.
function loadPrompt(name) {
  const f = path.join(cfg.promptsDir, name);
  if (!fs.existsSync(f)) throw new Error(`Prompt file missing: ${f}`);
  return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim();
}
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));

// ---------------------------------------------------------------- input
async function loadCsvText() {
  if (cfg.sheetUrl) {
    let url = cfg.sheetUrl;
    const m = url.match(/spreadsheets\/d\/([^/]+)/);
    if (m && !url.includes('export?format=csv')) {
      const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
      url = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
    }
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Could not fetch sheet (${res.status}). Share it as "Anyone with the link can view".`);
    return await res.text();
  }
  if (!fs.existsSync(cfg.csvPath)) throw new Error(`CSV not found: ${cfg.csvPath}`);
  return fs.readFileSync(cfg.csvPath, 'utf8');
}

function loadRows(text) {
  const recs = parse(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  const seen = new Set();
  const out = [];
  for (const x of recs) {
    const m = (x.Email || '').match(/[^\s;,<>]+@[^\s;,<>]+\.[^\s;,<>]+/);
    const name = (x.Name || '').trim();
    if (!m || !name) continue;
    if (String(x.Applied).toUpperCase() === 'TRUE') continue;
    const email = m[0].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      name,
      university: x.University || '',
      email,
      link: x['Profile Link'] || '',
      interests: x['Research Interests'] || '',
    });
  }
  return out;
}

// ---------------------------------------------------------------- web search (LangSearch)
async function webSearch(r) {
  if (!cfg.langKey) throw new Error('LANGSEARCH_API_KEY missing');
  const query = fill(loadPrompt('search_query.txt'), r);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.langsearch.com/v1/web-search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.langKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, freshness: 'noLimit', summary: true, count: cfg.searchCount }),
    });
    if (res.status === 429 || res.status >= 500) {
      log(`LangSearch ${res.status}, retrying...`);
      await sleep(5000 * (attempt + 1));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LangSearch ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    const items = j.data?.webPages?.value || [];
    return items
      .slice(0, 4)
      .map((x, i) => `[${i + 1}] ${x.name}\nURL: ${x.url}\n${(x.summary || x.snippet || '').slice(0, 700)}`)
      .join('\n\n');
  }
  throw new Error('LangSearch retries exhausted');
}

// ---------------------------------------------------------------- hook generation
const callLLM = createOpenRouterClient({
  apiKey: cfg.apiKey,
  baseUrl: cfg.baseUrl,
  model: cfg.model,
  log,
});

function parseHook(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in LLM output');
  const o = JSON.parse(m[0]);
  const bad = (s) => typeof s !== 'string' || s.length < 40 || /\[[A-Z][^\]]*\]/.test(s.replace(/\*\*/g, ''));
  if (bad(o.hook) || bad(o.short)) throw new Error('hook missing or contains placeholders');
  return {
    hook: o.hook.trim(),
    short: o.short.trim(),
    rating: Number(o.rating) || 0,
    reasons: String(o.reasons || ''),
    recommend_short: !!o.recommend_short,
    confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'low',
    evidence: String(o.evidence || 'none'),
  };
}

async function generateHook(r) {
  if (!cfg.apiKey) throw new Error('OPENROUTER_API_KEY missing');

  const contexts = [];
  if (cfg.useWeb) {
    try {
      const context = await webSearch(r);
      if (context) contexts.push(`LANGSEARCH WEB RESULTS\n${context}`);
    } catch (e) {
      log(`  LangSearch failed (${e.message.slice(0, 120)}); continuing with other research sources`);
    }
  }
  if (cfg.useOpenAlex) {
    try {
      const context = await searchOpenAlexProfessor(r, { apiKey: cfg.openAlexKey });
      if (context) contexts.push(context);
    } catch (e) {
      log(`  OpenAlex failed (${e.message.slice(0, 120)}); continuing with other research sources`);
    }
  }

  const web = contexts.join('\n\n') || loadPrompt('no_web.txt');
  const make = () => [
    { role: 'system', content: loadPrompt('system.txt') },
    { role: 'user', content: fill(loadPrompt('user.txt'), { ...r, interests: r.interests || 'n/a', link: r.link || 'n/a', web }) },
  ];

  let response = await callLLM(make());
  try {
    return parseHook(response);
  } catch {
    response = await callLLM(make());
    return parseHook(response);
  }
}

// ---------------------------------------------------------------- email
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const linkify = (s) =>
  s.replace(/(https?:\/\/[^\s<]+|github\.com\/[^\s<]+)/g, (u) => `<a href="${u.startsWith('http') ? u : 'https://' + u}">${u}</a>`);
const bold = (s) => linkify(esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'));
const plain = (s) => s.replace(/\*\*/g, '');

function buildEmail(r, h) {
  const hook = h.recommend_short ? h.short : h.hook;
  const paras = fill(loadPrompt('email_body.txt'), { name: r.name, university: r.university, hook })
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const signoff = loadPrompt('email_signature.txt').split('\n').map((l) => l.trim()).filter(Boolean);

  const text = paras.map(plain).join('\n\n') + '\n\n' + signoff.join('\n');
  const html =
    paras.map((p) => `<p>${bold(p)}</p>`).join('\n') +
    `<p>${signoff.map((l) => bold(l)).join('<br>')}</p>`;
  return { text, html };
}

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }
  return transporter;
}

async function sendMail(r, h) {
  const { text, html } = buildEmail(r, h);
  if (cfg.dryRun) {
    fs.mkdirSync('outbox', { recursive: true });
    fs.writeFileSync(path.join('outbox', `${r.email.replace(/[^a-z0-9@.]/gi, '_')}.txt`), `To: ${r.email}\nSubject: ${cfg.subject}\n\n${text}\n`);
    return null;
  }
  return getTransporter().sendMail({
    from: `"${cfg.fromName}" <${cfg.user}>`,
    to: r.email,
    subject: cfg.subject,
    text,
    html,
    attachments: [{ filename: path.basename(cfg.cvPath), path: cfg.cvPath }],
  });
}

// ---------------------------------------------------------------- scheduling
// A "sending day" starts at 5:00 AM PKT (UTC+5, no DST) = 00:00 UTC.
const dayKey = () => new Date().toISOString().slice(0, 10);
function msUntilNextStart() {
  const n = new Date();
  const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1);
  return next - n.getTime() + Math.floor(Math.random() * 10 * 60 * 1000); // +0-10 min jitter
}
const randomDelayMs = () => (cfg.minDelay + Math.random() * Math.max(0, cfg.maxDelay - cfg.minDelay)) * 60 * 1000;

function gate(h) {
  if (h.approved === false) return 'manually rejected';
  if (h.approved === true) return null;
  if (h.confidence === 'low' && !cfg.sendLow) return 'low confidence (set "approved": true in hooks.json to send)';
  if (h.rating < cfg.minRating) return `rating ${h.rating} < MIN_RATING`;
  return null;
}

// ---------------------------------------------------------------- commands
async function getPending() {
  const rows = loadRows(await loadCsvText());
  const state = readJson(STATE_FILE, { sent: {}, failed: {}, days: {} });
  state.sent = normalizeEmailMap(state.sent);
  state.failed = normalizeEmailMap(state.failed);
  state.replies = normalizeEmailMap(state.replies);
  state.followUps = normalizeEmailMap(state.followUps);
  state.contacts = normalizeEmailMap(state.contacts);
  state.bounces = normalizeEmailMap(state.bounces);
  state.days ||= {};
  const suppressed = rows.filter((r) => isContactSuppressed(state.contacts[r.email]?.status) || state.bounces[r.email]).length;
  return {
    rows,
    state,
    suppressed,
    pending: rows.filter((r) => !state.sent[r.email]
      && !isContactSuppressed(state.contacts[r.email]?.status)
      && !state.bounces[r.email]),
  };
}

async function preview(n) {
  const { pending } = await getPending();
  const hooks = readJson(HOOKS_FILE, {});
  const todo = pending.filter((r) => !hooks[r.email]).slice(0, n);
  log(`${pending.length} pending, generating hooks for ${todo.length}`);
  for (const r of todo) {
    try {
      hooks[r.email] = await generateHook(r);
      writeJson(HOOKS_FILE, hooks);
      const h = hooks[r.email];
      log(`${r.name} (${r.university}) rating ${h.rating}/10, ${h.confidence}${h.recommend_short ? ', short' : ''}`);
    } catch (e) {
      log(`${r.name}: hook failed - ${e.message}`);
    }
    await sleep(2500);
  }
  log(`Review/edit ${HOOKS_FILE}, then run: npm start`);
}

async function send() {
  if (!cfg.dryRun) {
    if (!cfg.user || !cfg.pass) throw new Error('SMTP_USER / SMTP_PASS missing');
    if (!cfg.cvPath || !fs.existsSync(cfg.cvPath)) throw new Error(`CV not found at CV_PATH: ${cfg.cvPath}`);
  }
  const { pending, state } = await getPending();
  const hooks = readJson(HOOKS_FILE, {});
  log(`${pending.length} professors pending. DRY_RUN=${cfg.dryRun}, limit ${cfg.dailyLimit}/day`);
  let dryCount = 0;
  const skipped = [];

  for (const r of pending) {
    // daily quota
    if (!cfg.dryRun && (state.days[dayKey()] || 0) >= cfg.dailyLimit && env.SCHEDULED_RUN === 'true') {
      log('Scheduled daily limit reached; stopping this run.');
      break;
    }
    while (!cfg.dryRun && (state.days[dayKey()] || 0) >= cfg.dailyLimit) {
      const ms = msUntilNextStart();
      log(`Daily limit reached. Sleeping ${(ms / 3600000).toFixed(1)}h until 5:00 AM PKT.`);
      await sleep(ms);
    }
    if (cfg.dryRun && dryCount >= cfg.dailyLimit) {
      log('DRY_RUN limit reached; stopping.');
      break;
    }

    if (!hooks[r.email]) {
      try {
        hooks[r.email] = await generateHook(r);
        writeJson(HOOKS_FILE, hooks);
      } catch (e) {
        log(`${r.name}: hook failed (${e.message}); skipping`);
        skipped.push(`${r.name}: hook failed`);
        continue;
      }
    }
    const h = hooks[r.email];
    const why = gate(h);
    if (why) {
      skipped.push(`${r.name}: ${why}`);
      continue;
    }

    try {
      const messageInfo = await sendMail(r, h);
    } catch (e) {
      if (e.responseCode === 535 || e.code === 'EAUTH') throw new Error(`SMTP login failed: ${e.message}`);
      log(`${r.name} <${r.email}>: send failed - ${e.message}`);
      state.failed[r.email] = e.message;
      writeJson(STATE_FILE, state);
      continue;
    }

    dryCount++;
    if (!cfg.dryRun) {
      state.sent[r.email] = {
        at: new Date().toISOString(),
        name: r.name,
        subject: cfg.subject,
        messageId: messageInfo?.messageId,
      };
      state.days[dayKey()] = (state.days[dayKey()] || 0) + 1;
      delete state.failed[r.email];
      writeJson(STATE_FILE, state);
      fs.appendFileSync(LOG_FILE, `"${r.name}","${r.university}",${r.email},${new Date().toISOString()},${h.rating}\n`);
    }
    log(`${cfg.dryRun ? '[dry] ' : ''}sent -> ${r.name} <${r.email}> (${state.days[dayKey()] || dryCount}/${cfg.dailyLimit} today)`);

    const ms = randomDelayMs();
    log(`  next in ${(ms / 60000).toFixed(1)} min`);
    await sleep(cfg.dryRun ? 500 : ms);
  }

  if (skipped.length) log(`Held back ${skipped.length}:\n  ` + skipped.join('\n  '));
  log('Done.');
}

async function followUpStatus() {
  const { rows, state } = await getPending();
  state.replies ||= {};
  state.followUps ||= {};
  state.bounces ||= {};
  state.contacts ||= {};
  const due = getDueFollowUps(rows, state, cfg.followUpDays);
  const rowsByEmail = new Map(rows.map((row) => [row.email.toLowerCase(), row]));
  const detectedReplies = Object.entries(state.replies)
    .filter(([email]) => state.sent[email])
    .map(([email, reply]) => ({
      name: rowsByEmail.get(email.toLowerCase())?.name || state.sent[email].name || email,
      email,
      university: rowsByEmail.get(email.toLowerCase())?.university || '',
      sentAt: state.sent[email].at,
      repliedAt: reply.at,
      subject: reply.subject,
      outcome: state.contacts[email]?.status || 'active',
    }));
  const recordedOutcomes = Object.entries(state.contacts)
    .filter(([, contact]) => contact.status && contact.status !== 'active')
    .map(([email, contact]) => ({
      name: rowsByEmail.get(email.toLowerCase())?.name || state.sent[email]?.name || email,
      email,
      university: rowsByEmail.get(email.toLowerCase())?.university || '',
      outcome: contact.status,
      updatedAt: contact.updatedAt,
    }));
  const result = {
    sent: Object.keys(state.sent).length,
    replied: Object.keys(state.replies).filter((email) => state.sent[email]).length,
    due: due.length,
    followUpsSent: Object.values(state.followUps).filter((entry) => entry.sentAt).length,
    outcomes: Object.values(state.contacts).filter((contact) => contact.status && contact.status !== 'active').length,
    bounces: Object.entries(state.bounces).map(([email, bounce]) => ({
      email,
      name: rowsByEmail.get(email.toLowerCase())?.name || state.sent[email]?.name || email,
      university: rowsByEmail.get(email.toLowerCase())?.university || '',
      sentAt: state.sent[email]?.at,
      bouncedAt: bounce.at,
      subject: bounce.subject,
      reason: bounce.reason,
      messageId: bounce.messageId,
    })),
    recordedOutcomes,
    followUpDays: cfg.followUpDays,
    dryRun: cfg.dryRun,
    inboxChecked: Boolean(state.mailboxLastCheckedAt),
    dailyLimit: cfg.dailyLimit,
    sentToday: state.days[dayKey()] || 0,
    remainingToday: Math.max(0, cfg.dailyLimit - (state.days[dayKey()] || 0)),
    lastInboxCheck: state.mailboxLastCheckedAt || null,
    candidates: due,
    detectedReplies,
  };
  console.log(JSON.stringify(result));
}

async function checkInbox(state) {
  state.replies ||= {};
  state.followUps ||= {};
  for (const record of Object.values(state.sent)) {
    record.subject ||= cfg.subject;
  }
  return syncReplies(state, {
    host: cfg.imapHost,
    port: cfg.imapPort,
    user: cfg.imapUser,
    pass: cfg.imapPass,
  });
}

async function syncFollowUps() {
  const { state } = await getPending();
  const detected = await checkInbox(state);
  writeJson(STATE_FILE, state);
  log(`Inbox check complete: ${detected.repliesDetected} new ${detected.repliesDetected === 1 ? 'reply' : 'replies'}, ${detected.bouncesDetected} new ${detected.bouncesDetected === 1 ? 'bounce' : 'bounces'}.`);
}

async function sendFollowUps() {
  if (!cfg.dryRun && (!cfg.user || !cfg.pass)) throw new Error('SMTP_USER / SMTP_PASS missing');
  const { rows, state } = await getPending();
  state.followUps ||= {};
  log('Checking the inbox before preparing follow-ups.');
  const detected = await checkInbox(state);
  writeJson(STATE_FILE, state);
  log(`Inbox check complete: ${detected.repliesDetected} new ${detected.repliesDetected === 1 ? 'reply' : 'replies'}, ${detected.bouncesDetected} new ${detected.bouncesDetected === 1 ? 'bounce' : 'bounces'}.`);
  const due = getDueFollowUps(rows, state, cfg.followUpDays);
  const alreadySentToday = state.days[dayKey()] || 0;
  const available = Math.max(0, cfg.dailyLimit - alreadySentToday);
  const batch = due.slice(0, available);
  log(`${due.length} follow-up${due.length === 1 ? '' : 's'} eligible; sending or drafting up to ${batch.length} (limit ${cfg.dailyLimit}/day).`);

  let completed = 0;
  for (const r of batch) {
    const sent = state.sent[r.email];
    const subject = `Re: ${sent.subject || cfg.subject}`;
    const text = fill(loadPrompt('follow_up.txt'), {
      name: r.name,
      university: r.university || 'your university',
      sentDate: new Date(sent.at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      fromName: cfg.fromName,
    });

    try {
      if (cfg.dryRun) {
        fs.mkdirSync('outbox', { recursive: true });
        const file = `follow-up-${r.email.replace(/[^a-z0-9@.]/gi, '_')}.txt`;
        fs.writeFileSync(path.join('outbox', file), `To: ${r.email}\nSubject: ${subject}\n\n${text}\n`);
        state.followUps[r.email] = { ...state.followUps[r.email], draftAt: new Date().toISOString(), subject };
        log(`${r.name}: follow-up draft saved to outbox/${file}`);
      } else {
        const originalMessageId = state.followUps[r.email]?.messageId || sent.messageId;
        const info = await getTransporter().sendMail({
          from: `"${cfg.fromName}" <${cfg.user}>`,
          to: r.email,
          subject,
          text,
          ...(originalMessageId ? {
            inReplyTo: originalMessageId,
            references: [originalMessageId],
          } : {}),
        });
        state.followUps[r.email] = {
          sentAt: new Date().toISOString(),
          subject,
          messageId: info.messageId,
        };
        state.days[dayKey()] = (state.days[dayKey()] || 0) + 1;
        fs.appendFileSync(LOG_FILE, `"${r.name}","${r.university}",${r.email},${new Date().toISOString()},follow-up\n`);
        log(`${r.name}: follow-up sent to ${r.email}`);
      }
      writeJson(STATE_FILE, state);
      completed += 1;
    } catch (e) {
      if (e.responseCode === 535 || e.code === 'EAUTH') throw new Error(`SMTP login failed: ${e.message}`);
      log(`${r.name}: follow-up failed - ${e.message}`);
    }

    if (completed < batch.length) await sleep(cfg.dryRun ? 500 : randomDelayMs());
  }
  if (due.length > batch.length) log(`Daily limit leaves ${due.length - batch.length} eligible follow-up(s) for a later run.`);
  log('Follow-up run complete.');
}

async function status() {
  const { rows, state, pending, suppressed } = await getPending();
  const hooks = readJson(HOOKS_FILE, {});
  const result = {
    eligibleRows: rows.length,
    sent: Object.keys(state.sent).length,
    pending: pending.length,
    suppressed,
    hooksReady: pending.filter((r) => hooks[r.email]).length,
    sentToday: state.days[dayKey()] || 0,
    failed: Object.keys(state.failed).length,
  };
  console.log(process.env.STATUS_JSON === '1' ? JSON.stringify(result) : result);
}

const [cmd = 'send', arg] = process.argv.slice(2);
const run = {
  preview: () => preview(num(arg, 20)),
  send,
  status,
  'followups-status': followUpStatus,
  'followups-sync': syncFollowUps,
  'followups-send': sendFollowUps,
}[cmd];
if (!run) {
  console.log('Usage: node src/index.js [preview [n] | send | status | followups-status | followups-sync | followups-send]');
  process.exit(1);
}
run().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});