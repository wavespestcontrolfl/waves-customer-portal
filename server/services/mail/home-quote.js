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
 * The verdict: a server price, no member of Waves at the address (its price would be on new-customer terms; read with
 * the strict address match, because the save's own warning is fail-soft and a failed lookup there reads as no member), exactly one engine line and it is the pest line, no quote-required line, no line a person must
 * review before its price stands as exact (draft-builder lineNeedsReviewBeforeExactPrice, the shared test), an annual
 * total above 0 and a setup fee the table can hold. A clean price is priced; anything else is not_clean with one reason
 * code; a save the server refuses (4xx) is not_clean / save_refused; any other failure is failed / engine (tried again
 * later). A member check that cannot finish is failed / member_check (tried again later), never a price; an address
 * the check can never answer for (no readable house number, too many rows, a member on file it cannot tell apart)
 * is not_clean / member_unchecked.
 *
 * One database read of its own (the member check: customers and their properties at this address), no paid or AI
 * service, no logging.
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
  // 'exact' when a member of Waves is at the address, 'near' when a member's address on file has the same house
  // digits and zip but the comparator cannot call it the same (cannot tell), else null. Strict: a failed lookup
  // throws, it never reads as no member.
  memberAtAddress: () => async (address, zip) => {
    const { findCustomersAtAddress } = require('../customer-address-match');
    const { isMembershipCustomerRow } = require('../waveguard-existing-services');
    const members = (await findCustomersAtAddress(require('../../models/db'), address, { strict: true, zip }))
      .filter(isMembershipCustomerRow);
    if (members.some((r) => r.exactMatch)) return 'exact';
    return members.length ? 'near' : null;
  },
  // The names the list counts as one place in a zip (prospect-store SAME_PLACE_CITY_NAMES), or the city alone.
  cityNamesOf: () => require('./prospect-store').cityNamesOf,
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
const addressOf = (row) => [row.address_line1, [row.city, row.state, row.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const upperLine = (text) => String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();

// The home's address once for each name of its place: a member may have it on file under the other name of the same
// zip (BRADENTON for LAKEWOOD RANCH in 34211), and the strict match compares cities.
function memberCheckAddresses(row, cityNamesOf) {
  const city = upperLine(row.city);
  const zip = upperLine(row.zip).slice(0, 5);
  if (!city || !zip) return [addressOf(row)];
  return cityNamesOf(city, zip).map((name) => addressOf({ ...row, city: name }));
}

function estimateBody(row, facts, engineInputs) {
  const address = addressOf(row);
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
 *                                                  engine_review | no_amount | save_refused | member_unchecked
 *   { status: 'failed', reason: 'engine' | 'member_check', ...facts }
 * `deps` may replace buildEngineInput, dryRunEstimate, memberAtAddress and cityNamesOf (tests).
 */
async function priceHome(row, facts, deps = {}) {
  const buildEngineInput = deps.buildEngineInput || REAL.buildEngineInput();
  const dryRunEstimate = deps.dryRunEstimate || REAL.dryRunEstimate();
  const memberAtAddress = deps.memberAtAddress || REAL.memberAtAddress();
  const cityNamesOf = deps.cityNamesOf || REAL.cityNamesOf();
  const known = {
    homeSqft: facts.homeSqft, homeSqftSource: facts.homeSqftSource, stories: facts.stories, lotSqft: facts.lotSqft,
  };
  // Before the save: a home whose member check cannot finish is tried again later, never priced on new-customer terms.
  // An address the search can never answer for is settled without a price (member_unchecked); any other error is
  // tried again later (member_check).
  // A near member (same house digits and zip, a spelling the comparator cannot read) cannot be told apart: no price.
  let member = null;
  try {
    const zip = upperLine(row.zip).slice(0, 5);
    for (const address of memberCheckAddresses(row, cityNamesOf)) {
      const found = await memberAtAddress(address, zip);
      if (found === 'exact') { member = 'exact'; break; }
      if (found === 'near') member = 'near';
    }
  } catch (err) {
    const { ADDRESS_UNCHECKABLE } = require('../customer-address-match');
    if (err?.code === ADDRESS_UNCHECKABLE) return { status: 'not_clean', reason: 'member_unchecked', ...known };
    return { status: 'failed', reason: 'member_check', ...known };
  }
  if (member === 'exact') return { status: 'not_clean', reason: 'member_address', ...known };
  if (member === 'near') return { status: 'not_clean', reason: 'member_unchecked', ...known };
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
