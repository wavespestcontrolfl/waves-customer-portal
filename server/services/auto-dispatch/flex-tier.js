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
 *                 DAY, or move up to ±5 days (±6 for a plan that runs every
 *                 2 months, ±7 for one that runs every 3 months or longer,
 *                 with no live occurrence of its series inside 56 days, see
 *                 flexBandRadius), SILENTLY —
 *                 no customer comms (apply.js's rebooker call is unchanged;
 *                 it already sends none) — until FLEX_TIER_FREEZE_HOURS
 *                 before the visit (25 h for the night pass, owner 2026-11-03:
 *                 the 24-hour reminder is the lock, and
 *                 the 72-hour reminder locks nothing). That freeze is
 *                 deliberately wider than route-tiers' own reminder-claimable
 *                 band (72.25 h; 24.25 h gate on) and fully covers it, so the
 *                 reminder — which reads the
 *                 scheduled_services_sync_reminder-synced row at SEND time,
 *                 not a snapshot (verified: the DB trigger keeps
 *                 appointment_reminders.appointment_time in lockstep with
 *                 every scheduled_date/window_start UPDATE, auto-dispatch's
 *                 included, and the cron's own SELECT re-reads the table
 *                 fresh each 15-minute tick) — always carries the FINAL
 *                 window.
 *   Anchor      = the band's allowance (that visit's own radius, 5, 6 or 7) is
 *                 measured from the visit's DURABLE original date as well as
 *                 its current one: route-tiers' cumulative drift anchor
 *                 (loadAnchorMap / resolveAnchor — the earliest
 *                 pre-auto-dispatch date on record), so successive nightly
 *                 moves can never add up past that radius from the date the
 *                 series gave the visit.
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
const { MIN_DESTINATION_DAYS_OUT, daysBetween } = require('./route-tiers');
const { etParts, etDateString } = require('../../utils/datetime-et');

// Owner-ruled constants (not env-tunable — the gate is the kill switch, the
// numbers themselves are the approved policy, same convention as
// route-tiers.js's tier ladder).
const FLEX_TIER_RADIUS_DAYS = 5;
// Owner 2026-11-22: "i think we can do safely a 7 day range for recurring
// services". The wide band is for a visit whose plan runs every 2 months or
// longer (flexRadiusDaysFor). Monthly stays at 5: ±7 each way could put two
// neighbouring monthly visits about 16 days apart.
const FLEX_TIER_WIDE_RADIUS_DAYS = 7;
// Owner 2026-11-24: "make it 6 for bi monthly". A plan every 2 months (or a custom plan of 56 to 83 days) gets ±6; a plan
// every 3 months or longer (a custom plan of 84 days or more) keeps ±7.
const FLEX_TIER_BIMONTHLY_RADIUS_DAYS = 6;
const FLEX_TIER_WIDE_MIN_INTERVAL_DAYS = 56;
const FLEX_TIER_WIDEST_MIN_INTERVAL_DAYS = 84;
const FLEX_TIER_FREEZE_HOURS = 73;
// Owner 2026-11-03: the night pass's lock is the 24-hour
// reminder. 25 = 24 plus the same 1-hour margin 73 has over 72, and it must
// keep covering route-tiers' REMINDER_SENDABLE_HOURS_24H (24.25), the band the
// 24-hour reminder can still claim. 73 above is the 09-25 rule, kept for
// callers that do not pass `lock24h`.
const FLEX_TIER_FREEZE_HOURS_24H = 25;

/**
 * The band radius (days) for ONE visit, from its OWN row: 7 when
 * `recurring_pattern` is a month-based pattern of 3 months or more
 * (rebooker.js MONTH_RECURRENCE_INTERVALS, the one table) or `custom` with
 * `recurring_interval_days` >= FLEX_TIER_WIDEST_MIN_INTERVAL_DAYS; 6 for a
 * 2-month pattern or `custom` from FLEX_TIER_WIDE_MIN_INTERVAL_DAYS up; 5 for
 * everything else. Unknown, null or malformed reads the narrow band (fail
 * closed). Pure. rebooker is required lazily: it is a large module and
 * apply.js already loads it.
 */
