'use strict';

/**
 * A one-technician day held in memory, answered by the REAL arrival evaluator
 * (evaluateArrivalPlacement), for GATE_ROUTE_CHECK_STAFF_SAVES tests. No
 * database and no Google: the saved check and the staff placement both read
 * and write this object the way the SQL-backed pair would.
 *
 * The case it models (Codex P1 on the first push): a visit keeps its route
 * number (here 2, behind a stop it shares a start with), so read where it is
 * saved its stale order cannot keep both promises, but the staff placement
 * puts it first and the day then fits. A check run BEFORE placement warns
 * about an order the save is about to replace.
 */
const { evaluateArrivalPlacement } = require('../../services/scheduling/arrival-route');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const DATE = etDateString(addETDays(new Date(), 10));
const TECH = 'tech';
const WINDOW = { windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60 };

const stop = (id, windowStart, windowEnd, lat, overrides = {}) => ({
  id, technician_id: TECH, scheduled_date: DATE, status: 'confirmed', window_start: windowStart, window_end: windowEnd,
  estimated_duration_minutes: 60, lat, lng: -82.4, route_order: null, created_at: '2020-01-01T12:00:00Z', ...overrides,
});

function createRoute() {
  // The moved visit (9-10, near) is numbered 2 behind a two-hour stop to the
  // north (9-11, numbered 1), the same start: the stored order misses the
  // moved visit's window, the order with the moved visit first fits both.
  const state = { target: stop('target', '09:00', '10:00', 27.545, { route_order: 2 }), other: stop('other', '09:00', '11:00', 27.6, { route_order: 1 }) };
  const context = () => ({
    date: DATE, now: new Date(), grouped: false, target: { ...state.target }, rows: [{ ...state.other }],
    // The saved place: the visit where the row is stored now.
    placedAt: { date: DATE, technicianId: TECH, windowStart: state.target.window_start },
  });
  return {
    state,
    /** The advisory check as the staff saves run it: the visit where it is saved. */
    savedFit: () => evaluateArrivalPlacement(context(), { ...WINDOW, allowInsertion: false }),
    /** The staff writer's placement: try every place, write the certified order. */
    place() {
      const fit = evaluateArrivalPlacement(context(), { ...WINDOW, allowInsertion: false, place: true });
      if (!fit.feasible || !fit.routeOrder) return null;
      fit.routeOrder.forEach((id, i) => { (id === 'target' ? state.target : state.other).route_order = i + 1; });
      return fit.routeOrder;
    },
    /** The findConflictingVisits answer the arrival branch gives for the saved visit. */
    conflictRows() {
      const fit = evaluateArrivalPlacement(context(), { ...WINDOW, allowInsertion: false });
      return fit.feasible ? [] : [{ id: 'target', conflict_reason: fit.reason, warning: fit.warning }];
    },
  };
}

module.exports = { createRoute, DATE, TECH, WINDOW };
