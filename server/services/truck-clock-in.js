/**
 * Truck clock-in, SHADOW ONLY (GATE_TRUCK_CLOCK_IN=shadow, owner 2026-10-25,
 * "this works").
 *
 * The rule: a technician's shift starts at the truck's first GPS arrival at a
 * stop, when the technician is not clocked in and has signed the Vehicle Use &
 * Commuting Agreement; if the truck's first trip of the day starts at the office,
 * the shift starts at that trip. Home-to-first-stop driving is unpaid commute
 * under the agreement. Training days stay by hand: a trainee rides in the
 * trainer's truck, so no Bouncie device maps to the trainee.
 *
 * THIS RELEASE ONLY RECORDS. It decides what the rule would do and writes one
 * truck_clock_in_shadow row; it never writes time_entries and never calls
 * time-tracking. Live clock-in (the shift write, the GPS time as clock_in, an
 * atomic claim and a persisted retry) is a separate later change.
 *
 * Called by the Bouncie receiver (routes/webhooks-bouncie.js) after the arrival
 * detector, once per GPS point, in its own try/catch.
 *
 * Two triggers; per technician per Eastern work day the FIRST one wins and later
 * ones do nothing (truck_clock_in_shadow is UNIQUE on technician + work date):
 *   first_arrival      the detector marked an arrival on this very call
 *                      (maybeMarkArrivedFromGps -> arrivalMarked).
 *   office_trip_start  a trip-start event whose point is within 200 m of the office
 *                      AND the truck's first trip-start of the Eastern work day (no
 *                      earlier trip-start in bouncie_webhook_log for the same truck).
 *
 * Modes (truckClockInMode()): off = nothing runs; shadow = decide and record.
 * Clock-out, the 9 PM reminder and the 11 PM close are not touched. Sends nothing.
 */
const db = require('../models/db');
const logger = require('./logger');
const RouteOptimizer = require('./route-optimizer');
const { distanceMeters, validLatitude, validLongitude } = require('./gps-arrival-detector');
const { hasCompletedIssuedRecord, VEHICLE_AGREEMENT_KEY } = require('./staff-onboarding');
const { truckClockInMode } = require('../config/feature-gates');
const { isStaffMaintenanceEnabled } = require('../middleware/staff-maintenance');
const { staffWorkDate } = require('../utils/staff-time-work-date');
const { parseETDateTime } = require('../utils/datetime-et');
const { redactBouncieWebhookPayload } = require('./bouncie-webhook-security');
const { normalizeEventType, pointFromPayload, stableJson, tripIdentity } = require('./bouncie-payload');

