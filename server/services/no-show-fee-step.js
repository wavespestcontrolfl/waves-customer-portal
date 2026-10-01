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
const { raiseAdminAlert } = require('./admin-alert-compose');

const REVIEW_REASONS = ['charge_review', 'charge_failed'];
const HELD_REASON = 'collection_hold';

function outcomeFromFeeResult(result) {
  if (result?.charged === true) return 'charged';
  if (result?.reason === HELD_REASON) return 'held';
  if (REVIEW_REASONS.includes(result?.reason)) return 'review';
  return null;
}

// Office alerts follow docs/admin-notifications.md: raised through raiseAdminAlert
// (composed headline / why / link / subject / done-when), never a raw notifyAdmin.
const ALERTS = {
  fee_unsettled: {
    action: 'review a no-show fee that did not settle',
    why: 'The fee was declined or parked, and a retry may still charge the card.',
    doneWhen: 'fee_reconciled',
  },
  fee_step_error: {
    action: 'review a no-show fee step that errored',
    why: 'The fee step failed before it knew which card rail applies, so a fee may still apply.',
    doneWhen: 'fee_reconciled',
  },
  fee_held_collections_dispute: {
    action: 'decide on a no-show fee held by a dispute',
    why: 'No-show fee not charged yet — customer has a collections dispute hold; decide after the dispute is resolved.',
    doneWhen: 'no_show_fee_decided',
  },
};

async function bell(svc, reason) {
  try {
    const alert = ALERTS[reason];
    await raiseAdminAlert('billing', {
      area: 'Billing',
      action: alert.action,
      why: alert.why,
      severity: 'needs-you',
      link: `/admin/customers?customerId=${svc.customer_id}`,
      subject: { type: 'visit', id: svc.id },
      doneWhen: alert.doneWhen,
      who: 'person',
    }, {
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
      await bell(svc, 'fee_unsettled');
    } else if (outcome === 'held') {
      // Informational, not a failure: nothing was attempted, so there is
      // nothing to reconcile. The hold itself is already on the customer's
      // billing surfaces.
      await bell(svc, 'fee_held_collections_dispute');
    }
  } catch (e) {
    // A THROWN fee step means lane ownership was never resolved (Codex #3153
    // r21 P1) — a retry can still charge, so the customer notice must use the
    // cautious review copy, never an unequivocal "no charge", and the office
    // needs to hear about it.
    outcome = 'review';
    logger.error(`[admin-dispatch] no-show card-hold fee charge failed — outcome parked review: ${e.message}`);
    await bell(svc, 'fee_step_error');
  }
  return outcome;
}

module.exports = { runNoShowFeeStep, outcomeFromFeeResult };
