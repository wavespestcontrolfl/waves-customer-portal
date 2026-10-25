/**
 * Truck clock-in (GATE_TRUCK_CLOCK_IN, owner 2026-10-25, "this works").
 *
 * A technician's shift starts at the truck's first GPS arrival at a stop, when
 * the technician is not clocked in and has signed the Vehicle Use & Commuting
 * Agreement. If the truck's first trip of the day starts at the office, the shift
 * starts at that trip. Home-to-first-stop driving is unpaid commute under the
 * agreement; a day that starts at the shop is paid from the shop. Training days
 * stay by hand: a trainee rides in the trainer's truck, so no Bouncie device maps
 * to the trainee and nothing here fires for them.
 *
 * Called by the Bouncie receiver (routes/webhooks-bouncie.js) after the arrival
 * detector, once per GPS point, in its own try/catch.
 *
 * Two triggers; per technician per Eastern work day the FIRST one wins and later
 * ones do nothing (truck_clock_in_shadow is UNIQUE on technician + work_date):
 *   first_arrival      the detector marked an arrival on this very call
 *                      (maybeMarkArrivedFromGps -> arrivalMarked).
 *   office_trip_start  a trip-start event whose point is within 200 m of the office.
 *
 * Modes (truckClockInMode()): off = nothing runs; shadow = decide and record the
 * row, never write time_entries; true = record the same row and clock the
 * technician in (source 'truck_gps'). Clock-out, the 9 PM reminder and the 11 PM
 * close are not touched here. Sends nothing to anyone.
 */
const db = require('../models/db');
const logger = require('./logger');
const RouteOptimizer = require('./route-optimizer');
const { distanceMeters, validLatitude, validLongitude } = require('./gps-arrival-detector');
const { hasCompletedIssuedRecord, VEHICLE_AGREEMENT_KEY } = require('./staff-onboarding');
const { truckClockInMode } = require('../config/feature-gates');
const { isStaffMaintenanceEnabled } = require('../middleware/staff-maintenance');
const { staffWorkDate } = require('../utils/staff-time-work-date');

const OFFICE_RADIUS_METERS = 200;
// A trip-start older than this is a replayed or delayed webhook: a shift started
// "now" from it would be wrong, so it fires nothing (a later arrival still can).
const MAX_TRIP_START_AGE_MS = 10 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const DECIDED_MEMO_MAX = 2000;
const SOURCE = 'truck_gps';

// tech:workDate keys already decided (row exists) by this process, so a moving
// truck costs no query per GPS point after the first trigger of the day. The
// unique row is the durable half; it survives restarts and a second instance.
const decidedToday = new Set();

function eventInstant(point, now) {
  const ms = point?.reported_at ? new Date(point.reported_at).getTime() : NaN;
  if (!Number.isFinite(ms)) return { at: now, known: false };
  if (ms - now.getTime() > FUTURE_TOLERANCE_MS) return { at: now, known: false };
  return { at: new Date(ms), known: true };
}

function isWithinOfficeRadius(point) {
  const meters = distanceMeters(point?.lat, point?.lng, RouteOptimizer.HQ.lat, RouteOptimizer.HQ.lng);
  return meters != null && meters <= OFFICE_RADIUS_METERS;
}

/**
 * Which trigger (if any) this GPS point fires. Pure. `arrival` is what
 * maybeMarkArrivedFromGps returned for the same point.
 */
function detectTrigger({ eventType, point, arrival, now = new Date() }) {
  const lat = validLatitude(point?.lat);
  const lng = validLongitude(point?.lng);
  if (lat == null || lng == null) return null;
  const { at, known } = eventInstant(point, now);

  if (arrival && arrival.arrivalMarked === true) {
    return { trigger: 'first_arrival', eventAt: at, lat, lng };
  }
  if (eventType === 'trip-start' && isWithinOfficeRadius({ lat, lng })) {
    if (known && now.getTime() - at.getTime() > MAX_TRIP_START_AGE_MS) return null;
    return { trigger: 'office_trip_start', eventAt: at, lat, lng };
  }
  return null;
}

/**
 * Would this technician be clocked in? { wouldClockIn, skipReason }. Reads only.
 * The agreement is the completed Vehicle Use & Commuting Agreement form
 * (staff.vehicle-use-commuting-agreement) on any issued version; a read that
 * fails is agreement_unknown, never a guess either way.
 */
