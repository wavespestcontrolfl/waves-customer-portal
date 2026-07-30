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
 * Geocode a free-form address string. Returns { lat, lng } or null.
 */
async function geocodeAddress(address) {
  if (!address) return null;
  if (memo.has(address)) return memo.get(address);
  if (!GOOGLE_KEY) {
    logger.warn('[geocoder] GOOGLE_API_KEY not set');
    return null;
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const { lat, lng } = data.results[0].geometry.location;
      const result = { lat, lng };
      memo.set(address, result);
      return result;
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
    }
    return null;
  } catch (err) {
    logger.error(`[geocoder] Geocoding error: ${err.message}`);
    return null;
  }
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
// Ids that failed to resolve during this process's sweeps. Skipped on later
// passes so a block of permanently bad addresses at the top of the
// newest-first ordering can't starve older customers out of the batch.
// Process restart clears it, giving stuck rows a fresh retry each deploy;
// admin address edits re-geocode directly so a fix never waits on this set.
const sweepUnresolvedIds = new Set();

async function sweepUngeocodedCustomers({ limit = 25 } = {}) {
  const candidates = await db('customers')
    .whereNull('deleted_at')
    .where(function () {
      this.whereNull('latitude').orWhereNull('longitude');
    })
    .whereNotNull('address_line1')
    .orderBy('created_at', 'desc')
    .limit(Math.max(limit * 8, 200))
    .select('id');
  const rows = candidates.filter((r) => !sweepUnresolvedIds.has(r.id)).slice(0, limit);

  const results = { checked: rows.length, geocoded: 0, unresolved: 0 };
  for (const row of rows) {
    try {
      const geo = await ensureCustomerGeocoded(row.id);
      if (geo) {
        results.geocoded += 1;
      } else {
        results.unresolved += 1;
        sweepUnresolvedIds.add(row.id);
      }
    } catch (err) {
      results.unresolved += 1;
      sweepUnresolvedIds.add(row.id);
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
  ensureCustomerGeocoded,
  buildAddress,
  sweepUngeocodedCustomers,
};
