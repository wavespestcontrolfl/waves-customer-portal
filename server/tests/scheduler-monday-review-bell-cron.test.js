/**
 * Monday review bell in its own Monday 9:20 ET cron (server/services/scheduler.js, '20 9 * * 1'):
 * gate off reads nothing; on, the review runs under runExclusive, so a deploy overlap never raises it twice,
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
  recurringSeriesTopUpLive: jest.fn(() => false), mondayReviewBellLive: jest.fn(() => false),
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

jest.mock('../services/monday-review-bell', () => ({ runMondayReview: jest.fn(async () => ({ count: 2, outcome: 'raised' })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, mondayReviewBellLive } = require('../config/feature-gates');
const { runMondayReview } = require('../services/monday-review-bell');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function reviewTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '20 9 * * 1' && String(task).includes('runMondayReview'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  mondayReviewBellLive.mockReturnValue(false);
});

test('gate off: the tick returns before the lock or any read', async () => {
  await reviewTick();
  expect(runExclusive).not.toHaveBeenCalledWith('monday-review-bell', expect.any(Function));
  expect(runMondayReview).not.toHaveBeenCalled();
});

test('gate on: the review runs once inside runExclusive and its outcome is logged', async () => {
  mondayReviewBellLive.mockReturnValue(true);
  await reviewTick();
  expect(runExclusive).toHaveBeenCalledWith('monday-review-bell', expect.any(Function));
  expect(runMondayReview).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Monday review bell: 2 list(s) (raised)');
});

test('a failed run is logged, never thrown out of the tick', async () => {
  mondayReviewBellLive.mockReturnValue(true);
  runMondayReview.mockRejectedValueOnce(new Error('connection reset'));
  await expect(reviewTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Monday review bell failed: connection reset');
});
