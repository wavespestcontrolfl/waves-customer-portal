// ============================================================
// estimate-proposal-billing.js — how will THIS estimate actually bill?
//
// The proposal model (estimate-proposal.js) is pure and the PDF generator is
// presentation-only, but describing a plan honestly needs two live facts that
// only the database holds. This module is the one place that resolves them,
// so every PDF entry point asks the same question the same way.
//
//   billsPerApplication — a customer who already holds a monthly membership
//     keeps monthly billing when they add a service (estimate-converter's
//     preservesExistingMembership), so for exactly that audience a
//     per-application description would misstate a real monthly charge.
//     Resolved LIVE from the linked customer row through the SAME shared
//     predicate the converter and the estimate page use. It must not be read
//     off the stored send snapshot: buildPricingBundle applies the
//     strip/backfill AFTER its snapshot fast path, so the page always renders
//     the current lane while the persisted flags are frozen at send time —
//     a customer who changes lanes afterwards would get a page and a PDF that
//     disagree (codex #3120 r2).
//
//   annualPrepay — a prepaid plan's visits are covered by one annual payment.
//     Per-application copy would describe charges that never happen, and the
//     annual figure IS the transaction, so prepay keeps the combined totals
//     that AGENTS.md otherwise bars from customer estimate surfaces.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { customerPreservesMonthlyMembership } = require('./billing-cadence');

// Terms in these states never took the customer's money, so they describe no
// prepaid coverage. Anything else (active//payment_pending/renewing/…) means
// the plan is being sold as an annual prepay and the document should say so.
const NON_COVERING_PREPAY_STATUSES = new Set(['cancelled', 'canceled', 'lapsed', 'superseded']);

async function estimateHasAnnualPrepayTerm(estimate) {
  if (!estimate?.id) return false;
  try {
    if (!(await db.schema.hasTable('annual_prepay_terms'))) return false;
    // source_estimate_id is UNIQUE (migration 20260514000001) — one row at most.
    const term = await db('annual_prepay_terms')
      .where({ source_estimate_id: estimate.id })
      .first();
    return !!term && !NON_COVERING_PREPAY_STATUSES.has(String(term.status || '').toLowerCase());
  } catch (err) {
    logger.warn(`[estimate-proposal-billing] prepay lookup failed for estimate ${estimate?.id}: ${err.message}`);
    return false;
  }
}

async function estimateBillsPerApplication(estimate) {
  // No linked customer: acceptance links by phone or creates one, and either
  // way an unmatched accept converts per-application (the converter only
  // preserves membership for a customer that already holds one).
  if (!estimate?.customer_id) return true;
  try {
    const customer = await db('customers').where({ id: estimate.customer_id }).first();
    if (!customer) return true;
    return !customerPreservesMonthlyMembership(customer);
  } catch (err) {
    // Unknown lane with a customer present: keep the monthly description.
    // Wrongly suppressing it hides a real charge; wrongly showing it merely
    // over-discloses for one failure window. Same fail direction as
    // estimateCustomerPreservesMonthlyBilling in estimate-public.js.
    logger.warn(`[estimate-proposal-billing] billing-lane lookup failed for estimate ${estimate?.id}: ${err.message}`);
    return false;
  }
}

/**
 * @returns {Promise<{ billsPerApplication: boolean, annualPrepay: boolean }>}
 */
async function resolveProposalBillingContext(estimate) {
  const [billsPerApplication, annualPrepay] = await Promise.all([
    estimateBillsPerApplication(estimate),
    estimateHasAnnualPrepayTerm(estimate),
  ]);
  return { billsPerApplication, annualPrepay };
}

module.exports = {
  NON_COVERING_PREPAY_STATUSES,
  estimateBillsPerApplication,
  estimateHasAnnualPrepayTerm,
  resolveProposalBillingContext,
};
