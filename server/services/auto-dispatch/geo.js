/**
 * Geo helpers for auto-dispatch — same drive-time approximation the find-time
 * scorer and route-optimizer fallback use (haversine × 1.4 road factor @ 30 mph).
 * HQ + haversine are reused from route-optimizer so the optimizer and the
 * autonomous driver agree on distances.
 */
const { HQ, haversine } = require('../route-optimizer');

const ROAD_FACTOR = 1.4;
const AVG_MPH = 30;

function milesToDriveMinutes(miles) {
  return Math.round((miles * ROAD_FACTOR / AVG_MPH) * 60);
}

function driveMin(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 0;
  return milesToDriveMinutes(haversine(
    parseFloat(a.lat), parseFloat(a.lng),
    parseFloat(b.lat), parseFloat(b.lng),
  ));
}

/**
 * Resolve a usable {lat,lng} for a scheduled_services row, falling back from the
 * service's own coords to the customer's. Accepts the column aliases this module's
 * queries produce (svc_lat/svc_lng, customer_latitude/customer_longitude) as well
 * as the raw scheduled_services.lat/lng. Returns null when nothing is usable.
 */
function resolveGeo(row) {
  if (!row) return null;
  const lat = row.lat ?? row.svc_lat ?? row.customer_latitude ?? row.cust_lat ?? null;
  const lng = row.lng ?? row.svc_lng ?? row.customer_longitude ?? row.cust_lng ?? null;
  if (lat == null || lng == null) return null;
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  if (Number.isNaN(la) || Number.isNaN(ln)) return null;
  return { lat: la, lng: ln };
}

module.exports = { HQ, haversine, driveMin, resolveGeo };
