'use strict';

/**
 * Estimator-engine half of the business-identity scope question
 * (address-match PR 5-1, GATE_LOOKUP_BUSINESS_IDENTITY). Owner ruling: Google
 * Places may only SUGGEST on screen; nothing derived from it is saved, and
 * only what staff confirmed is stored. The engine drafts calls with no human
 * in the loop, so it can never apply a Places conclusion. When the lookup
 * says a business is listed at the address and the scope is still open
 * (`scope_unresolved`), the engine can only say "a human must confirm":
 *
 *  - the call itself already typed the lead commercial: red lane, cause
 *    `commercial_scope_unresolved`, the reason carries the scope question
 *    ("just your space or the whole building?");
 *  - the call says the caller LIVES there: the lead stays residential, the
 *    question is dropped, and one yellow review reason asks staff to confirm;
 *  - otherwise (residential lead, nothing says they live there): the lead is
 *    NOT promoted to commercial. Red lane, same cause, reason asks staff to
 *    confirm in Property Lookup whether the customer is that business and
 *    whether the job is just their space or the whole building.
 *
 * No business name, type or tenant count is read or stored here. Pure and
 * deterministic; every function is inert without a verdict, so a gate-off
 * draft is byte-identical. Only used when the lookup describes the gathered
 * address (the caller passes parcelOk, the engine's effectiveParcelOk).
 */

const SCOPE_UNRESOLVED = 'scope_unresolved';
const REASON_SCOPE_UNRESOLVED = 'commercial_scope_unresolved';

const DEFAULT_QUESTION = 'ask the customer whether this is just their space or the whole building';
const CONFIRM_REASON = `${REASON_SCOPE_UNRESOLVED}: an operating business may be at this address — confirm in Property Lookup whether the customer is that business, and whether the job is just their space or the whole building — no price until it is answered`;
const KEPT_RESIDENTIAL_REASON = 'a business may be listed at this address but the caller says they live here — kept residential, confirm';

// The lookup's open scope question, or null when it carries none (gate off, no
// business listed, a lookup that does not describe the gathered address, or
// any decision other than "unresolved" — the engine never applies one).
function lookupBusinessScope(enriched, parcelOk) {
  if (!parcelOk || !enriched) return null;
  if (enriched.serviceScopeDecision !== SCOPE_UNRESOLVED) return null;
  return { decision: SCOPE_UNRESOLVED, question: enriched.serviceScopeQuestion || null };
}

// The call itself says the caller LIVES at the service address: the
// extraction's own property-role fields (service_address_is_primary_residence
// true, or occupancy owner_occupied — "we live here" — or seasonal — "our
// winter place", a home that is not the caller's main one, so the primary
// residence field is false for it). A relationship like owner or tenant says
// nothing about living there (a business owner is an owner), so it never
// counts.
const LIVES_THERE_OCCUPANCIES = new Set(['owner_occupied', 'seasonal']);

function callerLivesAtAddress(extraction) {
  const property = extraction?.property || {};
  return property.service_address_is_primary_residence === true
    || LIVES_THERE_OCCUPANCIES.has(property.service_address_occupancy);
}

/**
 * Decide what the engine does with an open business-scope question. Never
 * changes the intent (no promotion to commercial): a human confirms.
 * On a cross-property re-gather the primary call's extraction describes a
 * different property, so it cannot say the caller lives HERE.
 * @returns {{decision, question, keptResidential, needsConfirmation}|null}
 */
function applyBusinessCommercialVerdict({ intent, enriched, parcelOk, extraction, crossProperty = false }) {
  const scope = lookupBusinessScope(enriched, parcelOk);
  if (!scope || !intent) return null;
  // The call already typed the lead commercial: the question goes to the CSR.
  if (intent.is_commercial === true) {
    return { decision: SCOPE_UNRESOLVED, question: scope.question, keptResidential: false, needsConfirmation: false };
  }
  if (callerLivesAtAddress(crossProperty ? null : extraction)) {
    return { decision: null, question: null, keptResidential: true, needsConfirmation: false };
  }
  return { decision: SCOPE_UNRESOLVED, question: null, keptResidential: false, needsConfirmation: true };
}

// Stamp the verdict onto the facts the lane classifier reads; a missing
// verdict leaves the facts untouched (no key added).
function stampBusinessScope(propertyFacts, verdict) {
  if (propertyFacts && verdict) propertyFacts.businessScope = verdict;
  return propertyFacts;
}

// The red verdict for an open scope: no draft price until staff confirm.
function scopeUnresolvedVerdict(propertyFacts) {
  const scope = propertyFacts?.businessScope;
  if (scope?.decision !== SCOPE_UNRESOLVED) return null;
  const reason = scope.needsConfirmation
    ? CONFIRM_REASON
    : `${REASON_SCOPE_UNRESOLVED}: ${scope.question || DEFAULT_QUESTION} — no price until it is answered`;
  return { reasons: [reason], causes: [REASON_SCOPE_UNRESOLVED] };
}

// Yellow review reasons the business verdict adds to a draft.
function businessReviewReasons(propertyFacts) {
  return propertyFacts?.businessScope?.keptResidential ? [KEPT_RESIDENTIAL_REASON] : [];
}

// The lookup profile as the engine may hold it. A draft is stored, and
// Google's Places policies allow storing a place ID and nothing else, so the
// listing the lookup put on the profile for the admin screen (the business,
// the suggested scope, flags resting on the listing) is dropped before the
// engine reads it. The open-scope marker stays: it is what turns the lane
// red. Returns the same object when there is nothing to drop.
function withoutBusinessListing(enriched) {
  if (!enriched || typeof enriched !== 'object') return enriched;
  if (!('businessIdentity' in enriched) && !('serviceScopeSuggestion' in enriched)) return enriched;
  const { businessIdentity: _identity, serviceScopeSuggestion: _suggestion, ...rest } = enriched;
  if (Array.isArray(rest.fieldVerifyFlags)) {
    rest.fieldVerifyFlags = rest.fieldVerifyFlags.filter((f) => f?.source !== 'google_places');
  }
  return rest;
}

module.exports = {
  withoutBusinessListing,
  REASON_SCOPE_UNRESOLVED,
  lookupBusinessScope,
  callerLivesAtAddress,
  applyBusinessCommercialVerdict,
  stampBusinessScope,
  scopeUnresolvedVerdict,
  businessReviewReasons,
};
