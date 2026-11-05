'use strict';

/**
 * Fills NULL start and end coordinates on mileage_log rows from the Bouncie GPS trail (GATE_MILEAGE_TRIP_COORDS).
 *
 * Why: Bouncie's trip-start and trip-end webhooks carry no location, and the trip-metrics event that creates the
 * mileage_log row carries none either, so every row was stored with NULL start_lat/start_lng/end_lat/end_lng. GPS
 * points arrive only in trip-data events, logged in bouncie_webhook_log under the same transactionId that
 * mileage_log keeps in bouncie_trip_id. The first point (by point time) of that transaction is where the trip began;
 * the last is where it ended. bouncie-truck-stops.js already reads and parses those events, so this reuses its read
 * (loadTruckTrips) and writes nothing but the four coordinate columns and updated_at.
 *
 * Rules:
 *  - A coordinate pair is filled only when BOTH its columns are NULL, and the UPDATE repeats that guard, so an
 *    existing coordinate is never overwritten, not even by a race with another writer.
 *  - A trip with no trip-data in the log is left alone.
 *  - Only SETTLED trips are filled, because trip-data batches can arrive late or out of order and the NULL-only guard
 *    would freeze a wrong early answer. A trip is settled ONLY when the log holds its trip-end event, that end time
 *    is at least SETTLE_MS ago, the log also holds its trip-start event, and the trail's first point is within
 *    BOUNDARY_TOLERANCE_MS of the start time and its last point within it of the end time. There is no date-based
 *    fallback: a trip dated yesterday may have ended minutes ago. Anything else is counted (noEndEvent, unsettled,
 *    noStartEvent, incompleteTrail) and left NULL for a later run. A trip whose trip-end event never arrives stays
 *    NULL, which is today's state.
 *  - is_business, purpose, deduction and classification columns are never touched (the tax review stays
 *    suggestion-only, owner policy).
 *  - A write needs GATE_MILEAGE_TRIP_COORDS=true; a dry run reads and counts without it.
 */
const logger = require('./logger');
const { loadTruckTrips, parsePayload } = require('./bouncie-truck-stops');
const { firstPresent } = require('./bouncie-payload');
const { mileageTripCoordsLive } = require('../config/feature-gates');
const { etDateString, addETDays, parseETDateTime, dateOnlyString } = require('../utils/datetime-et');

const DEFAULT_BATCH_SIZE = 300;
// Trips of one vehicle are read in groups no wider than this many calendar days, so the trip-data read stays small.
const GROUP_SPAN_DAYS = 7;
// A trip is dated by its start day and ends at most this many days after the group's last start day.
const END_SLACK_DAYS = 2;
const DAY_MS = 86400000;
const SETTLE_MS = 2 * 60 * 60 * 1000;
const BOUNDARY_TOLERANCE_MS = 3 * 60 * 1000;
const BOUNDARY_PAGE_SIZE = 500;
// Same late-arrival and early-read bounds as the trip-data read in bouncie-truck-stops.js.
const LOG_SLACK_MS = 12 * 60 * 60 * 1000;

const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const etDayStartMs = (day) => parseETDateTime(`${day}T00:00`).getTime();

/** A pair needs filling when both its columns are NULL (a half-filled pair is left for a person to look at). */
function whereStartMissing(q) { return q.whereNull('start_lat').whereNull('start_lng'); }
function whereEndMissing(q) { return q.whereNull('end_lat').whereNull('end_lng'); }

/** One page of bouncie rows that still lack a start or an end pair, after `afterId` (null = first page), by id. */
async function loadCandidates(conn, { afterId, batchSize, sinceDate, tripId }) {
  const query = conn('mileage_log')
    .where('source', 'bouncie')
    .whereNotNull('bouncie_trip_id')
    .whereNotNull('vehicle_id')
    .where((q) => q.where(whereStartMissing).orWhere(whereEndMissing));
  // mileage_log.id is a UUID: no cursor on the first page, then the last id returned.
  if (afterId != null) query.where('id', '>', afterId);
  if (sinceDate) query.where('trip_date', '>=', sinceDate);
  if (tripId) query.where('bouncie_trip_id', String(tripId));
  return query.orderBy('id').limit(batchSize)
    .select('id', 'vehicle_id', 'bouncie_trip_id', 'trip_date', 'start_lat', 'start_lng', 'end_lat', 'end_lng');
}

