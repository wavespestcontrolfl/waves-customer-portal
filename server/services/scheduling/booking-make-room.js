/**
 * Make room at booking (GATE_BOOKING_MAKE_ROOM, owner 2026-11-06 "build this first").
 *
 * A new customer on the estimate page may take the best hour on a route even when a regular stop holds it. That
 * stop moves later by the new visit's length in whole hours (1 hour for a visit up to 60 minutes: the owner's
 * 2026-11-03 rule), and so does each later stop it would then overlap, until a free hour takes the last one. When the
 * 1-hour move fails a rule (most often the travel gap: no time to drive from the new visit to the moved stop), the
 * same chain is tried 2 hours later instead (owner 2026-11-07 "B": a moved visit may shift up to 2 hours, not 1).
 * A visit longer than 60 minutes already moves its own length in whole hours, so it has that one shift. This
 * module FINDS such hours for one customer's list. It never writes a visit and never changes the list.
 *
 * An hour counts only when every rule holds:
 *   1. The estimate page could offer it (the caller's `admit`: the customer grid and close, the request's dates,
 *      weekends, zone days, time of day, notice and season) and it starts where a stop starts, on a day the free-slot
 *      finder would use: an assignable technician, no absent or off tech-day, no blackout date (find-time's rules),
 *      and a technician whose capability for this estimate's services is not off (the page's filterCollidingSlots).
 *      The page's own placement rules then judge the new visit on the day as it would be, with the moved stops at
 *      their new times (the caller's `placement`: filterCollidingSlots with this estimate's arguments, so overlaps,
 *      live holds, zone limits, the day fit and the travel gap with its expected minutes; then the service-line
 *      rule). The module does not re-code them.
 *   2. Every stop in the chain may move under the 4:40 re-plan's own rules: day-replan fixedReason, read again with
 *      the day's full facts (status, hold, staff lock, office review, group, same customer twice, the 24-hour lock,
 *      the 24-hour text and, with GATE_NIGHT_TOLD_LOCK, confirmed, first or one-time, person-placed and told
 *      visits). Its customer also has both reminder tiers on and sent BY TEXT (the plan: "the customer gets reminder
 *      texts"), read with the sender's own channel and app routing rules. The lock is the re-plan's 24 hours (owner
 *      2026-11-03): the 24-hour text always carries the new time; a new time inside 72 hours gets no new 72-hour
 *      text, and with GATE_NIGHT_TOLD_LOCK a stop whose time was already told never moves at all. Its time
 *      preference (the re-plan's loadPref) allows the new hour, and it still ends by the night tools' day close.
 *   3. Nothing else holds the new minutes of the new visit or of a moved stop: no unassigned visit, no other
 *      technician's visit while the occupancy check is technician-blind (the re-plan's blockedHoursFor rule), no
 *      schedule block.
 *   4. The route keeps every arrival window with the new visit in it: arrival-route.js evaluateArrivalPlacement on
 *      the moved day, the check the estimate page runs today. In capacity mode its added drive also stays under the
 *      picker's self-serve cap (find-time findCapacitySlots: customerMaxDetourMinutes, with the zone route-day lift).
 *   5. The new visit adds at least MIN_SAVING_MIN fewer drive minutes than the best free time in the list. This is
 *      the approved offer rule.
 * Drive minutes on both sides use the re-plan's straight-line leg (legMin) from the technician's start point: the
 * drive the new visit adds between the stop before it and the stop after it. The moved stops keep their order, so
 * they add no drive. $0: no Google, no AI.
 *
 * The report also carries a log-only measurement of the rule the owner is being asked about (owner 2026-11-09, "get it
 * live"): a "sooner day" pass (report.sooner). It looks only at days before the first day in the customer's list, and
 * swaps rule 5 for a drive cap: the self-serve cap (customerMaxDetourMinutes, with the zone route-day lift, read
 * whatever the capacity mode is). Every other rule above holds. It runs after the saving pass, so it never takes that
 * pass's time, with its own MAX_SOONER_CHECKS full checks under what is left of the same budget and the same caches.
 * When the travel-gap gate is on and capacity mode is off (the page's own travel rule runs only then), a screen
 * predicts for each sooner candidate whether that rule passes on the moved day. The screen only
 * puts the likely passes first; it never drops a candidate, and the full check still decides. Nothing in the sooner
 * pass reaches a customer or changes the offer rule.
 *
 * Modes (bookingMakeRoomMode, read at CALL time):
 *   off     unset or any other value. Callers never reach this module.
 *   shadow  find and record one booking_make_room_checks row per checked list. The customer's list does not change.
 *   on      GATE_BOOKING_MAKE_ROOM=true. Reserved for the offer, hold and move (a later change); today it records
 *           exactly like shadow.
 *
 * Never throws, spends nothing, sends nothing, and writes only its own log row. The estimate page starts it through
 * startBackgroundCheck: at most MAX_IN_FLIGHT checks at once and one per estimate per DEDUPE_MS, extra requests dropped.
 * A check has DEFAULT_BUDGET_MS. Once that runs out it sends no further read, and it keeps its slot until the reads it
 * already sent answer, for at most LINGER_MS (makeBudget).
 */
const logger = require('../logger');
const { addETDays, etDateString } = require('../../utils/datetime-et');

const MIN_SAVING_MIN = 10;
const DEFAULT_BUDGET_MS = 4000;
const MAX_DATES = 21;
const MAX_FULL_CHECKS = 6;
// The sooner pass is log-only, so it may look at more hours than the offer rule's six.
const MAX_SOONER_CHECKS = 24;
const TABLE = 'booking_make_room_checks';
const TIMED_OUT = Symbol('timed_out');
// A budget that never runs out, for a direct call of one step (tests).
const NO_LIMIT = { spent: () => false };
// Backpressure (startBackgroundCheck): the page never waits for a check, and a lost race never cancels a read
// already sent, so the number of checks is bounded here instead. A check that ran out of time keeps its slot until
// the reads it already sent answer, for at most LINGER_MS (makeBudget).
const MAX_IN_FLIGHT = 2;
const DEDUPE_MS = 10 * 60 * 1000;
const LINGER_MS = 30 * 1000;

