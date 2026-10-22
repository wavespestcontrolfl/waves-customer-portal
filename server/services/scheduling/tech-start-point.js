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

module.exports = { techStartPointsLive, techColumns, techStartPoint, loadTechStartPoint, START_COLUMNS };
