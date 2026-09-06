/**
 * Shared day-stops query — the ONE place that builds "all of a day's stops
 * (optionally one tech's) with divergence-guarded coordinates".
 *
 * This exact scaffold was duplicated four times (admin-schedule /optimize +
 * /optimize-route, intelligence-bar schedule-tools optimize_all_routes +
 * optimize_tech_route) and now also feeds the nightly route-reorder pass.
 * Behavior contract: given the same { dateStr, technicianId, excludeStatuses,
 * select } each caller used before the extraction, the query returns the same
 * rows — callers keep their own status sets and select lists, only the
 * scaffold (FROM/WHERE/JOIN + the guarded lat/lng raws) is shared.
 *
 * The coordinate guard: a visit's primary-home coords are only a valid
 * fallback when its stamped service address doesn't DIVERGE from the primary —
 * a divergent stamp with no coords must degrade to "no pin" (the optimizer
 * appends coordless stops), never route to the wrong house.
 */
const { stampedDivergesSql } = require('../stamped-address');

/** The divergence-guarded lat/lng select expressions (aliased lat/lng). */
function guardedCoordSelects(db) {
  return [
    db.raw(`COALESCE(scheduled_services.lat, CASE WHEN NOT ${stampedDivergesSql('scheduled_services', 'customers')} THEN customers.latitude END) as lat`),
    db.raw(`COALESCE(scheduled_services.lng, CASE WHEN NOT ${stampedDivergesSql('scheduled_services', 'customers')} THEN customers.longitude END) as lng`),
  ];
}

// The saved service address is authoritative for an existing appointment.
// Keep hints and transactional arrival checks on the same address/pin read.
function serviceLocationSelects(db) {
  return [
    ...guardedCoordSelects(db),
    db.raw('COALESCE(scheduled_services.service_address_line1, customers.address_line1) as address_line1'),
    db.raw('COALESCE(scheduled_services.service_address_city, customers.city) as city'),
    db.raw('COALESCE(scheduled_services.service_address_state, customers.state) as state'),
    db.raw('COALESCE(scheduled_services.service_address_zip, customers.zip) as zip'),
  ];
}

async function resolveServiceLocation(row, addressOverride) {
  const { buildAddress, geocodeAddress } = require('../geocoder');
  // Legacy ranged searches accept a free-form address override. Arrival
  // callers pass only the stored row, so they cannot certify a client pin.
  const address = addressOverride || buildAddress(row);
  const hasPin = row.lat != null && row.lng != null
    && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng))
    && Number(row.lat) !== 0 && Number(row.lng) !== 0;
  // The existing geocoder rejects partial, coarse, and out-of-area results
  // and caches by address. Never persist a pin during an advisory lookup.
  const pin = hasPin ? row : (address ? await geocodeAddress(address) : null);
  return {
    lat: pin?.lat ?? null, lng: pin?.lng ?? null, address,
    source: hasPin ? 'visit_stamp' : (pin ? 'address_geocoded_now' : null),
  };
}

/**
 * Build the day-stops query.
 *   dateStr          YYYY-MM-DD (scheduled_services.scheduled_date)
 *   technicianId     optional — restrict to one tech
 *   excludeStatuses  REQUIRED — each caller's original status exclusion set
 *   select           REQUIRED — the caller's select list (column names and/or
 *                    db.raw expressions; use guardedCoordSelects for coords)
 */
function dayStopsQuery(db, { dateStr, technicianId = null, excludeStatuses, select }) {
  if (!Array.isArray(excludeStatuses) || !Array.isArray(select)) {
    throw new Error('dayStopsQuery requires explicit excludeStatuses and select arrays');
  }
  const q = db('scheduled_services')
    .where('scheduled_services.scheduled_date', dateStr);
  if (technicianId) q.where('scheduled_services.technician_id', technicianId);
  return q
    .whereNotIn('scheduled_services.status', excludeStatuses)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(...select);
}

module.exports = { dayStopsQuery, guardedCoordSelects, serviceLocationSelects, resolveServiceLocation };
