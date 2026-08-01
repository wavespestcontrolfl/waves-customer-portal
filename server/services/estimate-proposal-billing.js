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
// prepay, a pre-migration database where the lane cannot exist yet, an unknown
// lane — renders the document exactly as it did before, which is the safe
// direction: a caller that cannot establish the lane never has a billing
// cadence invented for it.
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

// Pre-migration compatibility (codex #3120 r5) — mirrors the guards in
// estimate-converter.js and estimate-public.js's buildPricingBundle.
// billing_mode / per_application_fee ship in migration 20260709000010. On a
// database that has not run it — an explicitly supported preview /
// deploy-window state — the converter detects the missing columns and keeps
// the LEGACY update shape, so EVERY accept bills through the monthly cron and
// per-application billing does not exist yet. The lane question is therefore
// moot before the migration: describing per-application charges would misstate
// a real monthly one, exactly the failure this PR set out to fix, so the
// answer is legacy for everyone (which is also how the page renders — the
// route strips the flags off the whole bundle on the same probe).
//
// A migrated database never un-migrates, so a true probe is cached forever;
// while false we re-probe per call — the window is short.
//
// A probe ERROR deliberately fails the other way from estimate-public's copy
// of this helper. That one assumes migrated so its display flag keeps working;
// here an error can only ever buy per-application copy on a document that is
// always safe to render the legacy way, so it falls through to the catch below
// with every other inconclusive lookup.
let perApplicationColumnsKnownPresent = false;
async function perApplicationBillingColumnsExist() {
  if (perApplicationColumnsKnownPresent) return true;
  perApplicationColumnsKnownPresent = await db.schema.hasColumn('customers', 'billing_mode');
  return perApplicationColumnsKnownPresent;
}

async function estimateBillsPerApplication(estimate) {
  try {
    if (!(await perApplicationBillingColumnsExist())) return false;
    const customer = estimate?.customer_id
      ? await db('customers').where({ id: estimate.customer_id }).first()
      : await matchUnlinkedCustomer(estimate || {});
    // No customer on either path: an unmatched accept converts
    // per-application (the converter preserves membership only for a customer
    // that already holds one).
    if (!customer) return true;
    return !customerPreservesMonthlyMembership(customer);
  } catch (err) {
    // Unknown lane — a failed customer read, or a schema probe that could not
    // answer: keep the legacy description. Wrongly suppressing it hides a real
    // charge; wrongly showing it merely over-discloses for one failure window.
    // Same fail direction as estimateCustomerPreservesMonthlyBilling in
    // estimate-public.js.
    logger.warn(`[estimate-proposal-billing] billing-lane lookup failed for estimate ${estimate?.id}: ${err.message}`);
    return false;
  }
}

// Was THIS estimate sold as an annual prepay? Keyed on the term's
// source_estimate_id (UNIQUE, migration 20260514000001) — a per-ESTIMATE fact,
// unlike the customer's current lane, which does not carry over: a prepay
// customer accepting a new standard estimate is stamped per_application by the
// converter (pre-push r5).
//
// Deliberately status-blind. The only thing this decides is "render the legacy
// document instead of per-application copy", so being wrong about a refunded
// or lapsed term costs a less-improved PDF, never a misstated charge — which
// is why it does NOT re-derive coveredTermsAsOf's semantics (codex r4, r5).
// Returns null for UNKNOWN (lookup failed) — never false. A transient DB or
// schema error must not read as "definitely not prepaid" and unlock
// per-application copy for a plan that may be prepaid (pre-push r6).
async function estimateSoldAsAnnualPrepay(estimate) {
  if (!estimate?.id) return false;
  try {
    if (!(await db.schema.hasTable('annual_prepay_terms'))) return false;
    const term = await db('annual_prepay_terms').where({ source_estimate_id: estimate.id }).first();
    return !!term;
  } catch (err) {
    logger.warn(`[estimate-proposal-billing] prepay lookup failed for estimate ${estimate?.id}: ${err.message}`);
    return null;
  }
}

