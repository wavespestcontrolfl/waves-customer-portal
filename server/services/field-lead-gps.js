/**
 * Truck GPS check for a technician's field lead (owner ruling 2026-10-29, D5 part 3b-1:
 * "the technician's flag, checked by the truck GPS, fills in 'Sold by'"). Used only while
 * GATE_COMMISSION_SOLD_BY is on. The phone's GPS is never used (it reached 0 of 3 visit
 * photos); the truck is.
 *
 * Two modes:
 *  - customer: the flag came from a visit. Verified when this technician's visit for that
 *    customer has a gps_arrival.mark_on_property audit row in the 12 hours before the flag,
 *    logged for THIS technician's truck (metadata.tech_id): a visit reassigned after another
 *    technician's arrival does not verify.
 *  - prospect ("Neighbor"): no customer yet. The typed address is geocoded and the
 *    technician's truck must sit within the radius of it, on a position under 6 hours old.
 *
 * The result goes on leads.gps_check. It holds a distance, never the truck's coordinates, the
 * flagging technician (technician_id: the seller, even if the office later reassigns the lead)
 * and the premise the check proved (the visited customer, or the typed address), so an office
 * edit to the lead's customer or address never moves the proof.
 * Nothing here throws for a failed check: a failed check is a result, and the lead is made
 * either way.
 */
const db = require('../models/db');
const logger = require('./logger');
const { toE164, nanpNationalDigits, isValidNanpNumber } = require('../utils/phone');

const ARRIVAL_WINDOW_MS = 12 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUCK_POSITION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RADIUS_M = 300;
const RADIUS_SETTING_KEY = 'field_flag.gps_radius_m';

const RESULT_TEXT = {
  no_gps_arrival: 'no truck arrival logged at this visit',
  no_truck: 'no truck assigned',
  no_truck_position: 'no truck position',
  stale_truck_position: 'truck position too old',
  address_not_found: 'address not found',
  too_far: 'too far',
};

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return null;
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

// "GPS: verified, 40 m" / "GPS: not verified (too far, 1.2 km)". Appended to the lead activity.
function describeGpsCheck(check) {
  if (!check) return null;
  const distance = formatDistance(check.distance_m);
  if (check.result === 'verified') return `GPS: verified${distance ? `, ${distance}` : ''}`;
  const reason = RESULT_TEXT[check.result] || check.result;
  return `GPS: not verified (${reason}${check.result === 'too_far' && distance ? `, ${distance}` : ''})`;
}

// `premise` is the place the check is about, kept with the result so it never follows an edit
// to the lead: the visited customer (customer mode) or the typed address (prospect mode).
function blankCheck(mode, now, technicianId, premise) {
  return {
    result: null,
    mode,
    technician_id: technicianId ? String(technicianId) : null,
    premise,
    scheduled_service_id: null,
    distance_m: null,
    radius_m: null,
    truck_reported_at: null,
    checked_at: now.toISOString(),
  };
}

// Radius in meters from system_settings; 300 when missing or not a positive whole number.
async function loadRadiusMeters(database = db) {
  try {
    const row = await database('system_settings').where({ key: RADIUS_SETTING_KEY }).first('value');
    const text = String(row?.value ?? '').trim();
    if (!/^\d+$/.test(text)) return DEFAULT_RADIUS_M;
    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_RADIUS_M;
  } catch {
    return DEFAULT_RADIUS_M;
  }
}

