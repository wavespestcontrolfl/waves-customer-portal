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
 * Three sources, tried in priority order, each fail-open (an error or a
 * miss just falls through to the next):
 *   1. license_seats     — an active FL DBPR food-service license naming
 *                           this suite (server/services/commercial-suite-size/dbpr-food-license.js).
 *   2. commercial_listing — a bounded Claude web-search leg reading
 *                           LoopNet/Crexi/county condo records/the
 *                           business's own site (./web-search-leg.js).
 *   3. suite_type_default — a business-type-keyed rough default
 *                           (./type-defaults.js) — always resolves, so this
 *                           function effectively never returns null.
 *
 * A caller/tech-stated size always outranks all three — that rule already
 * lives in source-arbitration.js's resolveHomeSqft and is unchanged; this
 * module is only ever consulted when the caller-stated size is absent.
 */

const logger = require('../logger');
const { resolveViaDbprLicense } = require('./dbpr-food-license');
const { resolveViaWebSearch } = require('./web-search-leg');
const { defaultSuiteSqftFor } = require('./type-defaults');

const SOURCES = {
  LICENSE_SEATS: 'license_seats',
  COMMERCIAL_LISTING: 'commercial_listing',
  SUITE_TYPE_DEFAULT: 'suite_type_default',
};

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
 *   buildingSqft        — the WHOLE building's sqft if known, or null (used
 *                         only to reject a web-search figure that is
 *                         actually the building total)
 * @param {object} opts   — timeouts/injection for tests: districts,
 *                         fetchText, now (DBPR leg), timeoutMs, maxSearches,
 *                         anthropicClient (web-search leg)
 * @returns {Promise<{value:number, source:string, confidence:string,
 *   businessName:string|null, businessType:string|null, evidence:array,
 *   seats?:number}|null>}
 */
async function resolveCommercialSuiteSize(input = {}, opts = {}) {
  const {
    address = {}, phone = null, businessNameHint = null,
    commercialRiskType = null, commercialSubtype = null, buildingSqft = null,
  } = input;

  let businessName = businessNameHint || null;
  let businessType = null;

  try {
    const dbpr = await resolveViaDbprLicense({ address, phone, businessNameHint }, opts);
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

  // skipWebSearch: the manual lookup tool's fast CACHED-rebuild path uses
  // this to keep a cache hit cheap — the DBPR leg is fine there (cached
  // in-process for 24h), but a multi-second Claude web-search call on every
  // cache hit would defeat the point of caching. The FRESH lookup (already
  // a multi-second, multi-provider call) and the estimator engine both run
  // the full leg.
  if (!opts.skipWebSearch) {
    try {
      const web = await resolveViaWebSearch({
        address, businessNameHint, buildingSqft, commercialRiskType, commercialSubtype,
      }, opts);
      if (web) {
        businessName = businessName || web.businessName || null;
        businessType = businessType || web.businessType || null;
        if (Number(web.value) > 0) {
          return {
            value: web.value,
            source: SOURCES.COMMERCIAL_LISTING,
            // Medium, not high: the size rests on a quote the MODEL reports
            // from a page we did not fetch ourselves.
            confidence: 'medium',
            businessName: web.businessName || businessName,
            businessType: web.businessType || businessType,
            evidence: web.evidence,
          };
        }
      }
    } catch (err) {
      logger.warn(`[commercial-suite-size] web-search leg errored: ${err.message}`);
    }
  }

  const value = defaultSuiteSqftFor({ commercialRiskType, commercialSubtype, businessType });
  const businessTypeLabel = businessType || commercialRiskType || commercialSubtype || 'this business type';
  return {
    value,
    source: SOURCES.SUITE_TYPE_DEFAULT,
    confidence: 'low',
    businessName,
    businessType,
    evidence: [{
      source: SOURCES.SUITE_TYPE_DEFAULT,
      detail: `no suite-specific measurement found — defaulted to ${value.toLocaleString()} sq ft for ${businessTypeLabel}`,
    }],
  };
}

module.exports = {
  SOURCES,
  resolveCommercialSuiteSize,
};
