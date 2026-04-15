/**
 * Geofence matcher — converts raw Bouncie geo-zone events into business-logic decisions.
 *
 * Pure lookup service. Does NOT write state (no time entries, no tracking advance, no
 * notifications). The webhook handler in routes/bouncie-webhook.js orchestrates writes
 * by combining these helpers with time-tracking / tracking services.
 */
const db = require('../models/db');
const logger = require('./logger');

const EARTH_METERS = 6371000;

/**
 * Get a geofence setting by key, with env var override + default fallback.
 * Settings live in the `system_settings` table, keyed by `geofence.<name>`.
 */
async function getSetting(key, fallback) {
  const envKey = 'GEOFENCE_' + key.replace('geofence.', '').toUpperCase();
  if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
    return process.env[envKey];
  }
  try {
    const row = await db('system_settings').where({ key }).first();
    if (row && row.value !== null && row.value !== undefined) return row.value;
  } catch (err) {
    // table may not exist in a stale env
    logger.warn(`[geofence-matcher] system_settings lookup failed: ${err.message}`);
  }
  return fallback;
}

async function getMode() {
  return (await getSetting('geofence.mode', 'reminder')).toLowerCase();
}

async function getRadiusMeters() {
  return parseInt(await getSetting('geofence.radius_meters', '200'), 10) || 200;
}

async function getCooldownMinutes() {
  return parseInt(await getSetting('geofence.cooldown_minutes', '15'), 10) || 15;
}

async function getAutoCompleteOnExit() {
  const v = await getSetting('geofence.auto_complete_on_exit', 'false');
  return String(v).toLowerCase() === 'true';
}

/**
 * Look up the technician assigned to a Bouncie device IMEI.
 * Returns null if no match.
 */
async function getTechByImei(imei) {
  if (!imei) return null;
  try {
    return await db('technicians')
      .where({ bouncie_imei: String(imei) })
      .where('active', true)
      .first();
  } catch (err) {
    logger.error(`[geofence-matcher] getTechByImei failed: ${err.message}`);
    return null;
  }
}

/**
 * Haversine distance, meters.
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_METERS * Math.asin(Math.sqrt(a));
}

/**
 * Find all customers within `radiusMeters` of a point, ordered by distance.
 * Uses raw Haversine SQL (no PostGIS required).
 */
async function findNearbyCustomers(lat, lng, radiusMeters = 200) {
  if (lat == null || lng == null) return [];
  try {
    const rows = await db('customers')
      .whereNotNull('latitude')
      .whereNotNull('longitude')
      .select(
        '*',
        db.raw(
          `(${EARTH_METERS} * acos(
            LEAST(1, GREATEST(-1,
              cos(radians(?)) * cos(radians(latitude)) *
              cos(radians(longitude) - radians(?)) +
              sin(radians(?)) * sin(radians(latitude))
            ))
          )) AS distance_meters`,
          [lat, lng, lat]
        )
      )
      .havingRaw('distance_meters <= ?', [radiusMeters])
      .orderBy('distance_meters', 'asc')
      .limit(5);
    return rows;
  } catch (err) {
    logger.error(`[geofence-matcher] findNearbyCustomers failed: ${err.message}`);
    return [];
  }
}

/**
 * Nearest single customer within radius, or null.
 */
async function findNearbyCustomer(lat, lng, radiusMeters = 200) {
  const rows = await findNearbyCustomers(lat, lng, radiusMeters);
  return rows[0] || null;
}

/**
 * Find today's scheduled job for a tech + customer.
 * Falls back to any tech if the assigned-tech query misses (covers crew swaps).
 */
async function findScheduledJob(techId, customerId, date = new Date()) {
  const dateStr = date.toISOString().split('T')[0];
  try {
    const assigned = await db('scheduled_services')
      .where({ technician_id: techId, customer_id: customerId })
      .where('scheduled_date', dateStr)
      .whereNotIn('status', ['completed', 'cancelled'])
      .orderBy('window_start', 'asc')
      .first();
    if (assigned) return assigned;

    // Fallback: same customer, any tech (handles crew switches)
    return await db('scheduled_services')
      .where({ customer_id: customerId })
      .where('scheduled_date', dateStr)
      .whereNotIn('status', ['completed', 'cancelled'])
      .orderBy('window_start', 'asc')
      .first();
  } catch (err) {
    logger.error(`[geofence-matcher] findScheduledJob failed: ${err.message}`);
    return null;
  }
}

/**
 * Check for a recent processed ENTER event at the same tech+customer pair.
 * Prevents GPS-jitter double-fires.
 */
async function isDuplicateEnter(techId, customerId, cooldownMinutes = 15) {
  try {
    const cutoff = new Date(Date.now() - cooldownMinutes * 60_000);
    const row = await db('geofence_events')
      .where({ technician_id: techId, matched_customer_id: customerId, event_type: 'ENTER' })
      .whereIn('action_taken', ['timer_started', 'reminder_sent', 'timer_already_running'])
      .where('event_timestamp', '>', cutoff)
      .first();
    return !!row;
  } catch (err) {
    logger.error(`[geofence-matcher] isDuplicateEnter failed: ${err.message}`);
    return false;
  }
}

/**
 * Active ('job'/'active') time entry for a tech, or null.
 */
async function getActiveJobTimer(techId) {
  try {
    return await db('time_entries')
      .where({ technician_id: techId, entry_type: 'job', status: 'active' })
      .first();
  } catch (err) {
    logger.error(`[geofence-matcher] getActiveJobTimer failed: ${err.message}`);
    return null;
  }
}

/**
 * Insert a geofence_events row. Never throws.
 */
async function logEvent(row) {
  try {
    const [inserted] = await db('geofence_events')
      .insert({
        bouncie_imei: row.bouncie_imei,
        technician_id: row.technician_id || null,
        event_type: row.event_type,
        latitude: row.latitude,
        longitude: row.longitude,
        matched_customer_id: row.matched_customer_id || null,
        matched_job_id: row.matched_job_id || null,
        action_taken: row.action_taken,
        time_entry_id: row.time_entry_id || null,
        raw_payload: row.raw_payload ? JSON.stringify(row.raw_payload) : null,
        event_timestamp: row.event_timestamp,
      })
      .returning('*');
    return inserted;
  } catch (err) {
    logger.error(`[geofence-matcher] logEvent failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  getMode,
  getRadiusMeters,
  getCooldownMinutes,
  getAutoCompleteOnExit,
  getTechByImei,
  findNearbyCustomer,
  findNearbyCustomers,
  findScheduledJob,
  isDuplicateEnter,
  getActiveJobTimer,
  logEvent,
  distanceMeters,
};
