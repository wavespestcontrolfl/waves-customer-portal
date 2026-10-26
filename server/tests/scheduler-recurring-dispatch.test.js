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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(), autoDispatchCatchUpLive: jest.fn(() => false) }));
jest.mock('../services/auto-dispatch/catch-up', () => ({ runCatchUp: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn(), maintainMissingGeoNotices: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
// The move-check notices' upkeep on the gate-off path: closed by the same rules as in a run.
jest.mock('../services/auto-dispatch/proofreader/nightly', () => ({ closeNotices: jest.fn(async () => true) }));
jest.mock('../services/auto-dispatch/check-down-notice', () => ({ noteRun: jest.fn(async () => ({ action: 'none' })) }));

const cron = require('../utils/scheduled-cron');
const { isEnabled, autoDispatchCatchUpLive } = require('../config/feature-gates');
const { runCatchUp } = require('../services/auto-dispatch/catch-up');
const { runExclusive } = require('../utils/cron-lock');
const { runAutoDispatch } = require('../services/auto-dispatch');
const { flagUnplacedVisits, maintainMissingGeoNotices } = require('../services/auto-dispatch/audit');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  flagUnplacedVisits.mockResolvedValue(0);
  maintainMissingGeoNotices.mockResolvedValue(undefined);
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
  // No placement run on a gate-off night: pin notices are still kept current (Codex #6208 r17 P2).
  expect(maintainMissingGeoNotices).toHaveBeenCalledTimes(1);
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
  // Only the handoff tick, the job_health dead-running settle (ledger
  // maintenance) and the consultation-outcome reconcile sweep (#4710 — a
  // completeness guarantee, not a feature cron) are registered above the
  // cronJobs early return and survive.
  // '* * * * *': the bundled tech push sweep, which must send pushes held whether or not cron jobs run (Codex #6459 r2).
  expect(cron.schedule.mock.calls.map(([expression]) => expression).sort()).toEqual(['* * * * *', '10 4 * * *', '27 * * * *', '3,18,33,48 * * * *']);
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
  // The pin-notice upkeep still ran (Codex #6208 r18 P2).
  expect(maintainMissingGeoNotices).toHaveBeenCalledTimes(1);
});

test('a gate-off night keeps the move-check-down notice by the same rule as a run; its failure reaches the job failure path (Codex #6465 r1)', async () => {
  const checkDown = require('../services/auto-dispatch/check-down-notice');
  await tick();
  // No run state: only the notice's own gate or the check being off closes it.
  expect(checkDown.noteRun).toHaveBeenCalledWith(null, { enabled: expect.any(Boolean), nowDate: expect.any(Date) });
  expect(logger.error).not.toHaveBeenCalled();
  checkDown.noteRun.mockResolvedValueOnce({ action: 'error' });
  await tick();
  expect(logger.error).toHaveBeenCalledWith('Auto-Dispatch run failed: move-check-down notice upkeep failed');
});

test('a gate-off pin-notice upkeep failure reaches the job failure path after the alert pass ran', async () => {
  maintainMissingGeoNotices.mockRejectedValueOnce(new Error('pin read failed'));
  await tick();
  expect(flagUnplacedVisits).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('Auto-Dispatch run failed: pin read failed');
});

// 5:00 AM catch-up (GATE_AUTO_DISPATCH_CATCH_UP, owner 2026-10-26).
function catchUpTick() {
  initScheduledJobs();
  // Other jobs also run at 0 5 * * *; the catch-up is the one that reads its gate.
  const registrations = cron.schedule.mock.calls.filter(([expression, fn]) => expression === '0 5 * * *' && String(fn).includes('autoDispatchCatchUpLive'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  // Registration reads the database for boundary upkeep; only the tick's own reads matter below.
  require('../models/db').mockClear();
  return registrations[0][1]();
}

describe('5 AM auto-dispatch catch-up', () => {
  beforeEach(() => {
    isEnabled.mockImplementation((name) => ['cronJobs', 'autoDispatch'].includes(name));
    autoDispatchCatchUpLive.mockReturnValue(true);
    runCatchUp.mockResolvedValue({ ran: true, reason: 'no night run started on 2026-10-26', settled: 0, result: { runId: 'run-9', status: 'completed', evaluated: 3, recommended: 1, changed: 1, skipped: 1, failed: 0 } });
  });

  test('gate off: returns at once, no lock, no read, no run', async () => {
    autoDispatchCatchUpLive.mockReturnValue(false);
    await catchUpTick();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(runCatchUp).not.toHaveBeenCalled();
    expect(runAutoDispatch).not.toHaveBeenCalled();
    // (Registration-time upkeep may still touch other tables; the catch-up itself reads auto_dispatch_runs.)
    expect(require('../models/db').mock.calls.map(([table]) => table)).not.toContain('auto_dispatch_runs');
  });

  test('cron jobs or auto-dispatch off: returns at once', async () => {
    isEnabled.mockImplementation((name) => name === 'cronJobs');
    await catchUpTick();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(runCatchUp).not.toHaveBeenCalled();
  });

  test('cron jobs off: the catch-up is not registered', () => {
    isEnabled.mockImplementation(() => false);
    initScheduledJobs();
    expect(cron.schedule.mock.calls.filter(([, fn]) => String(fn).includes('autoDispatchCatchUpLive'))).toHaveLength(0);
  });

  test('gate on: borrows the 4:10 writer lock inside its own job and runs the catch-up', async () => {
    await catchUpTick();
    expect(runExclusive).toHaveBeenCalledWith('auto-dispatch-catch-up', expect.any(Function));
    expect(runExclusive).toHaveBeenCalledWith('auto-dispatch-recurring', expect.any(Function), { recordHealth: false });
    expect(runCatchUp).toHaveBeenCalledWith({ nowDate: expect.any(Date) });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('catch-up running now'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('catch-up run run-9 completed: evaluated=3 recommended=1 changed=1 skipped=1 failed=0'));
  });

  test('not needed: logs the reason and does not fail job health', async () => {
    runCatchUp.mockResolvedValue({ ran: false, reason: 'the night run on 2026-10-26 already finished (completed)', settled: 0 });
    await catchUpTick();
    expect(logger.info).toHaveBeenCalledWith('[auto-dispatch] catch-up not needed: the night run on 2026-10-26 already finished (completed)');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('writer lock held elsewhere: warns and fails job health', async () => {
    runExclusive.mockImplementation(async (key, task, opts) => (key === 'auto-dispatch-recurring' ? { skipped: true, reason: 'lease_held' } : task()));
    await catchUpTick();
    expect(runCatchUp).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('catch-up skipped (lease_held)'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('auto-dispatch catch-up skipped (lease_held)'));
    runExclusive.mockImplementation(async (_key, task) => task());
  });

  test('a run that is not completed fails job health', async () => {
    runCatchUp.mockResolvedValue({ ran: true, reason: 'x', settled: 1, result: { runId: 'run-10', status: 'completed_with_errors', failed: 2 } });
    await catchUpTick();
    expect(logger.error).toHaveBeenCalledWith('Auto-Dispatch catch-up failed: auto-dispatch catch-up run run-10 unhealthy: status=completed_with_errors failed=2');
  });
});
