/**
 * Every production caller of performPropertyLookup, and its ONE scope
 * decision (address-match round 1, PR 7). The lookup's commercial-suite leg
 * — the suite / whole-building question (GATE_LOOKUP_BUSINESS_IDENTITY), the
 * suite size from a license or a listing (GATE_COMMERCIAL_SUITE_SIZING,
 * GATE_LOOKUP_LISTING_SIZE) — is OPT-IN per caller (`commercialSuiteSizing:
 * true`, the #4840 rule): a caller that does not opt in gets the ordinary
 * lookup, no business identity, no suite candidate, no scope question, and
 * its response is stripped of the parent-parcel context.
 *
 * The decision lives HERE, once, so a reader can see every surface at a
 * glance and a new caller has to declare itself: lookup-callers-guard.test.js
 * fails when a performPropertyLookup call site in server/ does not pass
 * through lookupOptionsFor(). Direct callers of lookupPropertyFromAITrio
 * (the record trio, no profile) are listed too, for the same reason.
 *
 *   suiteSizing: true   the surface can ASK and ANSWER the scope question
 *                       (buttons, or the engine's own composer verdict)
 *   suiteSizing: false  everything else: no way to answer, a public or
 *                       customer surface (never priced on a Places listing),
 *                       or a cache warm whose consumer decides for itself
 */

// `file`: the ONE production file that may use this id (relative to server/).
// The guard test fails when an id is used anywhere else, so a new surface
// cannot borrow another caller's decision.
const CALLERS = Object.freeze({
  // Staff, can answer: the admin estimate tool's own lookup route (occupancy
  // buttons on the panel; wholeProperty for an association job).
  admin_estimate_tool: { surface: 'staff', suiteSizing: true, file: 'routes/property-lookup-v2.js', why: 'the panel asks and answers the scope question' },
  // Automation that drafts a priced estimate from a call: the composer's own
  // commercial verdict answers for it, and an unresolved scope goes red.
  estimator_engine: { surface: 'automation', suiteSizing: true, file: 'services/estimator-engine/index.js', why: 'the engine answers scope from the call and refuses to price an unresolved one' },
  // Staff, but no answer surface: the legacy GET lookup route (no client
  // reads it today) and the Intelligence Bar's lookup tool. A suite question
  // raised here could not be answered, and its 409 at pricing would block
  // the bar. Suite sizing stays with the admin estimate tool.
  admin_lookup_get: { surface: 'staff', suiteSizing: false, file: 'routes/admin-property-lookup.js', why: 'no answer surface' },
  intelligence_bar_lookup: { surface: 'staff', suiteSizing: false, file: 'services/intelligence-bar/estimate-tools.js', why: 'no answer surface; suite sizing is the estimate tool\'s' },
  // Staff editor for lawn / bed / tree areas: the building is not what it
  // measures.
  property_service_areas: { surface: 'staff', suiteSizing: false, file: 'services/property-service-areas.js', why: 'area editor; building size is not read' },
  // Cache warm after a call: the engine opts in itself when it runs.
  call_cache_warm: { surface: 'automation', suiteSizing: false, file: 'services/call-property-lookup.js', why: 'warms the shared cache; the consumer decides' },
  // Customer-facing: the website quote and lookup, the portal / chat pricing,
  // the service report cross-sell and its warm. Never a Places listing, never
  // a suite size (#4840: public surfaces keep the ordinary lookup).
  public_property_lookup: { surface: 'public', suiteSizing: false, file: 'routes/public-property-lookup.js', why: 'customer surface' },
  public_quote: { surface: 'public', suiteSizing: false, file: 'routes/public-quote.js', why: 'customer surface, cache-only' },
  customer_pricing_ai: { surface: 'customer', suiteSizing: false, file: 'services/customer-pricing-ai.js', why: 'customer self-quote' },
  report_cross_sell: { surface: 'customer', suiteSizing: false, file: 'services/service-report/cross-sell.js', why: 'customer report, cache-only' },
  report_cross_sell_prewarm: { surface: 'automation', suiteSizing: false, file: 'services/service-report/evidence-prewarm.js', why: 'warms the cross-sell cache for a customer report' },
});

// Direct callers of lookupPropertyFromAITrio (the raw record trio, no
// enriched profile, no suite leg): WDO intelligence prompts that read home
// facts only. Listed so the guard can tell a declared bypass from a new one.
const TRIO_CALLERS = Object.freeze({
  'routes/admin-projects.js': 'WDO project intelligence prompt: home facts only, no price',
  'services/appointment-tagger.js': 'WDO appointment tagger: home facts only, no price',
});

/**
 * The lookup options for a declared caller. `extra` carries the caller's
 * own flags (refresh, cacheOnly, persist, prioritizeAccuracy, occupancy…);
 * the scope decision is never overridable from a call site.
 */
function lookupOptionsFor(callerId, extra = {}) {
  const caller = CALLERS[callerId];
  if (!caller) throw new Error(`unknown property-lookup caller: ${callerId}`);
  const { commercialSuiteSizing: _ignored, ...rest } = extra;
  return caller.suiteSizing ? { ...rest, commercialSuiteSizing: true } : rest;
}

module.exports = { CALLERS, TRIO_CALLERS, lookupOptionsFor };
