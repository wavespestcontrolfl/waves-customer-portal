/**
 * Route-stop activity predicate — PURE (no DB/I/O), unit-testable.
 *
 * GATE_AUTO_DISPATCH_SHARED_MODEL, dispatch backlog item 3.
 *
 * The SLOT_TAKEN pre-filter no longer lives here: candidate-slots.js asks
 * the rebooker's own read-only probe (probeMoveConflicts) instead of a
 * re-expression of its overlap rule.
 *
 * isActiveRouteStop() is a different concern — whether a
 * day's OTHER stop is a live route stop at all (not a non-route-stop status
 * or completed, not an expired estimate-slot hold) — used to filter which
 * rows count for route-model.js's drive-cost/cluster-share math (those
 * calculations have no such check of their own; an expired hold or a
 * no_show row must be invisible to them, not just to occupancy checks).
 */
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');

// Same status set the writer's occupancy WHERE excludes (NOT_A_ROUTE_STOP_STATUSES
// plus 'completed' — a finished morning visit must not block an afternoon move).
const OVERLAP_EXCLUDED_STATUSES = new Set([...NOT_A_ROUTE_STOP_STATUSES, 'completed']);

/** Whether `row` is a LIVE route stop at all: not a non-route-stop status or
 *  completed, and not an expired estimate-slot hold. */
function isActiveRouteStop(row) {
  if (!row) return false;
  if (OVERLAP_EXCLUDED_STATUSES.has(String(row.status))) return false;
  if (row.reservation_expires_at) {
    const expires = new Date(row.reservation_expires_at).getTime();
    if (Number.isFinite(expires) && expires <= Date.now()) return false;
  }
  return true;
}

module.exports = {
  isActiveRouteStop,
  OVERLAP_EXCLUDED_STATUSES,
};
