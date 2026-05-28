/**
 * facts-bank-auditor.js — classifies facts-bank readiness and answers the
 * sufficiency question the optimizer must ask before drafting any page:
 *
 *   "Can this exact city × service × county combination be safely drafted
 *    without inventing anything?"
 *
 * It does NOT generate content and it does NOT mutate anything. It reads the
 * facts-bank via facts-bank-loader, applies the sufficiency rules from
 * SCHEMA.md, and produces:
 *   - per-file classification (verified / draft / template / missing /
 *     expired / invalid_schema)
 *   - per-combination sufficiency verdict with gap_codes
 *   - a city × service readiness matrix
 *
 * The facts-sufficiency gate (wired into the autonomous pipeline) calls
 * `auditCombination()`. Dashboards and the facts-population worklist call
 * `auditAll()`.
 */

const loader = require('./facts-bank-loader');
const logger = require('../logger');

// Minimum usable (verified-or-stronger, in-TTL, public) fact counts required
// for each entity to be "sufficient". Mirrors SCHEMA.md.
const CITY_REQUIREMENTS = {
  // ≥2 facts of type neighborhood OR landmark
  placeFacts: { types: ['neighborhood', 'landmark'], min: 2 },
  // ≥1 home_type
  homeType: { types: ['home_type'], min: 1 },
  // ≥1 of pest_pressure / lawn_pattern / seasonality
  localPressure: { types: ['pest_pressure', 'lawn_pattern', 'seasonality'], min: 1 },
};

const SERVICE_REQUIREMENTS = {
  // ≥3 facts covering treatment_protocol / seasonality / pest_pressure.
  // (treatment_protocol facts are typed pest_pressure with treatment context
  //  in the current schema; we count across these types.)
  core: { types: ['pest_pressure', 'seasonality', 'treatment_protocol', 'lawn_pattern'], min: 3 },
};

const COUNTY_REQUIREMENTS = {
  regulation: { types: ['regulation'], min: 1 },
  context: { types: ['seasonality', 'landmark', 'home_type'], min: 1 },
};

const MAX_EXPIRED_FRACTION = 0.5; // >50% of facts expired → not sufficient

// Requirement names that may be satisfied by a SUPPLEMENT entity (the county),
// not just the entity's own facts. Construction/home-type patterns are
// genuinely regional, so a city need not duplicate them — the county file
// covers them. Place facts (neighborhoods/landmarks) and local pressure must
// remain city-specific and cannot be supplemented.
const SUPPLEMENTABLE = {
  city: new Set(['homeType']),
  service: new Set(),
  county: new Set(),
};

// ── per-file classification ─────────────────────────────────────────

/**
 * classifyFile(file, now) → {
 *   status, generation_allowed, usable_counts, expired_fraction,
 *   gap_codes[]
 * }
 *
 * `file` is the loader result (or null for missing). Status precedence:
 *   missing → invalid_schema → template → expired → draft → verified
 */
function classifyFile(file, now = new Date()) {
  if (file == null) {
    return { status: 'missing', generation_allowed: false, usable_counts: {}, gap_codes: ['file_missing'] };
  }
  if (file.ok === false) {
    return { status: 'invalid_schema', generation_allowed: false, usable_counts: {}, gap_codes: ['invalid_schema'], parse_error: file.parse_error };
  }
  if (file.schema_version !== loader.SUPPORTED_SCHEMA_VERSION) {
    return { status: 'invalid_schema', generation_allowed: false, usable_counts: {}, gap_codes: [`unsupported_schema_version_${file.schema_version}`] };
  }

  const declared = file.facts_bank_status;
  const copyFacts = loader.usableFacts(file, { purpose: 'copy', now });
  const byType = loader.factsByType(copyFacts);
  const usableCounts = Object.fromEntries(Object.entries(byType).map(([t, arr]) => [t, arr.length]));

  // Expired fraction across all declared facts.
  const allFacts = Array.isArray(file.facts) ? file.facts : [];
  const expiredCount = allFacts.filter((f) => loader.isFactExpired(f, now)).length;
  const expiredFraction = allFacts.length ? expiredCount / allFacts.length : 1;

  // A file marked template is never generation-capable, regardless of keys.
  if (declared === 'template' || file.generation_allowed !== true) {
    return {
      status: declared === 'template' ? 'template' : (declared || 'draft'),
      generation_allowed: false,
      usable_counts: usableCounts,
      expired_fraction: expiredFraction,
      gap_codes: declared === 'template' ? [`${file.entity_type}_file_template`] : [`${file.entity_type}_generation_not_allowed`],
    };
  }

  // generation_allowed === true and not template. Check expiry override.
  if (allFacts.length > 0 && expiredFraction > MAX_EXPIRED_FRACTION) {
    return {
      status: 'expired',
      generation_allowed: false,
      usable_counts: usableCounts,
      expired_fraction: expiredFraction,
      gap_codes: [`${file.entity_type}_facts_majority_expired`],
    };
  }

  return {
    status: declared || 'verified',
    generation_allowed: true,
    usable_counts: usableCounts,
    expired_fraction: expiredFraction,
    gap_codes: [],
  };
}

