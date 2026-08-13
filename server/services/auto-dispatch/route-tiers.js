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
 *     left. Anchor derivation (existing data, no new columns), CUMULATIVE
 *     across every durable auto-move record so a lost best-effort stamp can
 *     never reset the budget (codex pre-push P1):
 *       1. reschedule_log rows written INSIDE the rebooker's move
 *          transaction with the auto-dispatch writer signature
 *          (reason_code='auto_dispatch' AND initiated_by='auto_dispatch') —
 *          atomic with the move itself, the primary source;
 *       2. auto_dispatch_audit_logs action='changed' rows (append-only);
 *       3. the auto_dispatch_change_count stamp.
 *     Anchor = the EARLIEST recorded pre-move date across 1+2. No evidence
 *     anywhere → the current scheduled_date IS the anchor (never moved).
 *     change_count > 0 with no dated evidence, or an unreadable evidence
 *     query → anchor UNKNOWN → NO MOVE (fail closed — never guess a budget).
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
 * Bulk-load durable auto-move evidence for ALL loaded services (never keyed
 * off the best-effort change_count stamp alone — a stamp that failed after a
 * committed move would otherwise reset the anchor and un-spend the drift
 * budget). Returns Map<serviceId, earliest 'YYYY-MM-DD' pre-move date>; a
 * service ABSENT from the map has no recorded auto-move. On query failure
 * returns null (callers must treat EVERY visit as anchor-unknown → no move;
 * fail closed).
 */
async function loadAnchorMap(db, serviceIds) {
  const map = new Map();
  if (!serviceIds || serviceIds.length === 0) return map;
  try {
    // Two durable sources, merged by TIMESTAMP: the anchor is the pre-move
    // date of the chronologically EARLIEST record across BOTH — never
    // source-priority, which could let a later reschedule_log row shadow an
    // earlier audit record and quietly restore spent drift budget.
    //   1. reschedule_log rows the rebooker writes INSIDE the move
    //      transaction — strict auto-dispatch writer signature on both cols.
    //   2. the append-only auto_dispatch_audit_logs 'changed' trail.
    const moveRows = await db('reschedule_log')
      .whereIn('scheduled_service_id', serviceIds)
      .where('reason_code', 'auto_dispatch')
      .where('initiated_by', 'auto_dispatch')
      .orderBy('created_at', 'asc')
      .select('scheduled_service_id', 'original_date', 'created_at');
    const auditRows = await db('auto_dispatch_audit_logs')
      .whereIn('scheduled_service_id', serviceIds)
      .where('action', 'changed')
      .orderBy('created_at', 'asc')
      .select('scheduled_service_id', 'old_scheduled_date', 'created_at');

    const earliestAt = new Map(); // sid -> timestamp of the record backing map's date
    const consider = (sid, dateVal, createdAt) => {
      const d = toDateStr(dateVal);
      if (!sid || !d) return;
      const at = new Date(createdAt || 0).getTime();
      const prev = earliestAt.get(sid);
      if (prev === undefined || at < prev) {
        earliestAt.set(sid, at);
        map.set(sid, d);
      }
    };
    for (const r of moveRows) consider(r.scheduled_service_id, r.original_date, r.created_at);
    for (const r of auditRows) consider(r.scheduled_service_id, r.old_scheduled_date, r.created_at);
    return map;
  } catch (_) {
    return null; // fail closed upstream
  }
}

/** Resolve one visit's anchor date, or null when unknown (→ no move). */
function resolveAnchor(service, anchorMap) {
  if (!anchorMap) return null; // bulk load failed — unknown for everyone, fail closed
  const evidenced = anchorMap.get(service.id);
  if (evidenced) return evidenced; // earliest durable pre-move date
  // change_count says moved but no durable record carries the original date —
  // inconsistent history, never guess a budget.
  if ((service.auto_dispatch_change_count || 0) > 0) return null;
  return toDateStr(service.scheduled_date); // never moved — its date IS the anchor
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
