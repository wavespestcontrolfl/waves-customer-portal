/**
 * Estimator Engine — unit-scope classification model + fail-loud guardrails
 * (GATE_UNIT_SCOPE_GUARDRAILS, default OFF; engine-family env-gate pattern,
 * same value semantics as GATE_ESTIMATOR_SCOPE_GUARDS).
 *
 * Two live drafts motivated this module (2026-08-11 owner ruling):
 *  - A tenant in a 1BR apartment (rental complex, no per-unit county parcel)
 *    drafted with propertyType silently DEFAULTED to single_family and
 *    review noise about missing lot size — a unit has no individual lot by
 *    design, and a plausible-but-wrong classification prices confidently
 *    wrong where a visible "unknown" is observable and recoverable.
 *  - A commercial flex-suite lead (office + warehouse, address with NO
 *    street number) produced no property-lookup row at all and sat as a
 *    RESIDENTIAL draft — nothing flagged either failure.
 *
 * The model separates the questions the engine used to overload onto
 * propertyType + sqft:
 *
 *   propertyUse          — what the BUILDING is (single_family,
 *                          multifamily_rental, condominium, office,
 *                          industrial_flex, retail, unknown)
 *   serviceScope         — what the CUSTOMER is buying treatment for
 *                          (property-facts-v2 SERVICE_SCOPES vocabulary)
 *   customerRelationship — owner / tenant / property_manager / unknown
 *   sizeBasis            — provenance of the sqft the draft priced from
 *                          (source-arbitration SQFT_SOURCES vocabulary;
 *                          PR2 adds bedroom_band)
 *   lotApplicability     — private_parcel / common_master_parcel /
 *                          no_individual_lot / leased_land / unknown
 *
 * A multifamily building does NOT automatically mean commercial service:
 * a tenant treating the interior of one dwelling unit is a residential
 * customer. Commercial applies when the client is the association, complex
 * owner, or property manager — the whole-property verdict (detectCategory)
 * keeps answering that separate question.
 *
 * Everything here is pure and fail-open at the call sites: a model failure
 * must never sink a draft.
 */

const { lotApplicabilityFor } = require('../property-lookup/property-facts-v2');
const { _private: shadowPrivate } = require('./property-facts-shadow');