function flexRadiusDaysFor(service) {
  const pattern = service && service.recurring_pattern;
  if (typeof pattern !== 'string') return FLEX_TIER_RADIUS_DAYS;
  if (pattern === 'custom') {
    const days = Number(service.recurring_interval_days);
    if (!Number.isFinite(days)) return FLEX_TIER_RADIUS_DAYS;
    if (days >= FLEX_TIER_WIDEST_MIN_INTERVAL_DAYS) return FLEX_TIER_WIDE_RADIUS_DAYS;
    return days >= FLEX_TIER_WIDE_MIN_INTERVAL_DAYS ? FLEX_TIER_BIMONTHLY_RADIUS_DAYS : FLEX_TIER_RADIUS_DAYS;
  }
  const { MONTH_RECURRENCE_INTERVALS } = require('../rebooker');
  const months = Object.prototype.hasOwnProperty.call(MONTH_RECURRENCE_INTERVALS, pattern) ? MONTH_RECURRENCE_INTERVALS[pattern] : 0;
  if (months >= 3) return FLEX_TIER_WIDE_RADIUS_DAYS;
  return months === 2 ? FLEX_TIER_BIMONTHLY_RADIUS_DAYS : FLEX_TIER_RADIUS_DAYS;
}

// A caller's radius is used only when it is exactly one of the approved
// bands; anything else reads the default.
function approvedRadius(radiusDays) {
  return radiusDays === FLEX_TIER_WIDE_RADIUS_DAYS || radiusDays === FLEX_TIER_BIMONTHLY_RADIUS_DAYS ? radiusDays : FLEX_TIER_RADIUS_DAYS;
}

/**
 * The band radius a visit actually gets. The wide band needs the plan's
 * pattern (`radiusDays`, flexRadiusDaysFor) AND room in the series itself: a
 * pattern can be wrong for the visits it labels (the seeder keeps legacy
 * 9-visit mosquito rows on 'bimonthly'), so the nearest other live occurrence
 * of the series must be FLEX_TIER_WIDE_MIN_INTERVAL_DAYS away or more.
 * `neighbors.nearestDays` is that distance by ACTUAL scheduled date
 * (loadSeriesNeighbors with `withRadius`; nearestActualDays): null = no other
 * live occurrence, which does not narrow the band. A number under the minimum
 * (0 included: a sibling on the visit's own date) reads the narrow band, and so
 * does an entry that does not carry the fact at all (fail closed). The prev /
 * next bounds are NOT used here: they mix cadence positions with actual dates
 * for the crossing guard, and a rescheduled sibling's old cadence date says
 * nothing about where it is now. Pure; the ONE place the band is decided
 * (flexTierMoveWindow calls it too, so a caller cannot widen a window by
 * passing 7 on its own).
 */
function flexBandRadius({ radiusDays, neighbors }) {
  const radius = approvedRadius(radiusDays);
  if (radius === FLEX_TIER_RADIUS_DAYS) return FLEX_TIER_RADIUS_DAYS;
  const nearest = neighbors ? neighbors.nearestDays : undefined;
  if (nearest === null) return radius;
  return Number.isFinite(nearest) && nearest >= FLEX_TIER_WIDE_MIN_INTERVAL_DAYS ? radius : FLEX_TIER_RADIUS_DAYS;
}

/**
 * Days from `self` to the nearest OTHER live row of its series (`family`: every
 * live row the read saw, an unpositioned one included), by actual scheduled
 * date on either side (0 = a sibling on the same date). A skipped,
 * rescheduled or no-show sibling (NO_VISIT_STATUSES) does not count: no visit
 * happens on it (it still holds its cadence slot for the crossing guard,
 * adjacentBounds). null when the series has no other row that counts. A row whose own date, or a sibling's, cannot be read counts as
 * 0: the band stays narrow (fail closed).
 */
function nearestActualDays(family, self) {
  let nearest = null;
  for (const o of family) {
    if (o.id === self.id || o.noVisit === true) continue;
    const apart = daysBetween(self.actual, o.actual);
    const days = apart === null ? 0 : Math.abs(apart);
    if (nearest === null || days < nearest) nearest = days;
  }
  return nearest;
}

/** The flex tier's freeze, in hours. The night pass passes `lock24h`
 *  true (owner 2026-11-03). */
function flexFreezeHoursFor(lock24h) {
  return lock24h === true ? FLEX_TIER_FREEZE_HOURS_24H : FLEX_TIER_FREEZE_HOURS;
}

// A sibling occurrence must be live to anchor the guard — mirrors
// rebooker.js's own TERMINAL exclusion (readSiblings/seriesPosition), so a
// cancelled/completed occurrence never bounds the window.
const TERMINAL_STATUSES = ['completed', 'cancelled'];
// A series row in one of these holds its cadence slot (the crossing guard reads it) but no visit happens on it, so the
// 56-day room check for the wide band does not count it (candidate-slots and rebooker.js leave the same rows out).
const NO_VISIT_STATUSES = new Set(['skipped', 'rescheduled', 'no_show']);

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

