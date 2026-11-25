/**
 * Bank step left bell in its own cron (server/services/scheduler.js, '0 7,17,27,37,47,57 * * * *': every 10 minutes).
 * No gate (admin bell only, owner rule 2026-11-05). Runs under runExclusive with its own lock; a failed run is logged,
 * never thrown out of the tick.
 *
 * Mock baseline copied from scheduler-paid-visit-receipt-cron.test.js.
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
jest.mock('../services/bank-step-left-bell', () => ({
  runBankStepLeftBell: jest.fn(async () => ({ candidates: 4, rang: 1 })),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runBankStepLeftBell } = require('../services/bank-step-left-bell');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function tick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '0 7,17,27,37,47,57 * * * *' && String(task).includes('runBankStepLeftBell'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => jest.clearAllMocks());

test('every 10 minutes: the job runs once inside its own runExclusive lock and logs the outcome', async () => {
  await tick();
  expect(runExclusive).toHaveBeenCalledWith('bank-step-left-bell', expect.any(Function));
  expect(runBankStepLeftBell).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Bank step left bell: 1 rang (4 candidates)');
});

test('a failed run is logged, not thrown out of the tick', async () => {
  runBankStepLeftBell.mockRejectedValueOnce(new Error('stripe down'));
  await expect(tick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Bank step left bell failed: stripe down');
});
