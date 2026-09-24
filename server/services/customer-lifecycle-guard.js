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

// A future/unresolved OR in-progress scheduled_services row.
// CANCELLABLE_STATUSES (cancellation-eligibility.js, shared with
// cancellation-processor.js's own sweep and the customer portal's
// upcoming-visits query) is the "still cancellable" allowlist — but
// cancellation eligibility is narrower than lifecycle liveness: an
// en_route/on_site visit is not something a cancel would touch (the tech is
// already rolling), yet it is definitely still live for an archive/churn
// refusal, so those two statuses are added on top, date-exempt like
// 'rescheduled' (an in-progress visit stays live across a midnight
// boundary — findActiveRecurringSeries applies the same exemption).
// 'rescheduled' rows keep their ORIGINAL (often past) date until
// SmartRebooker actions them back onto the calendar, so an open rebook
// intent counts as live regardless of its stale date (codex #3504 —
// excluding it let a second same-family series activate, and would let an
// archive/churn through while a rebook is still owed).
const IN_PROGRESS_STATUSES = ['en_route', 'on_site'];
// A live visit/series obligation: either an upcoming-or-in-progress
// scheduled_services row, OR a series ANCHOR still marked recurring_ongoing
// with no upcoming child seeded yet (a completed last occurrence whose next
// one the maintenance job will mint on its own schedule) — mirrors
// hasCancellableWork's two separate checks (cancellation-eligibility.js) and
// the wind-down cancellation-processor.js applies (it clears
// recurring_ongoing even on an already-completed anchor). Without the
// second leg, an account between occurrences (last visit completed, next
// one not yet seeded) would read as clean while its plan keeps running.
async function findLiveFutureVisit(dbh, customerId, { todayIso } = {}) {
  const { CANCELLABLE_STATUSES } = require('./cancellation-eligibility');
  const today = todayIso || require('../utils/datetime-et').etDateString();
  // Built from `.where()` (incl. its function-callback OR form) only —
  // never whereIn/whereNot/whereNotIn/whereRaw — the smallest common
  // denominator across this repo's several hand-rolled query-builder test
  // doubles, which mock different subsets of knex's chain methods; none of
  // them actually invoke a callback passed to `.where()`, so this form is
  // inert (never crashes) under every one of them and correct under real knex.
  const dateExemptStatuses = ['rescheduled', ...IN_PROGRESS_STATUSES];
  const [upcoming, ongoingAnchor] = await Promise.all([
    dbh('scheduled_services')
      .where({ customer_id: customerId })
      .where(function inLiveStatus() {
        for (const status of [...CANCELLABLE_STATUSES, ...IN_PROGRESS_STATUSES]) this.orWhere('status', status);
      })
      .where(function activeBound() {
        this.where('scheduled_date', '>=', today);
        for (const status of dateExemptStatuses) this.orWhere('status', status);
      })
      .first('id', 'scheduled_date', 'status'),
    dbh('scheduled_services')
      .where({ customer_id: customerId, recurring_ongoing: true })
      .first('id', 'service_type', 'scheduled_date', 'status'),
  ]);
  if (upcoming) return { ...upcoming, liveReason: 'upcoming_visit' };
  if (ongoingAnchor) return { ...ongoingAnchor, liveReason: 'ongoing_series' };
  return null;
}

// One phrase for every writer that refuses on findLiveFutureVisit's result —
// an ongoing series anchor reads differently than a dated upcoming visit
// (its own scheduled_date may be a past, already-completed occurrence).
function describeLiveVisit(liveVisit) {
  if (liveVisit.liveReason === 'ongoing_series') {
    return 'This customer has an ongoing recurring plan that will keep scheduling visits';
  }
  const date = liveVisit.scheduled_date instanceof Date
    ? liveVisit.scheduled_date.toISOString().slice(0, 10)
    : liveVisit.scheduled_date;
  return `This customer still has a scheduled visit on ${date}`;
}

// A term with still-valid paid coverage that has not yet fully lapsed —
// reuses coveredTermsAsOf (annual-prepay-renewals.js), the SAME canonical
// "is this term's paid coverage live" predicate cancellation-eligibility.js's
// hasCancellableWork calls with today's date, but called with a null
// coverage date (its own documented "audit" mode: every term with
// still-valid paid coverage regardless of window) PLUS an explicit
// term_end >= today floor. Neither of coveredTermsAsOf's two modes alone is
// right here: passing today's date requires term_start <= today too, so a
// renewal term paid in advance (term_start tomorrow, no scheduled_services
// row seeded yet to catch it independently) reads as clean; passing null
// with no floor at all resurrects a fully-lapsed historical term (paid,
// decided, but its term_end long past) as a permanent block with nothing
// left to cancel. A narrower status='active' check would also miss a
// renewal_pending term or a decided (renewed/switch_plan) term still riding
// out its already-paid window.
async function findActivePrepayTerm(dbh, customerId) {
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  const today = require('../utils/datetime-et').etDateString();
  return coveredTermsAsOf(dbh, null)
    .where('t.customer_id', customerId)
    .where('t.term_end', '>=', today)
    .first('t.id as id', 't.term_end as term_end', 't.status as status');
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
  describeLiveVisit,
  findActivePrepayTerm,
  billingWindDownStamps,
};
