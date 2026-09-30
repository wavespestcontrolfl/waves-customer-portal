// The no-show fee step of PUT /api/admin/dispatch/:serviceId/status (toStatus
// 'no_show'): try the flat fee on both card rails and report ONE outcome the
// customer notice and the office alert are composed from.
//
//   'none'    — no fee applies (no hold / gate off / released / waived)
//   'charged' — the fee was collected
//   'review'  — Stripe MAY have accepted it (ambiguous API error parked for
//               reconciliation), or a definite decline / thrown fee step a
//               retry may still convert: the notice must not claim "no charge"
//   'held'    — a collections DISPUTE hold (B10) refused the fee BEFORE Stripe
//               was contacted. Definite no-charge, not a failure: the customer
//               gets the ordinary no-show notice (no fee or receipt wording)
//               and the office gets an informational note, no decline alert.
//
// Never throws — the caller has already committed the status flip.

const logger = require('./logger');

const REVIEW_REASONS = ['charge_review', 'charge_failed'];
const HELD_REASON = 'collection_hold';

function outcomeFromFeeResult(result) {
  if (result?.charged === true) return 'charged';
  if (result?.reason === HELD_REASON) return 'held';
  if (REVIEW_REASONS.includes(result?.reason)) return 'review';
  return null;
}

async function bell(title, body, svc, reason) {
  try {
    await require('./notification-service').notifyAdmin('billing', title, body, {
      link: `/admin/customers?customerId=${svc.customer_id}`,
      metadata: { scheduledServiceId: svc.id, reason },
    });
  } catch (notifyErr) {
    logger.warn(`[admin-dispatch] no-show fee alert failed: ${notifyErr.message}`);
  }
}

async function runNoShowFeeStep({ svc }) {
  let outcome = 'none';
  try {
    const CardHolds = require('./estimate-card-holds');
    const feeResult = await CardHolds.chargeNoShowFee({ scheduledServiceId: svc.id, reason: 'no_show' });
    // charge_failed is RETRYABLE — the claim reverts to NULL and a later
    // attempt may still collect (Codex #3153 r24 P0): the customer notice
    // must use the cautious review copy, never an unequivocal "no charge".
    outcome = outcomeFromFeeResult(feeResult);
    if (!outcome) {
      outcome = 'none';
      // Appointment-card fee rail fallback: visits secured via /secure carry
      // the disclosed fee on appointment_card_requests instead of a hold row
      // (mutually exclusive lanes — the rail re-checks). Runs only when the
      // hold rail saw nothing chargeable for lane reasons (no hold, or the
      // hold flag itself is off).
      if (['no_hold', 'feature_disabled'].includes(feeResult?.reason)) {
        const ApptCardRequests = require('./appointment-card-request');
        const apptFeeResult = await ApptCardRequests.chargeAppointmentNoShowFee({ scheduledServiceId: svc.id, reason: 'no_show' });
        outcome = outcomeFromFeeResult(apptFeeResult) || 'none';
      }
    }
    if (outcome === 'review') {
      await bell(
        'No-show fee needs review',
        'The no-show fee did not settle cleanly (declined or parked) — review the customer\'s billing; a retry may still charge.',
        svc,
        'fee_unsettled',
      );
    } else if (outcome === 'held') {
      // Informational, not a failure: nothing was attempted, so there is
      // nothing to reconcile. The hold itself is already on the customer's
      // billing surfaces.
      await bell(
        'No-show fee not charged — customer has a collections dispute hold',
        'The no-show fee was not charged because the customer has an active collections dispute hold. No charge was attempted, and the customer got the ordinary no-show notice with no fee wording.',
        svc,
        'fee_held_collections_dispute',
      );
    }
  } catch (e) {
    // A THROWN fee step means lane ownership was never resolved (Codex #3153
    // r21 P1) — a retry can still charge, so the customer notice must use the
    // cautious review copy, never an unequivocal "no charge", and the office
    // needs to hear about it.
    outcome = 'review';
    logger.error(`[admin-dispatch] no-show card-hold fee charge failed — outcome parked review: ${e.message}`);
    await bell(
      'No-show fee needs review',
      'The no-show fee step errored before lane ownership was resolved — review the customer\'s billing; a fee may still apply.',
      svc,
      'fee_step_error',
    );
  }
  return outcome;
}

module.exports = { runNoShowFeeStep, outcomeFromFeeResult };
