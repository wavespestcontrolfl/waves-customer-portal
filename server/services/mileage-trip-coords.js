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
 *  - is_business, purpose, deduction and classification columns are never touched (the tax review stays
 *    suggestion-only, owner policy).
 *  - A write needs GATE_MILEAGE_TRIP_COORDS=true; a dry run reads and counts without it.
 */
const logger = require('./logger');
const { loadTruckTrips } = require('./bouncie-truck-stops');
const { mileageTripCoordsLive } = require('../config/feature-gates');
const { etDateString, addETDays, parseETDateTime, dateOnlyString } = require('../utils/datetime-et');

const DEFAULT_BATCH_SIZE = 300;
// Trips of one vehicle are read in groups no wider than this many calendar days, so the trip-data read stays small.
const GROUP_SPAN_DAYS = 7;
// A trip is dated by its start day and ends at most this many days after the group's last start day.
const END_SLACK_DAYS = 2;
const DAY_MS = 86400000;

const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const etDayStartMs = (day) => parseETDateTime(`${day}T00:00`).getTime();

/** A pair needs filling when both its columns are NULL (a half-filled pair is left for a person to look at). */
function whereStartMissing(q) { return q.whereNull('start_lat').whereNull('start_lng'); }
function whereEndMissing(q) { return q.whereNull('end_lat').whereNull('end_lng'); }

/** One page of bouncie rows that still lack a start or an end pair, after `afterId`, oldest id first. */
async function loadCandidates(conn, { afterId, batchSize, sinceDate, tripId }) {
  const query = conn('mileage_log')
    .where('source', 'bouncie')
    .whereNotNull('bouncie_trip_id')
    .whereNotNull('vehicle_id')
    .where('id', '>', afterId)
    .where((q) => q.where(whereStartMissing).orWhere(whereEndMissing));
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

/** The trips of one group, by trip id, read from the trip-data log. */
async function tripsForGroup(conn, group, now) {
  const fromMs = etDayStartMs(group.firstDay);
  const toMs = etDayStartMs(etDateString(addETDays(parseETDateTime(`${group.lastDay}T12:00`), END_SLACK_DAYS)));
  const trips = await loadTruckTrips(conn, group.vehicle, { fromMs, toMs, now });
  return new Map(trips.map((trip) => [trip.tripId, trip]));
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

/** Folds one group's rows into the totals, writing when `apply`. */
async function processGroup(conn, group, totals, { apply, now }) {
  const trips = await tripsForGroup(conn, group, now);
  for (const row of group.rows) {
    const trip = trips.get(String(row.bouncie_trip_id));
    const fills = trip ? fillsFor(row, trip) : {};
    if (!fills.start && !fills.end) {
      totals.noPoints += 1;
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
 * @returns {Promise<{skipped?:string, candidates:number, rowsFilled:number, startFilled:number, endFilled:number, noPoints:number}>}
 */
async function fillTripCoordinates(conn, { apply = false, sinceDate = null, tripId = null, batchSize = DEFAULT_BATCH_SIZE, now = Date.now() } = {}) {
  const totals = { candidates: 0, rowsFilled: 0, startFilled: 0, endFilled: 0, noPoints: 0 };
  if (apply && !mileageTripCoordsLive()) return { skipped: 'gate_off', ...totals };
  for (let afterId = 0; ;) {
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
    logger.info(`[mileage-trip-coords] filled ${result.rowsFilled} of ${result.candidates} trip(s) since ${sinceDate}; no points for ${result.noPoints}`);
    return result;
  } catch (err) {
    logger.error(`[mileage-trip-coords] daily fill failed: ${err.message}`);
    return { skipped: 'error', error: err.message };
  }
}

/** One just-inserted trip, from the webhook path. Gate off = no-op. Never throws. */
async function fillTripCoordinatesForTrip(conn, tripId) {
  if (!mileageTripCoordsLive() || !tripId) return { skipped: 'gate_off' };
  try {
    return await fillTripCoordinates(conn, { apply: true, tripId });
  } catch (err) {
    logger.warn(`[mileage-trip-coords] fill for trip ${tripId} failed: ${err.message}`);
    return { skipped: 'error', error: err.message };
  }
}

module.exports = { fillTripCoordinates, fillRecentTripCoordinates, fillTripCoordinatesForTrip, groupRows, fillsFor };