const OFFICE_RADIUS_METERS = 200;
// A trip-start older than this is a replayed or delayed webhook: a shift started
// "now" from it would be wrong, so it fires nothing (a later arrival still can).
const MAX_TRIP_START_AGE_MS = 10 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const DECIDED_MEMO_MAX = 2000;

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
    return { trigger: 'first_arrival', eventAt: at, eventKnown: known, lat, lng };
  }
  if (eventType === 'trip-start' && isWithinOfficeRadius({ lat, lng })) {
    if (known && now.getTime() - at.getTime() > MAX_TRIP_START_AGE_MS) return null;
    return { trigger: 'office_trip_start', eventAt: at, eventKnown: known, lat, lng };
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

// Two receivers (/api/bouncie/webhook and /api/webhooks/bouncie) each log a copy of
// the same Bouncie event under their own dedupe namespace, so an "earlier" trip-start
// row can be the very same trip as the current one. Trips are told apart by identity:
//   1. both carry a trip identity (transactionId / tripId): same trip iff equal;
//   2. else byte-identical payloads: the same delivery, so the same trip;
//   3. else both carry a trip-start time: same trip iff within 2 minutes;
//   4. else unknown, which counts as a DIFFERENT trip. That is the safe side: the
//      office trigger is suppressed (a later arrival still fires) instead of
//      starting paid time from a trip that may not be the day's first.
const SAME_TRIP_TOLERANCE_MS = 2 * 60 * 1000;

// Stored rows are redacted by the receivers (stringifyBounciePayload); redact the
// live payload the same way so a byte comparison sees the same bytes.
function asPayloadObject(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' ? redactBouncieWebhookPayload(parsed) : null;
}

function tripStartMs(payload) {
  const at = pointFromPayload(payload, 'trip-start')?.reported_at;
  const ms = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function isSameTrip(current, other) {
  if (!current || !other) return false;
  const currentId = tripIdentity(current);
  const otherId = tripIdentity(other);
  if (currentId && otherId) return currentId === otherId;
  if (stableJson(current) === stableJson(other)) return true;
  const currentMs = tripStartMs(current);
  const otherMs = tripStartMs(other);
  return currentMs != null && otherMs != null && Math.abs(currentMs - otherMs) <= SAME_TRIP_TOLERANCE_MS;
}

/**
 * Is the trip-start being handled the truck's first of the Eastern work day?
 * The durable log decides: an earlier row (lower id) for the same vehicle since the
 * start of the ET day whose stored event type normalizes to 'trip-start' (the
 * receiver's own normalizer, so a raw "tripStart" row counts too) AND that is a
 * different trip (isSameTrip) means no. The current event must have a log id and
 * its payload; without them the order is unknowable and the answer is null.
 */
async function isFirstTripStartOfDay({ imei, logId, workDate, payload, conn = db }) {
  const current = asPayloadObject(payload);
  if (!imei || logId == null || !current) return null;
  const earlier = () => conn('bouncie_webhook_log')
    .where('vehicle_imei', imei)
    .where('id', '<', logId)
    .whereRaw('received_at >= ?::timestamptz', [parseETDateTime(`${workDate}T00:00`).toISOString()]);
  const types = await earlier().distinct('event_type').select('event_type');
  const tripStartTypes = (types || [])
    .map((row) => row.event_type)
    .filter((type) => normalizeEventType(type) === 'trip-start');
  if (!tripStartTypes.length) return true;
  const rows = await earlier().whereIn('event_type', tripStartTypes).select('id', 'payload');
  return !(rows || []).some((row) => !isSameTrip(current, asPayloadObject(row.payload)));
}

function remember(key) {
  if (decidedToday.size >= DECIDED_MEMO_MAX) decidedToday.clear();
  decidedToday.add(key);
}

function claimRow(techId, workDate, fired, decision) {
  return {
    technician_id: techId,
    work_date: workDate,
    trigger: fired.trigger,
    event_at: fired.eventAt,
    would_clock_in: decision.wouldClockIn,
    skip_reason: decision.skipReason,
    lat: fired.lat,
    lng: fired.lng,
  };
}

async function insertClaim(conn, row) {
  const inserted = await conn('truck_clock_in_shadow')
    .insert(row)
    .onConflict(['technician_id', 'work_date'])
    .ignore()
    .returning('id');
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  return first ? (first.id || first) : null;
}

/**
 * The webhook hook. `tech` is the technician the Bouncie IMEI maps to; `logId` is
 * the bouncie_webhook_log row of the event being handled.
 * Returns { action, ... } for tests and logs: 'off', 'maintenance', 'no_trigger',
 * 'already_decided' or 'recorded'.
 */
async function maybeClockInFromTruck({ tech, eventType, point, arrival = null, logId = null, payload = null, now = new Date() } = {}) {
  const mode = truckClockInMode();
  if (mode !== 'shadow') return { action: 'off' };
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

  if (fired.trigger === 'office_trip_start') {
    const first = await isFirstTripStartOfDay({ imei: tech.bouncie_imei, logId, workDate, payload });
    if (first !== true) {
      return { action: 'no_trigger', reason: first === null ? 'trip_order_unknown' : 'not_first_trip' };
    }
  }

  // Shadow: decide and record, never write time_entries.
  const decision = await decideClockIn(tech.id);
  const claimId = await insertClaim(db, claimRow(tech.id, workDate, fired, decision));
  remember(key);
  // Another instance or sample won the day between the check and the insert.
  if (!claimId) return { action: 'already_decided', workDate };

  logger.info(`[truck-clock-in] ${mode} tech=${tech.id} ${workDate} ${fired.trigger} would_clock_in=${decision.wouldClockIn}${decision.skipReason ? ` skip=${decision.skipReason}` : ''}`);
  return {
    action: 'recorded',
    mode,
    workDate,
    trigger: fired.trigger,
    wouldClockIn: decision.wouldClockIn,
    skipReason: decision.skipReason,
  };
}

function resetMemo() {
  decidedToday.clear();
}

module.exports = {
  maybeClockInFromTruck,
  OFFICE_RADIUS_METERS,
  _test: { detectTrigger, decideClockIn, isFirstTripStartOfDay, isSameTrip, isWithinOfficeRadius, resetMemo, MAX_TRIP_START_AGE_MS },
};
