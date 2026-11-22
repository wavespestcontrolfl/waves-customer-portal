'use strict';

/**
 * Mailer step 2a (shadow): the price of a new-home prospect's quarterly pest plan, for a home with every fact
 * (home size and its source, stories, lot size; see services/mail/home-facts.js). Used by the home price pass
 * (services/mail/home-price.js).
 *
 * The plan is priced as a DRY RUN of the portal's own estimate save (admin-estimate-persistence
 * createOrReuseAdminEstimate, requireLivePricing), with the engine input built by estimator-engine/draft-builder, the
 * way moving-auto-estimate and tech-estimate-price do. Unlike them it starts from no paid property lookup: the facts
 * come from the county data. The body carries the home's own address and no customer, phone or email; the dry run
 * needs none. Nothing is saved.
 *
 * The verdict: a server price, no member of Waves at the address (the save's own warning: its price would be on
 * new-customer terms), exactly one engine line and it is the pest line, no quote-required line, no line a person must
 * review before its price stands as exact (draft-builder lineNeedsReviewBeforeExactPrice, the shared test), an annual
 * total above 0 and a setup fee the table can hold. A clean price is priced; anything else is not_clean with one reason
 * code; a save the server refuses (4xx) is not_clean / save_refused; any other failure is failed / engine (tried again
 * later).
 *
 * No database access of its own, no paid or AI service, no logging.
 */

const MAX_AMOUNT = 1e8; // the price columns hold up to numeric(10,2)

// The real call for each outside dependency a test did not inject, loaded one by one.
const REAL = {
  buildEngineInput: () => require('../estimator-engine/draft-builder').buildEngineInput,
  // The shared estimate save as a dry run: nothing is written. It reads the live price list, and refuses (503) when
  // that is unavailable.
  dryRunEstimate: () => (body) => require('../admin-estimate-persistence').createOrReuseAdminEstimate({
    database: require('../../models/db'), body, technicianId: null, technician: null, dryRun: true, requireLivePricing: true,
  }),
};

const httpStatus = (err) => Number(err?.statusCode || err?.status) || 0;
const moneyOrNull = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.round(Number(value) * 100) / 100 : null);

function parseJson(value) {
  if (!value || typeof value === 'object') return value || null;
  try { return JSON.parse(value); } catch { return null; }
}

/** The engine input for a quarterly pest plan on a single-family home with these facts. */
function engineInputFor(facts, buildEngineInput) {
  const { SQFT_SOURCES } = require('../estimator-engine/source-arbitration');
  return buildEngineInput({
    intent: { services: { pest: { frequency: 'quarterly', roachType: 'none' } }, is_commercial: false, category: 'RESIDENTIAL' },
    propertyFacts: {
      home: {
        value: facts.homeSqft,
        source: facts.homeSqftSource === 'parcel_map' ? SQFT_SOURCES.COUNTY_ASSESSED : SQFT_SOURCES.PERMIT_PLAN,
        confidence: 'medium',
      },
      lot: { value: facts.lotSqft, source: SQFT_SOURCES.COUNTY_ASSESSED },
      stories: facts.stories,
      propertyType: 'single_family',
    },
    context: {},
    lookupEnriched: null,
  });
}

