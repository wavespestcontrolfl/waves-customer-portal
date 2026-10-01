'use strict';

// Internal packet billing phase. Records, invoice, deposit/offer allocations,
// and member links share the caller's transaction. No delivery or charge here.
const db = require('../models/db');
const InvoiceService = require('./invoice');
const { acquireScheduledInvoiceMintLock, TERMINAL_INVOICE_STATUSES } = require('./scheduled-invoice-mint');
const { lockStop, dateOnly } = require('./visit-groups');
const { resolveBillingLane, completionInvoiceAmount } = require('./billing-lane');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
const { parkSetupFeeStampForOffice, isPlanApplicationRow } = require('./setup-fee-obligation');
const { acquireEstimateDepositLedgerLock, pendingDepositCredit, consumeDepositCredit } = require('./estimate-deposits');

function office(reason, serviceId = null, extra = null) {
  return { state: 'office_required', reason, serviceId, invoiceId: null, ...(extra || {}) };
}

function visitBusy(error) {
  if (error && error.code !== '55P03') throw error;
  throw Object.assign(new Error('Estimate billing is being updated. Retry the closeout in a moment.'),
    { code: 'visit_busy', status: 409, statusCode: 409, isOperational: true });
}

async function acceptanceTaxRefusal({ invoice, members, customer, trx }) {
  const taxableBase = Number(invoice.subtotal) - Number(invoice.discount_amount || 0);
  const baseCents = Math.round(taxableBase * 100);
  let currentRate = 0;
  let expectedTaxCents = 0;
  if (['commercial', 'business'].includes(customer.property_type)) {
    const rates = new Set();
    let authority;
    for (const member of members) {
      const tax = await require('./tax-calculator').calculateTax(
        customer.id, member.service_type, taxableBase, { database: trx },
      );
      rates.add(Number(tax.rate));
      authority ||= tax;
    }
    if (rates.size !== 1) return 'mixed_tax_treatment';
    [currentRate] = rates;
    expectedTaxCents = Math.round(Number(authority.amount) * 100);
  }
  const savedTaxCents = Math.round(Number(invoice.tax_amount) * 100);
  if (![currentRate, Number(invoice.tax_rate)].every(Number.isFinite)
      || ![baseCents, savedTaxCents, expectedTaxCents].every(Number.isSafeInteger)
      || Math.min(currentRate, baseCents, savedTaxCents, expectedTaxCents) < 0
      || currentRate !== Number(invoice.tax_rate) || savedTaxCents !== expectedTaxCents) {
    return 'invoice_tax_mismatch';
  }
  return null;
}

async function memberBillingEligibility(member, customer, trx) {
  const notes = member.record_notes || {};
  if ([notes.backfill, notes.invoiceAlreadySent].some(Boolean)) {
    return office('special_completion_billing', member.id);
  }
  if (member.record_status === 'incomplete'
      || ['inspection_only', 'customer_declined'].includes(notes.visitOutcome)) return { lineItems: [] };
  if (member.record_status !== 'completed') return office('record_not_completed', member.id);
  if (notes.oneTimeRecapOnly) return { lineItems: [] };
  if (['monthly_membership', 'annual_prepay'].includes(resolveBillingLane(customer).mode)) {
    return office('covered_billing_lane');
  }
  if (member.prepaid_method || Number(member.prepaid_amount) > 0) return office('prepaid_member', member.id);
  const payer = await require('./payer').resolveForInvoice({
    database: trx, customerId: customer.id, customer, scheduledServiceId: member.id, throwOnError: true,
  });
  if (payer.payerId) return office('payer_billed_member', member.id);
  return null;
}

