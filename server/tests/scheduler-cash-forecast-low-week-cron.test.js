/**
 * The cash forecast low-week bell in its own daily 7:43 ET cron (server/services/scheduler.js, '43 7 * * *'):
 * gate off reads nothing; on, the check runs under runExclusive, so a deploy overlap never raises it twice,
 * and a failed run is logged, never thrown out of the tick.
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
  recurringSeriesTopUpLive: jest.fn(() => false), invoiceNotOnSparkLive: jest.fn(() => false), cashForecastLive: jest.fn(() => false),
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

jest.mock('../services/cash-forecast/low-week-bell', () => ({ runCashForecastLowWeek: jest.fn(async () => ({ count: 2, outcome: 'raised' })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, cashForecastLive } = require('../config/feature-gates');
const { runCashForecastLowWeek } = require('../services/cash-forecast/low-week-bell');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function lowWeekTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '43 7 * * *' && String(task).includes('runCashForecastLowWeek'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  cashForecastLive.mockReturnValue(false);
});

test('gate off: the tick returns before the lock or any read', async () => {
  await lowWeekTick();
  expect(runExclusive).not.toHaveBeenCalledWith('cash-forecast-low-week', expect.any(Function));
  expect(runCashForecastLowWeek).not.toHaveBeenCalled();
});

test('gate on: the check runs once inside runExclusive and its outcome is logged', async () => {
  cashForecastLive.mockReturnValue(true);
  await lowWeekTick();
  expect(runExclusive).toHaveBeenCalledWith('cash-forecast-low-week', expect.any(Function));
  expect(runCashForecastLowWeek).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Cash forecast low week: 2 weeks below the floor (raised)');
});

test('a reason rides the log line when the line could not be judged', async () => {
  cashForecastLive.mockReturnValue(true);
  runCashForecastLowWeek.mockResolvedValueOnce({ count: 0, outcome: 'not_judged', reason: 'balance_unread' });
  await lowWeekTick();
  expect(logger.info).toHaveBeenCalledWith('Cash forecast low week: 0 weeks below the floor (not_judged: balance_unread)');
});

test('a failed run is logged, never thrown out of the tick', async () => {
  cashForecastLive.mockReturnValue(true);
  runCashForecastLowWeek.mockRejectedValueOnce(new Error('connection reset'));
  await expect(lowWeekTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Cash forecast low week failed: connection reset');
});
