'use strict';

/**
 * GATE_ROUTE_CHECK_STAFF_SAVES (owner 2026-10-29, Route Check Everywhere
 * build 2a). The staff saves that checked only for an overlap run the
 * dispatcher's arrival-window route check on the SAVED visit too, and show its
 * warning, the way Edit's save does (routes/admin-schedule.js update-details).
 *
 *  - WARN ONLY. Nothing here throws into a save or refuses one; a failed
 *    check is logged and reads as "no warning".
 *  - Cache road times only (`roads: 'cache'`, arrival-route.js staffSaveTravel):
 *    no Google call, no spend.
 *  - The writer's own overlap probe is NOT replaced. With the arrival check on,
 *    findConflictingVisits answers with the route result instead of the
 *    overlap SQL, so the route check is a SECOND, advisory probe: a writer that
 *    refuses a real overlap (the Intelligence Bar's pinned "no overlap" card)
 *    keeps doing so on its own probe, and a route result can never refuse.
 *  - Gate off (unset): every function here returns nothing and touches nothing.
 */

const logger = require('../logger');

function routeCheckLive() {
  const { routeCheckStaffSavesLive } = require('./arrival-route');
  return typeof routeCheckStaffSavesLive === 'function' && routeCheckStaffSavesLive() === true;
}

/** The `arrivalWindow` argument findConflictingVisits takes for a saved visit. */
function routeCheckArrivalWindow(serviceId) {
  return { serviceId, roads: 'cache' };
}

/**
 * Route warnings for a visit already written on `conn` (inside the save's
 * transaction), in its final place: date, start, end and technician. Read under a
 * savepoint, so a failed read cannot poison the save. Returns [] when the gate
 * is off, the visit has no window or technician, or the route fits.
 */
async function staffSaveRouteWarnings(conn, { serviceId, date, windowStart, windowEnd, technicianId } = {}) {
  // An unassigned visit has no route to verify: skipping it keeps "could not
  // verify the route" off every unassigned booking.
  if (!conn || !serviceId || !date || !windowStart || !windowEnd || !technicianId) return [];
  if (!routeCheckLive()) return [];
  const { findConflictingVisits } = require('./occupancy');
  const { ADMIN_OCCUPANCY_EXCLUDE_STATUSES, slotOverlapWarning } = require('./window-rules');
  const dateStr = String(date).split('T')[0];
  const probe = (db) => findConflictingVisits({
    db,
    date: dateStr,
    windowStart: String(windowStart).slice(0, 5),
    windowEnd: String(windowEnd).slice(0, 5),
    excludeServiceIds: [String(serviceId)],
    excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
    arrivalWindow: routeCheckArrivalWindow(serviceId),
  });
  try {
    const rows = typeof conn.transaction === 'function' ? await conn.transaction(probe) : await probe(conn);
    return [...new Set((rows || []).map((row) => row.warning || slotOverlapWarning(dateStr)))];
  } catch (err) {
    logger.warn(`[staff-save-route-check] route check skipped for ${serviceId}: ${err.message}`);
    return [];
  }
}

/**
 * Number the visit's technician day in the order the route check certified
 * (placeMovedVisit, staff save). Call INSIDE the write transaction after the
 * insert or update: outside one it is a silent no-op. Never throws, and a no-op
 * unless GATE_STAFF_ROUTE_INSERTION is on as well.
 */
async function placeStaffSavedVisit(conn, { serviceId, source } = {}) {
  if (!conn || !serviceId) return null;
  if (!routeCheckLive()) return null;
  return require('./arrival-route').placeMovedVisit(conn, { serviceId, staffSave: true, ...(source ? { source } : {}) });
}

module.exports = { routeCheckLive, routeCheckArrivalWindow, staffSaveRouteWarnings, placeStaffSavedVisit };
