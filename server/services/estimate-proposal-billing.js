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

// Every proposal document asks the public estimate route's one service-mix
// policy. Classify the NORMALIZED rows the document actually prints, rather
// than the estimate page's pricing rows: a disabled proposal can remain stored
// as revision history and normalizeProposal deliberately renders its
// itemization, even though the ordinary page correctly ignores it. Passing a
// synthetic active proposal lets the canonical policy read those exact row
// containers without inventing a second termite/service taxonomy here.
// Unknown policy context fails closed to neutral copy.
function proposalMakesNoGuaranteeClaim(proposal, estimateId = null) {
  try {
    const { estimateMakesNoGuaranteeClaim } = require('../routes/estimate-public');
    if (typeof estimateMakesNoGuaranteeClaim !== 'function') return true;
    return estimateMakesNoGuaranteeClaim({
      proposal: {
        enabled: true,
        buildings: Array.isArray(proposal?.buildings) ? proposal.buildings : [],
        programs: Array.isArray(proposal?.programs) ? proposal.programs : [],
        correctiveWork: Array.isArray(proposal?.correctiveWork) ? proposal.correctiveWork : [],
      },
    });
  } catch (err) {
    logger.warn(`[estimate-proposal-billing] guarantee-policy lookup failed for estimate ${estimateId || 'unknown'}: ${err.message}`);
    return true;
  }
}

function proposalRows(proposal) {
  const list = (value) => (Array.isArray(value) ? value : []);
  return [
    ...list(proposal?.buildings).flatMap((building) => list(building?.lineItems)),
    ...list(proposal?.correctiveWork),
    ...list(proposal?.programs),
  ];
}

function proposalRowLanes(row) {
  const { serviceKeysFromText } = require('./estimate-service-lines');
  return serviceKeysFromText(row?.service, row?.serviceKey, row?.description, row?.label, row?.name);
}

// Whether a guarantee line may cover the whole proposal document: a
// residential proposal (never an authored, enabled one, which is commercial)
// whose every printed row is in a recurring residential lane (pest, lawn,
// mosquito, tree & shrub, palm). Rodent, commercial, mixed-with-neutral,
// termite and unknown scope stay terms-neutral (AGENTS.md estimate truth
// scope).
function proposalCarriesPlanTerms(proposal, estimateId = null) {
  if (!proposal || typeof proposal !== 'object' || proposal.enabled === true) return false;
  if (proposalMakesNoGuaranteeClaim(proposal, estimateId)) return false;
  const { RECURRING_TERMS_LANES } = require('./estimate-followup-copy');
  const rows = proposalRows(proposal);
  return rows.length > 0 && rows.every((row) => {
    const lanes = proposalRowLanes(row);
    return lanes.length === 1 && RECURRING_TERMS_LANES.includes(lanes[0]);
  });
}

// The terms one printed row states on its own (owner ruling 2026-09-27: each
// service carries its own terms): 'all' for a row in one recurring
// residential lane (pest, lawn, mosquito, tree & shrub, palm) on a
// residential proposal, 'satisfaction' for any other row and every row of an
// authored (commercial) proposal, 'none' on a document that makes no
// guarantee claim (the caller's proposalMakesNoGuaranteeClaim result).
function proposalRowTermsScope(proposal, row, noGuaranteeClaims = false) {
  if (noGuaranteeClaims === true) return 'none';
  if (proposal?.enabled === true) return 'satisfaction';
  const { RECURRING_TERMS_LANES } = require('./estimate-followup-copy');
  const lanes = proposalRowLanes(row);
  return lanes.length === 1 && RECURRING_TERMS_LANES.includes(lanes[0]) ? 'all' : 'satisfaction';
}