function bookingMakeRoomMode() {
  try {
    const gates = require('../../config/feature-gates');
    const mode = typeof gates.bookingMakeRoomMode === 'function' ? gates.bookingMakeRoomMode() : 'off';
    return mode === 'shadow' || mode === 'on' ? mode : 'off';
  } catch {
    return 'off';
  }
}

function minutesOf(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function pointOf(row) {
  const lat = Number(row?.lat);
  const lng = Number(row?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 ? { lat, lng } : null;
}

// A stop's booked minutes, the re-plan's plannerStop rule: its window, else its estimate, else 60 minutes.
function bookedRange(row) {
  const startMin = minutesOf(row?.window_start);
  if (startMin == null) return null;
  const endMin = row.window_end ? minutesOf(row.window_end) : null;
  const width = endMin != null && endMin > startMin ? endMin - startMin : (Number(row.estimated_duration_minutes) || 60);
  return { startMin, endMin: startMin + width };
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function hitsAny(ranges, taken) {
  return ranges.some((a) => taken.some((b) => overlaps(a, b)));
}

// Whole hours a stop moves: enough to clear the new visit (1 hour for a visit up to 60 minutes, the owner's rule).
function shiftMinutesFor(durationMin) {
  return 60 * Math.max(1, Math.ceil(durationMin / 60));
}

// The most a moved stop may shift when its first shift is 1 hour (owner 2026-11-07 "B": up to 2 hours, not 1).
const MAX_SHIFT_MIN = 120;

// The shifts to try for one hour, in order: the owner's 1-hour move first, then 2 hours. A longer visit's own shift
// (2 hours or more) is the only one.
function shiftsFor(durationMin) {
  const first = shiftMinutesFor(durationMin);
  return first < MAX_SHIFT_MIN ? [first, MAX_SHIFT_MIN] : [first];
}

const sameTech = (row, techId) => techId != null && row.technician_id != null && String(row.technician_id) === String(techId);

// One technician's timed stops with a pin, in start order: the order the chain walks.
function ownStops(rows, techId) {
  return rows.filter((row) => sameTech(row, techId) && bookedRange(row) && pointOf(row))
    .sort((a, b) => bookedRange(a).startMin - bookedRange(b).startMin || String(a.id).localeCompare(String(b.id)));
}

/**
 * The stops a new visit at [startMin, startMin + durationMin) pushes later, in order. `own` is the technician's timed
 * stops in start order. Each moved stop keeps its length and moves the same whole hours (`shiftMin`, by default the
 * new visit's length in whole hours); the chain ends at the first stop the moved ones no longer overlap. Stops that
 * already overlap each other would still overlap after the move, and the writer refuses that (day-replan apply.js
 * assertNoClash), so such a chain is refused here too.
 * Returns { moves: [{ row, fromMin, toMin, widthMin }] } or { reason }. Pure.
 */
function buildChain(own, { startMin, durationMin, closeMin, shiftMin = shiftMinutesFor(durationMin) }) {
  const shift = shiftMin;
  const moves = [];
  let busyUntil = startMin + durationMin;
  for (const row of own) {
    const range = bookedRange(row);
    if (range.startMin < startMin) {
      if (range.endMin > startMin) return { reason: 'earlier_stop_overlaps' };
      continue;
    }
    if (range.startMin >= busyUntil) break;
    const widthMin = range.endMin - range.startMin;
    const toMin = range.startMin + shift;
    if (toMin + widthMin > closeMin) return { reason: 'past_day_close' };
    if (moves.length && toMin < Math.max(...moves.map((m) => m.toMin + m.widthMin))) return { reason: 'moved_stops_overlap' };
    moves.push({ row, fromMin: range.startMin, toMin, widthMin });
    busyUntil = Math.max(busyUntil, toMin + widthMin);
  }
  return moves.length ? { moves } : { reason: 'hour_free' };
}

// Drive minutes a new visit adds between `prev` and `next` (stops or the start point).
function addedDrive(legMin, prev, point, next) {
  return legMin(prev, point) + legMin(point, next) - legMin(prev, next);
}

// The stop (or start point) before and after `startMin` on one technician's day.
function neighbours(own, startMin, home) {
  let prev = home;
  for (const row of own) {
    if (bookedRange(row).startMin >= startMin) return { prev, next: pointOf(row) };
    prev = pointOf(row);
  }
  return { prev, next: home };
}

// The free time in the customer's list that adds the least drive, or null for an empty list.
function bestFreeTime(pool, { dayRows, homeOf, point, legMin }) {
  let best = null;
  for (const slot of pool) {
    const startMin = minutesOf(slot?.windowStart);
    if (startMin == null || !slot.date) continue;
    const techId = slot.techId || null;
    const { prev, next } = neighbours(ownStops(dayRows.get(slot.date) || [], techId), startMin, homeOf(techId));
    const detourMin = addedDrive(legMin, prev, point, next);
    if (!best || detourMin < best.detourMin) best = { detourMin, date: slot.date, start: hhmm(startMin), techId };
  }
  return best;
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    if (row[key] != null) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  }
  return counts;
}

// The re-plan's day facts that need no extra read, for a first pass. The full facts are read later (fullCheck).
function quickDayContext(dateStr, rows, now) {
  return { dateStr, now, allRows: rows, visitCounts: countBy(rows, 'visit_id'), customerCounts: countBy(rows, 'customer_id'), sent24: new Set(), toldLock: false };
}

// Minutes the new visit and the moved stops may not use: unassigned visits, and other technicians' visits while the
// occupancy check is technician-blind (the re-plan's blockedHoursFor rule, by the minute).
function takenByOthers(rows, techId, techBlind) {
  return rows.filter((row) => !sameTech(row, techId) && (row.technician_id == null || techBlind))
    .map(bookedRange).filter(Boolean);
}

function chainRanges(candidate) {
  return [{ startMin: candidate.startMin, endMin: candidate.startMin + candidate.durationMin },
    ...candidate.moves.map((m) => ({ startMin: m.toMin, endMin: m.toMin + m.widthMin }))];
}

// One shift of one hour, with the checks that need no read. Returns { candidate } or { reason }.
function chainCandidate({ day, startMin, env, request, slot, shiftMin }) {
  const { durationMin } = request;
  const chain = buildChain(day.own, { startMin, durationMin, closeMin: env.closeMin, shiftMin });
  if (chain.reason) return { reason: chain.reason };
  const fixed = chain.moves.map((m) => env.fixedReason(m.row, day.quick)).find(Boolean);
  if (fixed) return { reason: `fixed_${fixed}` };
  const candidate = { dateStr: day.dateStr, techId: day.techId, startMin, durationMin, shiftMin, moves: chain.moves, slot };
  if (hitsAny(chainRanges(candidate), day.taken)) return { reason: 'taken_by_other' };
  const { prev } = neighbours(day.own, startMin, day.home);
  candidate.detourMin = addedDrive(env.legMin, prev, request.point, pointOf(chain.moves[0].row));
  candidate.savingMin = request.bestFree ? request.bestFree.detourMin - candidate.detourMin : null;
  // The sooner pass (request.soonerCap) swaps the saving bar for the self-serve drive cap; the saving is still logged.
  if (request.soonerCap) {
    if (candidate.detourMin > request.soonerCap(day.dateStr, day.techId)) return { reason: 'over_drive_cap' };
  } else if (candidate.savingMin != null && candidate.savingMin < MIN_SAVING_MIN) return { reason: 'saving_below_bar' };
  return { candidate };
}

// One hour on one technician-day, with the checks that need no read. Returns { candidate } or { reason }. The
// candidate is the first shift that passes them; `later` is the 2-hour shift that also passed, for the full check to
// try when the 1-hour one fails there. When no shift passes, the reason is the first shift's.
function tryHour({ day, startMin, env, request }) {
  const { durationMin } = request;
  // routeMode: every hour that passes is checked on the arrival-window route (routeKeepsWindows), like the page's own
  // capacity-mode slots, which is what filterCollidingSlots asks of a slot in capacity mode.
  const slot = { date: day.dateStr, windowStart: hhmm(startMin), windowEnd: hhmm(startMin + durationMin), durationMinutes: durationMin, techId: day.techId, routeMode: 'arrival_windows' };
  if (!request.admit(slot)) return { reason: 'not_offerable' };
  const tries = shiftsFor(durationMin).map((shiftMin) => chainCandidate({ day, startMin, env, request, slot, shiftMin }));
  const [candidate, later] = tries.map((t) => t.candidate).filter(Boolean);
  if (!candidate) return { reason: tries[0].reason };
  return { candidate: later ? { ...candidate, later } : candidate };
}

function tally(report, reason) {
  report.byReason[reason] = (report.byReason[reason] || 0) + 1;
}

// Every hour a stop starts on one technician-day.
function dayCandidates({ dateStr, rows, techId, env, request, report }) {
  const skip = env.skipReason(rows.filter((row) => sameTech(row, techId)));
  // One stop is enough to make room before; any other reason (untimed, no pin, under way) leaves the day alone.
  if (skip && skip !== 'FEWER_THAN_2_STOPS') {
    tally(report, `day_${String(skip).toLowerCase()}`);
    return [];
  }
  const own = ownStops(rows, techId);
  const day = { dateStr, techId, own, home: env.homeOf(techId), quick: quickDayContext(dateStr, rows, request.now), taken: takenByOthers(rows, techId, env.techBlind) };
  const found = [];
  for (const startMin of new Set(own.map((row) => bookedRange(row).startMin))) {
    report.tried += 1;
    const { candidate, reason } = tryHour({ day, startMin, env, request });
    if (candidate) found.push(candidate);
    else tally(report, reason);
  }
  return found;
}

function techIdsOf(rows) {
  return [...new Set(rows.map((row) => row.technician_id).filter((id) => id != null).map(String))];
}

// Most drive saved first (no free time at all sorts first), then the earliest hour.
function bySaving(a, b) {
  const saving = (c) => (c.savingMin == null ? Infinity : c.savingMin);
  return saving(b) - saving(a) || a.dateStr.localeCompare(b.dateStr) || a.startMin - b.startMin;
}

// The sooner pass: hours the travel-gap screen expects to pass first (no screen counts as a pass), then the earliest
// date, the earliest hour and the technician.
function bySooner(a, b) {
  return (a.screen ? 1 : 0) - (b.screen ? 1 : 0) || a.dateStr.localeCompare(b.dateStr) || a.startMin - b.startMin
    || String(a.techId ?? '').localeCompare(String(b.techId ?? ''));
}

// The estimate page's own entity for one day row (filterCollidingSlots' `busy`), `shiftMin` minutes later.
function screenStop(row, env, shiftMin = 0) {
  const start = minutesOf(row.window_start);
  const explicitEnd = minutesOf(row.window_end);
  const length = Number(row.estimated_duration_minutes) > 0 ? Number(row.estimated_duration_minutes) : 60;
  const end = explicitEnd ?? (start != null ? start + length : null);
  const known = start != null && end != null;
  return {
    startMin: start == null ? null : start + shiftMin,
    endMin: end == null ? null : end + shiftMin,
    technicianId: row.technician_id,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    hold: row.reservation_expires_at != null && row.customer_id == null,
    ...(known ? { windowMinutes: end - start, expectedMinutes: env.stopExpectedMinutesSync(row, end - start) } : {}),
  };
}

// The page's travel rule for one shift of one candidate on the moved day: null for a predicted pass, else the first
// conflict as overlap, gap_before or gap_after.
function screenShift(candidate, rows, { env, request }) {
  const moved = new Map(candidate.moves.map((m) => [String(m.row.id), m.toMin - m.fromMin]));
  // filterCollidingSlots' scopeToTechnician: one technician's rows and the unassigned ones with multi-tech confirm on.
  const scoped = candidate.techId && env.multiTechConfirmLive()
    ? rows.filter((row) => row.technician_id == null || String(row.technician_id) === String(candidate.techId))
    : rows;
  const stops = scoped.map((row) => screenStop(row, env, moved.get(String(row.id)) || 0));
  const { durationMin } = candidate;
  const expected = request.candidateExpectedMinutes;
  const entity = {
    startMin: candidate.startMin, endMin: candidate.startMin + durationMin, lat: request.point.lat, lng: request.point.lng,
    windowMinutes: durationMin,
    expectedMinutes: Number.isFinite(expected) ? Math.min(expected, durationMin) : durationMin,
  };
  const [first] = env.travelGapConflicts(entity, stops);
  if (!first) return null;
  if (first.reason === 'overlap') return 'overlap';
  return first.stop.endMin <= entity.startMin ? 'gap_before' : 'gap_after';
}

// The hour passes when either of its shifts is expected to; otherwise the 1-hour shift's first conflict.
function screenCandidate(candidate, rows, ctx) {
  let firstReason;
  for (const shift of [candidate, candidate.later].filter(Boolean)) {
    const reason = screenShift(shift, rows, ctx);
    if (reason === null) return null;
    if (firstReason === undefined) firstReason = reason;
  }
  return firstReason;
}

async function cached(map, key, load) {
  if (!map.has(key)) map.set(key, Promise.resolve().then(load));
  return map.get(key);
}

function shiftRow(row, move) {
  if (!move) return row;
  return { ...row, window_start: hhmm(move.toMin), ...(row.window_end ? { window_end: hhmm(move.toMin + move.widthMin) } : {}) };
}

// The estimate page's own route check on the moved day: true, or why the route does not keep every window.
async function routeKeepsWindows(candidate, { conn, env, request, caches }) {
  if (!env.arrivalWindowsOn()) return 'arrival_windows_off';
  const context = await cached(caches.routes, `${candidate.dateStr}|${candidate.techId}`, () => env.loadArrivalRouteContext({
    conn, date: candidate.dateStr, technicianId: candidate.techId, now: request.now,
    prospective: { lat: request.point.lat, lng: request.point.lng, estimated_duration_minutes: candidate.durationMin },
    ...(request.estimateId ? { excludeEstimateId: request.estimateId } : {}),
  }));
  if (!context) return 'route_unverified';
  const moved = new Map(candidate.moves.map((m) => [String(m.row.id), m]));
  const result = env.evaluateArrivalPlacement({ ...context, rows: context.rows.map((row) => shiftRow(row, moved.get(String(row.id)))) }, {
    windowStart: hhmm(candidate.startMin), windowEnd: hhmm(candidate.startMin + candidate.durationMin), durationMinutes: candidate.durationMin,
  });
  if (result?.feasible !== true) return `route_${result?.reason || 'unknown'}`;
  // find-time's own test: `fit.detourMinutes > capFor(date, tech.id)`.
  if (request.detourCap && result.detourMinutes > request.detourCap(candidate.dateStr, candidate.techId)) return 'detour_cap';
  return true;
}

// The picker's self-serve drive cap (find-time findCapacitySlots), with the zone route-day lift for the request's zone.
// `detourCap` is null while capacity mode is off: the page's free times have no cap then either. `soonerCap` is the
// same cap whatever the mode is, for the sooner pass. The zone route days are read once for both.
async function loadDetourCaps(conn, env, zoneSlug) {
  const zoneRouteDays = zoneSlug && env.zoneRouteDaysLive() ? await env.readZoneRouteDays(conn) : null;
  const soonerCap = (date, technicianId) => env.customerMaxDetourMinutes(zoneRouteDays ? { date, technicianId, zoneSlug, zoneRouteDays } : undefined);
  return { detourCap: env.capacityOn() ? soonerCap : null, soonerCap };
}

// The moved customer hears the new time only from the 72-hour and 24-hour texts, so both must be on and readable.
function remindersOn(prefs) {
  return !!prefs && prefs.unavailable !== true && prefs.smsEnabled !== false
    && prefs.serviceReminder72h !== false && prefs.serviceReminder24h !== false;
}

const TEXT_CHANNELS = new Set(['sms', 'both']);
// The message types of the 72-hour and the 24-hour reminder (appointment-reminders.js).
const REMINDER_TYPES = ['reminder_72h', 'appointment_reminder'];

// With the sender's app routing on (push-channel-routing decidePushRoute; app-first for reminders, owner 2026-11-04),
// a text-led reminder goes in the app INSTEAD of a text when the customer has an app device the sender could reach
// (its hasFreshPushDevice: a reachable or fresh native device). Such a customer never moves. A customer who chose
// Text in the app is counted here too: the check fails closed.
async function remindersMayGoInApp(customerId, env, conn) {
  if (!REMINDER_TYPES.some((messageType) => env.pushRouteFor(customerId, messageType) === 'push_first')) return false;
  const status = await env.appDeviceStatus(customerId, conn);
  return !status || (status.enabled === true && (status.reachable === true || status.fresh === true));
}

// ...and both go out by text: the channels the reminder sender itself uses (resolve72hChannel for the 72-hour leg,
// which can promote a one-time visit to email; the stored 24-hour channel), and, for a text-only leg, not the app.
// TIMED_OUT when the budget ran out before one of its reads.
async function remindersByText(prefs, row, env, conn, budget = NO_LIMIT) {
  if (budget.spent()) return TIMED_OUT;
  const channel72 = await env.resolve72hChannel(prefs.reminder72hChannel, row.id, {
    prefsUnavailable: prefs.unavailable,
    explicitChoice: prefs.reminder72hChannelExplicit,
    emailEnabled: prefs.emailEnabled,
  });
  if (!TEXT_CHANNELS.has(channel72) || !TEXT_CHANNELS.has(prefs.reminder24hChannel)) return false;
  // 'both' adds an email leg the app never replaces; only a text-only leg can turn into an app message.
  if (channel72 !== 'sms' && prefs.reminder24hChannel !== 'sms') return true;
  if (budget.spent()) return TIMED_OUT;
  return !(await remindersMayGoInApp(row.customer_id, env, conn));
}

// Why one moved stop may not move after all, from the day's full facts, or null. TIMED_OUT when the budget ran out
// before one of its reads.
async function moveBlockedReason(move, { conn, env, day, techId, budget = NO_LIMIT }) {
  const row = (day?.allRows || []).find((r) => String(r.id) === String(move.row.id));
  if (!row || !sameTech(row, techId) || bookedRange(row)?.startMin !== move.fromMin) return 'changed';
  const why = env.fixedReason(row, day);
  if (why) return `fixed_${why}`;
  let prefs;
  let pref;
  try {
    if (budget.spent()) return TIMED_OUT;
    prefs = await env.getReminderPrefs(row.customer_id, { scheduledServiceId: row.id });
    if (!remindersOn(prefs)) return 'reminders_off';
    // true, false, or TIMED_OUT (passed on as it is).
    const byText = await remindersByText(prefs, row, env, conn, budget);
    if (byText !== true) return byText || 'reminders_not_text';
    if (budget.spent()) return TIMED_OUT;
    pref = await env.loadPref(conn, row);
  } catch {
    return 'prefs_unreadable';
  }
  return pref && !(move.toMin >= pref.startMin && move.toMin < pref.endMin) ? 'preference' : null;
}

// The checks that read the database, for one candidate: schedule blocks, the page's placement rules on the moved
// day, the route, then each moved stop's facts. Once the budget is spent it sends no further read and returns
// TIMED_OUT: the race in checkOne has already ended the check, and a lost race never cancels the read in progress.
async function fullCheck(candidate, ctx) {
  const { conn, env, request, caches, budget } = ctx;
  const blocks = await cached(caches.blocks, `${candidate.dateStr}|${candidate.techId}`, () => env.loadBlocks(conn, candidate.dateStr, candidate.techId));
  if (hitsAny(chainRanges(candidate), blocks || [])) return 'schedule_block';
  if (budget.spent()) return TIMED_OUT;
  const placed = await request.placement(candidate.slot, new Map(candidate.moves.map((m) => [String(m.row.id), m.toMin - m.fromMin])));
  if (placed !== true) return placed || 'page_rules';
  if (budget.spent()) return TIMED_OUT;
  const route = await routeKeepsWindows(candidate, ctx);
  if (route !== true) return route;
  if (budget.spent()) return TIMED_OUT;
  const day = await cached(caches.days, candidate.dateStr, () => env.loadDayContext(conn, candidate.dateStr, request.now));
  for (const move of candidate.moves) {
    const why = await moveBlockedReason(move, { conn, env, day, techId: candidate.techId, budget });
    if (why) return why;
  }
  return null;
}

function raceBudget(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(TIMED_OUT);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), remaining); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The check's time budget (Codex round 5 on #7736). A read already sent is never cancelled, so:
//   race(start)        starts a step only while time is left, and races it against the deadline;
//   spent()            each step asks it before its next read, and stops there with TIMED_OUT;
//   settledWithin(ms)  waits, at most ms, until every started step has settled. recordMakeRoomCheck returns only
//                      then, so startBackgroundCheck frees the slot only after the reads a timed-out check left
//                      behind answer. A read that never answers frees the slot after ms.
// One read a step already sent (a page placement pass, a settings read) still finishes.
function makeBudget(deadline) {
  const pending = new Set();
  const spent = () => Date.now() >= deadline;
  return {
    spent,
    race(start) {
      if (spent()) return Promise.resolve(TIMED_OUT);
      const step = new Promise((resolve) => resolve(start()));
      const settled = step.then(() => true, () => true);
      pending.add(settled);
      settled.then(() => pending.delete(settled));
      return raceBudget(step, deadline);
    },
    async settledWithin(ms) {
      if (!pending.size) return true;
      return (await raceBudget(Promise.all([...pending]), Date.now() + ms)) !== TIMED_OUT;
    },
  };
}

// The request's dates (at most MAX_DATES) and every date the free list uses, in order.
function datesFor({ dateFrom, dateTo, pool }) {
  const dates = new Set(pool.map((slot) => slot?.date).filter(Boolean));
  const first = new Date(`${dateFrom}T12:00:00Z`);
  for (let i = 0; i < MAX_DATES; i++) {
    const date = etDateString(addETDays(first, i));
    if (date > dateTo) break;
    dates.add(date);
  }
  return [...dates].sort();
}

// The days, without this estimate's own hold. Null when a day cannot be read in time: a best free time judged on
// part of the list could read a saving that is not there.
async function loadDays(conn, env, { dates, holdIds, budget, report }) {
  const days = new Map();
  for (const dateStr of dates) {
    const rows = await budget.race(() => env.loadDayStops(conn, dateStr));
    if (rows === TIMED_OUT) {
      report.timedOut = true;
      return null;
    }
    days.set(dateStr, (rows || []).filter((row) => !holdIds.has(String(row.id))));
  }
  return days;
}

// The free-slot finder's own day and technician rules (find-time loadFindTimeContext): assignable technicians only,
// no absent or off tech-day, no blackout date (strict: an unreadable list stops the check). With this estimate's
// services (capabilityRows), also the page's capability rule (filterCollidingSlots): no technician whose capability
// for a requested service is off. A stop left on such a day is never a place to book, so it is never a candidate.
// The page's placement check reads capability again for the hours that reach it; reading it here first keeps an
// incapable technician's hours from using up the MAX_FULL_CHECKS full checks. TIMED_OUT when the budget ran out
// before one of its reads.
async function loadOpenTechDays(conn, env, { dates, capabilityRows, budget }) {
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];
  const techIds = (await env.assignableTechIds(conn)).map(String);
  if (budget.spent()) return TIMED_OUT;
  const blackout = await env.getBlackoutDates(dateFrom, dateTo, conn, { strict: true });
  if (budget.spent()) return TIMED_OUT;
  const absent = techIds.length ? await env.absentTechDays(conn, { dateFrom, dateTo, technicianIds: techIds }) : new Set();
  if (budget.spent()) return TIMED_OUT;
  const inactive = capabilityRows?.length && techIds.length ? await env.inactiveCapabilities(conn, techIds, capabilityRows) : [];
  const off = new Set(inactive.map((row) => String(row.technician_id)));
  const open = new Set(techIds.filter((id) => !off.has(id)));
  return (dateStr, techId) => open.has(String(techId)) && !blackout.has(dateStr) && !absent.has(`${techId}:${dateStr}`);
}

