/**
 * Geofence matcher — converts raw Bouncie geo-zone events into business-logic decisions.
 *
 * Pure lookup service. Does NOT write state (no time entries, no tracking advance, no
 * notifications). The webhook handler in routes/bouncie-webhook.js orchestrates writes
 * by combining these helpers with time-tracking / tracking services.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, etParts, addETDays } = require('../utils/datetime-et');

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

// Auto-flip settings: on EXIT from a customer's geofence, optionally
// flip the tech's next scheduled job to en_route + fire the customer
// SMS. All gated behind the OFF default — no behavior change until
// an admin explicitly enables. dry_run=true logs the intended action
// without firing SMS, for production observation.
async function getAutoFlipOnDeparture() {
  const v = await getSetting('geofence.auto_flip_on_departure', 'false');
  return String(v).toLowerCase() === 'true';
}

async function getAutoFlipDryRun() {
  const v = await getSetting('geofence.auto_flip_dry_run', 'true');
  return String(v).toLowerCase() === 'true';
}

async function getAutoFlipDwellMinutes() {
  return parseInt(await getSetting('geofence.auto_flip_dwell_minutes', '10'), 10) || 10;
}

async function getAutoFlipHorizonHours() {
  return parseInt(await getSetting('geofence.auto_flip_horizon_hours', '4'), 10) || 4;
}

async function getAutoFlipCooldownMinutes() {
  return parseInt(await getSetting('geofence.auto_flip_cooldown_minutes', '30'), 10) || 30;
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
 * Find the tech's next scheduled job after the given time, optionally
 * excluding a specific customer (so we don't auto-flip the customer
 * we just departed). Excludes already-completed/cancelled jobs and
 * any job whose track_state has already advanced past 'scheduled' (so
 * a tech who manually flipped en_route doesn't get re-flipped).
 *
 * Ordering matches admin-dispatch's day-plan: COALESCE(route_order,999)
 * first, then window_start. If ops manually re-sequenced a tech's day
 * (route_order set on rows), respect that sequence — chronological
 * window_start can be wrong when ops reorders jobs out of time order.
 *
 * TZ correctness: scheduled_date (DATE) and window_start/window_end
 * (TIME) are stored as ET wall-clock values. Server is UTC, so we
 * derive both via datetime-et helpers — never via toISOString(), which
 * would compare 1pm-ET as "17:00:00" against ET wall-clock window times.
 *
 * Cross-midnight: after a late-night EXIT (e.g. 11pm ET) the next job
 * may sit on tomorrow's date. We query both today (after the EXIT
 * time) and tomorrow (any time) and take the earliest.
 */
async function findNextScheduledJobForTech(techId, afterTime, excludeCustomerId = null) {
  if (!techId || !afterTime) return null;
  try {
    const exitDate = new Date(afterTime);
    const todayStr = etDateString(exitDate);
    const tomorrowStr = etDateString(addETDays(exitDate, 1));
    const et = etParts(exitDate);
    const timePart = `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}:${String(et.second).padStart(2, '0')}`;

    // SELECT * FROM scheduled_services
    //  WHERE technician_id = ?
    //    AND status NOT IN ('completed', 'cancelled')
    //    AND track_state = 'scheduled'
    //    AND ((scheduled_date = today AND (window_start >= time
    //             OR (window_end > time AND track_state='scheduled')))
    //      OR scheduled_date = tomorrow)
    //    AND (excludeCustomerId is null OR customer_id != ?)
    //  ORDER BY scheduled_date ASC,
    //           COALESCE(route_order, 999) ASC,
    //           window_start ASC
    //  LIMIT 1
    let q = db('scheduled_services')
      .where({ technician_id: techId })
      .whereNotIn('status', ['completed', 'cancelled'])
      .where('track_state', 'scheduled')
      .where(function () {
        this.where(function () {
          this.where('scheduled_date', todayStr)
            .where(function () {
              this.where('window_start', '>=', timePart)
                .orWhere('window_end', '>', timePart);
            });
        })
          .orWhere('scheduled_date', tomorrowStr);
      })
      .orderBy('scheduled_date', 'asc')
      .orderByRaw('COALESCE(route_order, 999) ASC')
      .orderBy('window_start', 'asc');
    if (excludeCustomerId) q = q.whereNot('customer_id', excludeCustomerId);
    return await q.first();
  } catch (err) {
    logger.error(`[geofence-matcher] findNextScheduledJobForTech failed: ${err.message}`);
    return null;
  }
}

/**
 * Look up the active time entry's elapsed minutes — used as the
 * dwell-time check for auto-flip. Returns null if no active timer
 * (caller should then skip auto-flip; we only trigger on EXIT after
 * a real on-site visit). Reads `clock_in` to compute elapsed.
 */
async function getActiveTimerDwellMinutes(techId) {
  try {
    const row = await db('time_entries')
      .where({ technician_id: techId, entry_type: 'job', status: 'active' })
      .first('clock_in');
    if (!row || !row.clock_in) return null;
    const elapsedMs = Date.now() - new Date(row.clock_in).getTime();
    return Math.floor(elapsedMs / 60000);
  } catch (err) {
    logger.error(`[geofence-matcher] getActiveTimerDwellMinutes failed: ${err.message}`);
    return null;
  }
}

/**
 * Check whether an auto-flip en-route SMS was already sent to this
 * customer recently. Reads `geofence_events` for action_taken values
 * that map to a sent SMS. Used to suppress departure-then-arrival
 * double SMS within the cooldown window.
 */
async function isRecentAutoFlipForCustomer(customerId, cooldownMinutes = 30) {
  if (!customerId) return false;
  try {
    const cutoff = new Date(Date.now() - cooldownMinutes * 60_000);
    const row = await db('geofence_events')
      .where({ matched_customer_id: customerId })
      .whereIn('action_taken', ['auto_flip_en_route', 'auto_flip_dry_run'])
      .where('event_timestamp', '>', cutoff)
      .first();
    return !!row;
  } catch (err) {
    logger.error(`[geofence-matcher] isRecentAutoFlipForCustomer failed: ${err.message}`);
    return false;
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
  getAutoFlipOnDeparture,
  getAutoFlipDryRun,
  getAutoFlipDwellMinutes,
  getAutoFlipHorizonHours,
  getAutoFlipCooldownMinutes,
  getTechByImei,
  findNearbyCustomer,
  findNearbyCustomers,
  findScheduledJob,
  findNextScheduledJobForTech,
  isDuplicateEnter,
  isRecentAutoFlipForCustomer,
  getActiveJobTimer,
  getActiveTimerDwellMinutes,
  logEvent,
  distanceMeters,
};
