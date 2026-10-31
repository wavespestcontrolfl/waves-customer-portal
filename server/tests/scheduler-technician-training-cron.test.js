/**
 * Technician training reminders in the 6:52 ET cron (server/services/scheduler.js, '52 6 * * *'; GATE_TECH_TRAINING_DATES, dark).
 * The gate is read per tick: off returns before the lease and the sweep; on runs the sweep under runExclusive so a Railway
 * deploy overlap cannot raise the same bells twice; a failed sweep is logged and never thrown out of the tick.
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
  recurringSeriesTopUpLive: jest.fn(() => false),
  techTrainingDatesLive: jest.fn(() => false),
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

jest.mock('../services/technician-training-reminders', () => ({ runTechnicianTrainingReminders: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, techTrainingDatesLive } = require('../config/feature-gates');
const { runTechnicianTrainingReminders } = require('../services/technician-training-reminders');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function trainingTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '52 6 * * *' && String(task).includes('technician-training-dates'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  techTrainingDatesLive.mockReturnValue(false);
});

test('gate off: the tick returns before the lease and the sweep', async () => {
  await trainingTick();
  expect(runExclusive).not.toHaveBeenCalledWith('technician-training-dates', expect.any(Function));
  expect(runTechnicianTrainingReminders).not.toHaveBeenCalled();
});

test('gate on: the sweep runs inside runExclusive', async () => {
  techTrainingDatesLive.mockReturnValue(true);
  await trainingTick();
  expect(runExclusive).toHaveBeenCalledWith('technician-training-dates', expect.any(Function));
  expect(runTechnicianTrainingReminders).toHaveBeenCalledTimes(1);
});

test('a tick another instance already holds never runs a second sweep', async () => {
  techTrainingDatesLive.mockReturnValue(true);
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await trainingTick();
  expect(runTechnicianTrainingReminders).not.toHaveBeenCalled();
});

test('a failed sweep is logged, never thrown out of the tick', async () => {
  techTrainingDatesLive.mockReturnValue(true);
  runTechnicianTrainingReminders.mockRejectedValueOnce(new Error('sweep failed'));
  await expect(trainingTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[technician-training-reminders] tick failed: sweep failed');
});
