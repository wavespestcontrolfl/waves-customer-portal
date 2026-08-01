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

// Terms in these states describe no prepaid coverage — the money was never
// taken, or it was given back. `refunded` is lockstep with the canonical
// coverage logic in annual-prepay-renewals.js, which rejects refunded
// invoices and payments (codex #3120 r4): a refunded term must not keep
// presenting a covered year on the customer's document.
const NON_COVERING_PREPAY_STATUSES = new Set([
  'cancelled', 'canceled', 'lapsed', 'superseded', 'refunded',
]);

/**
 * The prepay term for this estimate, or null. `prepay_amount` is the total the
 * customer was actually charged, which resolveAnnualPrepayInvoiceTotal may
 * have discounted below the estimate's annual_total — so the document must
 * quote it rather than the base annual price (codex #3120 r3).
 *
 * @returns {Promise<{ prepayAmount: number }|null>}
 */
async function estimateAnnualPrepayTerm(estimate) {
  if (!estimate?.id) return null;
  try {
    if (!(await db.schema.hasTable('annual_prepay_terms'))) return null;
    // source_estimate_id is UNIQUE (migration 20260514000001) — one row at most.
    const term = await db('annual_prepay_terms')
      .where({ source_estimate_id: estimate.id })
      .first();
    if (!term || NON_COVERING_PREPAY_STATUSES.has(String(term.status || '').toLowerCase())) return null;
    return { prepayAmount: Math.max(0, Number(term.prepay_amount) || 0) };
  } catch (err) {
    logger.warn(`[estimate-proposal-billing] prepay lookup failed for estimate ${estimate?.id}: ${err.message}`);
    return null;
  }
}

// An estimate with no customer_id still links at accept through the SAME
// phone matcher the accept path uses, so an existing monthly member can be on
// the other end of an unlinked estimate. Mirrors
// estimateCustomerPreservesMonthlyBilling in estimate-public.js by calling
// the one shared implementation — a second matcher here would drift, and
// ambiguous matches must resolve exactly like accept (no link). Required
// lazily: the route module is heavy and pulls this file in itself.
async function matchUnlinkedCustomer(estimate) {
  const { matchAcceptCustomerByPhone } = require('../routes/estimate-public');
  if (typeof matchAcceptCustomerByPhone !== 'function') return null;
  const { match } = await matchAcceptCustomerByPhone(estimate);
  return match || null;
}

async function estimateBillsPerApplication(estimate) {
  try {
    const customer = estimate?.customer_id
      ? await db('customers').where({ id: estimate.customer_id }).first()
      : await matchUnlinkedCustomer(estimate || {});
    // No customer on either path: an unmatched accept converts
    // per-application (the converter preserves membership only for a customer
    // that already holds one).
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
 * @returns {Promise<{ billsPerApplication: boolean, annualPrepay: boolean,
 *   annualPrepayTotal: number }>}
 */
async function resolveProposalBillingContext(estimate) {
  const [billsPerApplication, prepayTerm] = await Promise.all([
    estimateBillsPerApplication(estimate),
    estimateAnnualPrepayTerm(estimate),
  ]);
  return {
    billsPerApplication,
    annualPrepay: !!prepayTerm,
    annualPrepayTotal: prepayTerm?.prepayAmount || 0,
  };
}

module.exports = {
  NON_COVERING_PREPAY_STATUSES,
  estimateAnnualPrepayTerm,
  estimateBillsPerApplication,
  resolveProposalBillingContext,
};
