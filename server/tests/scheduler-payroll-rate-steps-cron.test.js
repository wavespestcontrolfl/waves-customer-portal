/**
 * The pay rate step job in its own daily 12:07 AM ET cron (server/services/scheduler.js, '7 0 * * *'):
 * it applies every due step under runExclusive, so a deploy overlap never applies one twice, it has no
 * gate, and a failed run is logged, never thrown out of the tick.
 *
 * Mock baseline copied from scheduler-invoice-not-on-spark-cron.test.js.
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
  recurringSeriesTopUpLive: jest.fn(() => false), invoiceNotOnSparkLive: jest.fn(() => false),
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

jest.mock('../services/payroll-rate-steps', () => ({ applyDueStepsDaily: jest.fn(async () => ['step-1']) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { applyDueStepsDaily } = require('../services/payroll-rate-steps');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function rateStepTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '7 0 * * *' && String(task).includes('payroll-rate-steps'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('the job applies due steps once inside runExclusive and logs how many', async () => {
  await rateStepTick();
  expect(runExclusive).toHaveBeenCalledWith('payroll-rate-steps', expect.any(Function));
  expect(applyDueStepsDaily).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('[payroll-rate-steps] 1 pay rate step(s) applied');
});

test('a quiet day logs nothing', async () => {
  applyDueStepsDaily.mockResolvedValueOnce([]);
  await rateStepTick();
  expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('[payroll-rate-steps]'));
});

test('a failed run is logged, never thrown out of the tick', async () => {
  applyDueStepsDaily.mockRejectedValueOnce(new Error('connection reset'));
  await expect(rateStepTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[payroll-rate-steps] tick failed: connection reset');
});