function unitScopeGuardrailsEnabled() {
  const flag = process.env.GATE_UNIT_SCOPE_GUARDRAILS;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// ── Address quality ─────────────────────────────────────────────

// A usable service address starts with a primary street NUMBER followed by
// more address text. Ordinal street NAMES ("48th Avenue East") deliberately
// fail: \d+ cannot be followed by a letter run ("48th" breaks on the 'h'),
// which is exactly the incomplete-address class that produced a quote-less
// silent lookup failure. Unit-letter house numbers ("123A Main St") and
// hyphenated ranges ("123-125 Main St") pass.
const PRIMARY_STREET_NUMBER_RE = /^\s*\d+[a-z]?(?:[-/]\w+)?\s+\S/i;

function hasPrimaryStreetNumber(address) {
  return PRIMARY_STREET_NUMBER_RE.test(String(address || ''));
}

// ── Category conflict (commercial signal on a residential draft) ─

// Structured extraction property types that positively describe a
// commercial premises. Kept to unambiguous nouns — 'multifamily' and
// 'apartment' are NOT here (a unit tenant is residential; the ≥5-unit
// whole-property rule lives in detectCategory).
const COMMERCIAL_EXTRACTION_TYPES = new Set([
  'office', 'industrial', 'warehouse', 'retail', 'commercial',
  'restaurant', 'storefront',
]);

// Free-text commercial signal for intake paths that carry prose instead of
// a structured type (lead webhook notes / call summaries). Conservative:
// premises nouns only, phrased as the caller's OWN premises — a residential
// caller merely mentioning their workplace must not trip it, so the nouns
// require an occupancy cue nearby ("my office" / "our warehouse" /
// "industrial building" / "office and warehouse" / "suite 101"…).
const COMMERCIAL_TEXT_RE = new RegExp(
  [
    '(?:my|our|the)\\s+(?:office|warehouse|shop|store|restaurant|clinic|storefront)\\b',
    'industrial\\s+(?:building|park|unit|space|suite)',
    'office\\s+(?:and|&|\\+)\\s+warehouse',
    'warehouse\\s+(?:and|&|\\+)\\s+office',
    'commercial\\s+(?:building|property|unit|space|suite|kitchen)',
    'retail\\s+(?:space|unit|store|plaza)',
    '\\bflex\\s+(?:space|unit|building)\\b',
    '\\bsuite\\s*#?\\s*\\d+\\w*\\b',
  ].join('|'),
  'i',
);

function commercialTextSignal(text) {
  return COMMERCIAL_TEXT_RE.test(String(text || ''));
}

// Engine-path conflict: the call extraction positively typed the premises
// commercial while the composed intent stayed residential. Returns the
// conflicting type (truthy) or null.
function commercialCategoryConflict({ extraction, intent }) {
  if (intent?.is_commercial === true) return null;
  const type = String(extraction?.property?.property_type || '').trim().toLowerCase();
  return COMMERCIAL_EXTRACTION_TYPES.has(type) ? type : null;
}

// ── Property use ────────────────────────────────────────────────

function resolvePropertyUse({ propertyType, landUseDescription, isCommercial, commercialSubtype }) {
  const text = [propertyType, landUseDescription, commercialSubtype]
    .filter(Boolean).join(' ').toLowerCase();
  if (/condo/.test(text)) return 'condominium';
  if (/apartment|multi.?family/.test(text)) return 'multifamily_rental';
  if (/industrial|warehouse|flex/.test(text)) return 'industrial_flex';
  if (/office|medical|clinic/.test(text)) return 'office';
  if (/retail|storefront|plaza|restaurant|shop\b/.test(text)) return 'retail';
  if (/single|townho|duplex|triplex|quadplex|villa|mobile|manufactured|house|home\b/.test(text)) {
    return 'single_family';
  }
  if (isCommercial) return 'unknown';
  return text ? 'single_family' : 'unknown';
}

// ── Relationship ────────────────────────────────────────────────

function resolveCustomerRelationship(extraction) {
  const rel = String(extraction?.caller?.relationship_to_property || '').trim().toLowerCase();
  if (rel === 'tenant' || rel === 'renter' || rel === 'lessee') return 'tenant';
  if (rel === 'owner' || rel === 'homeowner') return 'owner';
  if (/property.?manager|manager|management/.test(rel)) return 'property_manager';
  return 'unknown';
}

// ── The model ───────────────────────────────────────────────────

/**
 * Compose the unit-scope model from signals the engine already gathered.
 * Pure; never throws on missing inputs (every field degrades to 'unknown').
 */
function resolveUnitScopeModel({ propertyRecord, extraction, intent, propertyFacts, address }) {
  const isCommercial = intent?.is_commercial === true;
  const tenant = propertyFacts?.tenant === true
    || resolveCustomerRelationship(extraction) === 'tenant';
  const parcel = propertyRecord?._parcel || {};
  const aggregated = parcel.aggregated === true;
  const propertyType = propertyRecord?.propertyType
    || extraction?.property?.property_type
    || propertyFacts?.propertyType
    || null;

  const unitSignal = shadowPrivate.hasUnitSignal({
    tenant,
    address: address || propertyRecord?.formattedAddress || intent?.address,
    extraction,
  });
  const serviceScope = shadowPrivate.inferServiceScope({
    propertyType, isCommercial, tenant, aggregated, unitSignal,
  });
  const ownershipType = shadowPrivate.inferOwnershipType({
    propertyType, isCommercial, tenant, aggregated, unitSignal,
  });

  // propertyFacts.tenant came from the same extraction field; keep the two
  // consistent when the string variant wasn't recognized.
  const relationship = resolveCustomerRelationship(extraction);
  return {
    propertyUse: resolvePropertyUse({
      propertyType,
      landUseDescription: parcel.landUseDescription || propertyRecord?._raw?.landUse || null,
      isCommercial,
      commercialSubtype: intent?.commercial_subtype || null,
    }),
    serviceScope,
    customerRelationship: relationship === 'unknown' && tenant ? 'tenant' : relationship,
    // Truthful provenance of the sqft the draft priced from — the existing
    // arbitration vocabulary, never a synthesized value (owner ruling:
    // bedroom bands must never masquerade as property sqft).
    sizeBasis: propertyFacts?.home?.source || 'unresolved',
    lotApplicability: lotApplicabilityFor({ propertySubtype: propertyType, ownershipType }),
    unitSignal,
  };
}

/**
 * Gate ON only: mark a unit/suite scope's absent lot as NOT APPLICABLE —
 * a resolved fact, not missing data (property-facts-v2 doctrine). Only a
 * genuinely absent lot is touched: a lot value that somehow resolved stays
 * (classifyLane's existing rails judge its source), and whole-structure
 * scopes keep today's behavior entirely.
 */
function applyUnitScopeToPropertyFacts(propertyFacts, model) {
  if (!propertyFacts || !model) return propertyFacts;
  const unitScoped = model.serviceScope === 'residential_unit'
    || model.serviceScope === 'commercial_suite';
  // A tenant classifies as leased_land BEFORE the condo/apartment subtype
  // check (inferOwnershipType ordering) — in a UNIT scope that is still a
  // no-individual-lot property: the only lot that could resolve is the
  // development's master parcel (property-facts-shadow doctrine).
  const noIndividualLot = model.lotApplicability === 'common_master_parcel'
    || model.lotApplicability === 'no_individual_lot'
    || model.lotApplicability === 'leased_land';
  if (unitScoped && noIndividualLot && !Number(propertyFacts?.lot?.value)) {
    propertyFacts.lot = {
      value: null,
      source: `not_applicable:${model.lotApplicability}`,
      confidence: 'high',
      rejected: propertyFacts.lot?.rejected || [],
    };
  }
  return propertyFacts;
}

module.exports = {
  unitScopeGuardrailsEnabled,
  hasPrimaryStreetNumber,
  commercialTextSignal,
  commercialCategoryConflict,
  resolveUnitScopeModel,
  applyUnitScopeToPropertyFacts,
  _private: {
    resolvePropertyUse,
    resolveCustomerRelationship,
  },
};