async function ownHoldIds(conn, estimateId) {
  if (!estimateId) return new Set();
  const rows = await conn('scheduled_services').where({ source_estimate_id: estimateId })
    .whereNotNull('reservation_expires_at').select('id');
  return new Set(rows.map((row) => String(row.id)));
}

function defaultDeps() {
  const replan = require('../day-replan')._internals;
  const arrivalRoute = require('./arrival-route');
  const startPoints = require('./tech-start-point');
  const occupancy = require('./occupancy');
  const eligibility = require('../technician-eligibility');
  const reminders = require('../appointment-reminders');
  const pushRouting = require('../messaging/push-channel-routing');
  const policy = require('./policy');
  return {
    loadDayStops: (conn, dateStr) => replan.loadDayStops(conn, dateStr, false),
    loadDayContext: replan.loadDayContext,
    fixedReason: replan.fixedReason,
    skipReason: replan.skipReason,
    loadBlocks: replan.loadBlocks,
    loadPref: replan.loadPref,
    legMin: replan.legMin,
    loadTechStartPoints: startPoints.loadTechStartPoints,
    homeFromMap: startPoints.homeFromMap,
    loadArrivalRouteContext: arrivalRoute.loadArrivalRouteContext,
    evaluateArrivalPlacement: arrivalRoute.evaluateArrivalPlacement,
    arrivalWindowsOn: arrivalRoute.arrivalWindowRoutingEnabled,
    getReminderPrefs: reminders.getReminderPrefs,
    resolve72hChannel: reminders.resolve72hChannel,
    assignableTechIds: async (conn) => (await eligibility.applyAssignable(conn('technicians')).select('technicians.id')).map((row) => row.id),
    absentTechDays: eligibility.absentTechDays,
    getBlackoutDates: require('./blackout-dates').getBlackoutDates,
    capacityOn: policy.capacityEnabled,
    customerMaxDetourMinutes: policy.customerMaxDetourMinutes,
    zoneRouteDaysLive: require('../../config/feature-gates').zoneRouteDaysLive,
    readZoneRouteDays: require('./zone-route-days').readZoneRouteDays,
    inactiveCapabilities: require('../technician-capabilities').inactiveCapabilitiesForServices,
    pushRouteFor: (customerId, messageType) => pushRouting.decidePushRoute({ gateOn: pushRouting.gatePushRoutingOn(), customerId, messageType }),
    appDeviceStatus: (customerId, conn) => require('../push-notifications').customerStatus(customerId, conn, { withReachable: true }),
    techBlind: () => !occupancy.techScopedConfirmActive(),
    closeMin: require('../auto-dispatch/candidate-slots').DAY_CLOSE,
    ownHoldIds,
    // The sooner pass's travel-gap screen (the page's own rule and entities).
    travelGapEnabled: require('./travel-gap').travelGapEnabled,
    travelGapConflicts: require('./travel-gap').travelGapConflicts,
    stopExpectedMinutesSync: require('./expected-service-minutes').stopExpectedMinutesSync,
    ensureCatalogLoaded: require('./expected-service-minutes').ensureCatalogLoaded,
    multiTechConfirmLive: require('../../config/feature-gates').multiTechConfirmLive,
  };
}

