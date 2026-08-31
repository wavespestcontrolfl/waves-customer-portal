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
 * The result is fingerprinted at proposal time and re-checked at commit:
 * if the fee posture or the invoice set moved during the pending window
 * (a payment landed, the window elapsed, a card was removed), the commit
 * is refused with preview_changed and the operator re-proposes.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

async function previewCancellationEffects(scheduledServiceId) {
  const appt = await db('scheduled_services as ss')
    .leftJoin('customers as c', 'c.id', 'ss.customer_id')
    .where('ss.id', scheduledServiceId)
    .first('ss.id', 'ss.scheduled_date', 'ss.service_type', 'ss.status', 'c.first_name', 'c.last_name');
  if (!appt) return { error: 'Appointment not found' };

  // ── Fee rails (same precedence as the follow-through) ──
  let fee = { rail: 'none', applies: false, amount: null, unresolved: false };
  try {
    const CardHolds = require('../estimate-card-holds');
    const hold = await CardHolds.cardHoldCancelPreview(scheduledServiceId);
    if (hold?.held) {
      fee = { rail: 'card_hold', applies: !!hold.feeApplies, amount: hold.feeApplies ? Number(hold.feeAmount) || null : null, unresolved: false };
    } else {
      const ApptCards = require('../appointment-card-request');
      const secure = await ApptCards.appointmentCardCancelPreview(scheduledServiceId);
      if (secure?.secured) {
        fee = {
          rail: 'appointment_card',
          applies: !!secure.feeApplies,
          amount: secure.feeApplies ? (Number(secure.feeAmount) || null) : null,
          unresolved: !!secure.unresolved,
        };
      }
    }
  } catch (err) {
    // Fail CLOSED for disclosure: an unverifiable rail is "a fee may
    // apply", never "no fee" (the rails themselves take the same posture).
    logger.warn(`[intelligence-bar] cancellation fee preview failed for ${scheduledServiceId}: ${err.message}`);
    fee = { rail: 'unknown', applies: true, amount: null, unresolved: true };
  }

  // ── Invoices the void step would touch ──
  let invoices = [];
  try {
    const { CANCELLED_SERVICE_VOIDABLE_STATUSES } = require('../invoice');
    invoices = await db('invoices')
      .where({ scheduled_service_id: scheduledServiceId })
      .whereIn('status', CANCELLED_SERVICE_VOIDABLE_STATUSES)
      .orderBy('created_at', 'asc')
      .select('id', 'invoice_number', 'status', 'total', 'amount_paid');
  } catch (err) {
    logger.warn(`[intelligence-bar] cancellation invoice preview failed for ${scheduledServiceId}: ${err.message}`);
  }

  return {
    appointment: {
      id: appt.id,
      scheduled_date: appt.scheduled_date,
      service_type: appt.service_type,
      status: appt.status,
      customer_name: `${appt.first_name || ''} ${appt.last_name || ''}`.trim() || null,
    },
    fee,
    invoices: invoices.map((i) => ({
      id: i.id, invoice_number: i.invoice_number, status: i.status,
      total: i.total == null ? null : Number(i.total),
      amount_paid: i.amount_paid == null ? null : Number(i.amount_paid),
    })),
  };
}

// What the operator approved about the MONEY side: fee posture + invoice
// set. Re-computed at commit; drift ⇒ refuse.
function cancellationFingerprint(preview) {
  const material = {
    fee: { rail: preview?.fee?.rail, applies: preview?.fee?.applies, amount: preview?.fee?.amount, unresolved: preview?.fee?.unresolved },
    invoices: (preview?.invoices || []).map((i) => [String(i.id), i.status, i.total, i.amount_paid]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

module.exports = { previewCancellationEffects, cancellationFingerprint };