async function buildMemberLines(member, customer, trx, checkedEligibility = undefined, { deferMissingPrice = false } = {}) {
  const eligibility = checkedEligibility === undefined
    ? await memberBillingEligibility(member, customer, trx) : checkedEligibility;
  if (eligibility) return eligibility;
  const notes = member.record_notes || {};
  const price = Number.parseFloat(member.estimated_price);
  const feeReviewOnly = Boolean(member.source_estimate_id && member.is_recurring
    && !member.is_callback && !isAlwaysFreeServiceType(member.service_type));
  // The canonical review freezes an intentional zero after its discount.
  // Customer-level dues must not replace that performed application's price.
  if (price === 0 && notes.completionPricing?.amountCents === 0) return { lineItems: [], feeReviewOnly };
  const amount = completionInvoiceAmount({
    estimatedPrice: member.estimated_price, isCallback: member.is_callback,
    perApplicationBilling: customer.billing_mode === 'per_application',
    perApplicationFee: customer.per_application_fee, monthlyRate: customer.monthly_rate,
    billingMode: customer.billing_mode,
    // Codex round 4 P1 follow-through: member is `s.*` off scheduled_services,
    // so primary_line_price is on the row — pass it or a fully-discounted $0
    // packet member falls back to the acceptance fee here too.
    primaryLinePrice: member.primary_line_price,
  });
  const eligible = require('./complete-scheduled-service').shouldAutoInvoiceCompletion({
    invoiceAmount: amount, createInvoiceOnComplete: member.create_invoice_on_complete,
    perApplicationBilling: customer.billing_mode === 'per_application',
    explicitPerVisitLane: ['per_visit', 'one_time'].includes(customer.billing_mode),
    hasVisitPrice: price > 0, waveguardTier: customer.waveguard_tier,
    serviceType: member.service_type, isCallback: member.is_callback,
    backfillMintRequired: notes.backfillMintRequired === true,
    autoInvoicePricedVisits: process.env.GATE_AUTOINVOICE_PRICED_VISITS === 'true',
  });
  if (isAlwaysFreeServiceType(member.service_type) || (member.is_callback && !eligible)) return { lineItems: [] };
  // A combined plan's customer-level fallback is not a price for each member.
  // Explicit zero is allowed only when the canonical lane also says zero.
  if (!Number.isFinite(price)) {
    if (deferMissingPrice && member.estimated_price === null) {
      return { lineItems: [], deferredOffice: office('member_price_missing', member.id) };
    }
    return office('member_price_missing', member.id);
  }
  if (price === 0 && amount === 0) return { lineItems: [], feeReviewOnly };
  if (!(price > 0)) return office('member_price_ambiguous', member.id);
  if (!eligible) return office('member_billing_not_enabled', member.id);
  const built = await InvoiceService.buildLineItemsForScheduledService(member.id, {
    fallbackAmount: amount, fallbackDescription: member.service_type, database: trx,
  });
  if (!built.lineItems.length) return office('member_lines_missing', member.id);
  return built;
}

// The member's series parent's LIVE setup-fee claim, or null: scheduled_services.
// pending_setup_fee (positive = queued, negative = a completion mid-mint) on
// the parent. Keyed on the stamp itself, never on how it got there: the
// pay-after-first-visit accept (estimate_data.setupFeeDeferredToFirstVisit)
// and the secure plan-choice lane write the SAME claim, and the secure lane's
// stamps exist with GATE_PAF_SETUP_FEE (and the marker) absent entirely. The
// claim is consumed only by the single-visit completion mint, so a packet mint
// that carries no setup line must never run past it.
async function liveSetupClaim(trx, member) {
  const parentId = member.recurring_parent_id || member.id;
  const parent = await trx('scheduled_services').where({ id: parentId }).first('pending_setup_fee');
  const stamp = parent?.pending_setup_fee != null ? Number(parent.pending_setup_fee) : 0;
  return Number.isFinite(stamp) && stamp !== 0
    ? { parentId, raw: parent.pending_setup_fee, amount: Math.round(Math.abs(stamp) * 100) / 100, queued: stamp > 0 }
    : null;
}

