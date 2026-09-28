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

const crypto = require('crypto');
const db = require('../models/db');
const { dateOnlyString, parseETDateTime, formatETTime } = require('../utils/datetime-et');

// Human-readable arrival window for the card (Codex round-3 P1: two
// same-day visits for the same customer are otherwise indistinguishable on
// the cancel card). Prefers the AUTHORITATIVE window_start/window_end TIME
// columns — every mover of this row (reschedule_appointment's tools.js
// writer ~3517, the rebooker, auto-dispatch) updates these, using the SAME
// date+TIME-column composition appointment-reminders.js#
// composeScheduledApptTime establishes for these exact columns
// (scheduled_date is a DATE, window_start/window_end are bare TIME
// columns — never a timezone-bearing timestamp, so this is a straight ET
// wall-clock read, not a conversion) — and falls back to the legacy
// `time_window` display label ONLY when no bounds are stored at all
// (Codex round-4 P1: the label is NOT kept in sync by every mover, so a
// visit rescheduled since the label was set would show a STALE window if
// the label won; the bounds are what actually moves).
function formatAppointmentWindow(row) {
  if (row.scheduled_date && row.window_start) {
    const datePart = row.scheduled_date instanceof Date
      ? row.scheduled_date.toISOString().slice(0, 10)
      : String(row.scheduled_date).slice(0, 10);
    const start = parseETDateTime(`${datePart}T${String(row.window_start).slice(0, 8)}`);
    if (!row.window_end) return formatETTime(start);
    const end = parseETDateTime(`${datePart}T${String(row.window_end).slice(0, 8)}`);
    return `${formatETTime(start)}–${formatETTime(end)}`;
  }
  if (row.time_window) return String(row.time_window);
  return null;
}

// Plain "line1, line2, city, state, zip"-ish label — matches
// customer-properties.js's own (unexported) propertyAddressLabel shape,
// reimplemented locally rather than reaching into that module for a
// one-line join.
function formatAddressLabel({ line1, line2, city, state, zip }) {
  return [line1, line2, city, state, zip].filter(Boolean).join(', ') || null;
}

// The visit's effective service address (Codex round-4 P1:
// switchAppointmentProperty — server/services/intelligence-bar/
// schedule-tools.js — can move a visit to a DIFFERENT saved property than
// the customer's primary one, and the card must show where the technician
// is actually going, not assume the primary). appointment-address.js's
// applyAppointmentAddress stamps service_address_line1/2/city/state/zip
// onto the row itself on every switch, and per stamped-address.js's own
// header EVERY phone booking stamps these columns — including an ordinary
// booking at the primary address — so the stamped columns are the row's
// own authoritative service address whenever present. Only a legacy/
// unstamped row (booked before this stamping existed) falls back to the
// customer's current primary address.
function effectiveAddress(row) {
  if (row.service_address_line1) {
    return formatAddressLabel({
      line1: row.service_address_line1, line2: row.service_address_line2,
      city: row.service_address_city, state: row.service_address_state, zip: row.service_address_zip,
    });
  }
  return formatAddressLabel({
    line1: row.customer_address_line1, line2: row.customer_address_line2,
    city: row.customer_city, state: row.customer_state, zip: row.customer_zip,
  });
}

// Columns that legitimately change on scheduled_services without changing
// what cancelling THIS row would do — pure operational churn, never a
// signal that the visit's identity, money effects, eligibility, window, or
// property drifted. Kept deliberately tiny, each entry justified: every
// OTHER column on the row is pinned by computeRowFingerprint below, so a
// future column that turns out to matter (the exact gap rounds 2-4 of
// Codex kept finding one more of) needs no hand-added entry here — it is
// PINNED by default, and the safe failure mode for something unforeseen is
// an over-eager "re-ask" refusal, never a silent miss.
const ROW_FINGERPRINT_DENYLIST = new Set([
  // Bumped by nearly every write to this row (including several of the
  // writers below) — a pure bookkeeping stamp, never itself an effect of
  // anything cancelling this visit does or doesn't do.
  'updated_at',
  // The tech's stop SEQUENCE for the day, rewritten by the dispatch-board
  // drag reorder (admin-dispatch.js) and the route optimizer
  // (route-reorder.js writeRouteOrderRows) independently of any change to
  // THIS visit — neither writer touches identity, money, notice, window,
  // property, or reseed eligibility.
  'route_order',
  // Tech-portal "N stops until yours" display cache, rewritten on the live
  // tracker's ~15s poll for every row sharing the tracked visit's
  // customer/technician/date/window group (stops-ahead.js) — a
  // never-increase UI floor, not a cancel effect.
  'stops_ahead_min_shown',
  'stops_ahead_shown_date',
  // Free-text operator notes. tools.js's own cancelAppointment deliberately
  // appends the operator's cancel reason with a SQL-side concat_ws against
  // the LIVE column (Codex round-1 P1) specifically so a note a DIFFERENT
  // operator appends while this card is pending SURVIVES rather than being
  // silently overwritten — that fix's whole point is that a concurrent note
  // edit is normal, unrelated churn a pending cancel must tolerate, not a
  // reason to refuse and make the operator re-ask.
  'notes',
]);