// WHICH pricing is authoritative for this document (codex #3120 r4 + r6).
//
// Acceptance freezes the price: both accept flows stamp price_locked_at and
// pricing_authority 'LOCKED' in the same atomic update that writes
// monthly_total / annual_total / accepted_frequency_key, and /:token/pdf stays
// downloadable on the accepted terminal view. A locked estimate's document
// must therefore describe the plan the customer ACCEPTED — re-pricing it under
// today's policy would rewrite history on a permanent record — so its
// authority is the frozen send snapshot plus those frozen totals, which are
// mutually consistent. Same predicate the file already uses elsewhere for
// "this row is committed" (estimate-public.js:7151).
function estimateIsPriceLocked(estimate) {
  return estimate?.status === 'accepted' || !!estimate?.price_locked_at;
}

// An OUTSTANDING quote is the opposite case: the page rebuilds a snapshot that
// violates lawn program policy (retired cadence, below-floor price), carries a
// stale termite row, or is missing a required setup fee, so the frozen copy can
// describe a plan no link can still sell. Those estimates get the live bundle.
//
// The default candidate rides along because the frozen annual_total is NOT a
// usable anchor here: the route's snapshot fast path REQUIRES the totals to
// match, so a policy-invalid snapshot is by construction one whose totals equal
// annual_total — the rebuild then moves the price while the column stays put,
// and nothing reconciles. Resolved through the route's own
// defaultFrequencyFromList so this document cannot name a different default
// cadence than acceptance would price (codex #3120 r6).
//
// Null for a locked estimate, and null on any failure — both land on the
// snapshot, which is exactly how this document rendered before the r4 work.
async function resolveLivePricing(estimate) {
  if (estimateIsPriceLocked(estimate)) return null;
  try {
    const {
      buildPricingBundle,
      defaultFrequencyFromList,
      reconcileFrozenMembershipSnapshot,
    } = require('../routes/estimate-public');
    if (typeof buildPricingBundle !== 'function') return null;
    // The page reconciles a lapsed membership BEFORE it builds the bundle: a
    // snapshot frozen while the customer was still a member keeps prior-service
    // artifacts and a member-priced pricingBundle that the fast path would
    // happily serve. Reconciling drops those artifacts, reprices, refreshes the
    // row's totals in place and invalidates the stale bundle — so calling it
    // first is what makes this resolution identical to the page's, rather than
    // quoting a discount the accept path will not honour (codex #3120 r7).
    // Its own first guard is the same price-lock predicate used above, so a
    // committed deal is never retroactively repriced by this call.
    if (typeof reconcileFrozenMembershipSnapshot === 'function') {
      await reconcileFrozenMembershipSnapshot(estimate);
    }
    const bundle = await buildPricingBundle(estimate);
    if (!bundle || typeof bundle !== 'object') return null;
    const sellable = (Array.isArray(bundle.frequencies) ? bundle.frequencies : [])
      .filter((entry) => entry && entry.quoteRequired !== true);
    const defaultCandidate = typeof defaultFrequencyFromList === 'function'
      ? defaultFrequencyFromList(sellable)
      : null;
    return { bundle, defaultCandidate: defaultCandidate || null };
  } catch (err) {
    logger.warn(`[estimate-proposal-billing] live pricing failed for estimate ${estimate?.id}: ${err.message}`);
    return null;
  }
}

/**
 * Per-application copy requires BOTH lookups to answer conclusively — any
 * unknown keeps the legacy document, which is always safe to render.
 *
 * The live rebuild runs ONLY for a confirmed per-application lane on an
 * unlocked estimate: it is the one expensive call here, and every other case
 * renders from frozen pricing exactly as it did before.
 *
 * @returns {Promise<{ billsPerApplication: boolean,
 *   livePricing: { bundle: object, defaultCandidate: object|null }|null }>}
 */
async function resolveProposalBillingContext(estimate) {
  const [perApplication, prepaid] = await Promise.all([
    estimateBillsPerApplication(estimate),
    estimateSoldAsAnnualPrepay(estimate),
  ]);
  const billsPerApplication = perApplication === true && prepaid === false;
  return {
    billsPerApplication,
    livePricing: billsPerApplication ? await resolveLivePricing(estimate) : null,
  };
}

module.exports = {
  estimateBillsPerApplication,
  estimateIsPriceLocked,
  estimateSoldAsAnnualPrepay,
  resolveLivePricing,
  resolveProposalBillingContext,
};
// Test-only: lets suites exercise the pre-migration branch after a true probe
// has been cached (mirrors estimate-public.js).
module.exports._resetPerApplicationColumnsProbeForTests = () => {
  perApplicationColumnsKnownPresent = false;
};
