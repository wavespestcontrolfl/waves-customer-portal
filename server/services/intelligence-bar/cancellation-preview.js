/**
 * Read-only preview of what cancelling a visit will DO beyond flipping its
 * status — the money and invoice obligations runVisitCancellationFollowThrough
 * carries out after commit (W0B: the authorization contract must disclose
 * every effect the Confirm authorizes; a late-cancel fee is a charge).
 *
 * Composes the rails' OWN previews (estimate card-hold and /secure
 * appointment-card — mutually exclusive, same order the follow-through
 * uses) plus the invoices the void step would touch. Never writes.
 *
 * FAIL CLOSED: if either financial preview cannot be completed, the result
 * is an error and the caller refuses to propose (or commit) — the operator
 * cancels from the dispatch screen instead. A rail that reports its OWN
 * lane state as unverifiable ("fee may apply") is disclosed as exactly
 * that; it is the rails' documented posture, not a swallowed failure.
 *
 * The result is fingerprinted at proposal time and re-checked at commit —
 * both in the route (fast fail) and INSIDE the cancelling transaction under
 * row locks (tools.js cancelAppointment) — so the visit, its fee posture,
 * and its invoice set cannot change between what the card showed and what
 * the commit does.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

/**
 * @param {string} scheduledServiceId
 * @param {object} [opts]
 * @param {import('knex').Knex.Transaction} [opts.trx]  When re-checking
 *   inside the cancelling transaction, the visit + invoice reads run on the
 *   transaction (the caller holds FOR UPDATE locks on those rows).
 */
async function previewCancellationEffects(scheduledServiceId, { trx = null } = {}) {
  const conn = trx || db;
  const appt = await conn('scheduled_services as ss')
    .leftJoin('customers as c', 'c.id', 'ss.customer_id')
    .where('ss.id', scheduledServiceId)
    .first('ss.id', 'ss.scheduled_date', 'ss.service_type', 'ss.status', 'ss.technician_id', 'c.first_name', 'c.last_name');
  if (!appt) return { error: 'Appointment not found' };

  // ── Fee rails (same precedence as the follow-through) ──
  let fee;
  try {
    const CardHolds = require('../estimate-card-holds');
    const hold = await CardHolds.cardHoldCancelPreview(scheduledServiceId);
    if (hold?.held) {
      fee = {
        rail: 'card_hold',
        applies: !!hold.feeApplies,
        amount: hold.feeApplies ? (Number(hold.feeAmount) || null) : null,
        unresolved: false,
        // The no-fee disposition depends on a feature gate the rail reads
        // at execution — freeze it here so a gate flip during the pending
        // window is drift, not a silent change of effect.
        hold_disposition: hold.feeApplies ? null : (CardHolds.isParkOnCancelEnabled() ? 'parked' : 'released'),
      };
    } else {
      const ApptCards = require('../appointment-card-request');
      const secure = await ApptCards.appointmentCardCancelPreview(scheduledServiceId);
      fee = secure?.secured
        ? {
          rail: 'appointment_card',
          applies: !!secure.feeApplies,
          amount: secure.feeApplies ? (Number(secure.feeAmount) || null) : null,
          unresolved: !!secure.unresolved,
        }
        : { rail: 'none', applies: false, amount: null, unresolved: false };
    }
  } catch (err) {
    logger.warn(`[intelligence-bar] cancellation fee preview failed for ${scheduledServiceId}: ${err.message}`);
    return { error: 'Could not verify the late-cancel fee for this visit — cancel it from the Dispatch screen instead.' };
  }

  // ── Invoices the void step would touch ──
  let invoices;
  try {
    const { CANCELLED_SERVICE_VOIDABLE_STATUSES } = require('../invoice');
    invoices = await conn('invoices')
      .where({ scheduled_service_id: scheduledServiceId })
      .whereIn('status', CANCELLED_SERVICE_VOIDABLE_STATUSES)
      .orderBy('created_at', 'asc')
      .select('id', 'invoice_number', 'status', 'total', 'credit_applied');
  } catch (err) {
    logger.warn(`[intelligence-bar] cancellation invoice preview failed for ${scheduledServiceId}: ${err.message}`);
    return { error: 'Could not verify the invoices this cancellation would void — cancel it from the Dispatch screen instead.' };
  }

  return {
    appointment: {
      id: appt.id,
      scheduled_date: appt.scheduled_date,
      service_type: appt.service_type,
      status: appt.status,
      technician_id: appt.technician_id || null,
      customer_name: `${appt.first_name || ''} ${appt.last_name || ''}`.trim() || null,
    },
    fee,
    invoices: invoices.map((i) => ({
      id: i.id, invoice_number: i.invoice_number, status: i.status,
      total: i.total == null ? null : Number(i.total),
      credit_applied: i.credit_applied == null ? null : Number(i.credit_applied),
    })),
  };
}

// Everything the card disclosed that the commit depends on: the visit's
// identity/state, the fee posture, the invoice set. Re-computed at commit;
// any drift ⇒ refuse (the operator approved a different effect set).
function cancellationFingerprint(preview) {
  const a = preview?.appointment || {};
  const material = {
    appointment: [String(a.id || ''), String(a.scheduled_date || ''), a.service_type || null, a.status || null, a.technician_id ? String(a.technician_id) : null, a.customer_name || null],
    fee: {
      rail: preview?.fee?.rail, applies: preview?.fee?.applies, amount: preview?.fee?.amount,
      unresolved: preview?.fee?.unresolved, hold_disposition: preview?.fee?.hold_disposition ?? null,
    },
    invoices: (preview?.invoices || []).map((i) => [String(i.id), i.status, i.total, i.credit_applied]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

// The card's exact-effect scope: a cancellation whose follow-through could
// charge or void anything is NOT card-confirmable. The rails settle those
// amounts by re-reading state after commit, which cannot be pinned to what
// the card showed — so they stay on the Dispatch screen (waiver + review
// controls) until the rails accept a bound snapshot.
function cancellationHasMoneyEffects(preview) {
  return !!(preview?.fee?.applies || preview?.fee?.unresolved || (preview?.invoices || []).length);
}
const CANCELLATION_MONEY_EFFECTS_MESSAGE = 'This cancellation has money effects (a late-cancel fee may apply and/or open invoices would be voided), which the confirmation card cannot pin exactly. Cancel it from the Dispatch screen, where the fee waiver and invoice review controls live. Nothing was changed.';

module.exports = {
  previewCancellationEffects,
  cancellationFingerprint,
  cancellationHasMoneyEffects,
  CANCELLATION_MONEY_EFFECTS_MESSAGE,
};
