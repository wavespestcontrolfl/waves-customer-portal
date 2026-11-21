// The property lookup of the plan start offer (buildStartOffer in
// cross-sell.js; the one-time job to plan offer, owner 2026-11-19). It has
// its own file because lookup-callers.js binds one caller to one file: the
// start offer is priced by a job with nobody watching, and it must not run
// under the report card's entry (report_cross_sell).
//
// CACHE-ONLY, like the card's lookup: the live pipeline (geocode + satellite
// + AI vision) never runs here, and nothing is stored. STRICT cache reads: a
// failed cache or correction read is THROWN (LOOKUP_CACHE_READ_FAILED). The
// card's form answers a failed correction read as "no corrections" and
// serves the cached home without them. A report view may degrade that way,
// with a person looking at it. A job that prices alone must stop instead.
async function strictCacheOnlyPropertyLookup(address) {
  // Lazy-required — property-lookup-v2 is heavy and cyclic-prone.
  const { performPropertyLookup } = require('../../routes/property-lookup-v2');
  // Scope decision: lookup-callers.js (plan_start_offer).
  const { lookupOptionsFor } = require('../property-lookup/lookup-callers');
  return performPropertyLookup(address, lookupOptionsFor('plan_start_offer', { cacheOnly: true, persist: false, strictCacheReads: true }));
}

module.exports = { strictCacheOnlyPropertyLookup };
