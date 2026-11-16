/**
 * Estimate no-time-soon check in its own cron (server/services/scheduler.js, '35 7 * * *': 7:35 AM ET) and the
 * 5-minute estimate tick's settle pass. No gate (read-only, owner rule 2026-11-05). The job runs under runExclusive
 * with its own lock, and a failed run is logged, never thrown out of the tick.
 *
 * Mock baseline copied from scheduler-caller-callback-bell-cron.test.js.
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
  recurringSeriesTopUpLive: jest.fn(() => false), callerCallbackBellLive: jest.fn(() => false),
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
jest.mock('../services/estimate-no-time-soon-check', () => ({
  runEstimateNoTimeSoonCheck: jest.fn(async () => ({ candidates: 9, raised: 2, closed: 1 })),
  closeSettledNoTimeSoonAlerts: jest.fn(async () => ({ ran: true, open: 0, closed: 0 })),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runEstimateNoTimeSoonCheck } = require('../services/estimate-no-time-soon-check');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function dailyTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '35 7 * * *' && String(task).includes('runEstimateNoTimeSoonCheck'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => jest.clearAllMocks());

test('7:35 AM ET: the job runs once inside its own runExclusive lock and logs the outcome', async () => {
  await dailyTick();
  expect(runExclusive).toHaveBeenCalledWith('estimate-no-time-soon-check', expect.any(Function));
  expect(runEstimateNoTimeSoonCheck).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Estimate no-time-soon check: 9 open, 2 raised, 1 closed');
});

test('a failed run is logged, never thrown out of the tick', async () => {
  runEstimateNoTimeSoonCheck.mockRejectedValueOnce(new Error('1 estimate no-time-soon check failed'));
  await expect(dailyTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Estimate no-time-soon check failed: 1 estimate no-time-soon check failed');
});