// Customer mode. `scheduledServiceId` is the visit the flag was opened from. Verified when this
// technician's own truck logged a GPS arrival at the visit (or another stop of its grouped visit)
// in the 12 hours before the flag AND the truck stands within the radius of the visit's destination
// now (the arrival detector's own rule, extractDestination). The arrival proves an earlier moment
// and the visit's address may have moved since; the current position binds the proof to the
// premise stored with the result.
async function checkCustomerArrival({ database = db, technicianId, customerId, scheduledServiceId, now = new Date(), radiusMeters = null }) {
  const check = blankCheck('customer', now, technicianId, { customer_id: String(customerId) });
  const serviceId = typeof scheduledServiceId === 'string' ? scheduledServiceId.trim() : '';
  if (!UUID_RE.test(serviceId)) return { ...check, result: 'no_gps_arrival' };
  check.scheduled_service_id = serviceId;
  const visit = await loadFlaggedVisit(database, serviceId);
  if (!visit
    || String(visit.technician_id || '') !== String(technicianId || '')
    || String(visit.customer_id || '') !== String(customerId || '')
    || !(await arrivalLogged(database, visit, technicianId, now))) {
    return { ...check, result: 'no_gps_arrival' };
  }
  const destination = require('./gps-arrival-detector').extractDestination(visit);
  if (!destination) return { ...check, result: 'no_gps_arrival' };
  const radius = radiusMeters || await loadRadiusMeters(database);
  return { ...check, premise: visitedPremise(visit), radius_m: radius, ...(await truckNear(database, technicianId, now, destination, radius)) };
}

// The visit row with what the destination rule and the premise need (the detector's own columns).
function loadFlaggedVisit(database, serviceId) {
  return database('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.id', serviceId)
    .first('s.id', 's.technician_id', 's.customer_id', 's.visit_id',
      's.lat as service_lat', 's.lng as service_lng',
      's.service_address_line1', 's.service_address_line2', 's.service_address_city', 's.service_address_zip',
      'c.address_line1 as customer_address_line1', 'c.address_line2 as customer_address_line2',
      'c.city as customer_city', 'c.zip as customer_zip', 'c.latitude as customer_latitude', 'c.longitude as customer_longitude');
}

// This technician's truck logged an arrival at the visit (a grouped stop is one physical visit:
// the row can sit on any member) in the 12 hours before the flag.
async function arrivalLogged(database, visit, technicianId, now) {
  const memberIds = visit.visit_id
    ? (await database('scheduled_services').where({ visit_id: visit.visit_id }).pluck('id'))
    : [];
  const arrival = await database('audit_log')
    .where({ action: 'gps_arrival.mark_on_property', resource_type: 'scheduled_service' })
    .whereIn('resource_id', [...new Set([visit.id, ...memberIds].map(String))])
    .whereRaw("metadata->>'tech_id' = ?", [String(technicianId || '')])
    .where('created_at', '>=', new Date(now.getTime() - ARRIVAL_WINDOW_MS))
    .where('created_at', '<=', now)
    .first('id');
  return Boolean(arrival);
}

// The property the truck is at, by the arrival detector's own rule (extractDestination): the
// visit's stamped service address when it has one (a secondary or rental property), else the
// customer's primary address, with the unit. Stored with the result, with the visit's customer row,
// so the estimate is checked against the same place.
function visitedPremise(visit) {
  const stamped = Boolean(visit.service_address_line1);
  return {
    customer_id: String(visit.customer_id),
    address: (stamped ? visit.service_address_line1 : visit.customer_address_line1) || null,
    unit: (stamped ? visit.service_address_line2 : visit.customer_address_line2) || null,
    city: (stamped ? visit.service_address_city : visit.customer_city) || null,
    zip: (stamped ? visit.service_address_zip : visit.customer_zip) || null,
  };
}

// The truck against a point: { result, distance_m?, truck_reported_at? } (verified within radius).
async function truckNear(database, technicianId, now, point, radius) {
  const truck = await truckPosition(database, technicianId, now);
  const reported = truck.reportedAt ? { truck_reported_at: truck.reportedAt } : {};
  if (truck.result) return { ...reported, result: truck.result };
  const { distanceMeters } = require('./gps-arrival-detector');
  const meters = distanceMeters(Number(truck.lat), Number(truck.lng), Number(point.lat), Number(point.lng));
  if (meters == null) return { ...reported, result: 'no_truck_position' };
  return { ...reported, distance_m: Math.round(meters), result: meters <= radius ? 'verified' : 'too_far' };
}

