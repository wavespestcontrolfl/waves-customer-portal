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
 *   Anchor      = the ±FLEX_TIER_RADIUS_DAYS allowance is measured from the
 *                 visit's DURABLE original date as well as its current one:
 *                 route-tiers' cumulative drift anchor (loadAnchorMap /
 *                 resolveAnchor — the earliest pre-auto-dispatch date on
 *                 record), so successive nightly moves can never add up past
 *                 ±5 days of the date the series gave the visit.
 *   Guard       = a move must never cross the series' adjacent occurrence:
 *                 series order is COALESCE(date_exception_cadence_date,
 *                 scheduled_date) among the parent row and its live children
 *                 (rebooker.js's own seriesPosition/readSiblings key, reused
 *                 here via loadSeriesNeighbors rather than re-derived) — and
 *                 never reach or cross any other live occurrence's ACTUAL
 *                 date either, since a rescheduled occurrence (a date
 *                 exception) can sit well inside its cadence slot.
 */
const { toDateStr, shiftDateStr } = require('./dates');
const { MIN_DESTINATION_DAYS_OUT } = require('./route-tiers');
const { etParts, etDateString } = require('../../utils/datetime-et');

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

// Parent ids per read — keeps each whereIn well inside Postgres' bind limit
// on a large run (loadEligibleServices caps a run at 5,000 visits).
const NEIGHBOR_CHUNK = 1000;

/**
 * The bounds a move of positioned[idx] must stay strictly inside: its
 * cadence neighbors' series positions (as before) AND the nearest other
 * live occurrence's ACTUAL scheduled_date on each side (Codex #4995 P1) — an
 * occurrence rescheduled by a date exception can sit well inside its
 * cadence slot, or even past a closer cadence neighbor, and a bound on
 * cadence dates alone would let the move land on or cross it.
 */
function adjacentBounds(positioned, idx) {
  const self = positioned[idx];
  let prev = idx > 0 ? positioned[idx - 1].position : null;
  let next = idx < positioned.length - 1 ? positioned[idx + 1].position : null;
  for (const o of positioned) {
    if (o.id === self.id || !o.actual || !self.actual) continue;
    if (o.actual < self.actual && (!prev || o.actual > prev)) prev = o.actual;
    if (o.actual > self.actual && (!next || o.actual < next)) next = o.actual;
  }
  return { prev, next };
}

/**
 * Bulk-load the adjacent occurrence dates for each of `services` (assumed
 * already Flexible-tier eligible — is_recurring, recurring_parent_id set): a
 * series' members are the parent row (its first visit) plus every non-
 * terminal child, ordered by seriesPosition. One query per NEIGHBOR_CHUNK
 * distinct parent ids (never one per series — a run can span thousands),
 * partitioned by series in memory. Returns Map<serviceId, {prev, next}>
 * ('YYYY-MM-DD' strings, or null when there is no occurrence on that side —
 * see adjacentBounds), or null on a query failure (fail closed — callers
 * must treat every visit as guard-unknown, i.e. no move, the same posture
 * route-tiers' loadAnchorMap takes). A service missing from its own
 * series' read gets NO entry, which callers treat the same way.
 *
 * `lock` (the apply-time authoritative read only): FOR SHARE NOWAIT on every
 * live row read (Codex #4995 P1). The series fence (apply.js
 * fenceFlexSeries) serializes series writers, but an ordinary single-
 * occurrence reschedule (rebooker.reschedule — reschedule-public.js, admin
 * edits) never takes it. The row lock does: a neighbor edit committed first
 * is what this read returns, and one attempted after it waits for this
 * move's commit. NOWAIT so a neighbor already being edited refuses this move
 * at once (fail closed, retried next run) rather than waiting behind the
 * move's own locks.
 */
async function loadSeriesNeighbors(db, services, { lock = false } = {}) {
  const map = new Map();
  const byParent = new Map();
  for (const s of services || []) {
    const parentId = s && s.recurring_parent_id;
    if (!parentId) continue;
    const key = String(parentId);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(s);
  }
  if (byParent.size === 0) return map;
  try {
    const parentIds = [...byParent.keys()];
    const familyRows = new Map(parentIds.map((id) => [id, []]));
    for (let i = 0; i < parentIds.length; i += NEIGHBOR_CHUNK) {
      const chunk = parentIds.slice(i, i + NEIGHBOR_CHUNK);
      let query = db('scheduled_services')
        .where(function withParentOrChild() { this.whereIn('id', chunk).orWhereIn('recurring_parent_id', chunk); })
        .whereNotIn('status', TERMINAL_STATUSES);
      if (lock) query = query.forShare().noWait();
      const rows = await query
        .select('id', 'recurring_parent_id', 'scheduled_date', 'date_exception', 'date_exception_cadence_date');
      // A row joins each requested series it belongs to — as the parent row
      // (id) and/or as a child (recurring_parent_id) — the same membership
      // the per-series id-or-child predicate selects.
      for (const r of rows) {
        if (familyRows.has(String(r.id))) familyRows.get(String(r.id)).push(r);
        const parentKey = r.recurring_parent_id ? String(r.recurring_parent_id) : null;
        if (parentKey && familyRows.has(parentKey)) familyRows.get(parentKey).push(r);
      }
    }
    for (const [parentId, members] of byParent) {
      const positioned = familyRows.get(parentId)
        .map((r) => ({ id: String(r.id), position: seriesPosition(r), actual: toDateStr(r.scheduled_date) }))
        .filter((r) => r.position)
        .sort((a, b) => (a.position < b.position ? -1 : (a.position > b.position ? 1 : 0)));
      for (const s of members) {
        const idx = positioned.findIndex((r) => r.id === String(s.id));
        if (idx > -1) map.set(s.id, adjacentBounds(positioned, idx));
      }
    }
    return map;
  } catch (_) {
    return null; // fail closed upstream
  }
}