function summaryOf(candidate) {
  return {
    date: candidate.dateStr, start: hhmm(candidate.startMin), techId: candidate.techId, shiftMin: candidate.shiftMin,
    detourMin: candidate.detourMin, savingMin: candidate.savingMin,
    moves: candidate.moves.map((m) => ({ id: m.row.id, from: hhmm(m.fromMin), to: hhmm(m.toMin) })),
  };
}

// Full-check reasons a 2-hour move cannot change: the moved stops' own facts (the 2-hour chain holds every stop of the
// 1-hour one, from the same first stop) and a failed check.
const SAME_FOR_ANY_SHIFT = /^(changed$|fixed_|reminders_|prefs_unreadable$|error$)/;

// One full check within the budget: null when every rule holds, else why, or TIMED_OUT.
async function checkOne(candidate, ctx) {
  try {
    return await ctx.budget.race(() => fullCheck(candidate, ctx));
  } catch {
    return 'error';
  }
}

// The candidates that need reads, best first (`order`, by default the best saving), at most `limit`, within the budget.
// An hour whose 1-hour move fails is checked again with its 2-hour move (owner 2026-11-07 "B"); the hour counts once,
// with the last reason or the passing move. `onChecked` hears each hour that was fully checked.
async function checkCandidates(candidates, { conn, env, request, budget, report, caches, order = bySaving, limit = MAX_FULL_CHECKS, onChecked }) {
  const ctx = { conn, env, request, budget, caches };
  for (const candidate of candidates.sort(order).slice(0, limit)) {
    let checkedMove = candidate;
    let why = await checkOne(candidate, ctx);
    if (why && why !== TIMED_OUT && candidate.later && !SAME_FOR_ANY_SHIFT.test(why)) {
      report.twoHourTried += 1;
      checkedMove = candidate.later;
      why = await checkOne(checkedMove, ctx);
    }
    if (why === TIMED_OUT) {
      report.timedOut = true;
      return;
    }
    report.checked += 1;
    if (why) tally(report, why);
    else report.passed.push(summaryOf(checkedMove));
    if (onChecked) onChecked(candidate, why);
  }
}