async function deferredSetupClaimStillQueued(trx, member) {
  return !!(await liveSetupClaim(trx, member));
}

// The packet hands this closeout to the office, who bill the visit by hand. A
// QUEUED claim is never cleared into nothing (and never left armed: an ordinary
// invoice does not consume it, so a later single-visit completion would charge
// the fee a second time): on EVERY office-required exit it is PARKED FOR THE
// OFFICE (owner ruling 2026-10-01), in this transaction: the stamp is cleared
// and a setup_fee_office_billing alert is the durable owed-fee record. NO
// invoice is created outside the normal completion mint; the office bills the
// fee by hand, once. A rollback restores the stamp with it, and a park failure
// throws (never swallowed) so the whole packet transaction rolls back. A
// NEGATIVE stamp is a single-visit completion mid-mint that will bill the fee
// itself, left alone. Every member's series is scanned (billed or not), once
// per series.
// Only a member whose visit was really PERFORMED as live work can be the first
// visit the queued fee rides: a declined / inspection-only / incomplete visit
// (record_notes.visitOutcome, even on a 'completed' record),
// a backfill or an already-invoiced completion, a recap-only record, a callback
// or always-free work keeps its series' stamp for the visit that is performed
// (the single-visit completion's own rule). The member must also be a PLAN
// application (is_recurring, the detector's own isPlanApplicationRow rule): a
// non-recurring booster or add-on riding the same grouped stop never takes the
// plan's fee.
function memberPerformedForSetupClaim(member) {
  const notes = member.record_notes || {};
  return member.record_status === 'completed'
    && isPlanApplicationRow(member)
    && !notes.backfill && !notes.invoiceAlreadySent && !notes.oneTimeRecapOnly
    && !['inspection_only', 'customer_declined', 'incomplete'].includes(notes.visitOutcome)
    && !member.is_callback && !isAlwaysFreeServiceType(member.service_type);
}

async function parkQueuedSetupClaimsForOffice(trx, members, { packet, visit }) {
  const parked = [];
  const seen = new Set();
  for (const member of members) {
    if (!memberPerformedForSetupClaim(member)) continue;
    const claim = await liveSetupClaim(trx, member);
    if (!claim?.queued || seen.has(claim.parentId)) continue;
    seen.add(claim.parentId);
    const result = await parkSetupFeeStampForOffice(trx, {
      parentId: claim.parentId, rawAmount: claim.raw, customerId: member.customer_id,
      estimateId: member.source_estimate_id || null, origin: 'grouped closeout handed to the office',
      alertContext: { visitId: visit.id, packetId: packet.id, serviceId: member.id },
      billToScheduledServiceId: member.id,
    });
    if (result) parked.push({ amount: result.amount, seriesId: result.parentId, alertId: result.alertId });
  }
  return parked;
}

// Every office-required exit of the mint hands over the queued claims it found.
// Every outcome of the packet mint, not only an office exit: this mint never
// carries a setup line, so a queued fee left on a performed plan member's
// series after it (a $0 member never checked by the billed / fee-review scan,
// or a closeout that invoiced another member) would otherwise slide to a later
// visit. Parked for the office in the same transaction (the alert is the
// durable record).
async function mintPacketInvoice(args) {
  const result = await mintPacketInvoiceInner(args);
  const parked = await parkQueuedSetupClaimsForOffice(args.trx, args.members, args);
  return parked.length ? { ...result, setupFeeParked: parked } : result;
}

