'use strict';

/**
 * What both truck-evidence jobs share about a completed visit and its vehicle: where the visit was supposed to
 * be, one row per physical visit, ET day bounds, the vehicle's home base, the active geo-fences and the tracker
 * remap rule. Moved out of pin-parked-check.js (GATE_PIN_PARKED_CHECK) so trip-link.js (GATE_TRIP_LINK) reads the
 * same facts the same way. Pure reads: nothing here writes.
 */
const { distanceMeters, validLatitude, validLongitude } = require('./gps-arrival-detector');
const { effectiveCustomer } = require('./customer-geocode-review');
const { stampedAddressDiverges } = require('./stamped-address');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const HOME_LOOKBACK_DAYS = 30;
const HOME_MIN_DAYS = 3;
const FENCE_TYPES = ['business', 'personal', 'supplier'];

// A pin the detector's own distance function can measure: latitude in [-90, 90], longitude in [-180, 180], not 0.
const usablePin = (lat, lng) => {
  const a = validLatitude(lat);
  const b = validLongitude(lng);
  return a != null && b != null && a !== 0 && b !== 0 ? { lat: a, lng: b } : null;
};

// A distance that could not be measured (null) never matches anything: not "at the pin", not "closest".
const isWithin = (distance, meters) => distance != null && distance <= meters;

// ET calendar day -> [start, end) in epoch ms.
function etDayBounds(day) {
  const start = parseETDateTime(`${day}T00:00`);
  const next = etDateString(addETDays(start, 1));
  return { startMs: start.getTime(), endMs: parseETDateTime(`${next}T00:00`).getTime() };
}

/**
 * Completed visits with their customer, technician and primary property. `requireVehicle` (the default) keeps only
 * technicians that have a Bouncie vehicle; trip-link passes false so a visit without one, or without a technician at
 * all (left join), is still recorded.
 */
function completedVisitQuery(conn, { requireVehicle = true } = {}) {
  const query = conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    [requireVehicle ? 'join' : 'leftJoin']('technicians as t', 't.id', 's.technician_id')
    .leftJoin('customer_properties as p', function joinPrimary() {
      this.on('p.customer_id', '=', 'c.id').andOnVal('p.active', '=', true).andOnVal('p.is_primary', '=', true);
    })
    .where('s.status', 'completed')
    .whereNull('c.deleted_at')
    .orderBy('s.completed_at', 'desc').orderBy('s.id')
    .select(
      's.id', 's.customer_id', 's.technician_id', 's.visit_id', 's.property_id', 's.completed_at', 's.en_route_at', 's.arrived_at', 't.bouncie_imei_changed_at as mapping_changed_at',
      conn.raw('s.scheduled_date::text as scheduled_day'),
      's.lat as service_lat', 's.lng as service_lng',
      's.service_address_line1', 's.service_address_city', 's.service_address_zip',
      'c.first_name', 'c.last_name', 'c.address_line1 as customer_address_line1', 'c.address_line2 as customer_address_line2',
      'c.city as customer_city', 'c.state as customer_state', 'c.zip as customer_zip',
      'c.latitude as customer_latitude', 'c.longitude as customer_longitude',
      'p.id as primary_property_id', 'p.address_line1 as primary_address_line1', 'p.address_line2 as primary_address_line2',
      'p.city as primary_city', 'p.state as primary_state', 'p.zip as primary_zip',
      'p.latitude as primary_latitude', 'p.longitude as primary_longitude', 't.bouncie_imei',
    );
  return requireVehicle ? query.whereRaw("NULLIF(btrim(t.bouncie_imei), '') IS NOT NULL") : query;
}

/**
 * The saved pin as the review panel shows it: the review store's own effectiveCustomer (the matching primary
 * property's coordinates win over the customer row's). One definition for judging, verifying, storing and showing.
 */
function effectivePinColumns(row) {
  const pick = (prefix) => ({
    address_line1: row[`${prefix}_address_line1`], address_line2: row[`${prefix}_address_line2`], city: row[`${prefix}_city`],
    state: row[`${prefix}_state`], zip: row[`${prefix}_zip`],
  });
  const customer = { ...pick('customer'), latitude: row.customer_latitude, longitude: row.customer_longitude };
  const primary = row.primary_property_id == null ? null
    : { ...pick('primary'), latitude: row.primary_latitude, longitude: row.primary_longitude };
  const effective = effectiveCustomer(customer, primary);
  return { customer_latitude: effective.latitude, customer_longitude: effective.longitude };
}

