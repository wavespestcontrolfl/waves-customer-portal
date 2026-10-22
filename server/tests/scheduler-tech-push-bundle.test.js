/**
 * The every-minute bundled tech push sweep's cron registration
 * (GATE_TECH_PUSH_BUNDLE, server/services/scheduler.js). The sweep itself is
 * unit-tested in tech-visit-notifications.test.js; this file proves it is
 * registered even with GATE_CRON_JOBS off: with the bundle gate on, deliver()
 * holds pushes whether or not cron jobs run, and only this sweep sends them
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

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { flushBundledPushes } = require('../services/tech-visit-notifications');
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
