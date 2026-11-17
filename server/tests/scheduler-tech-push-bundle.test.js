/**
 * The every-minute bundled tech push sweep's cron registration
 * (server/services/scheduler.js). The sweep itself is
 * unit-tested in tech-visit-notifications.test.js; this file proves it is
 * registered even with GATE_CRON_JOBS off: deliver() holds pushes whether or not cron jobs run, and only this sweep sends them
 * (Codex #6459 r2). Same mock shape as scheduler-consultation-outcome-reconcile.test.js.
 */
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../models/db', () => {
  // select: the boot pass of the deploy-kill retry reads job_health (no rows here).
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0), select: jest.fn().mockResolvedValue([]) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));

jest.mock('../services/tech-visit-notifications', () => ({ flushBundledPushes: jest.fn(async () => ({ pushed: 0 })) }));
jest.mock('../services/live-call-card-pause', () => ({ recoverOpenPauses: jest.fn(async () => ({ action: 'swept' })) }));
jest.mock('../services/call-hold', () => ({ recoverPendingHolds: jest.fn(async () => ({ action: 'swept' })) }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { flushBundledPushes } = require('../services/tech-visit-notifications');
const { recoverOpenPauses } = require('../services/live-call-card-pause');
const { recoverPendingHolds } = require('../services/call-hold');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
});

// Every-minute handlers registered by one initScheduledJobs() call, run once each.
async function runEveryMinuteHandlers() {
  initScheduledJobs();
  const everyMinute = cron.schedule.mock.calls.filter(([expression]) => expression === '* * * * *');
  for (const [, handler] of everyMinute) await handler();
  return everyMinute;
}

test('registered every minute, America/New_York, and runs the sweep', async () => {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  const everyMinute = await runEveryMinuteHandlers();
  expect(flushBundledPushes).toHaveBeenCalledTimes(1);
  expect(everyMinute.every(([, , opts]) => opts && opts.timezone === 'America/New_York')).toBe(true);
});

test('registered even when GATE_CRON_JOBS (and every other gate) is off: held pushes must still go out (Codex #6459 r2 P1)', async () => {
  isEnabled.mockImplementation(() => false);
  await runEveryMinuteHandlers();
  expect(flushBundledPushes).toHaveBeenCalledTimes(1);
});

test('a sweep that throws is logged, never thrown into the scheduler', async () => {
  isEnabled.mockImplementation(() => false);
  flushBundledPushes.mockRejectedValueOnce(new Error('db down'));
  await expect(runEveryMinuteHandlers()).resolves.toBeDefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[tech-push-bundle] sweep failed: db down'));
});

test('the card-pause recovery sweep is registered every minute even with every gate off, and a throw is only logged', async () => {
  isEnabled.mockImplementation(() => false);
  recoverOpenPauses.mockRejectedValueOnce(new Error('db down'));
  const everyMinute = await runEveryMinuteHandlers();
  // The bundled push sweep, the card-pause recovery sweep and the star-key hold recovery sweep.
  expect(everyMinute).toHaveLength(3);
  expect(recoverOpenPauses).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[live-card-pause] recovery tick failed: db down'));
});

test('the star-key hold recovery sweep is registered every minute even with every gate off, and a throw is only logged', async () => {
  isEnabled.mockImplementation(() => false);
  recoverPendingHolds.mockRejectedValueOnce(new Error('db down'));
  await expect(runEveryMinuteHandlers()).resolves.toBeDefined();
  expect(recoverPendingHolds).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[call-hold] recovery tick failed: db down'));
  expect(flushBundledPushes).toHaveBeenCalledTimes(1);
});
