/**
 * Property Facts V2 — shadow bridge for the estimator engine.
 *
 * Maps the V1 lookup record + call extraction into typed MeasurementEvidence,
 * runs the V2 scoped selection, and diffs it against the V1 arbitration the
 * draft actually priced from. Shadow-only by default: the result is STORED on
 * the draft (estimate_data.estimatorEngine.propertyFactsV2) for evaluation
 * and never touches pricing unless GATE_PROPERTY_FACTS_V2 is flipped.
 *
 * Everything here is fail-open — a shadow failure must never sink a draft.
 */

const {
  selectPropertyFactsV2,
  deriveLegacyFields,
} = require('../property-lookup/property-facts-v2');

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function propertyFactsV2Enabled() {
  return String(process.env.GATE_PROPERTY_FACTS_V2 || '').toLowerCase() === 'true';
}

// ── Scope / ownership inference from V1 signals ─────────────────

const CONDO_TYPES = /condo/i;
const APARTMENT_TYPES = /apartment/i;
// 'Multifamily' is ambiguous: apartment inputs normalize to it, but so do
// whole-property triplexes/quadplexes a caller OWNS outright.
const MULTIFAMILY_TYPES = /multi.?family/i;
const ASSOCIATION_TYPES = /multifamily|apartment|hoa common area/i;