/** Rows of one vehicle sorted by day, cut into groups that each span at most GROUP_SPAN_DAYS days. */
function groupRows(rows) {
  const byVehicle = new Map();
  for (const row of rows) {
    const key = String(row.vehicle_id);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push({ ...row, day: dateOnlyString(row.trip_date) });
  }
  const groups = [];
  for (const [vehicle, list] of byVehicle) {
    list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    let current = null;
    for (const row of list) {
      if (!current || dayMs(row.day) - dayMs(current.firstDay) >= GROUP_SPAN_DAYS * DAY_MS) {
        current = { vehicle, firstDay: row.day, lastDay: row.day, rows: [] };
        groups.push(current);
      }
      current.lastDay = row.day;
      current.rows.push(row);
    }
  }
  return groups;
}

/** The log window of one group: trips are read from the start of its first day to two days past its last. */
function groupWindow(group) {
  const fromMs = etDayStartMs(group.firstDay);
  const toMs = etDayStartMs(etDateString(addETDays(parseETDateTime(`${group.lastDay}T12:00`), END_SLACK_DAYS)));
  return { fromMs, toMs };
}

/** The trips of one group, by trip id, read from the trip-data log. */
async function tripsForGroup(conn, group, now) {
  const { fromMs, toMs } = groupWindow(group);
  const trips = await loadTruckTrips(conn, group.vehicle, { fromMs, toMs, now });
  return new Map(trips.map((trip) => [trip.tripId, trip]));
}

/** One trip-start / trip-end event as { tripId, startMs?, endMs? }; null when it has no trip id or time. */
function boundaryFromPayload(rawPayload) {
  const payload = parsePayload(rawPayload);
  if (!payload) return null;
  const tripId = firstPresent(payload.transactionId, payload.transaction_id, payload.tripId, payload.trip_id);
  if (!tripId) return null;
  const startMs = Date.parse(payload.start?.timestamp);
  const endMs = Date.parse(payload.end?.timestamp);
  const boundary = { tripId: String(tripId) };
  if (Number.isFinite(startMs)) boundary.startMs = startMs;
  if (Number.isFinite(endMs)) boundary.endMs = endMs;
  return boundary.startMs != null || boundary.endMs != null ? boundary : null;
}

/** The trip-start / trip-end times the log holds for a group's vehicle and window: Map of trip id -> { startMs, endMs }. */
async function boundariesForGroup(conn, group, now) {
  const { fromMs, toMs } = groupWindow(group);
  const until = new Date(Math.min(now, toMs + LOG_SLACK_MS));
  const found = new Map();
  for (let afterId = null; ;) {
    const query = conn('bouncie_webhook_log')
      .where({ vehicle_imei: String(group.vehicle) })
      .whereIn('event_type', ['trip-start', 'trip-end'])
      .where('received_at', '>=', new Date(fromMs - LOG_SLACK_MS))
      .where('received_at', '<', until);
    if (afterId != null) query.where('id', '>', afterId);
    const rows = await query.orderBy('id').limit(BOUNDARY_PAGE_SIZE).select('id', 'payload');
    for (const row of rows) {
      const boundary = boundaryFromPayload(row.payload);
      if (boundary) found.set(boundary.tripId, { ...found.get(boundary.tripId), ...boundary });
    }
    if (rows.length < BOUNDARY_PAGE_SIZE) break;
    afterId = rows[rows.length - 1].id;
  }
  return found;
}

/** The logged trail reaches the start and end times of the trip's own events (both are required to be present). */
function trailReachesBoundaries(trip, boundary) {
  return Math.abs(trip.startMs - boundary.startMs) <= BOUNDARY_TOLERANCE_MS
    && Math.abs(trip.endMs - boundary.endMs) <= BOUNDARY_TOLERANCE_MS;
}

/** The pairs to write for one row, given its logged trip. Only a missing pair is returned. */
function fillsFor(row, trip) {
  const fills = {};
  const startMissing = row.start_lat == null && row.start_lng == null;
  const endMissing = row.end_lat == null && row.end_lng == null;
  if (startMissing && trip.startLat != null && trip.startLng != null) {
    fills.start = { start_lat: trip.startLat, start_lng: trip.startLng };
  }
  if (endMissing && trip.endLat != null && trip.endLng != null) {
    fills.end = { end_lat: trip.endLat, end_lng: trip.endLng };
  }
  return fills;
}

/** Writes one pair; the guard in the WHERE means a coordinate that appeared meanwhile is never overwritten. */
async function writePair(conn, id, pair, guard) {
  const changed = await conn('mileage_log')
    .where('id', id)
    .where(guard)
    .update({ ...pair, updated_at: conn.fn.now() });
  return changed > 0;
}

