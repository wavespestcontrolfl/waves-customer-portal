/**
 * ROUTE-TIERS — tiered move-radius rules for auto-dispatch day-moves.
 *
 * Replaces the flat 14-day lock with a tier ladder over "days until the
 * appointment" (owner-approved 2026-08-13), ACTIVE ONLY while
 * GATE_ROUTE_TIERS is on (config.routeTiersEnabled). Gate off = the legacy
 * flat-lock behavior, byte for byte (see tests/route-tiers-gate-off).
 *
 *   Tier 1  >= 14 days out   day-moves allowed, radius ±5 days
 *   Tier 2  7–13 days out    day-moves allowed, radius ±3 days
 *   Tier 3  < 7 days out     NO day-moves (intra-day reorder only —
 *                            services/route-reorder.js owns that band)
 *   Frozen  < 72h OR the 72-hour reminder was already SENT — nothing touches
 *           the visit. The reminder is the HARD gate, not the clock: the 72h
 *           SMS promises "{day} at {time}", so once it went out the promise
 *           must hold.
 *
 * Safety rails carried here:
 *   - Cumulative drift budget: every candidate date must stay within ±5 days
 *     of the visit's recurrence ANCHOR (the date the series originally gave
 *     it), shared across tiers — a tier-2 move can only spend what tier 1
 *     left. Anchor derivation (existing data, no new columns):
 *       change_count 0/null  → the current scheduled_date IS the anchor
 *       change_count > 0     → the FIRST auto_dispatch_audit_logs
 *                              action='changed' row's old_scheduled_date
 *                              (append-only ledger of every applied move)
 *       change_count > 0 with no audit row → anchor UNKNOWN → NO MOVE
 *       (fail closed — never guess a budget).
 *   - Destination legality: no move may LAND a visit under
 *     MIN_DESTINATION_DAYS_OUT (5) days from today. Moving later is always
 *     fine; moving earlier only while the destination stays >= 5 days away.
 *   - Reminder freeze is FAIL CLOSED: if the reminder-sent status cannot be
 *     read for a visit, the visit is treated as frozen.
 *
 * Writer signature for the reminder freeze (verified against
 * services/appointment-reminders.js + migration 20260401000078):
 *   appointment_reminders.reminder_72h_sent = true on the row whose
 *   scheduled_service_id = the visit (UNIQUE — at most one row per visit).
 *   suppressed_by_sibling=true rows are non-delivering placeholders (their
 *   flags are pre-set true at insert and never mean a send); for those the
 *   OWNER row for the same (customer_id, appointment_time) slot carries the
 *   real flag — its send covers the merged label, so it freezes the sibling
 *   visit too. windows_preclosed=true implies suppressed_by_sibling=true
 *   (migration 20260720000000 invariant), so one predicate covers both.
 */
const { toDateStr, shiftDateStr } = require('./dates');

// Tier ladder (owner-ruled constants — not env-tunable on purpose; the gate is
// the kill switch, the ladder itself is the approved policy).
const TIER1_MIN_DAYS_OUT = 14;
const TIER1_RADIUS_DAYS = 5;
const TIER2_MIN_DAYS_OUT = 7;
const TIER2_RADIUS_DAYS = 3;
const DRIFT_BUDGET_DAYS = 5;
const MIN_DESTINATION_DAYS_OUT = 5;
const FREEZE_HOURS = 72;

/** Whole calendar days from `fromStr` to `toStr` (YYYY-MM-DD each), UTC-noon
 *  anchored so DST seams can't roll the count. null on unparseable input. */