/** The estimate save's body for the home: its own address, no customer. */
function estimateBody(row, facts, engineInputs) {
  const address = [row.address_line1, [row.city, row.state, row.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    address,
    showOneTimeOption: false,
    billByInvoice: false,
    estimateData: {
      engineInputs,
      // What the estimator form reopens with, as the other automatic estimates write it.
      inputs: {
        address,
        propertyType: 'Single Family',
        homeSqFt: String(facts.homeSqft),
        lotSqFt: String(facts.lotSqft),
        stories: String(facts.stories),
        svcPest: true,
        pestFreq: '4',
      },
    },
  };
}

// A line a person must look at before its price stands: the shared exact-price test (a review marker, a heuristic turf
// grade, LOW confidence, a footprint the engine guessed), or a line the engine could not price.
function lineFlagged(line) {
  const { lineNeedsReviewBeforeExactPrice } = require('../estimator-engine/draft-builder');
  return !!(lineNeedsReviewBeforeExactPrice(line) || line.quoteRequired || line.requiresQuote);
}

// The setup fee: 0 when the result has none; null for a value that is no amount or that the column cannot hold.
function setupFeeOf(value) {
  if (value === null || value === undefined || value === '') return 0;
  const fee = moneyOrNull(value);
  return fee !== null && fee >= 0 && fee < MAX_AMOUNT ? fee : null;
}

// The annual total, the setup fee and the engine digest of a priced estimate, or null.
function priceOf(estimate, data) {
  const { agentEngineResultDigest } = require('../agent-estimate-preview');
  const annual = moneyOrNull(estimate.annual_total);
  const digest = agentEngineResultDigest(data.engineResult);
  const setupFee = setupFeeOf(data.result && data.result.oneTime && data.result.oneTime.membershipFee);
  if (!(annual > 0) || annual >= MAX_AMOUNT || !digest || setupFee === null) return null;
  return { annual, setupFee, digest };
}

/**
 * The dry run's verdict: { price } for a clean server price of one pest line, or { reason }
 * (not_server_price | member_address | not_one_line | engine_review | no_amount).
 */
function judge(prepared) {
  const estimate = prepared && prepared.estimate;
  if (!estimate || estimate.pricing_authority !== 'SERVER') return { reason: 'not_server_price' };
  // The save found a member of Waves at this address: its price is on new-customer terms. Only the code is kept, never
  // the warning (it names the member).
  if (prepared.memberLinkageWarning) return { reason: 'member_address' };
  const data = parseJson(estimate.estimate_data) || {};
  const lines = (data.engineResult && data.engineResult.lineItems) || [];
  if (lines.length !== 1 || !lines[0] || lines[0].service !== 'pest_control') return { reason: 'not_one_line' };
  if (lineFlagged(lines[0])) return { reason: 'engine_review' };
  const price = priceOf(estimate, data);
  return price ? { price } : { reason: 'no_amount' };
}

/**
 * The result to save for a home with every fact (`facts`: homeSqft, homeSqftSource, stories, lotSqft):
 *   { status: 'priced', ...facts, priceAnnual, priceSetupFee, priceDigest }
 *   { status: 'not_clean', reason, ...facts }     reason: not_server_price | member_address | not_one_line |
 *                                                  engine_review | no_amount | save_refused
 *   { status: 'failed', reason: 'engine', ...facts }
 * `deps` may replace buildEngineInput and dryRunEstimate (tests).
 */
async function priceHome(row, facts, deps = {}) {
  const buildEngineInput = deps.buildEngineInput || REAL.buildEngineInput();
  const dryRunEstimate = deps.dryRunEstimate || REAL.dryRunEstimate();
  const known = {
    homeSqft: facts.homeSqft, homeSqftSource: facts.homeSqftSource, stories: facts.stories, lotSqft: facts.lotSqft,
  };
  let prepared;
  try {
    prepared = await dryRunEstimate(estimateBody(row, facts, engineInputFor(facts, buildEngineInput)));
  } catch (err) {
    const status = httpStatus(err);
    return status >= 400 && status < 500
      ? { status: 'not_clean', reason: 'save_refused', ...known }
      : { status: 'failed', reason: 'engine', ...known };
  }
  const verdict = judge(prepared);
  if (verdict.reason) return { status: 'not_clean', reason: verdict.reason, ...known };
  return {
    status: 'priced', ...known, priceAnnual: verdict.price.annual, priceSetupFee: verdict.price.setupFee, priceDigest: verdict.price.digest,
  };
}

module.exports = { priceHome, judge, estimateBody, engineInputFor };