// A row joins each requested series it belongs to — as the parent row
// (id) and/or as a child (recurring_parent_id) — the same membership
// the per-series id-or-child predicate selects.
function joinFamilies(familyRows, rows) {
  for (const r of rows) {
    if (familyRows.has(String(r.id))) familyRows.get(String(r.id)).push(r);
    const parentKey = r.recurring_parent_id ? String(r.recurring_parent_id) : null;
    if (parentKey && familyRows.has(parentKey)) familyRows.get(parentKey).push(r);
  }
}

// One live series row as the neighbor read orders it; `radiusDays` and `noVisit` only when the band facts are asked for.
function positionedRow(r, withRadius) {
  const row = { id: String(r.id), position: seriesPosition(r), actual: toDateStr(r.scheduled_date) };
  return withRadius ? { ...row, radiusDays: flexRadiusDaysFor(r), noVisit: NO_VISIT_STATUSES.has(r.status) } : row;
}

// The map entry for positioned[idx]: its bounds, plus the band facts (its own radius, the distance to its nearest live sibling in `family`) when asked.
function neighborEntry(positioned, idx, withRadius, family) {
  const bounds = adjacentBounds(positioned, idx);
  if (!withRadius) return bounds;
  return { ...bounds, radiusDays: positioned[idx].radiusDays, nearestDays: nearestActualDays(family, positioned[idx]) };
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
 * `withRadius` (the night run's reads: pass 1 and the apply-time read): each
 * entry also carries the band facts flexBandRadius needs. `radiusDays` is
 * flexRadiusDaysFor of the visit's OWN row as this read saw it (under `lock`
 * at apply time, so the pattern the move commits against, not a pass-1 value).
 * `nearestDays` is the distance to its nearest other live occurrence by actual
 * date (nearestActualDays). Off, entries are exactly {prev, next}.
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
async function loadSeriesNeighbors(db, services, { lock = false, withRadius = false } = {}) {
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
        .select('id', 'recurring_parent_id', 'status', 'scheduled_date', 'date_exception', 'date_exception_cadence_date', 'recurring_pattern', 'recurring_interval_days');
      joinFamilies(familyRows, rows);
    }
    for (const [parentId, members] of byParent) {
      // Every live row counts for the band's distance (an unpositioned one reads 0, fail closed); only positioned rows bound the crossing guard.
      const family = familyRows.get(parentId).map((r) => positionedRow(r, withRadius));
      const positioned = family
        .filter((r) => r.position)
        .sort((a, b) => (a.position < b.position ? -1 : (a.position > b.position ? 1 : 0)));
      for (const s of members) {
        const idx = positioned.findIndex((r) => r.id === String(s.id));
        if (idx > -1) map.set(s.id, neighborEntry(positioned, idx, withRadius, family));
      }
    }
    return map;
  } catch (_) {
    return null; // fail closed upstream
  }
}

/**
 * The Flexible-tier candidate-date window for one visit. A DAY move lands in
 * one band: ±radius of its current date AND of its durable
 * anchor (`anchorDate`, route-tiers' resolveAnchor — the earliest
 * pre-auto-dispatch date on record; the current date when never moved), the
 * same intersection route-tiers' tierMoveWindow takes, so the allowance is
 * never reset by a previous night's move — never below
 * MIN_DESTINATION_DAYS_OUT of today, and never reaching or crossing the
 * series' adjacent occurrence (`neighbors`). The visit's own current date is
 * the one exception (same-day re-time is owner-mandated right up to the
 * freeze, and the freeze alone already keeps the current date safely in the
 * future — see FLEX_TIER_FREEZE_HOURS vs MIN_DESTINATION_DAYS_OUT above). It
 * joins the band on its own, never the dates between (Codex #4995 r3/r5):
 * when it sits below or above the band with dates between, `dayMoveFrom` /
 * `dayMoveTo` name the band's edge, and flexWindowAdmits is the one check of
 * a destination. A neighbor strictly on the wrong side of the current date —
 * a date-exception visit sitting ahead of its previous occurrence's slot, or
 * behind its next one — leaves no legal move at all: every day move would
 * cross it (Codex #4995 r7 P1). The lookahead horizon is the caller's
 * (candidate-slots.js caps any ctx.tierWindow).
 * The band is the visit's own radius (flexBandRadius: 7 for a plan of 3 months
 * or longer, 6 for a plan of 2 months, when its nearest live sibling,
 * `neighbors.nearestDays`, is 56 days away or more, else 5); a missing or unapproved `radiusDays` reads 5.
 * Returns {dateFrom, dateTo[, dayMoveFrom][, dayMoveTo]} — the span to
 * generate candidates in — or null when nothing is legal, or the anchor is
 * unknown (fail closed — never guess a budget).
 */
