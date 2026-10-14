'use strict';

// Scheduled-visit fee exposure on the visits this cancel pulls: BOTH card
// fee lanes (estimate card hold + /secure appointment card — mutually
// exclusive per visit) judged by the SAME preview helpers the dispatch
// cancel prompt uses (cardHoldCancelPreview / appointmentCardCancelPreview),
// so the operator sees the fee-or-waive choice BEFORE the money-moving
// commit, and the customer's own cancel screens show the same exposure
// (customerLateFeeFacts below). Unverifiable = fee-may-apply, never a silent
// "no fee" (a thrown preview matches the helpers' own posture); only
// fee-applying visits are listed. Rides the office approved-facts fingerprint.
const logger = require('../logger');

async function previewVisitFees(pulledVisitKeys, now = new Date()) {
  const ids = (Array.isArray(pulledVisitKeys) ? pulledVisitKeys : [])
    .map((k) => String(k).split(':')[0]).filter(Boolean);
  const visits = [];
  let unresolved = false;
  let total = 0;
  let totalKnown = true;
  for (const id of ids) {
    let fee = null;
    try {
      const CardHolds = require('../estimate-card-holds');
      const hold = await CardHolds.cardHoldCancelPreview(id, now);
      if (hold.held) {
        fee = { id, lane: 'card_hold', feeApplies: hold.feeApplies === true, feeAmount: hold.feeAmount ?? null, unresolved: hold.unresolved === true };
      } else {
        const ApptCards = require('../appointment-card-request');
        const appt = await ApptCards.appointmentCardCancelPreview(id, now);
        if (appt.secured) fee = { id, lane: 'appointment_card', feeApplies: appt.feeApplies === true, feeAmount: appt.feeAmount ?? null, unresolved: appt.unresolved === true };
      }
    } catch (err) {
      logger.warn(`[cancel-visit-fees] fee preview failed for visit ${id}: ${err.message}`);
      fee = { id, lane: null, feeApplies: true, feeAmount: null, unresolved: true };
    }
    if (!fee || !fee.feeApplies) continue;
    visits.push(fee);
    if (fee.unresolved) unresolved = true;
    if (fee.feeAmount != null && Number.isFinite(Number(fee.feeAmount))) total += Number(fee.feeAmount);
    else totalKnown = false;
  }
  return {
    applies: visits.length > 0,
    unresolved,
    total: visits.length && totalKnown ? Math.round(total * 100) / 100 : null,
    visits,
  };
}

// The facts the customer's cancel screens render (portal C1 impact):
//   lateCancelFee         the total dollars that WILL be charged, only when
//                         every fee-applying visit has a known amount, a
//                         verified window and no invoice that could make the
//                         commit skip the fee step; else null;
//   lateCancelFeeVisits   how many visits those dollars are spread over (each
//                         visit's rail charges separately, possibly on
//                         different saved cards); 0 with no firm amount;
//   lateCancelFeeMayApply true when a fee cannot be ruled out but no firm
//                         amount can be stated. It does NOT assert that any
//                         visit is inside its window — only that we could not
//                         say (unknown amount, unverified window, an invoice
//                         still attached, or a failed lookup).
// A thrown preview is may-apply for an account with visits to pull, never a
// silent "no fee" — the same posture as the per-visit helpers.
const NO_FEE = Object.freeze({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: false });
const FEE_MAY_APPLY = Object.freeze({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: true });

async function customerLateFeeFacts(pulledVisitKeys, now = new Date()) {
  const keys = Array.isArray(pulledVisitKeys) ? pulledVisitKeys : [];
  if (!keys.length) return { ...NO_FEE };
  try {
    const fees = await previewVisitFees(keys, now);
    if (!fees.applies) return { ...NO_FEE };
    // unresolved = the helpers could not VERIFY the window (an appointment-time
    // or reschedule-history read failed) even when the amount is known — the
    // commit may park that fee for office review, so never promise a charge.
    if (fees.total == null || !(fees.total > 0) || fees.unresolved) return { ...FEE_MAY_APPLY };
    // The commit skips BOTH fee rails for a visit whose invoice still holds
    // money after its void sweep (cancellation-processor invoiceMoneyOpen).
    // This read runs BEFORE any void and deliberately skips the void preview
    // (it calls Stripe): any invoice on a fee-applying visit that is not
    // already money-resolved makes the amount "may apply", not a promise.
    const InvoiceService = require('../invoice');
    for (const visit of fees.visits) {
      if (await InvoiceService.previewUnresolvedInvoiceAfterCancelVoid(visit.id)) return { ...FEE_MAY_APPLY };
    }
    return { lateCancelFee: fees.total, lateCancelFeeVisits: fees.visits.length, lateCancelFeeMayApply: false };
  } catch (err) {
    logger.warn(`[cancel-visit-fees] customer fee facts failed: ${err.message}`);
    return { ...FEE_MAY_APPLY };
  }
}

module.exports = { previewVisitFees, customerLateFeeFacts };
