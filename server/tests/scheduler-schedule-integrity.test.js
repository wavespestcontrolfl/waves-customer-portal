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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));

jest.mock('../services/schedule-integrity-watchdog', () => ({ runScheduleIntegrityWatchdog: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { runScheduleIntegrityWatchdog } = require('../services/schedule-integrity-watchdog');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((name) => name === 'cronJobs');
});

test.each([
  [{ acceptedScheduleCheckFailed: true }, 'ACCEPTED-SCHEDULE-CHECK-FAILED'],
  [{ acceptedScheduleGaps: 1 }, 'acceptedScheduleGaps=1'],
])('the existing daily tick surfaces acceptance-check status %j', async (result, message) => {
  runScheduleIntegrityWatchdog.mockResolvedValue({ skipped: false, stale: 0, unpricedSeries: 0,
    lawnEmailGaps: 0, lawnGapCheckFailed: false, acceptedScheduleGaps: 0,
    acceptedScheduleCheckFailed: false, alerted: 0, ...result });
  initScheduledJobs();
  // The earlier Google Ads upload shares 6:40; this watchdog is registered last.
  const registration = cron.schedule.mock.calls.filter(([expression]) => expression === '40 6 * * *').at(-1);
  expect(registration[2]).toEqual({ timezone: 'America/New_York' });
  await registration[1]();
  expect(runScheduleIntegrityWatchdog).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(message));
});
