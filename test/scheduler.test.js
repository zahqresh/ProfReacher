import test from 'node:test';
import assert from 'node:assert/strict';
import { isScheduleDue, localScheduleDate } from '../src/scheduler.js';

test('schedule starts at or after configured local time once per date', () => {
  const now = new Date(2026, 9, 23, 9, 5);
  assert.deepEqual(localScheduleDate(now), { date: '2026-10-23', time: '09:05' });
  assert.equal(isScheduleDue({ enabled: true, live: true, time: '09:00' }, null, now), true);
  assert.equal(isScheduleDue({ enabled: true, live: true, time: '09:00' }, '2026-10-23', now), false);
  assert.equal(isScheduleDue({ enabled: true, live: true, time: '09:06' }, null, now), false);
});

test('schedule cannot start when disabled or in safe mode', () => {
  const now = new Date(2026, 9, 23, 10);
  assert.equal(isScheduleDue({ enabled: false, live: true, time: '09:00' }, null, now), false);
  assert.equal(isScheduleDue({ enabled: true, live: false, time: '09:00' }, null, now), false);
});
