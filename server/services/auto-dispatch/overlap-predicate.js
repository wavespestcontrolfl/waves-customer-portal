/**
 * Route-stop activity predicate — PURE (no DB/I/O), unit-testable.
 *
 * GATE_AUTO_DISPATCH_SHARED_MODEL, dispatch backlog item 3.
 *
 * Superseded (Codex pre-push P1, 2026-09-26): this module used to also
 * carry a hand-rolled re-expression of SmartRebooker.reschedule's
 * TECH-SCOPED hard window-overlap probe (intervalsOverlap/conflictsWithStop/
 * candidateHasOverlap), for candidate-slots.js's SLOT_TAKEN pre-filter. That
 * re-derivation still missed what the writer's OTHER, tech-BLIND check
 * actually enforces (rebooker.js probeMoveConflicts -> scheduling/
 * occupancy.js findConflictingVisits has no technician_id filter at all —
 * "Waves runs exactly ONE active field technician, so any time overlap ...
 * is a real-world clash whether the rows carry a technician_id, carry
 * different ones, or carry none," occupancy.js header; AGENTS.md's
 * "tech-scoped conflict WHEREs are blind to technician-NULL rows" mirror
 * rule) — and since that tech-blind check is a strict superset of the
 * tech-scoped one (identical status/hold/windowless rules, just without the
 * technician_id narrowing), checking it alone is sufficient. candidate-
 * slots.js now calls the canonical reader (scheduling/occupancy.js's
 * listOccupiedWindows, batched by date) directly for that pre-filter
 * instead of re-deriving its WHERE — the removed functions are obsolete and
 * deleted here rather than kept unused.
 *
 * isActiveRouteStop() remains: a DIFFERENT, still-live concern — whether a
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
