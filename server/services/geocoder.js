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
    logger.warn(`[geocoder] Geocoding failed for "${address}": ${data.status}`);
    memo.set(address, null);
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

module.exports = {
  geocodeAddress,
  ensureCustomerGeocoded,
  buildAddress,
};