// Positive evidence the caller occupies a UNIT rather than the whole
// structure: tenancy, or a unit/apt/suite subpremise in the service address.
const SUBPREMISE_RE = /(?:\b(?:unit|apt|apartment|ste|suite|lot)\s*[#]?\s*[\w-]+|#\s*\w+)\s*$/i;

// DWELLING/suite designators only — deliberately NOT lot/spc/space: a
// mobile-home or RV LOT number identifies a whole structure on leased
// land, and treating "100 Park Rd, Lot 5" as a unit cleared that home's
// valid county area (codex r30 P2). hasUnitSignal keeps the broader
// SUBPREMISE_RE (pre-existing behavior shared with the V2 shadow).
const DWELLING_SUBPREMISE_RE = /(?:\b(?:unit|apt|apartment|ste|suite)\s*[#]?\s*[\w-]+|#\s*\w+)\s*$/i;

// A UNIT-FIRST address carries the same signal: "Unit 7, 123 Main St" is a
// subpremise exactly as "123 Main St Unit 7" is, and the end-anchored form
// above missed it, so a flattened Single Family lookup kept whole-structure
// scope and the county area/master lot priced the whole property (codex r51
// P1 — the scope-classification half of the r41 unit-first street-number
// fix). The designator must be followed by its token and then a street
// NUMBER, mirroring hasPrimaryStreetNumber's leading-unit rule; dwelling
// designators only, same as the end-anchored form.
const LEADING_DWELLING_SUBPREMISE_RE = /^\s*(?:(?:unit|apt|apartment|ste|suite)\s*[#]?\s*[\w-]+|#\s*\w+)\s*(?:,\s*|\s+at\s+|\s+)\d/i;

function hasDwellingSubpremise(line) {
  const stripped = stripTrailingLocality(line);
  return DWELLING_SUBPREMISE_RE.test(stripped) || LEADING_DWELLING_SUBPREMISE_RE.test(stripped);
}

// Strip the trailing locality so the unit suffix sits at the end of the
// string. Handles BOTH comma styles — ", Venice, FL 34285" and the equally
// common ", Parrish FL 34219" (requiring a comma before the state left the
// ZIP at the end, so an explicit "Suite 101" lost its unit scope — codex
// r27 P1) — and is ANCHORED to the final locality segment(s): an earlier
// form let the city group match a bare space, so a street NAMED Florida
// ("4801 Florida Ave, Suite 7, Sarasota, FL") stripped everything after the
// house number (codex r30 P1). City text carries no digits, and nothing but
// a ZIP may follow the state.
const TRAILING_LOCALITY_RE = new RegExp(
  [
    ',\\s*[A-Za-z][A-Za-z .\'-]*\\s*,\\s*(?:FL|Florida)\\b[\\s\\d-]*$', // …, Venice, FL 34285
    ',\\s*[A-Za-z][A-Za-z .\'-]*\\s+(?:FL|Florida)\\b[\\s\\d-]*$', //     …, Parrish FL 34219
    ',\\s*(?:FL|Florida)\\b[\\s\\d-]*$', //                               …, FL 34221
  ].join('|'),
  'i',
);

function stripTrailingLocality(address) {
  return String(address || '').replace(TRAILING_LOCALITY_RE, '');
}

function hasSubpremiseSignal({ address, extraction }) {
  if (address && hasDwellingSubpremise(address)) return true;
  const extractionAddress = extraction?.property?.service_address;
  if (typeof extractionAddress === 'string') {
    return !!(extractionAddress && hasDwellingSubpremise(extractionAddress));
  }
  // The extraction schema's field names (raw_text/street_line_1/
  // street_line_2 — codex r6 P1: the legacy raw/line1 reads matched
  // nothing, so a unit spoken on the call but dropped from the composed
  // address never signaled). street_line_2 IS the unit line, so any
  // nonempty value counts; the free-text lines still need the regex.
  const lines = [extractionAddress?.raw_text, extractionAddress?.street_line_1,
    extractionAddress?.raw, extractionAddress?.line1];
  if (String(extractionAddress?.street_line_2 || '').trim()) return true;
  // Free-text lines carry localities too (raw_text especially).
  return lines.some((line) => line && hasDwellingSubpremise(line));
}

// The PRE-CHANGE address parse, kept verbatim: the enhanced parse
// (anchored locality strip + schema street_line_2 + dwelling-only
// designators) must not reach the independently-gated V2 pricing path with
// GATE_UNIT_SCOPE_GUARDRAILS off, or an owner at a multifamily "Unit A"
// could newly flip to residential_unit and have V2 clear measurements
// after the advertised kill switch was flipped (codex r31 P1 — same class
// as the r12 owner-suite leak).
const LEGACY_LOCALITY_RE = /,?\s*[A-Za-z .]+,\s*FL.*$/i;

function hasLegacySubpremiseSignal({ address, extraction }) {
  if (address && SUBPREMISE_RE.test(String(address).replace(LEGACY_LOCALITY_RE, ''))) return true;
  const extractionAddress = extraction?.property?.service_address;
  const rawLine = typeof extractionAddress === 'string'
    ? extractionAddress
    : (extractionAddress?.raw || extractionAddress?.line1 || '');
  return !!(rawLine && SUBPREMISE_RE.test(String(rawLine)));
}

function hasUnitSignal({ tenant, address, extraction, enhanced = false }) {
  if (tenant) return true;
  const subpremise = enhanced
    ? hasSubpremiseSignal({ address, extraction })
    : hasLegacySubpremiseSignal({ address, extraction });
  if (subpremise) return true;
  return String(extraction?.property?.property_type || '') === 'apartment';
}

// Positive evidence the customer occupies PART of a building: an explicit
// subpremise, a stacked association aggregate, or a multi-tenant record
// type. Tenancy alone is NOT part-building evidence — a restaurant or
// warehouse tenant can lease an entire freestanding property (codex r38/r39
// P1). Shared by the unit-scope lane and the V2 scope inference so both
// paths agree.
function hasPartBuildingEvidence({ subpremiseSignal, aggregated, propertyType, landUseDescription }) {
  // 'condo' counts: a commercial CONDOMINIUM is by definition one unit of a
  // larger building even when the address carries no Unit/Suite suffix —
  // without it the model called such a tenant a whole-building lease and V2
  // overwrote their stated unit size with the county building area (codex
  // r43 P1).
  // The county's own land-use text is often the ONLY multi-unit evidence —
  // "Multiple Unit Stores" normalizes to a bare 'Commercial' propertyType,
  // so a suite tenant there read as a whole-building lease and V2 could
  // overwrite their stated size with the county building area (codex r44 P1).
  // 'office building' is NOT multi-unit evidence — a tenant can lease an
  // entire freestanding office (codex r45 P1). Only genuinely multi-tenant
  // forms count; 'office park' stays because a park is many buildings.
  const MULTI_UNIT_TEXT = /multiple\s*unit|multi.?tenant|suite|condo|strip\s*(?:mall|center)|plaza|shopping\s*(?:center|centre)|office\s*park/i;
  return subpremiseSignal === true || aggregated === true
    || MULTI_UNIT_TEXT.test(String(propertyType || ''))
    || MULTI_UNIT_TEXT.test(String(landUseDescription || ''));
}

// A CONDOMINIUM record describes ONE unit of a larger development by
// definition — its own folio, its own walls. An owner-occupied commercial
// condo has no tenancy and, with no Unit/Suite suffix on the address, no
// subpremise either, so `unitSignal` is false and the suite branch's
// `(tenant || unitSignal)` conjunct failed it: the owner-occupied commercial
// condo r8 fixed came back `entire_commercial_building`, and the county
// BUILDING area priced their unit (codex r49 P1). The record type IS the
// unit-occupancy evidence. Read from the same two texts as
// hasPartBuildingEvidence (which already counts 'condo' since r43), so the
// two predicates cannot disagree. An AGGREGATED stacked parcel is excluded —
// an aggregate complex bought whole is an association job (r17/r42).
function isCondoRecord({ aggregated, propertyType, landUseDescription }) {
  if (aggregated === true) return false;
  return CONDO_TYPES.test(String(propertyType || ''))
    || CONDO_TYPES.test(String(landUseDescription || ''));
}

// …but the record only stands in for unit OCCUPANCY when the caller is
// someone who occupies one unit. A condo-association manager or HOA board
// member requesting COMMON-AREA service is not — treating their condo-typed
// record as a suite cleared the association's building area and master
// parcel as though they occupied one unit (codex r51 P1). The structured
// hoa_common_area_service boolean and an hoa/common-area risk type carry
// the same rule (they already outrank type text everywhere else — pre-push
// r3). Owner/tenant/unknown keep the r49 behavior.
function condoRecordOccupancy({ condoRecord, extraction, intent }) {
  if (condoRecord !== true) return false;
  const rel = String(extraction?.caller?.relationship_to_property || '').toLowerCase();
  if (/property.?manager|manager|management|association|hoa|board/.test(rel)) return false;
  if (extraction?.property?.hoa_common_area_service === true) return false;
  if (/hoa|common.?area|association/i.test(String(intent?.commercial_risk_type || ''))) return false;
  return true;
}

function inferServiceScope({
  propertyType, isCommercial, tenant, aggregated, unitSignal,
  unitScopeSuites = false, partBuilding = false, subpremise = false,
  condoRecord = false,
}) {
  if (isCommercial) {
    // ASSOCIATION/aggregate first when nobody occupies one unit: an owner or
    // manager buying whole-complex service on a stacked aggregate parcel is
    // an association job, and `unitSignal` alone is true for any
    // apartment-TYPED record, so the suite branch used to swallow it and the
    // apply then discarded the complex's valid measurements (codex r42 P1).
    const occupiesOneUnit = tenant === true || subpremise === true;
    if (unitScopeSuites && !occupiesOneUnit
      && (aggregated || ASSOCIATION_TYPES.test(String(propertyType || '')))) {
      return 'association_common_area';
    }
    // Suite decision:
    //  - lane ON (`unitScopeSuites`): tenancy OR any unit signal counts,
    //    but ONLY with positive part-building evidence — a whole-building
    //    restaurant/warehouse tenant keeps building scope and its county
    //    area/lot (codex r38/r39 P1). This also covers the owner-occupied
    //    commercial condo/flex unit, which is one unit of a larger parcel
    //    (codex r8 P1).
    //  - lane OFF: the legacy tenancy⇒suite mapping, unchanged, so the
    //    independently-gated V2 pricing path cannot inherit new behavior
    //    after the advertised kill switch is flipped (codex r12 P1).
    //  - a CONDO record is unit occupancy in itself (codex r49 P1): the
    //    owner-occupied commercial condo has neither tenancy nor a
    //    subpremise to signal with.
    if (unitScopeSuites ? ((tenant || unitSignal || condoRecord) && partBuilding) : tenant) {
      return 'commercial_suite';
    }
    if (aggregated || ASSOCIATION_TYPES.test(String(propertyType || ''))) return 'association_common_area';
    return 'entire_commercial_building';
  }
  // A residential condo/apartment customer is a UNIT — the complex-wide
  // building measurement must not price their estimate.
  if (CONDO_TYPES.test(String(propertyType || '')) || APARTMENT_TYPES.test(String(propertyType || ''))) {
    return 'residential_unit';
  }
  // 'Multifamily' is a unit ONLY on positive unit evidence (tenancy or a
  // subpremise) — an owner quoting their whole triplex/quadplex is an
  // entire-structure job and must not be forced unresolved (codex r6 P1).
  if (MULTIFAMILY_TYPES.test(String(propertyType || ''))) {
    return unitSignal ? 'residential_unit' : 'entire_residential_structure';
  }
  return 'entire_residential_structure';
}

function inferOwnershipType({
  propertyType, isCommercial, tenant, aggregated, unitSignal,
  unitScopeSuites = false, partBuilding = false, condoRecord = false,
}) {
  if (tenant) {
    // A commercial tenant is a leased SUITE only when they occupy part of a
    // building; a whole-building restaurant/warehouse lease sits on a real
    // parcel, and 'leased_suite' made selectLot report no_individual_lot so
    // V2 cleared that valid parcel area (codex r40 P1 — the ownership half
    // of the r38/r39 scope fix). Gate-scoped like every other lane change.
    if (isCommercial) {
      return (unitScopeSuites && !partBuilding) ? 'leased_whole_building' : 'leased_suite';
    }
    return 'leased_land';
  }
  // Owner-occupied commercial UNIT (positive unit evidence, no tenancy):
  // a commercial condominium — its lot is the development's master parcel,
  // never a private lot (pairs with the suite scope above, codex r8 P1).
  // Same opt-in as inferServiceScope so the V2 path can't inherit the new
  // behavior with the unit-scope kill switch off (codex r12 P1).
  // The condo RECORD counts here too (codex r49 P1) — without it a
  // suffix-less commercial condo owner fell through to the residential
  // CONDO_TYPES line below and was labelled a residential condominium.
  if (isCommercial && (unitSignal || condoRecord) && unitScopeSuites) return 'commercial_condominium';
  if (aggregated) return 'association_common_property';
  const type = String(propertyType || '');
  // Multifamily without positive unit evidence is an OWNED whole-property
  // triplex/quadplex — fee simple with a real private parcel, not
  // association property (mirrors the serviceScope rule).
  if (APARTMENT_TYPES.test(type) || /hoa common area/i.test(type)
    || (MULTIFAMILY_TYPES.test(type) && unitSignal)) {
    return 'association_common_property';
  }
  if (CONDO_TYPES.test(type)) return 'residential_condominium';
  return 'fee_simple';
}

// ── Evidence extraction from the V1 record shape ────────────────

function sqftKindFor({ isCommercial, scope }) {
  if (isCommercial) return scope === 'suite' ? 'commercial_suite_area_sqft' : 'building_area_sqft';
  return scope === 'unit' ? 'residential_unit_area_sqft' : 'residential_living_area_sqft';
}

function fieldEvidenceItems(propertyRecord, field) {
  const evidence = propertyRecord?._fieldEvidence?.[field];
  if (!evidence) return [];
  const entries = Array.isArray(evidence) ? evidence : (evidence.evidence || [evidence]);
  return entries.filter(Boolean);
}

function buildMeasurementEvidence({ propertyRecord, extraction, isCommercial, tenant, serviceScope }) {
  const out = [];
  const parcel = propertyRecord?._parcel || {};
  const aggregated = parcel.aggregated === true;
  let id = 0;
  const nextId = (label) => `${label}-${id += 1}`;

  // Structure area from the merged field-evidence trail. The V1 trail
  // doesn't carry scope, so the record-level value describes the building
  // (or, for a tenant's county record, the WRONG building-wide figure —
  // scope 'building' keeps it out of suite-scoped selection by design).
  // Condo county records are PER-UNIT parcels (own folio), so their sqft is
  // unit-scoped; an APARTMENT record covers the whole complex — its sqft
  // stays 'building' so a residential_unit selection goes unresolved unless
  // unit-scoped evidence (caller-stated) exists.
  const unitScoped = !isCommercial && CONDO_TYPES.test(String(propertyRecord?.propertyType || ''));
  // The uncapped actual SUPERSEDES the pricing-capped legacy value IN PLACE:
  // both describe the same underlying record, so emitting them as separate
  // evidence would dedupe-collapse on the shared source URL and the stable
  // sort could keep the capped twin (codex r3 P2). The upgrade only applies
  // when the actual's own PROVENANCE is measured-grade — a listing/AI actual
  // retained through the merge must not be priced as a county-measured
  // building (codex r6 P1); provenance-less legacy actuals stay conservative.
  const actualBuilding = positive(propertyRecord?._actuals?.buildingAreaSqft);
  const actualBuildingSourceType = propertyRecord?._actuals?._sourceTypes?.buildingAreaSqft || 'unknown';
  const actualBuildingMeasured = ['county', 'cadastral', 'verified'].includes(actualBuildingSourceType);
  const cappedLegacy = positive(propertyRecord?.squareFootage);
  let actualApplied = false;
  for (const item of fieldEvidenceItems(propertyRecord, 'squareFootage')) {
    if (!positive(item.value)) continue;
    const scope = aggregated ? 'association' : (unitScoped ? 'unit' : 'building');
    let value = Number(item.value);
    if (actualBuilding && actualBuildingMeasured
      && (item.sourceType === 'county' || item.sourceType === 'cadastral' || item.sourceType === 'verified')
      && cappedLegacy && value === cappedLegacy) {
      value = actualBuilding;
      actualApplied = true;
    }
    out.push({
      id: nextId('sqft'),
      field: sqftKindFor({ isCommercial, scope }),
      value,
      units: 'sqft',
      scope,
      directness: 'direct',
      sourceName: item.provider || item.sourceType || 'lookup',
      sourceType: item.sourceType || 'unknown',
      sourceUrl: item.url || null,
      exactAddressMatch: true,
      exactSubpremiseMatch: unitScoped,
      extractionConfidence: item.providerConfidence || item.confidence || 'medium',
      warnings: [],
    });
  }
  // Actuals that couldn't upgrade in place (no matching measured item, or
  // non-measured provenance) still enter as evidence — under their TRUE
  // source label and authority, so a listing's 270k claim competes as a
  // listing, never as county data.
  if (actualBuilding && !actualApplied) {
    out.push({
      id: nextId('sqft-actual'),
      field: 'building_area_sqft',
      value: actualBuilding,
      units: 'sqft',
      scope: aggregated ? 'association' : 'building',
      directness: 'direct',
      sourceName: actualBuildingMeasured ? 'county (uncapped)' : `${actualBuildingSourceType} (uncapped)`,
      sourceType: actualBuildingSourceType,
      sourceUrl: propertyRecord?._aiSourceUrl || null,
      exactAddressMatch: true,
      exactSubpremiseMatch: false,
      extractionConfidence: actualBuildingMeasured ? 'high' : 'medium',
      warnings: [],
    });
  }

  // Per-building county rows (multi-building parcels).
  const buildings = Array.isArray(propertyRecord?._buildings) ? propertyRecord._buildings : [];
  buildings.forEach((row, index) => {
    const area = positive(row.livingAreaSqft) || positive(row.acAreaSqft) || positive(row.grossAreaSqft)
      || positive(row.areaSqft) || positive(row.totalAreaSqft);
    if (!area) return;
    out.push({
      id: nextId('bldg'),
      field: isCommercial ? 'building_area_sqft' : 'residential_living_area_sqft',
      value: area,
      units: 'sqft',
      scope: 'building',
      directness: 'direct',
      sourceName: row.description || `building ${index + 1}`,
      sourceType: 'county',
      sourceRecordId: `building-${index + 1}`,
      exactAddressMatch: true,
      exactSubpremiseMatch: false,
      extractionConfidence: 'high',
      warnings: [],
    });
    if (positive(row.stories)) {
      out.push({
        id: nextId('bldg-stories'),
        field: 'building_stories',
        value: Number(row.stories),
        units: 'stories',
        scope: 'building',
        directness: 'direct',
        sourceName: row.description || `building ${index + 1}`,
        sourceType: 'county',
        sourceRecordId: `building-${index + 1}-stories`,
        exactAddressMatch: true,
        exactSubpremiseMatch: false,
        extractionConfidence: 'high',
        warnings: [],
      });
    }
  });

  // Caller-stated sizes — the ONLY unit-scoped source for a commercial
  // suite, and for an apartment unit (whose county record is complex-wide).
  // Keyed on the resolved SERVICE SCOPE, not tenancy: an OWNER-occupied
  // commercial unit is a suite too, and scoping their stated unit size as
  // 'building' made the suite area unresolved and cleared the one usable
  // measurement they gave us (codex r11 P1).
  const stated = positive(extraction?.property?.approximate_living_sqft);
  if (stated) {
    const statedScope = (isCommercial && (tenant || serviceScope === 'commercial_suite')) ? 'suite'
      : (serviceScope === 'residential_unit' ? 'unit' : 'building');
    out.push({
      id: nextId('caller'),
      field: sqftKindFor({ isCommercial, scope: statedScope }),
      value: stated,
      units: 'sqft',
      scope: statedScope,
      directness: 'direct',
      sourceName: 'caller-stated',
      sourceType: 'caller',
      exactAddressMatch: true,
      exactSubpremiseMatch: true,
      extractionConfidence: 'medium',
      warnings: [],
    });
  }

  // Lot / parcel. An association aggregate's parcel is the MASTER parcel.
  // The source label follows WHERE the value actually came from — a hybrid
  // lookup can match a county parcel while the lot number itself is
  // AI/listing evidence, which must not masquerade as an assessed parcel
  // measurement (codex r4 P1).
  const countyLot = positive(parcel.lotSqft) || positive(parcel.polygonAreaSqft);
  const actualLot = positive(propertyRecord?._actuals?.lotSqft);
  const recordLot = actualLot || positive(propertyRecord?.lotSize);
  const lotValue = countyLot || recordLot;
  if (lotValue) {
    const lotEvidenceEntries = fieldEvidenceItems(propertyRecord, 'lotSize');
    // The actual's own provenance outranks the field-evidence trail when the
    // value IS the actual; provenance-less actuals stay 'unknown'.
    const actualLotSourceType = propertyRecord?._actuals?._sourceTypes?.lotSqft || null;
    const recordLotSourceType = (actualLot ? actualLotSourceType : null)
      || lotEvidenceEntries[0]?.sourceType || 'unknown';
    const fromCounty = !!countyLot;
    out.push({
      id: nextId('lot'),
      field: 'parcel_area_sqft',
      // A county lot may itself carry an uncapped actual (cadastral clamp);
      // only county/cadastral-PROVENANCED actuals upgrade a county value.
      value: fromCounty
        ? ((actualLotSourceType === 'county' || actualLotSourceType === 'cadastral')
          && actualLot > countyLot
          ? actualLot : countyLot)
        : recordLot,
      units: 'sqft',
      scope: aggregated ? 'association' : 'parcel',
      directness: 'direct',
      sourceName: fromCounty ? 'county parcel' : (lotEvidenceEntries[0]?.provider || 'lookup'),
      sourceType: fromCounty ? 'county' : recordLotSourceType,
      exactAddressMatch: true,
      exactSubpremiseMatch: false,
      extractionConfidence: fromCounty ? 'high'
        : (lotEvidenceEntries[0]?.providerConfidence || lotEvidenceEntries[0]?.confidence || 'medium'),
      warnings: [],
    });
  }

  // Record-level stories with fallback provenance.
  const stories = positive(propertyRecord?.stories);
  if (stories && !buildings.some((row) => positive(row.stories))) {
    const fallback = propertyRecord?._storiesEvidence || null;
    out.push({
      id: nextId('stories'),
      field: 'building_stories',
      value: stories,
      units: 'stories',
      scope: 'building',
      directness: fallback
        ? (fallback.basis === 'inferred' ? 'inferred' : 'direct')
        : 'direct',
      sourceName: fallback ? 'ai stories fallback' : 'lookup',
      sourceType: fallback ? (fallback.sourceType || 'model_inference') : 'county',
      sourceUrl: fallback?.sourceUrl || null,
      exactAddressMatch: true,
      exactSubpremiseMatch: false,
      extractionConfidence: fallback?.confidence || 'high',
      warnings: [],
    });
  }

  return out;
}

// ── Shadow computation + diff ───────────────────────────────────

/**
 * Run V2 selection in shadow and diff it against the V1 arbitration.
 * Returns null when there is nothing to select from. Never throws.
 */
function computePropertyFactsV2Shadow({ propertyRecord, extraction, intent, propertyFacts, address }) {
  try {
    const isCommercial = intent?.is_commercial === true;
    const tenant = propertyFacts?.tenant === true;
    const parcel = propertyRecord?._parcel || {};
    const aggregated = parcel.aggregated === true;
    const propertyType = propertyRecord?.propertyType || extraction?.property?.property_type || null;

    // The unit-scope lane's behavior reaches the V2 PRICING path only when
    // that kill switch is also on, so disabling it restores prior V2
    // behavior exactly — owner-unit suites (codex r12 P1) AND the enhanced
    // address parse (codex r31 P1). Lazily required: unit-scope-model
    // requires this module at load time, so an eager import would cycle.
    let unitScopeSuites = false;
    try {
      unitScopeSuites = require('./unit-scope-model').unitScopeGuardrailsEnabled();
    } catch { /* predicate unavailable — stay on prior behavior */ }
    const unitSignal = hasUnitSignal({
      tenant,
      address: address || propertyRecord?.formattedAddress,
      extraction,
      enhanced: unitScopeSuites,
    });
    const subpremiseSignalForScope = hasSubpremiseSignal({
      address: address || propertyRecord?.formattedAddress,
      extraction,
    });
    const partBuilding = hasPartBuildingEvidence({
      subpremiseSignal: subpremiseSignalForScope, aggregated, propertyType,
      landUseDescription: parcel.landUseDescription || propertyRecord?._raw?.landUse || null,
    });
    const condoRecord = condoRecordOccupancy({
      condoRecord: isCondoRecord({
        aggregated, propertyType,
        landUseDescription: parcel.landUseDescription || propertyRecord?._raw?.landUse || null,
      }),
      extraction, intent,
    });
    const serviceScope = inferServiceScope({
      propertyType, isCommercial, tenant, aggregated, unitSignal, unitScopeSuites, partBuilding,
      subpremise: subpremiseSignalForScope, condoRecord,
    });
    const ownershipType = inferOwnershipType({
      propertyType, isCommercial, tenant, aggregated, unitSignal, unitScopeSuites, partBuilding,
      condoRecord,
    });
    const evidence = buildMeasurementEvidence({ propertyRecord, extraction, isCommercial, tenant, serviceScope });
    if (!evidence.length) return null;

    const facts = selectPropertyFactsV2({
      normalizedAddress: address || propertyRecord?.formattedAddress || null,
      parcelId: parcel.paoParcelId || parcel.parcelId || null,
      occupancyClass: isCommercial ? 'commercial' : 'residential',
      propertySubtype: propertyType,
      ownershipType,
      serviceScope,
      evidence,
    });
    const legacy = deriveLegacyFields(facts);

    const differences = [];
    const v1Home = positive(propertyFacts?.home?.value);
    const v1Lot = positive(propertyFacts?.lot?.value);
    const v1Stories = positive(propertyFacts?.stories);
    if ((legacy.squareFootage || null) !== (v1Home || null)) differences.push('structure_area_changed');
    if ((legacy.lotSize || null) !== (v1Lot || null)) differences.push('lot_changed');
    if ((legacy.stories || null) !== (v1Stories || null)) differences.push('stories_changed');
    if (facts.lot.applicability === 'common_master_parcel' && v1Lot) differences.push('v1_lot_on_no_lot_property');

    return {
      version: 2,
      shadow: !propertyFactsV2Enabled(),
      facts,
      legacyDerived: legacy,
      v1: { homeSqFt: v1Home, lotSqFt: v1Lot, stories: v1Stories },
      differences,
    };
  } catch (err) {
    // Fail-open: shadow analysis must never sink a draft.
    try {
      const logger = require('../logger');
      logger.warn(`[estimator-engine] property-facts-v2 shadow failed: ${err.message}`);
    } catch { /* logger unavailable in some test harnesses */ }
    return null;
  }
}

/**
 * GATE ON only: mutate the V1 propertyFacts to follow the V2 selection.
 *
 * The critical rule (codex r2 P1): when V2 deliberately returned an
 * UNRESOLVED structure area (ambiguous multi-building scope, suite with no
 * suite-scoped evidence), the V1 value must be CLEARED, not retained — V2
 * refused to pick a number precisely so that scope could not auto-price.
 */
// Map a V2 selection's evidence back to the V1 source vocabulary the lane
// classifier and engine guards already understand (codex r5 P1): only
// measured-grade evidence (verified/county/cadastral/permit) earns the
// non-fallback 'property_facts_v2' label; caller-stated keeps its V1 name;
// anything weaker or mixed classifies as 'property_lookup_estimate', which
// sits in FALLBACK_SQFT_SOURCES so the yellow/manual-review rails still fire.
const MEASURED_EVIDENCE_SOURCES = new Set(['verified', 'county', 'cadastral', 'permit']);

function v1SourceForSelection(facts, selection) {
  const ids = new Set(selection?.selectedEvidenceIds || []);
  const items = (facts?.evidence || []).filter((e) => ids.has(e.id));
  if (items.length && items.every((e) => MEASURED_EVIDENCE_SOURCES.has(e.sourceType))) return 'property_facts_v2';
  if (items.length && items.every((e) => e.sourceType === 'caller')) return 'caller_stated';
  return 'property_lookup_estimate';
}

function applyV2ToPropertyFacts(propertyFacts, v2) {
  if (!propertyFacts || !v2) return propertyFacts;
  const legacy = v2.legacyDerived || {};
  const facts = v2.facts || {};

  if (legacy.squareFootage) {
    propertyFacts.home = {
      value: legacy.squareFootage,
      source: v1SourceForSelection(facts, facts.structureArea),
      confidence: facts.confidenceLevel,
      // V1 arbitration's dispute verdict (caller vs county >35%) survives
      // the replacement — the same hard conflict must keep forcing review,
      // not green-lane because the source string changed (codex r3 P1).
      ...(propertyFacts.home?.disputed ? { disputed: true } : {}),
      rejected: propertyFacts.home?.rejected || [],
    };
  } else if (facts.requiresConfirmation) {
    const priorValue = positive(propertyFacts.home?.value);
    propertyFacts.home = {
      value: null,
      source: 'unresolved',
      confidence: 'none',
      rejected: [
        ...(propertyFacts.home?.rejected || []),
        ...(priorValue ? [{
          value: priorValue,
          source: propertyFacts.home?.source || 'unknown',
          reason: `V2 scope selection unresolved — ${(facts.warnings || []).join('; ') || 'requires confirmation'}`,
        }] : []),
      ],
    };
  }

  // V2 may resolve the lot to NULL for a no-lot property (condo unit on a
  // common master parcel) — that resolved null must WIN over a V1 lot that
  // leaked in from the development's parcel. But only cases where the priced
  // property genuinely has no individual lot may clear a V1-resolved lot:
  // - a leased_land tenant of an ENTIRE residential structure (single-family
  //   rental) sits on a real parcel that lot-driven services still treat —
  //   not owning the lot is not evidence it is absent. A leased_land tenant
  //   in a UNIT scope (apartment/condo — inferOwnershipType maps residential
  //   tenants to leased_land before the unit check) must still clear: the
  //   only V1 lot available there is the development's master parcel.
  // - an unresolved private_parcel value is missing data, not a resolved
  //   "no lot" — clearing it stamped a false high-confidence source.
  if (facts.lot && facts.lot.applicability !== 'unknown') {
    // Positive whole-structure evidence required: entire_residential_
    // structure is also inferServiceScope's FALLBACK for a missing or
    // generic property type, and a tenant behind that fallback may really
    // be an apartment renter whose only V1 lot is the development's county
    // master parcel. Only a subtype that positively names a whole
    // residential structure lets a leased_land tenant keep the lot.
    const WHOLE_STRUCTURE_SUBTYPES = /single_?family|duplex|triplex|quadplex|townhou|villa|mobile_?home|manufactured/;
    const positiveWholeStructure = facts.serviceScope === 'entire_residential_structure'
      && WHOLE_STRUCTURE_SUBTYPES.test(String(facts.propertySubtype || ''));
    const keepsRealParcel = (facts.lot.applicability === 'leased_land' && positiveWholeStructure)
      || facts.lot.applicability === 'private_parcel';
    if (legacy.lotSize) {
      propertyFacts.lot = {
        value: legacy.lotSize,
        source: v1SourceForSelection(facts, facts.lot),
        confidence: facts.confidenceLevel,
        ...(propertyFacts.lot?.disputed ? { disputed: true } : {}),
        rejected: propertyFacts.lot?.rejected || [],
      };
    } else if (!keepsRealParcel) {
      propertyFacts.lot = {
        value: null,
        source: `no_individual_lot:${facts.lot.applicability}`,
        confidence: 'high',
        rejected: propertyFacts.lot?.rejected || [],
      };
    } else if (facts.lot.applicability === 'private_parcel'
      && positive(propertyFacts.lot?.value)) {
      // V2 REQUIRED a private-lot measurement here and could not resolve
      // one — the retained V1 value (which can be a medium-confidence
      // profile lot) survives as data, not as confidence: mark it low so
      // classifyLane parks lot-driven drafts for review instead of
      // green-laning on a measurement V2 explicitly failed to confirm.
      propertyFacts.lot = { ...propertyFacts.lot, confidence: 'low' };
    }
    // leased_land entire-structure keep: the V1 lot (and its own
    // confidence — county high stays green, caller-stated low parks) is
    // untouched; V2 never required a private-lot measurement there.
  }
  if (legacy.stories) propertyFacts.stories = legacy.stories;
  return propertyFacts;
}

module.exports = {
  propertyFactsV2Enabled,
  computePropertyFactsV2Shadow,
  applyV2ToPropertyFacts,
  _private: {
    inferServiceScope,
    inferOwnershipType,
    buildMeasurementEvidence,
    hasUnitSignal,
    hasSubpremiseSignal,
    hasPartBuildingEvidence,
    isCondoRecord,
    condoRecordOccupancy,
  },
};
