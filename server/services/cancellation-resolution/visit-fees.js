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

// The two facts the customer's cancel screens render (portal C1 impact):
//   lateCancelFee         the dollars that WILL be charged when every
//                         fee-applying visit has a known amount AND a
//                         verified window, else null;
//   lateCancelFeeMayApply true when a fee applies (or cannot be ruled out)
//                         but the amount is not known.
// A thrown preview is fee-may-apply for an account with visits to pull, never
// a silent "no fee" — the same posture as the per-visit helpers.
async function customerLateFeeFacts(pulledVisitKeys, now = new Date()) {
  const keys = Array.isArray(pulledVisitKeys) ? pulledVisitKeys : [];
  if (!keys.length) return { lateCancelFee: null, lateCancelFeeMayApply: false };
  try {
    const fees = await previewVisitFees(keys, now);
    if (!fees.applies) return { lateCancelFee: null, lateCancelFeeMayApply: false };
    // unresolved = the helpers could not VERIFY the window (an appointment-time
    // or reschedule-history read failed) even when the amount is known — the
    // commit may park that fee for office review, so never promise a charge.
    return fees.total != null && fees.total > 0 && !fees.unresolved
      ? { lateCancelFee: fees.total, lateCancelFeeMayApply: false }
      : { lateCancelFee: null, lateCancelFeeMayApply: true };
  } catch (err) {
    logger.warn(`[cancel-visit-fees] customer fee facts failed: ${err.message}`);
    return { lateCancelFee: null, lateCancelFeeMayApply: true };
  }
}

module.exports = { previewVisitFees, customerLateFeeFacts };
