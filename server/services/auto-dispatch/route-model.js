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
const {
  workDuration, currentOrder, effectiveWindowRange, isCoVisitPair, startCoVisitChain, advanceCoVisit,
} = require('../route-reorder-window-fit');
const { driveMin, haversine, HQ } = require('./geo');

const DEFAULT_DURATION_MINUTES = 60;

// "Same area" for the day-clustering term (owner directive 2026-09-26): a
// short local hop, not a cross-town drive — roughly 6-7 minutes of drive at
// the ~30 mph model auto-dispatch/geo.js's estimator assumes off-calibration.
// Kept as a plain mile radius (not minutes) so the term never depends on
// which drive-time calibration is live.
const CLUSTER_RADIUS_MILES = 3;

/**
 * Minutes a stop keeps a technician on site for THIS model: the canonical
 * route work duration (route-reorder-window-fit.js workDuration — the owner
 * planning table when it names the service, else the legacy rule: the larger
 * of the stored window span and the estimate, else 60; Codex r2: reuse it,
 * never re-derive it). Charged to EVERY stop passed in, including the moving
 * visit — see the module doc for why that is a deliberate departure from
 * planning-minutes.js's general `planning_exempt` convention.
 */
function stopPlanningMinutes(stop) {
  if (!stop) return DEFAULT_DURATION_MINUTES;
  return workDuration({ ...stop, planning_exempt: false }, DEFAULT_DURATION_MINUTES);
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

function sumPlanningMinutes(stops) {
  return (stops || []).reduce((sum, s) => sum + stopPlanningMinutes(s), 0);
}

function hhmmFromMin(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// The keys the canonical sequence reads (route_order, window_start,
// created_at, id): a stop given only a `startMin` reads it as its start.
function withSequenceKeys(stop) {
  if (stop.window_start || !Number.isFinite(stop.startMin)) return stop;
  return { ...stop, window_start: hhmmFromMin(stop.startMin) };
}

/**
 * The day's PHYSICAL stops, in the sequence dispatch runs them
 * (route-reorder-window-fit.js currentOrder: COALESCE(route_order, 999),
 * window_start, created_at — Codex r4). Each carries `minutes`, its on-site
 * time. Rows collapse into one physical stop two ways, each with the
 * canonical duration rule:
 *   - a visit_id group (combo lawn+pest, etc.) — one drive stop at its first
 *     member's place in the sequence, members' work SUMMED (arrival-route.js
 *     groupRouteStops' contract);
 *   - a legacy null-visit_id co-visit — the row adjacent to the previous row
 *     that isCoVisitPair accepts (same customer, promised window, premise and
 *     coordinates) — merged with the co-visit duration rule
 *     (startCoVisitChain / advanceCoVisit: real estimates summed, floored by
 *     the longest window-derived duration — never a phantom extra hour).
 * A location comes from the first member that has one. Codex r1 / r3 / r4.
 */
function physicalStops(stops) {
  const out = [];
  const byVisit = new Map();
  let lastRow = null;
  for (const row of currentOrder((stops || []).filter(Boolean).map(withSequenceKeys))) {
    const group = row.visit_id != null ? byVisit.get(String(row.visit_id)) : null;
    const last = out[out.length - 1];
    if (group) {
      group.minutes += stopPlanningMinutes(row);
      group.geo = group.geo || row.geo;
    } else if (lastRow && last && last.coChain && isCoVisitPair(effectiveWindowRange, lastRow, row)) {
      last.coChain = advanceCoVisit({ clock: 0, ...last.coChain }, row);
      last.minutes = last.coChain.coMerged;
      last.geo = last.geo || row.geo;
    } else {
      const stop = { ...row, minutes: stopPlanningMinutes(row), coChain: row.visit_id != null ? null : startCoVisitChain(row) };
      if (row.visit_id != null) byVisit.set(String(row.visit_id), stop);
      out.push(stop);
    }
    lastRow = row;
  }
  return out;
}

// The day's chain WITH the moving visit: the whole chain sorted by the
// canonical dispatch comparator (currentOrder — COALESCE(route_order, 999)
// first, then window_start, then created_at), exactly as dispatch will run
// it. The visit carries the route_order it will actually have (the caller's
// job: kept on a same-day, same-tech move, cleared otherwise, per the
// rebooker) and sits at its scored start (the candidate's, or its current
// one), whatever window it stores for its duration. Codex r4 + pre-push P1:
// an unsequenced visit runs after every sequenced stop, not by its time.
function chainWithVisit(sequence, visit) {
  const v = Number.isFinite(visit.startMin) ? { ...visit, window_start: hhmmFromMin(visit.startMin) } : withSequenceKeys(visit);
  return currentOrder([...sequence, v]);
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
 *
 * `routeTimeWithMinutes` / `routeTimeWithoutMinutes` are the day's route
 * time: the drive chain plus stopPlanningMinutes for EVERY stop — the
 * existing stops and, in the "with" figure, the moving visit and any
 * `visit.unitMembers` (group members at the same stop, moving with it; they
 * add service minutes but no drive) (Codex r1: the model documented drive +
 * service minutes but charged drive only).
 * scoring.js reads `routeTimeWithMinutes` (as `route_minutes`) for its
 * workload term, so a heavier day by the owner planning table scores worse.
 * `detourMinutes` stays pure drive: scoring.js's route-efficiency cap
 * (DETOUR_CAP_MIN, 45 min) is calibrated on drive, and the mover's own
 * service minutes are identical for the current placement and every
 * candidate, so adding them there would only saturate that cap.
 */
function routeCost(otherStops, visit) {
  const sequence = physicalStops(otherStops);
  const driveWithoutMinutes = chainDriveMinutes(sequence.map((s) => s.geo));
  // Every other stop is on-site time, located or not.
  const otherServiceMinutes = sequence.reduce((sum, s) => sum + s.minutes, 0);
  const routeTimeWithoutMinutes = driveWithoutMinutes + otherServiceMinutes;
  if (!visit || !visit.geo) {
    return {
      driveWithoutMinutes,
      driveWithMinutes: driveWithoutMinutes,
      detourMinutes: 0,
      routeTimeWithoutMinutes,
      routeTimeWithMinutes: routeTimeWithoutMinutes,
    };
  }
  const driveWithMinutes = chainDriveMinutes(chainWithVisit(sequence, visit).map((s) => s.geo));
  // The moving unit: the visit plus any co-located group members moving with it.
  const visitMinutes = stopPlanningMinutes(visit) + sumPlanningMinutes(visit.unitMembers);
  const routeTimeWithMinutes = driveWithMinutes + otherServiceMinutes + visitMinutes;
  const detourMinutes = Math.max(0, driveWithMinutes - driveWithoutMinutes);
  return {
    driveWithoutMinutes, driveWithMinutes, detourMinutes, routeTimeWithoutMinutes, routeTimeWithMinutes,
  };
}

/**
 * "Same area already on that day" — the share (0..1) of `otherStops` within
 * CLUSTER_RADIUS_MILES of `geo`. Replaces the stop-count density term (same
 * 10-point weight in scoring.js) with a measure of whether the visit is
 * actually clustered with the day's other work, not just how BUSY the day
 * is. An empty day (no other stops) scores 0 — there is nothing to cluster
 * with, same as the legacy density term's empty-day floor. Shares are of
 * PHYSICAL stops (physicalStops: a visit group is one), and a stop with no
 * known location still counts in the denominator as not nearby (Codex r3) —
 * it is real work somewhere, and dropping it would read one located
 * neighbour on a day of coordless stops as a fully clustered day.
 */
function clusterShare(otherStops, geo) {
  if (!geo || !otherStops || !otherStops.length) return 0;
  const stops = physicalStops(otherStops);
  if (!stops.length) return 0;
  const nearby = stops.filter((s) => s.geo && haversine(s.geo.lat, s.geo.lng, geo.lat, geo.lng) <= CLUSTER_RADIUS_MILES).length;
  return Math.max(0, Math.min(1, nearby / stops.length));
}

module.exports = {
  CLUSTER_RADIUS_MILES,
  stopPlanningMinutes,
  chainDriveMinutes,
  routeCost,
  clusterShare,
  _internals: { physicalStops, chainWithVisit, sumPlanningMinutes },
};
