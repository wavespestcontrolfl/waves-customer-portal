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
    .first('s.id', 's.status', 's.scheduled_date', 's.service_type', 'c.first_name', 'c.last_name');
  if (!row) return null;
  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null;
  return {
    id: row.id,
    status: row.status || null,
    scheduled_date: row.scheduled_date ? dateOnlyString(row.scheduled_date) : null,
    service_type: row.service_type || null,
    customer_name: customerName,
  };
}

// The single-visit analog of admin-cancellation.previewVisitFees (which
// previews fee exposure across a LIST of visits pulled by a plan cancel) —
// same two rail helpers, same merge, for exactly one visit. Returns the
// shape authorization-contract.js's cancel_appointment effects branch reads:
// { applies, amount, unresolved, rail, hold_disposition }.
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
  const holdDisposition = (rail === 'card_hold' && merged.feeApplies !== true)
    ? CardHolds.cardHoldCancelDisposition(merged)
    : null;

  return {
    applies: merged.feeApplies === true,
    amount: merged.feeAmount != null && Number.isFinite(Number(merged.feeAmount)) ? Number(merged.feeAmount) : null,
    unresolved: merged.unresolved === true,
    rail,
    hold_disposition: holdDisposition,
  };
}

// The fee fields the follow-through re-derives at the cancellation instant
// and compares against the pinned card before any card rail runs.
function cancelFeesMatch(a, b) {
  if (!a || !b) return false;
  return ['applies', 'amount', 'unresolved', 'rail', 'hold_disposition']
    .every((k) => (a[k] ?? null) === (b[k] ?? null));
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
  const appointment = await loadAppointmentFacts(scheduledServiceId);
  if (!appointment) return null;

  const InvoiceService = require('./invoice');
  const InspectionCredit = require('./inspection-credit');

  const [railFee, invoiceRows] = await Promise.all([
    previewCancelFee(scheduledServiceId, now),
    InvoiceService.previewInvoiceVoidForCancelledService(scheduledServiceId),
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

  return {
    appointment,
    fee,
    invoices: (invoiceRows || []).map((inv) => ({
      id: inv.id,
      invoice_number: inv.invoice_number || null,
      status: inv.status,
      total: inv.total,
      credit_applied: inv.credit_applied,
      deposit_credit: inv.deposit_credit,
    })),
    inspection_credit_reversal: creditReversal,
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
  cancelFeesMatch,
  _stableStringify: stableStringify,
};