// Deterministic hash over EVERY scheduled_services column except the tiny
// denylist above (see there for why). Replaces the earlier hand-picked
// normalizeAppointmentPin/appointmentPinFingerprint identity subset
// (proposal-pins.js) for the cancel path: rounds 2 through 4 of review each
// found one more column that could drift between proposal and commit
// without being caught (appointment identity, then property, then
// recurrence flags, then the window label, then visit_id) — a
// non-converging pattern that meant a hand-picked SUBSET was the wrong
// shape of fix. Pinning the whole row (bar a small denylist of columns
// that churn for unrelated operational reasons) closes that class of gap
// structurally instead of one column at a time. Used both by
// computeCancelAppointmentImpact (the proposal/pre-check reads, outside
// any lock) and by tools.js's cancelAppointment (the SAME function,
// recomputed from the row its own FOR UPDATE lock sees, immediately
// before transitioning anything).
function computeRowFingerprint(row) {
  const picked = {};
  for (const key of Object.keys(row || {}).sort()) {
    if (ROW_FINGERPRINT_DENYLIST.has(key)) continue;
    const value = row[key];
    picked[key] = value instanceof Date ? value.toISOString() : value;
  }
  return crypto.createHash('sha256').update(stableStringify(picked)).digest('hex');
}

async function loadAppointmentFacts(scheduledServiceId) {
  // The WHOLE row (Codex round-2 through round-4 P1s — see
  // computeRowFingerprint above), read EXACTLY as tools.js's cancelAppointment
  // re-reads it under its FOR UPDATE lock — trx('scheduled_services')
  // .where('id').first() — so the two fingerprints hash the same column set.
  // Customer columns come from a SEPARATE read: joined into this query they
  // would ride into the proposal-side hash but never the locked one, and
  // every confirm would refuse as drifted.
  const serviceRow = await db('scheduled_services').where('id', scheduledServiceId).first();
  if (!serviceRow) return null;
  const customer = serviceRow.customer_id
    ? await db('customers').where('id', serviceRow.customer_id)
      .first('first_name', 'last_name', 'address_line1', 'address_line2', 'city', 'state', 'zip')
    : null;
  // Fallback address source ONLY (effectiveAddress above) — a legacy row with
  // no stamped service_address_* uses the customer's current primary address.
  const row = {
    ...serviceRow,
    first_name: customer?.first_name ?? null,
    last_name: customer?.last_name ?? null,
    customer_address_line1: customer?.address_line1 ?? null,
    customer_address_line2: customer?.address_line2 ?? null,
    customer_city: customer?.city ?? null,
    customer_state: customer?.state ?? null,
    customer_zip: customer?.zip ?? null,
  };
  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null;
  return {
    facts: {
      id: row.id,
      status: row.status || null,
      scheduled_date: row.scheduled_date ? dateOnlyString(row.scheduled_date) : null,
      service_type: row.service_type || null,
      customer_name: customerName,
      // Human-readable arrival window (Codex round-3/round-4 P1) — see
      // formatAppointmentWindow above. Pinned automatically: part of the
      // impact object cancelImpactsMatch already compares.
      window: formatAppointmentWindow(row),
      // The visit's effective service address (Codex round-4 P1) — see
      // effectiveAddress above. Also pinned automatically: a
      // switch_appointment_property mid-pending changes property_id (and
      // the stamped columns), which changes this AND the row fingerprint.
      address: effectiveAddress(row),
    },
    // A hash, not the raw row: keeps the impact object's own shape small
    // (the fingerprint is what the drift check needs, not a second copy of
    // every column's current value) while still covering the whole row.
    identityFingerprint: computeRowFingerprint(serviceRow),
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
  // A grouped visit (row.visit_id set — visit-groups.js) refuses outright
  // (Codex round-4 P2). Cancelling one member of a group runs
  // job-status.js's cancel path into visit-groups.js's handleChildTerminal,
  // which can detach the row from the group or dissolve the group's
  // remaining member entirely — a side effect this card does not disclose
  // or pin. Refusing here means that side effect never has a bar-cancelled
  // visit to reach; the visit cancels from Dispatch instead, where the
  // group screen shows it.
  if (row.visit_id) refusals.push('grouped_visit');
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
  // The whole-row identity fingerprint (see computeRowFingerprint's own
  // header) — tools.js's cancelAppointment recomputes this from the row
  // its own FOR UPDATE lock sees, immediately before transitioning
  // anything, and refuses on any mismatch from the frozen proposal.
  computeRowFingerprint,
  _stableStringify: stableStringify,
};