async function mintPacketInvoiceInner({ packet, visit, members, customer, trx }) {
  const billed = [];
  const feeReviewCandidates = [];
  const adoptionMembers = [];
  const deferredOffices = [];
  for (const member of members) {
    const eligibility = await memberBillingEligibility(member, customer, trx);
    const adoptionEligible = !eligibility && !member.is_callback
      && !isAlwaysFreeServiceType(member.service_type);
    const built = await buildMemberLines(member, customer, trx, eligibility, {
      deferMissingPrice: adoptionEligible && Boolean(member.source_estimate_id) && !member.recurring_parent_id,
    });
    if (built.state === 'office_required') return built;
    if (built.deferredOffice) deferredOffices.push(built.deferredOffice);
    // Acceptance itemization covers every performed first-visit member,
    // including a member whose mutable scheduled price is now zero. Callback
    // and always-free work never inherits the accepted first-application bill.
    if (adoptionEligible) adoptionMembers.push(member);
    if (built.lineItems.length) billed.push({ member, lineItems: built.lineItems });
    else if (built.feeReviewOnly) feeReviewCandidates.push(member);
  }
  const sourceIds = [...new Set(billed.map(({ member }) => member.source_estimate_id || null))];
  if (sourceIds.length > 1) return office('mixed_estimate_billing');
  // A performed plan application discounted to zero can still owe its
  // accepted setup fee. Lock its fee authority, but only billed estimates
  // inspect stamped application invoices before this packet can mint.
  const billedEstimateIds = new Set(sourceIds.filter(Boolean));
  const feeEstimateIds = feeReviewCandidates.map((member) => member.source_estimate_id);
  for (const estimateId of [...new Set([...billedEstimateIds, ...feeEstimateIds])].sort()) {
    const lock = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked',
      [`unminted_setup_fee_manual_billing:${estimateId}`]);
    if (!lock.rows[0].locked) visitBusy();
  }
  // A linked acceptance invoice is an ownership candidate only for performed
  // first-visit members. Historical/nonbillable packet rows remain outside
  // packet billing and cannot make an unrelated invoice own this closeout.
  let existing = [];
  let hasAcceptanceCandidate = false;
  if (adoptionMembers.length) {
    // The caller already owns every member mint lock. Peek without invoice
    // row locks so an unrelated zero-price member does not widen the estimate
    // lock set; then acquire only the stamp lock named by a plausible linked
    // acceptance invoice and re-read the invoice rows under no-wait locks.
    const peek = await trx('invoices').where(function linkedMember() {
      this.whereIn('scheduled_service_id', adoptionMembers.map((member) => member.id))
        .orWhereIn('service_record_id', adoptionMembers.map((member) => member.record_id));
    }).select('id', 'scheduled_service_id', 'service_record_id', 'title', 'notes');
    const candidateEstimateIds = new Set();
    for (const row of peek) {
      const linked = adoptionMembers.find((member) => member.id === row.scheduled_service_id
        || member.record_id === row.service_record_id);
      const stampedId = require('./setup-fee-alert-reconcile').acceptedEstimateIdFromNotes(row.notes);
      if (linked?.source_estimate_id
          && stampedId === String(linked.source_estimate_id).toLowerCase()
          && require('./estimate-first-application-invoice').isAutoGeneratedPayPerApplicationInvoice(row)) {
        hasAcceptanceCandidate = true;
        candidateEstimateIds.add(linked.source_estimate_id);
      }
    }
    for (const estimateId of [...candidateEstimateIds].sort()) {
      const lock = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked',
        [`unminted_setup_fee_manual_billing:${estimateId}`]);
      if (!lock.rows[0].locked) visitBusy();
    }
  }
  const ownershipMembers = hasAcceptanceCandidate
    ? adoptionMembers : billed.map(({ member }) => member);
  if (ownershipMembers.length) {
    try {
      existing = await trx('invoices').where(function linkedMember() {
        this.whereIn('scheduled_service_id', ownershipMembers.map((member) => member.id))
          .orWhereIn('service_record_id', ownershipMembers.map((member) => member.record_id));
      }).orderBy('id').forUpdate().noWait();
    } catch (error) { visitBusy(error); }
  }
  if (existing.length) {
    if (hasAcceptanceCandidate) {
      const adoptionIds = new Set(adoptionMembers.map((member) => member.id));
      if (billed.some(({ member }) => !adoptionIds.has(member.id))) return office('existing_member_invoice');
      if (existing.length === 1) {
        const taxRefusal = await acceptanceTaxRefusal({
          invoice: existing[0], members: adoptionMembers, customer, trx,
        });
        if (taxRefusal) return office(taxRefusal);
      }
      return adoptAcceptanceInvoice({ packet, members: adoptionMembers, customer, trx, invoices: existing });
    }
  }
  if (deferredOffices.length) return deferredOffices[0];
  if (existing.length) return office('existing_member_invoice');
  if (!billed.length && !feeReviewCandidates.length) return { state: 'no_charge', invoiceId: null };
  for (const estimateId of [...billedEstimateIds].sort()) {
    let stamped;
    try {
      stamped = await trx('invoices').where({ customer_id: customer.id })
        .where('notes', 'ilike', `%accepted estimate #${estimateId}%`)
        .where(function relevantApplication() {
          this.where('service_date', dateOnly(visit.scheduled_date)).orWhereNull('service_date');
        }).forUpdate().noWait().select('status', 'line_items', 'notes');
    } catch (error) { visitBusy(error); }
    const { invoiceContainsOnlySetupFeeCharges, invoiceContainsSetupFeeLine } = require('./estimate-first-application-invoice');
    if (stamped.some((invoice) => {
      if (invoice.status === 'void') return false;
      if (invoice.status === 'refunded') return true;
      if (['canceled', 'cancelled'].includes(invoice.status)) return invoiceContainsSetupFeeLine(invoice);
      return !invoiceContainsOnlySetupFeeCharges(invoice);
    })) return office('existing_member_invoice');
  }
  // These financial reads see coverage under each applicable estimate lock.
  for (const { member } of billed) {
    const prior = await require('./estimate-first-application-invoice')
      .findFirstApplicationInvoiceForEstimateService(member, trx);
    if ([prior.invoice, prior.liveBeside, prior.canceledSetupFee].some(Boolean)) {
      return office('existing_estimate_invoice', member.id);
    }
  }
  for (const member of [...billed.map((entry) => entry.member), ...feeReviewCandidates]) {
    // A setup fee queued on the series (the pay-after-first-visit accept's
    // deferral or a secure plan-choice stamp: scheduled_services.
    // pending_setup_fee) is consumed ONLY by the single-visit completion
    // mint. This combined-packet mint carries no setup line, so letting it
    // proceed would silently push the fee to a later visit — send the closeout
    // to the office instead, never "deferred, therefore fine".
    // (mintPacketInvoice consumes the queued claim into its draft on this and
    // every other office-required exit.)
    if (await liveSetupClaim(trx, member)) return office('setup_fee_deferred_claim', member.id);
    // A canceled fee is treated as covered with completing-visit context only
    // because the billed application's prior-invoice lane parks that case.
    // A zero-price member skips that lane, so its canceled fee remains owed.
    const obligation = await require('./setup-fee-obligation').findUnmintedSetupFeeObligation({
      sourceEstimateId: member.source_estimate_id, customerId: customer.id,
      ...(feeReviewCandidates.includes(member) ? {} : { excludeScheduledServiceId: member.id }),
      visitPlanRow: member,
    }, trx);
    if (obligation.owed) return office('setup_fee_requires_review', member.id);
  }
  if (!billed.length) return { state: 'no_charge', invoiceId: null };
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
  // The packet already holds customer, visit and billed-member locks. Keep
  // the deposit key through the read, invoice insert and exact consumption;
  // a receipt arriving first is seen here, and one arriving later reconciles
  // against the committed packet invoice.
  if (sourceEstimateId) await acquireEstimateDepositLedgerLock(trx, sourceEstimateId);
  const deposit = sourceEstimateId ? await pendingDepositCredit(sourceEstimateId, trx) : null;
  const invoice = await InvoiceService.create({
    database: trx, customerId: customer.id, scheduledServiceId: billed[0].member.id,
    serviceRecordId: billed[0].member.record_id, serviceDate: visit.scheduled_date, dueDate: dateOnly(visit.scheduled_date),
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
  await linkPacketInvoice({ packet, invoice, members: billed.map(({ member }) => member), customer, trx });
  return { state: 'invoice_ready', invoiceId: invoice.id, total: Number(invoice.total) };
}

async function linkPacketInvoice({ packet, invoice, members, customer, trx, acceptedLineItems }) {
  await trx('visit_completion_packet_items').where({ packet_id: packet.id })
    .whereIn('scheduled_service_id', members.map((member) => member.id))
    .update({ invoice_id: invoice.id, updated_at: trx.fn.now() });
  // Server-owned charge ceiling survives invoice edits and closeout retries.
  // It is recorded beside the submitted forms, never accepted from a client.
  await trx('visit_completion_packets').where({ id: packet.id }).update({
    payload: trx.raw('payload || ?::jsonb', [JSON.stringify({ billingSnapshot: {
      ...(acceptedLineItems ? { acceptedLineItems } : {}),
      invoiceId: invoice.id, totalCents: Math.round(Number(invoice.total) * 100),
      netSubtotalCents: Math.round((Number(invoice.subtotal) - Number(invoice.discount_amount || 0)) * 100),
      billedServiceIds: members.map((member) => member.id),
      billingLane: resolveBillingLane(customer).mode,
      memberPricing: members.map((member) => ({ id: member.id,
        price: member.estimated_price === null ? null : Number(member.estimated_price),
        serviceType: member.service_type, serviceId: member.service_id,
        isCallback: Boolean(member.is_callback), invoiceOnComplete: Boolean(member.create_invoice_on_complete) })),
    } })]), updated_at: trx.fn.now(),
  });
}

async function adoptAcceptanceInvoice({ packet, members, customer, trx, invoices }) {
  const rejected = office('existing_member_invoice');
  if (invoices.length !== 1 || !members.length) return rejected;
  const invoice = invoices[0];
  const {
    isAutoGeneratedPayPerApplicationInvoice, invoiceHasPositiveSetupFeeLine,
    classifyAcceptedEstimateInvoiceCoverage, acceptanceSetupFeeMatchesAuthority,
  } = require('./estimate-first-application-invoice');
  const sourceId = members[0].source_estimate_id;
  const stampedId = require('./setup-fee-alert-reconcile').acceptedEstimateIdFromNotes(invoice.notes);
  if (![sourceId, isAutoGeneratedPayPerApplicationInvoice(invoice),
    stampedId === String(sourceId).toLowerCase(),
    invoice.customer_id === customer.id, invoice.status === 'draft'].every(Boolean)) return rejected;
  const priorOwnership = ['visit_completion_packet_id', 'service_record_id', 'payer_id',
    'stripe_payment_intent_id', 'sent_at', 'sms_sent_at', 'payment_recorded_at', 'scheduled_send_at'];
  if (priorOwnership.some((field) => invoice[field])) return rejected;
  // Each frozen primary line must name exactly one completed first-visit
  // member. Removed, moved, declined, covered or extra work cannot inherit
  // the acceptance invoice's whole-plan charge.
  const lines = InvoiceService._parseInvoiceLineItems(invoice.line_items);
  const primary = lines.filter(InvoiceService.lineIsBaseApplication);
  if (lines.some((line) => Number(line.amount) > 0 && !InvoiceService.lineIsBaseApplication(line)
      && !invoiceHasPositiveSetupFeeLine({ line_items: [line] }))) return rejected;
  try {
    if (!await acceptanceSetupFeeMatchesAuthority({ invoice, estimateId: sourceId }, trx)) return rejected;
  } catch (error) { visitBusy(error); }
  const identities = members.map((member) => [
    `scheduled_${member.id}_primary`, member.service_type, member.service_id,
  ]).sort();
  const frozenIdentities = primary.map((line) => [
    line.client_id, line.accepted_service_type, line.accepted_service_id,
  ]).sort();
  if (JSON.stringify(frozenIdentities) !== JSON.stringify(identities)
      || primary.some((line) => !(Number(line.amount) > 0))) return rejected;
  const applicationNet = Math.round((primary.reduce((sum, line) => sum + Number(line.amount), 0)
    - Number(invoice.discount_amount || 0)) * 100);
  const scheduledCeiling = members.reduce((sum, member) => sum + Math.round(Number(member.estimated_price) * 100), 0);
  if (![applicationNet, scheduledCeiling].every(Number.isSafeInteger)
      || applicationNet > scheduledCeiling) return rejected;
  for (const member of members) {
    if (member.source_estimate_id !== sourceId
        || member.recurring_parent_id || member.status !== 'completed') return rejected;
    if (await memberBillingEligibility(member, customer, trx)) return rejected;
    if (member.is_callback || isAlwaysFreeServiceType(member.service_type)) return rejected;
    if (await require('./annual-prepay-renewals').annualPrepayCoversVisit(member, trx, { throwOnError: true })) return rejected;
  }
  // Grant writers and the collection fence use this customer lock. Adoption
  // must classify retention under the same authority before taking offer rows.
  const grantLock = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?::text)) AS locked',
    [String(customer.id)]);
  if (!grantLock.rows[0].locked) visitBusy();
  const retainedFamilies = members.filter((member) => member.is_recurring || member.recurring_ongoing)
    .map(require('./cancellation-processor').familyOfServiceRow).filter(Boolean);
  let offers;
  try {
    offers = await trx('retention_offers').where({ customer_id: customer.id, status: 'granted' })
      .whereIn('family_key', retainedFamilies).forUpdate().noWait();
  } catch (error) { visitBusy(error); }
  const retentionNeedsReview = offers.some((offer) => require('./cancellation-resolution/retention-offer')
    .retentionDiscountForInvoice(offer, applicationNet / 100));
  const owner = members.find((member) => member.id === invoice.scheduled_service_id);
  if (!owner || !dateOnly(invoice.service_date)
      || dateOnly(invoice.service_date) !== dateOnly(owner.scheduled_date)) return rejected;

  // Application ownership is visit-date scoped; setup-fee coverage remains
  // estimate-wide. Lock both shapes so a concurrent manual writer cannot race
  // the packet ownership stamp.
  let competingRows;
  try {
    competingRows = await trx('invoices as i')
      .leftJoin('scheduled_services as s', 's.id', 'i.scheduled_service_id')
      .where('i.customer_id', customer.id).whereNot('i.id', invoice.id)
      .where(function acceptedEstimateInvoice() {
        this.where('s.source_estimate_id', sourceId)
          .orWhere('i.notes', 'ilike', `%accepted estimate #${sourceId}%`);
      }).orderBy('i.id').forUpdate('i').noWait()
      .select('i.id', 'i.status', 'i.service_date', 'i.line_items', 'i.notes', 's.scheduled_date');
  } catch (error) { visitBusy(error); }
  const ownerDate = dateOnly(owner.scheduled_date);
  const competing = competingRows.some((row) => {
    const status = String(row.status || '').toLowerCase();
    if (status === 'void') return false;
    const coverage = classifyAcceptedEstimateInvoiceCoverage(row, ownerDate);
    if (coverage.hasSetupFee) return true;
    if (!coverage.matchesApplicationDate) return false;
    if (status === 'refunded') return true;
    if (['canceled', 'cancelled'].includes(status)) return false;
    return !coverage.setupFeeOnly;
  });
  const arrangements = await trx('payment_plans').where({ invoice_id: invoice.id }).first('id');
  const attempt = await trx('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id }).first('id');
  const addons = await trx('scheduled_service_addons').whereIn('scheduled_service_id', members.map((member) => member.id)).first('id');
  if ([competing, arrangements, attempt, addons, retentionNeedsReview].some(Boolean)) return rejected;
  try {
    if (!await require('./estimate-deposits').invoiceDepositCreditIsBacked(invoice, trx)) return rejected;
  } catch (error) { visitBusy(error); }
  await trx('invoices').where({ id: invoice.id }).update({ visit_completion_packet_id: packet.id,
    service_record_id: owner.record_id, updated_at: trx.fn.now() });
  await linkPacketInvoice({ packet, invoice, members, customer, trx, acceptedLineItems: lines });
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
    if (visit.billing_hold) {
      // A hold set before this mint ran (the office, a payer withdrawal) still
      // hands the closeout over: any queued claim on its series is parked for the
      // office here too, never left armed behind the manual bill.
      const heldMembers = await trx('visit_completion_packet_items as i')
        .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
        .join('service_records as r', 'r.id', 'i.service_record_id')
        .where('i.packet_id', packet.id).orderBy('s.id')
        .select('s.id', 's.customer_id', 's.source_estimate_id', 's.recurring_parent_id', 's.is_callback',
          's.is_recurring', 's.service_type', 'r.status as record_status', 'r.structured_notes as record_notes');
      const parked = await parkQueuedSetupClaimsForOffice(trx, heldMembers, { packet, visit });
      if (parked.length) {
        await trx('visit_completion_packets').where({ id: packet.id }).update({
          payload: trx.raw('payload || ?::jsonb', [JSON.stringify({ setupFeeParked: parked })]), updated_at: trx.fn.now(),
        });
      }
      return { ...office(packet.error || 'visit_billing_held'), ...(parked.length ? { setupFeeParked: parked } : {}) };
    }
    if (visit.billing_frozen_at) return { state: 'no_charge', invoiceId: null };
    const members = await trx('visit_completion_packet_items as i')
      .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
      .join('service_records as r', 'r.id', 'i.service_record_id')
      .leftJoin('services as catalog', 'catalog.id', 's.service_id')
      .where('i.packet_id', packet.id).orderBy('s.id').forUpdate('s')
      .select('s.*', 'r.id as record_id', 'r.status as record_status', 'r.structured_notes as record_notes',
        'r.customer_id as record_customer_id', 'r.scheduled_service_id as record_scheduled_service_id',
        'catalog.service_key', 'catalog.name as service_name');
    if (members.length !== itemIds.length || members.length < 1
        || members.some((member) => member.visit_id !== visit.id || member.customer_id !== customer.id
          || member.record_customer_id !== customer.id || member.record_scheduled_service_id !== member.id)) {
      throw new Error('Visit billing member identity mismatch');
    }
    const result = await mintPacketInvoice({ packet, visit, members, customer, trx });
    const held = result.state === 'office_required';
    await trx('service_visits').where({ id: visit.id }).update({
      billing_hold: held, billing_frozen_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    if (held) {
      await trx('visit_completion_packets').where({ id: packet.id }).update({
        error: result.reason,
        // The setup fee the held closeout parked for the office rides the
        // packet, so the office review alert says it was handed over by hand.
        ...(result.setupFeeParked ? { payload: trx.raw('payload || ?::jsonb', [JSON.stringify({ setupFeeParked: result.setupFeeParked })]) } : {}),
        updated_at: trx.fn.now(),
      });
    }
    await trx('visit_effects').insert({
      visit_id: visit.id, effect_type: 'billing_ready', dedupe_key: `${visit.id}:billing_ready`,
      status: held ? 'failed' : 'sent', provider_id: result.invoiceId,
      last_error: held ? result.reason : null, sent_at: held ? null : trx.fn.now(), attempts: 1,
    });
    return result;
  };
  return database.isTransaction ? run(database) : database.transaction(run);
}

module.exports = { createVisitCompletionInvoice, deferredSetupClaimStillQueued };
