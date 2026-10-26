/**
 * SMS prompt auto-promote wiring in server/services/scheduler.js (GATE_SMS_PROMPT_AUTOPROMOTE):
 *  - the drafter's active-patch snapshot starts BEFORE the cronJobs early return, so a process with
 *    crons disabled still drafts with the live patch and its version tag;
 *  - the daily tick (6:12) returns before taking a lock when the gate is off.
 * Mock baseline copied from scheduler-bid-kit-expiry-cron.test.js.
 */
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  recurringSeriesTopUpLive: jest.fn(() => false),
}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/recurring-series-topup', () => ({ runRecurringSeriesTopUpSweep: jest.fn() }));
jest.mock('../services/sms-prompt-patch', () => ({ startPatchRefresh: jest.fn() }));
jest.mock('../services/sms-prompt-autopromote', () => ({ runAutopromoteTick: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const patchLib = require('../services/sms-prompt-patch');
const autopromote = require('../services/sms-prompt-autopromote');
const { initScheduledJobs } = require('../services/scheduler');

const job = (expression) => {
  const matches = cron.schedule.mock.calls.filter(([expr, task]) => expr === expression && String(task).includes('SMS prompt'));
  expect(matches).toHaveLength(1);
  return matches[0][1];
};

beforeEach(() => jest.clearAllMocks());

test('the snapshot loads with crons disabled, and not at all with the gate off', () => {
  isEnabled.mockImplementation((name) => name === 'smsPromptAutopromote');
  initScheduledJobs();
  expect(patchLib.startPatchRefresh).toHaveBeenCalledTimes(1);

  jest.clearAllMocks();
  isEnabled.mockImplementation(() => false);
  initScheduledJobs();
  expect(patchLib.startPatchRefresh).not.toHaveBeenCalled();
});

test('gate off: the tick returns before taking a lock; gate on: it runs under its own lock', async () => {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  await job('12 6 * * *')();
  expect(runExclusive).not.toHaveBeenCalledWith('sms-prompt-autopromote', expect.any(Function));
  expect(autopromote.runAutopromoteTick).not.toHaveBeenCalled();

  cron.schedule.mockClear();
  isEnabled.mockImplementation((name) => name === 'cronJobs' || name === 'smsPromptAutopromote');
  initScheduledJobs();
  await job('12 6 * * *')();
  expect(autopromote.runAutopromoteTick).toHaveBeenCalledTimes(1);
  expect(runExclusive).toHaveBeenCalledWith('sms-prompt-autopromote', expect.any(Function));
});
