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
 * The stops of one vehicle that START inside [fromMs, toMs).
 * Reads only that vehicle's trip-data events received from fromMs to toMs + 12 hours (never later than now).
 */
async function loadTruckStops(conn, imei, { fromMs, toMs, maxGapMeters, now = Date.now() }) {
  if (!imei) return [];
  const until = new Date(Math.min(now, toMs + LATE_ARRIVAL_MS));
  const trips = new Map();
  for (let afterId = 0; ;) {
    const rows = await conn('bouncie_webhook_log')
      .where({ vehicle_imei: String(imei), event_type: 'trip-data' })
      .where('received_at', '>=', new Date(fromMs))
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
  return stopsFromTrips(trips, { maxGapMeters })
    .filter((stop) => stop.startMs >= fromMs && stop.startMs < toMs);
}

module.exports = { loadTruckStops, stopsFromTrips, tripPointsFromPayload, addToTrips, MIN_STOP_MINUTES };
