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
// rendezvous point, not a timing guess. For ONE candidate, notification_prefs
// is read THREE times: #1 the batch classification pass (before the write
// phase even opens a transaction), #2 importOneCustomer's own FOR SHARE
// (right after taking both locks), #3 classifyCustomer's write-time
// re-check — the LAST read before the INSERT. Pausing #2 traps the moment
// right after the lock is taken; pausing #3 traps the moment right before
// the write, so a race landed between `reached` and `release()` is
// guaranteed to fall in that exact gap. Same technique as
// reschedule-link-promises-postgres.test.js's pauseFirstTableRead,
// generalized to the Nth occurrence.
//
// The wrap is RECURSIVE through `.transaction()`: importOneCustomer opens
// its own per-row transaction on the connection it's given, so a table
// call made on the trx a nested `.transaction()` callback receives must be
// counted too — an unwrapped inner trx would make every pause here silently
// count nothing and never fire, since ALL of importOneCustomer's reads run
// inside that nested transaction, never directly on `base`.
function pauseNthTableRead(base, table, n) {
  let count = 0;
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const released = new Promise((resolve) => { releaseResolve = resolve; });
  function wrapConn(conn) {
    const wrapped = (name, ...args) => {
      const qb = conn(name, ...args);
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
    wrapped.transaction = (cb, ...args) => conn.transaction((trx) => cb(wrapConn(trx)), ...args);
    wrapped.raw = (...args) => conn.raw(...args);
    wrapped.fn = conn.fn;
    return wrapped;
  }
  return { conn: wrapConn(base), reached, release: releaseResolve };
}

const POOL = { min: 0, max: 8 };

postgres('newsletter-list-reconcile — real Postgres', () => {
  let db;
  const { reconcileCustomers } = require('../services/newsletter-list-reconcile');

  // Only set when THIS run's insert actually created the row (a fresh
  // migrated database with no fixture yet) — never torn down when it
  // already existed (e.g. a shared/reused QA database, or a second suite
  // run against the same connection), since that row wasn't this run's to
  // delete.
  let virginiaRowCreatedByThisRun = false;

  beforeAll(async () => {
    db = knexFactory({ client: 'pg', connection, pool: POOL });
    // The migration-seeded demo customer (20260401000077_virginia_demo_customer)
    // is a genuine candidate under this reconcile's own rules in ANY freshly
    // migrated database. Give her a pre-existing active row ONCE so she never
    // competes with this file's own synthetic candidates — real Postgres
    // rules, not a mocked table, so the fixture itself must be excluded
    // the same way a real duplicate would be.
    const inserted = await db('newsletter_subscribers')
      .insert({ email: 'virginia@wavespestcontrol.com', status: 'active', source: 'test_fixture_exclusion' })
      .onConflict('email')
      .ignore()
      .returning('id');
    virginiaRowCreatedByThisRun = inserted.length > 0;
  });
  afterAll(async () => {
    if (virginiaRowCreatedByThisRun) {
      await db('newsletter_subscribers')
        .where({ email: 'virginia@wavespestcontrol.com', source: 'test_fixture_exclusion' })
        .del();
    }
    await db.destroy();
  });

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

    // notification_prefs is read THREE times total for this one candidate:
    // #1 the batch classification pass, #2 importOneCustomer's own FOR
    // SHARE (right after taking both locks), #3 classifyCustomer's
    // write-time re-check — the LAST read before the INSERT. Pause #3,
    // insert the conflicting row from a genuinely separate connection, then
    // release — the INSERT is guaranteed to run strictly after that commit.
    const { conn: paused, reached, release } = pauseNthTableRead(trx, 'notification_prefs', 3);
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

  test('two concurrent imports of the same customer produce exactly one row — proven as a genuine mutual-exclusion block on the shared customer-comms lock, not a lucky UNIQUE-constraint race', async () => {
    const cust = synthCustomer();
    const lc = cust.email.toLowerCase();
    await db('customers').insert(cust);
    await db('notification_prefs').insert({ customer_id: cust.id, marketing_offers: true, email_enabled: true });
    try {
      const connA = knexFactory({ client: 'pg', connection, pool: POOL });
      const connB = knexFactory({ client: 'pg', connection, pool: POOL });
      try {
        // Rendezvous: pause connA's import right after it takes the
        // customer-comms lock. notification_prefs occurrence #1 is the
        // batch classification pass (before the write-phase transaction
        // even opens); #2 is importOneCustomer's own FOR SHARE, taken
        // immediately after acquiring BOTH locks — pausing there holds the
        // lock open. It's transaction-scoped — held until connA's
        // transaction commits or rolls back — so while paused, connB's own
        // lock attempt for the SAME customer_id is a real, provable block,
        // not a timing guess.
        const { conn: pausedA, reached: aReached, release: releaseA } = pauseNthTableRead(connA, 'notification_prefs', 2);
        const resultAPromise = reconcileCustomers({ dryRun: false, conn: pausedA });
        await aReached; // connA holds the lock now; paused before its own read

        let bSettled = false;
        const resultBPromise = reconcileCustomers({ dryRun: false, conn: connB })
          .then((r) => { bSettled = true; return r; });
        // Give connB every opportunity to finish if it were (wrongly) not
        // actually blocked on the lock.
        await new Promise((resolve) => { setTimeout(resolve, 200); });
        expect(bSettled).toBe(false); // still blocked on the SAME advisory lock key

        releaseA();
        const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);
        const imported = resultA.imported + resultB.imported;
        const rowAppeared = resultA.excluded.row_appeared + resultB.excluded.row_appeared;
        expect(imported).toBe(1); // exactly one of the two actually inserted
        expect(rowAppeared).toBe(1); // the other's re-check, run strictly AFTER, found it already active
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

  test('the customer row is locked (FOR SHARE) through the whole import — a concurrent FOR UPDATE (customer-email-write.js\'s own lock) genuinely blocks until commit', async () => {
    const cust = await (async () => {
      const c = synthCustomer();
      await db('customers').insert(c);
      await db('notification_prefs').insert({ customer_id: c.id, marketing_offers: true, email_enabled: true });
      return c;
    })();
    const lc = cust.email.toLowerCase();
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    const other = knexFactory({ client: 'pg', connection, pool: POOL });
    try {
      // Pause connA's import right after fetchLiveCandidateNow's SELECT ...
      // FOR SHARE has already run (notification_prefs occurrence #2 is
      // importOneCustomer's own FOR SHARE, taken immediately after that
      // customer-row read) — the customer row lock is held from this point
      // until connA's transaction commits or rolls back.
      const { conn: pausedA, reached, release } = pauseNthTableRead(connA, 'notification_prefs', 2);
      const resultAPromise = reconcileCustomers({ dryRun: false, conn: pausedA });
      await reached; // connA now holds FOR SHARE on the customers row

      // A genuinely separate connection tries the SAME lock
      // customer-email-write.js takes before writing customers.email
      // (`.forUpdate()`) — this must be a real, provable block.
      let otherResolved = false;
      const otherPromise = other.transaction(async (trx2) => {
        await trx2('customers').where({ id: cust.id }).forUpdate().first();
      }).then(() => { otherResolved = true; });

      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(otherResolved).toBe(false); // genuinely blocked, not a coincidence of timing

      release();
      const result = await resultAPromise;
      await otherPromise; // now unblocks once connA's transaction has committed
      expect(otherResolved).toBe(true);
      expect(result.imported).toBe(1);
    } finally {
      await other.destroy();
      await connA.destroy();
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

  test('a padded legacy unsubscribed row (real Postgres) still blocks a new active row for the same address', () => rollbackTest(async (trx) => {
    const cust = synthCustomer();
    await trx('customers').insert(cust);
    await trx('notification_prefs').insert({ customer_id: cust.id, marketing_offers: true, email_enabled: true });
    // A legacy row with surrounding whitespace — LOWER(TRIM(...)) on BOTH
    // sides (existingSubscriberStatus and the candidate NOT EXISTS check)
    // is what makes this still resolve to the same address.
    await trx('newsletter_subscribers').insert({ email: ` ${cust.email.toUpperCase()} `, status: 'unsubscribed', source: 'legacy' });

    const dry = await reconcileCustomers({ conn: trx });
    // The legacy row isn't ACTIVE, so it's still a fetchCandidateRows
    // candidate — the normalization fix matters at CLASSIFICATION, where
    // existingSubscriberStatus must find the unsubscribed row despite the
    // whitespace/case difference.
    expect(dry.candidates).toBe(1);
    expect(dry.importable).toBe(0);
    expect(dry.excluded.previously_unsubscribed).toBe(1);

    const write = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(write.imported).toBe(0);
    const rows = await trx('newsletter_subscribers').whereRaw('LOWER(TRIM(email)) = ?', [cust.email.toLowerCase()]);
    expect(rows).toHaveLength(1); // still just the legacy row — nothing new inserted
    expect(rows[0].status).toBe('unsubscribed');
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
