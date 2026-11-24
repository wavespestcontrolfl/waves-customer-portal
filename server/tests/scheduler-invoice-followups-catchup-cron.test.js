/**
 * GATE_MONEY_NOTICE_CATCHUP, invoice follow-ups (owner 2026-11-06, "jobs 1-6"): a
 * second Tue–Fri run at 1:16 PM ET, same day as the 10:16 run and under the SAME
 * runExclusive lock name, so a lost 10:16 tick no longer skips that day's touches
 * for good. Gate off, the 1:16 tick does nothing. The 10:16 tick is unchanged. The
 * per-row rules of the catch-up run (claimed rows, stale grace) are tested in
 * invoice-followups-same-day-catchup.test.js.
 *
 * Mock baseline copied from scheduler-autopay-hold-timeout.test.js.
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
jest.mock('../services/invoice-followups', () => ({
  releaseStaleAutopayHolds: jest.fn().mockResolvedValue({ mode: 'true' }),
  clearAtRiskForSettledLongOverdue: jest.fn().mockResolvedValue([]),
  runPending: jest.fn().mockResolvedValue({ sent: 0, skipped: 0 }),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const InvoiceFollowUps = require('../services/invoice-followups');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

let registrations = null;
function tick(expression) {
  if (!registrations) {
    initScheduledJobs();
    registrations = cron.schedule.mock.calls.map(([expr, fn, opts]) => ({ expr, fn, opts }));
  }
  const matches = registrations.filter((r) => r.expr === expression);
  expect(matches).toHaveLength(1);
  expect(matches[0].opts).toEqual({ timezone: 'America/New_York' });
  return matches[0].fn();
}

const savedGate = process.env.GATE_MONEY_NOTICE_CATCHUP;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(require('../config/feature-gates'), 'isEnabled').mockImplementation((name) => name === 'cronJobs');
  runExclusive.mockImplementation(async (_key, task) => task());
  delete process.env.GATE_MONEY_NOTICE_CATCHUP;
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_MONEY_NOTICE_CATCHUP;
  else process.env.GATE_MONEY_NOTICE_CATCHUP = savedGate;
});

describe('1:16 PM catch-up tick (Tue–Fri)', () => {
  test('gate off: no lock, no run', async () => {
    await tick('16 13 * * 2-5');
    expect(runExclusive).not.toHaveBeenCalled();
    expect(InvoiceFollowUps.runPending).not.toHaveBeenCalled();
  });

  test('gate on: runs the due touches under the SAME lock as 10:16, in catch-up mode, without the Auto Pay hold sweep', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    await tick('16 13 * * 2-5');
    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(runExclusive).toHaveBeenCalledWith('invoice-followups', expect.any(Function));
    expect(InvoiceFollowUps.runPending).toHaveBeenCalledWith({ catchUp: true });
    expect(InvoiceFollowUps.releaseStaleAutopayHolds).not.toHaveBeenCalled();
    expect(InvoiceFollowUps.clearAtRiskForSettledLongOverdue).not.toHaveBeenCalled();
  });

  test('a lock the 10:16 run (or another instance) still holds runs nothing', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
    await tick('16 13 * * 2-5');
    expect(InvoiceFollowUps.runPending).not.toHaveBeenCalled();
  });

  test('a failed run is logged, never thrown out of the tick', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    InvoiceFollowUps.runPending.mockRejectedValueOnce(new Error('boom'));
    await expect(tick('16 13 * * 2-5')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Invoice follow-ups catch-up failed: boom');
  });
});

test('the 10:16 tick is unchanged with the gate on: hold sweep, then a plain run', async () => {
  process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
  await tick('16 10 * * 2-5');
  expect(runExclusive).toHaveBeenCalledWith('invoice-followups', expect.any(Function));
  expect(InvoiceFollowUps.releaseStaleAutopayHolds).toHaveBeenCalledTimes(1);
  expect(InvoiceFollowUps.runPending).toHaveBeenCalledWith();
});
