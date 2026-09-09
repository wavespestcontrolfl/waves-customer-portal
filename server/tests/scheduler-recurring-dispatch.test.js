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
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');
const { runAutoDispatch } = require('../services/auto-dispatch');
const { flagUnplacedVisits } = require('../services/auto-dispatch/audit');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  flagUnplacedVisits.mockResolvedValue(0);
  runAutoDispatch.mockResolvedValue({ runId: 'run-1', status: 'completed' });
});

function tick() {
  initScheduledJobs();
  const registration = cron.schedule.mock.calls.find(([expression]) => expression === '10 4 * * *');
  expect(registration[2]).toEqual({ timezone: 'America/New_York' });
  return registration[1]();
}

test('the existing daily tick maintains handoff alerts with autoDispatch disabled', async () => {
  await tick();
  expect(runExclusive).toHaveBeenCalledWith('auto-dispatch-recurring', expect.any(Function));
  expect(flagUnplacedVisits).toHaveBeenCalledTimes(1);
  expect(runAutoDispatch).not.toHaveBeenCalled();
});

test('the existing IB retention tick purges tasks and threads while their write gates are off', async () => {
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '23 4 * * *');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  await registrations[0][1]();
  expect(runExclusive).toHaveBeenCalledWith('ib-thread-retention', expect.any(Function));
  expect(require('../services/intelligence-bar/threads').purgeExpiredThreads).toHaveBeenCalledTimes(1);
  expect(require('../services/intelligence-bar/tasks').purgeExpiredTasks).toHaveBeenCalledTimes(1);
});

test.each([false, true])('handoff alerts stay registered with cronJobs off and autoDispatch=%s', async (autoDispatch) => {
  isEnabled.mockImplementation((name) => name === 'autoDispatch' && autoDispatch);
  await tick();
  // Only the handoff tick and the job_health dead-running settle (ledger
  // maintenance, registered above the cronJobs early return) survive.
  expect(cron.schedule.mock.calls.map(([expression]) => expression).sort()).toEqual(['10 4 * * *', '3,18,33,48 * * * *']);
  expect(flagUnplacedVisits).toHaveBeenCalledTimes(1);
  expect(runAutoDispatch).not.toHaveBeenCalled();
});

test('an enabled optimizer uses its existing in-run alert audit', async () => {
  isEnabled.mockImplementation((name) => ['cronJobs', 'autoDispatch'].includes(name));
  await tick();
  expect(runAutoDispatch).toHaveBeenCalledWith({ triggeredBy: 'cron' });
  expect(flagUnplacedVisits).not.toHaveBeenCalled();
});

test('a gate-off alert failure reaches the job failure path', async () => {
  flagUnplacedVisits.mockRejectedValueOnce(new Error('notification store unavailable'));
  await tick();
  expect(logger.error).toHaveBeenCalledWith('Auto-Dispatch run failed: notification store unavailable');
});