// Whether the PDF may print its canned IPM/callback sentence, a recurring
// residential PEST term: the proposal carries the plan terms, every row is
// pest work, and at least one line is a scheduled recurring visit.
function proposalHasRecurringVisit(proposal) {
  return (Array.isArray(proposal?.buildings) ? proposal.buildings : [])
    .flatMap((building) => (Array.isArray(building?.lineItems) ? building.lineItems : []))
    .some((item) => item?.frequency && item.frequency !== 'one_time');
}

function proposalCallbackTermsEligible(proposal, estimateId = null) {
  if (!proposalCarriesPlanTerms(proposal, estimateId)) return false;
  const rows = proposalRows(proposal);
  return proposalHasRecurringVisit(proposal) && rows.every((row) => {
    const lanes = proposalRowLanes(row);
    return lanes.length === 1 && lanes[0] === 'pest';
  });
}

// Frozen documents keep their original terms (codex #5434 r2 P1): an
// accepted or declined estimate's document describes the proposal the
// customer actually saw (estimateIsPriceLocked, the line this module already
// draws between "committed" and "still selling"), so the rate review
// disclosure prints on a frozen document ONLY when the recorded acceptance
// proves the customer accepted under terms that carried the sentence — the
// 'plan' acceptance snapshot (estimate_acceptances.terms_text). A document
// frozen before this disclosure existed, one accepted under the 'base'
// drawer (rodent, one-time toggle), or a declined one never acquires it. An
// open estimate is being sold under the current terms and prints it.
// Two pieces of persisted evidence, either suffices (codex #5434 r3 P1):
// the acceptance drawer snapshot, or the accept's own document stamp
// (estimate_data.rateReviewDisclosedAtAccept — written atomically with the
// acceptance whenever the open document carried the line, including accepts
// that record no drawer snapshot: the gate off, the annual prepay lane).
function documentCarriesRateReviewTerms(estimate, acceptance = null) {
  if (!estimateIsPriceLocked(estimate)) return true;
  let data = estimate?.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  if (data && typeof data === 'object' && data.rateReviewDisclosedAtAccept === true) return true;
  const { RATE_REVIEW_SENTENCE } = require('./acceptance-terms-text');
  const text = acceptance?.termsText ?? acceptance?.terms_text ?? '';
  return typeof text === 'string' && text.includes(RATE_REVIEW_SENTENCE);
}

// Whether the annual rate review disclosure prints beside the pdfkit
// document's terms (owner ruling 2026-09-30): the SAME plan-terms scope the
// money-back guarantee keys on — every row residential pest, lawn, mosquito
// or tree & shrub (proposalCarriesPlanTerms: never termite, rodent,
// commercial or an authored proposal) — plus at least one recurring line,
// because a one-time-only document has no rate to review — and, given the
// estimate row (+ its acceptance record), the frozen-document rule above.
// Projected to the browser document by /data, so the two renderers read ONE
// decision (EstimateProposalDocument.jsx rateReviewEligible).
function proposalRateReviewTermsEligible(proposal, estimateId = null, { estimate = null, acceptance = null } = {}) {
  if (!proposalCarriesPlanTerms(proposal, estimateId)) return false;
  if (!proposalHasRecurringVisit(proposal)) return false;
  return estimate ? documentCarriesRateReviewTerms(estimate, acceptance) : true;
}

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

// An unlocked estimate whose pricing could not be resolved. Distinct from null,
// which means "frozen — use the accepted pricing": conflating the two let a
// transient rebuild failure quote the very snapshot the route rejects (#3120 r8).
const UNRESOLVED_PRICING = Object.freeze({ unresolved: true });