// ── requirement checking ────────────────────────────────────────────

function countAcrossTypes(usableCounts, types) {
  return types.reduce((sum, t) => sum + (usableCounts[t] || 0), 0);
}

function checkRequirements(entityType, usableCounts, file, supplementCounts = {}) {
  const gaps = [];
  const reqs = entityType === 'city' ? CITY_REQUIREMENTS
    : entityType === 'service' ? SERVICE_REQUIREMENTS
      : COUNTY_REQUIREMENTS;
  const supplementable = SUPPLEMENTABLE[entityType] || new Set();

  for (const [name, rule] of Object.entries(reqs)) {
    let have = countAcrossTypes(usableCounts, rule.types);
    // Some requirements (e.g. city home_type) may be met by the supplement
    // entity's facts of the same type — construction patterns are regional.
    if (supplementable.has(name)) {
      have += countAcrossTypes(supplementCounts, rule.types);
    }
    if (have < rule.min) {
      gaps.push(`${entityType}_insufficient_${name}_${have}of${rule.min}`);
    }
  }

  // City-specific: internal links (quote + calculator) and disallowed claims.
  if (entityType === 'city') {
    const links = file.internal_links || {};
    if (!links.quote && !links.city_hub) gaps.push('city_missing_quote_or_hub_link');
    if (!links.calculator) gaps.push('city_missing_calculator_link');
    if (!Array.isArray(file.disallowed_claim_patterns) || file.disallowed_claim_patterns.length === 0) {
      gaps.push('city_missing_disallowed_claims');
    }
  }

  if (entityType === 'service') {
    if (!Array.isArray(file.disallowed_claim_patterns) || file.disallowed_claim_patterns.length === 0) {
      gaps.push('service_missing_disallowed_claims');
    }
  }

  return gaps;
}

// ── per-entity audit ────────────────────────────────────────────────

function auditEntity(entityType, file, now = new Date(), supplementCounts = {}) {
  const cls = classifyFile(file, now);
  const result = {
    entity_type: entityType,
    entity_id: file?.entity_id || null,
    status: cls.status,
    generation_allowed: cls.generation_allowed,
    usable_counts: cls.usable_counts,
    expired_fraction: cls.expired_fraction ?? null,
    gap_codes: [...cls.gap_codes],
    sufficient: false,
  };
  if (file?.parse_error) result.parse_error = file.parse_error;

  // Only check requirements if the file is generation-capable; otherwise the
  // status gap codes already explain why it's blocked.
  if (cls.generation_allowed && file && file.ok !== false) {
    const reqGaps = checkRequirements(entityType, cls.usable_counts, file, supplementCounts);
    result.gap_codes.push(...reqGaps);
    result.sufficient = reqGaps.length === 0;
  }
  return result;
}

// Usable copy facts grouped by type for an entity file (the supplement input).
function usableCountsByType(file, now) {
  if (!file || file.ok === false) return {};
  const copyFacts = loader.usableFacts(file, { purpose: 'copy', now });
  const byType = loader.factsByType(copyFacts);
  return Object.fromEntries(Object.entries(byType).map(([t, arr]) => [t, arr.length]));
}

// ── combination audit (the gate's entry point) ──────────────────────

/**
 * auditCombination({ city, service, county }, opts) → {
 *   sufficient, generation_allowed, city, service, county,
 *   gap_codes[], files_status{}
 * }
 *
 * Loads all three files, audits each, and combines. County facts are
 * SUPPLEMENTAL — a city service page requires city + service to be
 * sufficient on their own; the county must be at least generation-capable
 * but its requirement bar is lower.
 */