async function applyFills(conn, row, fills) {
  let start = false;
  let end = false;
  if (fills.start) start = await writePair(conn, row.id, fills.start, whereStartMissing);
  if (fills.end) end = await writePair(conn, row.id, fills.end, whereEndMissing);
  return { start, end };
}

/**
 * What to do with one row: { outcome } where outcome is 'noPoints', 'noEndEvent', 'unsettled', 'noStartEvent',
 * 'incompleteTrail' or 'fill' (+ fills). The checks run in that order.
 */
function decide(row, trip, boundary, now) {
  if (!trip) return { outcome: 'noPoints' };
  if (boundary?.endMs == null) return { outcome: 'noEndEvent' };
  if (now - boundary.endMs < SETTLE_MS) return { outcome: 'unsettled' };
  if (boundary.startMs == null) return { outcome: 'noStartEvent' };
  if (!trailReachesBoundaries(trip, boundary)) return { outcome: 'incompleteTrail' };
  const fills = fillsFor(row, trip);
  return fills.start || fills.end ? { outcome: 'fill', fills } : { outcome: 'noPoints' };
}

/** Folds one group's rows into the totals, writing when `apply`. */
async function processGroup(conn, group, totals, { apply, now }) {
  const trips = await tripsForGroup(conn, group, now);
  const boundaries = await boundariesForGroup(conn, group, now);
  for (const row of group.rows) {
    const tripId = String(row.bouncie_trip_id);
    const { outcome, fills } = decide(row, trips.get(tripId), boundaries.get(tripId), now);
    if (outcome !== 'fill') {
      totals[outcome] += 1;
      continue;
    }
    const done = apply ? await applyFills(conn, row, fills) : { start: Boolean(fills.start), end: Boolean(fills.end) };
    if (done.start) totals.startFilled += 1;
    if (done.end) totals.endFilled += 1;
    if (done.start || done.end) totals.rowsFilled += 1;
  }
}

/**
 * Fills NULL trip coordinates from the trip-data log.
 * @param {object} conn knex
 * @param {{apply?:boolean, sinceDate?:string, tripId?:string, batchSize?:number, now?:number}} [opts]
 *   apply: write (needs the gate); default false = count only. sinceDate: YYYY-MM-DD lower bound on trip_date.
 *   tripId: only the row with this bouncie_trip_id.
 * @returns {Promise<{skipped?:string, candidates:number, rowsFilled:number, startFilled:number, endFilled:number,
 *   noPoints:number, noEndEvent:number, unsettled:number, noStartEvent:number, incompleteTrail:number}>}
 */
async function fillTripCoordinates(conn, { apply = false, sinceDate = null, tripId = null, batchSize = DEFAULT_BATCH_SIZE, now = Date.now() } = {}) {
  const totals = { candidates: 0, rowsFilled: 0, startFilled: 0, endFilled: 0, noPoints: 0, noEndEvent: 0, unsettled: 0, noStartEvent: 0, incompleteTrail: 0 };
  if (apply && !mileageTripCoordsLive()) return { skipped: 'gate_off', ...totals };
  for (let afterId = null; ;) {
    const rows = await loadCandidates(conn, { afterId, batchSize, sinceDate, tripId });
    if (!rows.length) break;
    totals.candidates += rows.length;
    for (const group of groupRows(rows)) await processGroup(conn, group, totals, { apply, now });
    if (rows.length < batchSize) break;
    afterId = rows[rows.length - 1].id;
  }
  return totals;
}

/** The last `days` ET days, for the daily cron. Gate off = no-op. Never throws. */
async function fillRecentTripCoordinates(conn, { days = 3, now = Date.now() } = {}) {
  if (!mileageTripCoordsLive()) return { skipped: 'gate_off' };
  try {
    const sinceDate = etDateString(addETDays(new Date(now), -days));
    const result = await fillTripCoordinates(conn, { apply: true, sinceDate, now });
    logger.info(`[mileage-trip-coords] filled ${result.rowsFilled} of ${result.candidates} trip(s) since ${sinceDate}; no points ${result.noPoints}, no end event ${result.noEndEvent}, unsettled ${result.unsettled}, no start event ${result.noStartEvent}, incomplete trail ${result.incompleteTrail}`);
    return result;
  } catch (err) {
    logger.error(`[mileage-trip-coords] daily fill failed: ${err.message}`);
    return { skipped: 'error', error: err.message };
  }
}

module.exports = {
  fillTripCoordinates, fillRecentTripCoordinates, groupRows, fillsFor, boundaryFromPayload, SETTLE_MS, BOUNDARY_TOLERANCE_MS,
};