/**
 * The Flexible-tier candidate-date window for one visit: ±FLEX_TIER_RADIUS_DAYS
 * of its current date AND of its durable anchor (`anchorDate`, route-tiers'
 * resolveAnchor — the earliest pre-auto-dispatch date on record; the current
 * date when never moved), the same intersection route-tiers' tierMoveWindow
 * takes, so the allowance is never reset by a previous night's move. Then
 * clamped so it
 *   - never reaches or crosses the series' adjacent occurrence (`neighbors`),
 *   - never lands a DAY move below MIN_DESTINATION_DAYS_OUT of today. The
 *     visit's own current date is the one exception (same-day re-time is
 *     owner-mandated right up to the freeze, and the freeze alone already
 *     keeps the current date safely in the future — see FLEX_TIER_FREEZE_HOURS
 *     vs MIN_DESTINATION_DAYS_OUT above): it is added back on its own, never
 *     the dates between it and the floor (Codex #4995 r3 P1). When that
 *     leaves a gap, `dayMoveFrom` names the first date a day move may land
 *     on, and flexWindowAdmits is the one check of a destination,
 *   - never extends the upper bound past the lookahead horizon (the caller,
 *     candidate-slots.js, already applies that cap to any ctx.tierWindow).
 * Returns {dateFrom, dateTo[, dayMoveFrom]} or null when the intersection is
 * empty (e.g. the previous and next occurrence both sit inside the radius) or
 * the anchor is unknown (fail closed — never guess a budget).
 */
function flexTierMoveWindow({ origDate, anchorDate, today, neighbors }) {
  const orig = toDateStr(origDate);
  const anchor = toDateStr(anchorDate);
  if (!orig || !anchor || !today) return null;
  const { prev, next } = neighbors || {};
  const prevFloor = prev ? shiftDateStr(prev, 1) : null;
  const dayMoveFrom = latestDate(shiftDateStr(orig, -FLEX_TIER_RADIUS_DAYS), shiftDateStr(anchor, -FLEX_TIER_RADIUS_DAYS),
    shiftDateStr(today, MIN_DESTINATION_DAYS_OUT), prevFloor);
  // The current date always stays inside the radius band's upper edge
  // (same-day re-time); only the next occurrence can cut below it.
  const dateTo = earliestDate(latestDate(earliestDate(shiftDateStr(orig, FLEX_TIER_RADIUS_DAYS),
    shiftDateStr(anchor, FLEX_TIER_RADIUS_DAYS)), orig), next ? shiftDateStr(next, -1) : null);
  // The current date comes back on its own when only the floor (never the
  // previous occurrence) sits past it.
  const sameDayOnly = dayMoveFrom > orig && !(prevFloor && prevFloor > orig);
  if (!sameDayOnly) return dayMoveFrom > dateTo ? null : { dateFrom: dayMoveFrom, dateTo };
  if (orig > dateTo) return null;
  if (dayMoveFrom > dateTo) return { dateFrom: orig, dateTo: orig };
  return dayMoveFrom > shiftDateStr(orig, 1) ? { dateFrom: orig, dateTo, dayMoveFrom } : { dateFrom: orig, dateTo };
}

// The latest / earliest of some 'YYYY-MM-DD' dates, ignoring absent ones.
function latestDate(...dates) {
  return dates.filter(Boolean).reduce((a, b) => (b > a ? b : a));
}
function earliestDate(...dates) {
  return dates.filter(Boolean).reduce((a, b) => (b < a ? b : a));
}

/**
 * Whether `date` is a legal flex destination for a visit now on `origDate`,
 * under its flexTierMoveWindow: inside [dateFrom, dateTo], and — when the
 * window carries `dayMoveFrom` — either the current date itself (same-day
 * re-time) or on/after it. Used by candidate filtering and the apply-time
 * guards alike.
 */
