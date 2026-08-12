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
// more address text. Ordinal street NAMES ("62nd Avenue East") deliberately
// fail: \d+ cannot be followed by a letter run ("62nd" breaks on the 'n'),
// which is exactly the incomplete-address class that produced a quote-less
// silent lookup failure. Unit-letter house numbers ("123A Main St") and
// hyphenated ranges ("123-125 Main St") pass.
const PRIMARY_STREET_NUMBER_RE = /^\s*\d+[a-z]?(?:[-/]\w+)?\s+\S/i;

function hasPrimaryStreetNumber(address) {
  return PRIMARY_STREET_NUMBER_RE.test(String(address || ''));
}

// ── Category conflict (commercial signal on a residential draft) ─

// Extraction property types that positively describe a commercial
// premises, matched by FAMILY (the extraction field is free-form —
// 'industrial_flex', 'industrial building', and 'commercial property' must
// all count; an exact-string set let every variant evade the guard, codex
// pre-push P1). Residential families are excluded FIRST and win ties:
// 'multifamily'/'apartment'/'condo' are NOT commercial signals here — a
// unit tenant is residential; the ≥5-unit whole-property rule lives in
// detectCategory.
// 'town' alone would swallow 'downtown office', and a bare house-suffix
// match would swallow 'warehouse' — townhome spellings only, and
// house/home only as standalone words.
const RESIDENTIAL_TYPE_FAMILY_RE = /apartment|multi.?family|condo|town\s?(?:home|house)|single|duplex|triplex|quadplex|villa|mobile|manufactured|residential|\bhouse\b|\bhome\b/;
const COMMERCIAL_TYPE_FAMILY_RE = /commercial|office|industrial|warehouse|retail|restaurant|storefront|plaza|clinic|medical|business|flex/;

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
// HOA/common-area/association types trigger commercial handling by schema
// even though their text often carries residential words ('condo
// association') — checked BEFORE the residential exclusion so the
// exclusion can't swallow them (codex r1 P1).
const HOA_COMMON_AREA_TYPE_RE = /hoa|common.?area|association/;

function commercialCategoryConflict({ extraction, intent }) {
  if (intent?.is_commercial === true) return null;
  const type = String(extraction?.property?.property_type || '').trim().toLowerCase();
  if (!type) return null;
  if (HOA_COMMON_AREA_TYPE_RE.test(type)) return type;
  if (RESIDENTIAL_TYPE_FAMILY_RE.test(type)) return null;
  return COMMERCIAL_TYPE_FAMILY_RE.test(type) ? type : null;
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
  // Nothing matched positively: 'unknown' — an unrecognized (or literal
  // schema 'unknown') type must stay unknown in the audit record, or the
  // persisted model recreates the exact silent single-family default this
  // module exists to eliminate (codex r1 P2).
  return 'unknown';
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
 * Gate ON only: resolve a unit/suite scope's lot as NOT APPLICABLE — a
 * resolved fact, not missing data (property-facts-v2 doctrine). A lot
 * value that DID resolve on such a scope is the development's master
 * parcel leaking in (the only lot the lookup can see for a unit), so it is
 * CLEARED into the rejected trail rather than preserved — a lot-driven
 * service pricing a whole complex's parcel for one unit is exactly the
 * overquote the V2 bridge already clears on its own path (codex r1 P1).
 * Whole-structure scopes keep today's behavior entirely.
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
  if (unitScoped && noIndividualLot) {
    const priorValue = Number(propertyFacts?.lot?.value) > 0 ? Number(propertyFacts.lot.value) : null;
    propertyFacts.lot = {
      value: null,
      source: `not_applicable:${model.lotApplicability}`,
      confidence: 'high',
      rejected: [
        ...(propertyFacts.lot?.rejected || []),
        ...(priorValue ? [{
          value: priorValue,
          source: propertyFacts.lot?.source || 'unknown',
          reason: 'master-parcel lot cleared — a unit/suite scope has no individual lot',
        }] : []),
      ],
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
