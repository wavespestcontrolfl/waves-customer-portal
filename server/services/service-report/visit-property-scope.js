// Shared visit → property SCOPE KEY resolver (codex round-4 P1: a fourth
// consecutive parallel reimplementation of this same stamp → property_id →
// ??? chain missed the source_estimate_id leg, so a secondary-property
// visit that is unstamped and carries no property_id — but WAS created
// from an estimate for that secondary property — was silently classified
// as the customer's primary property).
//
// customer-properties.js deliberately leaves an estimate-backed
// scheduled_services row unanchored (no property_id — see its own
// comments), so property_id alone is not a complete "is this row linked to
// a specific premises" test. cross-sell.js's own report-identity proof
// already resolved the estimate leg (estimates.address via
// normalizedEstimateStreet); this module is that resolution, pulled out so
// every property-scope compare in this codebase — cross-sell.js's report/
// portal offers AND the report's "upcoming visits" card — shares ONE
// implementation instead of drifting again on the next case nobody
// thought to re-derive by hand.
//
// Key format is estimate-property-linkage.js's own `street|city|zip` scope
// key (NOT customer-properties.js's opaque addressKey hash) — only the
// scope-key format can be produced from an estimate's free-text address,
// and only it carries the locality-lacks / locality-shares proofs a real
// property-equality compare needs (see sameResolvedProperty below).
const linkage = require('../estimate-property-linkage');

/**
 * Resolves the property scope key a scheduled_services-shaped row (or any
 * row carrying the same identity columns) identifies:
 *   1. its own IMMUTABLE stamp (service_address_line1/2/city/zip) — a
 *      property record's address can change (edit, merge) after dispatch
 *      stamped it, so the stamp is authoritative whenever present;
 *   2. else its property_id's CURRENT customer_properties address;
 *   3. else its source_estimate_id's CURRENT estimates.address;
 *   4. else NO EVIDENCE — the row carries none of the three.
 *
 * @param {object} row - service_address_line1/2/city/zip, property_id,
 *   source_estimate_id (any subset; missing fields read as absent).
 * @param {object} database - knex-compatible query builder.
 * @param {object} [caches] - optional Maps a caller may pre-populate with
 *   one batched `.whereIn()` read per page (property_id -> row|null,
 *   source_estimate_id -> row|null) to avoid a per-row query; a cache miss
 *   falls back to a single-row query and, when a cache was supplied,
 *   remembers the answer (including a null) for reuse within the caller's
 *   own scope.
 * @param {Map} [caches.propertyById]
 * @param {Map} [caches.estimateById]
 * @returns {Promise<{key: string|null, hasEvidence: boolean}>}
 *   - hasEvidence: false, key: null — the row carries no stamp,
 *     property_id, or source_estimate_id at all. The caller decides its
 *     own no-evidence fallback (a customer-mirror address, or a "prove
 *     single premises" search) — this resolver takes no position.
 *   - hasEvidence: true, key: null — a stamp or link WAS present but could
 *     not be resolved to a provable premises: the property_id row is gone,
 *     the source_estimate_id row is gone or carries no address, the
 *     resolved address has no locality at all (scopeKeyLacksLocality), or
 *     the lookup itself failed. FAIL CLOSED — the caller must exclude/
 *     refuse this row, never fall back to a different address.
 *   - hasEvidence: true, key: '<street>|<city>|<zip>' — resolved. Compare
 *     with sameResolvedProperty below, never a bare `===` (the key may
 *     legitimately carry only ONE locality segment).
 */
async function resolveVisitPropertyScope(row = {}, database, caches = {}) {
  const { propertyById, estimateById } = caches;

  if (row.service_address_line1) {
    // address_line2 (the unit) rides this key too — a condo/apartment
    // building's units share a street address, and dropping the unit
    // would key a visit against the whole BUILDING instead of the
    // customer's own unit.
    const key = linkage.normalizedStampedStreet(
      row.service_address_line1, row.service_address_line2,
      row.service_address_city, row.service_address_zip,
    );
    return (!key || linkage.scopeKeyLacksLocality(key))
      ? { key: null, hasEvidence: true }
      : { key, hasEvidence: true };
  }

  if (row.property_id) {
    let prop;
    if (propertyById && propertyById.has(row.property_id)) {
      prop = propertyById.get(row.property_id);
    } else {
      prop = await database('customer_properties')
        .where({ id: row.property_id })
        .first('address_line1', 'address_line2', 'city', 'zip')
        .catch(() => null);
      if (propertyById) propertyById.set(row.property_id, prop);
    }
    if (!prop) return { key: null, hasEvidence: true };
    const key = linkage.normalizedStampedStreet(prop.address_line1, prop.address_line2, prop.city, prop.zip);
    return (!key || linkage.scopeKeyLacksLocality(key))
      ? { key: null, hasEvidence: true }
      : { key, hasEvidence: true };
  }

  if (row.source_estimate_id) {
    let src;
    if (estimateById && estimateById.has(row.source_estimate_id)) {
      src = estimateById.get(row.source_estimate_id);
    } else {
      src = await database('estimates')
        .where({ id: row.source_estimate_id })
        .first('address')
        .catch(() => null);
      if (estimateById) estimateById.set(row.source_estimate_id, src);
    }
    if (!src?.address) return { key: null, hasEvidence: true };
    const key = linkage.normalizedEstimateStreet(src.address);
    return (!key || linkage.scopeKeyLacksLocality(key))
      ? { key: null, hasEvidence: true }
      : { key, hasEvidence: true };
  }

  return { key: null, hasEvidence: false };
}

/**
 * Two resolved scope keys identify the SAME premises: a street match
 * (sameScopeKey's per-locality-field wildcard — a field absent on either
 * side never itself disproves a match) AND at least one locality field
 * shared and equal (scopeKeysShareLocality) — the standard every existing
 * property-scope compare in this codebase uses. Never compare two
 * resolveVisitPropertyScope() keys with a bare `===`.
 */
function sameResolvedProperty(a, b) {
  if (!a || !b) return false;
  return linkage.sameScopeKey(a, b) && linkage.scopeKeysShareLocality(a, b);
}

module.exports = { resolveVisitPropertyScope, sameResolvedProperty };