function flexWindowAdmits(window, origDate, date) {
  if (!window || !date || date < window.dateFrom || date > window.dateTo) return false;
  return !window.dayMoveFrom || date >= window.dayMoveFrom || date === toDateStr(origDate);
}

/**
 * Direct 73h freeze check from the visit's OWN schedule: scheduled_date + the
 * CANONICAL arrival start — reservation-arrival.js's arrivalStartForService,
 * the same resolution the reminder subsystem uses (scheduledServiceApptTime),
 * so a member of a combined work allocation freezes on the group's shared
 * (earlier) arrival, not its own later work slot — composed into the ET
 * instant via AppointmentReminders.composeScheduledApptTime. Both reused, not
 * re-derived; required lazily, the same way apply.js already requires the
 * reminders module.
 *
 * INDEPENDENT of reminder evidence (Codex pre-push P1): route-tiers'
 * loadReminderFreeze only ever ADDS a freeze — a sent flag, or the sender's
 * own claimable band, both read off `appointment_reminders` ROWS. A visit
 * with NO reminder row at all (not yet generated, a data gap, a race before
 * registration) is invisible to that check, and the Flexible tier's own
 * eligibility ctx (`ctx.flexTier`) skips eligibility.js's days-out lock
 * entirely — so this direct computation is the ONLY thing standing between
 * "no reminder row yet" and moving a visit that is due inside 73 hours.
 * Fails closed: an unreadable arrival or an uncomposable instant
 * (missing/malformed scheduled_date or window_start) freezes the visit.
 */
async function ownScheduleFrozen(conn, service, now = new Date()) {
  const { arrivalStartForService } = require('../reservation-arrival');
  let arrivalStart;
  try {
    arrivalStart = await arrivalStartForService(conn, service);
  } catch (_) {
    return true; // fail closed
  }
  return insideFreeze(service.scheduled_date, arrivalStart, now);
}

// `date` + `start` composed into the ET instant (the reminders module's own
// composer) is within FLEX_TIER_FREEZE_HOURS of `now` — or cannot be
// composed at all (fail closed).
function insideFreeze(date, start, now) {
  const { composeScheduledApptTime } = require('../appointment-reminders');
  const apptTime = composeScheduledApptTime({ scheduled_date: date, window_start: start });
  if (!apptTime || Number.isNaN(apptTime.getTime())) return true;
  return apptTime.getTime() - now.getTime() <= FLEX_TIER_FREEZE_HOURS * 3600000;
}

// The whole-hour arrival shape reservation_arrival_start accepts from a stamp.
const STAMP_ARRIVAL = /^([01][0-9]|2[0-3]):00$/;

/**
 * The DESTINATION's own 73h check (Codex #4995 P1). The date window keeps a
 * visit's current date reachable for a same-day re-time, and a re-time to an
 * EARLIER hour can land inside the freeze while the current time sits
 * outside it (Thu 17:00, 74h out → Thu 09:00, 66h out) — after which the
 * 72-hour reminder may already have gone out with the old time. So the
 * instant the placement gives the customer must clear the freeze as well:
 * `date` + the placement's `start` (ET), and — when the row carries a
 * combined-allocation stamp for that very date — the stamp's shared arrival
 * too, since reservation_arrival_start hands that earlier arrival back to a
 * member landing in its booked slot (checking both never under-freezes).
 * Fails closed on an uncomposable instant (no start).
 */
function destinationFrozen(service, date, start, now = new Date()) {
  if (insideFreeze(date, start, now)) return true;
  const stamp = service && service.reservation_service_mix;
  const arrival = stamp && Array.isArray(stamp.allocatedServiceIds) && stamp.scheduledDate === date
    ? String(stamp.arrivalWindowStart || '') : '';
  return STAMP_ARRIVAL.test(arrival) && insideFreeze(date, arrival, now);
}

/**
 * Where the freeze ends, as a slot-generation floor: the ET date of the
 * instant FLEX_TIER_FREEZE_HOURS from `now`, and the first whole minute of
 * that date strictly past it (insideFreeze treats the boundary itself as
 * frozen). candidate-slots hands it to find-time (startFloorByDate): the gap
 * path emits only each gap's earliest feasible start, so without the floor
 * an open gap on that date yields a frozen morning start that hides a legal
 * afternoon one (Codex #4995 pre-push P1).
 */
function freezeBoundaryFloor(now = new Date()) {
  const boundary = new Date(now.getTime() + FLEX_TIER_FREEZE_HOURS * 3600000);
  const { hour, minute } = etParts(boundary);
  return { date: etDateString(boundary), startMin: hour * 60 + minute + 1 };
}

module.exports = {
  FLEX_TIER_RADIUS_DAYS,
  FLEX_TIER_FREEZE_HOURS,
  seriesPosition,
  loadSeriesNeighbors,
  flexTierMoveWindow,
  flexWindowAdmits,
  ownScheduleFrozen,
  destinationFrozen,
  freezeBoundaryFloor,
};