// Whole days from `dateStr` to `laterDateStr` (both ET dates), or null.
function daysBetween(dateStr, laterDateStr) {
  if (!dateStr || !laterDateStr) return null;
  return Math.round((Date.parse(`${laterDateStr}T12:00:00Z`) - Date.parse(`${dateStr}T12:00:00Z`)) / 86400000);
}

// Every hour a stop starts on the given days, for the technicians the finder would use.
function collectCandidates(days, { open, env, request, report }) {
  const found = [];
  for (const [dateStr, rows] of days) {
    for (const techId of techIdsOf(rows)) {
      if (open(dateStr, techId)) found.push(...dayCandidates({ dateStr, rows, techId, env, request, report }));
      else tally(report, 'tech_day_closed');
    }
  }
  return found;
}

// The sooner-day measurement (log only): the hours on days before the first day of the customer's list that the same
// rules would give, with the saving bar swapped for the drive cap. Never throws: it must not cost the saving pass its
// turn. It fills report.sooner.
async function runSoonerPass(report, { dayRows, pool, open, soonerCap, request, conn, env, budget, caches }) {
  const firstFreeDay = pool.map((slot) => slot?.date).filter(Boolean).sort()[0] ?? null;
  const days = [...dayRows].filter(([dateStr]) => firstFreeDay == null || dateStr < firstFreeDay);
  const sooner = {
    firstFreeDay, daysBefore: days.length, capMin: env.customerMaxDetourMinutes(), tried: 0, candidates: 0, checked: 0,
    twoHourTried: 0, passed: [], byReason: {}, screenOn: false,
    screen: { pass: 0, overlap: 0, gap_before: 0, gap_after: 0 }, screenWrong: { saidPass_failed: 0, saidFail_passed: 0 }, timedOut: false,
  };
  report.sooner = sooner;
  try {
    const soonerRequest = { ...request, soonerCap };
    const found = collectCandidates(days, { open, env, request: soonerRequest, report: sooner });
    sooner.candidates = found.length;
    // filterCollidingSlots returns before its travel rule in capacity mode, so the screen is off there too.
    sooner.screenOn = typeof env.travelGapEnabled === 'function' && !!env.travelGapEnabled() && !env.capacityOn();
    if (sooner.screenOn && found.length) {
      // The page loads the catalog before its own travel-gap rule; the expected minutes of a stop read it.
      if (await budget.race(() => Promise.resolve(env.ensureCatalogLoaded?.(conn)).catch(() => {})) === TIMED_OUT) {
        sooner.timedOut = true;
        return;
      }
      for (const candidate of found) {
        candidate.screen = screenCandidate(candidate, dayRows.get(candidate.dateStr) || [], { env, request: soonerRequest });
        sooner.screen[candidate.screen === null ? 'pass' : candidate.screen] += 1;
      }
    }
    // How often the screen's guess matched the full check.
    const onChecked = (candidate, why) => {
      if (!sooner.screenOn) return;
      if (candidate.screen === null && why) sooner.screenWrong.saidPass_failed += 1;
      if (candidate.screen !== null && !why) sooner.screenWrong.saidFail_passed += 1;
    };
    await checkCandidates(found, { conn, env, request: soonerRequest, budget, report: sooner, caches, order: bySooner, limit: MAX_SOONER_CHECKS, onChecked });
  } catch (err) {
    sooner.error = err?.message || String(err);
  }
  sooner.passed = sooner.passed.map((hour) => ({ ...hour, daysGained: daysBetween(hour.date, firstFreeDay) }));
}

