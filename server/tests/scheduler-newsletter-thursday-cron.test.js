/**
 * The weekly events email's crons (server/services/scheduler.js), after the send moved from
 * Tuesday to Thursday 6:00 AM ET (owner 2026-11-26): the autopilot drafts Wednesday 7:15 AM, with
 * catch-ups Wednesday 2:00 PM and Thursday 4:30 AM, all ET. Nothing runs on the old Monday and
 * Tuesday slots, and the 7:15 start keeps it off the Waves Pest Insider planner's 7:00 AM run.
 *
 * Mock baseline copied from scheduler-pest-insider-shadow-cron.test.js.
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

jest.mock('../services/newsletter-autopilot', () => ({ autoDraftFlagship: jest.fn(async () => ({ skipped: true, reason: 'test' })) }));
jest.mock('../services/pest-insider/schedule', () => ({ runIssuePlanner: jest.fn(async () => ({ skipped: true, reason: 'not_build_day' })) }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { autoDraftFlagship } = require('../services/newsletter-autopilot');
const { initScheduledJobs } = require('../services/scheduler');

function newsletterRegistrations() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  return cron.schedule.mock.calls.filter(([, task]) => /newsletter-autopilot|autoDraftFlagship/.test(String(task)));
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('the autopilot and its two catch-ups run Wednesday 7:15 AM, Wednesday 2:00 PM and Thursday 4:30 AM ET, and nothing else', () => {
  const registrations = newsletterRegistrations();
  expect(registrations.map(([expression]) => expression).sort()).toEqual(['0 14 * * 3', '15 7 * * 3', '30 4 * * 4']);
  for (const [, , options] of registrations) expect(options).toEqual({ timezone: 'America/New_York' });
});

test('the 7:15 AM Wednesday tick drafts the weekly issue', async () => {
  const [, task] = newsletterRegistrations().find(([expression]) => expression === '15 7 * * 3');
  await task();
  expect(autoDraftFlagship).toHaveBeenCalledTimes(1);
});
