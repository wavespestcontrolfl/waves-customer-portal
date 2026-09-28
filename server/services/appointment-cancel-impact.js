'use strict';

/**
 * Deterministic pre-commit impact preview for cancelling ONE scheduled
 * service — the single-appointment analog of cancellation-resolution/
 * impact.js (which covers a whole-account/family PLAN cancel; this covers
 * exactly the one visit visit-cancellation-followthrough.js's
 * runVisitCancellationFollowThrough acts on).
 *
 * Computes exactly what that follow-through would do to THIS visit right
 * now — the late-cancel fee, which invoices would be voided, and any
 * inspection-credit reversal — using the SAME canonical rule engines the
 * rails call at commit, never a forked copy:
 *   - fee: estimate-card-holds.cardHoldCancelPreview +
 *     appointment-card-request.appointmentCardCancelPreview, merged by the
 *     EXACT function (admin-dispatch.mergeCardHoldPreviews) the Dispatch
 *     cancel screen already uses to show the operator this same fee
 *     decision before committing.
 *   - invoices: invoice.previewInvoiceVoidForCancelledService, a read-only
 *     mirror of invoice.voidOpenInvoicesForCancelledService's own
 *     candidate/skip rules (same file, same exported status constants).
 *   - inspection credit: inspection-credit.previewInspectionCreditReversalForBooking,
 *     a read-only mirror of reverseInspectionCreditForBooking's read path.
 *   - customer notice: job-status.previewCancellationNoticeVerdict, a
 *     read-only mirror of the SAME shared-writer cancellation-notice hook
 *     (GATE_CANCEL_NOTICE_HOOK) every other cancel surface goes through —
 *     'none' (the hook is off, or has nothing to claim, or this visit's
 *     notice is unconditionally suppressed) or 'may_send' (the hook may
 *     text the customer, immediately or via its own delivery-evidence
 *     retry). PR B (below) discloses this on the card rather than silently
 *     reversing the 2026-08-05 fix that added it.
 *
 * W0B (server/routes/admin-intelligence-bar.js) refused to make
 * cancel_appointment card-confirmable because these rails "settle amounts
 * by re-reading state after commit, so no contract the card shows can be
 * exact." This module is PR A of the fix: a fresh call right before the
 * pending action is proposed produces an EXACT snapshot (never a guess),
 * and cancelAppointment's commit path (server/services/intelligence-bar/
 * tools.js) recomputes the identical snapshot immediately before
 * transitioning the appointment and REFUSES if anything drifted between
 * proposal and confirm — never settles a different amount than the one
 * approved. PR B lifts the route's refusal once this has been reviewed;
 * this PR ships dark (the refusal stays, so nothing here is reachable from
 * a live IB query yet).
 */

const db = require('../models/db');
const { dateOnlyString } = require('../utils/datetime-et');

async function loadAppointmentFacts(scheduledServiceId) {
  const row = await db('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.id', scheduledServiceId)
    .first('s.id', 's.status', 's.scheduled_date', 's.service_type', 'c.first_name', 'c.last_name',
      's.is_recurring', 's.recurring_parent_id', 's.is_callback', 's.followup_included',
      // Full appointment identity (Codex round-2 P1): the display facts
      // below (status/scheduled_date/service_type/customer_name) are NOT
      // enough to pin — a same-day reschedule that keeps 'confirmed' and
      // the SAME date, or a repoint to a different customer who happens to
      // share a name, would produce an IDENTICAL impact and slip past the
      // commit-time drift check. These extra columns feed
      // normalizeAppointmentPin/appointmentPinFingerprint below — the SAME
      // identity fingerprint reschedule_appointment's own proposal pin
      // already trusts (proposal-pins.js), reused rather than a second
      // definition of "this appointment" that could drift from it.
      's.customer_id', 's.time_window', 's.window_start', 's.window_end',
      's.estimated_duration_minutes', 's.technician_id', 's.visit_id',
      's.track_state', 's.en_route_at', 's.arrived_at', 's.actual_start_time',
      's.check_in_time', 's.track_sms_sent_at', 's.arrival_sms_sent_at');
  if (!row) return null;
  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null;
  const { normalizeAppointmentPin, appointmentPinFingerprint } = require('./intelligence-bar/proposal-pins');
  return {
    facts: {
      id: row.id,
      status: row.status || null,
      scheduled_date: row.scheduled_date ? dateOnlyString(row.scheduled_date) : null,
      service_type: row.service_type || null,
      customer_name: customerName,
    },
    // A hash, not the raw pin object: matches every other pin in this
    // codebase (reschedule/price-approval/email), and keeps this shape
    // small — the fingerprint is what the drift check needs, not a second
    // copy of every field's current value.
    identityFingerprint: appointmentPinFingerprint(normalizeAppointmentPin(row)),
    row,
  };
}

