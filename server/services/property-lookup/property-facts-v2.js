/**
 * Property Facts V2 — typed measurement semantics for property data.
 *
 * The V1 record collapses every structure measurement into one generic
 * `squareFootage` (unit area, suite area, whole-building area, gross area,
 * association aggregate…) and one `lotSize` (private lot, parcel, or a condo
 * development's master parcel). This module gives every measurement an
 * explicit KIND and SCOPE, keeps evidence traceable to the specific source
 * it came from, and makes selection deterministic per service scope.
 *
 * Design rules (2026-07-24 audit):
 *  - A fact is never mutated by a pricing bound — `value` is the actual
 *    measurement; pricing limits surface as `pricingValue`/`pricingDisposition`.
 *  - A condo unit's missing private lot is a RESOLVED fact
 *    (applicability: 'common_master_parcel'), not incomplete data.
 *  - Model confidence describes extraction certainty; it never raises a
 *    source's authority. Comparison is lexicographic, authority before
 *    confidence.
 *  - N models reading the same page are ONE independent source.
 *
 * Pure and dependency-free by design: everything here is deterministic
 * selection over evidence the lookup/arbitration layers already gathered.
 */

const MEASUREMENT_KINDS = [
  'residential_living_area_sqft',
  'residential_heated_area_sqft',
  'residential_unit_area_sqft',
  'commercial_suite_area_sqft',
  'gross_leasable_area_sqft',
  'building_area_sqft',
  'gross_building_area_sqft',
  'building_footprint_sqft',
  'parcel_area_sqft',
  'private_lot_area_sqft',
  'building_stories',
  'unit_stories',
  'occupied_stories',
];

const MEASUREMENT_SCOPES = [
  'unit', 'suite', 'building', 'multi_building_parcel', 'parcel', 'association', 'unknown',
];

const SERVICE_SCOPES = [
  'residential_unit',
  'entire_residential_structure',
  'commercial_suite',
  'entire_commercial_building',
  'multi_building_commercial_parcel',
  'association_common_area',
  'entire_parcel',
  'unknown',
];

// Authority is a property of the SOURCE, never of the model that read it.
const SOURCE_AUTHORITY = {
  verified: 110,
  county: 100,
  cadastral: 97,
  permit: 95,
  builder: 85,
  mls: 75,
  listing: 75,
  commercial_listing: 75,
  // Caller-stated sits between listings and aggregators: it describes the
  // treated space first-hand (and is the ONLY source for a commercial
  // tenant's unit), but people round.
  caller: 70,
  aggregator: 55,
  generic: 40,
  unknown: 30,
  model_inference: 10,
};

const DIRECTNESS_RANK = { direct: 2, derived: 1, inferred: 0 };
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

// The commercial relationship-quote threshold the estimator already enforces
// (draft-builder COMMERCIAL_FOOTPRINT_RED_SQFT). Duplicated as a named
// constant so the facts layer can mark disposition without importing the
// estimator; keep the two in sync.
const COMMERCIAL_RELATIONSHIP_QUOTE_SQFT = 10000;

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Numeric equivalence ─────────────────────────────────────────

// Tolerance class per measurement kind. Stories always compare exact.
function kindToleranceClass(kind) {
  if (kind === 'building_stories' || kind === 'unit_stories' || kind === 'occupied_stories') return 'stories';
  if (kind === 'parcel_area_sqft' || kind === 'private_lot_area_sqft') return 'lot';
  if (kind === 'residential_living_area_sqft' || kind === 'residential_heated_area_sqft'
    || kind === 'residential_unit_area_sqft') return 'residential';
  return 'commercial';
}

const EQUIVALENCE = {
  residential: { relative: 0.01, absolute: 25 },
  commercial: { relative: 0.02, absolute: 100 },
  lot: { relative: 0.02, absolute: 100 },
  stories: { relative: 0, absolute: 0 },
};

/**
 * True when two values of the same measurement kind are the same fact modulo
 * rounding (2,154 vs 2,155 sqft is agreement, not a dispute).
 */
