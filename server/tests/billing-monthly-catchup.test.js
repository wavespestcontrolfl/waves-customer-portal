/**
 * Monthly billing catch-up (services/billing-monthly-catchup.js, GATE_BILLING_MONTHLY_CATCHUP,
 * owner 2026-11-06 O1 "bill each missed day of this month").
 *
 * The 8:00 AM ET dues run bills only today's billing_day cohort, so a lost or killed run left
 * that cohort uncharged until next month. These tests pin which dates the catch-up bills (each
 * missed ET date of this month after the bookmark, oldest first, never an earlier month), the
 * bookmark the 8:00 run and the catch-up keep, and the honest-failure rule: a failed read
 * before the lock skips, a failed read under the lock rejects with nothing billed.
 *
 * BillingCron.processMonthlyBilling is faked here; who a date's run charges, skips or leaves
 * alone is billing-cron-monthly-catchup.test.js.
 */
let mockBookmarkRow = null;
let mockReadError = null;
let mockWriteError = null;
let mockWrites = [];

jest.mock('../models/db', () => jest.fn((table) => {
  if (table !== 'ops_email_send_state') throw new Error(`unexpected table ${table}`);
  const b = {};
  b.where = () => b;
  b.first = () => (mockReadError ? Promise.reject(mockReadError) : Promise.resolve(mockBookmarkRow));
  b.insert = (row) => ({
    onConflict: () => ({
      merge: () => {
        if (mockWriteError) return Promise.reject(mockWriteError);
        mockWrites.push(row);
        return Promise.resolve();
      },
    }),
  });
  return b;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ billingMonthlyCatchupLive: jest.fn(() => false) }));
jest.mock('../services/billing-cron', () => ({ processMonthlyBilling: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { billingMonthlyCatchupLive } = require('../config/feature-gates');
const BillingCron = require('../services/billing-cron');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const catchUp = require('../services/billing-monthly-catchup');

const { missedBillingDates, BOOKMARK_KEY } = catchUp._private;

// Fixed clock: Thursday 2026-11-12, 10:29 AM ET. Only Date is faked.
const setNow = (iso) => jest.setSystemTime(new Date(iso));
const bookmarkAt = (ymd) => ({ last_sent_at: parseETDateTime(`${ymd}T12:00`) });
const writtenDates = () => mockWrites.map((w) => etDateString(w.last_sent_at));
const billedDates = () => BillingCron.processMonthlyBilling.mock.calls.map(([arg]) => (arg ? arg.billingDate : 'today'));

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  setNow('2026-11-12T15:29:00Z');
  mockBookmarkRow = null;
  mockReadError = null;
  mockWriteError = null;
  mockWrites = [];
  billingMonthlyCatchupLive.mockReturnValue(true);
  BillingCron.processMonthlyBilling.mockImplementation(async ({ billingDate } = {}) => ({
    charged: 1, processing: 0, failed: 0, skipped: 2, total: 3, billingDate: billingDate || etDateString(),
  }));
});

describe('missedBillingDates', () => {
  test('each date after the bookmark through today, oldest first', () => {
    expect(missedBillingDates('2026-11-10', '2026-11-12')).toEqual(['2026-11-11', '2026-11-12']);
    expect(missedBillingDates('2026-11-11', '2026-11-12')).toEqual(['2026-11-12']);
  });

  test('nothing owed: no bookmark, or a bookmark at or after today', () => {
    expect(missedBillingDates(null, '2026-11-12')).toEqual([]);
    expect(missedBillingDates('2026-11-12', '2026-11-12')).toEqual([]);
    expect(missedBillingDates('2026-11-13', '2026-11-12')).toEqual([]);
  });

  test('month boundary: only this month\'s dates, never an earlier month\'s cohort', () => {
    expect(missedBillingDates('2026-10-30', '2026-11-02')).toEqual(['2026-11-01', '2026-11-02']);
    expect(missedBillingDates('2026-09-15', '2026-11-01')).toEqual(['2026-11-01']);
  });

  test('crosses the November DST change one calendar day at a time', () => {
    expect(missedBillingDates('2026-11-01', '2026-11-03')).toEqual(['2026-11-02', '2026-11-03']);
  });
});

describe('catch-up tick, gate off', () => {
  beforeEach(() => billingMonthlyCatchupLive.mockReturnValue(false));

  test('nothing at all: no read, no billing, no write', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-10');
    expect(await catchUp.catchUpNeeded()).toBe(false);
    expect(await catchUp.runMonthlyBillingCatchUp()).toEqual({ skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(BillingCron.processMonthlyBilling).not.toHaveBeenCalled();
  });
});

describe('catch-up tick, gate on', () => {
  test('no bookmark yet (first days after deploy): no backfill', async () => {
    expect(await catchUp.catchUpNeeded()).toBe(false);
    expect(await catchUp.runMonthlyBillingCatchUp()).toEqual({ skipped: 'nothing_owed' });
    expect(BillingCron.processMonthlyBilling).not.toHaveBeenCalled();
    expect(mockWrites).toEqual([]);
  });

  test('today\'s 8:00 run finished: nothing owed', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-12');
    expect(await catchUp.catchUpNeeded()).toBe(false);
    expect(await catchUp.runMonthlyBillingCatchUp()).toEqual({ skipped: 'nothing_owed' });
    expect(BillingCron.processMonthlyBilling).not.toHaveBeenCalled();
  });

  test('one missed day (today\'s 8:00 run lost): that cohort billed once, then the bookmark moves', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-11');
    expect(await catchUp.catchUpNeeded()).toBe(true);
    const out = await catchUp.runMonthlyBillingCatchUp();
    expect(billedDates()).toEqual(['2026-11-12']);
    expect(writtenDates()).toEqual(['2026-11-12']);
    expect(mockWrites[0].email_key).toBe(BOOKMARK_KEY);
    expect(out.runs).toHaveLength(1);
  });

  test('two missed days: each cohort billed once, oldest first, bookmark after each', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-10');
    await catchUp.runMonthlyBillingCatchUp();
    expect(billedDates()).toEqual(['2026-11-11', '2026-11-12']);
    expect(writtenDates()).toEqual(['2026-11-11', '2026-11-12']);
  });

  test('month boundary: an October bookmark bills only November\'s missed dates', async () => {
    setNow('2026-11-02T15:29:00Z');
    mockBookmarkRow = bookmarkAt('2026-10-30');
    await catchUp.runMonthlyBillingCatchUp();
    expect(billedDates()).toEqual(['2026-11-01', '2026-11-02']);
  });

  test('a date whose run throws: the run rejects, the bookmark stays on the last finished date', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-10');
    BillingCron.processMonthlyBilling
      .mockImplementationOnce(async ({ billingDate }) => ({ charged: 0, processing: 0, failed: 0, skipped: 0, total: 0, billingDate }))
      .mockRejectedValueOnce(new Error('cohort read failed'));
    await expect(catchUp.runMonthlyBillingCatchUp()).rejects.toThrow('cohort read failed');
    expect(writtenDates()).toEqual(['2026-11-11']);
  });

  test('a failed bookmark read under the lock rejects: nothing billed, nothing written', async () => {
    mockReadError = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    await expect(catchUp.runMonthlyBillingCatchUp()).rejects.toThrow('connection terminated');
    expect(BillingCron.processMonthlyBilling).not.toHaveBeenCalled();
    expect(mockWrites).toEqual([]);
  });

  test('a failed bookmark read before the lock answers "skip"', async () => {
    mockReadError = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    expect(await catchUp.catchUpNeeded()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bookmark read failed (ECONNRESET) — skipping this catch-up tick'));
  });

  test('a failed bookmark write only logs: the billing result still returns', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-11');
    mockWriteError = Object.assign(new Error('write failed'), { code: '57P01' });
    const out = await catchUp.runMonthlyBillingCatchUp();
    expect(out.runs).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bookmark write for 2026-11-12 failed (57P01)'));
  });
});

