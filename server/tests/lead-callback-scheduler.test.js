/**
 * services/lead-callback-scheduler.js: the owner-approved reminder wording
 * and the gate. The claims, the ring timing and the 8 AM bell run against
 * PostgreSQL in lead-callback-scheduler-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const db = require('../models/db');
const { runLeadCallbackTick, _test } = require('../services/lead-callback-scheduler');

test('the lead reminder is the owner-approved text, in the first name', () => {
  expect(_test.reminderBody({ first_name: 'Pat' })).toBe("Hi Pat, Adam from Waves here. I'll call you in about 15 minutes.");
  expect(_test.reminderBody({ first_name: '  ' })).toBe("Hi there, Adam from Waves here. I'll call you in about 15 minutes.");
});

test('gate off: the tick reads nothing', async () => {
  await expect(runLeadCallbackTick({ now: new Date() })).resolves.toEqual({ skipped: 'gate_off' });
  expect(db).not.toHaveBeenCalled();
});

test('the scheduler registers the tick every minute under runExclusive', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  expect(src).toMatch(/cron\.schedule\('\* \* \* \* \*'[\s\S]{0,200}runExclusive\('lead-callback-scheduler'[\s\S]{0,120}runLeadCallbackTick\(\)/);
});
