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
 *
 * Codex round-2 PUSH review, a second P1: holding this compatibility lock
 * on 'billing-monthly' let a single in-flight customer op make the
 * scheduler's OWN 8 AM runExclusive('billing-monthly', ...) report
 * lease_held and skip processMonthlyBilling for its ENTIRE cohort, with
 * no recovery until next month (see the file header). Only
 * 'billing-retries' is held this way now — its own worst case if it's
 * ever the one contended is a bounded, self-healing one-day retry delay.
 * The last two tests below lock that asymmetry in.
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

  test('refuses when the billing-retries job lock (not excluded) is currently held exclusively elsewhere', async () => {
    mockConn = makeConn(['cron:billing-retries']);
    await expect(withCustomerBillingLock('cust-x', async () => 'ran'))
      .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
  });

  test('a caller excluding its OWN job lock still runs even while that job would report held (it holds it exclusively itself)', async () => {
    mockConn = makeConn(['cron:billing-retries']);
    const result = await withCustomerBillingLock('cust-x2', async () => 'ran', { excludeJobLocks: ['billing-retries'] });
    expect(result).toBe('ran');
  });

  test('runs normally, and releases the shared lock it took, when no job lock is held', async () => {
    mockConn = makeConn([]);
    const result = await withCustomerBillingLock('cust-y', async () => 'ok');
    expect(result).toBe('ok');
    const locks = mockConn.calls.filter(([t]) => t.includes('pg_try_advisory_lock_shared'));
    const unlocks = mockConn.calls.filter(([t]) => t.includes('pg_advisory_unlock_shared'));
    expect(locks.map((c) => c[1][0])).toEqual(['cron:billing-retries']);
    expect(unlocks.map((c) => c[1][0])).toEqual(['cron:billing-retries']);
  });

  test('never takes or checks a lock on billing-monthly — a customer op must not be able to suppress the scheduler\'s own monthly cohort tick', async () => {
    // billing-monthly reports as held elsewhere; if this layer checked it
    // at all, the operation would refuse. It must not even try.
    mockConn = makeConn(['cron:billing-monthly']);
    const result = await withCustomerBillingLock('cust-w', async () => 'ok');
    expect(result).toBe('ok');
    const keysTried = mockConn.calls
      .filter(([t]) => t.includes('pg_try_advisory_lock_shared'))
      .map((c) => c[1][0]);
    expect(keysTried).not.toContain('cron:billing-monthly');
  });

  // Codex round-3 P1: a raw DB error from the lock INFRASTRUCTURE before
  // fn() starts must become the same BILLING_CLAIM_HELD_ELSEWHERE refusal a
  // confirmed holder produces — every caller maps that to "defer, no charge
  // attempted", whereas a raw error falls into their charge-failure ladder
  // (retry_count bumped, service possibly paused) though Stripe was never
  // called. fn()'s OWN rejection must still propagate unchanged.
  test('a throw from the rollout-compat shared-lock query (before fn runs) surfaces as BILLING_CLAIM_HELD_ELSEWHERE, not a raw DB error', async () => {
    mockConn = makeConn([]);
    const dbBlip = new Error('connection terminated unexpectedly');
    mockConn.query.mockImplementationOnce(async () => { throw dbBlip; });
    const fn = jest.fn(async () => 'ran');
    await expect(withCustomerBillingLock('cust-t', fn))
      .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE', cause: dbBlip });
    expect(fn).not.toHaveBeenCalled();
  });

  test('a throw from the customer advisory-lock acquisition (runExclusive rejects before fn) surfaces as BILLING_CLAIM_HELD_ELSEWHERE', async () => {
    mockConn = makeConn([]);
    const tryLockBlip = new Error('could not serialize access');
    runExclusive.mockImplementationOnce(async () => { throw tryLockBlip; });
    const fn = jest.fn(async () => 'ran');
    await expect(withCustomerBillingLock('cust-u', fn))
      .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE', cause: tryLockBlip });
    expect(fn).not.toHaveBeenCalled();
  });

  test('fn()\'s own rejection still propagates unchanged (never disguised as contention)', async () => {
    mockConn = makeConn([]);
    const declined = Object.assign(new Error('card_declined'), { code: 'STRIPE_DECLINED' });
    await expect(withCustomerBillingLock('cust-z', async () => { throw declined; }))
      .rejects.toBe(declined);
  });

  test('excluding billing-retries when it is the only compatibility lock means no job lock is taken at all', async () => {
    mockConn = makeConn(['cron:billing-retries']);
    const result = await withCustomerBillingLock('cust-v', async () => 'ok', { excludeJobLocks: ['billing-retries'] });
    expect(result).toBe('ok');
    const locks = mockConn.calls.filter(([t]) => t.includes('pg_try_advisory_lock_shared'));
    expect(locks).toHaveLength(0);
  });
});
