// The parent-decision lock against REAL PostgreSQL (Codex round-7 P1,
// redesigned per the pre-push audit's P1: recordDecision no longer wraps
// EVERY program's decision in a dedicated-connection session lock — only a
// TERMITE annual term takes a lock at all, and it's a connection-free
// pg_advisory_xact_lock on the SAME conn/transaction the decision UPDATE
// itself runs on. withParentDecisionLock — the dedicated-connection
// SESSION lock — is now charge-side only (termite-annual-renewal-
// charge.js's decideAndCharge, held across its own live Stripe call).
// Proves, against real advisory-lock/pg_locks behavior no mock can fake:
//   (a) the pooled connection withParentDecisionLock borrows is ALWAYS
//       returned — on success, on a throwing fn(), and on a genuine
//       failure to acquire the lock;
//   (b) the pg_advisory_unlock actually runs on the SAME session that took
//       the lock (a cross-session unlock silently no-ops in Postgres, so
//       this is checked by watching the lock disappear from pg_locks, not
//       by trusting the call was made);
//   (c) a second caller contending for the SAME term WAITS (bounded by
//       lock_timeout), then either wins once the first releases or gets one
//       clear timeout error — never an instant spurious failure. This now
//       covers BOTH lock kinds on the same key: a charge (session lock)
//       and a decision (xact lock) genuinely exclude each other;
//   (d) the pool is never exhausted — sequential locks and two genuinely
//       concurrent holders (one per connection) both run clean against a
//       pool capped at 2, and recordDecision's OWN xact-lock path never
//       needs a SECOND connection at all (a pool of 1 is enough for it
//       alone);
//   (e) a non-termite recordDecision takes no lock and runs unaffected by
//       a held session lock on the same key — byte-identical to main.
//
// Bridges REPAIR_TEST_DATABASE_URL (this lane's own convention) onto
// DATABASE_URL and a small DB_POOL_MAX/MIN so `../models/db` — the SAME
// module-level handle withParentDecisionLock itself uses internally and
// cannot take as a parameter — connects to the disposable test database
// with a deliberately small pool, mirroring cron-lock-postgres.test.js's
// own real-db-module pattern (a separate small-pool `holder` knex instance
// models a genuinely different session/backend). recordDecision's OWN
// reads/writes are exercised against the REAL, already-migrated
// annual_prepay_terms table (customer_id/term_start/term_end are its only
// NOT NULL, no-default columns) — real rows, deleted via the customer's
// ON DELETE CASCADE in afterEach.
const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  DB_POOL_MAX: process.env.DB_POOL_MAX,
  DB_POOL_MIN: process.env.DB_POOL_MIN,
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