describe('8:00 tick (runMonthlyBillingTick)', () => {
  test('gate off: today\'s run unchanged (no argument), then the bookmark moves to today with no read', async () => {
    billingMonthlyCatchupLive.mockReturnValue(false);
    setNow('2026-11-12T13:00:00Z');
    mockReadError = new Error('a read must not happen');
    const out = await catchUp.runMonthlyBillingTick();
    expect(BillingCron.processMonthlyBilling).toHaveBeenCalledWith();
    expect(out).toMatchObject({ charged: 1, billingDate: '2026-11-12' });
    expect(writtenDates()).toEqual(['2026-11-12']);
  });

  test('gate on, nothing earlier owed: bookmark moves to today', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-11');
    await catchUp.runMonthlyBillingTick();
    expect(billedDates()).toEqual(['today']);
    expect(writtenDates()).toEqual(['2026-11-12']);
  });

  test('gate on, no bookmark yet: bookmark starts at today', async () => {
    await catchUp.runMonthlyBillingTick();
    expect(writtenDates()).toEqual(['2026-11-12']);
  });

  test('gate on, an earlier date still owed: the 8:00 run bills only today and leaves the bookmark for the catch-up', async () => {
    mockBookmarkRow = bookmarkAt('2026-11-10');
    const out = await catchUp.runMonthlyBillingTick();
    expect(billedDates()).toEqual(['today']);
    expect(mockWrites).toEqual([]);
    expect(out.owedBefore).toEqual(['2026-11-11']);
  });

  test('gate on, a failed bookmark read after the run: result returned, bookmark left as it is', async () => {
    mockReadError = new Error('connection terminated');
    const out = await catchUp.runMonthlyBillingTick();
    expect(out).toMatchObject({ charged: 1 });
    expect(mockWrites).toEqual([]);
  });

  test('a run that throws moves no bookmark', async () => {
    BillingCron.processMonthlyBilling.mockRejectedValueOnce(new Error('cohort read failed'));
    await expect(catchUp.runMonthlyBillingTick()).rejects.toThrow('cohort read failed');
    expect(mockWrites).toEqual([]);
  });
});
