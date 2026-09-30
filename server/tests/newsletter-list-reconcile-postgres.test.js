/**
 * Real PostgreSQL verification of the atomic INSERT-only import write —
 * genuine Postgres concurrency semantics a mocked knex cannot honestly
 * reproduce: a real UNIQUE constraint racing two connections, and the
 * write itself being unable to touch a pre-existing row. Run with
 * RECONCILE_TEST_DATABASE_URL pointing to a disposable local, managed
 * worktree QA, or isolated CI database. Deliberately NOT gated on
 * DATABASE_URL: the reconcile scans the whole customer/subscriber tables, so
 * it needs a database holding only migration seeds — CI runs it in its own
 * step right after the migration (.github/workflows/tests.yml). Every fixture rolls back (except
 * the genuine-concurrency case, which commits on a scratch email and
 * cleans up explicitly, since two real connections can't share one
 * uncommitted transaction).
 */
jest.setTimeout(30000);
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const { lockCustomerComms, lockCustomerEmail } = require('../utils/customer-comms-lock');

const connection = process.env.RECONCILE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

// Pauses the Nth query against one table, AFTER Postgres has already
// returned it, until the caller explicitly releases it — a deterministic
// rendezvous point, not a timing guess. Every decision (decideAddress) makes
// TWO notification_prefs calls for a single-profile address: the FOR SHARE
// on the profile's row (after the comms lock and the customer row lock) and
// classifyAddress's one read — the LAST read before an insert. The dry-run
// projection makes one decision per candidate (#1 FOR SHARE, #2 read); the
// write phase makes another (#3 FOR SHARE, #4 read). Pausing #3 traps the
// write-phase decision while it holds its locks; pausing #4 traps the
// moment right before the INSERT, so a race landed between `reached` and
// `release()` is guaranteed to fall in that exact gap. Same technique as
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