async function findMakeRoom(report, { conn, pool, point, durationMin, candidateExpectedMinutes, estimateId, capabilityRows, zoneSlug, dateFrom, dateTo, admit, placement, now, budget, deps }) {
  const base = deps || defaultDeps();
  // The setup reads run under the same budget as every later read.
  const homes = await budget.race(() => base.loadTechStartPoints(conn));
  const holdIds = homes === TIMED_OUT ? TIMED_OUT : await budget.race(() => base.ownHoldIds(conn, estimateId));
  if (holdIds === TIMED_OUT) {
    report.timedOut = true;
    return;
  }
  const env = { ...base, homeOf: (techId) => base.homeFromMap(homes, techId), techBlind: base.techBlind() };
  const dates = datesFor({ dateFrom, dateTo, pool });
  report.dates = dates.length;
  const dayRows = await loadDays(conn, env, { dates, holdIds, budget, report });
  if (!dayRows) return;
  const bestFree = bestFreeTime(pool, { dayRows, homeOf: env.homeOf, point, legMin: env.legMin });
  report.free = { count: pool.length, best: bestFree };
  const open = await budget.race(() => loadOpenTechDays(conn, env, { dates, capabilityRows, budget }));
  const caps = open === TIMED_OUT ? TIMED_OUT : await budget.race(() => loadDetourCaps(conn, env, zoneSlug));
  if (caps === TIMED_OUT) {
    report.timedOut = true;
    return;
  }
  const request = { point, durationMin, admit, placement, now, bestFree, estimateId, detourCap: caps.detourCap, candidateExpectedMinutes };
  // Both passes share what the reads return. The saving pass (the approved offer rule) runs first and unchanged; the
  // log-only sooner pass gets what is left of the budget.
  const caches = { blocks: new Map(), routes: new Map(), days: new Map() };
  const candidates = collectCandidates(dayRows, { open, env, request, report });
  report.candidates = candidates.length;
  await checkCandidates(candidates, { conn, env, request, budget, report, caches });
  await runSoonerPass(report, { dayRows, pool, open, soonerCap: caps.soonerCap, request, conn, env, budget, caches });
}

