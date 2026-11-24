/**
 * Stale-rule check in its own Tuesday 9:40 ET cron (server/services/scheduler.js, '40 9 * * 2'):
 * the check runs under runExclusive, so a deploy overlap never raises it twice,
 * and a failed run is logged, never thrown out of the tick.
 *
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

jest.mock('../services/stale-rule-check', () => ({ runStaleRuleCheck: jest.fn(async () => ({ flagged: 2, outcome: 'raised' })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runStaleRuleCheck } = require('../services/stale-rule-check');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function checkTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '40 9 * * 2' && String(task).includes('runStaleRuleCheck'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('the check runs once inside runExclusive and its outcome is logged', async () => {
  await checkTick();
  expect(runExclusive).toHaveBeenCalledWith('stale-rule-check', expect.any(Function));
  expect(runStaleRuleCheck).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Stale-rule check: 2 group(s) flagged (raised)');
});

test('a failed run is logged, never thrown out of the tick', async () => {
  runStaleRuleCheck.mockRejectedValueOnce(new Error('connection reset'));
  await expect(checkTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Stale-rule check failed: connection reset');
});
