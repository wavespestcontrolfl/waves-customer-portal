/**
 * Commercial suite sizing — owner ruling 2026-09-25.
 *
 * A commercial tenant in a multi-tenant building (a restaurant in unit 102
 * of a shopping plaza) must be auto-priced by the SUITE's own square
 * footage, never the whole building, and never left as a $0 manual quote.
 * source-arbitration.js gives a commercial tenant with no stated unit size
 * `sizeBasis: 'unresolved'` by design (county sqft describes the building) —
 * this module is what fills that gap for the estimator engine and the
 * manual property-lookup tool, the same way a residential estimate is
 * auto-sized from county/subdivision data.
 *
 * Two SIZE sources, tried in priority order, each fail-open (an error or a
 * miss just falls through to the next):
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
const { defaultSuiteSizeBasis } = require('./type-defaults');

const SOURCES = {
  LICENSE_SEATS: 'license_seats',
  SUITE_TYPE_DEFAULT: 'suite_type_default',
};

// Mirrors each leg's own default (dbpr-food-license.js's DBPR_FETCH_TIMEOUT_MS,
// web-search-leg.js's DEFAULT_TIMEOUT_MS) — used only to cap it further when
// opts.deadlineAt leaves less than the leg's usual budget.
const DBPR_DEFAULT_TIMEOUT_MS = 15000;
const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 20000;
// Below this much remaining lookup budget, a leg isn't worth starting at all
// (primary review of PR #4840 r5 P2 — a cold DBPR fetch (15s) + web search
// (20s) could add ~35s to a lookup the caller is already waiting on).
const MIN_LEG_REMAINING_MS = 2000;

// opts.deadlineAt: an absolute Date.now()-comparable timestamp (never a
// duration — avoids drift across the awaits between legs). Absent/non-finite
// means unbounded (every existing caller that doesn't pass it keeps today's
// behavior exactly).
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
 * @param {object} opts   — timeouts/injection for tests: districts,
 *                         fetchText, now, requireWarmCache (DBPR leg),
 *                         timeoutMs, maxSearches, anthropicClient
 *                         (web-search leg), skipWebSearch, deadlineAt (an
 *                         absolute ms timestamp both legs' own timeoutMs are
 *                         capped to — see remainingBudgetMs above)
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

  const dbprRemaining = remainingBudgetMs(opts.deadlineAt);
  if (dbprRemaining < MIN_LEG_REMAINING_MS) {
    logger.warn(`[commercial-suite-size] skipping DBPR leg — ${Math.max(0, Math.round(dbprRemaining))}ms left in the lookup budget`);
  } else {
    try {
      const dbprOpts = Number.isFinite(dbprRemaining)
        ? { ...opts, timeoutMs: Math.min(DBPR_DEFAULT_TIMEOUT_MS, dbprRemaining) }
        : opts;
      const dbpr = await resolveViaDbprLicense({ address, phone, businessNameHint }, dbprOpts);
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
    }
  }

  // skipWebSearch: the manual lookup tool's fast CACHED-rebuild path uses
  // this to keep a cache hit cheap — a Claude web-search call on every
  // cache hit would defeat the point of caching. The FRESH lookup (already
  // a multi-second, multi-provider call) and the estimator engine both run
  // this leg (name-only; see web-search-leg.js — it never returns a size).
  const webRemaining = remainingBudgetMs(opts.deadlineAt);
  if (opts.skipWebSearch) {
    // no-op — existing behavior
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
