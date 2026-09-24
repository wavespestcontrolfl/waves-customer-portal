/**
 * In-process per-customer serialization for "already collected this
 * period?" check-then-charge sequences (ADMIN-BUG-R11).
 *
 * Everything that can charge a customer's saved card off-session for a
 * period of dues — the Customer 360 "Charge now" button
 * (admin-billing-health.js) and the daily autopay-dues cron's per-customer
 * loop (billing-cron.js) — runs `cron.schedule` in-process on the SAME
 * Railway web dyno as the admin routes (see utils/cron-lock.js's header).
 * An in-process async mutex keyed by customer id fully serializes the
 * scenarios that actually cause a double charge on this codebase's
 * deployment shape: two admin tabs/operators, a retried/duplicated
 * request, and a "Charge now" click landing while the 8 AM dues cron or
 * 10 AM retry sweep is mid-charge for that SAME customer. The second
 * caller's callback runs only after the first's fully settles, so it sees
 * the ledger row the first call just wrote and returns "already
 * collected" instead of charging again.
 *
 * This is a same-process guard, not a cross-instance one — a genuine
 * second Railway instance (a deploy's old/new pod overlap) is NOT fenced
 * by this Map. Cross-instance safety is the durable idempotency key
 * callers pass to StripeService.charge() (manual_monthly_<cid>_<YYYY-MM>
 * / autopay_monthly_<cid>_<date>): a duplicate that slips past this lock
 * replays the SAME Stripe PaymentIntent, and charge()'s own per-PI
 * pg_advisory_xact_lock (services/stripe.js) collapses it to one ledger
 * row. Use both together, not one instead of the other.
 *
 * Callers MUST hold this lock across BOTH the already-collected read and
 * the charge() call — locking only the write leaves the classic
 * check-then-act race open.
 */

const locks = new Map(); // customerId -> tail promise (never rejects)

async function withCustomerBillingLock(customerId, fn) {
  const key = String(customerId);
  const prior = locks.get(key) || Promise.resolve();
  const run = prior.then(() => fn());
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
