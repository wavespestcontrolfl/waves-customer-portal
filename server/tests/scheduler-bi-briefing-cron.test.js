/**
 * Weekly BI Briefing cron (server/services/scheduler.js, '0 5 * * 1'): the
 * tick runs under runExclusive so a Railway deploy overlap cannot start two
 * briefing sessions (Codex #4870 r4 P1). The owner text is also claimed once
 * per ET week inside the tool (bi-briefing-sms.test.js).
 *
 * Mock baseline copied from scheduler-recurring-series-topup-cron.test.js.
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

jest.mock('../services/bi-agent', () => ({ run: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const BIAgent = require('../services/bi-agent');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function biTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '0 5 * * 1');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('the Monday tick runs the briefing inside runExclusive', async () => {
  BIAgent.run.mockResolvedValue({ smsSent: true });
  await biTick();
  expect(runExclusive).toHaveBeenCalledWith('bi-weekly-briefing', expect.any(Function));
  expect(BIAgent.run).toHaveBeenCalledTimes(1);
});

test('a tick another instance already holds never starts a second briefing', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await biTick();
  expect(BIAgent.run).not.toHaveBeenCalled();
});

test('a failed briefing is logged, never thrown out of the tick', async () => {
  BIAgent.run.mockRejectedValue(new Error('session create failed'));
  await expect(biTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('BI Briefing Agent failed'));
});
