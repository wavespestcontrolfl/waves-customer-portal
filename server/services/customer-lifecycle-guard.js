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

// A future/unresolved scheduled_services row — CANCELLABLE_STATUSES is the
// canonical "still cancellable" allowlist (cancellation-eligibility.js,
// shared with cancellation-processor.js's own sweep and the customer
// portal's upcoming-visits query). 'rescheduled' is date-EXEMPT: those rows
// keep their ORIGINAL (often past) date until SmartRebooker actions them
// back onto the calendar, so an open rebook intent counts as live
// regardless of its stale date (codex #3504 — excluding it let a second
// same-family series activate, and would let an archive/churn through
// while a rebook is still owed).
async function findLiveFutureVisit(dbh, customerId, { todayIso } = {}) {
  const { CANCELLABLE_STATUSES } = require('./cancellation-eligibility');
  const today = todayIso || require('../utils/datetime-et').etDateString();
  // Built from `.where()` (incl. its function-callback OR form) only —
  // never whereIn/whereNot/whereNotIn/whereRaw — the smallest common
  // denominator across this repo's several hand-rolled query-builder test
  // doubles, which mock different subsets of knex's chain methods; none of
  // them actually invoke a callback passed to `.where()`, so this form is
  // inert (never crashes) under every one of them and correct under real knex.
  return dbh('scheduled_services')
    .where({ customer_id: customerId })
    .where(function inCancellableStatus() {
      for (const status of CANCELLABLE_STATUSES) this.orWhere('status', status);
    })
    .where(function activeBound() {
      this.where('scheduled_date', '>=', today).orWhere('status', 'rescheduled');
    })
    .first('id', 'scheduled_date', 'status');
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
