/**
 * Unbilled visits in its own daily 7:23 ET cron (server/services/scheduler.js, '23 7 * * *'):
 * gate off reads nothing; on, the list runs under runExclusive, so a deploy overlap never raises it twice,
 * and a failed run is logged, never thrown out of the tick.
 *
 * Mock baseline copied from scheduler-quiet-overdue-invoices-cron.test.js.
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
  recurringSeriesTopUpLive: jest.fn(() => false), unbilledVisitsListLive: jest.fn(() => false),
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

jest.mock('../services/unbilled-visits-list', () => ({ runUnbilledVisitsList: jest.fn(async () => ({ count: 3, outcome: 'raised' })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, unbilledVisitsListLive } = require('../config/feature-gates');
const { runUnbilledVisitsList } = require('../services/unbilled-visits-list');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function unbilledListTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '23 7 * * *' && String(task).includes('runUnbilledVisitsList'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  unbilledVisitsListLive.mockReturnValue(false);
});

test('gate off: the tick returns before the lock or any read', async () => {
  await unbilledListTick();
  expect(runExclusive).not.toHaveBeenCalledWith('unbilled-visits-list', expect.any(Function));
  expect(runUnbilledVisitsList).not.toHaveBeenCalled();
});

test('gate on: the list runs once inside runExclusive and its outcome is logged', async () => {
  unbilledVisitsListLive.mockReturnValue(true);
  await unbilledListTick();
  expect(runExclusive).toHaveBeenCalledWith('unbilled-visits-list', expect.any(Function));
  expect(runUnbilledVisitsList).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Unbilled visits: 3 listed (raised)');
});

test('a failed run is logged, never thrown out of the tick', async () => {
  unbilledVisitsListLive.mockReturnValue(true);
  runUnbilledVisitsList.mockRejectedValueOnce(new Error('connection reset'));
  await expect(unbilledListTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Unbilled visits failed: connection reset');
});
