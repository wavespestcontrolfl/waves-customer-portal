/**
 * Travel gap — the ONE rule for "how much time must separate a candidate
 * window from the stops already on the calendar that day".
 *
 *   requiredGap(a, b) = driveMin(a, b) + SLOT_TRAVEL_BUFFER_MINUTES (default 15)
 *
 * Drive minutes come from route-optimizer's shared model via
 * auto-dispatch/geo.js driveMin (the same estimator find-time scores detours
 * with) — never a local copy. The fixed buffer is parking / setup / wrap-up
 * between two properties; it is one env value by owner ruling (2026-09-03),
 * NOT the dead service_zones.drive_buffer_minutes / services.scheduling_buffer_minutes
 * columns, which nothing reads.
 *
 * Every customer-facing offer lane that is not route-aware (estimate ASAP
 * capacity, spread windows, /book's hourly fan-out, rain-out day options)
 * filters with the same predicate the commit gates enforce
 * (occupancy.findConflictingVisits `travel` option), so an offered slot is
 * reservable and a reservable slot is offered — an offer/commit mismatch in
 * either direction is how the offer→reserve→409 dead-end loop happened.
 *
 * Deliberate boundaries:
 *   - Gate: GATE_SLOT_TRAVEL_GAP, read at CALL time. Off → violatesTravelGap
 *     always returns false and every caller is byte-for-byte legacy overlap.
 *   - Tech-blind, like occupancy.js: one active technician, so any two stops
 *     on a date are consecutive-route neighbours regardless of technician_id.
 *   - Fail-open on coordinates: a coordless side (ungeocoded customer, a
 *     divergent stamped rental with no pin) contributes ZERO drive minutes,
 *     exactly find-time's convention, but the fixed buffer still applies. A
 *     missing geocode never hides a slot; it only loses the drive term.
 *   - Between STOPS only. HQ start/end legs get drive time (find-time) but
 *     never the buffer — the buffer is the turnaround between two customers.
 *   - An overlap (negative gap) is also a violation, so a caller may use this
 *     as its only predicate; the SQL overlap fast paths stay where they are.
 */
const { driveMin } = require('../auto-dispatch/geo');
const { gateEnvValue } = require('../../config/feature-gates');

const DEFAULT_TRAVEL_BUFFER_MINUTES = 15;

function travelGapEnabled() {
  return gateEnvValue('GATE_SLOT_TRAVEL_GAP');
}

function travelBufferMinutes() {
  const raw = process.env.SLOT_TRAVEL_BUFFER_MINUTES;
  if (raw == null || String(raw).trim() === '') return DEFAULT_TRAVEL_BUFFER_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRAVEL_BUFFER_MINUTES;
  return Math.round(n);
}

function coordsOf(point) {
  if (!point) return null;
  const lat = point.lat != null ? Number(point.lat) : NaN;
  const lng = point.lng != null ? Number(point.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Minutes that must separate two stops: modeled drive (0 when a side has no pin) + buffer. */
function requiredGapMinutes(a, b) {
  return driveMin(coordsOf(a), coordsOf(b)) + travelBufferMinutes();
}

/**
 * candidate / stop: { startMin, endMin, lat?, lng? } (minutes from midnight).
 * Returns null when the pair is fine, else { gapMin, requiredMin } — gapMin is
 * the free time between the two windows (negative on overlap).
 * Gate-agnostic: callers decide via travelGapEnabled()/violatesTravelGap.
 */
function travelGapViolation(candidate, stop) {
  if (!candidate || !stop) return null;
  if (![candidate.startMin, candidate.endMin, stop.startMin, stop.endMin].every(Number.isFinite)) return null;
  const gapMin = stop.startMin >= candidate.endMin
    ? stop.startMin - candidate.endMin      // stop after the candidate
    : candidate.startMin - stop.endMin;     // stop before (negative = overlap)
  const requiredMin = requiredGapMinutes(candidate, stop);
  return gapMin < requiredMin ? { gapMin, requiredMin } : null;
}

/** True when the gate is on and ANY stop sits closer than the required gap. */
function violatesTravelGap(candidate, stops) {
  if (!travelGapEnabled()) return false;
  if (!Array.isArray(stops) || stops.length === 0) return false;
  return stops.some((stop) => travelGapViolation(candidate, stop) != null);
}

/**
 * One divergence-guarded read of a scheduled_services row's own pin for
 * commit gates that only hold the raw row (rebooker): the stamped
 * scheduled_services.lat/lng, else the non-divergent customer coords.
 * Returns { lat, lng } with nulls when unknown — never throws (fail-open).
 * Gate off → undefined WITHOUT a query, so a legacy move issues exactly the
 * statements it issued before (findConflictingVisits treats an undefined
 * `travel` as "overlap only").
 */
async function resolveStopCoords(db, scheduledServiceId) {
  if (!travelGapEnabled()) return undefined;
  const none = { lat: null, lng: null };
  if (!db || !scheduledServiceId) return none;
  try {
    const { guardedCoordSelects } = require('./day-stops');
    const row = await db('scheduled_services')
      .where('scheduled_services.id', scheduledServiceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(...guardedCoordSelects(db))
      .first();
    return coordsOf(row) || none;
  } catch (_err) {
    return none;
  }
}

module.exports = {
  DEFAULT_TRAVEL_BUFFER_MINUTES,
  travelGapEnabled,
  travelBufferMinutes,
  requiredGapMinutes,
  travelGapViolation,
  violatesTravelGap,
  resolveStopCoords,
};