// The sooner pass's line items: its best hour is the earliest day that passed.
function soonerLog(sooner) {
  if (!sooner) return '';
  const best = [...sooner.passed].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))[0];
  return ` sooner_first_free=${sooner.firstFreeDay ?? '-'} sooner_checked=${sooner.checked} sooner_passed=${sooner.passed.length}`
    + ` sooner_best=${best ? `${best.date} ${best.start} +${best.shiftMin}` : '-'} sooner_days_gained=${best ? best.daysGained ?? '-' : '-'}`
    + ` sooner_detour=${best ? best.detourMin : '-'}`;
}

function logReport(report) {
  const best = report.passed[0];
  const saving = best ? (best.savingMin == null ? 'no_free_time' : best.savingMin) : '-';
  logger.info(`[booking-make-room] mode=${report.mode} surface=${report.surface} free=${report.free ? report.free.count : '-'}`
    + ` best_free=${report.free?.best ? report.free.best.detourMin : '-'} dates=${report.dates} tried=${report.tried}`
    + ` candidates=${report.candidates} checked=${report.checked} two_hour_tried=${report.twoHourTried} passed=${report.passed.length}`
    + ` best_saving=${saving} best_shift=${best ? best.shiftMin : '-'} moved=${best ? best.moves.length : '-'} timed_out=${report.timedOut} ms=${report.ms}`
    + soonerLog(report.sooner)
    + (report.skipped ? ` skipped=${report.skipped}` : '') + (report.error ? ` error=${String(report.error).slice(0, 120)}` : ''));
}

