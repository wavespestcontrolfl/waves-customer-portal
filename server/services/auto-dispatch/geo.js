/**
 * Geo helpers for auto-dispatch.
 *
 * HQ, haversine and the drive-time estimator all come from route-optimizer so
 * the optimizer, the find-time scorer and the autonomous driver share ONE
 * model. That sharing is load-bearing rather than tidiness: auto-dispatch ranks
 * a visit's CURRENT placement (scored here) against CANDIDATE placements
 * (scored in scheduling/find-time.js). If the two sides used different
 * estimators, the comparison would be on different scales and the driver could
 * "improve" a route that did not improve. Do not reintroduce a local copy of
 * the constants here — see route-optimizer.js for the model and its
 * calibration.
 */
const { HQ, haversine, milesToDriveMinutes } = require('../route-optimizer');

/**
 * Drive minutes between two {lat,lng} points. Coordinate glue only — the
 * miles→minutes model itself is route-optimizer's and MUST NOT be re-derived
 * here.
 */
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

module.exports = { HQ, haversine, driveMin, resolveGeo, milesToDriveMinutes };
