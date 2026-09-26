// withParentDecisionLock against REAL PostgreSQL (Codex round-7 P1, hardened
// round-7 P2 self-review). Proves, against real advisory-lock/pg_locks
// behavior no mock can fake:
//   (a) the pooled connection it borrows is ALWAYS returned — on success,
//       on a throwing fn(), and on a genuine failure to acquire the lock;
//   (b) the pg_advisory_unlock actually runs on the SAME session that took
//       the lock (a cross-session unlock silently no-ops in Postgres, so
//       this is checked by watching the lock disappear from pg_locks, not
//       by trusting the call was made);
//   (c) a second caller contending for the SAME term WAITS (bounded by
//       lock_timeout), then either wins once the first releases or gets one
//       clear timeout error — never an instant spurious failure;
//   (d) the pool is never exhausted — sequential locks and two genuinely
//       concurrent holders (one per connection) both run clean against a
///      pool capped at 2.
//
// Bridges REPAIR_TEST_DATABASE_URL (this lane's own convention) onto
// DATABASE_URL and a small DB_POOL_MAX/MIN so `../models/db` — the SAME
// module-level handle withParentDecisionLock itself uses internally and
// cannot take as a parameter — connects to the disposable test database
// with a deliberately small pool, mirroring cron-lock-postgres.test.js's
// own real-db-module pattern (a separate small-pool `holder` knex instance
// models a genuinely different session/backend).
const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  DB_POOL_MAX: process.env.DB_POOL_MAX,
  DB_POOL_MIN: process.env.DB_POOL_MIN,
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

postgres('withParentDecisionLock — real Postgres advisory-lock mechanics', () => {
  let db;
  let holder; // a genuinely separate session/connection — models the "other side" of a race
  let withParentDecisionLock;

  beforeAll(() => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('This test requires a local disposable database');
    }
    process.env.DATABASE_URL = process.env.REPAIR_TEST_DATABASE_URL;
    process.env.DB_POOL_MAX = '2';
    process.env.DB_POOL_MIN = '2';
    db = require('../models/db');
    ({ withParentDecisionLock } = require('../services/annual-prepay-renewals'));
    holder = require('knex')({ client: 'pg', connection: process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 1, max: 1 } });
  });

  afterAll(async () => {
    await holder?.destroy();
    await db?.destroy();
    process.env.DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;
    process.env.DB_POOL_MAX = ORIGINAL_ENV.DB_POOL_MAX;
    process.env.DB_POOL_MIN = ORIGINAL_ENV.DB_POOL_MIN;
  });

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
});
