/**
 * Address → lat/lng via Google Geocoding API, with DB-backed cache.
 *
 * Also provides `ensureCustomerGeocoded` which fills `customers.latitude/longitude`
 * for a single customer on demand (used by geofence matcher + customer create/update).
 */
const db = require('../models/db');
const logger = require('./logger');

const GOOGLE_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

// In-process memo (speeds up batch runs; process restart clears)
const memo = new Map();

function buildAddress(c) {
  return [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(', ').trim();
}

/**
 * Geocode a free-form address string, reporting whether a failure is
 * permanent. Returns { location: {lat,lng}|null, permanent: boolean } —
 * `permanent` is true only for answers that will never change without an
 * address edit (empty address, ZERO_RESULTS); quota / config / network
 * failures are transient and safe to retry.
 */
async function geocodeAddressWithStatus(address) {
  if (!address) return { location: null, permanent: true };
  if (memo.has(address)) {
    const cached = memo.get(address);
    // memo only ever stores null for ZERO_RESULTS, so a cached null is permanent.
    return { location: cached, permanent: cached === null };
  }
  if (!GOOGLE_KEY) {
    logger.warn('[geocoder] GOOGLE_API_KEY not set');
    return { location: null, permanent: false };
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const { lat, lng } = data.results[0].geometry.location;
      const result = { lat, lng };
      memo.set(address, result);
      return { location: result, permanent: false };
    }
    logger.warn(`[geocoder] Geocoding failed: ${data.status}`);
    // Only memoize ZERO_RESULTS — Google saying "this address truly
    // doesn't exist" is a permanent answer worth caching. Transient
    // codes (OVER_QUERY_LIMIT / REQUEST_DENIED / INVALID_REQUEST /
    // UNKNOWN_ERROR) must NOT be memoized so the next call hits the
    // API fresh after quota recovers / config is fixed. Without this
    // distinction a single transient quota blip would wedge the
    // address as null in-process until restart.
    if (data.status === 'ZERO_RESULTS') {
      memo.set(address, null);
      return { location: null, permanent: true };
    }
    return { location: null, permanent: false };
  } catch (err) {
    logger.error(`[geocoder] Geocoding error: ${err.message}`);
    return { location: null, permanent: false };
  }
}

/**
 * Geocode a free-form address string. Returns { lat, lng } or null.
 */
async function geocodeAddress(address) {
  const { location } = await geocodeAddressWithStatus(address);
  return location;
}

/**
 * Ensure a customer has lat/lng populated. Geocodes and saves if missing.
 * Returns { lat, lng } or null.
 */
async function ensureCustomerGeocoded(customerId) {
  const c = await db('customers').where({ id: customerId }).first();
  if (!c) return null;
  if (c.latitude != null && c.longitude != null) {
    return { lat: Number(c.latitude), lng: Number(c.longitude) };
  }
  const address = buildAddress(c);
  const result = await geocodeAddress(address);
  if (!result) return null;
  await db('customers').where({ id: customerId }).update({
    latitude: result.lat,
    longitude: result.lng,
    updated_at: new Date(),
  });
  return result;
}

/**
 * Backstop sweep: geocode customers whose create path left latitude/longitude
 * NULL. Several booking/webhook create paths never call ensureCustomerGeocoded,
 * and the paths that do fire-and-forget it, so a transient Google failure
 * leaves the customer permanently coordinate-less — which silently drops
 * their stops from route optimization. Newest customers first.
 */
// Customers whose CURRENT address permanently failed to geocode
// (ZERO_RESULTS), keyed id → the address string that failed. Skipped on
// later passes so a block of bad addresses at the top of the newest-first
// ordering can't starve older customers out of the batch. Exclusions are
// pruned as soon as the customer's address no longer matches the failed
// one, so an address fix re-enters the sweep without waiting for a
// restart. Process restart clears it entirely (stuck rows retry).
const sweepUnresolved = new Map();

const SWEEP_UNRESOLVED_CAP = 2000;

// Drop exclusions whose customer address has changed since the failure —
// the corrected address deserves a fresh geocode attempt.
async function pruneStaleExclusions() {
  if (!sweepUnresolved.size) return;
  const ids = Array.from(sweepUnresolved.keys());
  const rows = await db('customers')
    .whereIn('id', ids)
    .select('id', 'address_line1', 'city', 'state', 'zip');
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [id, failedAddress] of sweepUnresolved) {
    const current = byId.get(id);
    if (!current || buildAddress(current) !== failedAddress) {
      sweepUnresolved.delete(id);
    }
  }
}

async function sweepUngeocodedCustomers({ limit = 25 } = {}) {
  // Excluding in the query (not post-filter) so a backlog of unresolvable
  // rows can never crowd eligible older customers out of the batch. The
  // map is capped; clearing it just means stuck rows get retried.
  if (sweepUnresolved.size > SWEEP_UNRESOLVED_CAP) sweepUnresolved.clear();
  await pruneStaleExclusions();
  const excluded = Array.from(sweepUnresolved.keys());
  const rows = await db('customers')
    .whereNull('deleted_at')
    .where(function () {
      this.whereNull('latitude').orWhereNull('longitude');
    })
    .whereNotNull('address_line1')
    .modify((q) => {
      if (excluded.length) q.whereNotIn('id', excluded);
    })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id');

  const results = { checked: rows.length, geocoded: 0, unresolved: 0 };
  for (const row of rows) {
    try {
      const c = await db('customers').where({ id: row.id }).first();
      if (!c) continue;
      if (c.latitude != null && c.longitude != null) {
        results.geocoded += 1;
        continue;
      }
      const address = buildAddress(c);
      const { location, permanent } = await geocodeAddressWithStatus(address);
      if (location) {
        // Guard against a concurrent edit: only write if the address we
        // geocoded is still the customer's address and both coordinates
        // still hold the values we read (either may be half-set — e.g.
        // latitude present, longitude null). A raced row counts as
        // unresolved and retries next pass.
        let guarded = db('customers').where({ id: row.id });
        for (const [col, val] of [['latitude', c.latitude], ['longitude', c.longitude]]) {
          guarded = val == null ? guarded.whereNull(col) : guarded.where(col, val);
        }
        for (const col of ['address_line1', 'city', 'state', 'zip']) {
          guarded = c[col] == null ? guarded.whereNull(col) : guarded.where(col, c[col]);
        }
        const written = await guarded.update({
          latitude: location.lat,
          longitude: location.lng,
          updated_at: new Date(),
        });
        if (written) results.geocoded += 1;
        else results.unresolved += 1;
      } else {
        results.unresolved += 1;
        // Only permanent failures (ZERO_RESULTS for this exact address) are
        // excluded from future sweeps — and only while the address still
        // matches (see pruneStaleExclusions). Transient failures (quota,
        // network, config) stay eligible and retry on the next hourly pass.
        if (permanent) sweepUnresolved.set(row.id, address);
      }
    } catch (err) {
      results.unresolved += 1;
      logger.error(`[geocoder] sweep failed for customer ${row.id}: ${err.message}`);
    }
  }
  if (results.checked > 0) {
    logger.info(
      `[geocoder] backstop sweep: checked=${results.checked}, ` +
      `geocoded=${results.geocoded}, unresolved=${results.unresolved}`,
    );
  }
  return results;
}

module.exports = {
  geocodeAddress,
  geocodeAddressWithStatus,
  ensureCustomerGeocoded,
  buildAddress,
  sweepUngeocodedCustomers,
};
