import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBounce } from '../src/bounce-tracking.js';

const sentByEmail = new Map([['professor@example.edu', 'professor@example.edu']]);

test('detects a delivery failure for a tracked recipient', async () => {
  const source = [
    'From: Mail Delivery Subsystem <mailer-daemon@example.com>',
    'To: sender@example.com',
    'Subject: Delivery Status Notification (Failure)',
    'Date: Fri, 23 Oct 2026 09:00:00 +0000',
    'Message-ID: <bounce-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="report"',
    '',
    '--report',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Delivery to professor@example.edu failed. The address could not be delivered.',
    '--report',
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; professor@example.edu',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; mailbox does not exist',
    '--report--',
  ].join('\r\n');

  const bounce = await parseBounce({ source: Buffer.from(source) }, sentByEmail);
  assert.equal(bounce.email, 'professor@example.edu');
  assert.equal(bounce.subject, 'Delivery Status Notification (Failure)');
  assert.equal(bounce.reason, 'smtp; mailbox does not exist');
  assert.equal(bounce.messageId, '<bounce-1@example.com>');
});

test('ignores ordinary replies and undelivered notices for unknown addresses', async () => {
  const reply = Buffer.from([
    'From: Professor <professor@example.edu>',
    'To: sender@example.com',
    'Subject: Re: PhD discussion',
    '',
    'Thank you for your message.',
  ].join('\r\n'));
  const unrelatedBounce = Buffer.from([
    'From: Mail Delivery Subsystem <mailer-daemon@example.com>',
    'To: sender@example.com',
    'Subject: Undelivered Mail Returned to Sender',
    '',
    'The message to other@example.edu could not be delivered.',
  ].join('\r\n'));

  assert.equal(await parseBounce({ source: reply }, sentByEmail), null);
  assert.equal(await parseBounce({ source: unrelatedBounce }, sentByEmail), null);
});
