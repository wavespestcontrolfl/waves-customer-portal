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
 *  2. A best-effort CROSS-PROCESS layer for the one case the Map can't
 *     fence — a genuine second Railway instance (a deploy's old/new pod
 *     overlap) — reusing utils/cron-lock.js's runExclusive (a real
 *     pg_try_advisory_lock held on a dedicated connection, the SAME
 *     mechanism review-request.js already uses for its own per-customer
 *     dynamic lock, `review-send:<id>`) rather than inventing new
 *     connection-pinning plumbing. Non-blocking and request-scoped
 *     (waitForSlot: false, recordHealth: false — this fences an entity,
 *     not a named job). A held-elsewhere lease throws
 *     BILLING_CLAIM_HELD_ELSEWHERE so the caller can refuse/skip instead
 *     of charging; anything else runExclusive reports (no_connection — a
 *     DB hiccup, a pool without the advisory-lock connection API, or a
 *     unit test's db double) FAILS OPEN and runs fn() directly — the
 *     in-process Map above still fences the case that matters most, and a
 *     transient infra gap must never block a legitimate charge.
 *
 * Together: a duplicate that slips past BOTH layers (should never happen
 * in production) still shares a durable Stripe idempotency key with its
 * sibling caller (autopay_monthly_<customerId>_<ET date> — the SAME
 * literal key chargeMonthly() defaults to, which charge-now and the retry
 * sweep's monthly branch pass explicitly), so Stripe replays one
 * PaymentIntent and charge()'s own per-PI pg_advisory_xact_lock
 * (services/stripe.js) collapses it to one ledger row.
 *
 * Callers MUST hold this lock across BOTH the already-collected read and
 * the charge() call — locking only the write leaves the classic
 * check-then-act race open.
 */
const { runExclusive } = require('./cron-lock');

const locks = new Map(); // customerId -> tail promise (never rejects)

function crossProcessLockName(customerId) {
  return `billing-customer:${customerId}`;
}

async function runCrossProcessGuarded(customerId, fn) {
  const result = await runExclusive(crossProcessLockName(customerId), fn, {
    recordHealth: false,
    waitForSlot: false,
  });
  if (result && result.skipped === true) {
    if (result.reason === 'lease_held') {
      const err = new Error(`A collection attempt for customer ${customerId} is already in progress on another process`);
      err.code = 'BILLING_CLAIM_HELD_ELSEWHERE';
      throw err;
    }
    // no_connection: could not even attempt the cross-process lock (DB
    // unreachable, a pool without client.acquireConnection, a test
    // double). Fail OPEN — see header.
    return fn();
  }
  return result;
}

async function withCustomerBillingLock(customerId, fn) {
  const key = String(customerId);
  const prior = locks.get(key) || Promise.resolve();
  const run = prior.then(() => runCrossProcessGuarded(customerId, fn));
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
