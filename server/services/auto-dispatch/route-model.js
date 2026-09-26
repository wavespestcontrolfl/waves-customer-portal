/**
 * Shared placement route-cost model — PURE (no DB/I/O), unit-testable.
 *
 * GATE_AUTO_DISPATCH_SHARED_MODEL (owner-approved 2026-09-26, dispatch
 * backlog item 3): the CURRENT placement and every CANDIDATE placement score
 * on ONE model — the calibrated drive-time estimator auto-dispatch/geo.js's
 * driveMin wraps (route-optimizer's model; GATE_DRIVE_TIME_CALIBRATION
 * governs which estimator that resolves to — no Google/Distance Matrix calls
 * either way) plus the owner planning-minutes table
 * (scheduling/planning-minutes.js), applied to EVERY stop in the day's chain
 * — including the moving visit itself.
 *
 * That last point is the one deliberate difference from the general
 * arrival-route placement contract (scheduling/arrival-route.js
 * buildPlacementTarget): a fresh booking/reschedule exempts the stop BEING
 * PLACED from planning minutes because its duration is already the caller-
 * resolved allowance. Auto-dispatch moves an EXISTING recurring visit with a
 * known planning-minutes category, and the 2026-09-26 incident traced part
 * of its false "improvement" scores to exactly this asymmetry: candidates
 * (via the capacity-mode arrival-route simulation) planned every OTHER stop
 * at its owner minutes but charged the mover its full estimate/default
 * (60 min), while the CURRENT placement used plain haversine and charged
 * nothing at all. This module gives both sides the same arithmetic.
 */
const { plannedWorkMinutes } = require('../scheduling/planning-minutes');
const { driveMin, haversine, HQ } = require('./geo');

const DEFAULT_DURATION_MINUTES = 60;

// "Same area" for the day-clustering term (owner directive 2026-09-26): a
// short local hop, not a cross-town drive — roughly 6-7 minutes of drive at
// the ~30 mph model auto-dispatch/geo.js's estimator assumes off-calibration.
// Kept as a plain mile radius (not minutes) so the term never depends on
// which drive-time calibration is live.
const CLUSTER_RADIUS_MILES = 3;

/**
 * Minutes a stop keeps a technician on site for THIS model: the owner
 * planning table when it names the service, else the stop's own promised
 * estimate/window (the legacy rule plannedWorkMinutes falls back to for an
 * unnamed service, or when GATE_SCHEDULING_CAPACITY is off). Charged to
 * EVERY stop passed in, including the moving visit — see the module doc for
 * why that is a deliberate departure from planning-minutes.js's general
 * `planning_exempt` convention.
 */
function stopPlanningMinutes(stop) {
  if (!stop) return DEFAULT_DURATION_MINUTES;
  const planned = plannedWorkMinutes({ ...stop, planning_exempt: false });
  if (planned != null) return planned;
  return Number(stop.estimated_duration_minutes) || DEFAULT_DURATION_MINUTES;
}

/** Total drive minutes for HQ -> ordered stops -> HQ, using the calibrated
 *  chain model (geo.js's driveMin) — a plain point-to-point sum, never a
 *  Google/traffic call. */
function chainDriveMinutes(orderedGeos) {
  const points = [HQ, ...(orderedGeos || []).filter(Boolean), HQ];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) total += driveMin(points[i], points[i + 1]);
  return total;
}

/**
 * Route cost of a technician-day's stop chain WITH and WITHOUT one visit —
 * the shared measure the current placement and every candidate score
 * against. `otherStops` is the day's OTHER stops (never the visit itself),
 * each `{ geo, startMin }`; `visit` is `{ geo, startMin }` for the position
 * being scored (the visit's CURRENT window for the current placement, or a
 * candidate's window for a candidate). Stops are chained in window-start
 * order (the day's real/promised sequence) — this measures the visit's
 * marginal drive contribution, never a re-optimized stop order.
 *
 * Returns the SAME `detourMinutes` quantity for a current placement (its
 * removal savings) and a candidate (its insertion cost), so the two are
 * finally comparable on one scale (root cause b of the 2026-09-26 incident).
 */
function routeCost(otherStops, visit) {
  const others = (otherStops || []).filter((s) => s && s.geo).sort((a, b) => a.startMin - b.startMin);
  const driveWithoutMinutes = chainDriveMinutes(others.map((s) => s.geo));
  if (!visit || !visit.geo) {
    return { driveWithoutMinutes, driveWithMinutes: driveWithoutMinutes, detourMinutes: 0 };
  }
  const withVisit = [...others, visit].sort((a, b) => a.startMin - b.startMin);
  const driveWithMinutes = chainDriveMinutes(withVisit.map((s) => s.geo));
  return { driveWithoutMinutes, driveWithMinutes, detourMinutes: Math.max(0, driveWithMinutes - driveWithoutMinutes) };
}

/**
 * "Same area already on that day" — the share (0..1) of `otherStops` within
 * CLUSTER_RADIUS_MILES of `geo`. Replaces the stop-count density term (same
 * 10-point weight in scoring.js) with a measure of whether the visit is
 * actually clustered with the day's other work, not just how BUSY the day
 * is. An empty day (no other stops) scores 0 — there is nothing to cluster
 * with, same as the legacy density term's empty-day floor.
 */
function clusterShare(otherStops, geo) {
  if (!geo || !otherStops || !otherStops.length) return 0;
  const withGeo = otherStops.filter((s) => s && s.geo);
  if (!withGeo.length) return 0;
  const nearby = withGeo.filter((s) => haversine(s.geo.lat, s.geo.lng, geo.lat, geo.lng) <= CLUSTER_RADIUS_MILES).length;
  return Math.max(0, Math.min(1, nearby / withGeo.length));
}

module.exports = {
  CLUSTER_RADIUS_MILES,
  stopPlanningMinutes,
  chainDriveMinutes,
  routeCost,
  clusterShare,
};
