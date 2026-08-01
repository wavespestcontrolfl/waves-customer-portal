// ============================================================
// estimate-proposal-billing.js — does THIS estimate bill per application?
//
// The proposal model (estimate-proposal.js) is pure and the PDF generator is
// presentation-only, but describing a plan honestly needs one live fact that
// only the database holds, so this module is the single place every PDF entry
// point asks for it.
//
// TRUE only for the lane this PR set out to fix: a plan billed per completed
// application. Everything else — a preserved monthly membership, an annual
// prepay, an unknown lane — renders the document exactly as it did before,
// which is the safe direction: a caller that cannot establish the lane never
// has a billing cadence invented for it.
//
//   Preserved monthly members keep monthly billing when they add a service
//   (estimate-converter's preservesExistingMembership), so per-application
//   copy would misstate a real monthly charge. Resolved LIVE through the SAME
//   shared predicate the converter and the estimate page use — never off the
//   stored send snapshot, because buildPricingBundle applies its strip/backfill
//   AFTER the snapshot fast path, so the page always renders the current lane
//   while persisted flags are frozen at send time (codex #3120 r2).
//
//   Annual prepay is deliberately NOT special-cased here. A prepaid year's
//   coverage is a genuinely subtle question — canonical coveredTermsAsOf in
//   annual-prepay-renewals.js weighs term status, renewal_decision, invoice
//   and payment state, and the coverage date — and re-deriving any of it here
//   would drift from the module that owns it (codex #3120 r4 + pre-push r5).
//   Reading the customer's LANE is enough for this document: prepay renders
//   the legacy plan lines and keeps its combined totals, unchanged by this PR.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { customerPreservesMonthlyMembership } = require('./billing-cadence');

// An estimate with no customer_id still links at accept through the SAME
// phone matcher the accept path uses, so an existing member can be on the
// other end of an unlinked estimate. Mirrors estimateCustomerPreservesMonthly
// Billing in estimate-public.js by calling the one shared implementation — a
// second matcher here would drift, and ambiguous matches must resolve exactly
// like accept (no link). Required lazily: the route module is heavy and pulls
// this file in itself.
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
    if (customer.billing_mode === 'annual_prepay') return false;
    return !customerPreservesMonthlyMembership(customer);
  } catch (err) {
    // Unknown lane with a customer present: keep the legacy description.
    // Wrongly suppressing it hides a real charge; wrongly showing it merely
    // over-discloses for one failure window. Same fail direction as
    // estimateCustomerPreservesMonthlyBilling in estimate-public.js.
    logger.warn(`[estimate-proposal-billing] billing-lane lookup failed for estimate ${estimate?.id}: ${err.message}`);
    return false;
  }
}

/**
 * @returns {Promise<{ billsPerApplication: boolean }>}
 */
async function resolveProposalBillingContext(estimate) {
  return { billsPerApplication: await estimateBillsPerApplication(estimate) };
}

module.exports = {
  estimateBillsPerApplication,
  resolveProposalBillingContext,
};
