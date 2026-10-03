'use strict';

/**
 * Estimator-engine half of the business-identity scope decision
 * (address-match PR 5-1, GATE_LOOKUP_BUSINESS_IDENTITY). The property lookup
 * (routes/property-lookup-v2.js) already decided suite / whole building /
 * ask-the-CSR from Google Places; this module reads that verdict off the
 * lookup's profile and turns it into the three things the draft pipeline needs:
 *
 *  - a business-identified suite counts as unit occupancy + part-building
 *    evidence for the unit-scope model and the V2 scope inference;
 *  - an unanswered scope (`scope_unresolved`) blocks the draft price: the lane
 *    goes red with reason `commercial_scope_unresolved` and the question for
 *    the CSR or agent, never an auto-draft, never a guessed size;
 *  - a matched operating business at the address makes the lead commercial,
 *    unless the call positively says the caller LIVES there.
 *
 * Pure and deterministic; every function is inert without a business verdict,
 * so a gate-off draft is byte-identical. Only used when the lookup describes
 * the gathered address (the caller passes parcelOk, the engine's
 * effectiveParcelOk).
 */

const BUSINESS_DETECTION_SOURCE = 'google_places_business';
const SCOPE_SUITE = 'commercial_suite';
const SCOPE_UNRESOLVED = 'scope_unresolved';
const REASON_SCOPE_UNRESOLVED = 'commercial_scope_unresolved';

// The lookup's business verdict, or null when it carries none (gate off, no
// identity, a lookup that does not describe the gathered address).
function lookupBusinessScope(enriched, parcelOk) {
  if (!parcelOk || !enriched) return null;
  const decision = enriched.serviceScopeDecision || null;
  const commercial = enriched.commercialDetectionSource === BUSINESS_DETECTION_SOURCE;
  if (!decision && !commercial) return null;
  return { decision, question: enriched.serviceScopeQuestion || null, commercial };
}

// The call itself says the caller LIVES at the service address: the
// extraction's own property-role fields (service_address_is_primary_residence
// true, or occupancy owner_occupied — "we live here"). A relationship like
// owner or tenant says nothing about living there (a business owner is an
// owner), so it never counts.
function callerLivesAtAddress(extraction) {
  const property = extraction?.property || {};
  return property.service_address_is_primary_residence === true
    || property.service_address_occupancy === 'owner_occupied';
}

/**
 * Apply the lookup's business verdict to the draft intent. A matched
 * operating business at the address plus a commercial-sounding lead is
 * commercial: `intent.is_commercial` is set so the draft enters the
 * commercial / suite path (flagged for review by classifyLane, never
 * auto-booked). If the call positively says the caller lives there, the
 * intent stays residential, the scope question is dropped (it is a business
 * question), and a review flag is added instead.
 * @returns {{decision, question, promoted, keptResidential}|null}
 */
function applyBusinessCommercialVerdict({ intent, enriched, parcelOk, extraction, crossProperty = false }) {
  const scope = lookupBusinessScope(enriched, parcelOk);
  if (!scope || !intent) return null;
  const needsPromotion = scope.commercial && intent.is_commercial !== true;
  // On a cross-property re-gather the primary call's extraction describes a
  // different property, so it cannot say the caller lives HERE.
  const keptResidential = needsPromotion && callerLivesAtAddress(crossProperty ? null : extraction);
  const promoted = needsPromotion && !keptResidential;
  if (promoted) intent.is_commercial = true;
  const commercialNow = intent.is_commercial === true;
  return {
    decision: commercialNow ? scope.decision : null,
    question: commercialNow ? scope.question : null,
    promoted,
    keptResidential,
  };
}

// Stamp the verdict onto the facts the lane classifier reads; a missing
// verdict leaves the facts untouched (no key added).
function stampBusinessScope(propertyFacts, verdict) {
  if (propertyFacts && verdict) propertyFacts.businessScope = verdict;
  return propertyFacts;
}

// A business-identified suite stands in for the unit signal AND the
// part-building evidence inferServiceScope needs; anything else passes the
// signals through unchanged.
function businessSuiteSignals({ unitSignal, partBuilding }, businessScope) {
  const suite = businessScope?.decision === SCOPE_SUITE;
  return { unitSignal: unitSignal || suite, partBuilding: partBuilding || suite };
}

// The red verdict for an unanswered scope: no draft price until the CSR says
// whether the job is just the space or the whole building.
function scopeUnresolvedVerdict(propertyFacts) {
  const scope = propertyFacts?.businessScope;
  if (scope?.decision !== SCOPE_UNRESOLVED) return null;
  return {
    reasons: [`${REASON_SCOPE_UNRESOLVED}: ${scope.question || 'ask the customer whether this is just their space or the whole building'} — no price until it is answered`],
    causes: [REASON_SCOPE_UNRESOLVED],
  };
}

// Yellow review reasons a business-derived classification adds to a draft.
function businessReviewReasons(propertyFacts) {
  const scope = propertyFacts?.businessScope;
  if (scope?.promoted) {
    return ['marked commercial because Google lists an operating business at this address — confirm the customer is the business, not a resident'];
  }
  if (scope?.keptResidential) {
    return ['Google lists an operating business at this address but the caller says they live here — kept residential, confirm'];
  }
  return [];
}

module.exports = {
  BUSINESS_DETECTION_SOURCE,
  REASON_SCOPE_UNRESOLVED,
  lookupBusinessScope,
  callerLivesAtAddress,
  applyBusinessCommercialVerdict,
  stampBusinessScope,
  businessSuiteSignals,
  scopeUnresolvedVerdict,
  businessReviewReasons,
};
