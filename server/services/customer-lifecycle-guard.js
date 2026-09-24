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
// track_state can LEAD the legacy status column (track-transitions.js flips
// track_state first and syncs `status` best-effort — a sync failure only
// logs), in BOTH directions: a tech already rolling can read track_state
// en_route/on_property while `status` still says pending/confirmed (the
// LIVE_TRACK_STATES export, cancellation-eligibility.js), and a finished or
// pulled visit can read track_state complete/cancelled while `status` lags
// behind at a live-looking value. Neither direction should trust `status`
// alone: the first must count as live even off today's date/CANCELLABLE_
// STATUSES allowlist (the tech is there NOW), and the second must NOT block
// on a stale status once the tracker itself says the work is done or gone.
const { LIVE_TRACK_STATES } = require('./cancellation-eligibility');
const TERMINAL_TRACK_STATES = ['complete', 'cancelled'];
// Terminal OPERATIONAL statuses outrank a stale live tracker: a cancel,
// skip or no-show writes `status` and syncs track_state best-effort, so a
// failed sync can leave en_route/on_property on a finished row. The
// tracking route and the cancellation processor give these statuses
// precedence the same way (GitHub Codex #4684 r9 P2).
const TERMINAL_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
// A live visit/series obligation: either an upcoming-or-in-progress
// scheduled_services row, OR a series ANCHOR still marked recurring_ongoing
// with no upcoming child seeded yet (a completed last occurrence whose next
// one the maintenance job will mint on its own schedule) — mirrors
// hasCancellableWork's two separate checks (cancellation-eligibility.js) and
// the wind-down cancellation-processor.js applies (it clears
// recurring_ongoing even on an already-completed anchor). Without the
// second leg, an account between occurrences (last visit completed, next
// one not yet seeded) would read as clean while its plan keeps running.
// The tracker-aware "this visit row is live" clause, as a `.where()`
// callback body — ONE definition shared by findLiveFutureVisit and the
// merge guard's cancelled-parent child probe (customer-dedupe.js
// cancelledParentStillLive; GitHub Codex #4684 r8 P1: its status-only copy
// missed a tracker-live child with a stale status and blocked on a
// tracker-terminal child with a stale live status). Also the canonical
// series lookup's upcoming-row probe (recurring-appointment-seeder.js
// findActiveRecurringSeries). `trackState: false` is for a schema without
// the track_state column — status/date rule only.
function whereVisitRowLive(qb, today, { trackState = true } = {}) {
  const { CANCELLABLE_STATUSES } = require('./cancellation-eligibility');
  const dateExemptStatuses = ['rescheduled', ...IN_PROGRESS_STATUSES];
  const liveTrackStatesSql = LIVE_TRACK_STATES.map(() => '?').join(', ');
  const terminalTrackStatesSql = TERMINAL_TRACK_STATES.map(() => '?').join(', ');
  qb.where(function statusDateLive() {
    this.where(function inCancellableStatus() {
      for (const status of [...CANCELLABLE_STATUSES, ...IN_PROGRESS_STATUSES]) this.orWhere('status', status);
    }).where(function activeBound() {
      this.where('scheduled_date', '>=', today);
      for (const status of dateExemptStatuses) this.orWhere('status', status);
    });
    if (trackState) this.whereRaw(`(track_state IS NULL OR track_state NOT IN (${terminalTrackStatesSql}))`, TERMINAL_TRACK_STATES);
  });
  if (trackState) {
    const terminalStatusesSql = TERMINAL_STATUSES.map(() => '?').join(', ');
    qb.orWhereRaw(
      `(track_state IN (${liveTrackStatesSql}) AND (status IS NULL OR status NOT IN (${terminalStatusesSql})))`,
      [...LIVE_TRACK_STATES, ...TERMINAL_STATUSES],
    );
  }
}

