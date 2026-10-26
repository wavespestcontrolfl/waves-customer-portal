/**
 * GATE_AUTOPAY_HOLD_TIMEOUT wiring in the invoice follow-up job (server/services/scheduler.js): the sweep runs once
 * per run, inside the same runExclusive lock and before due touches, and a sweep failure is logged without
 * stopping the touch run. Also pins the gate reader and that gate-off runs no query.
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
  runPending: jest.fn().mockResolvedValue({ sent: 0, skipped: 0 }),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const InvoiceFollowUps = require('../services/invoice-followups');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function followupTick() {
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '16 10 * * 2-5');
  expect(registrations).toHaveLength(1);
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(require('../config/feature-gates'), 'isEnabled').mockImplementation((name) => name === 'cronJobs');
  runExclusive.mockImplementation(async (_key, task) => task());
});

test('the sweep runs once, inside the invoice-followups lock, before due touches', async () => {
  const order = [];
  InvoiceFollowUps.releaseStaleAutopayHolds.mockImplementationOnce(async () => { order.push('sweep'); });
  InvoiceFollowUps.runPending.mockImplementationOnce(async () => { order.push('touches'); return { sent: 1, skipped: 2 }; });
  await followupTick();
  expect(runExclusive).toHaveBeenCalledWith('invoice-followups', expect.any(Function));
  expect(InvoiceFollowUps.releaseStaleAutopayHolds).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['sweep', 'touches']);
});

test('a lock another instance already holds runs neither the sweep nor the touches', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await followupTick();
  expect(InvoiceFollowUps.releaseStaleAutopayHolds).not.toHaveBeenCalled();
  expect(InvoiceFollowUps.runPending).not.toHaveBeenCalled();
});

test('a sweep that throws is logged and the touch run still happens', async () => {
  InvoiceFollowUps.releaseStaleAutopayHolds.mockRejectedValueOnce(new Error('boom'));
  await expect(followupTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Invoice follow-ups: autopay hold timeout sweep failed: boom');
  expect(InvoiceFollowUps.runPending).toHaveBeenCalledTimes(1);
});

describe('gate reader and gate-off sweep', () => {
  const saved = process.env.GATE_AUTOPAY_HOLD_TIMEOUT;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_AUTOPAY_HOLD_TIMEOUT;
    else process.env.GATE_AUTOPAY_HOLD_TIMEOUT = saved;
  });

  test.each([
    [undefined, 'off'], ['', 'off'], ['false', 'off'], ['on', 'off'], ['1', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['true', 'true'], ['TRUE', 'true'],
  ])('GATE_AUTOPAY_HOLD_TIMEOUT=%p reads as %s', (value, expected) => {
    if (value === undefined) delete process.env.GATE_AUTOPAY_HOLD_TIMEOUT;
    else process.env.GATE_AUTOPAY_HOLD_TIMEOUT = value;
    expect(jest.requireActual('../config/feature-gates').autopayHoldTimeoutMode()).toBe(expected);
  });

  test('gate off returns before any query', async () => {
    delete process.env.GATE_AUTOPAY_HOLD_TIMEOUT;
    const db = require('../models/db');
    db.mockClear();
    db.mockImplementation(() => { throw new Error('no query expected'); });
    const { releaseStaleAutopayHolds } = jest.requireActual('../services/invoice-followups');
    await expect(releaseStaleAutopayHolds()).resolves.toMatchObject({ mode: 'off', candidates: 0 });
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
  });
});
