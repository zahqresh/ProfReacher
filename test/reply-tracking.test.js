import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDueFollowUps,
  isContactSuppressed,
  isReplyToTrackedMessage,
  normalizeEmailMap,
} from '../src/reply-tracking.js';

const sentDate = '2026-01-01T12:00:00.000Z';
const now = new Date('2026-01-10T12:00:00.000Z');
const professor = {
  name: 'Example Professor',
  university: 'Example University',
  email: 'professor@example.edu',
};

test('selects only sent records older than the configured age without a reply or prior follow-up', () => {
  const state = {
    sent: {
      [professor.email]: { at: sentDate, name: professor.name },
      'recent@example.edu': { at: '2026-01-05T12:00:00.000Z', name: 'Recent' },
      'replied@example.edu': { at: sentDate, name: 'Replied' },
      'followed@example.edu': { at: sentDate, name: 'Followed' },
    },
    replies: { 'replied@example.edu': { at: '2026-01-02T12:00:00.000Z' } },
    followUps: { 'followed@example.edu': { sentAt: '2026-01-09T12:00:00.000Z' } },
  };
  const rows = [
    professor,
    { ...professor, email: 'recent@example.edu' },
    { ...professor, email: 'replied@example.edu' },
    { ...professor, email: 'followed@example.edu' },
  ];

  assert.deepEqual(getDueFollowUps(rows, state, 7, now), [{
    ...professor,
    sentAt: sentDate,
    daysSinceSent: 9,
    outcome: 'active',
  }]);
});

test('does not offer a follow-up to contacts with a recorded outcome', () => {
  const state = {
    sent: {
      [professor.email]: { at: sentDate },
    },
    contacts: {
      [professor.email]: { status: 'do_not_contact' },
    },
  };
  assert.deepEqual(getDueFollowUps([professor], state, 7, now), []);
});

test('does not offer a follow-up to a bounced recipient', () => {
  const state = {
    sent: {
      [professor.email]: { at: sentDate },
    },
    bounces: {
      [professor.email]: { at: '2026-01-02T12:00:00.000Z' },
    },
  };
  assert.deepEqual(getDueFollowUps([professor], state, 7, now), []);
});

test('makes a record due at the exact full-day threshold', () => {
  const sentAt = '2026-01-03T12:00:00.000Z';
  assert.equal(getDueFollowUps(
    [professor],
    { sent: { [professor.email]: { at: sentAt } } },
    7,
    now,
  ).length, 1);
});

test('normalizes historical email keys before matching professor records', () => {
  const sent = normalizeEmailMap({
    'Professor@Example.edu': { at: sentDate, name: 'Professor' },
  });
  assert.equal(sent['professor@example.edu'].name, 'Professor');
  assert.equal(getDueFollowUps(
    [professor],
    { sent: { 'Professor@Example.edu': { at: sentDate } } },
    7,
    now,
  )[0].email, professor.email);
});

test('suppresses future outreach for recorded outcomes except an explicitly cleared active outcome', () => {
  assert.equal(isContactSuppressed('interested'), true);
  assert.equal(isContactSuppressed('not_interested'), true);
  assert.equal(isContactSuppressed('do_not_contact'), true);
  assert.equal(isContactSuppressed('active'), false);
  assert.equal(isContactSuppressed(undefined), false);
});

test('matches replies by message ID even if the subject changed', () => {
  const message = {
    envelope: {
      from: [{ address: professor.email }],
      subject: 'Re: Different subject',
      inReplyTo: '<original-message@example.com>',
    },
  };

  assert.equal(isReplyToTrackedMessage(
    message,
    professor.email,
    { messageId: '<original-message@example.com>', subject: 'Original subject' },
  ), true);
});

test('matches old sent records by sender and normalized reply subject', () => {
  const message = {
    envelope: {
      from: [{ address: professor.email }],
      subject: 'Re: Fwd: Original subject',
    },
  };

  assert.equal(isReplyToTrackedMessage(
    message,
    professor.email,
    { subject: 'Original subject' },
  ), true);
  assert.equal(isReplyToTrackedMessage(
    message,
    professor.email,
    { subject: 'Another subject' },
  ), false);
});

test('does not treat a matching subject from another sender as a reply', () => {
  assert.equal(isReplyToTrackedMessage({
    envelope: {
      from: [{ address: 'someone-else@example.edu' }],
      subject: 'Re: Original subject',
    },
  }, professor.email, { subject: 'Original subject' }), false);
});
