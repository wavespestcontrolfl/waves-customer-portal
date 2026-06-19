const { etDateString } = require('../utils/datetime-et');

// An active recurring account is "at risk" — i.e. its next monthly charge is
// NOT something the business can count on landing — when either of these is
// true as of `asOf`:
//
//   1. Autopay is paused. `autopay_paused_until` is in the future, so the
//      automated charge will be skipped. (A null/past pause date = not paused.)
//   2. The account is already overdue: it carries an OUTSTANDING invoice that
//      is past due (or explicitly flagged `overdue`). "Outstanding" mirrors
//      the dashboard AR query's own definition exactly — `paid_at IS NULL`
//      (paid_at, not status, is the authoritative paid signal) AND
//      status NOT IN ('void','cancelled','draft'). That EXCLUSION model is
//      used instead of an inclusion list so a paid-but-status-stale invoice
//      can't falsely flag a customer, and a future status (`unpaid`,
//      `pending`, …) that's past due is still caught. Past-due test matches
//      command-center: status='overdue' OR due_date < today.
//
// Autopay being *disabled* is deliberately NOT at-risk: many Waves customers
// are invoiced after each visit and pay on receipt, so a disabled autopay
// flag is a billing *method*, not a billing *risk*.
//
// `iv` is correlated to the outer `customers c`, so the predicate works both
// inside a SUM(...) FILTER and as a standalone WHERE. Two `?` bindings, both
// `asOf`.
const AT_RISK_PREDICATE = `(
  (
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
 *   - atRisk:    monthly_rate of accounts that are autopay-paused OR overdue
 *
 * An account is counted in at-risk AT MOST ONCE even when it is both paused
 * and overdue, so `committed + atRisk === total` by construction.
 *
 * @param {import('knex')} [dbConn]  Knex instance (defaults to the app db; lazy-loaded).
 * @param {string} asOf              ET calendar date (YYYY-MM-DD). Defaults to today ET.
 * @returns {Promise<{total:number, committed:number, atRisk:number, totalCount:number, atRiskCount:number}>}
 */
async function computeMrrBreakdown(dbConn, asOf = etDateString()) {
  // Lazy-require so the helper (and its tests) can load without pulling in
  // knex when a connection is injected.
  const conn = dbConn || require('../models/db');
  const row = await conn('customers as c')
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .where('c.monthly_rate', '>', 0)
    .select(
      conn.raw('COALESCE(SUM(c.monthly_rate), 0) as total'),
      conn.raw('COUNT(*) as total_count'),
      conn.raw(`COALESCE(SUM(c.monthly_rate) FILTER (WHERE ${AT_RISK_PREDICATE}), 0) as at_risk`, [asOf, asOf]),
      conn.raw(`COUNT(*) FILTER (WHERE ${AT_RISK_PREDICATE}) as at_risk_count`, [asOf, asOf]),
    )
    .first();

  const total = parseFloat(row?.total || 0);
  const atRisk = parseFloat(row?.at_risk || 0);
  // Clamp so float dust can never produce a negative committed figure.
  const committed = Math.max(0, total - atRisk);

  return {
    total,
    committed,
    atRisk,
    totalCount: parseInt(row?.total_count || 0, 10),
    atRiskCount: parseInt(row?.at_risk_count || 0, 10),
  };
}

module.exports = { computeMrrBreakdown, AT_RISK_PREDICATE };
