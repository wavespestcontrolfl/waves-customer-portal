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
 * Owner rulings carried here: ambiguous occupancy asks "Are we treating just
 * your space or the whole building?" and NO price until it is answered; a
 * suite is priced by the suite's size, never the building's; neighbors alone
 * never decide a suite (a stand-alone outparcel has neighbors too).
 */

const SCOPE = Object.freeze({
  SUITE: 'commercial_suite',
  BUILDING: 'entire_commercial_building',
  UNRESOLVED: 'scope_unresolved',
});

const OCCUPANCY_QUESTION = 'Are we treating just your space or the whole building?';
const BUSINESS_DETECTION_SOURCE = 'google_places_business';
const OCCUPANCY_ANSWERS = Object.freeze(['suite', 'building']);

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

function suiteEvidence({ identity, typedSubpremise, countyPartBuildingEvidence, occupancyAnswer }) {
  return Boolean(typedSubpremise)
    || Boolean(identity.matched?.subpremise)
    || Number(identity.tenantsAtNumber) >= 2
    || countyPartBuildingEvidence === true
    || occupancyAnswer === 'suite';
}

/**
 * @param {object} p
 *   identity                    — buildBusinessIdentity() output, or null
 *   typedSubpremise             — the address names a suite/unit/bay
 *   countyPartBuildingEvidence  — shadowHasPartBuildingEvidence on the county record
 *   countyRecordPresent         — a county/cadastral record vouches for the address
 *   ownUnitFolio                — a non-aggregated condo: the record already measures the unit
 *   association                 — an association/common-area job (never one suite)
 *   occupancyAnswer             — the CSR's answer: 'suite' | 'building' | null
 * @returns {{decision: string, question: string|null}|null} null = no change
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
  // The CSR's explicit answer outranks every derived signal.
  if (answer === 'building') return { decision: SCOPE.BUILDING, question: null };
  if (suiteEvidence({ identity, typedSubpremise, countyPartBuildingEvidence, occupancyAnswer: answer })) {
    return { decision: SCOPE.SUITE, question: null };
  }
  // A county record that describes the building, with no multi-tenant
  // evidence and nobody else around: a stand-alone building.
  if (countyRecordPresent && Number(identity.neighbors) === 0) {
    return { decision: SCOPE.BUILDING, question: null };
  }
  return { decision: SCOPE.UNRESOLVED, question: OCCUPANCY_QUESTION };
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

const SUBTYPE_LABELS = Object.freeze({
  restaurant_food_service: 'a restaurant or food business',
  salon_spa: 'a salon or spa',
  medical_office: 'a medical or dental office',
  veterinary_clinic: 'a veterinary clinic',
  school_daycare: 'a school or daycare',
  office_retail: 'a business',
});

const GENERIC_SUBTYPES = new Set(['', 'other', 'office_retail']);

// The residential record types a Places hit must not override: a house with
// a home business pinned at its street number is still a house. These are the
// pricing engine's own residential property types (commercial-helpers.js
// normalizePropertyType); an unknown or empty type does not block, since the
// no-county-record case is exactly where the record says nothing.
const RESIDENTIAL_PRICING_TYPES = new Set([
  'single_family', 'townhome_end', 'townhome_interior', 'duplex', 'condo_ground', 'condo_upper',
]);

function recordBlocksCommercialFlip(recordPricingType) {
  return RESIDENTIAL_PRICING_TYPES.has(recordPricingType);
}

/**
 * The classification half: a matched business flips a non-commercial lookup
 * to COMMERCIAL (source google_places_business), and a generic commercial
 * subtype is refined to the business's type. Pure; the caller supplies the
 * base verdicts it already computed.
 */
