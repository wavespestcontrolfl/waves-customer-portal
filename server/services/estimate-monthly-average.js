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

const SETUP_WORDING = /set-?up|membership|initial/i;

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

// The plan-level credit the bundle declares, as a monthly amount (the same
// source estimate-proposal.js reconciles its per-application lines against).
function declaredCredit(bundle) {
  const annual = num(bundle?.manualDiscount?.recurringAmount ?? bundle?.manualDiscount?.amount);
  if (!(annual > 0)) return null;
  return { label: String(bundle?.manualDiscount?.label || '').trim() || 'Discount', monthly: Math.round((annual / 12) * 100) / 100 };
}

// Plans this feature never touches: commercial, authored proposals, quote-required.
function isExcludedPlan(estimate, proposal, bundle) {
  if (proposal.enabled === true) return true;
  if (String(estimate.category || '').toUpperCase() === 'COMMERCIAL') return true;
  if ((proposal.programs || []).length > 0 || (proposal.correctiveWork || []).length > 0) return true;
  return bundle?.quoteRequired === true || parseData(estimate.estimate_data ?? estimate.estimateData).quoteRequired === true;
}

/**
 * Decide whether the average may be shown for this estimate, from a NORMALIZED
 * per-application proposal. Sync and pure.
 *
 * @param {object} args
 * @param {object} args.estimate  the estimate row (monthly_total, category)
 * @param {object} args.proposal  normalizeProposal(estimate, {recurringMode:'per_application', ...})
 * @param {object|null} args.bundle  the pricing bundle the lines came from (live, else the send snapshot)
 * @returns {null | {
 *   model: object,
 *   inputs: { planMonthly: number, credit: object|null, bundleDiscountPct: number, oneTime: object|null },
 * }}
 */
function monthlyAverageFor({ estimate, proposal, bundle = null } = {}) {
  if (!gateOn() || !estimate || !proposal || isExcludedPlan(estimate, proposal, bundle)) return null;

  const lines = (proposal.buildings || []).flatMap((building) => building.lineItems || []);
  const recurring = lines.filter((line) => line.frequency !== 'one_time');
  if (recurring.length === 0) return null;
  // Every recurring line must be a per-application line; a flat-monthly or
  // unknown-cadence line means the plan is not described purely per application.
  if (!recurring.every((line) => line.frequency === 'per_application'
    && num(line.visitsPerYear) > 0 && num(line.amount) > 0 && line.taxable !== true)) return null;

  const bundlePct = num(bundle?.combinedRecurring?.waveGuardDiscountPct);
  const credit = declaredCredit(bundle);
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

  const oneTimeLines = lines.filter((line) => line.frequency === 'one_time' && num(line.amount) > 0);
  const oneTimeAmount = Math.round(oneTimeLines.reduce((sum, line) => sum + num(line.amount), 0) * 100) / 100;
  const oneTime = oneTimeAmount > 0
    ? { amount: oneTimeAmount, setup: oneTimeLines.every((line) => SETUP_WORDING.test(String(line.description || ''))) }
    : null;
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
    // The billing resolution can refresh totals on the row it is given
    // (reconcileFrozenMembershipSnapshot), so it works on a copy.
    const copy = { ...estimate };
    const ctx = await resolveProposalBillingContext(copy);
    if (!ctx || ctx.billsPerApplication !== true) return null;
    const proposal = normalizeProposal(copy, { recurringMode: 'per_application', livePricing: ctx.livePricing || null });
    const bundle = ctx.livePricing?.bundle || parseData(copy.estimate_data ?? copy.estimateData)?.sendSnapshot?.pricingBundle || null;
    const result = monthlyAverageFor({ estimate: copy, proposal, bundle });
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
  const stored = reviewedEmail.monthlyAverage ?? null;
  // Gate off and nothing recorded: nothing to compute, nothing changed.
  if (stored === null && !gateOn()) return false;
  // Through module.exports so a test can pin the resolution without a billing fixture.
  return stored !== averageText(await module.exports.emailAverageParts(await loadRow()));
}

module.exports = { monthlyAverageFor, emailAverageParts, averageText, reviewedAverageStale, gateOn };
