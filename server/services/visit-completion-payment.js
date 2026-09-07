'use strict';

const db = require('../models/db');
const VisitGroups = require('./visit-groups');
const { resolveBillingLane } = require('./billing-lane');
const { isInvoiceCollectibleStatus } = require('./invoice-helpers');

function refuse(reason) {
  const error = new Error('The visit billing changed. Review the shared invoice before charging.');
  error.code = 'VISIT_PAYMENT_REVIEW_REQUIRED';
  error.reason = reason;
  throw error;
}

/** Called by the canonical saved-card charger under its invoice/customer locks. */
async function assertVisitCompletionCharge(trx, invoice, packetId) {
  if (invoice.visit_completion_packet_id !== packetId || invoice.payer_id) refuse('invoice_owner_changed');
  const peek = await trx('visit_completion_packets as p').join('service_visits as v', 'v.id', 'p.visit_id')
    .where('p.id', packetId).first('v.id', 'v.stop_base_key');
  if (!peek) refuse('packet_missing');
  await VisitGroups.lockStop(trx, peek.stop_base_key);
  const visit = await trx('service_visits').where({ id: peek.id }).forUpdate().first();
  const packet = await trx('visit_completion_packets').where({ id: packetId }).forUpdate().first();
  if (!visit || visit.customer_id !== invoice.customer_id || visit.billing_hold
      || !['closing', 'closed'].includes(visit.status) || !['processing', 'done'].includes(packet?.status)) {
    refuse('visit_billing_held');
  }
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
  const frozen = payload?.billingSnapshot;
  if (frozen?.invoiceId !== invoice.id || !Number.isSafeInteger(frozen.totalCents)
      || !Number.isSafeInteger(frozen.netSubtotalCents) || !Array.isArray(frozen.billedServiceIds)) {
    refuse('billing_snapshot_missing');
  }
  const netSubtotalCents = Math.round((Number(invoice.subtotal) - Number(invoice.discount_amount || 0)) * 100);
  const totalCents = Math.round(Number(invoice.total) * 100);
  if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(netSubtotalCents)
      || totalCents > frozen.totalCents || netSubtotalCents > frozen.netSubtotalCents) {
    refuse('invoice_above_saved_amount');
  }
  const customer = await trx('customers').where({ id: invoice.customer_id }).first();
  if (!customer || resolveBillingLane(customer).mode !== frozen.billingLane) refuse('billing_lane_changed');
  const members = await trx('visit_completion_packet_items as i')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .where('i.packet_id', packet.id).orderBy('s.id').forUpdate('s', 'i')
    .select('s.*', 'i.status as item_status', 'i.invoice_id', 'r.id as record_id',
      'r.status as record_status', 'r.customer_id as record_customer_id',
      'r.scheduled_service_id as record_service_id', 'r.structured_notes as record_notes');
  if (members.length < 2 || members.some((member) => member.item_status !== 'done'
      || member.visit_id !== visit.id || member.customer_id !== customer.id
      || member.record_customer_id !== customer.id || member.record_service_id !== member.id)) {
    refuse('member_identity_changed');
  }
  const billed = members.filter((member) => member.invoice_id === invoice.id);
  if (JSON.stringify(billed.map((member) => member.id)) !== JSON.stringify([...frozen.billedServiceIds].sort())
      || !billed.some((member) => member.id === invoice.scheduled_service_id && member.record_id === invoice.service_record_id)) {
    refuse('billed_members_changed');
  }
  for (const member of billed) {
    const pricing = frozen.memberPricing?.find((entry) => entry.id === member.id);
    if (!pricing || pricing.price !== Number(member.estimated_price)
        || pricing.isCallback !== Boolean(member.is_callback)
        || pricing.invoiceOnComplete !== Boolean(member.create_invoice_on_complete)) refuse('member_price_changed');
    if (member.status !== 'completed' || member.record_status !== 'completed'
        || ['inspection_only', 'customer_declined', 'incomplete'].includes(member.record_notes?.visitOutcome)
        || member.prepaid_method || Number(member.prepaid_amount) > 0) refuse('member_coverage_changed');
    const payer = await require('./payer').resolveForInvoice({
      database: trx, customerId: customer.id, customer, scheduledServiceId: member.id, throwOnError: true,
    });
    if (payer.payerId) refuse('member_payer_changed');
    if (await require('./annual-prepay-renewals').annualPrepayCoversVisit(member, trx, { throwOnError: true })) {
      refuse('member_prepaid');
    }
  }
  // Alternate one-time card consents own their existing financial contract.
  // Refuse the mixed lane instead of silently selecting another saved method.
  const ids = billed.map((member) => member.id);
  const appointmentConsent = await trx('appointment_card_requests').whereIn('scheduled_service_id', ids).first('id');
  const heldConsent = await trx('estimate_card_holds').whereIn('scheduled_service_id', ids).where({ status: 'held' }).first('id');
  if (appointmentConsent || heldConsent) refuse('competing_card_consent');
}

