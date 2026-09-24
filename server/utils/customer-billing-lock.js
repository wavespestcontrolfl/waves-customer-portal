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
 * A THIRD, rollout-compatibility check runs before either lock layer:
 * during a rolling deploy, an OLD pod's retry sweep or monthly cron
 * (code that predates this whole file) has no idea this per-customer lock
 * exists, so a NEW pod's charge-now taking `billing-customer:<id>` alone
 * would not see it. Both jobs, in every version of this code (the wrapping
 * in services/scheduler.js is untouched by this file), already run inside
 * a NAMED job-level advisory lock ('billing-monthly' / 'billing-retries',
 * utils/cron-lock.js's runExclusive) for their ENTIRE run — a signal
 * visible regardless of which pod's code is doing the checking. A plain
 * `pg_locks` read (lockHeldByAnySession — db.raw only, no connection
 * pinning) checks whether either job is running ANYWHERE before
 * proceeding. Callers that ARE themselves running inside one of those two
 * jobs pass `excludeJobLocks` naming their OWN job — checking it would
 * otherwise refuse every one of their own charges (the lock they hold IS
 * what's reported as "held").
 *
 * Callers MUST hold this lock across BOTH the already-collected read and
 * the charge() call — locking only the write leaves the classic
 * check-then-act race open.
 */
const db = require('../models/db');
const { runExclusive, lockHeldByAnySession } = require('./cron-lock');

const locks = new Map(); // customerId -> tail promise (never rejects)

// The two named jobs every version of this code already serializes
// cluster-wide (services/scheduler.js) — see the rollout-compatibility
// note above.
const ROLLOUT_COMPAT_JOB_LOCKS = ['billing-monthly', 'billing-retries'];

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

// Rollout-compatibility probe: is EITHER named cron job (other than the
// caller's own, if it named one) currently running on ANY pod? A plain
// pg_locks read — degrades to "not running" (false/null) on a DB hiccup or
// a test double, since the per-customer layer below is the primary defense
// and already fails closed on genuine ambiguity; this is a supplementary
// net for the old/new-pod overlap the per-customer lock alone can't see.
async function anyOtherJobRunning(excludeJobLocks) {
  const exclude = new Set(excludeJobLocks || []);
  for (const jobName of ROLLOUT_COMPAT_JOB_LOCKS) {
    if (exclude.has(jobName)) continue;
    const held = await lockHeldByAnySession(jobName).catch(() => null);
    if (held === true) return jobName;
  }
  return null;
}

async function runCrossProcessGuarded(customerId, fn, excludeJobLocks) {
  const busyJob = await anyOtherJobRunning(excludeJobLocks);
  if (busyJob) throw claimHeldElsewhereError(customerId, `job ${busyJob} is running`);

  if (!crossProcessLockCapable()) {
    // No pg connection-pinning API at all (a unit test's db double) — no
    // cross-process signal exists to trust either way. The in-process Map
    // still fences the case that matters most on this deployment shape.
    return fn();
  }
  const result = await runExclusive(crossProcessLockName(customerId), fn, {
    recordHealth: false,
    waitForSlot: false,
  });
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
