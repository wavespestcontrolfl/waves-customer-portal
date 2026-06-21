const { etDateString } = require('../utils/datetime-et');
const { INTERNAL_TEST_CUSTOMERS } = require('./internal-test-customers');

// An active recurring account is "at risk" — i.e. its next monthly charge is
// NOT something the business can count on landing — when any of these is
// true as of `asOf`:
//
//   1. Service is paused (`service_paused_at` set). The monthly billing cron
//      skips these entirely — it's the terminal end-state after the autopay
//      retry ladder exhausts ('autopay_final_failure'), so the account will
//      not be charged at all. (billing-cron.js: .whereNull('service_paused_at'))
//   2. Autopay is paused. `autopay_paused_until` is in the future, so the
//      automated charge will be skipped. (A null/past pause date = not paused.)
//   3. The account is already overdue: it carries an OUTSTANDING invoice that
//      is past due (or explicitly flagged `overdue`). "Outstanding" mirrors
//      the dashboard AR query's own definition exactly — `paid_at IS NULL`
//      (paid_at, not status, is the authoritative paid signal) AND
//      status NOT IN ('void','cancelled','draft'). That EXCLUSION model is
//      used instead of an inclusion list so a paid-but-status-stale invoice
//      can't falsely flag a customer, and a future status (`unpaid`,
//      `pending`, …) that's past due is still caught. Past-due test matches
//      command-center: status='overdue' OR due_date < today.
//
// A fourth at-risk signal — annual-prepay terms in `payment_pending` (prepay
// invoice sent but unpaid) — can't be expressed against `customers` alone, so
// it's unioned in below via the billing cron's own
// getPaymentPendingCustomerIds() helper (reused, not re-implemented, so the two
// definitions can't drift).
//
// Autopay being *disabled* is deliberately NOT at-risk: many Waves customers
// are invoiced after each visit and pay on receipt, so a disabled autopay
// flag is a billing *method*, not a billing *risk*. Annual-prepay customers
// whose term is PAID/active (also skipped by the monthly cron) are likewise
// NOT at-risk — they have already paid for the period, so that revenue is
// collected, not uncertain. Only the sent-but-unpaid (payment_pending) prepay
// state is at-risk.
//
// `iv` is correlated to the outer `customers c`, so the predicate works as a
// per-row boolean and as a standalone WHERE. Two `?` bindings, both `asOf`.
const AT_RISK_PREDICATE = `(
  c.service_paused_at IS NOT NULL
  OR (
    c.autopay_enabled = true
    AND c.autopay_paused_until IS NOT NULL
    AND c.autopay_paused_until >= ?::date
  )
  OR EXISTS (
    SELECT 1 FROM invoices iv
    WHERE iv.customer_id = c.id
      AND iv.paid_at IS NULL
      AND iv.status NOT IN ('void', 'cancelled', 'draft')
      AND (iv.status = 'overdue' OR iv.due_date < ?::date)
  )
)`;

/**
 * Committed vs at-risk MRR.
 *
 * The headline "MRR" — SUM(monthly_rate) over active, non-deleted, recurring
 * customers — counts every billable account equally, including ones whose
 * next charge is not actually going to land (autopay paused, or already
 * overdue). That overstates the run-rate the business can count on.
 *
 * This splits the SAME population (active, deleted_at IS NULL,
 * monthly_rate > 0 — identical to the headline) into:
 *   - committed: monthly_rate of accounts with nothing blocking the next bill
 *   - atRisk:    monthly_rate of accounts that are service-paused, autopay-paused,
 *                overdue, or sitting on a sent-but-unpaid annual-prepay invoice
 *
 * Evaluated per-customer and reduced in JS so the annual-prepay payment-pending
 * set (which can't be expressed against `customers` alone) can be unioned in
 * without double-counting — committed then matches what the billing cron will
 * actually attempt to charge. An account is counted in at-risk AT MOST ONCE, so
 * `committed + atRisk === total` by construction. (Customer counts here are in
 * the hundreds and the calling endpoint is 60s-cached, so the per-row scan is
 * cheap.)
 *
 * @param {import('knex')} [dbConn]  Knex instance (defaults to the app db; lazy-loaded).
 * @param {string} asOf              ET calendar date (YYYY-MM-DD). Defaults to today ET.
 * @returns {Promise<{total:number, committed:number, atRisk:number, totalCount:number, atRiskCount:number}>}
 */
async function computeMrrBreakdown(dbConn, asOf = etDateString()) {
  // Lazy-require so the helper (and its tests) can load without pulling in
  // knex when a connection is injected.
  const conn = dbConn || require('../models/db');
  const { getPaymentPendingCustomerIds } = require('./annual-prepay-renewals');

  const [rows, pendingSet] = await Promise.all([
    conn('customers as c')
      .where('c.active', true)
      .whereNull('c.deleted_at')
      .where('c.monthly_rate', '>', 0)
      // Exclude internal/test accounts so they never inflate MRR — the same
      // population the live trend (excludeInternalCustomers) and the snapshot use.
      .modify((qb) => {
        if (INTERNAL_TEST_CUSTOMERS.length) {
          qb.whereNotIn(
            conn.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
            INTERNAL_TEST_CUSTOMERS,
          );
        }
      })
      .select(
        'c.id as id',
        'c.monthly_rate as monthly_rate',
        conn.raw(`(${AT_RISK_PREDICATE}) as at_risk`, [asOf, asOf]),
      ),
    // Sent-but-unpaid annual-prepay commitments — the cron suppresses their
    // monthly charge while the prepay cash hasn't landed. Reuse the cron's own
    // helper so the two definitions can't drift; fail soft to an empty set so a
    // prepay-table hiccup never blanks the dashboard MRR tile.
    Promise.resolve()
      .then(() => getPaymentPendingCustomerIds(asOf, conn))
      .catch(() => new Set()),
  ]);

  let total = 0;
  let atRisk = 0;
  let totalCount = 0;
  let atRiskCount = 0;
  for (const r of rows) {
    const rate = parseFloat(r.monthly_rate || 0);
    total += rate;
    totalCount += 1;
    // pg returns boolean columns as JS booleans; tolerate 't'/1 from other drivers.
    const sqlAtRisk = r.at_risk === true || r.at_risk === 't' || r.at_risk === 1;
    if (sqlAtRisk || pendingSet.has(String(r.id))) {
      atRisk += rate;
      atRiskCount += 1;
    }
  }
  // Clamp so float dust can never produce a negative committed figure.
  const committed = Math.max(0, total - atRisk);

  return { total, committed, atRisk, totalCount, atRiskCount };
}

module.exports = { computeMrrBreakdown, AT_RISK_PREDICATE };