function valuesEquivalent(kind, a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x === y) return true;
  const tol = EQUIVALENCE[kindToleranceClass(kind)];
  const allowed = Math.max(tol.absolute, Math.abs(Math.max(x, y)) * tol.relative);
  return Math.abs(x - y) <= allowed;
}

// ── Source independence ─────────────────────────────────────────

/**
 * Canonical form of a source URL: scheme/query/hash/www stripped, host
 * lowercased, trailing slash dropped. Two fetches of the same page (or the
 * same page cited by different models) canonicalize identically.
 */
function canonicalSourceUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim().toLowerCase() || null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return `${host}${path}`;
}

/**
 * Independence key: which underlying RECORD this evidence came from.
 * MLS number first (syndicated copies of one listing share it across
 * domains), then the record id WITHIN a source (a county parcel page lists
 * several distinct building rows under one URL), then canonical URL, then
 * parcel identity.
 */
function independenceKeyFor(ev) {
  if (ev?.mlsNumber) return `mls:${String(ev.mlsNumber).trim().toUpperCase()}`;
  if (ev?.sourceRecordId) return `rec:${ev.sourceType || 'unknown'}:${ev.sourceRecordId}`;
  const canonical = canonicalSourceUrl(ev?.canonicalSourceUrl || ev?.sourceUrl);
  if (canonical) return `url:${canonical}`;
  if (ev?.parcelId) return `parcel:${ev.sourceType || 'unknown'}:${ev.parcelId}`;
  return `src:${ev?.sourceType || 'unknown'}:${ev?.sourceName || 'unnamed'}`;
}

function sourceAuthority(ev) {
  return SOURCE_AUTHORITY[ev?.sourceType] ?? SOURCE_AUTHORITY.unknown;
}

/**
 * Lexicographic evidence comparison (descending preference). Model
 * confidence is the LAST tiebreaker — a perfect extraction from a listing is
 * still listing evidence.
 */
function compareEvidence(a, b) {
  const identity = (ev) => (ev?.exactAddressMatch ? 2 : 0) + (ev?.exactSubpremiseMatch ? 1 : 0);
  const directness = (ev) => DIRECTNESS_RANK[ev?.directness] ?? 0;
  const freshness = (ev) => Number(ev?.freshnessScore) || 0;
  const confidence = (ev) => CONFIDENCE_RANK[ev?.extractionConfidence] ?? 0;
  return (identity(b) - identity(a))
    || (directness(b) - directness(a))
    || (sourceAuthority(b) - sourceAuthority(a))
    || (freshness(b) - freshness(a))
    || (confidence(b) - confidence(a));
}

/**
 * Collapse evidence items that describe the same field of the same
 * underlying record into one entry (best representative kept, contributing
 * providers recorded). Claude+OpenAI+Gemini reading one Realtor page → one
 * independent source.
 */
