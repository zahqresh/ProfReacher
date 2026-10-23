import { simpleParser } from 'mailparser';

const bounceSubject = /\b(?:undelivered|delivery status notification|delivery failure|failure notice|returned mail|delivery incomplete|delivery has failed|could not be delivered)\b/i;
const bounceSender = /(?:mailer-daemon|postmaster|mail delivery subsystem)/i;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export async function parseBounce(message, sentByEmail) {
  if (!message.source) return null;
  const parsed = await simpleParser(message.source);
  const sender = (parsed.from?.value || []).map((item) => item.address || '').join(' ');
  const subject = parsed.subject || message.envelope?.subject || '';
  if (!bounceSubject.test(subject)) return null;

  const bodyParts = [parsed.text || ''];
  for (const attachment of parsed.attachments || []) {
    if (attachment.content.length < 1_000_000) {
      bodyParts.push(attachment.content.toString('utf8'));
    }
  }
  const body = bodyParts.join('\n');
  const hasDeliveryStatus = /(?:Final-Recipient|Original-Recipient|Action:\s*failed|multipart\/report)/i.test(
    Buffer.isBuffer(message.source) ? message.source.toString('utf8') : String(message.source),
  );
  if (!bounceSender.test(sender) && !hasDeliveryStatus) return null;

  const addresses = new Set(body.match(emailPattern)?.map((email) => email.toLowerCase()) || []);
  const candidates = [...sentByEmail.keys()].filter((email) => addresses.has(email));
  if (candidates.length !== 1) return null;

  const email = candidates[0];
  const reason = body.match(/diagnostic-code\s*:\s*([^\r\n]+)/i)?.[1]?.trim().slice(0, 300)
    || body.match(/(?:status|reason)[\s:=]+([^\r\n]+)/i)?.[1]?.trim().slice(0, 300)
    || subject;
  return {
    email,
    at: new Date(message.internalDate || parsed.date || Date.now()).toISOString(),
    subject,
    reason,
    messageId: parsed.messageId || message.envelope?.messageId || '',
  };
}
