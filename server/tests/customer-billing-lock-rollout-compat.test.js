/**
 * Rollout-compatibility layer of utils/customer-billing-lock.js
 * (ADMIN-BUG-R11, Codex round-1 P1, tightened round-2 P1): during a
 * rolling deploy, an OLD pod's retry sweep or monthly cron has no idea the
 * per-customer `billing-customer:<id>` lock exists. A one-time snapshot of
 * "is that job running right now?" cannot close the race (the old pod's
 * job can start in the gap between the snapshot and the actual charge),
 * so this layer HOLDS a pg_try_advisory_lock_shared on each non-excluded
 * job's key for the customer op's WHOLE duration, on the SAME session
 * already holding the customer's exclusive lock — see
 * customer-billing-lock-rollout-race-postgres.test.js for the live,
 * real-Postgres proof that this actually blocks/is blocked by an old
 * pod's own unmodified pg_try_advisory_lock. This file exercises the
 * orchestration logic in isolation with a mocked connection.
 */
jest.mock('../models/db', () => ({
  // Just enough shape for crossProcessLockCapable() to see a "real pool".
  client: { acquireConnection: jest.fn(), releaseConnection: jest.fn() },
}));

let mockConn;
jest.mock('../utils/cron-lock', () => ({
  // Mirrors runExclusiveLocked's own contract closely enough for this
  // unit: call fn() and return/propagate what it does, with no connection
  // pinning, slot semantics, or health recording (recordHealth: false in
  // production).
  runExclusive: jest.fn(async (_name, fn) => fn()),
  getHeldConnection: jest.fn(() => mockConn),
}));

const { withCustomerBillingLock } = require('../utils/customer-billing-lock');
const { runExclusive, getHeldConnection } = require('../utils/cron-lock');

// A fake connection whose pg_try_advisory_lock_shared reports `false` for
// every key in `deniedKeys` and `true` otherwise, recording every call.
function makeConn(deniedKeys = []) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async ({ text, values }) => {
      calls.push([text, values]);
      if (text.includes('pg_try_advisory_lock_shared')) {
        return { rows: [{ locked: !deniedKeys.includes(values[0]) }] };
      }
      return { rows: [{ locked: true }] };
    }),
  };
}

describe('withCustomerBillingLock — rollout-compatibility (held shared job-lock)', () => {
  beforeEach(() => {
    runExclusive.mockClear();
    getHeldConnection.mockClear();
  });

  test('refuses when a named job lock (not excluded) is currently held exclusively elsewhere', async () => {
    mockConn = makeConn(['cron:billing-retries']);
    await expect(withCustomerBillingLock('cust-x', async () => 'ran'))
      .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
  });

  test('a caller excluding its OWN job lock still runs even while that job would report held (it holds it exclusively itself)', async () => {
    mockConn = makeConn(['cron:billing-retries']);
    const result = await withCustomerBillingLock('cust-x2', async () => 'ran', { excludeJobLocks: ['billing-retries'] });
    expect(result).toBe('ran');
  });

  test('a caller excluding its own job lock still refuses when the OTHER job is held', async () => {
    mockConn = makeConn(['cron:billing-monthly']);
    await expect(withCustomerBillingLock('cust-x3', async () => 'ran', { excludeJobLocks: ['billing-retries'] }))
      .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
  });

  test('runs normally, and releases every shared lock it took, when no job lock is held', async () => {
    mockConn = makeConn([]);
    const result = await withCustomerBillingLock('cust-y', async () => 'ok');
    expect(result).toBe('ok');
    const locks = mockConn.calls.filter(([t]) => t.includes('pg_try_advisory_lock_shared'));
    const unlocks = mockConn.calls.filter(([t]) => t.includes('pg_advisory_unlock_shared'));
    expect(locks.map((c) => c[1][0]).sort()).toEqual(['cron:billing-monthly', 'cron:billing-retries']);
    expect(unlocks.map((c) => c[1][0]).sort()).toEqual(['cron:billing-monthly', 'cron:billing-retries']);
  });

  test('releases only the lock it actually acquired when a later one in the list fails', async () => {
    mockConn = makeConn(['cron:billing-retries']);
    await expect(withCustomerBillingLock('cust-z', async () => 'nope')).rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
    // billing-monthly is tried first (ROLLOUT_COMPAT_JOB_LOCKS order),
    // succeeds, and must still be released even though billing-retries
    // then failed and was never held.
    const unlocks = mockConn.calls.filter(([t]) => t.includes('pg_advisory_unlock_shared'));
    expect(unlocks).toHaveLength(1);
    expect(unlocks[0][1]).toEqual(['cron:billing-monthly']);
  });
});