// Ids, dates, hours and minutes only: no name, address, phone or pin.
function checkRow(report) {
  const best = report.passed[0] || null;
  return {
    mode: report.mode,
    surface: report.surface,
    estimate_id: report.estimateId,
    fired: !!best,
    best_saving_min: best && best.savingMin != null ? Math.round(best.savingMin) : null,
    moved_count: best ? best.moves.length : null,
    report: JSON.stringify(report),
  };
}

/**
 * Checks one offered list and records the result. Never throws; the caller does not wait for it.
 * @param {object} args
 * @param {'shadow'|'on'} args.mode
 * @param {string} [args.surface]       'estimate'
 * @param {string} [args.estimateId]    its own live hold is not a stop
 * @param {Array}  args.pool            the final free list ({ date, windowStart, techId })
 * @param {object} args.coords          the new customer's pin { lat, lng }
 * @param {number} args.durationMinutes the new visit's length
 * @param {number} [args.candidateExpectedMinutes] the new visit's expected service minutes (the page's travel-gap credit)
 * @param {string} args.dateFrom        the request's first and last ET dates
 * @param {string} args.dateTo
 * @param {Function} args.admit         slot -> true when the page could offer it
 * @param {Function} args.placement     async (slot, Map<stop id, minutes later>) -> true, or why the page's own
 *                                      placement rules refuse the new visit on the moved day
 * @param {Array}  [args.capabilityRows] this estimate's services as technician-capabilities rows ({ service_type })
 * @param {string} [args.zoneSlug]      the request's route-day zone (the page passes find-time the same one)
 * @param {number} [args.budgetMs]      the check's time budget
 * @param {number} [args.lingerMs]      how long a check that ran out of time waits for the reads it already sent
 * @returns {Promise<object>} the report, once the check's own reads have answered (at most lingerMs after it ended)
 */
async function recordMakeRoomCheck({ mode, surface = 'estimate', estimateId = null, pool, coords, durationMinutes, candidateExpectedMinutes, capabilityRows, zoneSlug,
  dateFrom, dateTo, admit, placement, now = new Date(), conn, deps, budgetMs = DEFAULT_BUDGET_MS, lingerMs = LINGER_MS } = {}) {
  const startedAt = Date.now();
  const budget = makeBudget(startedAt + budgetMs);
  const report = { mode, surface, estimateId, durationMin: null, free: null, dates: 0, tried: 0, candidates: 0, checked: 0, twoHourTried: 0, passed: [], byReason: {}, timedOut: false, skipped: null, error: null, ms: 0, sooner: null };
  const knex = conn || require('../../models/db');
  try {
    const point = pointOf(coords);
    report.durationMin = Number(durationMinutes) > 0 ? Math.round(Number(durationMinutes)) : 60;
    if (!point) report.skipped = 'no_pin';
    else if (typeof admit !== 'function' || typeof placement !== 'function' || !dateFrom || !dateTo) report.skipped = 'no_request';
    else {
      await findMakeRoom(report, {
        conn: knex, pool: Array.isArray(pool) ? pool : [], point, durationMin: report.durationMin, candidateExpectedMinutes, estimateId,
        capabilityRows, zoneSlug,
        dateFrom, dateTo, admit, placement, now, budget, deps,
      });
    }
  } catch (err) {
    report.error = err?.message || String(err);
  }
  report.ms = Date.now() - startedAt;
  await finishCheck(knex, report, { budget, lingerMs });
  return report;
}

// Logs and records the report, then waits for the reads a timed-out check already sent: the caller, and so the
// in-flight slot, waits with it.
async function finishCheck(knex, report, { budget, lingerMs }) {
  try { logReport(report); } catch { /* logging never breaks a check */ }
  try {
    await knex(TABLE).insert(checkRow(report));
  } catch (err) {
    logger.warn(`[booking-make-room] could not record the check: ${err.message}`);
  }
  if (!(await budget.settledWithin(lingerMs))) {
    logger.warn(`[booking-make-room] a read was still running ${lingerMs} ms after the check ended; its slot is free again`);
  }
}

const inFlight = new Set();
const lastStarted = new Map();

/**
 * Starts one check in the background, or drops the request: at most MAX_IN_FLIGHT checks at once, and one estimate
 * at most once per DEDUPE_MS (Codex security review: a link holder can ask for many lists in a row). A dropped
 * request records nothing. A check holds its slot until recordMakeRoomCheck returns: after its row, and after the
 * reads a timed-out check already sent (at most LINGER_MS). Always returns a promise that never rejects.
 */
function startBackgroundCheck(args, { nowMs = Date.now() } = {}) {
  const key = args?.estimateId ? String(args.estimateId) : null;
  if (inFlight.size >= MAX_IN_FLIGHT || (key && nowMs - (lastStarted.get(key) ?? -Infinity) < DEDUPE_MS)) return Promise.resolve(null);
  for (const [id, at] of lastStarted) if (nowMs - at >= DEDUPE_MS) lastStarted.delete(id);
  const token = Symbol('check');
  inFlight.add(token);
  if (key) lastStarted.set(key, nowMs);
  return recordMakeRoomCheck(args).catch(() => null).finally(() => inFlight.delete(token));
}

function resetBackgroundChecks() {
  inFlight.clear();
  lastStarted.clear();
}

module.exports = {
  bookingMakeRoomMode,
  startBackgroundCheck,
  recordMakeRoomCheck,
  _internals: { buildChain, shiftsFor, MAX_SHIFT_MIN, bestFreeTime, addedDrive, neighbours, tryHour, remindersOn, remindersByText, moveBlockedReason, datesFor, bySaving, bySooner, daysBetween, defaultDeps, resetBackgroundChecks, makeBudget, TIMED_OUT, MIN_SAVING_MIN, MAX_FULL_CHECKS, MAX_SOONER_CHECKS, MAX_IN_FLIGHT, DEDUPE_MS, LINGER_MS },
};
