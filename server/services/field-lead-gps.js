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
 * The result goes on leads.gps_check. It holds a distance, never the truck's coordinates, and
 * the flagging technician (technician_id): the seller, even if the office later reassigns the
 * lead (leads.assigned_to).
 * Nothing here throws for a failed check: a failed check is a result, and the lead is made
 * either way.
 */
const db = require('../models/db');
const logger = require('./logger');
const { toE164, nanpNationalDigits, isValidNanpNumber } = require('../utils/phone');

const ARRIVAL_WINDOW_MS = 12 * 60 * 60 * 1000;
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

function blankCheck(mode, now, technicianId) {
  return {
    result: null,
    mode,
    technician_id: technicianId ? String(technicianId) : null,
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

// Customer mode. `scheduledServiceId` is the visit the flag was opened from.
async function checkCustomerArrival({ database = db, technicianId, customerId, scheduledServiceId, now = new Date() }) {
  const check = blankCheck('customer', now, technicianId);
  const serviceId = typeof scheduledServiceId === 'string' ? scheduledServiceId.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serviceId)) {
    return { ...check, result: 'no_gps_arrival' };
  }
  check.scheduled_service_id = serviceId;
  const visit = await database('scheduled_services').where({ id: serviceId }).first('id', 'technician_id', 'customer_id', 'visit_id');
  if (!visit
    || String(visit.technician_id || '') !== String(technicianId || '')
    || String(visit.customer_id || '') !== String(customerId || '')) {
    return { ...check, result: 'no_gps_arrival' };
  }
  // A grouped stop is one physical visit: the arrival row can sit on any member.
  const memberIds = visit.visit_id
    ? (await database('scheduled_services').where({ visit_id: visit.visit_id }).pluck('id'))
    : [];
  const visitIds = [...new Set([visit.id, ...memberIds].map(String))];
  const arrival = await database('audit_log')
    .where({ action: 'gps_arrival.mark_on_property', resource_type: 'scheduled_service' })
    .whereIn('resource_id', visitIds)
    .whereRaw("metadata->>'tech_id' = ?", [String(technicianId || '')])
    .where('created_at', '>=', new Date(now.getTime() - ARRIVAL_WINDOW_MS))
    .where('created_at', '<=', now)
    .orderBy('created_at', 'desc')
    .first('metadata');
  if (!arrival) return { ...check, result: 'no_gps_arrival' };
  const logged = Number(arrival.metadata?.distance_meters);
  return { ...check, result: 'verified', distance_m: Number.isFinite(logged) ? Math.round(logged) : null };
}

// Prospect mode: the typed address against the technician's truck.
async function checkProspectLocation({ database = db, technicianId, prospect, now = new Date(), geocode = null, radiusMeters = null }) {
  const check = blankCheck('prospect', now, technicianId);
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

  const tech = await database('technicians').where({ id: technicianId }).first('bouncie_imei');
  if (!tech?.bouncie_imei) return { ...check, result: 'no_truck' };
  const truck = await database('vehicle_locations').where({ bouncie_imei: tech.bouncie_imei }).first('lat', 'lng', 'reported_at');
  if (!truck || truck.lat == null || truck.lng == null) return { ...check, result: 'no_truck_position' };

  const reportedMs = truck.reported_at ? new Date(truck.reported_at).getTime() : NaN;
  if (!Number.isFinite(reportedMs)) return { ...check, result: 'stale_truck_position' };
  check.truck_reported_at = new Date(reportedMs).toISOString();
  if (now.getTime() - reportedMs > TRUCK_POSITION_MAX_AGE_MS) return { ...check, result: 'stale_truck_position' };

  const { distanceMeters } = require('./gps-arrival-detector');
  const meters = distanceMeters(Number(truck.lat), Number(truck.lng), Number(location.lat), Number(location.lng));
  if (meters == null) return { ...check, result: 'no_truck_position' };
  check.distance_m = Math.round(meters);
  return { ...check, result: meters <= radius ? 'verified' : 'too_far' };
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
