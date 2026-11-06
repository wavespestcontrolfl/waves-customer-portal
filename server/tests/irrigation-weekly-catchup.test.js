/**
 * Monday catch-up for the irrigation weekly email sweep (GATE_WATERING_CATCHUP).
 * job_health.last_success_at says whether this ET week's sweep finished; the
 * catch-up runs the same sweep only when it did not, re-checks under the lock
 * (a failed read there throws, so the run is never recorded as done), and asks
 * the sweep to skip customers already sent before any weather call. Fakes only:
 * no network, no database.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/irrigation-weekly-email', () => ({
  runWeeklyIrrigationEmailSweep: jest.fn(async () => ({ shadow: false, sent: 2 })),
}));

const { runWeeklyIrrigationEmailSweep } = require('../services/irrigation-weekly-email');
const {
  JOB_NAME, readSweepWeekMissing, sweepWeekIsMissing, runWeeklyIrrigationEmailCatchUp,
} = require('../services/irrigation-weekly-catchup');

// Monday 2026-11-09 (EST): 7:00 tick = 12:00Z, 9:01 catch-up = 14:01Z.
const MONDAY_CATCH_UP = new Date('2026-11-09T14:01:00Z');
const THIS_MONDAY_7AM = new Date('2026-11-09T12:00:00Z');
const LAST_MONDAY_7AM = new Date('2026-11-02T12:40:00Z');

function fakeDb({ lastSuccessAt = null, error = null } = {}) {
  const calls = [];
  const db = (table) => ({
    where(criteria) {
      calls.push([table, criteria]);
      return {
        first: async () => {
          if (error) throw new Error(error);
          return lastSuccessAt ? { last_success_at: lastSuccessAt } : undefined;
        },
      };
    },
  });
  return { db, calls };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('readSweepWeekMissing / sweepWeekIsMissing', () => {
  test('reads the 7:00 tick\'s own job_health row', async () => {
    const { db, calls } = fakeDb({});
    await readSweepWeekMissing({ now: MONDAY_CATCH_UP, db });
    expect(JOB_NAME).toBe('irrigation-weekly-email');
    expect(calls).toEqual([['job_health', { job_name: 'irrigation-weekly-email' }]]);
  });

  test('no row, or last success in an earlier week: missing', async () => {
    await expect(sweepWeekIsMissing({ now: MONDAY_CATCH_UP, db: fakeDb({}).db })).resolves.toBe(true);
    await expect(sweepWeekIsMissing({ now: MONDAY_CATCH_UP, db: fakeDb({ lastSuccessAt: LAST_MONDAY_7AM }).db })).resolves.toBe(true);
  });

  test('a run that finished this ET week (from Monday 00:00 ET): not missing', async () => {
    await expect(sweepWeekIsMissing({ now: MONDAY_CATCH_UP, db: fakeDb({ lastSuccessAt: THIS_MONDAY_7AM }).db })).resolves.toBe(false);
    // Monday 00:05 ET = 05:05Z counts as this week; Sunday 23:55 ET does not.
    await expect(sweepWeekIsMissing({ now: MONDAY_CATCH_UP, db: fakeDb({ lastSuccessAt: '2026-11-09T05:05:00Z' }).db })).resolves.toBe(false);
    await expect(sweepWeekIsMissing({ now: MONDAY_CATCH_UP, db: fakeDb({ lastSuccessAt: '2026-11-09T04:55:00Z' }).db })).resolves.toBe(true);
  });

  test('pre-lock read failure answers skip; the under-lock form throws', async () => {
    const { db } = fakeDb({ error: 'connection reset' });
    await expect(sweepWeekIsMissing({ now: MONDAY_CATCH_UP, db })).resolves.toBe(false);
    await expect(readSweepWeekMissing({ now: MONDAY_CATCH_UP, db })).rejects.toThrow('connection reset');
  });
});

describe('runWeeklyIrrigationEmailCatchUp', () => {
  test('this week finished: the sweep does not run', async () => {
    const { db } = fakeDb({ lastSuccessAt: THIS_MONDAY_7AM });
    await expect(runWeeklyIrrigationEmailCatchUp({ now: MONDAY_CATCH_UP, db })).resolves.toEqual({ skipped: 'already_ran' });
    expect(runWeeklyIrrigationEmailSweep).not.toHaveBeenCalled();
  });

  test('this week missing: runs the sweep on the live clock, skipping customers already sent before any weather call', async () => {
    const { db } = fakeDb({ lastSuccessAt: LAST_MONDAY_7AM });
    await expect(runWeeklyIrrigationEmailCatchUp({ now: MONDAY_CATCH_UP, db })).resolves.toEqual({ shadow: false, sent: 2 });
    expect(runWeeklyIrrigationEmailSweep).toHaveBeenCalledTimes(1);
    // No `now` or `clock`: the sweep re-reads the wall clock per customer, so its noon
    // plan cutoff (PLAN_WINDOW_END_HOUR_ET) applies to catch-up customers unchanged.
    expect(runWeeklyIrrigationEmailSweep).toHaveBeenCalledWith({ skipDeliveredBeforeFetch: true });
  });

  test('an unreadable job_health under the lock rejects, so runExclusive records a failed run', async () => {
    const { db } = fakeDb({ error: 'timeout' });
    await expect(runWeeklyIrrigationEmailCatchUp({ now: MONDAY_CATCH_UP, db })).rejects.toThrow('timeout');
    expect(runWeeklyIrrigationEmailSweep).not.toHaveBeenCalled();
  });
});
