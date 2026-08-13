/**
 * Geo helpers for auto-dispatch — the drive-time approximation the find-time
 * scorer and route-optimizer fallback share. HQ + haversine are reused from
 * route-optimizer so the optimizer and the autonomous driver agree on distances.
 *
 * Two models live here, selected by GATE_DRIVE_TIME_CALIBRATION:
 *
 *   legacy      haversine × 1.4 road factor @ 30 mph
 *   calibrated  a fixed per-leg overhead + a per-mile rate
 *
 * The calibrated constants were fitted against 150 real trips reconstructed
 * from Bouncie GPS (first/last fix per trip, measured duration and odometer
 * distance), fitted on half and scored on the held-out half:
 *
 *   legacy      MAE 4.99 min   59% of legs within 5 min
 *   calibrated  MAE 3.89 min   79% of legs within 5 min
 *
 * The legacy constants were measurably off in both terms — the same trips imply
 * a road factor of 1.50 (not 1.40) and an average speed of 20.8 mph (not 30).
 * The speed assumption is the larger error and is why legacy under-estimates.
 *
 * The fixed term is not a fudge factor: measured idle time averages 3.3 min on a
 * 13.2 min trip, and under-estimate correlates with idle at 0.886. It is the
 * park/unpark/idle overhead every leg carries regardless of length. One
 * consequence is deliberate — because detour is computed as
 * d(prev,new) + d(new,next) − d(prev,next), the fixed terms no longer cancel and
 * inserting a stop now costs the overhead even when it sits directly en route.
 * A stop is never free; the legacy model priced it as if it were.
 */
const { HQ, haversine } = require('../route-optimizer');
const { gateEnvValue } = require('../../config/feature-gates');

const ROAD_FACTOR = 1.4;
const AVG_MPH = 30;

// Fitted per-leg overhead (minutes) and per-mile rate over STRAIGHT-LINE miles.
// The per-mile rate already carries the road-detour factor — it is not applied
// to road distance, so do not additionally multiply by ROAD_FACTOR.
const CALIBRATED_FIXED_MINUTES = 4.25;
const CALIBRATED_MINUTES_PER_MILE = 2.35;

// Below this, two points are the same place (~260 ft) and the leg is not a
// drive — no overhead is charged. Guards the HQ bookends in candidate-slots,
// where an anchor can coincide with the stop being scored.
const SAME_PLACE_MILES = 0.05;

function calibrationEnabled() {
  return gateEnvValue('GATE_DRIVE_TIME_CALIBRATION');
}

function milesToDriveMinutes(miles) {
  if (!Number.isFinite(miles) || miles <= 0) return 0;
  if (calibrationEnabled()) {
    if (miles < SAME_PLACE_MILES) return 0;
    return Math.round(CALIBRATED_FIXED_MINUTES + (miles * CALIBRATED_MINUTES_PER_MILE));
  }
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

module.exports = { HQ, haversine, driveMin, resolveGeo, milesToDriveMinutes };
