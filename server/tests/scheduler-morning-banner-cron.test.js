/**
 * Morning banner in its own daily 8:00 AM ET cron (server/services/scheduler.js, '0 8 * * *', GATE_MORNING_BANNER):
 * gate off reads nothing; on, the job runs under runExclusive (the per-ET-day claim inside it stops a second banner),
 * a failed run is logged, never thrown out of the tick, and the schedule is 8:00 in America/New_York on every date,
 * the clock-change days included.
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
  recurringSeriesTopUpLive: jest.fn(() => false), mondayReviewBellLive: jest.fn(() => false), morningBannerLive: jest.fn(() => false),
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

jest.mock('../services/morning-banner', () => ({ runMorningBanner: jest.fn(async () => ({ count: 2, sent: true })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, morningBannerLive } = require('../config/feature-gates');
const { runMorningBanner } = require('../services/morning-banner');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function bannerRegistration() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([, task]) => String(task).includes('runMorningBanner'));
  expect(registrations).toHaveLength(1);
  return registrations[0];
}
const bannerTick = () => bannerRegistration()[1]();

beforeEach(() => {
  jest.clearAllMocks();
  morningBannerLive.mockReturnValue(false);
});

test('registered once, at 8:00 every day, on the Eastern clock', () => {
  const [expression, , options] = bannerRegistration();
  expect(expression).toBe('0 8 * * *');
  expect(options).toEqual({ timezone: 'America/New_York' });
});

test('8:00 AM Eastern is a real, single instant on the clock-change days, and the day key is that ET date', () => {
  // Spring forward 2026-03-08 and fall back 2026-11-01 both change the clocks at 2 AM, before 8:00.
  const cases = [['2026-03-07', '13:00'], ['2026-03-08', '12:00'], ['2026-03-09', '12:00'], ['2026-10-31', '12:00'], ['2026-11-01', '13:00'], ['2026-11-02', '13:00']];
  for (const [day, utcTime] of cases) {
    const fire = parseETDateTime(`${day}T08:00`);
    expect(fire.toISOString()).toBe(`${day}T${utcTime}:00.000Z`);
    expect(etDateString(fire)).toBe(day);
  }
});

test('gate off: the tick returns before the lock or any read', async () => {
  await bannerTick();
  expect(runExclusive).not.toHaveBeenCalledWith('morning-banner', expect.any(Function));
  expect(runMorningBanner).not.toHaveBeenCalled();
});

test('gate on: the job runs once inside runExclusive', async () => {
  morningBannerLive.mockReturnValue(true);
  await bannerTick();
  expect(runExclusive).toHaveBeenCalledWith('morning-banner', expect.any(Function));
  expect(runMorningBanner).toHaveBeenCalledTimes(1);
});

test('a failed run is logged, never thrown out of the tick', async () => {
  morningBannerLive.mockReturnValue(true);
  runMorningBanner.mockRejectedValueOnce(new Error('connection reset'));
  await expect(bannerTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Morning banner failed: connection reset');
});
