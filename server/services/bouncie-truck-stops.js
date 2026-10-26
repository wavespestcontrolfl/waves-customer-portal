'use strict';

/**
 * Where a technician's Bouncie truck stood still, derived from the raw trip-data events in
 * bouncie_webhook_log (pin check after a visit, GATE_PIN_PARKED_CHECK).
 *
 * Why the log and not a trips table: mileage_log keeps each trip's end coordinates but no start or end
 * TIME, so the length of a stop cannot be read from it. The log's trip-data events carry a transactionId per
 * trip and timestamped GPS points, which is exactly what a stop needs.
 *
 * A stop is the gap between two consecutive trips of one vehicle: it starts at the last GPS point of the
 * earlier trip and ends at the first GPS point of the next trip. It counts when it lasted at least
 * MIN_STOP_MINUTES and the two points are within `maxGapMeters` of each other. A farther pair means a trip
 * event was lost and the truck moved without us seeing it, so no stop is claimed there.
 *
 * The read is bounded to ONE vehicle (vehicle_imei) and ONE received_at window, read in id-ordered pages and
 * reduced to a few numbers per trip as it goes. Pure reads: nothing here writes.
 */
const { pointFromSource, firstPresent } = require('./bouncie-payload');
const { distanceMeters } = require('./gps-arrival-detector');

const MIN_STOP_MINUTES = 5;
const PAGE_SIZE = 500;
// A trip-data event can reach us hours late; events are read up to this long after the window closes.
const LATE_ARRIVAL_MS = 12 * 60 * 60 * 1000;
// A trip that began before a window opened has batches received before it. The trips reads (trip link) start this
// long earlier so a trip's first point is its true start: a trip across midnight belongs to the day it began, never to
// both. loadTruckStops keeps its own read (the pin check is unchanged); its stops inside the window are the same.
const EARLY_READ_MS = 12 * 60 * 60 * 1000;

function parsePayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload !== 'string') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

/** The trip id and timestamped points of one trip-data event; null when it has no usable trip id or point. */
function tripPointsFromPayload(rawPayload) {
  const payload = parsePayload(rawPayload);
  if (!payload) return null;
  const tripId = firstPresent(payload.transactionId, payload.transaction_id, payload.tripId, payload.trip_id);
  const samples = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.samples) ? payload.samples : null;
  if (!tripId || !samples) return null;
  const points = [];
  for (const sample of samples) {
    const point = pointFromSource(sample);
    const ms = point ? Date.parse(point.reported_at) : NaN;
    if (point && Number.isFinite(ms)) points.push({ ms, lat: point.lat, lng: point.lng });
  }
  return points.length ? { tripId: String(tripId), points } : null;
}

/** Folds one event into the per-trip first/last point. A point seen twice (two receivers) counts once. */
function addToTrips(trips, event) {
  const trip = trips.get(event.tripId) || { first: null, last: null };
  for (const point of event.points) {
    if (!trip.first || point.ms < trip.first.ms) trip.first = point;
    if (!trip.last || point.ms > trip.last.ms) trip.last = point;
  }
  trips.set(event.tripId, trip);
}

/**
 * Stops from per-trip first/last points.
 * @param {Map<string,{first:object,last:object}>} trips
 * @param {{maxGapMeters:number, minMinutes?:number}} opts
 * @returns {Array<{lat:number,lng:number,startMs:number,endMs:number,minutes:number}>} in time order
 */
function stopsFromTrips(trips, { maxGapMeters, minMinutes = MIN_STOP_MINUTES }) {
  const ordered = [...trips.values()].filter((trip) => trip.first && trip.last)
    .sort((a, b) => a.first.ms - b.first.ms);
  const stops = [];
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const end = ordered[i].last;
    const next = ordered[i + 1].first;
    const minutes = (next.ms - end.ms) / 60000;
    const gap = distanceMeters(end.lat, end.lng, next.lat, next.lng);
    if (minutes >= minMinutes && gap != null && gap <= maxGapMeters) {
      stops.push({ lat: end.lat, lng: end.lng, startMs: end.ms, endMs: next.ms, minutes });
    }
  }
  return stops;
}

