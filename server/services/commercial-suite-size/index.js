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

  let businessName = businessNameHint || null;
  let businessType = null;

  // Listing leg (PR 5b): a size published for THIS suite. Network-bound
  // (a search vendor, up to three page fetches), so the cache-hit path that
  // skips the web-search leg skips this one too; the gate inside returns
  // null at once when dark.
  // The listing's SIZE is authoritative when found, but the DBPR license
  // below still runs: a license at this suite is what classifies it as a
  // restaurant (subtype correction, cadence), whichever source sized it.
  let listing = null;
  const listingRemaining = remainingBudgetMs(opts.deadlineAt);
  if (opts.skipWebSearch || opts.skipListing) {
    // skipped by the caller
  } else if (listingRemaining < MIN_LEG_REMAINING_MS) {
    logger.warn(`[commercial-suite-size] skipping listing leg — ${Math.max(0, Math.round(listingRemaining))}ms left in the lookup budget`);
  } else {
    try {
      const found = await resolveViaListing({ address, businessNameHint }, {
        ...opts,
        timeoutMs: Math.min(opts.listingTimeoutMs || LISTING_DEFAULT_TIMEOUT_MS, listingRemaining),
      });
      if (found && Number(found.value) > 0) listing = found;
    } catch (err) {
      logger.warn(`[commercial-suite-size] listing leg errored: ${err.message}`);
    }
  }
  const listingResult = (license) => ({
    value: listing.value,
    source: SOURCES.LISTING_VERIFIED_TEXT,
    confidence: 'medium',
    businessName: (license && license.businessName) || businessName,
    // Only a license (a public record) classifies the business; the
    // listing itself never does.
    businessType: license ? 'restaurant_food' : null,
    ...(license ? { licenseBacked: true, seats: license.seats, licenseEvidence: license.evidence } : {}),
    evidence: listing.evidence,
    url: listing.url,
    listingFetchedAt: listing.fetchedAt,
  });

  const dbprRemaining = remainingBudgetMs(opts.deadlineAt);
  if (dbprRemaining < MIN_LEG_REMAINING_MS) {
    logger.warn(`[commercial-suite-size] skipping DBPR leg — ${Math.max(0, Math.round(dbprRemaining))}ms left in the lookup budget`);
    if (listing) return listingResult(null);
  } else {
    try {
      const dbprOpts = Number.isFinite(dbprRemaining)
        ? { ...opts, timeoutMs: Math.min(DBPR_DEFAULT_TIMEOUT_MS, dbprRemaining) }
        : opts;
      const dbpr = await resolveViaDbprLicense({ address, phone, businessNameHint }, dbprOpts);
      if (listing) return listingResult(dbpr && (Number(dbpr.value) > 0 || dbpr.businessName) ? dbpr : null);
      if (dbpr) {
        businessName = businessName || dbpr.businessName || null;
        if (Number(dbpr.value) > 0) {
          return {
            value: dbpr.value,
            source: SOURCES.LICENSE_SEATS,
            confidence: 'medium',
            businessName: dbpr.businessName || businessName,
            businessType: 'restaurant_food',
            evidence: dbpr.evidence,
            seats: dbpr.seats,
          };
        }
      }
    } catch (err) {
      logger.warn(`[commercial-suite-size] DBPR leg errored: ${err.message}`);
      if (listing) return listingResult(null);
    }
  }

  // Name-only leg (see web-search-leg.js — it never returns a size).
  // skipWebSearch: the admin lookup's cache-hit path, which must stay fast.
  const webRemaining = remainingBudgetMs(opts.deadlineAt);
  if (opts.skipWebSearch) {
    // skipped by the caller
  } else if (webRemaining < MIN_LEG_REMAINING_MS) {
    logger.warn(`[commercial-suite-size] skipping web-search leg — ${Math.max(0, Math.round(webRemaining))}ms left in the lookup budget`);
  } else {
    try {
      const webOpts = Number.isFinite(webRemaining)
        ? { ...opts, timeoutMs: Math.min(opts.timeoutMs || WEB_SEARCH_DEFAULT_TIMEOUT_MS, webRemaining) }
        : opts;
      const web = await resolveViaWebSearch({ address, businessNameHint }, webOpts);
      if (web) {
        businessName = businessName || web.businessName || null;
        businessType = businessType || web.businessType || null;
      }
    } catch (err) {
      logger.warn(`[commercial-suite-size] web-search leg errored: ${err.message}`);
    }
  }

  // Type default keys OFF commercialRiskType/commercialSubtype ONLY — a
  // web-search-reported businessType never chooses the size (AGENTS.md); it
  // still rides the RESULT for display/notes. The label names the ONE input
  // that chose the value (a specific subtype, else the risk type).
  const { sqft: value, basis } = defaultSuiteSizeBasis({ commercialRiskType, commercialSubtype });
  const businessTypeLabel = basis || 'this business type';
  return {
    value,
    source: SOURCES.SUITE_TYPE_DEFAULT,
    confidence: 'low',
    businessName,
    businessType,
    defaultBasis: basis || null,
    evidence: [{
      source: SOURCES.SUITE_TYPE_DEFAULT,
      detail: `no suite-specific measurement found — defaulted to ${value.toLocaleString()} sq ft for ${businessTypeLabel}`,
    }],
  };
}

const { suiteAddressParts } = require('./address-parts');

module.exports = {
  SOURCES,
  suiteAddressParts,
  resolveCommercialSuiteSize,
};
