'use strict';

const db = require('../models/db');
const VisitGroups = require('./visit-groups');
const { resolveBillingLane } = require('./billing-lane');
const { isInvoiceCollectibleStatus, invoiceAmountDue } = require('./invoice-helpers');

function refuse(reason) {
  const error = new Error('The visit billing changed. Review the shared invoice before charging.');
  error.code = 'VISIT_PAYMENT_REVIEW_REQUIRED';
  error.reason = reason;
  throw error;
}

/** Called by the canonical saved-card charger under its invoice/customer locks. */
async function assertVisitCompletionCharge(trx, invoice, packetId) {
  if (invoice.visit_completion_packet_id !== packetId || invoice.payer_id) refuse('invoice_owner_changed');
  // Initial sends render outside their claim transaction, just like reminders.
  if (invoice.status === 'sending') {
    throw Object.assign(new Error('Visit invoice delivery is still in flight. Retry closeout.'), {
      code: 'VISIT_PAYMENT_SEND_IN_FLIGHT',
    });
  }
  // Plan creation holds this invoice lock, but a draft may have no reminder
  // sequence to stop. The plan itself owns its collection arrangement.
  if (await trx('payment_plans').where({ invoice_id: invoice.id, status: 'active' }).first('id')) {
    refuse('active_payment_plan');
  }
  const peek = await trx('visit_completion_packets as p').join('service_visits as v', 'v.id', 'p.visit_id')
    .where('p.id', packetId).first('v.id', 'v.stop_base_key');
  if (!peek) refuse('packet_missing');
  // Schedule edits take the stop before the invoice. Collection already owns
  // the invoice, so every subsequent visit lock must refuse contention.
  await VisitGroups.lockStop(trx, peek.stop_base_key, { noWait: true });
  const visit = await trx('service_visits').where({ id: peek.id }).forUpdate().noWait().first();
  const packet = await trx('visit_completion_packets').where({ id: packetId }).forUpdate().noWait().first();
  if (!visit || visit.customer_id !== invoice.customer_id || visit.billing_hold
      || !['closing', 'closed'].includes(visit.status) || !['processing', 'done'].includes(packet?.status)) {
    refuse('visit_billing_held');
  }
  const payload = require('./visit-completion-packets').packetPayload(packet);
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
  if (!await require('./estimate-deposits').invoiceDepositCreditIsBacked(invoice, trx)) refuse('deposit_credit_changed');
  const customer = await trx('customers').where({ id: invoice.customer_id }).first();
  if (!customer || resolveBillingLane(customer).mode !== frozen.billingLane) refuse('billing_lane_changed');
  // Schedule conversions lock the service before its invoice. As in
  // lockVisitForSettlement, never wait on that row while holding the invoice.
  const members = await trx('visit_completion_packet_items as i')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .where('i.packet_id', packet.id).orderBy('s.id').forUpdate('s', 'i').noWait()
    .select('s.*', 'i.status as item_status', 'i.invoice_id', 'r.id as record_id',
      'r.status as record_status', 'r.customer_id as record_customer_id',
      'r.scheduled_service_id as record_service_id', 'r.structured_notes as record_notes');
  if (members.length < 1 || members.some((member) => member.item_status !== 'done'
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
    if (String(member.technician_id || '') !== String(visit.technician_id || '')
        || !VisitGroups.rowStillAtVisitStop(member, visit, members.filter((other) => other.id !== member.id))) {
      refuse('member_stop_changed');
    }
    const pricing = frozen.memberPricing?.find((entry) => entry.id === member.id);
    if (!pricing || pricing.price !== Number(member.estimated_price)
        || pricing.isCallback !== Boolean(member.is_callback)
        || pricing.invoiceOnComplete !== Boolean(member.create_invoice_on_complete)) refuse('member_price_changed');
    // Older saved packets predate the service-identity snapshot. New packets
    // also fence in-place conversions that retain the same price and row ID.
    if (Object.hasOwn(pricing, 'serviceType')
        && (pricing.serviceType !== member.service_type || pricing.serviceId !== member.service_id)) refuse('member_service_changed');
    if (require('./no-cost-visit-types').isAlwaysFreeServiceType(member.service_type)) refuse('member_coverage_changed');
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
  const heldConsent = await trx('estimate_card_holds').whereIn('scheduled_service_id', ids)
    .whereNotIn('status', ['released', 'cancelled', 'failed']).first('id');
  if (appointmentConsent || heldConsent) refuse('competing_card_consent');
  // The visit-effect finalizer can be lost after Stripe has already refused
  // this invoice. Its expired lease must not authorize another automatic
  // provider attempt. The saved-card rail stamps submission durably, before
  // dispatch; pre-submission failures remain retryable and zero balances can
  // still settle. Failed submitted attempts need office reconciliation because
  // their ledger does not distinguish declines from other provider refusals.
  const failedSubmission = await trx('stripe_invoice_charge_attempts')
    .where({ invoice_id: invoice.id, status: 'failed' }).whereNotNull('submitted_at').first('id');
  if (failedSubmission && invoiceAmountDue(invoice) > 0) refuse('previous_collection_failed');
  // The reminder worker claims under this invoice lock before rendering or
  // sending outside its transaction. A fresh claim must finish before money moves.
  const sequence = await trx('invoice_followup_sequences').where({ invoice_id: invoice.id }).forUpdate()
    .first('touch_claimed_at');
  if (new Date(sequence?.touch_claimed_at).getTime() > Date.now() - 10 * 60 * 1000) {
    throw Object.assign(new Error('Visit invoice reminder is still in flight. Retry closeout.'), {
      code: 'VISIT_PAYMENT_FOLLOWUP_IN_FLIGHT',
    });
  }
}

// The self-pay invoice of a packet whose live owner is now a payer is
// withdrawn under the held customer, member and payer rows; returns that
// payer, or null when the invoice is self-pay or already terminal.
async function withdrawPayerOwnedInvoice(packet, database) {
  const candidate = await database('invoices').where({ visit_completion_packet_id: packet.id }).whereNull('payer_id')
    .whereNotIn('status', ['void', 'refunded', 'canceled', 'cancelled', 'paid', 'prepaid']).first('id');
  if (!candidate) return null;
  const Packets = require('./visit-completion-packets');
  const run = async (trx) => {
    const { visit, billed, payerId } = await Packets.resolvePacketOwnershipLocked(packet.id, trx);
    if (!visit || !payerId) return null;
    const withdrawn = await Packets.withdrawPacketInvoiceForPayer(trx, { packetId: packet.id, invoiceId: candidate.id, visit, billed, payerId });
    return withdrawn ? payerId : null;
  };
  return database.isTransaction ? run(database) : database.transaction(run);
}

/** One automatic collection decision for the saved visit, using the invoice rail. */
async function collectVisitCompletionInvoice(packetId, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  if (!packet) throw new Error('Visit completion packet not found');
  // Live Bill-To is decided under held rows BEFORE any automatic collection:
  // a payer assigned since the self-pay invoice was minted withdraws it
  // (stamp, billing hold, office review), so neither the saved card nor
  // account credit settles debt that belongs to AP. The payer writers refuse
  // while this collection's own claim is in flight (packetInvoiceSendInFlight).
  const withdrawnFor = await withdrawPayerOwnedInvoice(packet, database);
  const visit = await database('service_visits').where({ id: packet.visit_id }).first();
  const invoice = await database('invoices').where({ visit_completion_packet_id: packet.id }).first();
  if (withdrawnFor) {
    const finalized = await VisitGroups.finalizeVisitNotification(visit.id, 'visit_payment', 'suppressed', new Date(), null, {
      lastError: 'office_required', providerId: invoice?.stripe_payment_intent_id || null,
    });
    return { state: finalized.ok ? 'office_required' : 'payment_pending', reason: 'payer_assigned', payerId: withdrawnFor, invoiceId: invoice?.id || null };
  }
  if (visit.billing_hold || ['void', 'refunded', 'canceled', 'cancelled'].includes(invoice?.status)) {
    if (!visit.billing_hold) {
      await database('service_visits').where({ id: visit.id }).update({
        billing_hold: true, updated_at: database.fn.now(),
      });
    }
    const finalized = await VisitGroups.finalizeVisitNotification(visit.id, 'visit_payment', 'suppressed', new Date(), null, {
      lastError: 'office_required', providerId: invoice?.stripe_payment_intent_id || null,
    });
    return { state: finalized.ok ? 'office_required' : 'payment_pending', invoiceId: invoice?.id || null };
  }
  if (!invoice) return { state: 'no_charge', invoiceId: null };
  if (invoice.status === 'sending') return { state: 'payment_pending', invoiceId: invoice.id };
  if (!isInvoiceCollectibleStatus(invoice.status)) {
    // Processing also parks ambiguous saved-card requests. Only a durable
    // payment matching this invoice's bound PI proves accepted money in flight.
    if (invoice.status === 'processing') {
      const payment = invoice.stripe_payment_intent_id && await database('payments')
        .where({ customer_id: invoice.customer_id, stripe_payment_intent_id: invoice.stripe_payment_intent_id })
        .whereNull('payer_id').where('amount', invoiceAmountDue(invoice))
        .whereIn('status', ['paid', 'processing']).first('id');
      if (!payment) return { state: 'payment_pending', invoiceId: invoice.id };
    }
    if (['paid', 'prepaid', 'processing'].includes(invoice.status)) {
      const finalized = await VisitGroups.finalizeVisitNotification(visit.id, 'visit_payment', 'sent', new Date(), null, {
        lastError: null, providerId: invoice.stripe_payment_intent_id || null,
      });
      if (!finalized.ok) return { state: 'payment_pending', invoiceId: invoice.id };
      await database('service_visits').where({ id: visit.id }).update({
        payment_intent_id: invoice.stripe_payment_intent_id || null, updated_at: database.fn.now(),
      });
    }
    return { state: invoice.status, invoiceId: invoice.id };
  }
  // Only a recorded member can own payment; retained history is outside the claim.
  const member = await VisitGroups.recordedPacketMember(packet.id, database);
  const claim = await VisitGroups.claimVisitNotification(member, 'visit_payment');
  let terminalReason = null;
  if (claim?.state !== 'owner') {
    const previous = await database('visit_effects').where({ visit_id: visit.id, effect_type: 'visit_payment' }).first();
    if (claim?.state !== 'taken' || previous?.status !== 'suppressed'
        || !['payment_needed', 'payment_failed'].includes(previous.last_error)) {
      return { state: previous?.last_error || (claim?.state === 'taken' ? 'payment_needed' : 'payment_pending'), invoiceId: invoice.id };
    }
    // A terminal automatic attempt cannot charge again. A later discount may
    // still settle zero through the same locked, non-cash invoice authority.
    terminalReason = previous.last_error;
  }
  const { customerOnAutopay, getChargeableAutopayMethod } = require('./autopay-eligibility');
  let outcome = 'suppressed';
  let reason = 'payment_needed';
  try {
    const settlement = await database.transaction(async (trx) => {
      const locked = await trx('invoices').where({ id: invoice.id }).forUpdate().first();
      if (!locked) refuse('invoice_missing');
      if (invoiceAmountDue(locked) > 0) return { reason: 'balance_due' };
      await trx('customers').where({ id: locked.customer_id }).forUpdate().first('id');
      await assertVisitCompletionCharge(trx, locked, packet.id);
      return require('./invoice').settleZeroBalance(invoice.id, trx);
    });
    if (settlement.reason !== 'balance_due') {
      if (settlement.retryable) throw new Error('Visit invoice settlement is waiting for its reminder claim');
      if (!settlement.settled && !['paid', 'prepaid'].includes(settlement.invoice?.status)) {
        refuse(settlement.reason);
      }
      outcome = 'sent';
      reason = null;
    } else {
      if (terminalReason) return { state: terminalReason, invoiceId: invoice.id };
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
    }
  } catch (err) {
    const stripe = require('./stripe');
    if (stripe.savedCardChargeSuppressesAlternateCollection(err)) {
      outcome = 'retry';
      reason = 'payment_pending';
    } else if (err.wavesCardDecline) {
      // A closeout retry never starts a fresh automatic attempt after a decline.
      reason = 'payment_failed';
    } else if (['VISIT_PAYMENT_REVIEW_REQUIRED', 'INVOICE_COLLECTION_STOPPED'].includes(err.code)) {
      reason = 'office_required';
      await database('service_visits').where({ id: visit.id }).update({ billing_hold: true, updated_at: database.fn.now() });
    } else {
      outcome = 'retry';
      reason = 'payment_pending';
    }
  }
  // A failed zero-only replay must not turn the terminal attempt into a
  // reclaimable lease that could charge a later positive balance.
  if (terminalReason && outcome === 'retry') return { state: reason, invoiceId: invoice.id };
  const current = await database('invoices').where({ id: invoice.id }).first();
  const finalized = await VisitGroups.finalizeVisitNotification(visit.id, 'visit_payment', outcome, new Date(), claim.token, {
    lastError: reason, providerId: current.stripe_payment_intent_id || null,
  });
  if (!finalized.ok) return { state: 'payment_pending', invoiceId: invoice.id };
  if (current.stripe_payment_intent_id) {
    await database('service_visits').where({ id: visit.id }).update({ payment_intent_id: current.stripe_payment_intent_id, updated_at: database.fn.now() });
  }
  return { state: reason || current.status, invoiceId: invoice.id };
}

module.exports = { assertVisitCompletionCharge, collectVisitCompletionInvoice };
