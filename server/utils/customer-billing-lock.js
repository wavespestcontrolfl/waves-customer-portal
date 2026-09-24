/**
 * Per-customer serialization for "already collected this period?"
 * check-then-charge sequences (ADMIN-BUG-R11).
 *
 * Everything that can charge a customer's saved card off-session for a
 * period of dues — the Customer 360 "Charge now" button
 * (admin-billing-health.js), the daily autopay-dues cron's per-customer
 * loop, and its retry sweep's monthly-obligation charge (both
 * billing-cron.js) — must serialize on the SAME customer key so none of
 * the three can charge a month a sibling just collected.
 *
 * Two layers:
 *
 *  1. An in-process async mutex (the Map below) — free, and closes the
 *     overwhelmingly common case on this codebase's deployment shape:
 *     every one of the three collectors above runs in-process on the SAME
 *     Railway web dyno (see utils/cron-lock.js's header), so two admin
 *     tabs/operators, a duplicated request, or a "Charge now" click
 *     landing while the 8 AM cron or 10 AM retry sweep is mid-charge for
 *     that SAME customer are all serialized here. The second caller's
 *     callback runs only after the first's fully settles, so it sees the
 *     ledger row the first call just wrote and can refuse instead of
 *     charging again.
 *
 *  2. A CROSS-PROCESS layer for the one case the Map can't fence — a
 *     genuine second Railway instance (a deploy's old/new pod overlap) —
 *     reusing utils/cron-lock.js's runExclusive (a real
 *     pg_try_advisory_lock held on a dedicated connection, the SAME
 *     mechanism review-request.js already uses for its own per-customer
 *     dynamic lock, `review-send:<id>`) rather than inventing new
 *     connection-pinning plumbing. Non-blocking and request-scoped
 *     (waitForSlot: false, recordHealth: false — this fences an entity,
 *     not a named job).
 *
 *     Fails CLOSED whenever this process is capable of the technique (a
 *     real db.client with the pg connection-pinning API): a held-elsewhere
 *     lease, a holder-slot cap hit, or a connection-acquire failure all
 *     throw BILLING_CLAIM_HELD_ELSEWHERE — every one of them means "this
 *     process could not confirm it is the only collector for this
 *     customer right now," and continuing unlocked is exactly the
 *     double-charge risk this layer exists to close, whether the OTHER
 *     side is a confirmed holder or unprovable under load. Each of the
 *     three collectors treats it as a retryable/deferrable refusal, never
 *     a charge failure.
 *
 *     Fails OPEN only when the technique is unavailable at all — no
 *     db.client, or no acquireConnection/releaseConnection on it (a unit
 *     test's db double; never a real Postgres pool) — since there is then
 *     no cross-process signal to trust either way, and the in-process Map
 *     above still fences the case that matters most on this deployment
 *     shape.
 *
 * Together: a duplicate that slips past BOTH layers (should never happen
 * in production) still shares a durable Stripe idempotency key with its
 * sibling caller (autopay_monthly_<customerId>_<ET date> — the SAME
 * literal key chargeMonthly() defaults to, which charge-now and the retry
 * sweep's monthly branch pass explicitly for a customer's FIRST attempt
 * that day), so Stripe replays one PaymentIntent and charge()'s own
 * per-PI pg_advisory_xact_lock (services/stripe.js) collapses it to one
 * ledger row.
 *
 * A THIRD, rollout-compatibility layer runs INSIDE the second: during a
 * rolling deploy, an OLD pod's retry sweep or monthly cron (code that
 * predates this whole file) has no idea this per-customer lock exists, so
 * a NEW pod's charge-now taking `billing-customer:<id>` alone would not
 * see it. Both jobs, in every version of this code (the wrapping in
 * services/scheduler.js is untouched by this file), already run inside a
 * NAMED job-level advisory lock ('billing-monthly' / 'billing-retries',
 * utils/cron-lock.js's runExclusive, via its own UNMODIFIED
 * pg_try_advisory_lock) for their ENTIRE run — a signal visible
 * regardless of which pod's code is doing the checking.
 *
 * A one-time snapshot of "is that job running right now?" cannot close
 * this: the old pod's job can start its OWN exclusive acquisition in the
 * gap between the snapshot and the actual charge. Instead, for the WHOLE
 * duration of the customer-scoped operation, this layer holds a
 * pg_try_advisory_lock_SHARED on each non-excluded job's exact key — on
 * the SAME connection already holding the `billing-customer:<id>`
 * exclusive lock (utils/cron-lock.js's getHeldConnection(), set via
 * runExclusive's AsyncLocalStorage context). Postgres advisory locks make
 * shared and exclusive holders on the SAME key mutually exclusive, so:
 *   - if a job is CURRENTLY running (holds its lock exclusively)
 *     anywhere, the shared acquire fails immediately and this layer
 *     refuses rather than let the charge proceed unfenced;
 *   - once this layer holds the shared lock, an old pod's job cannot
 *     START — its own unmodified pg_try_advisory_lock call fails and it
 *     skips that tick, exactly like a same-version instance overlap
 *     already does — until this operation releases it.
 * No old-pod code needs to know this file exists; it only ever calls the
 * pg_try_advisory_lock it already called before this PR. Callers that ARE
 * themselves running inside one of those two jobs pass `excludeJobLocks`
 * naming their OWN job — taking a lock this session already holds
 * exclusively would deadlock against itself.
 *
 * Callers MUST hold this lock across BOTH the already-collected read and
 * the charge() call — locking only the write leaves the classic
 * check-then-act race open.
 *
 * ONLY 'billing-retries' is held this way (Codex round-2 push review, a
 * SECOND P1 on top of the one above): services/scheduler.js's OWN
 * runExclusive('billing-monthly', processMonthlyBilling) is a single
 * non-blocking pg_try_advisory_lock over the ENTIRE function — it has no
 * way to tell "a customer op's compatibility claim is held" apart from "a
 * genuine competing instance of this exact job is already running", so a
 * held shared lock on 'cron:billing-monthly' makes the 8 AM tick itself
 * report lease_held and skip processMonthlyBilling ENTIRELY — not just
 * the one contended customer. That's a fresh, single tick's WHOLE
 * cohort silently missed, with nothing to recover it: the per-customer
 * deferred-retry-row logic added for lock CONTENTION lives inside
 * processMonthlyBilling and never runs if the job never starts, and
 * isBillingDayMatch only matches a given customer once a month, so the
 * miss stands until next month. That failure mode is worse than the
 * narrow double-charge this layer exists to close.
 *
 * 'billing-retries' does not have this asymmetry: if ITS tick reports
 * lease_held and skips, every armed row it would have picked up simply
 * stays armed (next_retry_at unchanged) and is picked up by the very next
 * day's sweep — a bounded, self-healing one-day delay, not a permanent
 * loss. So 'billing-retries' stays in the compatibility set (closing the
 * exact cross-pod race named in the round-2 finding, which used
 * billing-retries as its own example) while 'billing-monthly' is
 * deliberately left out. The residual exposure this trades away — a true
 * simultaneous cross-pod race for the SAME customer on their monthly
 * billing_day specifically — is still narrowed by the per-customer
 * `billing-customer:<id>` lock (same-version overlaps) and by the shared
 * bare Stripe idempotency key both charge-now and the monthly cron use
 * for a customer's first attempt of the day (retry-collectibility.js's
 * deriveMonthlyChargeIdempotencyKey) collapsing a genuine simultaneous
 * first attempt to one PaymentIntent at Stripe's own layer.
 */
