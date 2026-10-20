'use strict';

// GATE_ESTIMATE_MONTHLY_AVERAGE (owner ruling 2026-10-20, "option A"): a
// monthly AVERAGE beside the per-application price on residential estimates.
// The per-application price stays the price; this module only decides WHETHER
// the average may be shown for an estimate and hands the numbers to the shared
// builder (shared/estimate-monthly-average.cjs) that the PDF document and the
// estimate page also use.
//
// It never prices anything. The inputs are the proposal lines the PDF already
// prints (estimate-proposal.js, per-application mode, same live-or-frozen
// pricing authority as the document) and the estimate's STORED monthly total.
// Whenever those do not reconcile (a stale stored total, a flat-monthly line,
// a quote-required plan) the answer is null and the surface renders exactly as
// it did before the gate.

const featureGates = require('../config/feature-gates');
const logger = require('./logger');
const shared = require('../../shared/estimate-monthly-average.cjs');
const { isCommercialAutoAcceptEstimate } = require('./estimate-commercial-identity');

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function gateOn() {
  return featureGates.isEnabled('estimateMonthlyAverage');
}

function parseData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

const liveCredit = (discount) => (discount && num(discount.recurringAmount ?? discount.amount) > 0 ? discount : null);

const creditOf = (discount) => ({
  label: String(discount?.label || '').trim() || 'Discount',
  monthly: Math.round((num(discount.recurringAmount ?? discount.amount) / 12) * 100) / 100,
});

// The plan-level credit, as a monthly amount, read from the SAME candidate the
// document's lines were quoted from (perApplicationRecurringResolution), the way
// the React page reads the selected cadence: a service-cadence COMBO carries its
// own credit state (manualDiscount + manualDiscountSuppressed) and the bundle
// root's is stale for it; the top-level frequency and then the bundle root only
// apply when no combo was selected. Without a resolvable candidate (a bare
// bundle) the bundle root is all there is.
function declaredCredit(bundle, candidate = null) {
  const isCombo = !!candidate && Array.isArray(bundle?.serviceCadenceCombos) && bundle.serviceCadenceCombos.includes(candidate);
  if (isCombo) {
    const own = candidate.manualDiscountSuppressed === true ? null : liveCredit(candidate.manualDiscount);
    return own ? creditOf(own) : null;
  }
  if (candidate?.manualDiscountSuppressed === true) return null;
  const discount = liveCredit(candidate?.manualDiscount) || (bundle?.manualDiscountSuppressed === true ? null : liveCredit(bundle?.manualDiscount));
  return discount ? creditOf(discount) : null;
}

const cents = (n) => Math.round(num(n) * 100);

// One-time charges that sit BESIDE the plan, by identity, never by wording.
//
// With a one-time option on offer (show_one_time_option) the proposal's one-time
// rows include the either/or alternative ("Initial Pest Cleanout"), which is not
// an extra charge. What is certainly additive is the bundle's positive first-visit
// fees (the same source the page's fee list reads: firstVisitFees, else the lone
// setupFee), so those alone count. Without a one-time option every positive
// one-time line is additive (today's rule). Either way `setup` (the "One-time
// setup" wording) is true only when every counted dollar is the WaveGuard setup
// fee (service waveguard_setup), else the wording is "One-time charges".
function oneTimeBesidePlan({ estimate, bundle, lines }) {
  const fees = (Array.isArray(bundle?.firstVisitFees) && bundle.firstVisitFees.length
    ? bundle.firstVisitFees
    : (bundle?.setupFee ? [bundle.setupFee] : []))
    .filter((fee) => num(fee?.amount) > 0);
  const feeCents = fees.reduce((sum, fee) => sum + cents(fee.amount), 0);
  const setupFeeCents = fees.filter((fee) => fee.service === 'waveguard_setup').reduce((sum, fee) => sum + cents(fee.amount), 0);

  if (estimate.show_one_time_option) {
    return feeCents > 0 ? { amount: feeCents / 100, setup: setupFeeCents === feeCents } : null;
  }

  const lineCents = lines
    .filter((line) => line.frequency === 'one_time' && num(line.amount) > 0)
    .reduce((sum, line) => sum + cents(line.amount), 0);
  if (!(lineCents > 0)) return null;
  // The setup fee may be carried by the fee list or by a breakdown row; it is the same charge, never both.
  const rowSetupCents = (Array.isArray(bundle?.oneTimeBreakdown?.items) ? bundle.oneTimeBreakdown.items : [])
    .filter((item) => item?.kind === 'charge' && item.service === 'waveguard_setup' && num(item.amount) > 0)
    .reduce((sum, item) => sum + cents(item.amount), 0);
  const knownSetupCents = setupFeeCents || rowSetupCents;
  return { amount: lineCents / 100, setup: knownSetupCents > 0 && knownSetupCents === lineCents };
}

