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
 *
 * It answers only the PLAIN PATH with confidence (see offPathStates). Any visit
 * off that path returns prediction 'uncertain' and will_invoice null with the
 * reasons: those branches of the completion (invoice history of a dead status,
 * annual-prepay add-ons, queued or orphaned setup-fee claims, a recorded
 * prepayment, ...) are not modelled here and the close-out may hand the bill
 * to the office.
 * Nothing here writes, texts, emails or calls Stripe. Customer names, phones
 * and addresses never appear in the result.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { discountStackingLive } = require('../config/feature-gates');
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
    GATE_ANNUAL_PREPAY_ADDON_BILLING: !!gates.gateEnvValue('GATE_ANNUAL_PREPAY_ADDON_BILLING'),
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
  // Every invoice on the visit, any status: a dead or refunded one, or more than one, is off the plain path.
  const history = await database('invoices').where({ scheduled_service_id: visit.id }).select('id', 'status');
  return { existing, terminal, liveBeside, history };
}

async function loadCoverage(database, visit, billing, flags) {
  const AnnualPrepay = require('./annual-prepay-renewals');
  // The completion's own coverage check (termite renewal grace, held and deferred year, stamped term), not the
  // prediction's narrower verdict. true = covered; false = a stamp the term no longer backs; null = no annual coverage.
  let annualVerdict = null;
  let annualUnavailable = false;
  try {
    const covered = billing.payer_billed === true
      ? false
      : await AnnualPrepay.annualPrepayCoversVisit(visit, database, { throwOnError: true });
    if (covered) annualVerdict = true;
    else if (visit.prepaid_method === AnnualPrepay.ANNUAL_PREPAY_PREPAID_METHOD) annualVerdict = false;
  } catch (err) {
    annualUnavailable = true;
    logger.warn(`[closeout-bill-preview] annual prepay verdict unavailable for ${visit.id}: ${err.message}`);
  }
  let duesCollected = false;
  const membershipLane = flags.explicitMembershipLane
    || (!visit.cust_billing_mode && BillingLane.isMembershipTier(visit.cust_waveguard_tier));
  if (!billing.autopay_active && !billing.payer_billed && !flags.perApplicationBilling
    && !flags.annualPrepayBilling && membershipLane) {
    try {
      const day = dateOnlyString(visit.scheduled_date);
      duesCollected = await BillingLane.monthlyDuesCollected(database, visit.customer_id, new Date(`${day}T12:00:00Z`), {
        excludeScheduledServiceId: visit.id,
      });
    } catch (err) {
      logger.warn(`[closeout-bill-preview] dues lookup unavailable for ${visit.id}: ${err.message}`);
    }
  }
  return { annualVerdict, annualUnavailable, duesCollected };
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

// The secure plan-choice fee (pending_setup_fee on the series parent), as the completion claims it. state 'queued' =
// a positive stamp; 'orphaned' = a negative stamp (a claim an earlier completion left). Only 'queued' with a mint and
// no invoice on the visit is on the plain path. Returns null when no fee applies.
async function loadQueuedSetupClaim(database, visit) {
  const SetupFee = require('./setup-fee-obligation');
  const parentId = visit.recurring_parent_id || visit.id;
  const parent = await database('scheduled_services').where({ id: parentId }).first('pending_setup_fee');
  const rawFee = parent?.pending_setup_fee != null ? Number(parent.pending_setup_fee) : null;
  const boosterUnderPlan = !!visit.recurring_parent_id && !visit.is_recurring;
  if (!rawFee || boosterUnderPlan || visit.is_callback) return null;
  const amount = money(Math.abs(rawFee));
  if (rawFee < 0) return { amount, state: 'orphaned' };
  return (await SetupFee.prepayWaivesDeferredSetupFee(database, { seriesId: parentId, visit })) ? null : { amount, state: 'queued' };
}

async function loadSetupFee(database, visit) {
  const out = { obligation: null, parkedElsewhere: false, claim: null, detectorError: false };
  const attempt = async (label, read) => {
    try { await read(); } catch (err) {
      out.detectorError = true;
      logger.warn(`[closeout-bill-preview] setup fee ${label} unavailable for ${visit.id}: ${err.message}`);
    }
  };
  if (visit.source_estimate_id) await attempt('check', async () => Object.assign(out, await loadUnmintedObligation(database, visit)));
  await attempt('claim read', async () => { out.claim = await loadQueuedSetupClaim(database, visit); });
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
  // A covered visit with add-ons owed goes to the office-or-bill path (annual-prepay-addon-billing.js): off the plain path.
  const covered = billing.payer_billed !== true && coverage.annualVerdict === true;
  let addonsOwed = false;
  if (covered) {
    const { annualPrepayAddonRows } = require('./annual-prepay-addon-billing');
    try { addonsOwed = (await annualPrepayAddonRows(visit, database)).owed; } catch { addonsOwed = true; }
  }
  // Auto Pay never collects a visit from a won Bill-by-invoice proposal: read it strictly, so an unreadable check says so.
  let billByInvoiceReadable = true;
  try {
    const { billByInvoiceClosesLane } = require('./completion-charge-verdict');
    await billByInvoiceClosesLane({ svc: visit, conn: database, strict: true, lane: 'closeout-preview' });
  } catch (err) {
    billByInvoiceReadable = false;
    logger.warn(`[closeout-bill-preview] Bill-by-invoice check unavailable for ${visit.id}: ${err.message}`);
  }
  return { visit, flags, billing, invoices, coverage, setup, profile, addonsOwed, billByInvoiceReadable };
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
  const { obligation, claim, detectorError } = f.setup;
  return {
    never_invoiced: !!obligation,
    amount: obligation ? money(obligation.setupFee) : null,
    held_for_manual_billing: setupHold,
    park_gate_on: gates.GATE_UNMINTED_SETUP_FEE_PARK,
    rides_on_this_invoice: claim?.state === 'queued' ? claim.amount : null,
    claim_state: claim?.state || null,
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
  const riding = f.setup.claim?.state === 'queued' && !f.invoices.existing ? f.setup.claim.amount : null;
  if (riding != null) lines.push({ description: 'One-time setup fee', amount: riding });
  return finishPrice(f, { lines, discounts, notes }, deps, database);
}

async function finishPrice(f, { lines, discounts, notes }, deps, database) {
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
  const { gates, obligation } = ctx;
  const notes = [];
  if (obligation && !gates.GATE_UNMINTED_SETUP_FEE_PARK && !f.invoices.existing) {
    notes.push(`The park gate is off, so the completion invoices this application without the $${money(obligation.setupFee).toFixed(2)} setup fee and the fee stays unbilled.`);
  }
  if (obligation && f.invoices.existing) notes.push(`The $${money(obligation.setupFee).toFixed(2)} setup fee is still on no invoice; the office bills it beside the existing invoice.`);
  notes.push('Not included: estimate deposit credit, account credit, a retention offer and Auto Pay results, which the completion applies after the invoice is built.');
  return notes;
}

const DEAD_OR_TERMINAL = () => require('./invoice').CANCELLED_SERVICE_RESOLVED_STATUSES;

// The PLAIN PATH is the only thing this preview answers with confidence. Every state below is a branch of the completion
// this preview does not model (the completion may hand the bill to the office, park a fee, net a payment or settle an
// invoice there), so it returns 'uncertain' instead of a guess:
//   - the visit is not open;
//   - a dead or refunded invoice, or more than one invoice, on the visit (any status), or a refunded / voided
//     first-application invoice (held for the office);
//   - annual-prepay coverage that is a stale stamp, could not be read, or has add-ons owed or any invoice on the visit;
//   - a setup-fee claim (pending_setup_fee) unless it is a queued positive fee on a visit that mints with no invoice;
//   - a recorded prepayment that only part-covers a visit that mints;
//   - a stranded setup-fee stamp the completion would first hand to the office;
//   - the completion type or the setup-fee check could not be read.
// On the plain path: no invoice, or exactly one live invoice (reused); coverage by dues, a full prepayment, a valid annual
// prepay with no add-ons; the unminted-setup-fee park; and an ordinary mint (with a queued setup-fee line when claimed).
function invoiceStates(f) {
  const { visit, invoices, coverage } = f;
  const history = invoices.history || [];
  const dead = DEAD_OR_TERMINAL();
  const states = [];
  if (!OPEN_VISIT_STATUSES.includes(visit.status)) states.push({ code: 'visit_not_open', text: `this visit is ${visit.status}, not open` });
  if (invoices.terminal || history.some((r) => dead.includes(r.status))) {
    states.push({ code: 'dead_or_refunded_invoice', text: 'a voided, canceled or refunded invoice is on this visit: the close-out may hand the bill to the office' });
  }
  if (history.length > 1) states.push({ code: 'several_invoices', text: 'more than one invoice is on this visit: the close-out may hand the bill to the office' });
  if (coverage.annualUnavailable || coverage.annualVerdict === false) {
    states.push({ code: 'annual_prepay_unconfirmed', text: 'the annual prepay coverage could not be confirmed for this visit' });
  }
  const anyInvoice = history.length > 0 || !!invoices.existing;
  // GATE_DISCOUNT_STACKING: InvoiceService.create() re-resolves a service-scoped stamp against the invoice's own lines
  // (computeStackedDocumentDiscountLines), so a stamp whose service left the visit bills $0, not the frozen amount
  // the builder returns. The preview does not run that resolution.
  if (discountStackingLive() && (visit.discount_service_key_filter || visit.discount_service_category_filter)) {
    states.push({ code: 'service_scoped_discount', text: 'a discount scoped to one service is stamped on this visit: the invoice re-checks it against the billed lines, so its amount may differ' });
  }
  if (coverage.annualVerdict === true && (f.addonsOwed || anyInvoice)) {
    states.push({ code: 'annual_prepay_addons_or_invoice', text: 'the visit is annual-prepay covered and has add-ons owed or an invoice on it: the close-out may bill the add-ons or hand them to the office' });
  }
  return states;
}

function setupAndPaymentStates(f, ctx) {
  const { visit, invoices, setup } = f;
  const states = [];
  const anyInvoice = (invoices.history || []).length > 0 || !!invoices.existing;
  if (setup.claim && !(setup.claim.state === 'queued' && ctx.willMint && !anyInvoice)) {
    states.push({ code: 'setup_fee_claim', text: 'a queued or orphaned setup fee claim is on this visit\'s series: the close-out may hand the fee to the office or adopt the claim' });
  }
  if (Number(visit.prepaid_amount) > 0 && ctx.willMint && !ctx.prepaidCovered
    && visit.prepaid_method !== require('./annual-prepay-renewals').ANNUAL_PREPAY_PREPAID_METHOD) {
    states.push({ code: 'partial_prepayment', text: 'a payment recorded on the visit only part-covers it: the close-out nets it against the invoice' });
  }
  if (setup.obligation?.unconsumableStamps?.length) {
    states.push({ code: 'stranded_setup_fee_stamp', text: 'a setup fee stamp on this estimate\'s series is handed to the office first at close-out' });
  }
  if (f.profile.known === false) states.push({ code: 'completion_type_unreadable', text: 'the completion type could not be read' });
  if (setup.detectorError) states.push({ code: 'setup_fee_check_unavailable', text: 'the setup fee check could not be read' });
  return states;
}

function offPathStates(f, ctx) {
  return [...invoiceStates(f), ...setupAndPaymentStates(f, ctx)];
}

// How the invoice is collected, from the completion's own helpers. The sheet prediction says auto_charge for an Auto Pay
// customer; billByInvoiceDemotedPrediction (the schedule sheet's own demotion) turns that into an invoice for a visit
// from a won Bill-by-invoice proposal. An unreadable check is 'uncertain'. 'auto_charge_eligible' is NOT a promise: the
// completion still charges the card only when its Auto Pay guards pass (agreed-price cap, usable card, no hold).
async function collectionOf(f, prediction, deps, database) {
  if (prediction.kind !== 'auto_charge') return prediction.kind;
  if (f.billByInvoiceReadable === false) return 'uncertain';
  const demote = deps.demote || require('./completion-charge-verdict').billByInvoiceDemotedPrediction;
  const demoted = await demote(prediction, f.visit, database);
  return demoted.kind === 'auto_charge' ? 'auto_charge_eligible' : demoted.kind;
}

function collectionReason(collection) {
  if (collection === 'auto_charge_eligible') {
    return 'the completion cuts an invoice for this visit; the saved card is charged only if the completion\'s Auto Pay guards pass (agreed-price cap, usable card, no hold)';
  }
  if (collection === 'uncertain') {
    return 'the completion cuts an invoice for this visit; whether the saved card is charged could not be checked';
  }
  return 'the completion cuts an invoice for this visit';
}

async function invoicePayload(f, ctx, deps, database) {
  const price = await priceBlock(f, ctx.invoiceAmount, {
    buildLines: deps.buildLines || defaultBuildLines, previewTax: deps.previewTax || defaultPreviewTax,
  }, database);
  const dn = discountNote(f, price);
  return {
    will_invoice: true,
    reason_code: 'invoice_minted',
    reason: collectionReason(ctx.collection),
    collection: ctx.collection,
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
  if (why.code === 'held_for_manual_billing' && ctx.invoiceAmount > 0) out.application_amount_held = money(ctx.invoiceAmount);
  return out;
}

// Off the plain path: no yes or no. The ordinary invoice, when the visit would mint one, is shown only as what it is
// before any office handling.
async function uncertainPayload(f, ctx, states, deps, database) {
  const out = {
    will_invoice: null,
    reason_code: 'uncertain',
    reason: `uncertain: ${states.map((st) => st.text).join('; ')}`,
    off_path: states.map((st) => st.code),
    lines: [],
    discounts: [],
    setup_fee: ctx.setup_fee,
    notes: ctx.notes,
  };
  if (ctx.willMint) {
    try {
      const built = splitLines(await (deps.buildLines || defaultBuildLines)(f.visit, ctx.invoiceAmount, database));
      const lines = built.lines.length ? built.lines : [{ description: f.visit.service_type || 'Service', amount: money(ctx.invoiceAmount) }];
      const price = await finishPrice(f, { lines, discounts: built.discounts, notes: [] }, {
        previewTax: deps.previewTax || defaultPreviewTax,
      }, database);
      out.before_office_handling = {
        lines: price.lines, discounts: price.discounts, subtotal: price.subtotal, net_before_tax: price.net,
        total: price.tax ? price.tax.total : price.net,
      };
    } catch { /* uncertain stays uncertain without the lines */ }
  }
  return out;
}

function dayOf(value) {
  return dateOnlyString(value);
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
    willMint,
    prepaidCovered,
    prediction: sheetPrediction(f, autopayCoversVisit),
    collection: null,
    cover: { autopayCoversVisit, annualPrepayCovered, prepaidCovered },
    setup_fee: setupFeeSummary(f, holdWanted && wouldMintWithoutHold, gates),
    notes: previewNotes(f, { gates, obligation }),
  };
  const base = {
    found: true,
    service_id: f.visit.id,
    visit: { status: f.visit.status, service_type: f.visit.service_type, scheduled_date: dayOf(f.visit.scheduled_date) },
    gates,
    sources: ['shouldAutoInvoiceCompletion', 'annualPrepayCoversVisit', 'buildLineItemsForScheduledService', 'predictCompletionBilling', 'findUnmintedSetupFeeObligation'],
  };
  const states = offPathStates(f, ctx);
  if (states.length) return { ...base, prediction: 'uncertain', ...(await uncertainPayload(f, ctx, states, deps, database)) };
  if (willMint) ctx.collection = await collectionOf(f, ctx.prediction, deps, database);
  const body = willMint ? await invoicePayload(f, ctx, deps, database) : noInvoicePayload(f, ctx);
  return { ...base, prediction: 'confident', ...body };
}

module.exports = { previewCloseoutBill, gatherFacts, OPEN_VISIT_STATUSES, _private: { loadCoverage, loadQueuedSetupClaim, offPathStates } };