function applyBusinessClassification({
  identity, baseCategory, baseSubtype, recordPricingType = null,
}) {
  const type = identity?.matched?.type || identity?.ambiguousType || null;
  const base = { category: baseCategory, subtype: baseSubtype, flipped: false, refined: false };
  if (!businessIdentified(identity) || !type) return base;
  if (baseCategory === 'COMMERCIAL') {
    const refine = GENERIC_SUBTYPES.has(String(baseSubtype || '')) && type !== 'office_retail';
    return refine ? { ...base, subtype: type, refined: true } : base;
  }
  if (recordBlocksCommercialFlip(recordPricingType)) return base;
  return { category: 'COMMERCIAL', subtype: type, flipped: true, refined: false };
}

function classificationFlags(classification) {
  if (!classification.flipped) return [];
  const label = SUBTYPE_LABELS[classification.subtype] || SUBTYPE_LABELS.office_retail;
  return [{
    field: 'propertyType',
    // Deliberately no business name: flag text reaches shared surfaces.
    reason: `Commercial: Google lists ${label} at this address — confirm`,
    priority: 'MEDIUM',
  }];
}

function scopeFlags(scope) {
  if (!scope) return [];
  if (scope.decision === SCOPE.UNRESOLVED) {
    return [{
      field: 'squareFootage',
      reason: `${scope.question} Square footage is not priced until this is answered — the building's and the satellite's size are not this business's space.`,
      priority: 'HIGH',
    }];
  }
  if (scope.decision === SCOPE.SUITE) {
    return [{
      field: 'squareFootage',
      reason: 'Sized as ONE suite from the business at this address (its type, not the building) — confirm the space\'s square footage on site.',
      priority: 'MEDIUM',
    }];
  }
  return [];
}

// The admin-only profile keys; {} unless a business was identified, so a
// gate-off profile gains none. The business NAME rides here only, never a
// flag (flag text reaches shared surfaces).
function adminProfileFields(identity, scope, typedSubpremise) {
  if (!businessIdentified(identity)) return {};
  return {
    serviceScopeDecision: scope?.decision || null,
    serviceScopeQuestion: scope?.question || null,
    businessIdentity: {
      name: identity.matched?.name || null,
      type: identity.matched?.type || identity.ambiguousType || null,
      matchedBy: matchedBy(identity, typedSubpremise),
      tenantsAtNumber: Number(identity.tenantsAtNumber) || 0,
      unitKey: businessUnitKey(identity),
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
  const classification = applyBusinessClassification({
    identity, baseCategory, baseSubtype, recordPricingType,
  });
  const scope = classification.category === 'COMMERCIAL'
    ? resolveBusinessScope({ ...scopeSignals, identity, occupancyAnswer })
    : null;
  return {
    active: businessIdentified(identity),
    category: classification.category,
    subtype: classification.subtype,
    flipped: classification.flipped,
    decision: scope?.decision || null,
    question: scope?.question || null,
    unitKey: businessIdentified(identity) ? businessUnitKey(identity) : null,
    // The detection source a flipped lookup reports; a record-typed
    // commercial lookup keeps its own source.
    source: (base) => (classification.flipped ? BUSINESS_DETECTION_SOURCE : base),
    flags: [...classificationFlags(classification), ...scopeFlags(scope)],
    profileFields: adminProfileFields(identity, scope, scopeSignals.typedSubpremise),
  };
}

// The suite unit key for a stamp: a business-identified unit with no typed
// unit keys on the matched place; otherwise the typed unit as before.
function effectiveSuiteUnitKey(typedUnitKey, businessScope) {
  if (typedUnitKey) return typedUnitKey;
  return businessScope?.decision === SCOPE.SUITE ? (businessScope.unitKey || null) : null;
}

module.exports = {
  SCOPE,
  OCCUPANCY_QUESTION,
  BUSINESS_DETECTION_SOURCE,
  normalizeOccupancyAnswer,
  businessIdentified,
  resolveBusinessScope,
  applyBusinessClassification,
  buildBusinessScopeContext,
  businessUnitKey,
  effectiveSuiteUnitKey,
};
