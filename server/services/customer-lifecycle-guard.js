'use strict';

/**
 * Shared "is this customer still billing-live or getting visited" checks for
 * the customer-lifecycle writers (Stage=Churned, archive/DELETE, and the
 * duplicate-merge series check lives separately in customer-dedupe.js).
 *
 * Audit findings ADMIN-BUG-R10 / ADMIN-BUG-R14: setting pipeline_stage to
 * 'churned' or soft-deleting a customer used to touch ONLY the label
 * (churned_at / deleted_at) — active, autopay_enabled, next_charge_date, the
 * future scheduled_services rows and the active annual_prepay_terms row all
 * stayed live, so the customer kept being charged and visited. Every writer
 * that lands here now either (a) refuses with a 409 naming the still-live
 * visit/term so the operator uses "Cancel plan…" first, or (b) — for the
 * stage-flip writers only, where there is no future visit/term to strand —
 * winds the billing fields down itself, byte-identical to the fields
 * cancellation-processor.js's churn write applies (active/autopay_enabled/
 * next_charge_date), so a churn label can never coexist with a row the
 * monthly dues cron would still select.
 *
 * Deliberately NOT a call into the full cancellation-processor /
 * admin-cancellation pipeline: that engine drives Stripe refunds, prepay
 * term decisions and customer-facing timeline notes for an operator who is
 * actively working a cancellation case. A stage-dropdown flip or an archive
 * click is a much smaller admission ("this account should not still be
 * billing/scheduled") — so it refuses and points at "Cancel plan…" whenever
 * there is anything more than the bare billing flags to unwind, rather than
 * silently driving the heavier engine's side effects (refunds, comms) from a
 * click that never asked for them.
 */

const LIVE_VISIT_EXCLUDED_STATUSES = ['cancelled', 'rescheduled'];

// A future, not-yet-cancelled/rescheduled scheduled_services row — the same
// "still on the board" predicate admin-schedule.js's day view applies, minus
// the missing customers.deleted_at filter that let an archived customer's
// visit through unmarked.
async function findLiveFutureVisit(dbh, customerId, { todayIso } = {}) {
  const today = todayIso || require('../utils/datetime-et').etDateString();
  // Built from repeated `.where()` calls only (never whereNot/whereNotIn/
  // whereRaw): the smallest common denominator across this repo's several
  // hand-rolled query-builder test doubles, which mock different subsets of
  // knex's chain methods.
  let query = dbh('scheduled_services').where({ customer_id: customerId });
  for (const status of LIVE_VISIT_EXCLUDED_STATUSES) {
    query = query.where('status', '!=', status);
  }
  return query.where('scheduled_date', '>=', today).first('id', 'scheduled_date', 'status');
}

// An active annual prepay term — coverage the customer is still paying for
// (or the account still owes visits against).
async function findActivePrepayTerm(dbh, customerId) {
  return dbh('annual_prepay_terms')
    .where({ customer_id: customerId, status: 'active' })
    .first('id', 'term_end');
}

// Byte-identical to the billing fields cancellation-processor.js's churn
// write applies (active/autopay_enabled/next_charge_date) — deliberately NOT
// the gated tier/rate clear (GATE_CANCEL_FLOW_V2), which is a policy choice
// about win-back pricing this narrower stage-flip guard doesn't own.
function billingWindDownStamps() {
  return { active: false, autopay_enabled: false, next_charge_date: null };
}

module.exports = {
  findLiveFutureVisit,
  findActivePrepayTerm,
  billingWindDownStamps,
};