// Plans this feature never touches: commercial (by the canonical classifier the
// accept and slot routes use: the commercialEstimatedPricing marker, estimated-
// pricing commercial lines or commercial rows, not only the category), authored
// proposals, quote-required.
function isExcludedPlan(estimate, proposal, bundle) {
  if (proposal.enabled === true) return true;
  if (String(estimate.category || '').toUpperCase() === 'COMMERCIAL') return true;
  if (isCommercialAutoAcceptEstimate(estimate)) return true;
  if ((proposal.programs || []).length > 0 || (proposal.correctiveWork || []).length > 0) return true;
  return bundle?.quoteRequired === true || parseData(estimate.estimate_data ?? estimate.estimateData).quoteRequired === true;
}

// The candidate cadence the proposal's lines were quoted from; null when it
// cannot be resolved (callers fall back to the bundle root).
function resolveCandidate(estimate, livePricing) {
  try {
    const { perApplicationRecurringResolution } = require('./estimate-proposal');
    return perApplicationRecurringResolution(estimate, parseData(estimate.estimate_data ?? estimate.estimateData), livePricing)?.candidate || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether the average may be shown for this estimate, from a NORMALIZED
 * per-application proposal. Sync and pure.
 *
 * @param {object} args
 * @param {object} args.estimate  the estimate row (monthly_total, category)
 * @param {object} args.proposal  normalizeProposal(estimate, {recurringMode:'per_application', ...})
 * @param {object|null} args.bundle  the pricing bundle the lines came from (live, else the send snapshot)
 * @param {object|null} args.livePricing  the live pricing the lines were quoted with (null = frozen snapshot); resolves the candidate cadence
 * @returns {null | {
 *   model: object,
 *   inputs: { planMonthly: number, credit: object|null, bundleDiscountPct: number, oneTime: object|null },
 * }}
 */
function monthlyAverageFor({ estimate, proposal, bundle = null, livePricing = null } = {}) {
  if (!gateOn() || !estimate || !proposal || isExcludedPlan(estimate, proposal, bundle)) return null;

  const lines = (proposal.buildings || []).flatMap((building) => building.lineItems || []);
  const recurring = lines.filter((line) => line.frequency !== 'one_time');
  if (recurring.length === 0) return null;
  // Every recurring line must be a per-application line; a flat-monthly or
  // unknown-cadence line means the plan is not described purely per application.
  if (!recurring.every((line) => line.frequency === 'per_application'
    && num(line.visitsPerYear) > 0 && num(line.amount) > 0 && line.taxable !== true)) return null;

  const bundlePct = num(bundle?.combinedRecurring?.waveGuardDiscountPct);
  const credit = declaredCredit(bundle, bundle ? resolveCandidate(estimate, livePricing) : null);
  const model = shared.buildMonthlyAverage({
    services: recurring.map((line, i) => ({
      key: String(i),
      label: line.description,
      perApplication: num(line.amount),
      visits: num(line.visitsPerYear),
    })),
    planMonthly: num(estimate.monthly_total),
    credit,
    bundleDiscountPct: bundlePct,
  });
  if (!model) return null;

  const oneTime = oneTimeBesidePlan({ estimate, bundle, lines });
  return {
    model,
    inputs: { planMonthly: model.planMonthly, credit, bundleDiscountPct: bundlePct, oneTime },
  };
}

/**
 * The delivery email's pieces for an estimate row (async: it asks the same
 * billing authority the PDF asks). Null whenever the gate is off or the
 * average may not be shown; never throws, so an email falls back to its
 * existing wording.
 *
 * @returns {Promise<null | {priceLine: string, note: string}>}
 */
async function emailAverageParts(estimate) {
  if (!gateOn() || !estimate) return null;
  try {
    const { normalizeProposal } = require('./estimate-proposal');
    const { resolveProposalBillingContext } = require('./estimate-proposal-billing');
    // The billing resolution can refresh totals AND nested estimate_data on
    // the row it is given (reconcileFrozenMembershipSnapshot mutates in
    // place), so it works on a deep copy: the caller's row (hashed into the
    // review's editVersion) must never change (#6360 pre-push P1).
    const copy = structuredClone(estimate);
    const ctx = await resolveProposalBillingContext(copy);
    if (!ctx || ctx.billsPerApplication !== true) return null;
    const proposal = normalizeProposal(copy, { recurringMode: 'per_application', livePricing: ctx.livePricing || null });
    const bundle = ctx.livePricing?.bundle || parseData(copy.estimate_data ?? copy.estimateData)?.sendSnapshot?.pricingBundle || null;
    const result = monthlyAverageFor({ estimate: copy, proposal, bundle, livePricing: ctx.livePricing || null });
    return result ? shared.emailParts(result.model, result.inputs.oneTime) : null;
  } catch (err) {
    logger.warn(`[estimate-monthly-average] email parts unavailable for estimate ${estimate?.id}: ${err.message}`);
    return null;
  }
}

// The exact customer copy the average adds to the delivery email (the price
// row and the context sentence), or null when there is none. This is what a
// review records and what the send compares against.
function averageText(parts) {
  return parts ? `${parts.priceLine}\n${parts.note}` : null;
}

/**
 * True when a REVIEWED (or scheduled) delivery email's recorded average no
 * longer matches what the send would now carry: a gate flip or a price edit
 * since the review. Same class as the reviewed PDF decision
 * (estimate-email-pdf.js reviewedPdfDecisionStale), with one difference: a
 * review with no recorded average means "no average", so a send that would now
 * add one is stale too. The copy is never silently added or dropped. SMTP
 * reviews carry no average line, so they are never stale on this account.
 *
 * @param {object|null} reviewedMessages  options.reviewedMessages of the send (null for an unreviewed send)
 * @param {() => Promise<object>} loadRow  reads the estimate row as it is now
 */
async function reviewedAverageStale(reviewedMessages, loadRow) {
  const reviewedEmail = reviewedMessages?.email;
  if (!reviewedEmail || reviewedEmail.provider === 'smtp') return false;
  // Gate off and nothing recorded: nothing to compute, nothing changed.
  if ((reviewedEmail.monthlyAverage ?? null) === null && !gateOn()) return false;
  // Through module.exports so a test can pin the resolution without a billing fixture.
  return averageDiffersFromReview(reviewedMessages, await module.exports.emailAverageParts(await loadRow()));
}

/**
 * The exact-copy comparison: does the average the email is about to carry
 * (already resolved, `parts`) differ from the one the review recorded? Used at
 * the email build itself, the last point before the provider handoff.
 */
function averageDiffersFromReview(reviewedMessages, parts) {
  const reviewedEmail = reviewedMessages?.email;
  if (!reviewedEmail || reviewedEmail.provider === 'smtp') return false;
  return (reviewedEmail.monthlyAverage ?? null) !== averageText(parts);
}

module.exports = { monthlyAverageFor, emailAverageParts, averageText, reviewedAverageStale, averageDiffersFromReview, gateOn };
