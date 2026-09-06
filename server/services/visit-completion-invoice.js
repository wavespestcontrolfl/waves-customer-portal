'use strict';

// Internal packet billing phase. Records, invoice, deposit/offer allocations,
// and member links share the caller's transaction. No delivery or charge here.
const db = require('../models/db');
const InvoiceService = require('./invoice');
const { acquireScheduledInvoiceMintLock, TERMINAL_INVOICE_STATUSES } = require('./scheduled-invoice-mint');
const { lockStop } = require('./visit-groups');
const { resolveBillingLane, completionInvoiceAmount } = require('./billing-lane');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
const { pendingDepositCredit, consumeDepositCredit } = require('./estimate-deposits');

function office(reason, serviceId = null) {
  return { state: 'office_required', reason, serviceId, invoiceId: null };
}

async function buildMemberLines(member, customer, trx) {
  const notes = member.record_notes || {};
  if ([notes.backfill, notes.oneTimeRecapOnly, notes.invoiceAlreadySent].some(Boolean)) {
    return office('special_completion_billing', member.id);
  }
  if (member.record_status === 'incomplete'
      || ['inspection_only', 'customer_declined'].includes(notes.visitOutcome)) return { lineItems: [] };
  if (member.record_status !== 'completed') return office('record_not_completed', member.id);
  if (member.prepaid_method || Number(member.prepaid_amount) > 0) return office('prepaid_member', member.id);
  const payer = await require('./payer').resolveForInvoice({
    database: trx, customerId: customer.id, customer, scheduledServiceId: member.id, throwOnError: true,
  });
  if (payer.payerId) return office('payer_billed_member', member.id);
  const prior = await require('./estimate-first-application-invoice')
    .findFirstApplicationInvoiceForEstimateService(member, trx);
  if ([prior.invoice, prior.liveBeside, prior.canceledSetupFee].some(Boolean)) return office('existing_estimate_invoice', member.id);
  const obligation = await require('./setup-fee-obligation').findUnmintedSetupFeeObligation({
    sourceEstimateId: member.source_estimate_id, customerId: customer.id,
    excludeScheduledServiceId: member.id, visitPlanRow: member,
  }, trx);
  if (obligation.owed) return office('setup_fee_requires_review', member.id);
  const amount = completionInvoiceAmount({
    estimatedPrice: member.estimated_price, isCallback: member.is_callback,
    perApplicationBilling: customer.billing_mode === 'per_application',
    perApplicationFee: customer.per_application_fee, monthlyRate: customer.monthly_rate,
    billingMode: customer.billing_mode,
  });
  if (isAlwaysFreeServiceType(member.service_type) || (member.is_callback && !(amount > 0))) return { lineItems: [] };
  // A combined plan's customer-level fallback is not a price for each member.
  // Explicit zero is allowed only when the canonical lane also says zero.
  if (member.estimated_price == null || !Number.isFinite(Number(member.estimated_price))) {
    return office('member_price_missing', member.id);
  }
  if (Number(member.estimated_price) === 0 && amount === 0) return { lineItems: [] };
  if (!(Number(member.estimated_price) > 0)) return office('member_price_ambiguous', member.id);
  const built = await InvoiceService.buildLineItemsForScheduledService(member.id, {
    fallbackAmount: amount, fallbackDescription: member.service_type, database: trx,
  });
  if (!built.lineItems.length) return office('member_lines_missing', member.id);
  return built;
}

async function mintPacketInvoice({ packet, visit, members, customer, trx }) {
  const lane = resolveBillingLane(customer).mode;
  if (['monthly_membership', 'annual_prepay'].includes(lane)) return office('covered_billing_lane');
  const existing = await trx('invoices').where(function linkedMember() {
    this.whereIn('scheduled_service_id', members.map((member) => member.id))
      .orWhereIn('service_record_id', members.map((member) => member.record_id));
  }).first('id');
  if (existing) return office('existing_member_invoice');
  const billed = [];
  for (const member of members) {
    const built = await buildMemberLines(member, customer, trx);
    if (built.state === 'office_required') return built;
    if (built.lineItems.length) billed.push({ member, lineItems: built.lineItems });
  }
  if (!billed.length) return { state: 'no_charge', invoiceId: null };
  const sourceIds = [...new Set(billed.map(({ member }) => member.source_estimate_id || null))];
  if (sourceIds.length > 1) return office('mixed_estimate_billing');
  // create() owns county tax. Its service-level authority can represent the
  // group only when every positive line has the same tax treatment.
  if (['commercial', 'business'].includes(customer.property_type)) {
    const rates = new Set();
    for (const { member, lineItems } of billed) {
      for (const label of [member.service_type, ...lineItems.filter((line) => line.amount > 0).map((line) => line.category)]) {
        const tax = await require('./tax-calculator').calculateTax(customer.id, label, 100, { database: trx });
        rates.add(tax.rate);
      }
    }
    if (rates.size !== 1) return office('mixed_tax_treatment');
  }

  // Existing retention authority applies once to the kept service family on
  // this ONE charge. Unrelated families and one-time extras are excluded.
  const retained = new Map();
  for (const { member, lineItems } of billed) {
    if (!(member.is_recurring || member.recurring_ongoing) || member.is_callback) continue;
    const family = require('./cancellation-processor').familyOfServiceRow(member);
    if (!family) continue;
    if (!retained.has(family)) retained.set(family, { member, lineItems: [] });
    retained.get(family).lineItems.push(...lineItems);
  }
  const offers = [];
  const lineItems = billed.flatMap((entry) => entry.lineItems);
  for (const group of retained.values()) {
    const offer = await InvoiceService.applyRetentionOfferUnderSavepoint({
      customerId: customer.id, scheduledServiceId: group.member.id, lineItems: group.lineItems, trx,
    });
    if (offer) { offers.push(offer); lineItems.push(offer.lineItem); }
  }
  const sourceEstimateId = sourceIds[0];
  const deposit = sourceEstimateId ? await pendingDepositCredit(sourceEstimateId, trx) : null;
  const invoice = await InvoiceService.create({
    database: trx, customerId: customer.id, scheduledServiceId: billed[0].member.id,
    serviceRecordId: billed[0].member.record_id, serviceDate: visit.scheduled_date,
    title: 'Combined service visit', lineItems, trustedStoredDiscountSources: ['scheduled_service'],
    ...(deposit ? { depositCredit: { amount: deposit.amount, estimateId: sourceEstimateId } } : {}),
  }, { packetId: packet.id });
  if (invoice.payer_id) throw new Error('Visit Bill-To changed during invoice creation');
  const applied = Number(invoice.applied_deposit_credit) || 0;
  if (applied > 0) {
    const consumed = await consumeDepositCredit({ estimateId: sourceEstimateId, amount: applied, invoiceId: invoice.id, trx });
    if (Math.round(consumed * 100) !== Math.round(applied * 100)) throw new Error('Visit deposit allocation mismatch');
  }
  for (const offer of offers) {
    const stamped = await require('./cancellation-resolution/retention-offer')
      .stampRetentionApplied({ offerId: offer.offerId, ref: invoice.id }, trx);
    if (!stamped) throw new Error('Visit retention allocation could not be linked');
  }
  await trx('visit_completion_packet_items').where({ packet_id: packet.id })
    .whereIn('scheduled_service_id', billed.map(({ member }) => member.id))
    .update({ invoice_id: invoice.id, updated_at: trx.fn.now() });
  return { state: 'invoice_ready', invoiceId: invoice.id, total: Number(invoice.total) };
}