// The single-visit analog of admin-cancellation.previewVisitFees (which
// previews fee exposure across a LIST of visits pulled by a plan cancel) —
// same two rail helpers, same merge, for exactly one visit. Returns the
// shape authorization-contract.js's cancel_appointment effects branch reads:
// { applies, amount, unresolved, rail }. A card-confirmed cancel requires
// rail 'none' (see cardCancelRefusals), so no hold disposition is needed.
async function previewCancelFee(scheduledServiceId, now) {
  const CardHolds = require('./estimate-card-holds');
  const ApptCardRequests = require('./appointment-card-request');
  // Lazy require (established pattern — see call-reschedule-apply.js,
  // rain-out.js, reschedule-sms.js): admin-dispatch is a route module, and
  // a top-level require here would risk a load-order cycle.
  const { mergeCardHoldPreviews } = require('../routes/admin-dispatch');

  // The rail previews report their own unverifiable lane state as
  // `unresolved` (kept, and stated on the card). A THROW is different: the
  // verdict is unknown, so it propagates and the whole impact is
  // undeterminable.
  const holdPreview = await CardHolds.cardHoldCancelPreview(scheduledServiceId, now);
  const merged = await mergeCardHoldPreviews(holdPreview, () => ApptCardRequests.appointmentCardCancelPreview(scheduledServiceId, now));

  // mergeCardHoldPreviews returns EITHER the exact holdPreview object it was
  // given, or a freshly-built apptShape(...) object — reference equality is
  // how we know which rail's verdict won, without re-deriving that decision.
  const wonByHold = merged === holdPreview;
  const rail = wonByHold
    ? (holdPreview.held ? 'card_hold' : 'none')
    : (merged.held ? 'appointment_card' : 'none');

  return {
    applies: merged.feeApplies === true,
    amount: merged.feeAmount != null && Number.isFinite(Number(merged.feeAmount)) ? Number(merged.feeAmount) : null,
    unresolved: merged.unresolved === true,
    rail,
  };
}

// True only when the rails say, readably, that no card fee agreement exists.
function feeRailClear(fee) {
  return fee.rail === 'none' && fee.applies !== true && fee.unresolved !== true;
}

// Owner ruling 2026-09-28 (simple visits only): the bar confirms a cancel
// only when none of these apply; each is a cancel side effect the card does
// not pin, so the visit is cancelled from Dispatch instead. Sorted codes, so
// the frozen impact (and its drift comparison) covers the verdict too.
function cardCancelRefusals({ row, fee, invoices, inspectionCreditReversal }) {
  const refusals = [];
  // Any card rail, any fee, or a card lane state that could not be read.
  if (!feeRailClear(fee)) refusals.push('card_fee_agreement');
  if (invoices.some((inv) => inv.payment_intent)) refusals.push('card_payment_on_invoice');
  if (invoices.some((inv) => Number(inv.deposit_credit) > 0)) refusals.push('estimate_deposit');
  if (require('./recurring-series-cancel-reseed').cancelMayReseedPlan(row)) refusals.push('plan_makeup_visit');
  // Money already collected on an invoice the void preview would NOT touch
  // (paid/processing/on a finalized statement) — `card_payment_on_invoice`
  // above only covers a PaymentIntent on a would-void CANDIDATE invoice, so
  // it misses this case entirely (Codex round-1 P1). `fee.blocked_by_invoice`
  // is the SAME verdict visit-cancellation-followthrough.js's own gate acts
  // on (previewUnresolvedInvoiceAfterCancelVoid, run against the post-void
  // state) — reusing it here means the refusal and the follow-through's own
  // office-review gate can never disagree.
  if (fee.blocked_by_invoice) refusals.push('invoice_holds_money');
  // A redeemed inspection-credit offer — reversed, deferred to office
  // review, OR rebound to a live alternate booking — refuses outright
  // (Codex round-2 P1, owner's simple-visits ruling). The commit's own
  // follow-through voids/reverses only the PINNED set the card showed, but
  // inspection-credit.js's independent HOURLY sweep
  // (sweepInspectionCreditRedemptions) later re-derives ANY stale redeemed
  // offer on a non-live booking and calls voidOpenInvoicesForCancelledService
  // UNPINNED — no card, no operator approval, no way for this lane to
  // thread a skip flag into a cron that runs an hour later. A bar-cancelled
  // visit with a redeemed offer left outstanding (deferred by an unresolved
  // invoice, or a later-created/changed invoice) would let that sweep void
  // something the operator never saw. Refusing here means the sweep never
  // has a bar-cancelled booking to process at all — the visit cancels from
  // Dispatch instead, where this constraint doesn't exist.
  if (inspectionCreditReversal !== null) refusals.push('inspection_credit');
  return refusals.sort();
}

