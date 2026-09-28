/**
 * Real PostgreSQL verification of the atomic INSERT-only import write —
 * genuine Postgres concurrency semantics a mocked knex cannot honestly
 * reproduce: a real UNIQUE constraint racing two connections, and the
 * write itself being unable to touch a pre-existing row. Run with
 * RECONCILE_TEST_DATABASE_URL pointing to a disposable local, managed
 * worktree QA, or isolated CI database. Every fixture rolls back (except
 * the genuine-concurrency case, which commits on a scratch email and
 * cleans up explicitly, since two real connections can't share one
 * uncommitted transaction).
 */
jest.setTimeout(30000);
const { randomUUID } = require('crypto');
const knexFactory = require('knex');

const connection = process.env.RECONCILE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

// Pauses the Nth query against one table, AFTER Postgres has already
// returned it, until the caller explicitly releases it — a deterministic
// rendezvous point, not a timing guess. `notification_prefs` is read twice
// per candidate (the batch classification pass, then the write-time
// recheck); pausing occurrence 2 traps exactly the read immediately before
// the reconcile's own INSERT, so a race inserted between `reached` and
// `release()` is guaranteed to land in that exact gap. Same technique as
// reschedule-link-promises-postgres.test.js's pauseFirstTableRead,
// generalized to the Nth occurrence.
function pauseNthTableRead(base, table, n) {
  let count = 0;
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const released = new Promise((resolve) => { releaseResolve = resolve; });
  const wrapped = (name, ...args) => {
    const qb = base(name, ...args);
    if (name !== table) return qb;
    count += 1;
    const mine = count === n;
    if (!mine) return qb;
    const originalThen = qb.then.bind(qb);
    qb.then = (onFulfilled, onRejected) => originalThen(async (result) => {
      reachedResolve();
      await released;
      return result;
    }).then(onFulfilled, onRejected);
    return qb;
  };
  wrapped.transaction = (...args) => base.transaction(...args);
  wrapped.raw = (...args) => base.raw(...args);
  wrapped.fn = base.fn;
  return { conn: wrapped, reached, release: releaseResolve };
}

const POOL = { min: 0, max: 8 };

