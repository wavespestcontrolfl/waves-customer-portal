/**
 * FLEX-TIER — Flexible-tier day moves for existing recurring visits
 * (owner-approved 2026-09-25/26, capacity-picker-scope-20260925.md §11:
 * "this is costing us the most money"). Runs INSIDE the auto-dispatch pass,
 * ACTIVE ONLY while GATE_AUTO_DISPATCH_FLEX_TIER is on (see
 * config.js/feature-gates.js) — off, none of this module runs.
 *
 * Owner rules:
 *   Fixed tier  = a series' first visit, and every one-time/first-time
 *                 customer's visit — never touched here. eligibility.js's
 *                 existing recurring-child-only checks (NON_RECURRING,
 *                 PARENT_TEMPLATE_ROW) already exclude both: the parent row
 *                 IS the series' first visit, so a "child" (recurring_parent_id
 *                 set) is always a 2nd+ occurrence.
 *   Flexible tier = everything eligibility.js lets through. May re-time SAME
 *                 DAY, or move up to ±FLEX_TIER_RADIUS_DAYS days, SILENTLY —
 *                 no customer comms (apply.js's rebooker call is unchanged;
 *                 it already sends none) — until FLEX_TIER_FREEZE_HOURS
 *                 before the visit. That freeze is deliberately tighter than
 *                 route-tiers' own 72.25h reminder-claimable band (fully
 *                 covers it), so the 72-hour reminder — which reads the
 *                 scheduled_services_sync_reminder-synced row at SEND time,
 *                 not a snapshot (verified: the DB trigger keeps
 *                 appointment_reminders.appointment_time in lockstep with
 *                 every scheduled_date/window_start UPDATE, auto-dispatch's
 *                 included, and the cron's own SELECT re-reads the table
 *                 fresh each 15-minute tick) — always carries the FINAL
 *                 window.
 *   Guard       = a move must never cross the series' adjacent occurrence:
 *                 series order is COALESCE(date_exception_cadence_date,
 *                 scheduled_date) among the parent row and its live children
 *                 (rebooker.js's own seriesPosition/readSiblings key, reused
 *                 here via loadSeriesNeighbors rather than re-derived).
 */
const { toDateStr, shiftDateStr } = require('./dates');
const { MIN_DESTINATION_DAYS_OUT } = require('./route-tiers');

// Owner-ruled constants (not env-tunable — the gate is the kill switch, the
// numbers themselves are the approved policy, same convention as
// route-tiers.js's tier ladder).
const FLEX_TIER_RADIUS_DAYS = 5;
const FLEX_TIER_FREEZE_HOURS = 73;

// A sibling occurrence must be live to anchor the guard — mirrors
// rebooker.js's own TERMINAL exclusion (readSiblings/seriesPosition), so a
// cancelled/completed occurrence never bounds the window.
const TERMINAL_STATUSES = ['completed', 'cancelled'];

/** One row's position in its series — mirrors rebooker.js's seriesPosition. */
function seriesPosition(row) {
  return toDateStr(row.date_exception === true && row.date_exception_cadence_date
    ? row.date_exception_cadence_date
    : row.scheduled_date);
}

/**
 * Bulk-load the adjacent occurrence dates for each of `services` (assumed
 * already Flexible-tier eligible — is_recurring, recurring_parent_id set): a
 * series' members are the parent row (its first visit) plus every non-
 * terminal child, ordered by seriesPosition. One query per distinct parent
 * id. Returns Map<serviceId, {prev, next}> ('YYYY-MM-DD' strings, or null
 * when there is no occurrence on that side), or null on a query failure
 * (fail closed — callers must treat every visit as guard-unknown, i.e. no
 * move, the same posture route-tiers' loadAnchorMap takes).
 */
async function loadSeriesNeighbors(db, services) {
  const map = new Map();
  const byParent = new Map();
  for (const s of services || []) {
    const parentId = s && s.recurring_parent_id;
    if (!parentId) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(s);
  }
  if (byParent.size === 0) return map;
  try {
    // One series at a time (never more than a handful of distinct parents
    // in a single run's eligible set) — kept sequential rather than
    // Promise.all so a busy run never opens unboundedly many concurrent
    // per-series reads.
    for (const [parentId, members] of byParent) {
      const rows = await db('scheduled_services')
        .where(function withParentOrChild() { this.where('id', parentId).orWhere('recurring_parent_id', parentId); })
        .whereNotIn('status', TERMINAL_STATUSES)
        .select('id', 'scheduled_date', 'date_exception', 'date_exception_cadence_date');
      const positioned = rows
        .map((r) => ({ id: String(r.id), position: seriesPosition(r) }))
        .filter((r) => r.position)
        .sort((a, b) => (a.position < b.position ? -1 : (a.position > b.position ? 1 : 0)));
      for (const s of members) {
        const idx = positioned.findIndex((r) => r.id === String(s.id));
        map.set(s.id, {
          prev: idx > 0 ? positioned[idx - 1].position : null,
          next: (idx > -1 && idx < positioned.length - 1) ? positioned[idx + 1].position : null,
        });
      }
    }
    return map;
  } catch (_) {
    return null; // fail closed upstream
  }
}

/**
 * The Flexible-tier candidate-date window for one visit: ±FLEX_TIER_RADIUS_DAYS
 * of its current date, clamped so it
 *   - never reaches or crosses the series' adjacent occurrence (`neighbors`),
 *   - never goes below MIN_DESTINATION_DAYS_OUT of today EXCEPT that the
 *     visit's own current date always stays reachable (same-day re-time is
 *     owner-mandated right up to the freeze, and the freeze alone already
 *     keeps the current date safely in the future — see FLEX_TIER_FREEZE_HOURS
 *     vs MIN_DESTINATION_DAYS_OUT above),
 *   - never extends the upper bound past the lookahead horizon (the caller,
 *     candidate-slots.js, already applies that cap to any ctx.tierWindow).
 * Returns {dateFrom, dateTo} or null when the intersection is empty (e.g.
 * the previous and next occurrence both sit inside the radius).
 */
function flexTierMoveWindow({ origDate, today, neighbors }) {
  const orig = toDateStr(origDate);
  if (!orig || !today) return null;
  const floor = shiftDateStr(today, MIN_DESTINATION_DAYS_OUT);
  let dateFrom = shiftDateStr(orig, -FLEX_TIER_RADIUS_DAYS);
  if (floor > dateFrom) dateFrom = floor;
  if (dateFrom > orig) dateFrom = orig; // same-day re-time must always stay reachable
  const prevFloor = neighbors && neighbors.prev ? shiftDateStr(neighbors.prev, 1) : null;
  if (prevFloor && prevFloor > dateFrom) dateFrom = prevFloor;

  let dateTo = shiftDateStr(orig, FLEX_TIER_RADIUS_DAYS);
  const nextCeil = neighbors && neighbors.next ? shiftDateStr(neighbors.next, -1) : null;
  if (nextCeil && nextCeil < dateTo) dateTo = nextCeil;

  if (dateFrom > dateTo) return null;
  return { dateFrom, dateTo };
}

module.exports = {
  FLEX_TIER_RADIUS_DAYS,
  FLEX_TIER_FREEZE_HOURS,
  seriesPosition,
  loadSeriesNeighbors,
  flexTierMoveWindow,
};