function daysBetween(fromStr, toStr) {
  if (!fromStr || !toStr) return null;
  const a = new Date(`${String(fromStr).split('T')[0]}T12:00:00Z`);
  const b = new Date(`${String(toStr).split('T')[0]}T12:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Allowed day-move radius for a visit `daysOut` days from today. 0 = no day-moves. */
function tierRadiusForDaysOut(daysOut) {
  if (!Number.isFinite(daysOut)) return 0;
  if (daysOut >= TIER1_MIN_DAYS_OUT) return TIER1_RADIUS_DAYS;
  if (daysOut >= TIER2_MIN_DAYS_OUT) return TIER2_RADIUS_DAYS;
  return 0;
}

/**
 * The candidate-date window a tiered move may search: the INTERSECTION of
 *   [orig - radius, orig + radius]      (tier radius, from the CURRENT date)
 *   [anchor - 5, anchor + 5]            (cumulative drift budget)
 *   [today + 5, ∞)                      (destination legality floor)
 * Returns { dateFrom, dateTo } or null when the intersection is empty.
 */
function tierMoveWindow({ origDate, anchorDate, today, radius }) {
  const orig = toDateStr(origDate);
  const anchor = toDateStr(anchorDate);
  if (!orig || !anchor || !today || !radius) return null;
  const floor = shiftDateStr(today, MIN_DESTINATION_DAYS_OUT);
  let dateFrom = shiftDateStr(orig, -radius);
  const anchorFrom = shiftDateStr(anchor, -DRIFT_BUDGET_DAYS);
  if (anchorFrom > dateFrom) dateFrom = anchorFrom;
  if (floor > dateFrom) dateFrom = floor;
  let dateTo = shiftDateStr(orig, radius);
  const anchorTo = shiftDateStr(anchor, DRIFT_BUDGET_DAYS);
  if (anchorTo < dateTo) dateTo = anchorTo;
  if (dateFrom > dateTo) return null;
  return { dateFrom, dateTo };
}

/**
 * Bulk-load recurrence anchors for a set of already-moved services.
 * Returns Map<serviceId, 'YYYY-MM-DD'>. Services with change_count 0/null are
 * NOT queried — their anchor is their current scheduled_date (resolveAnchor).
 * On query failure returns null (callers must then treat every moved visit as
 * anchor-unknown → no move; fail closed).
 */
async function loadAnchorMap(db, movedServiceIds) {
  const map = new Map();
  if (!movedServiceIds || movedServiceIds.length === 0) return map;
  try {
    const rows = await db('auto_dispatch_audit_logs')
      .whereIn('scheduled_service_id', movedServiceIds)
      .where('action', 'changed')
      .orderBy('created_at', 'asc')
      .select('scheduled_service_id', 'old_scheduled_date', 'created_at');
    for (const r of rows) {
      if (!map.has(r.scheduled_service_id)) {
        const d = toDateStr(r.old_scheduled_date);
        if (d) map.set(r.scheduled_service_id, d);
      }
    }
    return map;
  } catch (_) {
    return null; // fail closed upstream
  }
}

/** Resolve one visit's anchor date, or null when unknown (→ no move). */
function resolveAnchor(service, anchorMap) {
  const changeCount = service.auto_dispatch_change_count || 0;
  if (changeCount === 0) return toDateStr(service.scheduled_date);
  if (!anchorMap) return null; // bulk load failed — unknown, fail closed
  return anchorMap.get(service.id) || null; // moved but no audit trail → unknown
}

/**
 * Bulk reminder-freeze lookup for a set of scheduled_service ids.
 *
 * Returns { failed, frozen:Set<id> }:
 *   failed=true  → the status could not be read; callers MUST treat EVERY
 *                  visit as frozen (fail closed).
 *   frozen       → ids whose 72h reminder is recorded as sent (directly, or
 *                  via the owning sibling row for the same appointment slot).
 */
async function loadReminderFreeze(db, serviceIds) {
  if (!serviceIds || serviceIds.length === 0) return { failed: false, frozen: new Set() };
  try {
    const rows = await db('appointment_reminders')
      .whereIn('scheduled_service_id', serviceIds)
      .select('scheduled_service_id', 'customer_id', 'appointment_time',
        'reminder_72h_sent', 'suppressed_by_sibling');

    const frozen = new Set();
    const suppressed = [];
    for (const r of rows) {
      if (r.suppressed_by_sibling === true) {
        // Placeholder — its own flags never mean a send. The slot's OWNER row
        // (checked below) decides.
        suppressed.push(r);
      } else if (r.reminder_72h_sent === true) {
        frozen.add(r.scheduled_service_id);
      }
    }

    if (suppressed.length) {
      // Owner rows share (customer_id, appointment_time) and are the
      // deliverable senders (suppressed_by_sibling=false). If the owner's 72h
      // went out, the merged-label text covered the suppressed visit too.
      const customerIds = [...new Set(suppressed.map((r) => r.customer_id).filter(Boolean))];
      const owners = await db('appointment_reminders')
        .whereIn('customer_id', customerIds)
        .where('suppressed_by_sibling', false)
        .where('reminder_72h_sent', true)
        .select('customer_id', 'appointment_time');
      const sentSlots = new Set(owners.map((o) => `${o.customer_id}:${new Date(o.appointment_time).getTime()}`));
      for (const r of suppressed) {
        if (sentSlots.has(`${r.customer_id}:${new Date(r.appointment_time).getTime()}`)) {
          frozen.add(r.scheduled_service_id);
        }
      }
    }

    return { failed: false, frozen };
  } catch (_) {
    return { failed: true, frozen: new Set() }; // fail closed upstream
  }
}

module.exports = {
  TIER1_MIN_DAYS_OUT,
  TIER1_RADIUS_DAYS,
  TIER2_MIN_DAYS_OUT,
  TIER2_RADIUS_DAYS,
  DRIFT_BUDGET_DAYS,
  MIN_DESTINATION_DAYS_OUT,
  FREEZE_HOURS,
  daysBetween,
  tierRadiusForDaysOut,
  tierMoveWindow,
  loadAnchorMap,
  resolveAnchor,
  loadReminderFreeze,
};