/** One automatic collection decision for the saved visit, using the invoice rail. */
async function collectVisitCompletionInvoice(packetId, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  if (!packet) throw new Error('Visit completion packet not found');
  const visit = await database('service_visits').where({ id: packet.visit_id }).first();
  const invoice = await database('invoices').where({ visit_completion_packet_id: packet.id }).first();
  if (visit.billing_hold) return { state: 'office_required', invoiceId: invoice?.id || null };
  if (!invoice) return { state: 'no_charge', invoiceId: null };
  if (!isInvoiceCollectibleStatus(invoice.status)) {
    if (['paid', 'prepaid'].includes(invoice.status)) {
      await VisitGroups.finalizeVisitNotification(visit.id, 'visit_payment', 'sent');
      await database('service_visits').where({ id: visit.id }).update({
        payment_intent_id: invoice.stripe_payment_intent_id || null, updated_at: database.fn.now(),
      });
    }
    return { state: invoice.status, invoiceId: invoice.id };
  }
  const member = await database('scheduled_services').where({ visit_id: visit.id }).orderBy('id').first();
  const claim = await VisitGroups.claimVisitNotification(member, 'visit_payment');
  if (claim?.state !== 'owner') {
    const previous = await database('visit_effects').where({ visit_id: visit.id, effect_type: 'visit_payment' }).first();
    return { state: previous?.last_error || (claim?.state === 'taken' ? 'payment_needed' : 'payment_pending'), invoiceId: invoice.id };
  }
  const { customerOnAutopay, getChargeableAutopayMethod } = require('./autopay-eligibility');
  let outcome = 'suppressed';
  let reason = 'payment_needed';
  try {
    const customer = await database('customers').where({ id: visit.customer_id }).first();
    const method = await getChargeableAutopayMethod(customer, database, { rethrow: true });
    if (method && await customerOnAutopay(customer, { db: database, failClosed: true })) {
      await require('./stripe').chargeInvoiceWithSavedCard(invoice.id, method.id, {
        requireAutopayForCustomerId: customer.id, requireVisitCompletionPacketId: packet.id,
        refuseWhenDunningStopped: true,
      });
      outcome = 'sent';
      reason = null;
    }
  } catch (err) {
    const stripe = require('./stripe');
    if (stripe.savedCardChargeSuppressesAlternateCollection(err)) {
      outcome = 'retry';
      reason = 'payment_pending';
    } else if (err.wavesCardDecline) {
      // A closeout retry never starts a fresh automatic attempt after a decline.
      reason = 'payment_failed';
    } else if (err.code === 'VISIT_PAYMENT_REVIEW_REQUIRED') {
      reason = 'office_required';
      await database('service_visits').where({ id: visit.id }).update({ billing_hold: true, updated_at: database.fn.now() });
    } else {
      outcome = 'retry';
      reason = 'payment_pending';
    }
  }
  const finalized = await VisitGroups.finalizeVisitNotification(visit.id, 'visit_payment', outcome, new Date(), claim.token);
  if (!finalized.ok) return { state: 'payment_pending', invoiceId: invoice.id };
  const current = await database('invoices').where({ id: invoice.id }).first();
  await database('visit_effects').where({ visit_id: visit.id, effect_type: 'visit_payment', claim_token: claim.token }).update({
    provider_id: current.stripe_payment_intent_id || null, last_error: reason, updated_at: database.fn.now(),
  });
  if (current.stripe_payment_intent_id) {
    await database('service_visits').where({ id: visit.id }).update({ payment_intent_id: current.stripe_payment_intent_id, updated_at: database.fn.now() });
  }
  return { state: reason || current.status, invoiceId: invoice.id };
}

module.exports = { assertVisitCompletionCharge, collectVisitCompletionInvoice };