const shapeVisits = (rows) => rows.map((row) => ({
  ...row, ...effectivePinColumns(row), bouncie_imei: String(row.bouncie_imei || '').trim(),
}));

/** One row per physical visit: grouped partners (the same visit_id) are the same stop. */
function oneRowPerVisit(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.visit_id ? `v:${row.visit_id}` : `s:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Active business, personal and supplier fences, with their type. */
async function loadFences(conn) {
  const rows = await conn('geo_fences').where({ is_active: true }).whereIn('fence_type', FENCE_TYPES)
    .select('lat', 'lng', 'radius_meters', 'fence_type');
  return rows.map((row) => ({ ...usablePin(row.lat, row.lng), radius: Number(row.radius_meters) || 0, type: row.fence_type }))
    .filter((fence) => fence.lat != null);
}

/** The cell (about 110 m) most days of the last month began in; null when no cell began 3+ days. Pure. */
function homeBaseFrom(rows) {
  const cells = new Map();
  for (const row of rows) {
    const pin = usablePin(row.start_lat, row.start_lng);
    if (!pin) continue;
    const key = `${pin.lat.toFixed(3)},${pin.lng.toFixed(3)}`;
    const cell = cells.get(key) || { days: 0, lat: 0, lng: 0 };
    cell.days += 1; cell.lat += pin.lat; cell.lng += pin.lng;
    cells.set(key, cell);
  }
  const best = [...cells.values()].sort((a, b) => b.days - a.days)[0];
  return best && best.days >= HOME_MIN_DAYS ? { lat: best.lat / best.days, lng: best.lng / best.days } : null;
}

/**
 * First ET day whose trips count toward a vehicle's home base: the lookback start, or the day AFTER the tracker
 * mapping began when that is later (trips before it may be another technician's routine). NULL changed_at = no bound.
 */
function homeSince(now, mappingChangedAt) {
  const lookback = etDateString(addETDays(now, -HOME_LOOKBACK_DAYS));
  if (!mappingChangedAt) return lookback;
  const changed = new Date(mappingChangedAt);
  if (!Number.isFinite(changed.getTime())) return lookback;
  const dayAfter = etDateString(addETDays(changed, 1));
  return dayAfter > lookback ? dayAfter : lookback;
}

/** The vehicle's home base from its trips of the 30 days up to `now` (or `until`, an ET day, for a past day). */
async function loadHomeBase(conn, imei, now, mappingChangedAt = null, until = null) {
  const since = homeSince(now, mappingChangedAt);
  const { rows } = await conn.raw(
    `SELECT DISTINCT ON (trip_date) trip_date, start_lat, start_lng FROM mileage_log
      WHERE vehicle_id = ? AND trip_date >= ? AND (?::date IS NULL OR trip_date <= ?::date)
        AND start_lat IS NOT NULL AND start_lng IS NOT NULL
      ORDER BY trip_date, created_at`,
    [imei, since, until, until],
  );
  return homeBaseFrom(rows || []);
}

/**
 * The tracker remap rule. The log is keyed by device, and the technician's CURRENT device is what a visit query
 * joins. A day that starts before the mapping changed (technicians.bouncie_imei_changed_at; NULL = never remapped)
 * may belong to another vehicle, so it cannot be judged. The day of the change itself is partly before it: not judged
 * either.
 */
function dayBeforeMapping(day, mappingChangedAt) {
  const changedMs = mappingChangedAt ? new Date(mappingChangedAt).getTime() : null;
  return changedMs != null && Number.isFinite(changedMs) && etDayBounds(day).startMs < changedMs;
}

/** Where the visit was supposed to be: its own pin, else the customer's. Null for another property or no pin. */
function destinationOf(visit) {
  if (visit.property_id != null && visit.primary_property_id != null
    && String(visit.property_id) !== String(visit.primary_property_id)) return null;
  const own = usablePin(visit.service_lat, visit.service_lng);
  if (own) return stampedAddressDiverges(visit) ? null : own;
  if (stampedAddressDiverges(visit)) return null;
  return usablePin(visit.customer_latitude, visit.customer_longitude);
}

const within = (point, stop, meters) => Boolean(point) && isWithin(distanceMeters(point.lat, point.lng, stop.lat, stop.lng), meters);

module.exports = {
  usablePin, isWithin, within, etDayBounds, completedVisitQuery, effectivePinColumns, shapeVisits, oneRowPerVisit,
  loadFences, homeBaseFrom, homeSince, loadHomeBase, dayBeforeMapping, destinationOf, FENCE_TYPES,
};
