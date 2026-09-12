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
  // Only correctness recovery registered above the cronJobs early return
  // survives: the handoff tick, the job_health dead-running settle (ledger
  // maintenance) and — since codex #4210 round 4 — the unknown-sender SMS
  // alert sweep. That sweep is the ONLY process-independent recovery for a
  // claim whose winner crashed, so leaving it below the gate meant turning
  // cron off silently removed it. Ordinary scheduled FEATURES must still
  // stay below the gate; this list is the guard against them leaking above
  // it, so add to it only for recovery a correctness bug depends on.
  expect(cron.schedule.mock.calls.map(([expression]) => expression).sort()).toEqual(['*/2 * * * *', '10 4 * * *', '3,18,33,48 * * * *']);
  expect(flagUnplacedVisits).toHaveBeenCalledTimes(1);
  expect(runAutoDispatch).not.toHaveBeenCalled();
});

test.each([false, true])('the unknown-sender SMS alert sweep still RUNS with cronJobs off (cronJobs=%s) — codex #4210 round-4 P1', async (cronJobs) => {
  isEnabled.mockImplementation((name) => name === 'cronJobs' && cronJobs);
  jest.doMock('../services/sms-reply-alert-sweep', () => ({
    sweepUnknownSenderAlertClaims: jest.fn(async () => ({ dispatched: 0, checked: 0 })),
  }), { virtual: false });
  initScheduledJobs();
  const registration = cron.schedule.mock.calls.find(([expression]) => expression === '*/2 * * * *');
  expect(registration).toBeDefined();
  expect(registration[2]).toEqual({ timezone: 'America/New_York' });
  // Registered is not the same as working: run the tick and prove it reaches
  // the sweep through its cron lock. Behind the master gate this recovery
  // simply did not exist, which silently reinstated the permanently-unread
  // first-contact thread the claim design was built to prevent.
  await registration[1]();
  expect(runExclusive).toHaveBeenCalledWith('sms-reply-alert-sweep', expect.any(Function));
  expect(require('../services/sms-reply-alert-sweep').sweepUnknownSenderAlertClaims).toHaveBeenCalledTimes(1);
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
