'use strict';

/**
 * Business identity → scope decision (address-match PR 5, dark behind
 * GATE_LOOKUP_BUSINESS_IDENTITY).
 *
 * Pure functions only: given what Places said about the address
 * (./business-identity.js) and what the lookup already knows (typed unit,
 * county part-building evidence, own-unit folio, association job), decide
 * whether the customer occupies ONE SUITE, the WHOLE BUILDING, or whether
 * that is still an open question for the CSR. No network, no model, no
 * clock — the lookup (routes/property-lookup-v2.js) and the estimator engine
 * both consume the same verdict so they cannot disagree.
 *
 * Owner rulings carried here: Google Places only SUGGESTS. Its listing never
 * changes the profile by itself: the lookup asks "Are we treating just your
 * space or the whole building?" and there is NO price until staff answer
 * (suite / building / none — "not this business"). Only a staff answer makes
 * the lookup commercial, sets the business's type and decides the scope, so
 * everything that is saved is what staff confirmed. A suite is priced by the
 * suite's size, never the building's.
 */

const SCOPE = Object.freeze({
  SUITE: 'commercial_suite',
  BUILDING: 'entire_commercial_building',
  UNRESOLVED: 'scope_unresolved',
});

const OCCUPANCY_QUESTION = 'Are we treating just your space or the whole building?';
// The detection source of a lookup staff confirmed as the listed business.
const BUSINESS_DETECTION_SOURCE = 'staff_confirmed_business';
// 'none' = staff say the customer is not the listed business.
const OCCUPANCY_ANSWERS = Object.freeze(['suite', 'building', 'none']);

function normalizeOccupancyAnswer(value) {
  const v = String(value || '').trim().toLowerCase();
  return OCCUPANCY_ANSWERS.includes(v) ? v : null;
}

// A business is identified when exactly one operating place matched the
// street number, or several share the number (a multi-tenant address with no
// single match — the tenants-at-number signal below still applies).
function businessIdentified(identity) {
  if (!identity || typeof identity !== 'object') return false;
  return Boolean(identity.matched) || (Number(identity.tenantsAtNumber) >= 2);
}

// Which signal part-building evidence rests on, for the admin field only.
function matchedBy(identity, typedSubpremise) {
  if (!businessIdentified(identity)) return null;
  if (!identity.matched) return 'ambiguous_tenants';
  return (typedSubpremise || identity.matched.subpremise) ? 'subpremise' : 'street_number';
}

// What the signals point to, shown to staff as a hint next to the question
// and never applied: one space of a shared building, a stand-alone building,
// or nothing either way. Neighbors alone never suggest a suite (a
// stand-alone outparcel has neighbors too).
function suggestScope({ identity, typedSubpremise, countyPartBuildingEvidence, countyRecordPresent }) {
  if (typedSubpremise || identity.matched?.subpremise || Number(identity.tenantsAtNumber) >= 2
    || countyPartBuildingEvidence === true) return 'suite';
  if (countyRecordPresent && Number(identity.neighbors) === 0) return 'building';
  return null;
}

/**
 * @param {object} p
 *   identity                    — buildBusinessIdentity() output, or null
 *   typedSubpremise             — the address names a suite/unit/bay
 *   countyPartBuildingEvidence  — shadowHasPartBuildingEvidence on the county record
 *   countyRecordPresent         — a county/cadastral record vouches for the address
 *   ownUnitFolio                — a non-aggregated condo: the record already measures the unit
 *   association                 — an association/common-area job (never one suite)
 *   occupancyAnswer             — staff's answer: 'suite' | 'building' | 'none' | null
 * @returns {{decision: string|null, question: string|null, suggestion: string|null}|null}
 *   null = no business scope applies; decision null = staff said "not this business"
 */
function resolveBusinessScope({
  identity = null,
  typedSubpremise = false,
  countyPartBuildingEvidence = false,
  countyRecordPresent = false,
  ownUnitFolio = false,
  association = false,
  occupancyAnswer = null,
} = {}) {
  if (!businessIdentified(identity) || association || ownUnitFolio) return null;
  const answer = normalizeOccupancyAnswer(occupancyAnswer);
  if (answer === 'building') return { decision: SCOPE.BUILDING, question: null, suggestion: null };
  if (answer === 'suite') return { decision: SCOPE.SUITE, question: null, suggestion: null };
  if (answer === 'none') return { decision: null, question: null, suggestion: null };
  return {
    decision: SCOPE.UNRESOLVED,
    question: OCCUPANCY_QUESTION,
    suggestion: suggestScope({ identity, typedSubpremise, countyPartBuildingEvidence, countyRecordPresent }),
  };
}

// ── Lookup-facing helpers ───────────────────────────────────────────

