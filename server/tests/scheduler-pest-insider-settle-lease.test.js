/**
 * The every-minute newsletter tick (server/services/scheduler.js): after the dispatcher, the Waves
 * Pest Insider settle step runs under its own lease, so two ticks (a slow one, or an overlapping
 * deploy) never settle at once: a recovery never reads an issue while another tick is still
 * delivering its failure alert. A lease another tick holds skips only the settle step.
 *
 * Mock baseline copied from scheduler-alert-retention-cron.test.js.
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

jest.mock('../services/newsletter-sender', () => ({ processScheduledSends: jest.fn(), settlePlannedIssues: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const NewsletterSender = require('../services/newsletter-sender');
const { initScheduledJobs } = require('../services/scheduler');

function newsletterTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const ticks = cron.schedule.mock.calls.filter(([expression, task]) => expression === '* * * * *' && String(task).includes('settlePlannedIssues'));
  expect(ticks).toHaveLength(1);
  return ticks[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  runExclusive.mockImplementation(async (_key, task) => task());
});

test('the settle step runs inside its own lease, after the dispatcher', async () => {
  await newsletterTick();
  expect(runExclusive).toHaveBeenCalledWith('pest-insider-settle', expect.any(Function));
  expect(NewsletterSender.processScheduledSends).toHaveBeenCalledTimes(1);
  expect(NewsletterSender.settlePlannedIssues).toHaveBeenCalledTimes(1);
  expect(NewsletterSender.processScheduledSends.mock.invocationCallOrder[0])
    .toBeLessThan(NewsletterSender.settlePlannedIssues.mock.invocationCallOrder[0]);
});

test('a lease another tick holds skips the settle step, and the dispatcher still runs', async () => {
  runExclusive.mockImplementation(async (key, task) => (key === 'pest-insider-settle' ? { skipped: true, reason: 'lease_held' } : task()));
  await newsletterTick();
  expect(NewsletterSender.processScheduledSends).toHaveBeenCalledTimes(1);
  expect(NewsletterSender.settlePlannedIssues).not.toHaveBeenCalled();
});
