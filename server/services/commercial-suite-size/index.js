/**
 * Commercial suite sizing — owner ruling 2026-09-25.
 *
 * A commercial tenant in a multi-tenant building (a restaurant in unit 102
 * of a shopping plaza) must be auto-priced by the SUITE's own square
 * footage, never the whole building, and never left as a $0 manual quote.
 * source-arbitration.js gives a commercial tenant with no stated unit size
 * `sizeBasis: 'unresolved'` by design (county sqft describes the building) —
 * this module is what fills that gap for the estimator engine and the
 * admin estimate tool's property lookup, the same way a residential
 * estimate is auto-sized from county/subdivision data.
 *
 * Three SIZE sources, tried in priority order, each fail-open (an error or a
 * miss just falls through to the next):
 *   0. listing_verified_text — a size a public listing publishes for THIS
 *                           suite (./listing-size.js; address-match PR 5b,
 *                           owner 2026-10-02; dark, GATE_LOOKUP_LISTING_SIZE):
 *                           plain code reads search-result snippets and
 *                           fetchable broker pages for a figure next to the
 *                           typed street number and suite. No model.
 *   1. license_seats     — an active FL DBPR food-service license naming
 *                           this suite (server/services/commercial-suite-size/dbpr-food-license.js).
 *   2. suite_type_default — a business-type-keyed rough default
 *                           (./type-defaults.js), keyed OFF
 *                           commercialRiskType/commercialSubtype ONLY —
 *                           always resolves, so this function effectively
 *                           never returns null.
 *
 * A caller/tech-stated size always outranks both — that rule already lives
 * in source-arbitration.js's resolveHomeSqft and is unchanged; this module
 * is only ever consulted when the caller-stated size is absent.
 *
 * The web-search leg (./web-search-leg.js) is NOT a size source (AGENTS.md:
 * an LLM proposes intent, it never reaches a price/size field) — it only
 * finds the business name/type for display/notes when DBPR has nothing,
 * and is consulted between the two size rungs above for that reason alone.
 */

const logger = require('../logger');
const { resolveViaDbprLicense } = require('./dbpr-food-license');
const { resolveViaWebSearch } = require('./web-search-leg');
const { resolveViaListing, SOURCE: LISTING_SOURCE } = require('./listing-size');
const { defaultSuiteSizeBasis } = require('./type-defaults');

const SOURCES = {
  LISTING_VERIFIED_TEXT: LISTING_SOURCE,
  LICENSE_SEATS: 'license_seats',
  SUITE_TYPE_DEFAULT: 'suite_type_default',
};

// Admin-lookup budget (property-lookup-v2.js passes opts.deadlineAt, an
// absolute Date.now()-comparable timestamp): each leg's timeout is capped to
// the time left, and a leg isn't started at all under MIN_LEG_REMAINING_MS.
// Absent (the estimator engine), every leg keeps its own default.
const DBPR_DEFAULT_TIMEOUT_MS = 15000;
const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 20000;
const LISTING_DEFAULT_TIMEOUT_MS = 12000;
const MIN_LEG_REMAINING_MS = 2000;

function remainingBudgetMs(deadlineAt) {
  return Number.isFinite(deadlineAt) ? (deadlineAt - Date.now()) : Infinity;
}

/**
 * @param {object} input
 *   address            — { street, unit, city, zip }
 *   phone              — any phone string, or null
 *   businessNameHint    — a known/typed business name, or null (the resolver
 *                         DISCOVERS the name when this is absent — that is
 *                         the point: "search for the business name by
 *                         address", not "require it to be typed in first")
 *   commercialRiskType  — intent-schema commercial_risk_type, or null
 *   commercialSubtype   — property-lookup commercialSubtype, or null
 * @param {object} opts   — districts, fetchText, now, requireWarmCache,
 *                         minRows (DBPR leg); timeoutMs, maxSearches,
 *                         anthropicClient (web-search leg); skipWebSearch
 *                         (the admin lookup's cache-hit path); deadlineAt
 *                         (the admin lookup's remaining budget)
 * @returns {Promise<{value:number, source:string, confidence:string,
 *   businessName:string|null, businessType:string|null, evidence:array,
 *   seats?:number}|null>}
 */
async function resolveCommercialSuiteSize(input = {}, opts = {}) {
  const {
    address = {}, phone = null, businessNameHint = null,
    commercialRiskType = null, commercialSubtype = null,
  } = input;

  // The listing's SIZE is authoritative when found (PR 5b), but the DBPR
  // license still runs: a license at this suite is what classifies it as a
  // restaurant (subtype correction, cadence), whichever source sized it.
  const listing = await listingLeg({ address, businessNameHint }, opts);
  const license = await licenseLeg({ address, phone, businessNameHint }, opts);
  if (listing) return listingResult(listing, license, businessNameHint || null);
  const licensed = licenseResult(license.row, businessNameHint);
  if (licensed) return licensed;

  // Name-only leg (see web-search-leg.js — it never returns a size).
  const web = await webSearchLeg({ address, businessNameHint }, opts);
  const names = [businessNameHint, license.row && license.row.businessName, web && web.businessName];
  return typeDefaultResult({ commercialRiskType, commercialSubtype }, names.find(Boolean) || null, web);
}