postgres('newsletter-list-reconcile — real Postgres', () => {
  let db;
  const { reconcileCustomers } = require('../services/newsletter-list-reconcile');

  beforeAll(async () => {
    db = knexFactory({ client: 'pg', connection, pool: POOL });
    // The migration-seeded demo customer (20260401000077_virginia_demo_customer)
    // is a genuine candidate under this reconcile's own rules in ANY freshly
    // migrated database. Give her a pre-existing active row ONCE so she never
    // competes with this file's own synthetic candidates — real Postgres
    // rules, not a mocked table, so the fixture itself must be excluded
    // the same way a real duplicate would be.
    await db('newsletter_subscribers')
      .insert({ email: 'virginia@wavespestcontrol.com', status: 'active', source: 'test_fixture_exclusion' })
      .onConflict('email')
      .ignore();
  });
  afterAll(async () => { await db.destroy(); });

  async function rollbackTest(fn) {
    const trx = await db.transaction();
    try { await fn(trx); } finally { await trx.rollback(); }
  }

  function synthCustomer(overrides = {}) {
    return {
      id: randomUUID(),
      first_name: 'Synthetic',
      last_name: 'Reconcile',
      email: `synth-${randomUUID().slice(0, 8)}@example.invalid`,
      phone: `+1555${String(Math.floor(1000000 + Math.random() * 8999999))}`,
      city: 'Venice',
      active: true,
      pipeline_stage: 'active_customer',
      deleted_at: null,
      ...overrides,
    };
  }

  async function seedLiveConsentingCustomer(trx) {
    const cust = synthCustomer();
    await trx('customers').insert(cust);
    await trx('notification_prefs').insert({ customer_id: cust.id, marketing_offers: true, email_enabled: true });
    return cust;
  }

  test('a row that appears for the same email AFTER this reconcile\'s own recheck (but before its write) is left byte-for-byte unchanged, and counted as row_appeared', () => rollbackTest(async (trx) => {
    const cust = await seedLiveConsentingCustomer(trx);
    const lc = cust.email.toLowerCase();

    // notification_prefs read #2 is the LAST read the write-time recheck
    // performs before the INSERT. Pause it there, insert the conflicting
    // row from a genuinely separate connection, then release — the INSERT
    // is guaranteed to run strictly after that commit.
    const { conn: paused, reached, release } = pauseNthTableRead(trx, 'notification_prefs', 2);
    const reconcilePromise = reconcileCustomers({ dryRun: false, conn: paused });
    const other = knexFactory({ client: 'pg', connection, pool: POOL });
    try {
      await reached;
      await other('newsletter_subscribers').insert({ email: lc, status: 'unsubscribed', source: 'public_form' });
      release();
      const result = await reconcilePromise;

      expect(result.imported).toBe(0);
      expect(result.excluded.row_appeared).toBe(1);

      const row = await trx('newsletter_subscribers').where({ email: lc }).first();
      expect(row.status).toBe('unsubscribed');
      expect(row.source).toBe('public_form');
      expect(row.first_name).toBeNull(); // none of the import's values landed
      expect(row.confirmed_at).toBeNull();
    } finally {
      await other.destroy();
      // Clean up the OTHER connection's committed row (outside this trx).
      await db('newsletter_subscribers').where({ email: lc }).del();
    }
  }));

  test('two concurrent imports of the same customer produce exactly one row', async () => {
    const cust = synthCustomer();
    const lc = cust.email.toLowerCase();
    await db('customers').insert(cust);
    await db('notification_prefs').insert({ customer_id: cust.id, marketing_offers: true, email_enabled: true });
    try {
      const connA = knexFactory({ client: 'pg', connection, pool: POOL });
      const connB = knexFactory({ client: 'pg', connection, pool: POOL });
      try {
        const [resultA, resultB] = await Promise.all([
          reconcileCustomers({ dryRun: false, conn: connA }),
          reconcileCustomers({ dryRun: false, conn: connB }),
        ]);
        const imported = resultA.imported + resultB.imported;
        const rowAppeared = resultA.excluded.row_appeared + resultB.excluded.row_appeared;
        expect(imported).toBe(1); // exactly one of the two actually inserted
        expect(rowAppeared).toBe(1); // the other found the real UNIQUE constraint had already won
        const rows = await db('newsletter_subscribers').where({ email: lc });
        expect(rows).toHaveLength(1);
      } finally {
        await connA.destroy();
        await connB.destroy();
      }
    } finally {
      await db('newsletter_subscribers').where({ email: lc }).del();
      await db('notification_prefs').where({ customer_id: cust.id }).del();
      await db('customers').where({ id: cust.id }).del();
    }
  });

  test.each([
    ['at_risk', true], // canonical CUSTOMER_STAGES member — a candidate
    [null, false], // NULL pipeline_stage is no longer a candidate (owner ruling 2026-09-28)
    ['new_lead', false],
  ])('pipeline_stage %s -> candidate: %s (real Postgres, canonical whereLiveCustomer/CUSTOMER_STAGES)', (stage, expected) => rollbackTest(async (trx) => {
    const cust = synthCustomer({ pipeline_stage: stage });
    await trx('customers').insert(cust);
    await trx('notification_prefs').insert({ customer_id: cust.id, marketing_offers: true, email_enabled: true });
    const result = await reconcileCustomers({ conn: trx });
    // Virginia (the seeded demo customer) already has an active subscriber
    // row from beforeAll, so the only possible candidate in this rolled-back
    // transaction is this test's own synthetic customer.
    expect(result.candidates).toBe(expected ? 1 : 0);
  }));

  test('an imported customer is not enrolled in any automation and no email is sent', () => rollbackTest(async (trx) => {
    const cust = await seedLiveConsentingCustomer(trx);
    const lc = cust.email.toLowerCase();

    const result = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(result.imported).toBe(1);

    const row = await trx('newsletter_subscribers').where({ email: lc }).first();
    expect(row.status).toBe('active');
    expect(row.quote_lead_automation_pending).toBe(false); // never enrolled — column default, never set by this write
    expect(row.confirmation_sent_at).toBeNull(); // no double-opt-in email queued

    const sent = await trx('email_messages').whereRaw('LOWER(recipient_email_snapshot) = ?', [lc]);
    expect(sent).toHaveLength(0); // no email_messages row for this address
  }));
});