function dedupeEvidence(list) {
  const groups = new Map();
  for (const ev of Array.isArray(list) ? list : []) {
    if (!ev) continue;
    const key = `${ev.field || 'unknown'}|${independenceKeyFor(ev)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const out = [];
  for (const members of groups.values()) {
    const sorted = [...members].sort(compareEvidence);
    const best = { ...sorted[0] };
    const providers = [...new Set(members.map((m) => m.sourceName).filter(Boolean))];
    if (providers.length > 1) best.corroboratingProviders = providers;
    best.independenceKey = independenceKeyFor(best);
    out.push(best);
  }
  return out;
}

// ── Completeness ────────────────────────────────────────────────

function normalizeSubtype(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Lot applicability from ownership + subtype. Condo/apartment/leased
 * occupancies have no individually assigned lot BY DESIGN — treating that
 * N/A as "missing" is what pulled development master parcels into unit
 * quotes.
 */
function lotApplicabilityFor({ propertySubtype, ownershipType }) {
  if (ownershipType === 'leased_land') return 'leased_land';
  if (ownershipType === 'residential_condominium' || ownershipType === 'commercial_condominium'
    || ownershipType === 'association_common_property') return 'common_master_parcel';
  if (ownershipType === 'leased_suite') return 'no_individual_lot';
  const subtype = normalizeSubtype(propertySubtype);
  if (subtype === 'condominium' || subtype === 'condo' || subtype === 'apartment') return 'common_master_parcel';
  if (ownershipType === 'fee_simple') return 'private_parcel';
  return 'unknown';
}

/**
 * Required measurements depend on property type and service scope — there is
 * no universal "sqft + lot + type = complete".
 */
function requiredMeasurements({ propertySubtype, ownershipType, serviceScope }) {
  const applicability = lotApplicabilityFor({ propertySubtype, ownershipType });
  switch (serviceScope) {
    case 'residential_unit':
      return ['residential_unit_area_sqft'];
    case 'commercial_suite':
      return ['commercial_suite_area_sqft'];
    case 'entire_residential_structure': {
      const required = ['residential_living_area_sqft'];
      if (applicability === 'private_parcel') required.push('private_lot_area_sqft');
      return required;
    }
    case 'entire_commercial_building':
      return ['building_area_sqft'];
    case 'multi_building_commercial_parcel':
      return ['building_area_sqft'];
    case 'association_common_area':
      return ['building_area_sqft'];
    default:
      return [];
  }
}

// ── Selection ───────────────────────────────────────────────────

// Structure-area kinds acceptable per service scope, in preference order.
// Whole-building figures are NEVER acceptable substitutes for a unit/suite —
// wrong scope is not competing evidence, it's the wrong fact.
const STRUCTURE_KINDS_BY_SCOPE = {
  residential_unit: ['residential_unit_area_sqft', 'residential_living_area_sqft', 'residential_heated_area_sqft'],
  entire_residential_structure: ['residential_living_area_sqft', 'residential_heated_area_sqft', 'residential_unit_area_sqft'],
  commercial_suite: ['commercial_suite_area_sqft', 'gross_leasable_area_sqft'],
  entire_commercial_building: ['building_area_sqft', 'gross_building_area_sqft'],
  multi_building_commercial_parcel: ['building_area_sqft', 'gross_building_area_sqft'],
  association_common_area: ['building_area_sqft', 'gross_building_area_sqft'],
};

// Scopes a unit/suite-targeted selection may draw from, per structure kind.
const UNIT_SCOPES = new Set(['unit', 'suite']);

function isCommercialServiceScope(serviceScope) {
  return serviceScope === 'commercial_suite'
    || serviceScope === 'entire_commercial_building'
    || serviceScope === 'multi_building_commercial_parcel'
    || serviceScope === 'association_common_area';
}

function confidenceFromEvidence(ev) {
  if (!ev) return 0;
  const authority = Math.min(sourceAuthority(ev), 100) / 100;
  const directness = (DIRECTNESS_RANK[ev.directness] ?? 0) / 2;
  const extraction = (CONFIDENCE_RANK[ev.extractionConfidence] ?? 1) / 3;
  // Authority dominates; directness and extraction certainty attenuate.
  return Math.round(authority * (0.6 + 0.2 * directness + 0.2 * extraction) * 100) / 100;
}

function selectStructureArea({ serviceScope, evidence, warnings }) {
  const kinds = STRUCTURE_KINDS_BY_SCOPE[serviceScope] || [];
  const unresolved = {
    value: null, kind: 'unknown', scope: 'unknown',
    pricingValue: null, pricingDisposition: null,
    confidence: 0, selectedEvidenceIds: [],
  };
  if (!kinds.length) return unresolved;

  const areaEvidence = evidence.filter((ev) => kinds.includes(ev.field) && positive(ev.value));

  // Multi-building parcel: sum every distinct building — but ONLY when the
  // service scope explicitly covers all of them.
  if (serviceScope === 'multi_building_commercial_parcel' || serviceScope === 'association_common_area') {
    const buildingRows = areaEvidence.filter((ev) => ev.scope === 'building' || ev.scope === 'multi_building_parcel');
    if (!buildingRows.length) return unresolved;
    const total = buildingRows.reduce((sum, ev) => sum + Number(ev.value), 0);
    return finishArea({
      value: total,
      kind: buildingRows[0].field,
      scope: 'multi_building_parcel',
      selectedEvidenceIds: buildingRows.map((ev) => ev.id).filter(Boolean),
      confidence: Math.min(...buildingRows.map(confidenceFromEvidence)),
      commercial: true,
    });
  }

  const unitTarget = serviceScope === 'residential_unit' || serviceScope === 'commercial_suite';
  for (const kind of kinds) {
    let candidates = areaEvidence.filter((ev) => ev.field === kind);
    if (unitTarget) {
      // A whole-building figure must never stand in for the unit/suite.
      candidates = candidates.filter((ev) => UNIT_SCOPES.has(ev.scope) || ev.scope === 'unknown');
    }
    if (serviceScope === 'entire_commercial_building') {
      // Multiple distinct building rows = ambiguous target: selecting the
      // largest silently under- or over-states the property. Unresolved.
      const distinctBuildings = new Set(candidates.map((ev) => ev.sourceRecordId || ev.id));
      if (distinctBuildings.size > 1) {
        warnings.push('multiple distinct buildings on the parcel — confirm which building(s) the service covers');
        continue;
      }
    }
    if (!candidates.length) continue;
    const best = [...candidates].sort(compareEvidence)[0];
    return finishArea({
      value: Number(best.value),
      kind,
      scope: best.scope || 'unknown',
      selectedEvidenceIds: [best.id].filter(Boolean),
      confidence: confidenceFromEvidence(best),
      commercial: isCommercialServiceScope(serviceScope),
    });
  }
  return unresolved;
}

// Pricing disposition WITHOUT mutating the fact. Commercial structures over
// the relationship-quote threshold carry no pricing value at all — they are
// operator-priced by rule.
function finishArea({ value, kind, scope, selectedEvidenceIds, confidence, commercial }) {
  let pricingValue = value;
  let pricingDisposition = null;
  if (commercial && value > COMMERCIAL_RELATIONSHIP_QUOTE_SQFT) {
    pricingValue = null;
    pricingDisposition = 'relationship_quote';
  }
  return { value, kind, scope, pricingValue, pricingDisposition, confidence, selectedEvidenceIds };
}

function selectStories({ serviceScope, evidence, warnings }) {
  const byKind = (kind) => evidence
    .filter((ev) => ev.field === kind && positive(ev.value))
    .sort(compareEvidence)[0] || null;

  const building = byKind('building_stories');
  const unit = byKind('unit_stories');
  const occupied = byKind('occupied_stories');

  const lowConfidenceInference = (ev) => ev
    && (DIRECTNESS_RANK[ev.directness] ?? 0) === 0
    && (CONFIDENCE_RANK[ev.extractionConfidence] ?? 0) <= 1;

  // A unit-scoped service prices the unit's own stories, never the
  // building's — a 1-level condo in a 3-story building is 1 story of
  // treated space.
  const unitTarget = serviceScope === 'residential_unit' || serviceScope === 'commercial_suite';
  let pricingPick = unitTarget ? (unit || occupied) : (building || unit);
  if (lowConfidenceInference(pricingPick)) {
    warnings.push('story count is a low-confidence inference — confirm before story-sensitive pricing');
    pricingPick = null;
  }

  const selected = [building, unit, occupied].filter(Boolean);
  return {
    buildingStories: building ? Number(building.value) : null,
    unitStories: unit ? Number(unit.value) : null,
    occupiedStories: occupied ? Number(occupied.value) : null,
    pricingStories: pricingPick ? Number(pricingPick.value) : null,
    confidence: pricingPick ? confidenceFromEvidence(pricingPick) : 0,
    selectedEvidenceIds: selected.map((ev) => ev.id).filter(Boolean),
  };
}

function selectLot({ propertySubtype, ownershipType, evidence }) {
  const applicability = lotApplicabilityFor({ propertySubtype, ownershipType });
  const byField = (field, scopes) => evidence
    .filter((ev) => ev.field === field && positive(ev.value)
      && (!scopes || scopes.includes(ev.scope || 'unknown')))
    .sort(compareEvidence)[0] || null;

  const privateLot = byField('private_lot_area_sqft', null);
  const parcel = byField('parcel_area_sqft', ['parcel', 'unknown']);
  const masterParcel = byField('parcel_area_sqft', ['association', 'multi_building_parcel']);

  const hasPrivateLot = applicability === 'private_parcel';
  const selected = hasPrivateLot ? (privateLot || parcel) : null;
  return {
    // The development's master parcel is context, NEVER an individual lot.
    privateLotSqft: selected ? Number(selected.value) : null,
    parcelAreaSqft: parcel ? Number(parcel.value) : null,
    masterParcelAreaSqft: masterParcel ? Number(masterParcel.value) : null,
    applicability,
    confidence: selected ? confidenceFromEvidence(selected) : (hasPrivateLot ? 0 : 1),
    selectedEvidenceIds: [selected, masterParcel].filter(Boolean).map((ev) => ev.id).filter(Boolean),
  };
}

function confidenceLevelFor(confidence) {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.45) return 'medium';
  return 'low';
}

/**
 * Deterministic facts selection over deduplicated evidence.
 *
 * @param {object} input
 *   normalizedAddress, parcelId?, occupancyClass?, propertySubtype,
 *   ownershipType, serviceScope, evidence: MeasurementEvidence[]
 * @returns PropertyFactsV2
 */
function selectPropertyFactsV2(input) {
  const warnings = [];
  const serviceScope = SERVICE_SCOPES.includes(input?.serviceScope) ? input.serviceScope : 'unknown';
  const deduped = dedupeEvidence(input?.evidence);

  const structureArea = selectStructureArea({ serviceScope, evidence: deduped, warnings });
  const stories = selectStories({ serviceScope, evidence: deduped, warnings });
  const lot = selectLot({
    propertySubtype: input?.propertySubtype,
    ownershipType: input?.ownershipType,
    evidence: deduped,
  });

  const required = requiredMeasurements({
    propertySubtype: input?.propertySubtype,
    ownershipType: input?.ownershipType,
    serviceScope,
  });
  const resolvedKinds = new Set([
    ...(structureArea.value != null ? STRUCTURE_KINDS_BY_SCOPE[serviceScope] || [] : []),
    ...(lot.privateLotSqft != null || lot.applicability !== 'private_parcel' ? ['private_lot_area_sqft'] : []),
  ]);
  // The selected structure kind satisfies any required area kind for the
  // scope (preference order already picked the best available kind).
  const missing = required.filter((kind) => !resolvedKinds.has(kind));
  const requiresConfirmation = missing.length > 0 || warnings.length > 0;
  if (missing.length) warnings.push(`unresolved required measurements: ${missing.join(', ')}`);

  const componentConfidences = [
    structureArea.value != null ? structureArea.confidence : null,
    lot.applicability !== 'private_parcel' || lot.privateLotSqft != null ? lot.confidence : 0,
  ].filter((v) => v != null);
  const confidence = componentConfidences.length
    ? Math.round(Math.min(...componentConfidences) * 100) / 100
    : 0;

  return {
    normalizedAddress: input?.normalizedAddress || null,
    parcelId: input?.parcelId || null,
    occupancyClass: input?.occupancyClass || 'unknown',
    propertySubtype: normalizeSubtype(input?.propertySubtype) || 'unknown',
    ownershipType: input?.ownershipType || 'unknown',
    serviceScope,
    structureArea,
    stories,
    lot,
    confidence,
    confidenceLevel: confidenceLevelFor(confidence),
    requiresConfirmation,
    warnings,
    evidence: deduped,
  };
}

/**
 * Legacy V1 fields derived FROM the scoped selection — never the other way
 * around. A condo unit yields lotSize null (its true state), not the master
 * parcel.
 */
function deriveLegacyFields(facts) {
  return {
    squareFootage: positive(facts?.structureArea?.value),
    lotSize: positive(facts?.lot?.privateLotSqft),
    stories: positive(facts?.stories?.pricingStories),
  };
}

module.exports = {
  MEASUREMENT_KINDS,
  MEASUREMENT_SCOPES,
  SERVICE_SCOPES,
  SOURCE_AUTHORITY,
  COMMERCIAL_RELATIONSHIP_QUOTE_SQFT,
  valuesEquivalent,
  canonicalSourceUrl,
  independenceKeyFor,
  compareEvidence,
  dedupeEvidence,
  requiredMeasurements,
  lotApplicabilityFor,
  selectPropertyFactsV2,
  deriveLegacyFields,
};
