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
  let acquireTermiteGateAtEntry;
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
      withParentDecisionLock, recordDecision, cancelTermWithRestorations, suspendActiveTermsForDisputedInvoice, acquireTermiteGateAtEntry,
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

  // Codex #4971 r12 P1: the session lock now lives on a DEDICATED connection
  // outside the pool (acquireRawConnection), destroyed afterwards — it never
  // takes a pool slot, even while held. The (a)-(d) pool assertions below
  // were written for the old pooled lock connection ("returned to the
  // pool"); they now pin the stronger property: zero pool slots throughout.
  test('(a) the lock takes no pool slot while held, and leaves none behind on success', async () => {
    const termId = 'lock-success-1';
    expect(db.client.pool.numUsed()).toBe(0);
    let usedWhileHeld = null;
    const result = await withParentDecisionLock(termId, async () => {
      usedWhileHeld = db.client.pool.numUsed();
      expect(await advisoryLockCount(termId)).toBe(1);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(usedWhileHeld).toBe(0);
    expect(db.client.pool.numUsed()).toBe(0);
    expect(await advisoryLockCount(termId)).toBe(0);
  });

  test('(a) a throwing fn() leaves no pool slot and no lock behind', async () => {
    const termId = 'lock-throw-1';
    await expect(withParentDecisionLock(termId, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(db.client.pool.numUsed()).toBe(0);
    expect(await advisoryLockCount(termId)).toBe(0);
  });

  // Codex #4971 r15 P1: the dedicated raw connection's own error/end/close
  // is the one authority for "is this lock session still held" — Postgres
  // releases every advisory lock the session held the instant its
  // connection drops, but the ALS store's keys alone don't know it.
  // assertParentDecisionLockAlive() is what the gated flow checks
  // immediately before each provider boundary. Proved here against a REAL
  // connection loss (the backend actually terminated from a separate
  // session), not a simulated flag — trackConnectionLoss's own unit test
  // (raw-connection-slots.test.js) covers the plain event-listener
  // mechanics; this proves the wiring end to end.
  test('assertParentDecisionLockAlive: alive right after the gate is taken, throws once the session connection is actually killed', async () => {
    const termId = 'lock-session-loss-1';
    const { assertParentDecisionLockAlive } = require('../services/annual-prepay-renewals');
    let sawAliveMidHold = false;
    let thrown = null;
    await withParentDecisionLock(termId, async () => {
      expect(() => assertParentDecisionLockAlive()).not.toThrow();
      sawAliveMidHold = true;
      const pidRow = await holder.raw(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = hashtext(?) AND objid = hashtext(?::text)",
        ['annual-prepay-parent-decision', String(termId)],
      );
      const pid = pidRow.rows[0]?.pid;
      expect(pid).toBeTruthy();
      // Kill the exact backend holding OUR lock session — a real socket
      // close, not a mock.
      await holder.raw('SELECT pg_terminate_backend(?)', [pid]);
      for (let waited = 0; waited < 3000 && !thrown; waited += 25) {
        try {
          assertParentDecisionLockAlive();
        } catch (err) {
          thrown = err;
        }
        if (!thrown) await sleep(25);
      }
    });
    expect(sawAliveMidHold).toBe(true);
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('PARENT_DECISION_LOCK_LOST');
    expect(thrown.deliveryNeverAttempted).toBe(true);
    // Outside the gate (fn() has returned) the store is gone — a no-op,
    // never a stale throw leaking into whatever runs next.
    expect(() => assertParentDecisionLockAlive()).not.toThrow();
  });

  // Codex #4971 r19 P1: once the session is lost, PostgreSQL has released its
  // locks — a nested writer must take its OWN transaction lock again instead
  // of skipping it because the ALS store still named the key as held.
  test('a nested writer re-takes the transaction lock after the held session is lost', async () => {
    const termId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
    const { acquireTermiteGateAtEntry } = require('../services/annual-prepay-renewals');
    let nestedLockCount = null;
    await withParentDecisionLock(termId, async () => {
      const pidRow = await holder.raw(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = hashtext(?) AND objid = hashtext(?::text)",
        ['annual-prepay-parent-decision', String(termId)],
      );
      await holder.raw('SELECT pg_terminate_backend(?)', [pidRow.rows[0].pid]);
      for (let waited = 0; waited < 3000 && (await advisoryLockCount(termId)) > 0; waited += 25) await sleep(25);
      for (let waited = 0; waited < 3000; waited += 25) {
        try {
          require('../services/annual-prepay-renewals').assertParentDecisionLockAlive();
        } catch (err) {
          break;
        }
        await sleep(25);
      }
      await db.transaction(async (trx) => {
        await acquireTermiteGateAtEntry(trx, { termIds: [termId] });
        nestedLockCount = await advisoryLockCount(termId);
      });
    });
    // Before the fix the nested writer saw the key as held and took nothing.
    expect(nestedLockCount).toBe(1);
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

  test('(c) a genuine failure to acquire the lock fails after a bounded wait, with one clear error, and uses no pool slot', async () => {
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

  test('(c)/(d) a decline racing an in-flight charge WAITS for it, then wins — never a spurious instant failure, and neither lock takes a pool slot', async () => {
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
    // Both locks lived on their own dedicated sessions — the pool was never
    // touched (it used to be one pooled connection per held lock).
    expect(peakUsed).toBe(0);
    expect(db.client.pool.numUsed()).toBe(0);
  });

  // Codex #4971 r12 P1: the renewal charge's shape under the gate with the
  // supported DB_POOL_MAX=2 — chargeInvoiceWithSavedCard's invoice
  // transaction holds one pooled connection and, before it can finish,
  // commits its submission marker on ANOTHER (commitInvoiceSavedCardChargeSubmission
  // with the root handle). With the gate on a pooled connection that needed
  // a third and waited until the pool timed out; now it completes.
  test('a gated flow that nests an independent transaction inside its own transaction completes against a pool of 2', async () => {
    const termId = 'lock-pool-shape-1';
    const shape = withParentDecisionLock(termId, () => db.transaction(async (invoiceTrx) => {
      await invoiceTrx.raw('SELECT 1');
      const marker = await db.transaction(async (markerTrx) => (await markerTrx.raw('SELECT 2 AS n')).rows[0].n);
      await invoiceTrx.raw('SELECT 3');
      return marker;
    }));
    const timeout = sleep(5000).then(() => 'pool-starved');
    await expect(Promise.race([shape, timeout])).resolves.toBe(2);
    expect(db.client.pool.numUsed()).toBe(0);
    expect(await advisoryLockCount(termId)).toBe(0);
  });

  // Codex #4971 r13 P2: the unpooled lock sessions are bounded (the shared
  // raw-connection mechanism, raw-connection-slots.js): with every session
  // slot held, the next gate fails at once with the "could not acquire"
  // error callers already defer on — no ninth connection is opened — and a
  // released slot is usable again.
  test('the lock sessions are capped: with every slot held the next gate fails at once, then works once one is released', async () => {
    const { PARENT_DECISION_LOCK_SESSIONS } = require('../services/annual-prepay-renewals')._private;
    const releases = [];
    const holders = [];
    for (let i = 0; i < 8; i += 1) {
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      releases.push(release);
      holders.push(withParentDecisionLock(`lock-cap-${i}`, () => released));
    }
    while (PARENT_DECISION_LOCK_SESSIONS.openCount() < 8) await sleep(10);
    const startedAt = Date.now();
    await expect(withParentDecisionLock('lock-cap-over', async () => 'unreachable'))
      .rejects.toThrow(/could not acquire the parent-decision lock .* no lock session is available/);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(await advisoryLockCount('lock-cap-over')).toBe(0);

    releases[0]();
    await holders[0];
    await expect(withParentDecisionLock('lock-cap-over', async () => 'ok')).resolves.toBe('ok');
    releases.slice(1).forEach((release) => release());
    await Promise.all(holders);
    expect(PARENT_DECISION_LOCK_SESSIONS.openCount()).toBe(0);
  });

  test('(d) 20 sequential locks against a pool capped at 2 never exhaust it', async () => {
    for (let i = 0; i < 20; i += 1) {
       
      const result = await withParentDecisionLock(`lock-sequential-${i}`, async () => `ok-${i}`);
      expect(result).toBe(`ok-${i}`);
       
      expect(db.client.pool.numUsed()).toBe(0);
    }
  });

  // The lock's own lock_timeout is set on its dedicated session, which is
  // destroyed afterwards — no pooled connection ever carries it.
  test('the lock\'s lock_timeout never leaks onto a pooled connection', async () => {
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
      await acquireTermiteGateAtEntry(trx, { termIds: [termId] });
      return (await trx.raw('SHOW lock_timeout')).rows[0].lock_timeout;
    });
    expect(seen).toBe('12s');
  });

  // Codex #4971 pre-push (lock order): the gate is every writer's FIRST
  // lock — gate → customer → invoice → term, the charge path's own order.
  // The charge holds the gate and THEN asks for the customer row; a writer
  // that takes the gate first simply queues behind the charge (visible as
  // an ungranted advisory lock), then proceeds — no lock_timeout, no
  // deadlock. The control case shows the old order (a row lock first, the
  // gate second) stalls the charge on the row until the writer's 5s
  // lock_timeout aborts it.
  describe('(B) lock order: gate first at every writer entry', () => {
    let writerDb;
    beforeAll(() => {
      writerDb = require('knex')({ client: 'pg', connection: process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 2 } });
    });
    afterAll(async () => { await writerDb?.destroy(); });

    const gateWaiters = async (termId) => (await holder.raw(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = hashtext(?) AND objid = hashtext(?::text)",
      ['annual-prepay-parent-decision', String(termId)],
    )).rows[0].n;

    // The charge: gate, then (after a beat) the customer row, held briefly.
    const chargeHoldingGateThenCustomer = (termId, customerId, order) => withParentDecisionLock(termId, async () => {
      order.push('charge-gate');
      await sleep(150);
      await db.transaction(async (t) => {
        await t('customers').where({ id: customerId }).forUpdate().first('id');
        order.push('charge-customer-row');
        await sleep(100);
      });
      order.push('charge-done');
    });

    test('a writer entering gate-first while the charge holds the gate and requests the customer row WAITS, then proceeds — no timeout, no deadlock', async () => {
      const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const { customer_id: customerId } = await db('annual_prepay_terms').where({ id: termId }).first('customer_id');
      const order = [];
      let sawGateWait = false;
      const charge = chargeHoldingGateThenCustomer(termId, customerId, order);
      await sleep(40);
      const startedAt = Date.now();
      const writer = writerDb.transaction(async (trx) => {
        // The writer's entry (reverse-prepaid / remove-flag / dispute shape):
        await acquireTermiteGateAtEntry(trx, { invoiceIds: [invoiceId] });
        order.push('writer-gate');
        await trx('customers').where({ id: customerId }).forUpdate().first('id');
        await trx('invoices').where({ id: invoiceId }).forUpdate().first('id');
        await trx('annual_prepay_terms').where({ id: termId }).forUpdate().first('id');
        order.push('writer-rows');
      });
      const poll = (async () => { while (!order.includes('writer-gate')) { if (await gateWaiters(termId)) sawGateWait = true; await sleep(20); } })();
      await Promise.all([charge, writer, poll]);

      expect(sawGateWait).toBe(true);
      expect(order).toEqual(['charge-gate', 'charge-customer-row', 'charge-done', 'writer-gate', 'writer-rows']);
      expect(Date.now() - startedAt).toBeLessThan(4000); // never the 5s lock_timeout
    });

    // Codex #4971 r5 P2 — lock order across the PARENT and SUCCESSOR keys.
    // A withdrawal (or pay link / charge / grace lapse) guards the parent's
    // decision while its nested voidInvoice / cancel gate on the successor;
    // a refund keyed by customer takes every termite key of that customer in
    // sorted order. With successor < parent, holding only the parent let the
    // refund take the successor and then wait on the parent while the
    // withdrawal waited on the successor.
    const parentAndLowerSuccessor = async () => {
      const { randomUUID } = require('crypto');
      const parentId = await insertTerm({ annualPlanVersion: 'v3', status: 'active' });
      const { customer_id: customerId } = await db('annual_prepay_terms').where({ id: parentId }).first('customer_id');
      let successorId = randomUUID();
      while (successorId >= String(parentId)) successorId = randomUUID();
      await db('annual_prepay_terms').insert({
        id: successorId, customer_id: customerId, term_start: '2027-01-01', term_end: '2027-12-31',
        status: 'payment_pending', annual_plan_version: 'v3', renewed_from_term_id: parentId,
      });
      return { parentId: String(parentId), successorId, customerId };
    };
    const withdrawalShape = (parentId, successorId, order, lockOptions) => withParentDecisionLock(parentId, async () => {
      order.push('withdrawal-gate');
      await sleep(150);
      // voidInvoice / cancelTermWithRestorations: their own transaction's
      // gate, keyed on the successor.
      await db.transaction(async (t) => {
        await acquireTermiteGateAtEntry(t, { termIds: [successorId] });
        order.push('withdrawal-successor-gate');
      });
      order.push('withdrawal-done');
    }, lockOptions);

    test('a customer-keyed refund gate arriving mid-withdrawal WAITS, then proceeds — no lock_timeout (parent + successor held together, sorted)', async () => {
      const { parentId, successorId, customerId } = await parentAndLowerSuccessor();
      const order = [];
      const withdrawal = withdrawalShape(parentId, successorId, order, { alsoTermIds: [successorId] });
      await sleep(40);
      const startedAt = Date.now();
      const refund = writerDb.transaction(async (trx) => {
        const keys = await acquireTermiteGateAtEntry(trx, { customerIds: [customerId] });
        order.push('refund-gate');
        return keys;
      });
      const [keys] = await Promise.all([refund, withdrawal]);
      expect(keys).toEqual([successorId, parentId]);
      expect(order).toEqual(['withdrawal-gate', 'withdrawal-successor-gate', 'withdrawal-done', 'refund-gate']);
      expect(Date.now() - startedAt).toBeLessThan(4000);
      expect(await advisoryLockCount(parentId)).toBe(0);
      expect(await advisoryLockCount(successorId)).toBe(0);
      expect(db.client.pool.numUsed()).toBe(0);
    }, 20000);

    test('control: holding only the PARENT key, the same refund and withdrawal wait on each other until a lock_timeout aborts one', async () => {
      const { parentId, successorId, customerId } = await parentAndLowerSuccessor();
      const order = [];
      const withdrawal = withdrawalShape(parentId, successorId, order, {}).catch((err) => err);
      await sleep(40);
      const refund = writerDb.transaction(async (trx) => acquireTermiteGateAtEntry(trx, { customerIds: [customerId] })).catch((err) => err);
      const outcomes = await Promise.all([refund, withdrawal]);
      expect(outcomes.some((o) => o instanceof Error && /could not acquire the parent-decision lock/.test(o.message))).toBe(true);
    }, 20000);

    test('control: the OLD order (customer row first, gate second) stalls both until the writer\'s lock_timeout aborts it', async () => {
      const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const { customer_id: customerId } = await db('annual_prepay_terms').where({ id: termId }).first('customer_id');
      const order = [];
      const charge = chargeHoldingGateThenCustomer(termId, customerId, order);
      await sleep(40);
      const writer = writerDb.transaction(async (trx) => {
        await trx('customers').where({ id: customerId }).forUpdate().first('id');
        await acquireTermiteGateAtEntry(trx, { invoiceIds: [invoiceId] });
      });
      await expect(writer).rejects.toThrow(/could not acquire the parent-decision lock/);
      await charge;
      expect(order).toEqual(['charge-gate', 'charge-customer-row', 'charge-done']);
    }, 20000);
  });

  // Codex #4971 r4 P1 — the refund / chargeback writers' entry gate. A
  // refund names a Stripe charge / PaymentIntent / payments row, never a
  // term: the gate keys must be resolved from the money (the invoice it
  // settled, a combined share's metadata.invoice_id, the customer whose
  // credit it returns, a payer statement's children) — against the REAL
  // schema, where payments carries no invoice_id column at all.
  describe('(C) refund writers resolve the gate from the money and WAIT on a renewal charge in flight', () => {
    const { randomUUID } = require('crypto');
    const chargeIds = [];
    const statementIds = [];
    const payerIds = [];
    let acquireTermiteGateForCharge;
    let acquireTermiteGateForStatement;

    beforeAll(() => {
      ({ acquireTermiteGateForCharge, acquireTermiteGateForStatement } = require('../services/annual-prepay-renewals'));
    });

    afterEach(async () => {
      if (chargeIds.length) await db('payments').whereIn('stripe_charge_id', chargeIds.splice(0)).del();
      if (statementIds.length) {
        await db('invoices').whereIn('payer_statement_id', statementIds).update({ payer_statement_id: null });
        await db('payer_statements').whereIn('id', statementIds.splice(0)).del();
      }
      if (payerIds.length) await db('payers').whereIn('id', payerIds.splice(0)).del();
    });

    const insertPayment = async ({ customerId = null, metadata = {}, chargeId = `ch_${randomUUID().slice(0, 12)}`, paymentIntentId = null }) => {
      chargeIds.push(chargeId);
      await db('payments').insert({
        customer_id: customerId,
        payment_date: '2026-09-27',
        amount: 100,
        status: 'paid',
        stripe_charge_id: chargeId,
        stripe_payment_intent_id: paymentIntentId,
        metadata: JSON.stringify(metadata),
      });
      return chargeId;
    };

    const gatedWrite = (resolve) => () => db.transaction(async (trx) => resolve(trx));

    test('a charge whose invoice is the termite parent\'s prepay invoice (by the invoice\'s own charge id) waits, then proceeds keyed on the parent', async () => {
      const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const chargeId = `ch_${randomUUID().slice(0, 12)}`;
      await db('invoices').where({ id: invoiceId }).update({ stripe_charge_id: chargeId });
      const { result, order, sawAdvisoryWait } = await raceWriteAgainstCharge(termId,
        gatedWrite((trx) => acquireTermiteGateForCharge(trx, { chargeId })));
      expect(sawAdvisoryWait).toBe(true);
      expect(order).toEqual(['charge-holds-lock', 'charge-releases', 'write-runs']);
      expect(result).toEqual([String(termId)]);
    });

    test('a combined share (metadata.invoice_id) and a PaymentIntent-only lookup both resolve the parent', async () => {
      const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const chargeId = await insertPayment({ metadata: { combined_payment: true, invoice_id: invoiceId } });
      const byCharge = await raceWriteAgainstCharge(termId,
        gatedWrite((trx) => acquireTermiteGateForCharge(trx, { chargeId })));
      expect(byCharge.sawAdvisoryWait).toBe(true);
      expect(byCharge.result).toEqual([String(termId)]);

      const paymentIntentId = `pi_${randomUUID().slice(0, 12)}`;
      await db('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: paymentIntentId });
      const byPi = await db.transaction((trx) => acquireTermiteGateForCharge(trx, { paymentIntentId }));
      expect(byPi).toEqual([String(termId)]);
    });

    test('the admin refund route (a payments row id on an UNRELATED invoice of the same customer) still waits — the credit it returns is money the charge could consume', async () => {
      const { termId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const term = await db('annual_prepay_terms').where({ id: termId }).first('customer_id');
      const chargeId = await insertPayment({ customerId: term.customer_id });
      const payment = await db('payments').where({ stripe_charge_id: chargeId }).first('id');
      const { result, sawAdvisoryWait } = await raceWriteAgainstCharge(termId,
        gatedWrite((trx) => acquireTermiteGateForCharge(trx, { paymentIds: [payment.id] })));
      expect(sawAdvisoryWait).toBe(true);
      expect(result).toEqual([String(termId)]);
    });

    // Codex #4971 r11 P1 (chokepoint B): the dispute webhook holds the
    // renewal gate (withTermiteGateForCharge, a session lock) from before its
    // phase-one ledger flip through the later reopen transaction — both ways
    // round, the dispute and a renewal charge on the same parent serialize.
    test('the dispute webhook\'s gate (by the disputed charge / PaymentIntent) waits on a renewal charge in flight, and a charge waits on a held dispute', async () => {
      const { withTermiteGateForCharge } = require('../services/annual-prepay-renewals');
      const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const chargeId = await insertPayment({ metadata: { invoice_id: invoiceId } });
      const paymentIntentId = `pi_${randomUUID().slice(0, 12)}`;
      await db('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: paymentIntentId });

      const disputeAfterCharge = await raceWriteAgainstCharge(termId,
        () => withTermiteGateForCharge({ chargeId, paymentIntentId }, async () => 'dispute-phases-ran'));
      expect(disputeAfterCharge.sawAdvisoryWait).toBe(true);
      expect(disputeAfterCharge.order).toEqual(['charge-holds-lock', 'charge-releases', 'write-runs']);
      expect(disputeAfterCharge.result).toBe('dispute-phases-ran');

      const order = [];
      const dispute = withTermiteGateForCharge({ chargeId }, async () => {
        order.push('dispute-phase-one');
        await sleep(250);
        order.push('dispute-reopen-committed');
      });
      await sleep(40);
      await withParentDecisionLock(termId, async () => { order.push('renewal-charge-runs'); });
      await dispute;
      expect(order).toEqual(['dispute-phase-one', 'dispute-reopen-committed', 'renewal-charge-runs']);
    });

    test('a charge touching no termite term takes nothing and never waits', async () => {
      const plain = await insertTerm({ annualPlanVersion: null, status: 'active', withInvoice: true });
      const plainTerm = await db('annual_prepay_terms').where({ id: plain.termId }).first('customer_id');
      const chargeId = await insertPayment({ customerId: plainTerm.customer_id, metadata: { invoice_id: plain.invoiceId } });
      const { result, sawAdvisoryWait, elapsed } = await raceWriteAgainstCharge(plain.termId,
        gatedWrite((trx) => acquireTermiteGateForCharge(trx, { chargeId })));
      expect(result).toEqual([]);
      expect(sawAdvisoryWait).toBe(false);
      expect(elapsed).toBeLessThan(250);
      expect(await db.transaction((trx) => acquireTermiteGateForCharge(trx, {}))).toEqual([]);
    });

    test('malformed ids are ignored, never thrown (the key lookup compares uuid columns to a filtered uuid[] — index-friendly)', async () => {
      const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const keys = await db.transaction((trx) => acquireTermiteGateAtEntry(trx, {
        termIds: ["x') OR true --", 'term-1'], invoiceIds: ['not-a-uuid', invoiceId], customerIds: ['cust-1'],
      }));
      expect(keys).toEqual([String(termId)]);
      expect(await db.transaction((trx) => acquireTermiteGateAtEntry(trx, { customerIds: ['cust-1'], invoiceIds: ['inv-1'] }))).toEqual([]);
    });

    test('a payer statement whose child is the termite parent\'s prepay invoice gates its refund / chargeback reversal', async () => {
      const { termId, invoiceId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
      const [payer] = await db('payers').insert({ display_name: 'Gate Test Payer' }).returning('id');
      payerIds.push(payer.id);
      const [statement] = await db('payer_statements').insert({
        payer_id: payer.id, period_start: '2026-08-01', period_end: '2026-08-31', terms_snapshot: 'net30', token: randomUUID(),
      }).returning('id');
      statementIds.push(statement.id);
      await db('invoices').where({ id: invoiceId }).update({ payer_statement_id: statement.id });
      const { result, sawAdvisoryWait } = await raceWriteAgainstCharge(termId,
        gatedWrite((trx) => acquireTermiteGateForStatement(trx, statement.id)));
      expect(sawAdvisoryWait).toBe(true);
      expect(result).toEqual([String(termId)]);
    });
  });

  // Codex #4971 r4 P1 — no parent decision while an ACH renewal is clearing:
  // a cancel / switch of a termite parent is refused (under the gate, before
  // the write) while its renewal successor's invoice is still processing;
  // once it is no longer in motion the same cancel goes through.
  test('(D) a termite parent cannot be cancelled or switched while its renewal payment is clearing — one actionable 409; renew is unaffected', async () => {
    const { randomUUID } = require('crypto');
    const { termId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
    const parent = await db('annual_prepay_terms').where({ id: termId }).first('customer_id');
    const [renewalInvoice] = await db('invoices').insert({
      customer_id: parent.customer_id, token: randomUUID(), invoice_number: `LOCK-R-${randomUUID().slice(0, 8)}`, status: 'processing',
    }).returning('id');
    await db('annual_prepay_terms').insert({
      customer_id: parent.customer_id, term_start: '2027-01-01', term_end: '2027-12-31', status: 'payment_pending',
      annual_plan_version: 'v3', renewed_from_term_id: termId, prepay_invoice_id: renewalInvoice.id,
    });

    for (const action of ['cancel', 'switch_plan']) {
      await expect(recordDecision({ termId, action })).rejects.toMatchObject({
        code: 'renewal_money_in_motion', statusCode: 409,
        message: expect.stringContaining('wait for it to settle or refund it first'),
      });
    }
    expect(await db('annual_prepay_terms').where({ id: termId }).first('status', 'renewal_decision')).toEqual({ status: 'active', renewal_decision: null });

    // The debit failed back to an open invoice — nothing in motion: the cancel is allowed.
    await db('invoices').where({ id: renewalInvoice.id }).update({ status: 'sent' });
    await expect(recordDecision({ termId, action: 'cancel' })).resolves.toMatchObject({ renewal_decision: 'cancel' });
    expect(db.client.pool.numUsed()).toBe(0);
  });

  // Codex #4971 r13 P1: the paid sync activated the renewal but its parent
  // 'renewed' stamp was lost (a failed savepoint) — the parent is still
  // live and undecided. A cancel / switch is refused with the same 409 until
  // the backstop records 'renew'; after that, the ordinary rules apply.
  test('(D) a PAID renewal awaiting its parent stamp blocks a cancel / switch (409); the backstop\'s renew goes through, then cancel follows the normal rules', async () => {
    const { randomUUID } = require('crypto');
    const { termId } = await insertTerm({ annualPlanVersion: 'v3', status: 'active', withInvoice: true });
    const parent = await db('annual_prepay_terms').where({ id: termId }).first('customer_id');
    const [renewalInvoice] = await db('invoices').insert({
      customer_id: parent.customer_id, token: randomUUID(), invoice_number: `LOCK-P-${randomUUID().slice(0, 8)}`, status: 'paid', paid_at: new Date(),
    }).returning('id');
    await db('annual_prepay_terms').insert({
      customer_id: parent.customer_id, term_start: '2027-01-01', term_end: '2027-12-31', status: 'active',
      annual_plan_version: 'v3', renewed_from_term_id: termId, prepay_invoice_id: renewalInvoice.id,
    });

    for (const action of ['cancel', 'switch_plan']) {
      await expect(recordDecision({ termId, action })).rejects.toMatchObject({
        code: 'renewal_money_in_motion', statusCode: 409,
        message: 'A renewal payment was received for this plan and is still being recorded — try again shortly, or refund it first.',
      });
    }
    expect(await db('annual_prepay_terms').where({ id: termId }).first('status', 'renewal_decision')).toEqual({ status: 'active', renewal_decision: null });

    // The backstop (reconcileParentRenewedStamps) records 'renew' — never refused.
    await expect(recordDecision({ termId, action: 'renew' })).resolves.toMatchObject({ renewal_decision: 'renew' });
    // A decided parent is past recordDecision's reach (the normal guard): no 409, no write.
    await expect(recordDecision({ termId, action: 'cancel' })).resolves.toBeNull();
    expect(await db('annual_prepay_terms').where({ id: termId }).first('status', 'renewal_decision')).toEqual({ status: 'renewed', renewal_decision: 'renew' });
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