// A license-sized result, or null when the license names no size.
function licenseResult(row, nameHint) {
  if (!row || !(Number(row.value) > 0)) return null;
  return {
    value: row.value,
    source: SOURCES.LICENSE_SEATS,
    confidence: 'medium',
    businessName: row.businessName || nameHint || null,
    businessType: 'restaurant_food',
    evidence: row.evidence,
    seats: row.seats,
  };
}

// Type default keys OFF commercialRiskType/commercialSubtype ONLY — a
// web-search-reported businessType never chooses the size (AGENTS.md); it
// still rides the RESULT for display/notes. The label names the ONE input
// that chose the value (a specific subtype, else the risk type).
function typeDefaultResult(types, businessName, web) {
  const { sqft: value, basis } = defaultSuiteSizeBasis(types);
  return {
    value,
    source: SOURCES.SUITE_TYPE_DEFAULT,
    confidence: 'low',
    businessName,
    businessType: (web && web.businessType) || null,
    defaultBasis: basis || null,
    evidence: [{
      source: SOURCES.SUITE_TYPE_DEFAULT,
      detail: `no suite-specific measurement found — defaulted to ${value.toLocaleString()} sq ft for ${basis || 'this business type'}`,
    }],
  };
}

// Listing leg (PR 5b): a size published for THIS suite, or null. Network-
// bound (a search vendor, up to three page fetches), so the cache-hit path
// (skipWebSearch) skips it, EXCEPT when the row's own listing stamp aged out
// (opts.listingRefresh): then the published size is re-read rather than
// dropped to a default. The gate inside returns null at once when dark.
async function listingLeg(input, opts) {
  if ((opts.skipWebSearch && opts.listingRefresh !== true) || opts.skipListing) return null;
  const remaining = remainingBudgetMs(opts.deadlineAt);
  if (remaining < MIN_LEG_REMAINING_MS) {
    logger.warn(`[commercial-suite-size] skipping listing leg — ${Math.max(0, Math.round(remaining))}ms left in the lookup budget`);
    return null;
  }
  try {
    const found = await resolveViaListing(input, { ...opts, timeoutMs: Math.min(opts.listingTimeoutMs || LISTING_DEFAULT_TIMEOUT_MS, remaining) });
    return found && Number(found.value) > 0 ? found : null;
  } catch (err) {
    logger.warn(`[commercial-suite-size] listing leg errored: ${err.message}`);
    return null;
  }
}

// DBPR license leg. `row` is the matched license (or null); `checked` is
// true only when the license list really loaded, so a null row then means
// "no license at this suite", not an outage, a timeout or a skipped leg.
async function licenseLeg(input, opts) {
  const remaining = remainingBudgetMs(opts.deadlineAt);
  if (remaining < MIN_LEG_REMAINING_MS) {
    logger.warn(`[commercial-suite-size] skipping DBPR leg — ${Math.max(0, Math.round(remaining))}ms left in the lookup budget`);
    return { row: null, checked: false };
  }
  const diag = {};
  const legOpts = Number.isFinite(remaining)
    ? { ...opts, diag, timeoutMs: Math.min(DBPR_DEFAULT_TIMEOUT_MS, remaining) }
    : { ...opts, diag };
  try {
    const row = await resolveViaDbprLicense(input, legOpts);
    return { row: row || null, checked: diag.extractLoaded === true };
  } catch (err) {
    logger.warn(`[commercial-suite-size] DBPR leg errored: ${err.message}`);
    return { row: null, checked: false };
  }
}

// Name-only web-search leg. skipWebSearch: the admin lookup's cache-hit
// path, which must stay fast.
async function webSearchLeg(input, opts) {
  if (opts.skipWebSearch) return null;
  const remaining = remainingBudgetMs(opts.deadlineAt);
  if (remaining < MIN_LEG_REMAINING_MS) {
    logger.warn(`[commercial-suite-size] skipping web-search leg — ${Math.max(0, Math.round(remaining))}ms left in the lookup budget`);
    return null;
  }
  const legOpts = Number.isFinite(remaining)
    ? { ...opts, timeoutMs: Math.min(opts.timeoutMs || WEB_SEARCH_DEFAULT_TIMEOUT_MS, remaining) }
    : opts;
  try {
    return (await resolveViaWebSearch(input, legOpts)) || null;
  } catch (err) {
    logger.warn(`[commercial-suite-size] web-search leg errored: ${err.message}`);
    return null;
  }
}

// A listing-sized result. Only a license (a public record) classifies the
// business; the listing itself never does. The license's own evidence rides
// beside the listing's, so the record that justified a restaurant
// classification is kept with the result.
function listingResult(listing, license, nameHint) {
  const row = license.row && (Number(license.row.value) > 0 || license.row.businessName) ? license.row : null;
  return {
    value: listing.value,
    source: SOURCES.LISTING_VERIFIED_TEXT,
    confidence: 'medium',
    businessName: (row && row.businessName) || nameHint,
    businessType: row ? 'restaurant_food' : null,
    ...(row ? { licenseBacked: true, seats: row.seats } : {}),
    licenseChecked: Boolean(row) || license.checked,
    evidence: [...(listing.evidence || []), ...((row && row.evidence) || [])],
    url: listing.url,
    listingFetchedAt: listing.fetchedAt,
  };
}

const { suiteAddressParts } = require('./address-parts');

module.exports = {
  SOURCES,
  suiteAddressParts,
  resolveCommercialSuiteSize,
};
