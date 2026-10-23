import { ImapFlow } from 'imapflow';
import { parseBounce } from './bounce-tracking.js';

const normalizeSubject = (subject = '') =>
  subject.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim().replace(/\s+/g, ' ').toLowerCase();

function addresses(envelope) {
  return (envelope || [])
    .map((entry) => entry.address?.toLowerCase())
    .filter(Boolean);
}

function inReplyToIds(message) {
  const value = message.envelope?.inReplyTo || '';
  return new Set(value.match(/<[^>]+>/g)?.map((id) => id.toLowerCase()) || []);
}

export function isReplyToTrackedMessage(message, recipient, sent, followUp) {
  const envelope = message.envelope || {};
  if (!addresses(envelope.from).includes(recipient.toLowerCase())) return false;

  const ids = inReplyToIds(message);
  const trackedIds = [sent.messageId, followUp?.messageId]
    .filter(Boolean)
    .map((id) => id.toLowerCase());
  if (trackedIds.some((id) => ids.has(id))) return true;

  return Boolean(envelope.subject)
    && normalizeSubject(envelope.subject) === normalizeSubject(sent.subject || '');
}

export function getDueFollowUps(rows, state, followUpDays, now = new Date()) {
  const sent = normalizeEmailMap(state.sent);
  const replies = normalizeEmailMap(state.replies);
  const followUps = normalizeEmailMap(state.followUps);
  const contacts = normalizeEmailMap(state.contacts);
  const bounces = normalizeEmailMap(state.bounces);
  const rowsByEmail = new Map(rows.map((row) => [row.email.toLowerCase(), row]));
  const ageLimit = followUpDays * 24 * 60 * 60 * 1000;

  return Object.entries(sent).flatMap(([email, record]) => {
    const row = rowsByEmail.get(email.toLowerCase());
    const sentAt = Date.parse(record.at);
    if (!row || !Number.isFinite(sentAt) || now.getTime() - sentAt < ageLimit) return [];
    if (replies[email.toLowerCase()] || followUps[email.toLowerCase()]?.sentAt) return [];
    if (bounces[email.toLowerCase()]) return [];
    if (contacts[email.toLowerCase()]?.status && contacts[email.toLowerCase()].status !== 'active') return [];
    return [{
      ...row,
      sentAt: record.at,
      daysSinceSent: Math.floor((now.getTime() - sentAt) / (24 * 60 * 60 * 1000)),
      outcome: contacts[email.toLowerCase()]?.status || 'active',
    }];
  });
}

export function normalizeEmailMap(records = {}) {
  const normalized = {};
  for (const [email, value] of Object.entries(records)) {
    const key = email.toLowerCase();
    const current = normalized[key];
    const timestamp = Date.parse(value?.at || value?.sentAt || value?.updatedAt || '');
    const currentTimestamp = Date.parse(current?.at || current?.sentAt || current?.updatedAt || '');
    if (!current || (Number.isFinite(timestamp) && (!Number.isFinite(currentTimestamp) || timestamp >= currentTimestamp))) {
      normalized[key] = value;
    }
  }
  return normalized;
}

export const contactStatuses = new Set(['active', 'interested', 'not_interested', 'do_not_contact']);

export function isContactSuppressed(status) {
  return Boolean(status) && status !== 'active';
}

export async function syncReplies(state, config) {
  const user = config.user || '';
  const pass = config.pass || '';
  if (!user || !pass) throw new Error('IMAP credentials are missing. Configure IMAP or SMTP username and password in Settings.');

  const sent = normalizeEmailMap(state.sent);
  state.sent = sent;
  state.replies = normalizeEmailMap(state.replies);
  state.followUps = normalizeEmailMap(state.followUps);
  state.bounces = normalizeEmailMap(state.bounces);
  const entries = Object.entries(sent).filter(([, record]) => Number.isFinite(Date.parse(record.at)));
  if (!entries.length) {
    state.replies ||= {};
    state.bounces ||= {};
    state.mailboxLastCheckedAt = new Date().toISOString();
    return { repliesDetected: 0, bouncesDetected: 0 };
  }

  const firstSentAt = Math.min(...entries.map(([, record]) => Date.parse(record.at)));
  const imap = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port === 993,
    doSTARTTLS: config.port !== 993,
    auth: { user, pass },
    logger: false,
  });
  const sentByEmail = new Map(entries.map(([email]) => [email.toLowerCase(), email]));
  let connected = false;
  let repliesDetected = 0;
  let bouncesDetected = 0;

  try {
    await imap.connect();
    connected = true;
    const lock = await imap.getMailboxLock('INBOX');
    try {
      for await (const message of imap.fetch(
        { since: new Date(firstSentAt) },
        { envelope: true, internalDate: true, source: true },
      )) {
        const envelope = message.envelope || {};
        const bounce = await parseBounce(message, sentByEmail);
        if (bounce && !state.bounces?.[bounce.email]) {
          state.bounces ||= {};
          state.bounces[bounce.email] = bounce;
          bouncesDetected += 1;
          continue;
        }
        for (const from of addresses(envelope.from)) {
          const email = sentByEmail.get(from);
          if (!email || state.replies?.[email]) continue;
          if (!isReplyToTrackedMessage(message, email, sent[email], state.followUps?.[email])) continue;
          state.replies ||= {};
          state.replies[email] = {
            at: new Date(message.internalDate || envelope.date || Date.now()).toISOString(),
            subject: envelope.subject || '',
          };
          repliesDetected += 1;
          break;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    if (connected) await imap.logout();
  }

  state.mailboxLastCheckedAt = new Date().toISOString();
  return { repliesDetected, bouncesDetected };
}