// Prospect mode: the typed address against the technician's truck.
async function checkProspectLocation({ database = db, technicianId, prospect, now = new Date(), geocode = null, radiusMeters = null }) {
  // normalizeProspect has already required the address and the ZIP (the city may be '').
  const check = blankCheck('prospect', now, technicianId, { address: prospect.address, city: prospect.city, zip: prospect.zip });
  const radius = radiusMeters || await loadRadiusMeters(database);
  check.radius_m = radius;

  const geocodeFn = geocode || require('./geocoder').geocodeAddressWithStatus;
  const address = [prospect.address, prospect.city, 'FL', prospect.zip].filter(Boolean).join(', ');
  let location = null;
  try {
    ({ location } = await geocodeFn(address, { serviceAddress: true, requireInServiceArea: true }));
  } catch (err) {
    logger.warn(`[field-lead-gps] geocode failed: ${err.name || 'error'}`);
  }
  if (!location) return { ...check, result: 'address_not_found' };

  return { ...check, ...(await truckNear(database, technicianId, now, location, radius)) };
}

// The technician's truck position, or the reason there is none. vehicle_locations keeps the latest
// point per device; a device moved to this technician's truck still holds points from before the
// move, so by the tracker's shared rule (customer-tracking-eta.js techMappingCutoff, as
// tracking-vehicle-location.js applies it) a point counts only when it was reported AND received by
// the server (vehicle_locations.updated_at, stamped NOW() with each newer point) after the mapping
// last changed (technicians.bouncie_imei_changed_at; NULL = never remapped).
async function truckPosition(database, technicianId, now) {
  const tech = await database('technicians').where({ id: technicianId }).first('bouncie_imei', 'bouncie_imei_changed_at');
  if (!tech?.bouncie_imei) return { result: 'no_truck' };
  const truck = await database('vehicle_locations').where({ bouncie_imei: tech.bouncie_imei }).first('lat', 'lng', 'reported_at', 'updated_at');
  if (!truck || truck.lat == null || truck.lng == null) return { result: 'no_truck_position' };
  const reportedMs = truck.reported_at ? new Date(truck.reported_at).getTime() : NaN;
  if (!Number.isFinite(reportedMs)) return { result: 'stale_truck_position' };
  const reportedAt = new Date(reportedMs).toISOString();
  if (now.getTime() - reportedMs > TRUCK_POSITION_MAX_AGE_MS) return { result: 'stale_truck_position', reportedAt };
  const cutoff = require('./customer-tracking-eta').techMappingCutoff(tech.bouncie_imei_changed_at);
  const cutoffMs = cutoff == null ? null : new Date(cutoff).getTime();
  const receivedMs = truck.updated_at ? new Date(truck.updated_at).getTime() : NaN;
  if (cutoffMs != null && !(reportedMs > cutoffMs && receivedMs > cutoffMs)) return { result: 'stale_truck_position', reportedAt };
  return { lat: truck.lat, lng: truck.lng, reportedAt };
}

// Neighbor-mode body. First name, a 10-digit phone, an address and a ZIP are required.
// Returns { prospect } or { error }.
function normalizeProspect(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const prospect = {
    firstName: text(p.firstName, 100),
    lastName: text(p.lastName, 100),
    address: text(p.address, 200),
    city: text(p.city, 100),
    zip: text(p.zip, 10),
  };
  if (!prospect.firstName) return { error: 'First name is required' };
  if (!isValidNanpNumber(p.phone)) return { error: 'A 10-digit phone number is required' };
  prospect.phone = toE164(nanpNationalDigits(p.phone));
  if (!prospect.address) return { error: 'Address is required' };
  if (!/^\d{5}(-\d{4})?$/.test(prospect.zip)) return { error: 'A 5-digit ZIP is required' };
  return { prospect };
}

module.exports = {
  ARRIVAL_WINDOW_MS,
  TRUCK_POSITION_MAX_AGE_MS,
  DEFAULT_RADIUS_M,
  RADIUS_SETTING_KEY,
  describeGpsCheck,
  loadRadiusMeters,
  checkCustomerArrival,
  checkProspectLocation,
  normalizeProspect,
};
