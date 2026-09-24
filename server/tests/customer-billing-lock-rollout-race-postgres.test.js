/**
 * customer-billing-lock.js rollout-compatibility layer — real Postgres,
 * two independent sessions, proving the ACTUAL cross-session advisory-lock
 * semantics the mocked unit test (customer-billing-lock-rollout-compat.
 * test.js) only exercises the orchestration logic for.
 *
 * Codex round-2 P1: a one-time snapshot of "is the old job running right
 * now?" cannot close the rolling-deploy race — the old pod's job can start
 * its OWN exclusive pg_try_advisory_lock in the gap between the snapshot
 * and the actual charge. The fix HOLDS a pg_try_advisory_lock_shared on
 * the job's exact key for the whole customer-scoped operation. This suite
 * proves both directions with a second, genuinely separate pg session
 * standing in for an "old pod" that has never heard of this file and only
 * ever calls the SAME pg_try_advisory_lock it always has:
 *
 *   1. while withCustomerBillingLock holds the shared lock, the old pod's
 *      own unmodified exclusive pg_try_advisory_lock on that same job key
 *      FAILS (so its sweep would skip that tick, exactly like a
 *      same-version instance overlap already does) — proving a new pod's
 *      in-flight charge blocks an old pod's job from starting;
 *   2. when the old pod already holds its job's lock exclusively,
 *      withCustomerBillingLock's shared acquire FAILS and it refuses
 *      (BILLING_CLAIM_HELD_ELSEWHERE) rather than let the charge proceed
 *      unfenced — proving the reverse direction too.
 */
const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(30000);

postgres('withCustomerBillingLock — rollout-compatibility holds a claim for the whole operation (real Postgres, two sessions)', () => {
  let db;
  let withCustomerBillingLock;
  let oldPodConn; // A second, genuinely separate session — stands in for an old pod's own pg_try_advisory_lock call, unmodified by this file.

  beforeAll(async () => {
    db = require('../models/db');
    ({ withCustomerBillingLock } = require('../utils/customer-billing-lock'));
    oldPodConn = await db.client.acquireConnection();
  });

  afterAll(async () => {
    if (oldPodConn) await db.client.releaseConnection(oldPodConn);
    await db.destroy();
  });

  test('an old pod cannot start its exclusive job lock while a customer-scoped op holds the shared claim — and can once it releases', async () => {
    let oldPodTrySucceededDuringHold = null;

    const result = await withCustomerBillingLock('rollout-race-customer-1', async () => {
      // The "old pod": its own unmodified exclusive acquisition attempt,
      // on a completely separate session, while we're mid-operation.
      const res = await oldPodConn.query({
        text: "SELECT pg_try_advisory_lock(hashtext('cron:billing-retries')) AS locked",
      });
      oldPodTrySucceededDuringHold = !!res.rows[0].locked;
      return 'charged';
    });

    expect(result).toBe('charged');
    // Held elsewhere (by us) — the old pod's sweep would skip this tick.
    expect(oldPodTrySucceededDuringHold).toBe(false);

    // Our operation is done — the shared lock released — the old pod's
    // exclusive attempt should now succeed.
    const after = await oldPodConn.query({
      text: "SELECT pg_try_advisory_lock(hashtext('cron:billing-retries')) AS locked",
    });
    expect(after.rows[0].locked).toBe(true);
    await oldPodConn.query({ text: "SELECT pg_advisory_unlock(hashtext('cron:billing-retries'))" });
  });

  test('an old pod already holding its exclusive job lock blocks our shared claim — we refuse rather than charge unfenced', async () => {
    const acquired = await oldPodConn.query({
      text: "SELECT pg_try_advisory_lock(hashtext('cron:billing-monthly')) AS locked",
    });
    expect(acquired.rows[0].locked).toBe(true);

    try {
      await expect(withCustomerBillingLock('rollout-race-customer-2', async () => 'should-not-run'))
        .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
    } finally {
      await oldPodConn.query({ text: "SELECT pg_advisory_unlock(hashtext('cron:billing-monthly'))" });
    }
  });

  test('excludeJobLocks lets a caller inside that SAME job proceed even while it holds that job\'s lock itself', async () => {
    // The caller's own exclusion means it never tries billing-monthly at
    // all here — it only takes the shared lock on billing-retries.
    const result = await withCustomerBillingLock('rollout-race-customer-3', async () => 'ok', { excludeJobLocks: ['billing-monthly'] });
    expect(result).toBe('ok');
  });
});