// A stable key for the unit a business identifies, so a persisted suite
// stamp is reused for the same business only. Null when there is no
// business-identified unit.
function businessUnitKey(identity) {
  if (identity?.matched?.placeId) return `business:${identity.matched.placeId}`;
  if (identity?.tenantPlaceKey) return `business:tenants:${identity.tenantPlaceKey}`;
  return null;
}

const GENERIC_SUBTYPES = new Set(['', 'other', 'office_retail']);

// The residential record types a Places hit must not override: a house with
// a home business pinned at its street number is still a house. These are the
// pricing engine's own residential property types (commercial-helpers.js
// normalizePropertyType); an unknown or empty type does not block, since the
// no-county-record case is exactly where the record says nothing.
const RESIDENTIAL_PRICING_TYPES = new Set([
  'single_family', 'townhome_end', 'townhome_interior', 'duplex', 'condo_ground', 'condo_upper',
]);

// The other residential whole structures the lookup recognizes but the
// pricing normalizer passes through under their own name (the unit-scope
// model's whole-structure vocabulary): a mobile or manufactured home, a
// villa, a triplex or a quadplex is a residence too.
const RESIDENTIAL_STRUCTURE_RE = /single_?family|duplex|triplex|quadplex|townhou|town_?home|villa|mobile_?home|manufactured/;

function recordBlocksCommercialFlip(recordPricingType) {
  const type = String(recordPricingType || '').toLowerCase().replace(/[\s-]+/g, '_');
  return RESIDENTIAL_PRICING_TYPES.has(type) || RESIDENTIAL_STRUCTURE_RE.test(type);
}

/**
 * The classification half, applied ONLY once staff confirmed the customer is
 * the listed business (`confirmed`: the suite or building answer): a
 * non-commercial lookup becomes COMMERCIAL (source staff_confirmed_business)
 * and a generic commercial subtype is refined to the business's type. With
 * no confirmation the base verdicts stand. Pure.
 */
function applyBusinessClassification({
  identity, baseCategory, baseSubtype, recordPricingType = null, confirmed = false,
}) {
  const type = identity?.matched?.type || identity?.ambiguousType || null;
  const base = { category: baseCategory, subtype: baseSubtype, flipped: false, refined: false };
  if (!confirmed || !businessIdentified(identity) || !type) return base;
  if (baseCategory === 'COMMERCIAL') {
    const refine = GENERIC_SUBTYPES.has(String(baseSubtype || '')) && type !== 'office_retail';
    return refine ? { ...base, subtype: type, refined: true } : base;
  }
  if (recordBlocksCommercialFlip(recordPricingType)) return base;
  return { category: 'COMMERCIAL', subtype: type, flipped: true, refined: false };
}

// Marks a flag as resting on the Places listing, so storage and the pricing
// call can drop it (nothing from Places is saved).
const PLACES_FLAG_SOURCE = 'google_places';

function scopeFlags(scope) {
  if (!scope) return [];
  if (scope.decision === SCOPE.UNRESOLVED) {
    return [{
      field: 'squareFootage',
      reason: `${scope.question} Square footage is not priced until this is answered — the building's and the satellite's size are not this business's space.`,
      priority: 'HIGH',
      source: PLACES_FLAG_SOURCE,
    }];
  }
  if (scope.decision === SCOPE.SUITE) {
    return [{
      field: 'squareFootage',
      reason: 'Sized as ONE suite, as staff answered (by the business type, not the building) — confirm the space\'s square footage on site.',
      priority: 'MEDIUM',
    }];
  }
  return [];
}

// The admin-only profile keys; {} unless a business scope applies, so a
// gate-off profile gains none. `businessIdentity` and the suggestion are for
// THIS response's screen only — storage and the pricing call drop them.
function adminProfileFields(identity, scope, typedSubpremise, occupancyAnswer) {
  if (!scope) return {};
  return {
    serviceScopeDecision: scope.decision,
    serviceScopeQuestion: scope.question,
    serviceScopeSuggestion: scope.suggestion,
    // Staff's answer rides the profile into the estimate inputs, so the
    // pricing boundary and the save-time recompute both see it.
    occupancyAnswer: normalizeOccupancyAnswer(occupancyAnswer),
    businessIdentity: {
      name: identity.matched?.name || null,
      type: identity.matched?.type || identity.ambiguousType || null,
      matchedBy: matchedBy(identity, typedSubpremise),
      tenantsAtNumber: Number(identity.tenantsAtNumber) || 0,
      unitKey: businessUnitKey(identity),
    },
  };
}