/**
 * The exact effect set cancelling `scheduledServiceId` would produce right
 * now: the appointment identity, the late-cancel fee decision, the
 * invoices that would be voided, and any inspection-credit reversal.
 * Read-only — never charges, voids, or reverses anything. Throws when any
 * part cannot be read: a failed read must never pass for "no effect", so
 * callers refuse to propose or confirm a pinned cancel on a throw.
 */
async function computeCancelAppointmentImpact(scheduledServiceId, { now = new Date() } = {}) {
  const loaded = await loadAppointmentFacts(scheduledServiceId);
  if (!loaded) return null;
  const { facts: appointment, row, identityFingerprint } = loaded;

  const InvoiceService = require('./invoice');
  const InspectionCredit = require('./inspection-credit');
  const { previewCancellationNoticeVerdict } = require('./job-status');

  const [railFee, invoiceRows, customerNotice] = await Promise.all([
    previewCancelFee(scheduledServiceId, now),
    InvoiceService.previewInvoiceVoidForCancelledService(scheduledServiceId),
    // Read-only mirror of job-status.js's real cancellation-notice hook
    // (Codex round-1 P1: the bar's card claimed cancellations never contact
    // the customer, but the shared status writer's default notice path can
    // text one — GATE_CANCEL_NOTICE_HOOK is a deliberate, existing fix, not
    // something this lane may silently reverse). 'none' | 'may_send' — see
    // previewCancellationNoticeVerdict's own header for exactly which real
    // suppression conditions it mirrors.
    previewCancellationNoticeVerdict(scheduledServiceId),
  ]);
  // The commit runs the void FIRST, then gates both later money steps on
  // what is left (visit-cancellation-followthrough.js step 1; the credit
  // reversal in voidOpenInvoicesForCancelledService's `finally`). Both
  // previews below must see that post-void state, so the invoices the void
  // would resolve are passed in as already resolved.
  const voidedInvoiceIds = (invoiceRows || []).map((inv) => inv.id);
  const [invoiceBlocksFee, creditReversal] = await Promise.all([
    InvoiceService.previewUnresolvedInvoiceAfterCancelVoid(scheduledServiceId, { voidedInvoiceIds }),
    InspectionCredit.previewInspectionCreditReversalForBooking(scheduledServiceId, { voidedInvoiceIds }),
  ]);
  // An invoice still holding money after the void makes the follow-through
  // throw before either card rail runs: no fee is charged, no hold is
  // released or parked, and the office gets the unresolved-fee alert. The
  // rail verdict is kept (the office sees what the fee would have been),
  // but `blocked_by_invoice` decides what the card says.
  const fee = { ...railFee, blocked_by_invoice: invoiceBlocksFee === true };

  const invoices = (invoiceRows || []).map((inv) => ({
    id: inv.id,
    invoice_number: inv.invoice_number || null,
    status: inv.status,
    total: inv.total,
    credit_applied: inv.credit_applied,
    deposit_credit: inv.deposit_credit,
    payment_intent: inv.payment_intent === true,
  }));

  return {
    appointment,
    fee,
    invoices,
    inspection_credit_reversal: creditReversal,
    card_cancel_refusals: cardCancelRefusals({ row, fee, invoices, inspectionCreditReversal: creditReversal }),
    customer_notice: customerNotice,
    // Full appointment identity, hashed (Codex round-2 P1) — see
    // loadAppointmentFacts above. Part of the impact object, so the
    // existing cancelImpactsMatch drift check covers it automatically: a
    // same-day reschedule (window change, same status/date) or a repoint
    // to a different customer between proposal and confirm changes this
    // hash even when every OTHER field above reads identical.
    identity_fingerprint: identityFingerprint,
  };
}

// Deterministic stringify (sorted keys) so two impacts with the same
// content always compare equal regardless of property insertion order —
// same approach as authorization-contract.js's own stableStringify.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** True when two computeCancelAppointmentImpact() results describe the identical effect set. */
function cancelImpactsMatch(a, b) {
  if (!a || !b) return a === b;
  return stableStringify(a) === stableStringify(b);
}

module.exports = {
  computeCancelAppointmentImpact,
  cancelImpactsMatch,
  previewCancelFee,
  feeRailClear,
  _stableStringify: stableStringify,
};