// Acceptance freezes the price: both accept flows stamp price_locked_at and
// pricing_authority 'LOCKED' in the same atomic update that writes
// monthly_total / annual_total / accepted_frequency_key, and /:token/pdf stays
// downloadable on the accepted terminal view. A locked estimate's document must
// describe the plan the customer ACCEPTED, so it is never re-priced under
// today's policy. Same predicate reconcileFrozenMembershipSnapshot uses for
// exactly the same reason (estimate-public.js) — this is the line the codebase
// already draws between "committed" and "still selling".
// DECLINED is terminal too: the link stays customer-viewable and its PDF stays
// downloadable, but the estimate can never be accepted, so rebuilding it under
// today's floors and cadences would restate a quote the customer already turned
// down. Frozen, like accepted (#3120 r8).
const FROZEN_DOCUMENT_STATUSES = new Set(['accepted', 'declined']);
function estimateIsPriceLocked(estimate) {
  return FROZEN_DOCUMENT_STATUSES.has(String(estimate?.status || '').trim().toLowerCase())
    || !!estimate?.price_locked_at;
}

// An OUTSTANDING quote is described from the bundle the PAGE is selling, not
// the frozen send snapshot: buildPricingBundleInner refuses to fast-path a
// snapshot that violates lawn program policy (retired cadence, below-floor
// price), carries a stale termite row, or is missing a required setup fee, and
// rebuilds it — so the frozen copy can describe a plan no link can still sell.
//
// Two things have to happen in order, both borrowed rather than reimplemented:
//
//   1. reconcileFrozenMembershipSnapshot, because the page runs it BEFORE
//      building the bundle. A snapshot frozen while the customer was still a
//      member keeps prior-service artifacts and a member-priced bundle the fast
//      path would serve; reconciling strips them, reprices, refreshes the row's
//      totals IN PLACE and invalidates the stale bundle. It self-guards on the
//      same price-lock predicate, so it can never touch a committed deal.
//   2. buildPricingBundle, the single function applying every invalidity check
//      AND the lane strip/backfill. Re-implementing either here would just add
//      a copy to drift.
//
// defaultCandidate rides along because a rebuilt bundle's prices no longer
// match the frozen columns — see the authority table in estimate-proposal.js.
// Resolved through the route's own defaultFrequencyFromList so this document
// cannot name a different default cadence than acceptance would price.
//
// Null for a locked estimate and null on any failure: both land on the frozen
// pricing, which is always safe to render.
async function resolveLivePricing(estimate) {
  if (estimateIsPriceLocked(estimate)) return null;
  try {
    const {
      buildPricingBundle,
      defaultFrequencyFromList,
      reconcileFrozenMembershipSnapshot,
    } = require('../routes/estimate-public');
    if (typeof buildPricingBundle !== 'function') return UNRESOLVED_PRICING;
    if (typeof reconcileFrozenMembershipSnapshot === 'function') {
      await reconcileFrozenMembershipSnapshot(estimate);
    }
    const bundle = await buildPricingBundle(estimate);
    if (!bundle || typeof bundle !== 'object') return UNRESOLVED_PRICING;
    const sellable = (Array.isArray(bundle.frequencies) ? bundle.frequencies : [])
      .filter((entry) => entry && entry.quoteRequired !== true);
    const defaultCandidate = typeof defaultFrequencyFromList === 'function'
      ? defaultFrequencyFromList(sellable)
      : null;
    // snapshotHit tells the synthesis whether the stored columns still describe
    // this bundle: the route stamps it only on the fast path, so its ABSENCE
    // means the snapshot was rejected and rebuilt.
    return { bundle, defaultCandidate: defaultCandidate || null, snapshotHit: bundle.snapshotHit === true };
  } catch (err) {
    logger.warn(`[estimate-proposal-billing] live pricing failed for estimate ${estimate?.id}: ${err.message}`);
    return UNRESOLVED_PRICING;
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
  proposalCallbackTermsEligible,
  proposalCarriesPlanTerms,
  proposalMakesNoGuaranteeClaim,
  proposalRateReviewTermsEligible,
  documentCarriesRateReviewTerms,
  proposalRowTermsScope,
  resolveLivePricing,
  resolveProposalBillingContext,
};
// Test-only: lets suites exercise the pre-migration branch after a true probe
// has been cached (mirrors estimate-public.js).
module.exports._resetPerApplicationColumnsProbeForTests = () => {
  perApplicationColumnsKnownPresent = false;
};