// The CSR answered the scope question, but the re-run could not reach Places
// to confirm the business the answer is about. The answer cannot be applied
// to an unknown business and must not be dropped either (that would restore
// whole-building sizing and unblock pricing), so the question stays open: no
// price until an answered lookup succeeds. Classification is left alone.
const UNAVAILABLE_IDENTITY = Object.freeze({ unavailable: true });
const UNCONFIRMED_SCOPE_REASON = `Could not confirm the business at this address just now, so the answer was not applied. ${OCCUPANCY_QUESTION} Answer again to retry — square footage is not priced until then.`;

function unconfirmedScopeContext(baseCategory, baseSubtype) {
  return {
    active: false,
    category: baseCategory,
    subtype: baseSubtype,
    flipped: false,
    decision: SCOPE.UNRESOLVED,
    question: OCCUPANCY_QUESTION,
    unitKey: null,
    source: (base) => base,
    flags: [{ field: 'squareFootage', reason: UNCONFIRMED_SCOPE_REASON, priority: 'HIGH', source: PLACES_FLAG_SOURCE }],
    profileFields: {
      serviceScopeDecision: SCOPE.UNRESOLVED,
      serviceScopeQuestion: OCCUPANCY_QUESTION,
      serviceScopeSuggestion: null,
      occupancyAnswer: null,
    },
  };
}

/**
 * The whole business-scope context the profile builder consumes, in one pure
 * call. `active` is false (and every field inert) unless an identity arrived,
 * so a gate-off lookup is byte-identical.
 */
function buildBusinessScopeContext({
  identity = null,
  baseCategory,
  baseSubtype,
  recordPricingType = null,
  scopeSignals = {},
  occupancyAnswer = null,
}) {
  if (identity?.unavailable === true) return unconfirmedScopeContext(baseCategory, baseSubtype);
  // A record that positively says "residence" is never asked about: a house
  // with a home business pinned at its number is still a house.
  const askable = baseCategory === 'COMMERCIAL' || !recordBlocksCommercialFlip(recordPricingType);
  const scope = askable ? resolveBusinessScope({ ...scopeSignals, identity, occupancyAnswer }) : null;
  const confirmed = scope?.decision === SCOPE.SUITE || scope?.decision === SCOPE.BUILDING;
  const classification = applyBusinessClassification({
    identity, baseCategory, baseSubtype, recordPricingType, confirmed,
  });
  return {
    active: Boolean(scope),
    category: classification.category,
    subtype: classification.subtype,
    flipped: classification.flipped,
    decision: scope?.decision || null,
    question: scope?.question || null,
    unitKey: scope ? businessUnitKey(identity) : null,
    // The detection source a staff-confirmed flip reports; a record-typed
    // commercial lookup keeps its own source.
    source: (base) => (classification.flipped ? BUSINESS_DETECTION_SOURCE : base),
    flags: scopeFlags(scope),
    profileFields: adminProfileFields(identity, scope, scopeSignals.typedSubpremise, occupancyAnswer),
  };
}

// The suite unit key for a stamp: a business-identified unit with no typed
// unit keys on the matched place; otherwise the typed unit as before.
function effectiveSuiteUnitKey(typedUnitKey, businessScope) {
  if (typedUnitKey) return typedUnitKey;
  return businessScope?.decision === SCOPE.SUITE ? (businessScope.unitKey || null) : null;
}

// The pricing-boundary refusal for a profile whose scope is still the open
// question (any listed business staff have not answered about): a 409 the calculation route returns and the save-time recompute
// rethrows (failClosed). An answered profile (the lookup re-run with the
// CSR's occupancy answer, or the answer stamped on the profile) passes.
// Returns the error to throw, or null.
function unresolvedScopeError(profile) {
  if (profile?.serviceScopeDecision !== SCOPE.UNRESOLVED) return null;
  if (normalizeOccupancyAnswer(profile.occupancyAnswer)) return null;
  const question = profile.serviceScopeQuestion || OCCUPANCY_QUESTION;
  const err = new Error(`${question} Answer it in Property Lookup before pricing this address.`);
  err.statusCode = 409;
  err.code = 'COMMERCIAL_SCOPE_UNRESOLVED';
  err.metadata = { question };
  // A rejection, not engine breakage: the save-time recompute rethrows it
  // rather than falling back to the browser's price.
  err.failClosed = true;
  return err;
}

function assertScopeAnswered(profile) {
  const err = unresolvedScopeError(profile);
  if (err) throw err;
}

module.exports = {
  SCOPE,
  unresolvedScopeError,
  assertScopeAnswered,
  OCCUPANCY_QUESTION,
  UNAVAILABLE_IDENTITY,
  PLACES_FLAG_SOURCE,
  BUSINESS_DETECTION_SOURCE,
  normalizeOccupancyAnswer,
  businessIdentified,
  resolveBusinessScope,
  applyBusinessClassification,
  buildBusinessScopeContext,
  businessUnitKey,
  effectiveSuiteUnitKey,
};
