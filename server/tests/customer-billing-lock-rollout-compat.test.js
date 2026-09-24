/**
 * Rollout-compatibility layer of utils/customer-billing-lock.js
 * (ADMIN-BUG-R11, Codex round-1 P1): during a rolling deploy, an OLD pod's
 * retry sweep or monthly cron has no idea the per-customer
 * `billing-customer:<id>` lock exists, so a NEW pod's charge-now taking
 * that lock alone would not see it. Both jobs, in every version of this
 * code, already run inside a NAMED job-level advisory lock
 * ('billing-monthly' / 'billing-retries', scheduler.js) for their whole
 * run — a signal visible regardless of which pod's code is checking.
 *
 * These tests mock cron-lock.js's lockHeldByAnySession directly (a live
 * two-process check on the per-customer runExclusive layer already exists
 * — see the PR body) to pin the job-lock decision deterministically.
 */
jest.mock('../models/db', () => ({})); // no .client -> not cross-process-lock-capable; isolates this test to the job-lock layer
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  lockHeldByAnySession: jest.fn(async () => false),
}));

const { withCustomerBillingLock } = require('../utils/customer-billing-lock');
const { lockHeldByAnySession } = require('../utils/cron-lock');

describe('withCustomerBillingLock — rollout-compatibility job-lock check', () => {
  beforeEach(() => {
    lockHeldByAnySession.mockReset();
  });

  test('refuses when a named job lock (not excluded) is held elsewhere', async () => {
    lockHeldByAnySession.mockImplementation(async (name) => name === 'billing-retries');
    await expect(withCustomerBillingLock('cust-x', async () => 'ran'))
      .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
  });

  test('a caller excluding its OWN job lock still runs even while that job is held (itself)', async () => {
    lockHeldByAnySession.mockImplementation(async (name) => name === 'billing-retries');
    const result = await withCustomerBillingLock('cust-x2', async () => 'ran', { excludeJobLocks: ['billing-retries'] });
    expect(result).toBe('ran');
  });

  test('a caller excluding its own job lock still refuses on the OTHER job being held', async () => {
    lockHeldByAnySession.mockImplementation(async (name) => name === 'billing-monthly');
    await expect(withCustomerBillingLock('cust-x3', async () => 'ran', { excludeJobLocks: ['billing-retries'] }))
      .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
  });

  test('runs normally when no job lock is held', async () => {
    lockHeldByAnySession.mockResolvedValue(false);
    const result = await withCustomerBillingLock('cust-y', async () => 'ok');
    expect(result).toBe('ok');
  });

  test('degrades to "not held" (runs normally) when the probe itself fails', async () => {
    lockHeldByAnySession.mockRejectedValue(new Error('pg_locks unreadable'));
    const result = await withCustomerBillingLock('cust-z', async () => 'ok-despite-probe-failure');
    expect(result).toBe('ok-despite-probe-failure');
  });
});
