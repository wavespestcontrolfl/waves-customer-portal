/**
 * Where a technician's day starts and ends (GATE_TECH_START_POINTS, owner
 * 2026-10-22). A tech who takes the truck home starts and ends at home; a
 * tech with no start address set starts and ends at the office (route-
 * optimizer HQ), which is every tech's route today.
 *
 * STAFF SURFACES ONLY (Codex #6435 r1). A caller opts in per request
 * (`techStartPoints: true` on findAvailableSlots, `startPoints: true` on
 * loadArrivalRouteContext): the staff picker, the Intelligence Bar and
 * auto-dispatch. Public booking, the estimate slot list and every commit-time
 * certification keep the office: a public answer carries per-technician
 * detour minutes, and on an empty day those would trace a home address.
 *
 * Read at call time. Gate off: every answer is RouteOptimizer.HQ itself (the
 * same object), so callers that compare `origin === RouteOptimizer.HQ` and
 * every route they build are exactly as before, and the technician queries
 * select no new column. A start address without both coordinates, or with
 * a coordinate that is not a finite number, is the office too.
 *
 * The coordinates are a staff home address: never log them.
 */
const RouteOptimizer = require('../route-optimizer');
const { gateEnvValue } = require('../../config/feature-gates');

const START_COLUMNS = ['start_lat', 'start_lng'];

function techStartPointsLive() {
  return !!gateEnvValue('GATE_TECH_START_POINTS');
}

// The technician columns a slot search selects: the start point's only for an
// opted-in staff caller while the gate is on, so any other query is the one it
// always was.
function techColumns(base, optIn = false) {
  return optIn && techStartPointsLive() ? [...base, ...START_COLUMNS] : base;
}

// `tech`: a row carrying start_lat / start_lng (pg decimals arrive as strings).
function techStartPoint(tech) {
  if (!techStartPointsLive() || !tech || tech.start_lat == null || tech.start_lng == null) return RouteOptimizer.HQ;
  const lat = Number(tech.start_lat);
  const lng = Number(tech.start_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return RouteOptimizer.HQ;
  return { lat, lng };
}

async function loadTechStartPoint(conn, technicianId) {
  if (!techStartPointsLive() || !technicianId) return RouteOptimizer.HQ;
  const row = await conn('technicians').where({ id: technicianId }).first(START_COLUMNS);
  return techStartPoint(row);
}

// Every technician's start point in ONE query, for a staff run that routes
// many techs (the nightly reorder). Map of lowercase tech id -> {lat, lng}
// holding only techs whose point is usable; anyone absent starts at the
// office. Gate off: an empty Map and no query. Never log the points.
async function loadTechStartPoints(conn, technicianIds = null) {
  if (!techStartPointsLive()) return new Map();
  const ids = technicianIds ? [...new Set(technicianIds.filter(Boolean))] : null;
  if (ids && !ids.length) return new Map();
  const query = conn('technicians').whereNotNull('start_lat').whereNotNull('start_lng');
  if (ids) query.whereIn('id', ids);
  const rows = await query.select(['id', ...START_COLUMNS]);
  const points = new Map();
  for (const row of rows) {
    const point = techStartPoint(row);
    if (point !== RouteOptimizer.HQ) points.set(String(row.id).toLowerCase(), point);
  }
  return points;
}

// A technician's start from a loadTechStartPoints map; the office when the
// map is absent or does not hold the tech (Postgres hands back lowercase ids).
function homeFromMap(points, technicianId) {
  return (points && technicianId != null && points.get(String(technicianId).toLowerCase())) || RouteOptimizer.HQ;
}

// Same point: the office object itself, or equal coordinates.
function sameStartPoint(a, b) {
  return a === b || (!!a && !!b && a.lat === b.lat && a.lng === b.lng);
}

// Commit-time fence for a route plan certified against `planned` (the point the
// plan was built from). Call it INSIDE the write transaction, after the
// tech-day locks: a Team-tab start-address edit that lands between the plan and
// the write must not let a route certified against the old origin be written.
// Gate on: re-reads the tech's coordinates FOR SHARE (an editor's UPDATE waits
// for this transaction) and throws `makeError()` when they no longer match.
// Gate off: no query; throws only if the plan used a non-office point (the gate
// was flipped off mid-run). The coordinates are never put in the error.
async function assertStartPointUnchanged(trx, technicianId, planned, makeError) {
  if (!technicianId) return;
  if (!techStartPointsLive()) {
    if (!sameStartPoint(planned, RouteOptimizer.HQ)) throw makeError();
    return;
  }
  const row = await trx('technicians').where({ id: technicianId }).forShare().first(START_COLUMNS);
  if (!sameStartPoint(techStartPoint(row), planned)) throw makeError();
}

module.exports = { techStartPointsLive, sameStartPoint, assertStartPointUnchanged, techColumns, techStartPoint, loadTechStartPoint, loadTechStartPoints, homeFromMap, START_COLUMNS };