// Same rendezvous technique as pauseNthTableRead, for a statement reached
// via `.raw()` (matched by a SQL substring) rather than a table-builder
// call — fillZoneForSubscriber's customer-row lock and its subscriber-row
// lock are both plain `.raw()` calls, so pauseNthTableRead's table-name
// match can't target either one.
function pauseNthRawCall(base, sqlSubstring, n) {
  let count = 0;
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const released = new Promise((resolve) => { releaseResolve = resolve; });
  function wrapConn(conn) {
    const wrapped = (...args) => conn(...args);
    wrapped.transaction = (cb, ...args) => conn.transaction((trx) => cb(wrapConn(trx)), ...args);
    wrapped.raw = async (sql, ...rest) => {
      const result = await conn.raw(sql, ...rest);
      if (String(sql).includes(sqlSubstring) && ++count === n) {
        reachedResolve();
        await released;
      }
      return result;
    };
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

    // Pause #4 — the write-phase decision's last read before the INSERT —
    // insert the conflicting row from a genuinely separate connection, then
    // release: the INSERT is guaranteed to run strictly after that commit.
    const { conn: paused, reached, release } = pauseNthTableRead(trx, 'notification_prefs', 4);
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
        // Rendezvous: pause connA's write-phase decision (#3, its FOR
        // SHARE, taken right after the customer-comms lock and the
        // customer row lock). The lock is transaction-scoped — held until
        // connA's import commits or rolls back — so while paused, connB's
        // own decision for the SAME customer_id is a real, provable block,
        // not a timing guess.
        const { conn: pausedA, reached: aReached, release: releaseA } = pauseNthTableRead(connA, 'notification_prefs', 3);
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
      // Pause connA's write-phase decision right after its customers-row
      // SELECT ... FOR SHARE has run (#3 is the prefs FOR SHARE taken
      // immediately after it) — the customer row lock is held from this
      // point until connA's import commits or rolls back.
      const { conn: pausedA, reached, release } = pauseNthTableRead(connA, 'notification_prefs', 3);
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
  // ── Address-level eligibility (a mailbox shared by several profiles) ──

  async function seedCommitted(customers, prefs = []) {
    for (const c of customers) await db('customers').insert(c);
    for (const p of prefs) await db('notification_prefs').insert(p);
  }
  async function cleanupCommitted(customerIds, emails) {
    await db('newsletter_subscribers').whereIn('customer_id', customerIds).del();
    for (const e of emails) await db('newsletter_subscribers').whereRaw('LOWER(TRIM(email)) = ?', [e.toLowerCase()]).del();
    await db('notification_prefs').whereIn('customer_id', customerIds).del();
    await db('customers').whereIn('id', customerIds).del();
  }

  // Codex #5165: Google ignores local-part dots and '+tags' and
  // googlemail.com is gmail.com, so exclusions match on that mailbox
  // identity in both directions — the real SQL (GOOGLE_MAILBOX_SQL), not a
  // mocked matcher. Non-Google addresses stay exact.
  test('an unsubscribe, a suppression, or an opt-out recorded under a Google alias excludes the address; a non-Google +tag does not (real Postgres)', () => rollbackTest(async (trx) => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const unsub = synthCustomer({ email: `unsub${tag}@gmail.com` });
    const suppressed = synthCustomer({ email: `U.N.S.U.P${tag}+promo@googlemail.com` });
    const optedIn = synthCustomer({ email: `optout${tag}@gmail.com` });
    const optedOutAlias = synthCustomer({ email: `Opt.Out${tag}+work@gmail.com`, pipeline_stage: 'new_lead' });
    const control = synthCustomer({ email: `ctrl${tag}@example.invalid` });
    await trx('customers').insert([unsub, suppressed, optedIn, optedOutAlias, control]);
    await trx('notification_prefs').insert({ customer_id: optedOutAlias.id, marketing_offers: false, email_enabled: true });
    await trx('newsletter_subscribers').insert([
      { email: `u.n.s.u.b${tag}+news@googlemail.com`, status: 'unsubscribed', source: 'public_form' },
      { email: `ctrl${tag}+news@example.invalid`, status: 'unsubscribed', source: 'public_form' },
    ]);
    await trx('email_suppressions').insert({ email: `unsup${tag}@gmail.com`, suppression_type: 'unsubscribe', status: 'active' });

    const dry = await reconcileCustomers({ conn: trx });
    expect(dry.excluded).toMatchObject({ previously_unsubscribed: 1, suppressed: 1, marketing_opted_out: 1 });
    expect(dry.importable).toBe(1); // the non-Google control only
    const write = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(write.imported).toBe(1);
    const active = await trx('newsletter_subscribers').where({ status: 'active' }).whereRaw('email LIKE ?', [`%${tag}%`]);
    expect(active.map((r) => r.email)).toEqual([`ctrl${tag}@example.invalid`]);
  }));

  // Codex #5165 (recheck sharers): an email assignment that took the address
  // key FIRST (customer-email-write.js order: row FOR UPDATE, then the key)
  // makes the decision wait on that key; once it commits, the re-read sees
  // the new sharer, the decision retries from scratch, and the new sharer's
  // opt-out is honoured.
  test('an email assignment holding the address key blocks the decision, and the new (opted-out) sharer it commits is honoured on retry', async () => {
    const primary = synthCustomer();
    const joiner = synthCustomer({ pipeline_stage: 'new_lead' });
    await seedCommitted([primary, joiner], [
      { customer_id: primary.id, marketing_offers: true, email_enabled: true },
      { customer_id: joiner.id, marketing_offers: false, email_enabled: true },
    ]);
    const writer = knexFactory({ client: 'pg', connection, pool: POOL });
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    let writerTrx;
    try {
      writerTrx = await writer.transaction();
      await writerTrx('customers').where({ id: joiner.id }).forUpdate().first('id');
      await lockCustomerEmail(writerTrx, primary.email);
      await writerTrx('customers').where({ id: joiner.id }).update({ email: primary.email });

      let settled = false;
      const resultPromise = reconcileCustomers({ dryRun: false, conn: connA }).then((r) => { settled = true; return r; });
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(settled).toBe(false); // waiting on the address key

      await writerTrx.commit();
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(0);
      expect(result.excluded.marketing_opted_out).toBe(1);
      const rows = await db('newsletter_subscribers').whereRaw('LOWER(TRIM(email)) = ?', [primary.email.toLowerCase()]);
      expect(rows).toHaveLength(0);
    } finally {
      if (writerTrx && !writerTrx.isCompleted()) await writerTrx.rollback();
      await writer.destroy();
      await connA.destroy();
      await cleanupCommitted([primary.id, joiner.id], [primary.email]);
    }
  });

  test('two live candidates on equivalent Google spellings are ONE mailbox: the dry run projects one import and the write performs exactly one (real Postgres)', () => rollbackTest(async (trx) => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const a = synthCustomer({ email: `j.o.h.n${tag}+work@gmail.com` });
    const b = synthCustomer({ email: `john${tag}@gmail.com` });
    await trx('customers').insert([a, b]);
    const dry = await reconcileCustomers({ conn: trx });
    expect(dry.importable).toBe(1);
    expect(dry.excluded.duplicate_address).toBe(1);
    const write = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(write.imported).toBe(1);
    expect(write.excluded.row_appeared).toBe(0); // the preview matched what the write applied
  }));

  test('a lead-stage profile sharing the address with an explicit opt-out excludes it (real Postgres) — the dry run and the write agree', () => rollbackTest(async (trx) => {
    const primary = synthCustomer();
    const sharer = synthCustomer({ email: ` ${primary.email.toUpperCase()}`, pipeline_stage: 'new_lead' });
    await trx('customers').insert([primary, sharer]);
    await trx('notification_prefs').insert([
      { customer_id: primary.id, marketing_offers: true, email_enabled: true },
      { customer_id: sharer.id, marketing_offers: false, email_enabled: true },
    ]);
    const dry = await reconcileCustomers({ conn: trx });
    expect(dry.candidates).toBe(1);
    expect(dry.importable).toBe(0);
    expect(dry.excluded.marketing_opted_out).toBe(1);
    const write = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(write.imported).toBe(0);
    const rows = await trx('newsletter_subscribers').whereRaw('LOWER(TRIM(email)) = ?', [primary.email.toLowerCase()]);
    expect(rows).toHaveLength(0);
  }));

  test('a sharing profile\'s opt-out committed under its customer-comms lock (the notification-prefs writer protocol) blocks the reconcile, which then honours it', async () => {
    const primary = synthCustomer();
    const sharer = synthCustomer({ email: primary.email, pipeline_stage: 'new_lead' });
    await seedCommitted([primary, sharer], [
      { customer_id: primary.id, marketing_offers: true, email_enabled: true },
      { customer_id: sharer.id, marketing_offers: true, email_enabled: true },
    ]);
    const writer = knexFactory({ client: 'pg', connection, pool: POOL });
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    let writerTrx;
    try {
      writerTrx = await writer.transaction();
      await lockCustomerComms(writerTrx, sharer.id);
      await writerTrx('notification_prefs').where({ customer_id: sharer.id }).update({ marketing_offers: false });

      let settled = false;
      const resultPromise = reconcileCustomers({ dryRun: false, conn: connA }).then((r) => { settled = true; return r; });
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(settled).toBe(false); // waiting on the SHARER's comms lock, not just its own

      await writerTrx.commit();
      const result = await resultPromise;
      expect(result.imported).toBe(0);
      expect(result.excluded.marketing_opted_out).toBe(1);
      const rows = await db('newsletter_subscribers').whereRaw('LOWER(TRIM(email)) = ?', [primary.email.toLowerCase()]);
      expect(rows).toHaveLength(0);
    } finally {
      // A failed assertion must not leave the held transaction open (destroy would hang).
      if (writerTrx && !writerTrx.isCompleted()) await writerTrx.rollback();
      await writer.destroy();
      await connA.destroy();
      await cleanupCommitted([primary.id, sharer.id], [primary.email]);
    }
  });

  test('a sharing profile\'s prefs row stays FOR SHARE-locked from the decision through the insert — a lockless FOR UPDATE writer (admin-customers.js pattern) waits for the commit', async () => {
    const primary = synthCustomer();
    const sharer = synthCustomer({ email: primary.email, pipeline_stage: 'new_lead' });
    await seedCommitted([primary, sharer], [
      { customer_id: primary.id, marketing_offers: true, email_enabled: true },
      { customer_id: sharer.id, marketing_offers: true, email_enabled: true },
    ]);
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    const other = knexFactory({ client: 'pg', connection, pool: POOL });
    try {
      // Two profiles => each decision makes 3 prefs calls (2 FOR SHARE + 1
      // read); #6 is the write-phase decision's last read before the INSERT.
      const { conn: pausedA, reached, release } = pauseNthTableRead(connA, 'notification_prefs', 6);
      const resultPromise = reconcileCustomers({ dryRun: false, conn: pausedA });
      await reached;

      let writerDone = false;
      const writerPromise = other.transaction(async (t) => {
        await t('notification_prefs').where({ customer_id: sharer.id }).forUpdate().first('customer_id');
        await t('notification_prefs').where({ customer_id: sharer.id }).update({ marketing_offers: false });
      }).then(() => { writerDone = true; });
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(writerDone).toBe(false); // cannot land between the decision and the insert

      release();
      const result = await resultPromise;
      await writerPromise;
      expect(result.imported).toBe(1); // decided and inserted strictly BEFORE the opt-out committed
    } finally {
      await other.destroy();
      await connA.destroy();
      await cleanupCommitted([primary.id, sharer.id], [primary.email]);
    }
  });

  test('orphan linking serializes on the target customer\'s comms lock: a competing link committed first makes this run refuse, never a second active subscriber', async () => {
    const twin = synthCustomer();
    await seedCommitted([twin]);
    const orphanEmail = twin.email.toLowerCase();
    const competingEmail = `synth-${randomUUID().slice(0, 8)}@example.invalid`;
    await db('newsletter_subscribers').insert({ email: orphanEmail, status: 'active', source: 'test_orphan' });
    const holder = knexFactory({ client: 'pg', connection, pool: POOL });
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    let holderTrx;
    try {
      // A competing linker holds the twin's comms lock and links ANOTHER
      // active subscriber to the twin, uncommitted.
      holderTrx = await holder.transaction();
      await lockCustomerComms(holderTrx, twin.id);
      await holderTrx('newsletter_subscribers').insert({ email: competingEmail, status: 'active', source: 'test_orphan', customer_id: twin.id });

      let settled = false;
      const resultPromise = reconcileCustomers({ dryRun: false, conn: connA }).then((r) => { settled = true; return r; });
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(settled).toBe(false); // blocked on the lock BEFORE its one-active-link check

      await holderTrx.commit();
      const result = await resultPromise;
      expect(result.orphanLinks).toBe(0);
      const linked = await db('newsletter_subscribers').where({ customer_id: twin.id, status: 'active' });
      expect(linked).toHaveLength(1);
      expect(linked[0].email).toBe(competingEmail);
    } finally {
      if (holderTrx && !holderTrx.isCompleted()) await holderTrx.rollback();
      await holder.destroy();
      await connA.destroy();
      await cleanupCommitted([twin.id], [orphanEmail, competingEmail]);
    }
  });

  // ── Canonical link / identity / zone (the SAME picker every linker runs) ──

  async function canonicalTwinId(conn, email) {
    const { liveTwinSubselect } = require('../services/newsletter-subscribers');
    const twin = liveTwinSubselect('?');
    const r = await conn.raw(`SELECT ${twin.sql} AS id`, [email.trim().toLowerCase(), ...twin.bindings]);
    return r.rows[0].id;
  }

  test('an orphan links to THE canonical twin (liveTwinSubselect) — a primary lead-stage profile beats a live customer, exactly as linkToCustomer picks (real Postgres)', () => rollbackTest(async (trx) => {
    const live = synthCustomer();
    const lead = synthCustomer({ email: ` ${live.email.toUpperCase()}`, pipeline_stage: 'new_lead', is_primary_profile: true });
    await trx('customers').insert([live, lead]);
    const orphanEmail = live.email.toLowerCase();
    await trx('newsletter_subscribers').insert({ email: orphanEmail, status: 'active', source: 'test_orphan' });
    expect(await canonicalTwinId(trx, orphanEmail)).toBe(lead.id);

    const dry = await reconcileCustomers({ conn: trx });
    expect(dry.orphanLinks).toBeGreaterThanOrEqual(1);
    expect((await trx('newsletter_subscribers').where({ email: orphanEmail }).first()).customer_id).toBeNull(); // dry run wrote nothing
    await reconcileCustomers({ dryRun: false, conn: trx });
    const row = await trx('newsletter_subscribers').where({ email: orphanEmail }).first();
    expect(row.customer_id).toBe(lead.id);
  }));

  test('a linked orphan gets its zone in the same run — the dry run projects that fill and the write applies it (real Postgres)', () => rollbackTest(async (trx) => {
    const owner = synthCustomer({ city: 'Venice' });
    await trx('customers').insert(owner);
    await trx('newsletter_subscribers').insert({ email: owner.email.toLowerCase(), status: 'active', source: 'public_form' });
    const dry = await reconcileCustomers({ conn: trx });
    expect(dry).toMatchObject({ orphanLinks: 1, zoneFills: 1 });
    const write = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(write).toMatchObject({ orphanLinks: 1, zoneFills: 1, errors: [] });
    const row = await trx('newsletter_subscribers').where({ email: owner.email.toLowerCase() }).first();
    expect(row).toMatchObject({ customer_id: owner.id, region_zone: 'south_sarasota' });
  }));

  test('an imported row carries the CANONICAL profile\'s name and is linked to it — never a secondary sharer\'s (real Postgres)', () => rollbackTest(async (trx) => {
    const secondary = synthCustomer({ first_name: 'Secondary', last_name: 'Sharer', city: 'Bradenton' });
    const primary = synthCustomer({ email: secondary.email.toUpperCase(), first_name: 'Primary', last_name: 'Holder', city: 'Venice', is_primary_profile: true });
    await trx('customers').insert([secondary, primary]);
    const dry = await reconcileCustomers({ conn: trx });
    expect(dry.byCity).toEqual(expect.arrayContaining([{ city: 'Venice', count: 1 }]));
    const write = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(write.imported).toBeGreaterThanOrEqual(1);
    const row = await trx('newsletter_subscribers').where({ email: secondary.email.toLowerCase() }).first();
    expect(row).toMatchObject({ customer_id: primary.id, first_name: 'Primary', last_name: 'Holder', region_zone: 'south_sarasota' });
  }));

  // Codex P2 (:673) — two live profiles sharing a Google mailbox under
  // DIFFERENT spellings (never an exact-match twin, so the canonicalProfile
  // query alone can't disambiguate them) must resolve to the picker's own
  // pick every run, never whichever spelling Postgres's (otherwise
  // unordered) heap scan happens to return first. fetchCandidateRows' own
  // ORDER BY (is_primary_profile DESC NULLS LAST, created_at ASC, id ASC)
  // is what makes this deterministic — proven against real Postgres, not a
  // mocked row order.
  test('two live profiles sharing a Google mailbox under different spellings resolve to the SAME canonical profile every run (real Postgres)', () => rollbackTest(async (trx) => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const alias = synthCustomer({
      email: `j.o.h.n${tag}+work@gmail.com`, first_name: 'Alias', last_name: 'Spelling', city: 'Nowhere',
    });
    const canonical = synthCustomer({
      email: `john${tag}@gmail.com`, first_name: 'Canonical', last_name: 'Holder', city: 'Venice', is_primary_profile: true,
    });
    await trx('customers').insert([alias, canonical]);
    const dry = await reconcileCustomers({ conn: trx });
    expect(dry.byCity).toEqual(expect.arrayContaining([{ city: 'Venice', count: 1 }]));
    expect(dry.byCity).not.toEqual(expect.arrayContaining([{ city: 'Nowhere', count: 1 }]));

    const write = await reconcileCustomers({ dryRun: false, conn: trx });
    expect(write.imported).toBe(1);
    const row = await trx('newsletter_subscribers').whereRaw(
      'LOWER(TRIM(email)) IN (?, ?)',
      [alias.email.toLowerCase(), canonical.email.toLowerCase()],
    ).first();
    // The CANONICAL spelling was kept and inserted — never the alias's.
    expect(row).toMatchObject({
      email: canonical.email.toLowerCase(), customer_id: canonical.id, first_name: 'Canonical', last_name: 'Holder',
    });
  }));

  test('zone fill writes from the customer\'s CURRENT city: an uncommitted city edit blocks the locked re-read, and the committed city is the one used (real Postgres)', async () => {
    const cust = synthCustomer({ city: 'Venice' });
    await seedCommitted([cust]);
    const email = cust.email.toLowerCase();
    await db('newsletter_subscribers').insert({ email, status: 'active', source: 'test_zone', customer_id: cust.id });
    const editor = knexFactory({ client: 'pg', connection, pool: POOL });
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    let editTrx;
    try {
      // The projection reads Venice (south_sarasota); an edit to Bradenton
      // (manatee) is in flight on the customer row.
      editTrx = await editor.transaction();
      await editTrx('customers').where({ id: cust.id }).update({ city: 'Bradenton' });

      let settled = false;
      const resultPromise = reconcileCustomers({ dryRun: false, conn: connA }).then((r) => { settled = true; return r; });
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(settled).toBe(false); // the zone write's locked re-read waits on the edit

      await editTrx.commit();
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      const row = await db('newsletter_subscribers').where({ email }).first();
      expect(row.region_zone).toBe('manatee'); // never the projected south_sarasota
    } finally {
      if (editTrx && !editTrx.isCompleted()) await editTrx.rollback();
      await editor.destroy();
      await connA.destroy();
      await cleanupCommitted([cust.id], [email]);
    }
  });

  // Codex P1 (this round) — fillZoneForSubscriber locked the subscriber row
  // and the customer row in ONE combined `FOR UPDATE OF ns FOR SHARE OF c`
  // statement, leaving the actual acquisition order to the query planner;
  // customer-email-fanout.js locks `customers FOR UPDATE` BEFORE its own
  // later subscriber `FOR UPDATE`, with no comms lock in between — a
  // genuine cross-module deadlock risk if the planner locked ns first here.
  // Proven directly: while this decision holds ONLY the customer-row lock
  // (paused right after it, before the subscriber statement runs), a
  // separate connection can freely take FOR UPDATE on the subscriber row —
  // the subscriber is genuinely untouched at that point, so the two locks
  // are sequential (customer, then subscriber), never combined/reordered.
  test('fillZoneForSubscriber locks the customer row strictly BEFORE the subscriber row — never combined, matching every other writer\'s order (real Postgres)', async () => {
    const cust = synthCustomer({ city: 'Venice' });
    await seedCommitted([cust]);
    const email = cust.email.toLowerCase();
    const [subRow] = await db('newsletter_subscribers')
      .insert({ email, status: 'active', source: 'test_zone_order', customer_id: cust.id })
      .returning(['id']);
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    const other = knexFactory({ client: 'pg', connection, pool: POOL });
    try {
      // Pause right after the customer-row FOR SHARE (the statement added
      // by this round's fix), before the subscriber-row statement runs.
      const { conn: pausedA, reached, release } = pauseNthRawCall(connA, 'customers WHERE id = ? FOR SHARE', 1);
      const resultPromise = reconcileCustomers({ dryRun: false, conn: pausedA });
      await reached;

      // The subscriber row is NOT yet locked — a separate connection can
      // take FOR UPDATE on it immediately, no wait.
      const otherTrx = await other.transaction();
      const before = Date.now();
      await otherTrx('newsletter_subscribers').where({ id: subRow.id }).forUpdate().first('id');
      expect(Date.now() - before).toBeLessThan(200); // uncontended — proves ns wasn't locked yet
      await otherTrx.commit();

      release();
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      const row = await db('newsletter_subscribers').where({ id: subRow.id }).first();
      expect(row.region_zone).toBe('south_sarasota'); // the fill still landed once released
    } finally {
      await other.destroy();
      await connA.destroy();
      await cleanupCommitted([cust.id], [email]);
    }
  });

  // Codex P2 (:795) — "Retry fallbacks when the selected profile changes
  // address": the projection picks `primary` for this mailbox and keeps
  // `secondary` as its fallback; between the projection's own last read and
  // the write phase's first (pre-check) read on `primary`, a genuinely
  // committed race moves `primary` to a totally DIFFERENT mailbox. The old
  // outcome-code judgment would let importOneCustomer classify (and
  // import) `primary`'s NEW address — it's still live, so the outcome is
  // never 'no_longer_live' — and never try `secondary`. The fix judges by
  // mailbox: `primary`'s re-addressed profile is skipped WITHOUT being
  // imported here, and `secondary` — still in the projected mailbox — is
  // tried and imported.
  test('the selected profile moves to a DIFFERENT mailbox between projection and write: the fallback imports the ORIGINAL mailbox, and the moved profile is never imported here (real Postgres)', async () => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const primary = synthCustomer({ email: `moved${tag}@example.invalid`, is_primary_profile: true, first_name: 'Primary' });
    const secondary = synthCustomer({ email: `moved${tag}@example.invalid`, first_name: 'Secondary' });
    const movedEmail = `elsewhere${tag}@example.invalid`;
    await seedCommitted([primary, secondary], [
      { customer_id: primary.id, marketing_offers: true, email_enabled: true },
      { customer_id: secondary.id, marketing_offers: true, email_enabled: true },
    ]);
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    try {
      // Projection processes primary then secondary (is_primary_profile
      // DESC first): 2 raw "WHERE c.id = ?" reads each (peek + FOR SHARE
      // fresh) = reads #1-4. Pausing at #4 traps the run right as the
      // projection finishes, BEFORE the write phase's own first (pre-check)
      // read on `primary` — read #5 — has a chance to run.
      const { conn: pausedA, reached, release } = pauseNthRawCall(connA, 'WHERE c.id = ?', 4);
      let settled = false;
      const resultPromise = reconcileCustomers({ dryRun: false, conn: pausedA }).then((r) => { settled = true; return r; });
      await reached;
      expect(settled).toBe(false);
      await db('customers').where({ id: primary.id }).update({ email: movedEmail });
      release();
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      expect(result.excluded.no_longer_live).toBe(0);
      const rows = await db('newsletter_subscribers').whereRaw('email LIKE ?', [`%${tag}%`]);
      expect(rows).toHaveLength(1);
      // secondary's mailbox — never primary's new address.
      expect(rows[0].email).toBe(`moved${tag}@example.invalid`);
      expect(rows[0].customer_id).toBe(secondary.id);
    } finally {
      await connA.destroy();
      await cleanupCommitted([primary.id, secondary.id], [`moved${tag}@example.invalid`, movedEmail]);
    }
  });

  // The same race, but `primary` is re-addressed to a DIFFERENT SPELLING of
  // the SAME mailbox (a Google dot/tag alias) — the mailbox key still
  // matches, so the write phase's own attempt on `primary` settles it and
  // `secondary` is never even attempted.
  test('the selected profile is re-addressed to an ALIAS SPELLING of the same mailbox between projection and write: the attempt settles it without trying a fallback (real Postgres)', async () => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const primary = synthCustomer({ email: `johndoe${tag}@gmail.com`, is_primary_profile: true, first_name: 'Primary' });
    const secondary = synthCustomer({ email: `johndoe${tag}@gmail.com`, first_name: 'Secondary' });
    const aliasEmail = `j.o.h.n.d.o.e${tag}+work@gmail.com`;
    await seedCommitted([primary, secondary], [
      { customer_id: primary.id, marketing_offers: true, email_enabled: true },
      { customer_id: secondary.id, marketing_offers: true, email_enabled: true },
    ]);
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    try {
      const { conn: pausedA, reached, release } = pauseNthRawCall(connA, 'WHERE c.id = ?', 4);
      let settled = false;
      const resultPromise = reconcileCustomers({ dryRun: false, conn: pausedA }).then((r) => { settled = true; return r; });
      await reached;
      expect(settled).toBe(false);
      await db('customers').where({ id: primary.id }).update({ email: aliasEmail });
      release();
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      expect(result.excluded.no_longer_live).toBe(0);
      const rows = await db('newsletter_subscribers').whereRaw('email LIKE ?', [`%${tag}%`]);
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe(aliasEmail);
      // Settled by the FIRST attempt (primary, still the same mailbox) —
      // never fell through to secondary.
      expect(rows[0].customer_id).toBe(primary.id);
    } finally {
      await connA.destroy();
      await cleanupCommitted([primary.id, secondary.id], [`johndoe${tag}@gmail.com`, aliasEmail]);
    }
  });

  // Codex P2 (:817) — "Recheck the expected mailbox inside the import
  // transaction": the unlocked pre-filter peek in importAddressWithFallback
  // can itself be raced — the address moves in the exact gap between THAT
  // peek and decideAddress's own locked read, so the pre-filter alone would
  // let the mismatch through. Here the mutation lands strictly AFTER the
  // pre-filter's own read (so the pre-filter sees the ORIGINAL, matching
  // mailbox and does not skip the attempt) but BEFORE decideAddress's own
  // reads — proving the fix's SECOND, authoritative check (under the
  // FOR SHARE lock, via `expectedMailbox`) is what actually catches it.
  test('the selected profile moves to a DIFFERENT mailbox strictly AFTER the fallback loop\'s own pre-filter peek: the locked recheck still catches it, the fallback imports the ORIGINAL mailbox, and the moved profile is never imported here (real Postgres)', async () => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const primary = synthCustomer({ email: `lockrace${tag}@example.invalid`, is_primary_profile: true, first_name: 'Primary' });
    const secondary = synthCustomer({ email: `lockrace${tag}@example.invalid`, first_name: 'Secondary' });
    const movedEmail = `lockraceelsewhere${tag}@example.invalid`;
    await seedCommitted([primary, secondary], [
      { customer_id: primary.id, marketing_offers: true, email_enabled: true },
      { customer_id: secondary.id, marketing_offers: true, email_enabled: true },
    ]);
    const connA = knexFactory({ client: 'pg', connection, pool: POOL });
    try {
      // Projection: reads #1-4 (peek + FOR SHARE fresh, primary then
      // secondary). Read #5 is importAddressWithFallback's OWN pre-filter
      // peek on primary — pausing there traps the run AFTER that peek has
      // already read (and matched) the ORIGINAL address, but before
      // decideAddress's own peek (read #6) has run.
      const { conn: pausedA, reached, release } = pauseNthRawCall(connA, 'WHERE c.id = ?', 5);
      let settled = false;
      const resultPromise = reconcileCustomers({ dryRun: false, conn: pausedA }).then((r) => { settled = true; return r; });
      await reached;
      expect(settled).toBe(false);
      await db('customers').where({ id: primary.id }).update({ email: movedEmail });
      release();
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      expect(result.excluded.no_longer_live).toBe(0);
      const rows = await db('newsletter_subscribers').whereRaw('email LIKE ?', [`%${tag}%`]);
      expect(rows).toHaveLength(1);
      // secondary's (original) mailbox — never primary's new address, even
      // though the pre-filter peek itself never caught the move.
      expect(rows[0].email).toBe(`lockrace${tag}@example.invalid`);
      expect(rows[0].customer_id).toBe(secondary.id);
    } finally {
      await connA.destroy();
      await cleanupCommitted([primary.id, secondary.id], [`lockrace${tag}@example.invalid`, movedEmail]);
    }
  });
});