async function decideClockIn(technicianId, conn = db) {
  const active = await conn('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
    .first('id');
  if (active) return { wouldClockIn: false, skipReason: 'already_clocked_in' };

  let signed;
  try {
    signed = await hasCompletedIssuedRecord(conn, technicianId, VEHICLE_AGREEMENT_KEY);
  } catch (err) {
    logger.warn(`[truck-clock-in] agreement lookup failed: ${err.message}`);
    return { wouldClockIn: false, skipReason: 'agreement_unknown' };
  }
  return signed
    ? { wouldClockIn: true, skipReason: null }
    : { wouldClockIn: false, skipReason: 'agreement_not_signed' };
}

function remember(key) {
  if (decidedToday.size >= DECIDED_MEMO_MAX) decidedToday.clear();
  decidedToday.add(key);
}

async function clockInFromTruck(technicianId, fired) {
  const timeTracking = require('./time-tracking');
  const label = fired.trigger === 'first_arrival' ? 'first GPS arrival at a stop' : 'first trip started at the office';
  try {
    await timeTracking.clockIn(technicianId, {
      lat: fired.lat,
      lng: fired.lng,
      source: SOURCE,
      notes: `Truck clock-in: ${label}`,
    });
    return { wouldClockIn: true, skipReason: null };
  } catch (err) {
    if (err && err.code === 'ALREADY_CLOCKED_IN') {
      return { wouldClockIn: false, skipReason: 'already_clocked_in' };
    }
    logger.error(`[truck-clock-in] clock-in failed for ${technicianId}: ${err && err.message}`);
    return { wouldClockIn: false, skipReason: 'clock_in_failed' };
  }
}

/**
 * The webhook hook. `tech` is the technician the Bouncie IMEI maps to.
 * Returns { action, ... } for tests and logs: 'off', 'maintenance', 'no_trigger',
 * 'already_decided' or 'recorded'.
 */
async function maybeClockInFromTruck({ tech, eventType, point, arrival = null, now = new Date() } = {}) {
  const mode = truckClockInMode();
  if (mode === 'off') return { action: 'off' };
  if (!tech?.id) return { action: 'no_trigger' };
  if (isStaffMaintenanceEnabled()) return { action: 'maintenance' };

  const fired = detectTrigger({ eventType, point, arrival, now });
  if (!fired) return { action: 'no_trigger' };

  const workDate = staffWorkDate(fired.eventAt);
  const key = `${tech.id}:${workDate}`;
  if (decidedToday.has(key)) return { action: 'already_decided', workDate };

  const existing = await db('truck_clock_in_shadow')
    .where({ technician_id: tech.id, work_date: workDate })
    .first('id');
  if (existing) {
    remember(key);
    return { action: 'already_decided', workDate };
  }

  const decision = await decideClockIn(tech.id);
  const inserted = await db('truck_clock_in_shadow')
    .insert({
      technician_id: tech.id,
      work_date: workDate,
      trigger: fired.trigger,
      event_at: fired.eventAt,
      would_clock_in: decision.wouldClockIn,
      skip_reason: decision.skipReason,
      lat: fired.lat,
      lng: fired.lng,
    })
    .onConflict(['technician_id', 'work_date'])
    .ignore()
    .returning('id');
  remember(key);
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  // Another instance or sample won the day between the check and the insert.
  if (!row) return { action: 'already_decided', workDate };

  let outcome = decision;
  if (mode === 'true' && decision.wouldClockIn) {
    outcome = await clockInFromTruck(tech.id, fired);
    if (!outcome.wouldClockIn) {
      // The row records what actually happened, not what was planned.
      await db('truck_clock_in_shadow')
        .where({ id: row.id || row })
        .update({ would_clock_in: false, skip_reason: outcome.skipReason });
    }
  }

  logger.info(`[truck-clock-in] ${mode} tech=${tech.id} ${workDate} ${fired.trigger} would_clock_in=${outcome.wouldClockIn}${outcome.skipReason ? ` skip=${outcome.skipReason}` : ''}`);
  return {
    action: 'recorded',
    mode,
    workDate,
    trigger: fired.trigger,
    wouldClockIn: outcome.wouldClockIn,
    skipReason: outcome.skipReason,
  };
}

function resetMemo() {
  decidedToday.clear();
}

module.exports = {
  maybeClockInFromTruck,
  OFFICE_RADIUS_METERS,
  SOURCE,
  _test: { detectTrigger, decideClockIn, isWithinOfficeRadius, resetMemo, MAX_TRIP_START_AGE_MS },
};
