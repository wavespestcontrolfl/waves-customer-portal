/**
 * Bid kit expiry sweep in the 6:05 ET compliance cron (server/services/scheduler.js, '5 6 * * *'): the sweep reads the
 * open bells and then rings at most three, so it runs under runExclusive; a Railway deploy overlap must not run two
 * sweeps that each ring three (Codex #6523). The credential expiry check in the same tick is unchanged.
 *
 * Mock baseline copied from scheduler-bi-briefing-cron.test.js.
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

jest.mock('../services/credential-expiry-checker', () => ({ runCredentialExpiryCheck: jest.fn() }));
jest.mock('../services/bid-kit-expiry', () => ({ runBidKitExpiryCheck: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runCredentialExpiryCheck } = require('../services/credential-expiry-checker');
const { runBidKitExpiryCheck } = require('../services/bid-kit-expiry');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function complianceTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  // Two jobs share 6:05; the compliance one is the job that calls the bid kit sweep.
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '5 6 * * *' && String(task).includes('runBidKitExpiryCheck'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('the 6:05 tick runs the bid kit sweep inside runExclusive, after the credential check', async () => {
  await complianceTick();
  expect(runCredentialExpiryCheck).toHaveBeenCalledTimes(1);
  expect(runExclusive).toHaveBeenCalledWith('bid-kit-expiry', expect.any(Function));
  expect(runBidKitExpiryCheck).toHaveBeenCalledTimes(1);
});

test('a tick another instance already holds never runs a second sweep', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await complianceTick();
  expect(runCredentialExpiryCheck).toHaveBeenCalledTimes(1);
  expect(runBidKitExpiryCheck).not.toHaveBeenCalled();
});

test('a failed sweep is logged, never thrown out of the tick', async () => {
  runBidKitExpiryCheck.mockRejectedValueOnce(new Error('sweep failed'));
  await expect(complianceTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Bid kit expiry check failed: sweep failed');
});
