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
const ASSOCIATION_TYPES = /multifamily|apartment|hoa common area/i;

function inferServiceScope({ propertyType, isCommercial, tenant, aggregated }) {
  if (isCommercial) {
    if (tenant) return 'commercial_suite';
    if (aggregated || ASSOCIATION_TYPES.test(String(propertyType || ''))) return 'association_common_area';
    return 'entire_commercial_building';
  }
  // A residential apartment customer is a UNIT, like a condo — the complex-
  // wide building measurement must not price their estimate.
  if (CONDO_TYPES.test(String(propertyType || '')) || APARTMENT_TYPES.test(String(propertyType || ''))) {
    return 'residential_unit';
  }
  return 'entire_residential_structure';
}

function inferOwnershipType({ propertyType, isCommercial, tenant, aggregated }) {
  if (tenant) return isCommercial ? 'leased_suite' : 'leased_land';
  if (aggregated || ASSOCIATION_TYPES.test(String(propertyType || ''))) return 'association_common_property';
  if (CONDO_TYPES.test(String(propertyType || ''))) return 'residential_condominium';
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
  for (const item of fieldEvidenceItems(propertyRecord, 'squareFootage')) {
    if (!positive(item.value)) continue;
    const scope = aggregated ? 'association' : (unitScoped ? 'unit' : 'building');
    out.push({
      id: nextId('sqft'),
      field: sqftKindFor({ isCommercial, scope }),
      value: Number(item.value),
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
  // Uncapped actual supersedes the pricing-capped legacy value for the fact.
  const actualBuilding = positive(propertyRecord?._actuals?.buildingAreaSqft);
  if (actualBuilding) {
    out.push({
      id: nextId('sqft-actual'),
      field: 'building_area_sqft',
      value: actualBuilding,
      units: 'sqft',
      scope: aggregated ? 'association' : 'building',
      directness: 'direct',
      sourceName: 'county (uncapped)',
      sourceType: 'county',
      sourceUrl: propertyRecord?._aiSourceUrl || null,
      exactAddressMatch: true,
      exactSubpremiseMatch: false,
      extractionConfidence: 'high',
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
  // tenant, and for an apartment unit (whose county record is complex-wide).
  const stated = positive(extraction?.property?.approximate_living_sqft);
  if (stated) {
    const statedScope = (isCommercial && tenant) ? 'suite'
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
  const lotValue = positive(parcel.lotSqft) || positive(parcel.polygonAreaSqft)
    || positive(propertyRecord?._actuals?.lotSqft) || positive(propertyRecord?.lotSize);
  if (lotValue) {
    out.push({
      id: nextId('lot'),
      field: 'parcel_area_sqft',
      value: positive(propertyRecord?._actuals?.lotSqft) || lotValue,
      units: 'sqft',
      scope: aggregated ? 'association' : 'parcel',
      directness: 'direct',
      sourceName: parcel.parcelId ? 'county parcel' : 'lookup',
      sourceType: parcel.parcelId ? 'county' : 'unknown',
      exactAddressMatch: true,
      exactSubpremiseMatch: false,
      extractionConfidence: 'high',
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

    const serviceScope = inferServiceScope({ propertyType, isCommercial, tenant, aggregated });
    const ownershipType = inferOwnershipType({ propertyType, isCommercial, tenant, aggregated });
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
function applyV2ToPropertyFacts(propertyFacts, v2) {
  if (!propertyFacts || !v2) return propertyFacts;
  const legacy = v2.legacyDerived || {};
  const facts = v2.facts || {};

  if (legacy.squareFootage) {
    propertyFacts.home = {
      value: legacy.squareFootage,
      source: 'property_facts_v2',
      confidence: facts.confidenceLevel,
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
  // leaked in from the development's parcel.
  if (facts.lot && facts.lot.applicability !== 'unknown') {
    propertyFacts.lot = legacy.lotSize
      ? {
        value: legacy.lotSize,
        source: 'property_facts_v2',
        confidence: facts.confidenceLevel,
        rejected: propertyFacts.lot?.rejected || [],
      }
      : {
        value: null,
        source: `no_individual_lot:${facts.lot.applicability}`,
        confidence: 'high',
        rejected: propertyFacts.lot?.rejected || [],
      };
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
  },
};
