'use strict';

/**
 * Read-only "what will the close-out bill for this visit?" for ONE open
 * visit (scheduled_services id). Backs the Intelligence Bar tool
 * get_closeout_bill_preview.
 *
 * It decides with the completion's own code, not a copy of it:
 *   - the mint decision is shouldAutoInvoiceCompletion
 *     (complete-scheduled-service.js), called with the same inputs the
 *     completion builds (completionLaneFlags, completionInvoiceAmount,
 *     membershipDuesCoverVisit, annualPrepay coverage, the completion invoice
 *     lookups in completion-invoice-candidate.js, perApplicationCompletionVoidHold,
 *     and the setup-fee detector findUnmintedSetupFeeObligation);
 *   - the lines and discount lines are InvoiceService.buildLineItemsForScheduledService,
 *     the builder the completion mint replays;
 *   - the label of the charge (invoice or Auto Pay charge) is predictCompletionBilling,
 *     the schedule sheet's own prediction.
 * Nothing here writes, texts, emails or calls Stripe. Customer names, phones
 * and addresses never appear in the result.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const BillingLane = require('./billing-lane');
const InvoiceCandidate = require('./completion-invoice-candidate');

const OPEN_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function gateStates() {
  const gates = require('../config/feature-gates');
  return {
    GATE_UNMINTED_SETUP_FEE_PARK: process.env.GATE_UNMINTED_SETUP_FEE_PARK === 'true',
    GATE_AUTOINVOICE_PRICED_VISITS: process.env.GATE_AUTOINVOICE_PRICED_VISITS === 'true',
    GATE_COMPLETION_AUTOPAY_CHARGE: gates.gates?.completionAutopayCharge === true,
    GATE_INVOICE_ESTIMATE_DISCOUNT_LINES: typeof gates.invoiceEstimateDiscountLinesLive === 'function'
      ? gates.invoiceEstimateDiscountLinesLive() === true
      : false,
  };
}

async function loadVisit(database, serviceId) {
  return database('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .where('s.id', serviceId)
    .first(
      's.*',
      'c.billing_mode as cust_billing_mode', 'c.waveguard_tier as cust_waveguard_tier',
      'c.monthly_rate as cust_monthly_rate', 'c.per_application_fee as cust_per_application_fee',
    );
}

// The invoice state the completion reads before it mints: the visit's own live
// invoice, a refunded one (parks the visit), the estimate's combined
// first-application invoice, and a voided combined invoice with no replacement.
async function loadInvoiceState(database, visit) {
  let existing = await InvoiceCandidate.completionSuppressorInvoiceLookup(database, { scheduled_service_id: visit.id });
  const refunded = await InvoiceCandidate.completionTerminalInvoiceLookup(database, { scheduledServiceId: visit.id });
  let newestLive = null;
  if (refunded && existing) {
    newestLive = await InvoiceCandidate.completionNewestLiveInvoiceLookup(database, { scheduledServiceId: visit.id });
  }
  const reconciled = InvoiceCandidate.reconcileLiveVsRefunded(existing, refunded, newestLive);
  existing = reconciled.existing;
  let terminal = reconciled.terminal;
  let liveBeside = reconciled.liveBeside;
  let voidHold = null;
  if (!existing && !terminal) {
    const { findFirstApplicationInvoiceForEstimateService } = require('./estimate-first-application-invoice');
    const sibling = await findFirstApplicationInvoiceForEstimateService(visit, database);
    const split = InvoiceCandidate.splitTerminalCompletionInvoice(sibling.invoice);
    existing = split.existing;
    terminal = split.terminal;
    liveBeside = split.terminal ? (sibling.liveBeside || null) : null;
    if (!existing && !terminal && sibling.canceledSetupFee) terminal = { ...sibling.canceledSetupFee, setupFee: true };
    if (!existing && !terminal) {
      voidHold = await BillingLane.perApplicationCompletionVoidHold({
        isCallback: visit.is_callback, serviceType: visit.service_type, svc: visit, dbConn: database,
      });
      if (voidHold) terminal = { id: voidHold.id, invoice_number: voidHold.invoice_number, status: voidHold.status };
    }
  }
  return { existing, terminal, liveBeside };
}

async function loadCoverage(database, visit, billing, flags) {
  const AnnualPrepay = require('./annual-prepay-renewals');
  let annualVerdict = null;
  try {
    const deferred = await AnnualPrepay.deferredPrepayHoldCustomerIds(database, [visit.customer_id]);
    annualVerdict = await AnnualPrepay.annualCoverageVerdictForPrediction(visit, database, { deferredCustomerIds: deferred });
  } catch (err) {
    logger.warn(`[closeout-bill-preview] annual prepay verdict unavailable for ${visit.id}: ${err.message}`);
  }
  let duesCollected = false;
  const membershipLane = flags.explicitMembershipLane
    || (!visit.cust_billing_mode && BillingLane.isMembershipTier(visit.cust_waveguard_tier));
  if (!billing.autopay_active && !billing.payer_billed && !flags.perApplicationBilling
    && !flags.annualPrepayBilling && membershipLane) {
    try {
      const day = String(visit.scheduled_date instanceof Date ? visit.scheduled_date.toISOString() : visit.scheduled_date).slice(0, 10);
      duesCollected = await BillingLane.monthlyDuesCollected(database, visit.customer_id, new Date(`${day}T12:00:00Z`), {
        excludeScheduledServiceId: visit.id,
      });
    } catch (err) {
      logger.warn(`[closeout-bill-preview] dues lookup unavailable for ${visit.id}: ${err.message}`);
    }
  }
  return { annualVerdict, duesCollected };
}

// Setup fee facts. The detector the completion parks on, plus whether another
// visit's parked alert already owns the fee.
async function loadUnmintedObligation(database, visit) {
  const { findUnmintedSetupFeeObligation } = require('./setup-fee-obligation');
  const found = await findUnmintedSetupFeeObligation({
    sourceEstimateId: visit.source_estimate_id,
    customerId: visit.customer_id,
    excludeScheduledServiceId: visit.id,
    visitPlanRow: { is_recurring: visit.is_recurring, recurring_parent_id: visit.recurring_parent_id || null },
  }, database);
  if (!found.owed) return { obligation: null, parkedElsewhere: false };
  const prior = await database('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [`unminted_setup_fee_manual_billing:${visit.source_estimate_id}`])
    .whereRaw("COALESCE(metadata->>'resolvedCovered', '') <> 'true'")
    .first('id', 'metadata');
  const meta = typeof prior?.metadata === 'string' ? JSON.parse(prior.metadata) : prior?.metadata;
  return { obligation: found, parkedElsewhere: !!prior && String(meta?.scheduledServiceId || '') !== String(visit.id) };
}

// The secure plan-choice fee that rides the first mint as its own line
// (pending_setup_fee on the series parent), as the completion claims it.
async function loadQueuedSetupClaim(database, visit) {
  const parentId = visit.recurring_parent_id || visit.id;
  const parent = await database('scheduled_services').where({ id: parentId }).first('pending_setup_fee');
  const raw = parent?.pending_setup_fee != null ? Number(parent.pending_setup_fee) : 0;
  const boosterUnderPlan = !!visit.recurring_parent_id && !visit.is_recurring;
  if (!(raw > 0) || boosterUnderPlan || visit.is_callback) return null;
  const { prepayWaivesDeferredSetupFee } = require('./setup-fee-obligation');
  return (await prepayWaivesDeferredSetupFee(database, { seriesId: parentId, visit })) ? null : money(raw);
}

async function loadSetupFee(database, visit) {
  const out = { obligation: null, parkedElsewhere: false, claimAmount: null, detectorError: false };
  const attempt = async (label, read) => {
    try { await read(); } catch (err) {
      out.detectorError = true;
      logger.warn(`[closeout-bill-preview] setup fee ${label} unavailable for ${visit.id}: ${err.message}`);
    }
  };
  if (visit.source_estimate_id) await attempt('check', async () => Object.assign(out, await loadUnmintedObligation(database, visit)));
  await attempt('claim read', async () => { out.claimAmount = await loadQueuedSetupClaim(database, visit); });
  return out;
}

async function loadProfileBillingType(database, visit) {
  try {
    const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
    const profile = await resolveCompletionProfileForScheduledService(visit, database);
    return { known: true, billingType: String(profile?.billingType || '').toLowerCase() };
  } catch (err) {
    logger.warn(`[closeout-bill-preview] completion profile unavailable for ${visit.id}: ${err.message}`);
    return { known: false, billingType: '' };
  }
}

async function gatherFacts(serviceId, database = db) {
  const visit = await loadVisit(database, serviceId);
  if (!visit) return null;
  const flags = BillingLane.completionLaneFlags(visit.cust_billing_mode);
  const today = etDateString();
  const { _private: { billingFacts } } = require('./invoice-tier-line-check');
  const billing = (await billingFacts(database, [visit], today)).get(String(visit.id)) || {};
  const [invoices, coverage, setup, profile] = await Promise.all([
    loadInvoiceState(database, visit),
    loadCoverage(database, visit, billing, flags),
    loadSetupFee(database, visit),
    loadProfileBillingType(database, visit),
  ]);
  return { visit, flags, billing, invoices, coverage, setup, profile };
}

function invoiceRef(inv) {
  if (!inv) return null;
  return {
    id: inv.id,
    invoice_number: inv.invoice_number || null,
    status: inv.status || null,
    ...(inv.total != null ? { total: money(inv.total) } : {}),
  };
}

// The inputs of the completion's own mint decision, built exactly as the
// completion builds them for a live, performed, non-backfill visit.
function mintInputs(f, amounts, setupHold) {
  const { visit, flags, billing, invoices, coverage } = f;
  const payer = billing.payer_billed === true;
  const hasVisitPrice = visit.estimated_price != null && Number(visit.estimated_price) > 0;
  const autopayCoversVisit = BillingLane.membershipDuesCoverVisit({
    visitIsPayerBilled: payer,
    perApplicationBilling: flags.perApplicationBilling,
    annualPrepayBilling: flags.annualPrepayBilling,
    customerAutopayActive: billing.autopay_active === true,
    duesCollectedThisMonth: coverage.duesCollected,
    hasVisitPrice,
    isRecurring: visit.is_recurring,
    waveguardTier: visit.cust_waveguard_tier,
    monthlyRate: visit.cust_monthly_rate,
    billingMode: visit.cust_billing_mode,
  });
  const annualPrepayCovered = !payer && coverage.annualVerdict === true;
  const prepaidCovered = annualPrepayCovered
    || (!payer && visit.prepaid_method !== require('./annual-prepay-renewals').ANNUAL_PREPAY_PREPAID_METHOD
      && visit.prepaid_amount != null && Number(visit.prepaid_amount) > 0
      && Number(visit.prepaid_amount) >= amounts.invoiceAmount);
  const input = {
    issuedInvoiceCloseout: false,
    recapReviewOnly: false,
    alreadyPaid: false,
    prepaidCovered,
    autopayCoversVisit,
    preMintedInvoice: invoices.existing || null,
    existingCompletionInvoice: invoices.existing || null,
    terminalInvoiceOnVisit: !!invoices.terminal,
    unmintedSetupFeeHold: setupHold,
    createInvoiceOnComplete: visit.create_invoice_on_complete,
    waveguardTier: visit.cust_waveguard_tier,
    explicitMembership: flags.explicitMembershipLane,
    explicitPerVisitLane: flags.explicitPerVisitLane,
    perApplicationBilling: flags.perApplicationBilling,
    annualPrepayBilling: flags.annualPrepayBilling,
    hasVisitPrice,
    invoiceAmount: amounts.invoiceAmount,
    autoInvoicePricedVisits: process.env.GATE_AUTOINVOICE_PRICED_VISITS === 'true',
    serviceType: visit.service_type,
    isCallback: visit.is_callback,
    visitPerformed: true,
    backfillMintRequired: null,
    typedOneTimeBilling: f.profile.known && f.profile.billingType === 'one_time' && visit.followup_included !== true,
    isBackfillCompletion: false,
    annualPrepayCovered,
  };
  return { input, autopayCoversVisit, annualPrepayCovered, prepaidCovered };
}

function invoiceAmountOf(visit, flags) {
  return BillingLane.completionInvoiceAmount({
    estimatedPrice: visit.estimated_price,
    isCallback: visit.is_callback,
    perApplicationBilling: flags.perApplicationBilling,
    perApplicationFee: visit.cust_per_application_fee,
    monthlyRate: visit.cust_monthly_rate,
    billingMode: visit.cust_billing_mode,
    primaryLinePrice: visit.primary_line_price,
    serviceType: visit.service_type,
  });
}

// The charge the sheet promises (invoice vs saved-card charge, net of a recorded prepayment).
function sheetPrediction(f, autopayCoversVisit) {
  const { visit, billing, coverage } = f;
  const lane = BillingLane.resolveBillingLane({
    billing_mode: visit.cust_billing_mode, waveguard_tier: visit.cust_waveguard_tier, monthly_rate: visit.cust_monthly_rate,
  });
  return BillingLane.predictCompletionBilling({
    lane: lane.mode,
    billingMode: visit.cust_billing_mode || null,
    autopayActive: billing.autopay_active === true,
    estimatedPrice: visit.estimated_price != null ? Number(visit.estimated_price) : null,
    primaryLinePrice: visit.primary_line_price,
    monthlyRate: visit.cust_monthly_rate,
    perApplicationFee: visit.cust_per_application_fee,
    isRecurring: !!visit.is_recurring,
    isCallback: !!visit.is_callback,
    serviceType: visit.service_type,
    payerBilled: billing.payer_billed === true,
    prepaidAmount: visit.prepaid_amount,
    prepaidMethod: visit.prepaid_method || null,
    annualCoverageValidated: coverage.annualVerdict,
    duesCollectedThisMonth: coverage.duesCollected || autopayCoversVisit === true,
    completionAutopayChargeEnabled: gateStates().GATE_COMPLETION_AUTOPAY_CHARGE,
  });
}

function setupFeeSummary(f, setupHold, gates) {
  const { obligation, claimAmount, detectorError } = f.setup;
  const owed = obligation ? money(obligation.setupFee) : null;
  return {
    never_invoiced: !!obligation,
    amount: owed,
    held_for_manual_billing: setupHold,
    park_gate_on: gates.GATE_UNMINTED_SETUP_FEE_PARK,
    rides_on_this_invoice: claimAmount,
    check_unavailable: detectorError || undefined,
  };
}

// First matching reason wins; the boolean itself always comes from shouldAutoInvoiceCompletion.
function noInvoiceReason(f, ctx) {
  const { invoices } = f;
  const { setupHold, flags: cover, prediction } = ctx;
  if (invoices.existing) {
    const ref = invoiceRef(invoices.existing);
    return { code: 'already_invoiced', text: `already invoiced ${ref.invoice_number || ref.id} (${ref.status}); the completion reuses it and cuts no second invoice` };
  }
  if (invoices.terminal) {
    const ref = invoiceRef(invoices.terminal);
    return { code: 'held_for_manual_billing', text: `held for manual billing: invoice ${ref.invoice_number || ref.id} on this visit is ${ref.status}; the completion mints no replacement and raises a billing alert` };
  }
  if (setupHold) {
    const fee = money(f.setup.obligation.setupFee);
    return { code: 'held_for_manual_billing', text: `held for manual billing: the $${fee.toFixed(2)} setup fee was never invoiced, so the completion parks the visit and the office bills the fee and this application together` };
  }
  if (cover.autopayCoversVisit) return { code: 'covered_by_monthly_dues', text: 'covered by monthly membership dues; no invoice is cut for this visit' };
  if (cover.annualPrepayCovered) return { code: 'covered_by_annual_prepay', text: 'covered by the annual prepay; no invoice is cut for this visit' };
  if (cover.prepaidCovered) return { code: 'covered_by_prepayment', text: 'covered by a payment already recorded on the visit; no invoice is cut' };
  if (prediction.kind === 'no_charge') return { code: 'no_charge', text: `nothing bills (${prediction.reason || 'no amount on file'})` };
  if (prediction.kind === 'covered_membership') return { code: 'covered_by_monthly_dues', text: 'covered by monthly membership dues; no invoice is cut for this visit' };
  return { code: 'no_mint_trigger', text: 'the completion mints no invoice for this visit: no invoice-on-complete flag, membership tier, billing lane or priced-visit gate applies' };
}

function splitLines(lineItems) {
  const lines = [];
  const discounts = [];
  for (const item of lineItems || []) {
    const amount = money(item.amount);
    if (amount < 0) discounts.push({ name: item.description || 'Discount', amount: money(Math.abs(amount)) });
    else if (amount > 0) lines.push({ description: item.description || 'Service', amount });
  }
  return { lines, discounts };
}

async function defaultBuildLines(visit, amount, database) {
  const InvoiceService = require('./invoice');
  const built = await InvoiceService.buildLineItemsForScheduledService(visit.id, {
    fallbackAmount: amount, fallbackDescription: visit.service_type, database, strictReads: true,
  });
  return built.lineItems;
}

async function defaultPreviewTax(visit, net, database) {
  const InvoiceService = require('./invoice');
  return InvoiceService.previewInvoiceTotals({
    customerId: visit.customer_id, amount: net, scheduledServiceId: visit.id, database,
  });
}

async function priceBlock(f, amount, deps, database) {
  const notes = [];
  let lineItems = [];
  try {
    lineItems = await deps.buildLines(f.visit, amount, database);
  } catch (err) {
    notes.push(`Invoice lines could not be built (${err.message}); only the amount is shown.`);
  }
  const { lines, discounts } = splitLines(lineItems);
  if (!lines.length && amount > 0) lines.push({ description: f.visit.service_type || 'Service', amount: money(amount) });
  const setupLine = f.setup.claimAmount != null && !f.invoices.existing
    ? { description: 'One-time setup fee', amount: f.setup.claimAmount } : null;
  if (setupLine) lines.push(setupLine);
  const subtotal = money(lines.reduce((s, l) => s + l.amount, 0));
  const discountTotal = money(discounts.reduce((s, d) => s + d.amount, 0));
  const net = money(subtotal - discountTotal);
  let tax = null;
  try {
    const t = await deps.previewTax(f.visit, net, database);
    tax = { rate: Number(t.tax_rate) || 0, amount: money(t.tax_amount), total: money(t.total) };
  } catch {
    notes.push('Tax could not be previewed; total shown before tax.');
  }
  return { lines, discounts, subtotal, discount_total: discountTotal, net, tax, notes };
}

function discountNote(f, price) {
  if (price.discounts.length) return null;
  const tier = f.visit.cust_waveguard_tier || null;
  return `No discount line is stamped on this visit${tier ? ` (customer tier: ${tier})` : ''}. The invoice applies no tier discount of its own: a tier discount shows only when the visit price carries it or the accepted estimate names it.`;
}

function previewNotes(f, ctx) {
  const { gates, obligation, prepaidCovered } = ctx;
  const notes = [];
  if (!OPEN_VISIT_STATUSES.includes(f.visit.status)) notes.push(`This visit is ${f.visit.status}, not open; the answer shows what the completion rule says now.`);
  if (f.profile.known === false) notes.push('The completion type could not be read; a one-time billing profile would add a mint trigger.');
  if (obligation && !gates.GATE_UNMINTED_SETUP_FEE_PARK && !f.invoices.existing) {
    notes.push(`The park gate is off, so the completion invoices this application without the $${money(obligation.setupFee).toFixed(2)} setup fee and the fee stays unbilled.`);
  }
  if (obligation && f.invoices.existing) notes.push(`The $${money(obligation.setupFee).toFixed(2)} setup fee is still on no invoice; the office bills it beside the existing invoice.`);
  if (Number(f.visit.prepaid_amount) > 0 && !prepaidCovered) notes.push('A recorded prepayment is netted off the invoice at completion.');
  notes.push('Not included: estimate deposit credit, account credit, a retention offer and Auto Pay results, which the completion applies after the invoice is built.');
  return notes;
}

async function invoicePayload(f, ctx, deps, database) {
  const price = await priceBlock(f, ctx.invoiceAmount, {
    buildLines: deps.buildLines || defaultBuildLines, previewTax: deps.previewTax || defaultPreviewTax,
  }, database);
  const dn = discountNote(f, price);
  return {
    will_invoice: true,
    reason_code: 'invoice_minted',
    reason: ctx.prediction.kind === 'auto_charge'
      ? 'the completion cuts an invoice and charges the saved card on file (Auto Pay)'
      : 'the completion cuts an invoice for this visit',
    collection: ctx.prediction.kind,
    lines: price.lines,
    discounts: price.discounts,
    subtotal: price.subtotal,
    discount_total: price.discount_total,
    net_before_tax: price.net,
    tax: price.tax,
    total: price.tax ? price.tax.total : price.net,
    setup_fee: ctx.setup_fee,
    notes: [...ctx.notes, ...price.notes, ...(dn ? [dn] : [])],
  };
}

function noInvoicePayload(f, ctx) {
  const why = noInvoiceReason(f, {
    setupHold: ctx.setup_fee.held_for_manual_billing, flags: ctx.cover, prediction: ctx.prediction,
  });
  const out = {
    will_invoice: false,
    reason_code: why.code,
    reason: why.text,
    lines: [],
    discounts: [],
    setup_fee: ctx.setup_fee,
    notes: ctx.notes,
  };
  if (f.invoices.existing) out.existing_invoice = invoiceRef(f.invoices.existing);
  if (f.invoices.terminal) out.blocking_invoice = invoiceRef(f.invoices.terminal);
  if (why.code === 'held_for_manual_billing' && ctx.invoiceAmount > 0) out.application_amount_held = money(ctx.invoiceAmount);
  return out;
}

function dayOf(value) {
  return String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function previewCloseoutBill(serviceId, deps = {}) {
  const database = deps.database || db;
  const f = await (deps.gather || gatherFacts)(serviceId, database);
  if (!f) return { found: false };
  const gates = gateStates();
  const invoiceAmount = invoiceAmountOf(f.visit, f.flags);
  const obligation = f.setup.obligation;
  const holdWanted = gates.GATE_UNMINTED_SETUP_FEE_PARK && !!obligation && !obligation.firstVisitAlreadyCompleted
    && !f.setup.parkedElsewhere && !f.invoices.terminal && !f.invoices.existing;
  const { input, autopayCoversVisit, annualPrepayCovered, prepaidCovered } = mintInputs(f, { invoiceAmount }, holdWanted);
  const { shouldAutoInvoiceCompletion } = require('./complete-scheduled-service');
  const willMint = shouldAutoInvoiceCompletion(input);
  // The decision with only the setup-fee hold cleared: tells a held visit from one that never bills.
  const wouldMintWithoutHold = holdWanted ? shouldAutoInvoiceCompletion({ ...input, unmintedSetupFeeHold: false }) : willMint;
  const ctx = {
    invoiceAmount,
    prediction: sheetPrediction(f, autopayCoversVisit),
    cover: { autopayCoversVisit, annualPrepayCovered, prepaidCovered },
    setup_fee: setupFeeSummary(f, holdWanted && wouldMintWithoutHold, gates),
    notes: previewNotes(f, { gates, obligation, prepaidCovered }),
  };
  const base = {
    found: true,
    service_id: f.visit.id,
    visit: { status: f.visit.status, service_type: f.visit.service_type, scheduled_date: dayOf(f.visit.scheduled_date) },
    gates,
    sources: ['shouldAutoInvoiceCompletion', 'buildLineItemsForScheduledService', 'predictCompletionBilling', 'findUnmintedSetupFeeObligation'],
  };
  return { ...base, ...(willMint ? await invoicePayload(f, ctx, deps, database) : noInvoicePayload(f, ctx)) };
}

module.exports = { previewCloseoutBill, gatherFacts, OPEN_VISIT_STATUSES };
