/**
 * Shared window-overlap predicate — PURE (no DB/I/O), unit-testable.
 *
 * GATE_AUTO_DISPATCH_SHARED_MODEL factors SmartRebooker.reschedule's hard
 * per-technician window-overlap probe (server/services/rebooker.js, the
 * `!useArrivalWindows` branch, ~line 1542) into this pure re-expression so
 * the candidate finder can apply the SAME rule the move writer enforces
 * BEFORE offering a candidate — the 2026-09-26 incident (282 evaluated, 17
 * applied, 72 SLOT_TAKEN) traced to the finder offering slots the writer's
 * probe then refused.
 *
 * This module does NOT loosen the writer's rule — the rebooker's own SQL
 * probe is unchanged; this is the identical half-open interval-overlap test
 * (existing.window_start < new.window_end AND existing.effective_end >
 * new.window_start), re-expressed for in-memory pre-filtering rather than a
 * live query. A touching boundary (one stop's end equals the next stop's
 * start) is NOT a conflict, matching the writer's strict `<`/`>` comparison.
 *
 * Excluded from a conflict, exactly like the writer's WHERE clause:
 *   - the moving visit's own row, and any id the caller names (visit-group
 *     members moving together — the rebooker's excludeServiceIds)
 *   - a non-route-stop status (cancelled/skipped/no_show/rescheduled) or a
 *     completed stop
 *   - an expired estimate-slot hold (reservation_expires_at in the past)
 *   - a row with no window_start (nothing to overlap)
 *
 * isActiveRouteStop() exposes the status/expiry half of that exclusion on
 * its own (everything above except the id exclusion, which is per-candidate)
 * so a caller can filter a day's stop LIST to the ones that are actually
 * there before running OTHER math over them — route-model.js's drive-cost
 * and cluster-share calculations have no overlap check of their own, so an
 * expired hold or no_show row must be filtered out before it reaches them,
 * not just before the overlap probe.
 */
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');

// Same status set the writer's occupancy WHERE excludes (NOT_A_ROUTE_STOP_STATUSES
// plus 'completed' — a finished morning visit must not block an afternoon move).
const OVERLAP_EXCLUDED_STATUSES = new Set([...NOT_A_ROUTE_STOP_STATUSES, 'completed']);

const DEFAULT_DURATION_MINUTES = 60;

function hhmmToMin(t) {
  if (t == null) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

/** Half-open interval overlap: [aStart,aEnd) vs [bStart,bEnd). Touching
 *  endpoints (aEnd === bStart) are NOT a conflict — mirrors the writer's
 *  strict `<` / `>` SQL comparison. */
function intervalsOverlap(aStartMin, aEndMin, bStartMin, bEndMin) {
  if (![aStartMin, aEndMin, bStartMin, bEndMin].every(Number.isFinite)) return false;
  return aStartMin < bEndMin && bStartMin < aEndMin;
}

/** Whether `row` is a LIVE route stop at all — the writer's occupancy-probe
 *  status/expiry rules (not the per-candidate id exclusion, which is
 *  caller-specific): not a non-route-stop status or completed, and not an
 *  expired estimate-slot hold. Factored out of conflictsWithStop so other
 *  callers can filter a day's stops to the ones that are ACTUALLY there
 *  before running route-cost/clustering math over them — an expired hold or
 *  a no_show row is invisible to the overlap probe already; it must be
 *  invisible to drive/cluster scoring too, or a day whose only "stops" are
 *  expired holds reads as a busy, clustered day it never was. */
function isActiveRouteStop(row) {
  if (!row) return false;
  if (OVERLAP_EXCLUDED_STATUSES.has(String(row.status))) return false;
  if (row.reservation_expires_at) {
    const expires = new Date(row.reservation_expires_at).getTime();
    if (Number.isFinite(expires) && expires <= Date.now()) return false;
  }
  return true;
}

/** Whether an existing tech-day `row` conflicts with a candidate window
 *  [startMin, endMin) — the exact predicate the writer's occupancy probe
 *  applies for one other stop. `excludeIds` is a Set of string ids to skip
 *  (the moving visit + any visit-group members moving with it). */
function conflictsWithStop(row, { startMin, endMin, excludeIds = new Set() }) {
  if (!row || row.id == null) return false;
  if (excludeIds.has(String(row.id))) return false;
  if (!isActiveRouteStop(row)) return false;
  const rowStart = hhmmToMin(row.window_start);
  if (rowStart == null) return false;
  const rowEnd = row.window_end != null
    ? hhmmToMin(row.window_end)
    : rowStart + (Number(row.estimated_duration_minutes) || DEFAULT_DURATION_MINUTES);
  return intervalsOverlap(rowStart, rowEnd, startMin, endMin);
}

/** Whether ANY of `stops` (one technician-day's other stops) conflicts with
 *  a candidate window — true means the writer would refuse this candidate
 *  with SLOT_TAKEN. `excludeIds` should include the moving visit's own id
 *  and any visit-group members moving with it. */
function candidateHasOverlap(stops, { startMin, endMin, excludeIds = new Set() }) {
  return (stops || []).some((row) => conflictsWithStop(row, { startMin, endMin, excludeIds }));
}

module.exports = {
  intervalsOverlap,
  isActiveRouteStop,
  conflictsWithStop,
  candidateHasOverlap,
  OVERLAP_EXCLUDED_STATUSES,
  _internals: { hhmmToMin },
};