async function createVisitCompletionInvoice(packetId, database = db) {
  const run = async (trx) => {
    const peek = await trx('visit_completion_packets as p').join('service_visits as v', 'p.visit_id', 'v.id')
      .where('p.id', packetId).first('p.visit_id', 'v.customer_id', 'v.stop_base_key');
    if (!peek) throw new Error('Visit completion packet not found');
    const itemIds = await trx('visit_completion_packet_items').where({ packet_id: packetId })
      .orderBy('scheduled_service_id').pluck('scheduled_service_id');
    for (const id of itemIds) await acquireScheduledInvoiceMintLock(trx, id);
    const customer = await trx('customers').where({ id: peek.customer_id }).forNoKeyUpdate().first();
    await lockStop(trx, peek.stop_base_key);
    const visit = await trx('service_visits').where({ id: peek.visit_id }).forUpdate().first();
    const packet = await trx('visit_completion_packets').where({ id: packetId }).forUpdate().first();
    if (!customer || !visit || !packet || !['closing', 'closed'].includes(visit.status)) {
      throw new Error('Visit completion packet is not ready for billing');
    }
    const ownInvoice = await trx('invoices').where({ visit_completion_packet_id: packet.id }).first();
    if (ownInvoice) {
      if (['void', ...TERMINAL_INVOICE_STATUSES].includes(ownInvoice.status)) {
        await trx('service_visits').where({ id: visit.id }).update({ billing_hold: true, updated_at: trx.fn.now() });
        return { ...office('shared_invoice_reversed'), invoiceId: ownInvoice.id };
      }
      return { state: 'invoice_ready', invoiceId: ownInvoice.id, total: Number(ownInvoice.total) };
    }
    if (visit.billing_hold) return office(packet.error || 'visit_billing_held');
    if (visit.billing_frozen_at) return { state: 'no_charge', invoiceId: null };
    const members = await trx('visit_completion_packet_items as i')
      .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
      .join('service_records as r', 'r.id', 'i.service_record_id')
      .leftJoin('services as catalog', 'catalog.id', 's.service_id')
      .where('i.packet_id', packet.id).orderBy('s.id').forUpdate('s')
      .select('s.*', 'r.id as record_id', 'r.status as record_status', 'r.structured_notes as record_notes',
        'r.customer_id as record_customer_id', 'r.scheduled_service_id as record_scheduled_service_id',
        'catalog.service_key', 'catalog.name as service_name');
    if (members.length !== itemIds.length || members.length < 2
        || members.some((member) => member.visit_id !== visit.id || member.customer_id !== customer.id
          || member.record_customer_id !== customer.id || member.record_scheduled_service_id !== member.id)) {
      throw new Error('Visit billing member identity mismatch');
    }
    const result = await mintPacketInvoice({ packet, visit, members, customer, trx });
    const held = result.state === 'office_required';
    await trx('service_visits').where({ id: visit.id }).update({
      billing_hold: held, billing_frozen_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    if (held) await trx('visit_completion_packets').where({ id: packet.id }).update({ error: result.reason, updated_at: trx.fn.now() });
    await trx('visit_effects').insert({
      visit_id: visit.id, effect_type: 'billing_ready', dedupe_key: `${visit.id}:billing_ready`,
      status: held ? 'failed' : 'sent', provider_id: result.invoiceId,
      last_error: held ? result.reason : null, sent_at: held ? null : trx.fn.now(), attempts: 1,
    });
    return result;
  };
  return database.isTransaction ? run(database) : database.transaction(run);
}

module.exports = { createVisitCompletionInvoice };