function flexTierMoveWindow({
  origDate, anchorDate, today, neighbors, radiusDays,
}) {
  const orig = toDateStr(origDate);
  const anchor = toDateStr(anchorDate);
  if (!orig || !anchor || !today) return null;
  const { prev, next } = neighbors || {};
  if ((prev && prev > orig) || (next && next < orig)) return null;
  const radius = flexBandRadius({ radiusDays, neighbors });
  const prevFloor = prev ? shiftDateStr(prev, 1) : null;
  const nextCeil = next ? shiftDateStr(next, -1) : null;
  const from = latestDate(shiftDateStr(orig, -radius), shiftDateStr(anchor, -radius),
    shiftDateStr(today, MIN_DESTINATION_DAYS_OUT), prevFloor);
  const to = earliestDate(shiftDateStr(orig, radius), shiftDateStr(anchor, radius), nextCeil);
  if (from > to) return { dateFrom: orig, dateTo: orig };
  const window = { dateFrom: earliestDate(from, orig), dateTo: latestDate(to, orig) };
  if (from > shiftDateStr(orig, 1)) window.dayMoveFrom = from;
  if (to < shiftDateStr(orig, -1)) window.dayMoveTo = to;
  return window;
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
 * under its flexTierMoveWindow: inside [dateFrom, dateTo], and either the
 * current date itself (same-day re-time) or inside the day-move band
 * (`dayMoveFrom` / `dayMoveTo`, when the window carries them). Used by
 * candidate filtering and the apply-time guards alike.
 */
function flexWindowAdmits(window, origDate, date) {
  if (!window || !date || date < window.dateFrom || date > window.dateTo) return false;
  if (date === toDateStr(origDate)) return true;
  return !(window.dayMoveFrom && date < window.dayMoveFrom) && !(window.dayMoveTo && date > window.dayMoveTo);
}

/**
 * Direct freeze check (25 h for the night pass) from the visit's OWN schedule: scheduled_date + the
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
 * "no reminder row yet" and moving a visit that is due inside the freeze (25 hours for the night pass).
 * Fails closed: an uncomposable instant (missing/malformed scheduled_date
 * or window_start) freezes the visit; an unreadable arrival throws (below).
 */
async function ownScheduleFrozen(conn, service, now = new Date(), lock24h = false) {
  const { arrivalStartForService } = require('../reservation-arrival');
  // An unreadable arrival THROWS (Codex #4995 r5 P2): read as "frozen" it
  // would pass as an ordinary 73h skip, so a persistent fault could stop
  // every flex move while the run reported green. Thrown, the caller still
  // makes no move and the run records the failure (completed_with_errors).
  const arrivalStart = await arrivalStartForService(conn, service);
  return insideFreeze(service.scheduled_date, arrivalStart, now, lock24h);
}

// `date` + `start` composed into the ET instant (the reminders module's own
// composer) is within the flex freeze (flexFreezeHoursFor(lock24h): 73 h, or
// 25 h for the night pass) of `now` — or cannot be composed at all
// (fail closed).
function insideFreeze(date, start, now, lock24h = false) {
  const { composeScheduledApptTime } = require('../appointment-reminders');
  const apptTime = composeScheduledApptTime({ scheduled_date: date, window_start: start });
  if (!apptTime || Number.isNaN(apptTime.getTime())) return true;
  return apptTime.getTime() - now.getTime() <= flexFreezeHoursFor(lock24h) * 3600000;
}

// The whole-hour arrival shape reservation_arrival_start accepts from a stamp.
const STAMP_ARRIVAL = /^([01][0-9]|2[0-3]):00$/;

/**
 * The arrival reservation_arrival_start would report for this row once it
 * lands on `date` at `start` — the same rule as that SQL function
 * (migrations/20260906000020_reservation_arrival.js): a combined-allocation
 * stamp's shared arrival applies only on the stamp's own date, and only while
 * the row sits in its booked slot (arrival + allocation index × 60 minutes,
 * wrapping at midnight as `time + interval` does); anything else — including
 * a stale stamp on a row moved out of its slot — is the row's own start.
 */
function destinationArrival(service, date, start) {
  const stamp = service && service.reservation_service_mix;
  const ids = stamp && Array.isArray(stamp.allocatedServiceIds) ? stamp.allocatedServiceIds.map(String) : [];
  const index = ids.indexOf(String(service && service.id));
  const arrival = index > -1 && stamp.scheduledDate === date ? String(stamp.arrivalWindowStart || '') : '';
  if (!start || !STAMP_ARRIVAL.test(arrival)) return start;
  const slotHour = (Number(arrival.slice(0, 2)) + index) % 24;
  return String(start).slice(0, 5) === `${String(slotHour).padStart(2, '0')}:00` ? arrival : start;
}

/**
 * The DESTINATION's own freeze check (25 h for the night pass; Codex #4995 P1). The date window keeps a
 * visit's current date reachable for a same-day re-time, and a re-time to an
 * EARLIER hour can land inside the freeze while the current time sits
 * outside it (Thu 17:00, 74h out → Thu 09:00, 66h out) — after which the
 * 72-hour reminder may already have gone out with the old time. So the
 * instant the placement gives the customer must clear the freeze as well:
 * `date` + the arrival that placement would carry (destinationArrival — the
 * placement's own `start`, or a combined visit's shared arrival when the row
 * lands back in its booked slot), in ET. Fails closed on an uncomposable
 * instant (no start).
 */
function destinationFrozen(service, date, start, now = new Date(), lock24h = false) {
  return insideFreeze(date, destinationArrival(service, date, start), now, lock24h);
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
function freezeBoundaryFloor(now = new Date(), lock24h = false) {
  const boundary = new Date(now.getTime() + flexFreezeHoursFor(lock24h) * 3600000);
  const { hour, minute } = etParts(boundary);
  return { date: etDateString(boundary), startMin: hour * 60 + minute + 1 };
}

// Outside the flexible tier the candidate pipeline is untouched.
const NO_FLEX_CANDIDATE_RULES = { findTimeArgs: {}, admit: (slots) => slots };

/**
 * The flexible tier's candidate admission for candidate-slots, as one unit
 * (Codex #4995 r6 P2 — kept out of the candidate pipeline itself): the
 * find-time floor on the date the 73h freeze ends (freezeBoundaryFloor →
 * startFloorByDate), and the filter of fetched slots — a destination inside
 * the freeze (destinationFrozen) or outside the window's legal dates
 * (flexWindowAdmits) is dropped and tallied in `drops` (flex_frozen /
 * flex_floor). Outside flex mode (ctx.tierMeta.mode) both are no-ops.
 */
function flexCandidateRules(service, ctx) {
  if (!(ctx.tierMeta && ctx.tierMeta.mode === 'flex')) return NO_FLEX_CANDIDATE_RULES;
  const origDate = toDateStr(service.scheduled_date);
  const lock24h = ctx.nightLock24h === true; // the night pass passes true (index.js)
  const { date, startMin } = freezeBoundaryFloor(ctx.nowDate, lock24h);
  const dropReason = (slot) => {
    if (destinationFrozen(service, slot.date, slot.start_time, ctx.nowDate, lock24h)) return 'flex_frozen';
    return flexWindowAdmits(ctx.tierWindow, origDate, slot.date) ? null : 'flex_floor';
  };
  return {
    findTimeArgs: { startFloorByDate: { [date]: startMin } },
    admit: (slots, drops) => slots.filter((slot) => {
      const reason = dropReason(slot);
      if (reason) drops[reason] += 1;
      return !reason;
    }),
  };
}

module.exports = {
  FLEX_TIER_RADIUS_DAYS,
  FLEX_TIER_WIDE_RADIUS_DAYS,
  FLEX_TIER_BIMONTHLY_RADIUS_DAYS,
  FLEX_TIER_WIDE_MIN_INTERVAL_DAYS,
  FLEX_TIER_WIDEST_MIN_INTERVAL_DAYS,
  flexRadiusDaysFor,
  flexBandRadius,
  FLEX_TIER_FREEZE_HOURS,
  FLEX_TIER_FREEZE_HOURS_24H,
  flexFreezeHoursFor,
  seriesPosition,
  loadSeriesNeighbors,
  flexTierMoveWindow,
  flexWindowAdmits,
  ownScheduleFrozen,
  destinationFrozen,
  flexCandidateRules,
};