const db = require('../models/db');
const { runExclusive, getHeldConnection } = require('./cron-lock');

const locks = new Map(); // customerId -> tail promise (never rejects)

// Only 'billing-retries' — NOT 'billing-monthly' — see the file header's
// "ONLY 'billing-retries' is held this way" note for why holding this
// compatibility lock on 'billing-monthly' would let an unrelated
// customer op silently suppress the scheduler's own entire monthly-cohort
// tick, with no recovery until next month.
const ROLLOUT_COMPAT_JOB_LOCKS = ['billing-retries'];

function crossProcessLockName(customerId) {
  return `billing-customer:${customerId}`;
}

// True only when this process can actually pin a dedicated pg connection
// for the advisory lock (utils/cron-lock.js's own technique) — a real knex
// pg pool, never a unit test's bare db double.
function crossProcessLockCapable() {
  const client = db && db.client;
  return !!(client && typeof client.acquireConnection === 'function' && typeof client.releaseConnection === 'function');
}

function claimHeldElsewhereError(customerId, reason) {
  const err = new Error(`Could not confirm exclusive collection for customer ${customerId} (${reason}) — refusing rather than risk a duplicate charge`);
  err.code = 'BILLING_CLAIM_HELD_ELSEWHERE';
  return err;
}

// Rollout-compatibility layer — see the file header. Runs INSIDE the
// customer's own exclusive lock (called as runExclusive's fn), so
// getHeldConnection() returns the SAME session already holding it. Takes
// a pg_try_advisory_lock_shared on each non-excluded job's EXACT key
// (utils/cron-lock.js's own `cron:<jobName>` namespace) before letting the
// real fn() run, and releases them (in reverse) once it settles.
async function runUnderRolloutCompatJobLocks(customerId, fn, excludeJobLocks) {
  const exclude = new Set(excludeJobLocks || []);
  const conn = getHeldConnection();
  const heldKeys = [];
  try {
    for (const jobName of ROLLOUT_COMPAT_JOB_LOCKS) {
      if (exclude.has(jobName)) continue;
      const lockKey = `cron:${jobName}`;
      const res = await conn.query({
        text: 'SELECT pg_try_advisory_lock_shared(hashtext($1)) AS locked',
        values: [lockKey],
      });
      const locked = !!res?.rows?.[0]?.locked;
      if (!locked) throw claimHeldElsewhereError(customerId, `job ${jobName} is running`);
      heldKeys.push(lockKey);
    }
    return await fn();
  } finally {
    for (const lockKey of heldKeys.reverse()) {
      try {
        await conn.query({ text: 'SELECT pg_advisory_unlock_shared(hashtext($1))', values: [lockKey] });
      } catch (err) {
        // Session advisory locks survive pool release — if this connection
        // went back into the pool still holding a shared lock, every
        // future tick of that job would skip (lease_held) until the
        // process died. Flag it for destruction (mirrors cron-lock.js's
        // own unlock-failure handling) so the lock dies with the session.
        conn.__knex__disposed = `customer-billing-lock rollout-compat unlock failed: ${err.message}`;
      }
    }
  }
}