/**
 * Every trip of one vehicle read from its trip-data events received from readFromMs (default fromMs) to toMs + 12
 * hours (never later than now): a Map of trip id -> first and last timestamped point. The ONE read behind
 * loadTruckStops and loadTruckTrips, so both see the same trips under the same paging, late-arrival and dedupe rules.
 */
async function readTripMap(conn, imei, { fromMs, toMs, now = Date.now(), readFromMs = fromMs }) {
  const until = new Date(Math.min(now, toMs + LATE_ARRIVAL_MS));
  const trips = new Map();
  for (let afterId = 0; ;) {
    const rows = await conn('bouncie_webhook_log')
      .where({ vehicle_imei: String(imei), event_type: 'trip-data' })
      .where('received_at', '>=', new Date(readFromMs))
      .where('received_at', '<', until)
      .where('id', '>', afterId)
      .orderBy('id').limit(PAGE_SIZE).select('id', 'payload');
    for (const row of rows) {
      const event = tripPointsFromPayload(row.payload);
      if (event) addToTrips(trips, event);
    }
    if (rows.length < PAGE_SIZE) break;
    afterId = rows[rows.length - 1].id;
  }
  return trips;
}

/**
 * Trips as { tripId, startMs, endMs, startLat, startLng, endLat, endLng }, in time order (start, then id).
 * @param {Map<string,{first:object,last:object}>} trips
 */
function tripList(trips) {
  return [...trips.entries()].filter(([, trip]) => trip.first && trip.last)
    .map(([tripId, trip]) => ({
      tripId, startMs: trip.first.ms, endMs: trip.last.ms,
      startLat: trip.first.lat, startLng: trip.first.lng, endLat: trip.last.lat, endLng: trip.last.lng,
    }))
    .sort((a, b) => a.startMs - b.startMs || (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0));
}

/**
 * The stops of one vehicle that START inside [fromMs, toMs).
 * Reads only that vehicle's trip-data events received from fromMs to toMs + 12 hours (never later than now).
 */
async function loadTruckStops(conn, imei, { fromMs, toMs, maxGapMeters, now = Date.now() }) {
  if (!imei) return [];
  const trips = await readTripMap(conn, imei, { fromMs, toMs, now });
  return stopsFromTrips(trips, { maxGapMeters })
    .filter((stop) => stop.startMs >= fromMs && stop.startMs < toMs);
}

/**
 * The trips of one vehicle that START inside [fromMs, toMs), in time order. The read starts EARLY_READ_MS before the
 * window, so a trip that began before it is read whole and left out, never cut to a late start.
 */
async function loadTruckTrips(conn, imei, { fromMs, toMs, now = Date.now() }) {
  if (!imei) return [];
  return tripList(await readTripMap(conn, imei, { fromMs, toMs, now, readFromMs: fromMs - EARLY_READ_MS }))
    .filter((trip) => trip.startMs >= fromMs && trip.startMs < toMs);
}

/**
 * A vehicle's trips AND stops that start inside [fromMs, toMs), from ONE read (starting EARLY_READ_MS before the
 * window, as loadTruckTrips). The stops are derived over every trip the read saw, as loadTruckStops does, so a stop at
 * the end of the window's last trip (its next trip begins after toMs) is kept. `carriedIn`: trips that began before the
 * window and ended inside it (a drive across midnight); they belong to the day they began, but the window's first
 * drive leg can start with one.
 */
async function loadTruckDay(conn, imei, { fromMs, toMs, maxGapMeters, now = Date.now() }) {
  if (!imei) return { trips: [], stops: [], carriedIn: [] };
  const trips = await readTripMap(conn, imei, { fromMs, toMs, now, readFromMs: fromMs - EARLY_READ_MS });
  const inWindow = (startMs) => startMs >= fromMs && startMs < toMs;
  const list = tripList(trips);
  return {
    trips: list.filter((trip) => inWindow(trip.startMs)),
    stops: stopsFromTrips(trips, { maxGapMeters }).filter((stop) => inWindow(stop.startMs)),
    carriedIn: list.filter((trip) => trip.startMs < fromMs && trip.endMs > fromMs),
  };
}

module.exports = {
  loadTruckStops, loadTruckTrips, loadTruckDay, stopsFromTrips, tripList, tripPointsFromPayload, addToTrips, MIN_STOP_MINUTES,
  EARLY_READ_MS,
};