async function findLiveFutureVisit(dbh, customerId, { todayIso } = {}) {
  const today = todayIso || require('../utils/datetime-et').etDateString();
  // Built from `.where()` (incl. its function-callback OR/whereRaw form)
  // only — never whereIn/whereNot/whereNotIn — the smallest common
  // denominator across this repo's several hand-rolled query-builder test
  // doubles, which mock different subsets of knex's chain methods; none of
  // them actually invoke a callback passed to `.where()`, so this form is
  // inert (never crashes) under every one of them and correct under real knex.
  const [upcoming, ongoingAnchor] = await Promise.all([
    dbh('scheduled_services')
      .where({ customer_id: customerId })
      .where(function liveByStatusOrTrack() { whereVisitRowLive(this, today); })
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

// A payment_pending annual-prepay term with a still-payable (not void)
// invoice — reuses admin-cancellation.js's findPendingPrepayInvoice, the
// SAME guard "Cancel plan…" itself refuses on (refusePendingPrepayInvoices).
// coveredTermsAsOf (findActivePrepayTerm above) deliberately does NOT treat
// an unpaid payment_pending term as live coverage — nothing has been paid
// yet — but that invoice being paid LATER, after this customer is churned/
// archived, re-activates the term (annual-prepay-renewals.js's
// syncTermForInvoicePayment) with no live guard left to catch it. Refusing
// here (rather than voiding it ourselves) matches the same engine's own
// posture: the invoice tools own the void, this guard only surfaces it.
async function findPendingPrepayInvoiceConflict(dbh, customerId) {
  const { findPendingPrepayInvoice } = require('./admin-cancellation');
  // On the CALLER's connection: every churn/archive writer holds a
  // transaction + customers row lock here, so a pool checkout would wait
  // on itself under load (pre-push audit P1 on 951f966e1d).
  return findPendingPrepayInvoice(customerId, null, dbh);
}

// One-shot per-row decision for a write entering (or re-saving)
// pipeline_stage='churned', or an archive: refuse (naming what's still
// live) or WIND BILLING DOWN THROUGH THE CANONICAL OPERATION —
// cancellation-processor.js's own disarmCustomerBillingFields (customer-
// level active/autopay_enabled/next_charge_date) + disarmPaymentRails
// (payment_methods.autopay_enabled, payments.next_retry_at) — the exact
// write this processor's own churn always has, not a parallel hand-rolled
// subset. Both are unconditional/idempotent, so calling this on an
// ALREADY-churned or already-disarmed row is a safe no-op-if-clean,
// harmless-if-dirty repair — which is what lets a re-save of Churned on a
// pre-fix residue row (or a repeated archive click) self-heal it: the
// caller decides WHETHER to call this from the row's PERSISTED billing
// state (is pipeline_stage being set to 'churned', or is this an archive?),
// never from whether the stage is actually changing.
//
// The SINGLE canonical helper every churn/archive writer calls — the admin
// routes (PUT /:id, PUT /:id/stage, DELETE /:id), IB's updateCustomer, AND
// both of bulkUpdateCustomers' branches (the fast CASE path for a plain
// stage move, and the per-row path a combined stage+address/email edit
// takes) — so a bulk edit that combines a churn move with an address/email
// change gets the exact same guard the plain bulk path already had.
async function churnGuardForRow(dbh, customerId, { archive = false } = {}) {
  const [liveVisit, liveTerm, pendingPrepayInvoice] = await Promise.all([
    findLiveFutureVisit(dbh, customerId),
    findActivePrepayTerm(dbh, customerId),
    findPendingPrepayInvoiceConflict(dbh, customerId),
  ]);
  if (liveVisit || liveTerm || pendingPrepayInvoice) {
    return {
      blocked: true,
      liveVisit: liveVisit || null,
      liveTerm: liveTerm || null,
      pendingPrepayInvoice: pendingPrepayInvoice || null,
      // Short, generic wording — callers that want the fuller
      // describeLiveVisit() sentence build it themselves from liveVisit.
      error: liveVisit
        ? 'still has a scheduled visit — use "Cancel plan…" first'
        : liveTerm
          ? 'still has an active prepay term — use "Cancel plan…" first'
          : `has an unpaid annual-prepay invoice (${pendingPrepayInvoice.invoice.invoice_number || pendingPrepayInvoice.invoice.id}) that would re-activate coverage if paid — void it from the invoice tools first`,
    };
  }
  const { disarmCustomerBillingFields, disarmPaymentRails } = require('./cancellation-processor');
  // An ARCHIVE keeps `active` as it was (see disarmCustomerBillingFields):
  // deleted_at already removes the row from every charge set, and restore
  // must hand the customer back in the state they were archived in.
  await disarmCustomerBillingFields(dbh, customerId, { preserveActive: archive });
  await disarmPaymentRails(dbh, customerId);
  return { blocked: false };
}

// The one entry point every REPEATABLE churn writer calls: on a transition
// into churned, or an already-churned row whose customer-level billing is
// still live (churnGuardApplies), the full guard + wind-down; otherwise a
// RAIL-ONLY repair — payment_methods.autopay_enabled / payments.next_retry_at
// are independent charge rails the customer-level flags say nothing about
// (a legacy churn whose later rail disarm failed leaves exactly this shape —
// GitHub Codex #4684 r6 P1), so they are disarmed unconditionally, without
// any refusal, on every churn write. Never blocks an unrelated edit to a
// cleanly churned customer.
async function churnGuardOrRepair(dbh, customerId, lockedRow) {
  if (churnGuardApplies(lockedRow)) return churnGuardForRow(dbh, customerId);
  const { disarmPaymentRails } = require('./cancellation-processor');
  await disarmPaymentRails(dbh, customerId);
  return { blocked: false, railsRepairedOnly: true };
}

// Does a write of pipeline_stage='churned' need churnGuardForRow at all?
// Yes on an actual TRANSITION into churned (the fix's core case), and yes
// on an ALREADY-churned row whose customer-level billing fields are still
// live (the pre-fix residue shape the re-save self-heal exists for). No on
// an already-churned row whose billing is already wound down: Customer 360
// submits the whole form on every save, so gating unrelated edits (a phone
// or note change) on a churned customer whose paid prepay term is still
// riding out its window would 409 with "mark Churned" advice they already
// followed (pre-push fallback audit P1 on d5e0ad00a4). The payment rails
// (payment_methods/payments) are not probed here — the customer-level
// flags are the signal the dues cron and the residue audit key on.
function churnGuardApplies(row) {
  if (!row) return true;
  if (row.pipeline_stage !== 'churned') return true;
  return row.active === true || row.autopay_enabled === true || row.next_charge_date != null;
}

module.exports = {
  whereVisitRowLive,
  findLiveFutureVisit,
  describeLiveVisit,
  findActivePrepayTerm,
  churnGuardApplies,
  churnGuardForRow,
  churnGuardOrRepair,
};