postgres('parent-decision lock — real Postgres advisory-lock mechanics', () => {
  let db;
  let holder; // a genuinely separate session/connection — models the "other side" of a race
  let withParentDecisionLock;
  let recordDecision;
  let cancelTermWithRestorations;
  let suspendActiveTermsForDisputedInvoice;
  let lockTermiteTermForStatusWrite;
  const customerIds = [];

  beforeAll(() => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('This test requires a local disposable database');
    }
    process.env.DATABASE_URL = process.env.REPAIR_TEST_DATABASE_URL;
    process.env.DB_POOL_MAX = '2';
    process.env.DB_POOL_MIN = '2';
    db = require('../models/db');
    ({
      withParentDecisionLock, recordDecision, cancelTermWithRestorations, suspendActiveTermsForDisputedInvoice, lockTermiteTermForStatusWrite,
    } = require('../services/annual-prepay-renewals'));
    holder = require('knex')({ client: 'pg', connection: process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 1, max: 1 } });
  });

  afterEach(async () => {
    // ON DELETE CASCADE on annual_prepay_terms.customer_id — deleting the
    // customer takes the term(s) with it.
    if (customerIds.length) {
      await db('customers').whereIn('id', customerIds).del();
      customerIds.length = 0;
    }
  });

  afterAll(async () => {
    await holder?.destroy();
    await db?.destroy();
    process.env.DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;
    process.env.DB_POOL_MAX = ORIGINAL_ENV.DB_POOL_MAX;
    process.env.DB_POOL_MIN = ORIGINAL_ENV.DB_POOL_MIN;
  });

  // Minimal valid rows on the REAL, already-migrated schema — annualPlanVersion
  // null/undefined models an ordinary (non-termite) program's term.
  const insertTerm = async ({ annualPlanVersion = null, status = 'active', renewalDecision = null, withInvoice = false } = {}) => {
    const { randomUUID } = require('crypto');
    const customerId = randomUUID();
    customerIds.push(customerId);
    await db('customers').insert({
      id: customerId,
      first_name: 'Lock Test',
      phone: `+1555${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`,
    });
    let prepayInvoiceId = null;
    if (withInvoice) {
      const [invoice] = await db('invoices').insert({
        customer_id: customerId, token: randomUUID(), invoice_number: `LOCK-${randomUUID().slice(0, 8)}`, status: 'paid',
      }).returning('id');
      prepayInvoiceId = invoice.id;
    }
    const [term] = await db('annual_prepay_terms').insert({
      customer_id: customerId,
      term_start: '2026-01-01',
      term_end: '2026-12-31',
      status,
      renewal_decision: renewalDecision,
      annual_plan_version: annualPlanVersion,
      prepay_invoice_id: prepayInvoiceId,
    }).returning('*');
    return withInvoice ? { termId: term.id, invoiceId: prepayInvoiceId } : term.id;
  };

  // Holds the charge's session lock on `termId` for `holdMs`, then runs
  // `write` once the lock is visibly held; returns the write's result, the
  // order of events, and how long the write took.
  // `sawAdvisoryWait` is the direct proof the write queued on THIS lock (an
  // ungranted advisory request on the key in pg_locks) — not merely on the
  // small test pool, which a write could also wait on.
  const raceWriteAgainstCharge = async (termId, write, { holdMs = 300 } = {}) => {
    const order = [];
    let sawAdvisoryWait = false;
    const chargeDone = withParentDecisionLock(termId, async () => {
      order.push('charge-holds-lock');
      for (let waited = 0; waited < holdMs; waited += 25) {
        await sleep(25);
        const res = await holder.raw(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = hashtext(?) AND objid = hashtext(?::text)",
          ['annual-prepay-parent-decision', String(termId)],
        );
        if (res.rows[0].n > 0) sawAdvisoryWait = true;
      }
      order.push('charge-releases');
    });
    await sleep(40);
    const startedAt = Date.now();
    const result = await write().then((value) => { order.push('write-runs'); return value; });
    const elapsed = Date.now() - startedAt;
    await chargeDone;
    return { result, order, elapsed, sawAdvisoryWait };
  };

  // The two-int4-arg form (pg_advisory_lock(key1, key2), what
  // withParentDecisionLock actually calls) stores classid=key1, objid=key2
  // DIRECTLY in pg_locks — unlike the single-bigint-arg form (used
  // elsewhere in this codebase, e.g. cron-lock.js), which splits one
  // bigint into classid/objid halves. No bit-shifting here.
  const advisoryLockCount = async (termId) => {
    const res = await holder.raw(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = hashtext(?) AND objid = hashtext(?::text)",
      ['annual-prepay-parent-decision', String(termId)],
    );
    return res.rows[0].n;
  };

  test('(a) the connection returns to the pool on a normal success', async () => {
    const termId = 'lock-success-1';
    expect(db.client.pool.numUsed()).toBe(0);
    const result = await withParentDecisionLock(termId, async () => 'ok');
    expect(result).toBe('ok');
    expect(db.client.pool.numUsed()).toBe(0);
    expect(await advisoryLockCount(termId)).toBe(0);
  });

  test('(a) the connection returns to the pool when fn() throws', async () => {
    const termId = 'lock-throw-1';
    await expect(withParentDecisionLock(termId, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(db.client.pool.numUsed()).toBe(0);
    expect(await advisoryLockCount(termId)).toBe(0);
  });

  test('(b) the unlock runs on the SAME session that took the lock — pg_locks clears the instant fn() resolves', async () => {
    const termId = 'lock-same-session-1';
    let sawHeld = false;
    const p = withParentDecisionLock(termId, async () => {
      // While fn() is running, the lock this SAME call took must still be
      // visible in pg_locks (proving the query above ran on a real,
      // still-open session, not a connection that already went back to
      // the pool).
      sawHeld = (await advisoryLockCount(termId)) === 1;
      await sleep(30);
      return 'done';
    });
    await expect(p).resolves.toBe('done');
    expect(sawHeld).toBe(true);
    // If the unlock had run on a DIFFERENT connection than the one that
    // locked it, Postgres would silently no-op it (a session can only
    // unlock its OWN advisory locks) and the row above would still show 1
    // forever (until that connection's session eventually ends). Seeing 0
    // here is the proof it ran on the same session.
    expect(await advisoryLockCount(termId)).toBe(0);
    expect(db.client.pool.numUsed()).toBe(0);
  });

  test('(c) a genuine failure to acquire the lock still returns the connection, after a bounded wait, with one clear error', async () => {
    const termId = 'lock-timeout-1';
    await holder.raw('SELECT pg_advisory_lock(hashtext(?), hashtext(?::text))', ['annual-prepay-parent-decision', termId]);
    try {
      const startedAt = Date.now();
      await expect(withParentDecisionLock(termId, async () => 'unreachable', { timeoutMs: 250 }))
        .rejects.toThrow(/could not acquire the parent-decision lock/);
      const elapsed = Date.now() - startedAt;
      // Bounded, not instant (proves it actually waited on the lock, not a
      // client-side "already someone else has it" pre-check) and not
      // hung well past the configured ceiling.
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(3000);
      expect(db.client.pool.numUsed()).toBe(0);
    } finally {
      await holder.raw('SELECT pg_advisory_unlock(hashtext(?), hashtext(?::text))', ['annual-prepay-parent-decision', termId]);
    }
  });

  test('(c)/(d) a decline racing an in-flight charge WAITS for it, then wins — never a spurious instant failure, and the pool is never asked for more than 2 connections', async () => {
    const termId = 'lock-contention-1';
    const order = [];
    let peakUsed = 0;
    const watchPeak = () => { peakUsed = Math.max(peakUsed, db.client.pool.numUsed()); };
    const poll = setInterval(watchPeak, 5);

    // "the charge" — takes the lock first and holds it across a simulated
    // Stripe round trip.
    const chargeStartedAt = Date.now();
    const chargeDone = withParentDecisionLock(termId, async () => {
      order.push('charge-holds-lock');
      await sleep(300);
      order.push('charge-releases');
      return 'charged';
    });
    // Give the charge a moment to actually claim the lock before the
    // decline tries — otherwise this would just be a race for who gets
    // there first, not a proof that the LOSER waits.
    await sleep(40);

    // "the decline" — starts while the charge is still mid-flight.
    const declineStartedAt = Date.now();
    const declineDone = withParentDecisionLock(termId, async () => {
      order.push('decline-runs');
      return 'declined';
    });

    const [chargeResult, declineResult] = await Promise.all([chargeDone, declineDone]);
    clearInterval(poll);

    expect(chargeResult).toBe('charged');
    expect(declineResult).toBe('declined'); // won the lock once the charge released — never refused outright
    expect(order).toEqual(['charge-holds-lock', 'charge-releases', 'decline-runs']);
    // The decline's OWN call didn't return until well after the charge had
    // released — proof it genuinely waited rather than failing fast.
    expect(Date.now() - declineStartedAt).toBeGreaterThanOrEqual(200);
    expect(Date.now() - chargeStartedAt).toBeGreaterThanOrEqual(300);
    // Never needed a 3rd connection: one per concurrently-held lock.
    expect(peakUsed).toBeLessThanOrEqual(2);
    expect(db.client.pool.numUsed()).toBe(0);
  });

  test('(d) 20 sequential locks against a pool capped at 2 never exhaust it', async () => {
    for (let i = 0; i < 20; i += 1) {
       
      const result = await withParentDecisionLock(`lock-sequential-${i}`, async () => `ok-${i}`);
      expect(result).toBe(`ok-${i}`);
       
      expect(db.client.pool.numUsed()).toBe(0);
    }
  });

  test('a lock this connection just released never leaks a lock_timeout onto the NEXT borrower of the same pooled connection', async () => {
    const baseline = (await db.raw('SHOW lock_timeout')).rows[0].lock_timeout;
    // Acquire+release several times (sets, then resets, lock_timeout on
    // whichever pooled connection tarn hands out each time — with a
    // 2-connection pool this cycles through both), then confirm every
    // connection in the pool still reads the SAME baseline, not the small
    // bound this helper uses internally while it holds the lock.
    for (let i = 0; i < 4; i += 1) {
       
      await withParentDecisionLock(`lock-reset-check-${i}`, async () => 'ok');
    }
    const after = (await db.raw('SHOW lock_timeout')).rows[0].lock_timeout;
    expect(after).toBe(baseline);
    expect(after).not.toMatch(/ms$/); // sanity: the internal bound (e.g. "5000ms") always carries a unit suffix
  });

  test('(e) recordDecision on a NON-termite term takes no lock — runs unaffected by a held session lock on the same key', async () => {
    const termId = await insertTerm({ annualPlanVersion: null, status: 'active' });
    // Hold the SESSION lock a termite charge would hold, on this exact key —
    // a non-termite decision must never even ask for it.
    await holder.raw('SELECT pg_advisory_lock(hashtext(?), hashtext(?::text))', ['annual-prepay-parent-decision', termId]);
    try {
      const startedAt = Date.now();
      const result = await recordDecision({ termId, action: 'renew', conn: db });
      const elapsed = Date.now() - startedAt;
      expect(result).toMatchObject({ id: termId, status: 'renewed', renewal_decision: 'renew' });
      // Byte-identical to main: no wait at all, since no lock is ever taken.
      expect(elapsed).toBeLessThan(500);
      expect(db.client.pool.numUsed()).toBe(0);
    } finally {
      await holder.raw('SELECT pg_advisory_unlock(hashtext(?), hashtext(?::text))', ['annual-prepay-parent-decision', termId]);
    }
  });

  test('(c) a decline (recordDecision, xact lock) racing an in-flight charge (withParentDecisionLock, session lock) on the SAME termite term WAITS, then proceeds', async () => {
    const termId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
    const order = [];

    const chargeStartedAt = Date.now();
    const chargeDone = withParentDecisionLock(termId, async () => {
      order.push('charge-holds-lock');
      await sleep(300);
      order.push('charge-releases');
      return 'charged';
    });
    // Give the charge a moment to actually claim the session lock first —
    // otherwise this is just a race for who gets there first, not proof
    // that the LOSER waits.
    await sleep(40);

    const declineStartedAt = Date.now();
    const declineDone = recordDecision({ termId, action: 'cancel', conn: db }).then((term) => {
      order.push('decline-runs');
      return term;
    });

    const [chargeResult, declineResult] = await Promise.all([chargeDone, declineDone]);

    expect(chargeResult).toBe('charged');
    // The decision genuinely proceeded (not refused, not silently skipped)
    // once the charge released its session lock.
    expect(declineResult).toMatchObject({ id: termId, status: 'cancelled', renewal_decision: 'cancel' });
    expect(order).toEqual(['charge-holds-lock', 'charge-releases', 'decline-runs']);
    expect(Date.now() - declineStartedAt).toBeGreaterThanOrEqual(200);
    expect(Date.now() - chargeStartedAt).toBeGreaterThanOrEqual(300);
    expect(db.client.pool.numUsed()).toBe(0);
  });

  test('(d) recordDecision (termite, xact lock) never needs a SECOND connection — a pool capped at 1 is enough on its own', async () => {
    const termId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
    const soloPool = require('knex')({ client: 'pg', connection: process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
    try {
      // If recordDecision's termite path ever tried to hold one connection
      // (its transaction) while asking the SAME pool for a second one (the
      // old, redesigned-away session-lock shape), this would hang against
      // a max:1 pool instead of resolving.
      const result = await recordDecision({ termId, action: 'renew', conn: soloPool });
      expect(result).toMatchObject({ id: termId, status: 'renewed', renewal_decision: 'renew' });
      expect(soloPool.client.pool.numUsed()).toBe(0);
    } finally {
      await soloPool.destroy();
    }
  });

  // Codex #4971 round-3 P1 (item 2) — chokepoint B: EVERY writer that can
  // move a termite annual term out of charge-eligible state takes the same
  // key, not just recordDecision. The refund/void-driven cancel
  // (cancelTermWithRestorations — moves 9 and 13) and the dispute demotion
  // (move 10) committing between the charge's last parent re-check and its
  // Stripe submission would otherwise still get the parent charged.
  test('(B) a refund/void-driven cancel (cancelTermWithRestorations) racing an in-flight charge on the SAME termite term WAITS, then cancels', async () => {
    const termId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
    const { result, order, elapsed, sawAdvisoryWait } = await raceWriteAgainstCharge(termId, () => cancelTermWithRestorations(termId, db));

    expect(sawAdvisoryWait).toBe(true);
    expect(order).toEqual(['charge-holds-lock', 'charge-releases', 'write-runs']);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(result).toMatchObject({ id: termId, status: 'cancelled', renewal_decision: null });
    expect(db.client.pool.numUsed()).toBe(0);
  });

  test('(B) a dispute demotion (suspendActiveTermsForDisputedInvoice) racing an in-flight charge on the SAME termite term WAITS, then demotes', async () => {
    const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
    const { result, order, elapsed, sawAdvisoryWait } = await raceWriteAgainstCharge(termId, () => suspendActiveTermsForDisputedInvoice(invoiceId, db));

    expect(sawAdvisoryWait).toBe(true);
    expect(order).toEqual(['charge-holds-lock', 'charge-releases', 'write-runs']);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(result.map((t) => [t.id, t.status])).toEqual([[termId, 'payment_pending']]);
    expect(db.client.pool.numUsed()).toBe(0);
  });

  test('(B, e) a NON-termite cancel or demotion never waits on the key — byte-identical to main', async () => {
    const plain = await insertTerm({ annualPlanVersion: null, status: 'active' });
    const cancel = await raceWriteAgainstCharge(plain, () => cancelTermWithRestorations(plain, db));
    expect(cancel.sawAdvisoryWait).toBe(false);
    expect(cancel.result).toMatchObject({ id: plain, status: 'cancelled' });

    const { termId: plainWithInvoice, invoiceId } = await insertTerm({ annualPlanVersion: null, status: 'active', withInvoice: true });
    const demote = await raceWriteAgainstCharge(plainWithInvoice, () => suspendActiveTermsForDisputedInvoice(invoiceId, db));
    expect(demote.sawAdvisoryWait).toBe(false);
    expect(demote.order).toEqual(['charge-holds-lock', 'write-runs', 'charge-releases']);
  });

  test('(B) the refund/void cancel re-entering from INSIDE the charge\'s own lock for the SAME term never self-waits', async () => {
    const termId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
    const startedAt = Date.now();
    const cancelled = await withParentDecisionLock(termId, () => cancelTermWithRestorations(termId, db));
    expect(cancelled).toMatchObject({ id: termId, status: 'cancelled' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(db.client.pool.numUsed()).toBe(0);
  });

  test('(B) taking the gate inside a caller\'s own transaction bounds only its own wait — the caller\'s lock_timeout is put back', async () => {
    const termId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
    const seen = await db.transaction(async (trx) => {
      await trx.raw("SELECT set_config('lock_timeout', '12s', true)");
      await lockTermiteTermForStatusWrite(trx, termId);
      return (await trx.raw('SHOW lock_timeout')).rows[0].lock_timeout;
    });
    expect(seen).toBe('12s');
  });

  // Codex round-7 P1 (2nd audit round) — REENTRANCY: chargeInvoiceWithSavedCard's
  // own card-on-file success path calls syncTermForInvoicePayment
  // synchronously, which for a termite renewal successor walks straight
  // into stampParentRenewedForSuccessor -> recordDecision('renew') on the
  // SAME parent term withParentDecisionLock is still holding (the session
  // lock, across the "Stripe submission"). Without the re-entrancy guard,
  // that inner recordDecision would try its OWN xact lock on the SAME key
  // from a SECOND connection and self-wait until its lock_timeout — a
  // multi-second stall on every successful synchronous charge, against a
  // pool of only 2. Proves it completes immediately instead.
  test('a successful charge that synchronously re-enters recordDecision for the SAME parent term completes with no timeout, under a pool of max 2', async () => {
    const termId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
    const startedAt = Date.now();

    const outcome = await withParentDecisionLock(termId, async () => {
      // Models decideAndCharge's own eligibility re-check + "Stripe
      // submission" — then the SAME synchronous call chain that
      // submission's own success handler makes into recordDecision for
      // this EXACT parent term, all still inside this callback.
      await sleep(20); // stands in for the live Stripe round trip
      const decided = await recordDecision({ termId, action: 'renew', conn: db });
      return { charged: true, decided };
    });

    const elapsed = Date.now() - startedAt;
    expect(outcome.charged).toBe(true);
    expect(outcome.decided).toMatchObject({ id: termId, status: 'renewed', renewal_decision: 'renew' });
    // Bounded by the ~20ms stand-in for Stripe, nowhere near the 5s
    // lock_timeout a self-wait would have hit.
    expect(elapsed).toBeLessThan(1000);
    expect(db.client.pool.numUsed()).toBe(0);
  });
});