async function auditCombination({ city, service, county = null }, opts = {}) {
  const now = opts.now || new Date();

  const cityFile = await loader.loadCity(city, opts);
  const serviceFile = await loader.loadService(service, opts);
  // Derive county from the city file when not passed.
  const countyId = county || cityFile?.county || null;
  const countyFile = countyId ? await loader.loadCounty(countyId, opts) : null;

  // County supplies regional home_type facts that can satisfy the city's
  // home_type requirement (construction patterns are regional, not per-city).
  const countySupplement = usableCountsByType(countyFile, now);
  const cityAudit = auditEntity('city', cityFile, now, countySupplement);
  const serviceAudit = auditEntity('service', serviceFile, now);
  const countyAudit = countyId ? auditEntity('county', countyFile, now) : null;

  const gapCodes = [];
  if (!cityAudit.sufficient) gapCodes.push(...cityAudit.gap_codes.map((g) => `city:${g}`));
  if (!serviceAudit.sufficient) gapCodes.push(...serviceAudit.gap_codes.map((g) => `service:${g}`));
  // County only blocks if it exists and is explicitly invalid; a missing
  // county file is a soft gap (supplemental).
  if (countyAudit && !countyAudit.generation_allowed) {
    gapCodes.push(...countyAudit.gap_codes.map((g) => `county:${g}`));
  }

  const sufficient = cityAudit.sufficient
    && serviceAudit.sufficient
    && (!countyAudit || countyAudit.generation_allowed);

  return {
    city,
    service,
    county: countyId,
    sufficient,
    generation_allowed: sufficient,
    disposition_hint: sufficient ? 'optimize' : 'facts_insufficient',
    gap_codes: gapCodes,
    files_status: {
      city: { id: city, status: cityAudit.status, sufficient: cityAudit.sufficient },
      service: { id: service, status: serviceAudit.status, sufficient: serviceAudit.sufficient },
      county: countyAudit ? { id: countyId, status: countyAudit.status, generation_allowed: countyAudit.generation_allowed } : null,
    },
    audits: { city: cityAudit, service: serviceAudit, county: countyAudit },
  };
}

// ── full audit / readiness matrix ───────────────────────────────────

/**
 * auditAll(opts) → {
 *   files: { cities[], services[], counties[] },
 *   matrix: [{ city, service, county, sufficient, gap_codes }],
 *   summary: { ... }
 * }
 *
 * Builds the full city × service readiness matrix. This is what the
 * facts-population worklist ranks.
 */
async function auditAll(opts = {}) {
  const now = opts.now || new Date();

  const [cityIds, serviceIds, countyIds] = await Promise.all([
    loader.listEntities('city', opts),
    loader.listEntities('service', opts),
    loader.listEntities('county', opts),
  ]);

  const cityFiles = {};
  const serviceFiles = {};
  const countyFiles = {};
  for (const id of cityIds) cityFiles[id] = await loader.loadCity(id, opts);
  for (const id of serviceIds) serviceFiles[id] = await loader.loadService(id, opts);
  for (const id of countyIds) countyFiles[id] = await loader.loadCounty(id, opts);

  const cityAudits = cityIds.map((id) => {
    const cityFile = cityFiles[id];
    const countyId = cityFile?.county || null;
    const supplement = usableCountsByType(countyId ? countyFiles[countyId] : null, now);
    return auditEntity('city', cityFile, now, supplement);
  });
  const serviceAudits = serviceIds.map((id) => auditEntity('service', serviceFiles[id], now));
  const countyAudits = countyIds.map((id) => auditEntity('county', countyFiles[id], now));

  const matrix = [];
  for (const city of cityIds) {
    const cityFile = cityFiles[city];
    const countyId = cityFile?.county || null;
    const countySupplement = usableCountsByType(countyId ? countyFiles[countyId] : null, now);
    const cityAudit = auditEntity('city', cityFile, now, countySupplement);
    const countyAudit = countyId ? auditEntity('county', countyFiles[countyId], now) : null;
    for (const service of serviceIds) {
      const serviceAudit = auditEntity('service', serviceFiles[service], now);
      const gap = [];
      if (!cityAudit.sufficient) gap.push(...cityAudit.gap_codes.map((g) => `city:${g}`));
      if (!serviceAudit.sufficient) gap.push(...serviceAudit.gap_codes.map((g) => `service:${g}`));
      if (countyAudit && !countyAudit.generation_allowed) gap.push(...countyAudit.gap_codes.map((g) => `county:${g}`));
      const sufficient = cityAudit.sufficient && serviceAudit.sufficient && (!countyAudit || countyAudit.generation_allowed);
      matrix.push({ city, service, county: countyId, sufficient, gap_codes: gap });
    }
  }

  const sufficientCombos = matrix.filter((m) => m.sufficient);
  return {
    files: {
      cities: cityAudits,
      services: serviceAudits,
      counties: countyAudits,
    },
    matrix,
    summary: {
      cities_total: cityIds.length,
      cities_sufficient: cityAudits.filter((a) => a.sufficient).length,
      services_total: serviceIds.length,
      services_sufficient: serviceAudits.filter((a) => a.sufficient).length,
      counties_total: countyIds.length,
      counties_generation_capable: countyAudits.filter((a) => a.generation_allowed).length,
      combinations_total: matrix.length,
      combinations_sufficient: sufficientCombos.length,
    },
  };
}

module.exports = {
  classifyFile,
  auditEntity,
  auditCombination,
  auditAll,
  // constants
  CITY_REQUIREMENTS,
  SERVICE_REQUIREMENTS,
  COUNTY_REQUIREMENTS,
};
