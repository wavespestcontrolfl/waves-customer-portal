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
 *   office_trip_start  a trip-start event whose point is within 200 m of the office
 *                      AND the truck's first trip-start of the Eastern work day (no
 *                      earlier trip-start in bouncie_webhook_log for the same truck).
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
const { parseETDateTime } = require('../utils/datetime-et');
const { normalizeEventType } = require('./bouncie-payload');

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
async function decideClockIn(technicianId, conn = db, { savepoint = false } = {}) {
  const active = await conn('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
    .first('id');
  if (active) return { wouldClockIn: false, skipReason: 'already_clocked_in' };

  let signed;
  try {
    // Inside the claim transaction a failed read would abort it (Postgres), so the
    // read runs in a savepoint: its failure is agreement_unknown and nothing more.
    signed = savepoint
      ? await conn.transaction((sp) => hasCompletedIssuedRecord(sp, technicianId, VEHICLE_AGREEMENT_KEY))
      : await hasCompletedIssuedRecord(conn, technicianId, VEHICLE_AGREEMENT_KEY);
  } catch (err) {
    logger.warn(`[truck-clock-in] agreement lookup failed: ${err.message}`);
    return { wouldClockIn: false, skipReason: 'agreement_unknown' };
  }
  return signed
    ? { wouldClockIn: true, skipReason: null }
    : { wouldClockIn: false, skipReason: 'agreement_not_signed' };
}

/**
 * Is the trip-start being handled the truck's first of the Eastern work day?
 * The durable log decides: any earlier row (lower id) for the same vehicle since
 * the start of the ET day whose stored event type normalizes to 'trip-start' (the
 * receiver's own normalizer, so a raw "tripStart" row counts too) means no.
 * The current event must have a log id; without one the order is unknowable and
 * the answer is null (fire nothing).
 */
async function isFirstTripStartOfDay({ imei, logId, workDate, conn = db }) {
  if (!imei || logId == null) return null;
  const dayStart = parseETDateTime(`${workDate}T00:00`);
  const types = await conn('bouncie_webhook_log')
    .where('vehicle_imei', imei)
    .where('id', '<', logId)
    .whereRaw('received_at >= ?::timestamptz', [dayStart.toISOString()])
    .distinct('event_type')
    .select('event_type');
  return !(types || []).some((row) => normalizeEventType(row.event_type) === 'trip-start');
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

function clockInOptions(fired) {
  const label = fired.trigger === 'first_arrival' ? 'first GPS arrival at a stop' : 'first trip started at the office';
  return {
    lat: fired.lat,
    lng: fired.lng,
    source: SOURCE,
    notes: `Truck clock-in: ${label}`,
    // The shift starts when the truck did, not when a late webhook arrived. Only
    // when the point carried its own time; otherwise the event time IS now.
    ...(fired.eventKnown ? { clockInAt: fired.eventAt } : {}),
  };
}

/**
 * 'true' mode: the claim row and the shift are ONE transaction. A transient
 * failure rolls both back (no claim, no memo), so a later point that day retries.
 * ALREADY_CLOCKED_IN is thrown before any write, so the transaction is still
 * usable: the claim row is updated to say so and commits.
 * Returns { lost: true } when another sample or instance already claimed the day.
 */
async function claimAndClockIn(tech, workDate, fired) {
  const timeTracking = require('./time-tracking');
  return db.transaction(async (trx) => {
    let decision = await decideClockIn(tech.id, trx, { savepoint: true });
    const claimId = await insertClaim(trx, claimRow(tech.id, workDate, fired, decision));
    if (!claimId) return { lost: true };
    if (!decision.wouldClockIn) return { lost: false, decision };
    try {
      await timeTracking.clockInInTransaction(trx, tech.id, clockInOptions(fired));
    } catch (err) {
      if (err && err.code === 'ALREADY_CLOCKED_IN') {
        decision = { wouldClockIn: false, skipReason: 'already_clocked_in' };
        await trx('truck_clock_in_shadow')
          .where({ id: claimId })
          .update({ would_clock_in: false, skip_reason: decision.skipReason });
        return { lost: false, decision };
      }
      throw err;
    }
    return { lost: false, decision };
  });
}

// Decide and record the day. 'true' = claim + shift in one transaction; shadow =
// claim only. Remembers the day only once it is settled (commit, or lost to a
// winner); a rolled-back failure rethrows with no claim row and no memo.
async function settleDay(mode, tech, workDate, fired, key) {
  if (mode === 'true') {
    let result;
    try {
      result = await claimAndClockIn(tech, workDate, fired);
    } catch (err) {
      logger.error(`[truck-clock-in] clock-in rolled back for ${tech.id}: ${err && err.message}`);
      throw err;
    }
    remember(key);
    return result;
  }
  const decision = await decideClockIn(tech.id);
  const claimId = await insertClaim(db, claimRow(tech.id, workDate, fired, decision));
  remember(key);
  // Another instance or sample won the day between the check and the insert.
  return claimId ? { lost: false, decision } : { lost: true };
}

/**
 * The webhook hook. `tech` is the technician the Bouncie IMEI maps to; `logId` is
 * the bouncie_webhook_log row of the event being handled.
 * Returns { action, ... } for tests and logs: 'off', 'maintenance', 'no_trigger',
 * 'already_decided' or 'recorded'.
 */
async function maybeClockInFromTruck({ tech, eventType, point, arrival = null, logId = null, now = new Date() } = {}) {
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

  if (fired.trigger === 'office_trip_start') {
    const first = await isFirstTripStartOfDay({ imei: tech.bouncie_imei, logId, workDate });
    if (first !== true) {
      return { action: 'no_trigger', reason: first === null ? 'trip_order_unknown' : 'not_first_trip' };
    }
  }

  const settled = await settleDay(mode, tech, workDate, fired, key);
  if (settled.lost) return { action: 'already_decided', workDate };
  const outcome = settled.decision;

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
  _test: { detectTrigger, decideClockIn, isFirstTripStartOfDay, isWithinOfficeRadius, resetMemo, MAX_TRIP_START_AGE_MS },
};
