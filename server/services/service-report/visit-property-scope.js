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

// True only when NOTHING on file contradicts "this customer has a single
// premises, the primary one" (codex #3367 PR r11 P1; moved here codex
// round-5 P1 so the upcoming-visits card can share it — a legacy
// no-evidence row on a multi-property account must not pass
// sameResolvedProperty against a primary-property report just because
// the customer mirror happens to be all either side has). Deliberately a
// PROOF of single-premises, not a search for a second one: an unreadable
// witness throws and the caller decides the fail-closed consequence (the
// whole card suppresses in cross-sell.js's unlinked-report branch; the
// one unscoped row excludes in the upcoming-visits card).
//
// options.unresolvedFails (default false, codex round-6 P1): an
// UNSTAMPED witness row whose property_id names no customer_properties
// row, or whose source_estimate_id names no estimate (or one with no
// address), is genuinely UNRESOLVABLE — it might be the primary, or it
// might be a second premises this account has, and there is no way to
// tell which. cross-sell.js's original callers treat that as "not
// evidence of a second premises" (`continue`) — a doctrine this function
// keeps by DEFAULT so cross-sell.js's own behavior and tests stay
// byte-identical. The upcoming-visits card cannot accept that risk: its
// mirror fallback is a "prove single-premises, THEN allow the fallback"
// gate, and an unresolved witness proves nothing either way — so it
// passes `{ unresolvedFails: true }` to fail the proof (return false)
// instead, matching its own fail-closed doctrine for every other
// unresolvable link in this module.
async function customerHasOnlyPrimaryPremises(database, customerId, customer, primaryStreet, { unresolvedFails = false } = {}) {
  // The eligibility flag the discount engine already trusts for multi-home
  // status — admins hand-set it for customers whose second property never
  // made it into customer_properties.
  if (customer?.has_multi_home === true) return false;
  const provablyPrimary = (key) => {
    if (!key) return false;
    if (!linkage.sameScopeKey(key, primaryStreet)) return false;
    // Same street, but disjoint locality evidence (city-only vs zip-only)
    // matches across cities under sameScopeKey's per-field wildcard — the
    // r6/r7 rule. A key with NO locality at all is the legacy partial stamp,
    // and it is UNPROVEN, not benign (codex #3367 PR r12): a secondary
    // property with the same street and unit in another city produces
    // exactly that key, so accepting it would declare the wrong premises
    // primary and publish an exact price from the wrong profile — the hole
    // the linked-report and estimate-seed guards already close by rejecting
    // scopeKeyLacksLocality outright. Same rejection here.
    if (linkage.scopeKeyLacksLocality(key)) return false;
    return linkage.scopeKeysShareLocality(key, primaryStreet);
  };
  // EVERY property row, active or not (pre-push P0): report tokens are
  // permanent, so the report being priced is frequently older than the
  // account's current shape. A secondary property that has since been
  // deactivated is exactly the premises a legacy unlinked record is likely
  // to belong to, and filtering it out makes the COALESCEd primary address
  // look proven. This proof asks "has this account EVER had a second
  // premises", not "does it have one today" — the live-count question that
  // refreshHasMultiHome answers is a different one.
  const properties = await database('customer_properties')
    .where({ customer_id: customerId })
    .select('address_line1', 'address_line2', 'city', 'zip');
  if (properties.length >= 2) return false;
  for (const row of properties) {
    if (!provablyPrimary(linkage.normalizedStampedStreet(row.address_line1, row.address_line2, row.city, row.zip))) {
      return false;
    }
  }
  // customer_properties is gated (GATE_CUSTOMER_PROPERTIES) and empty for
  // accounts that predate it, so the STAMPED visit addresses are the second
  // witness: dispatch stamps the premises it routed to, and a stamp that
  // cannot be proven to be the primary is a second premises on this account.
  const cols = await database('scheduled_services').columnInfo();
  if (!cols.service_address_line1) return true;
  const stampCols = ['service_address_line1'];
  for (const col of ['service_address_line2', 'service_address_city', 'service_address_zip']) {
    if (cols[col]) stampCols.push(col);
  }
  // property_id / source_estimate_id ride along so an UNSTAMPED row can be
  // resolved rather than waved through (codex #3367 PR r13): dispatch's own
  // order is stamp → property row → creating estimate → primary, and only
  // the property_id leg is covered by the customer_properties witness above.
  // A row that links to a secondary address through its creating ESTIMATE
  // would otherwise certify a multi-property account as single-premises.
  if (cols.property_id) stampCols.push('property_id');
  if (cols.source_estimate_id) stampCols.push('source_estimate_id');
  const rows = await database('scheduled_services')
    .where({ customer_id: customerId })
    .distinct(stampCols);
  for (const row of rows) {
    if (String(row.service_address_line1 || '').trim()) {
      if (!provablyPrimary(linkage.normalizedStampedStreet(
        row.service_address_line1, row.service_address_line2, row.service_address_city, row.service_address_zip
      ))) return false;
      continue;
    }
    // Unstamped: resolve the same way the linked-report branch does.
    if (row.property_id) {
      const prop = await database('customer_properties')
        .where({ id: row.property_id })
        .first('address_line1', 'address_line2', 'city', 'zip');
      // An unresolvable property link names no premises — the row is not
      // evidence of a second one (the linked-report branch suppresses on
      // it because THAT report is the one being priced; here the row is
      // just another visit on the account) — UNLESS the caller opted into
      // unresolvedFails: it might just as easily BE the second premises,
      // and there is no way to tell which from an unresolvable link alone.
      if (!prop) { if (unresolvedFails) return false; continue; }
      if (!provablyPrimary(linkage.normalizedStampedStreet(
        prop.address_line1, prop.address_line2, prop.city, prop.zip
      ))) return false;
      continue;
    }
    if (row.source_estimate_id) {
      const src = await database('estimates')
        .where({ id: row.source_estimate_id })
        .first('address');
      // Same unresolvedFails doctrine as the property_id leg above.
      if (!src?.address) { if (unresolvedFails) return false; continue; }
      if (!provablyPrimary(linkage.normalizedEstimateStreet(src.address))) return false;
      continue;
    }
    // Neither stamped nor linked → the absence of evidence, not evidence of
    // a second premises.
  }
  return true;
}

module.exports = { resolveVisitPropertyScope, sameResolvedProperty, customerHasOnlyPrimaryPremises };