async function runCrossProcessGuarded(customerId, fn, excludeJobLocks) {
  if (!crossProcessLockCapable()) {
    // No pg connection-pinning API at all (a unit test's db double) — no
    // cross-process signal exists to trust either way. The in-process Map
    // still fences the case that matters most on this deployment shape.
    return fn();
  }
  // Codex round-3 P1: an error thrown by the lock INFRASTRUCTURE before
  // fn() ever starts — the customer advisory try-lock query, or the
  // rollout-compat shared-lock query — must surface as the SAME
  // BILLING_CLAIM_HELD_ELSEWHERE refusal a confirmed holder produces, not
  // as a raw DB error. Every caller already maps that code to "defer, no
  // charge was attempted"; a raw error instead falls into their ordinary
  // charge-FAILURE ladder (retry_count bumped, service possibly paused,
  // "your card failed" copy) even though Stripe was never called. Only
  // fn()'s OWN rejection may propagate unchanged — it is tagged here so
  // the two are never confused.
  let fnRejected = false;
  const tagged = async () => {
    try {
      return await fn();
    } catch (err) {
      fnRejected = true;
      throw err;
    }
  };
  let result;
  try {
    result = await runExclusive(
      crossProcessLockName(customerId),
      () => runUnderRolloutCompatJobLocks(customerId, tagged, excludeJobLocks),
      { recordHealth: false, waitForSlot: false },
    );
  } catch (err) {
    if (fnRejected) throw err;
    const held = claimHeldElsewhereError(customerId, `lock acquisition failed before the operation ran: ${err && err.message}`);
    held.cause = err;
    throw held;
  }
  if (result && result.skipped === true) {
    // Capable of the technique but could not confirm exclusivity —
    // whether a confirmed other-process holder (lease_held) or an
    // unprovable state under load (no_connection: holder-slot cap hit, or
    // the connection acquire itself failed). Fail CLOSED either way.
    throw claimHeldElsewhereError(customerId, result.reason || 'unknown');
  }
  return result;
}

async function withCustomerBillingLock(customerId, fn, { excludeJobLocks } = {}) {
  const key = String(customerId);
  const prior = locks.get(key) || Promise.resolve();
  const run = prior.then(() => runCrossProcessGuarded(customerId, fn, excludeJobLocks));
  // Never-rejecting tail so the NEXT caller's chain always proceeds, even
  // when this caller's fn() throws — a lock must not stay held forever
  // just because one holder failed.
  const settled = run.then(() => undefined, () => undefined);
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return run;
}

module.exports = { withCustomerBillingLock };
