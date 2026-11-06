/**
 * Make room at booking (GATE_BOOKING_MAKE_ROOM, owner 2026-11-06 "build this first").
 *
 * A new customer on the estimate page may take the best hour on a route even when a regular stop holds it. That
 * stop moves later by the new visit's length in whole hours (1 hour for a visit up to 60 minutes: the owner's
 * 2026-11-03 rule), and so does each later stop it would then overlap, until a free hour takes the last one. This
 * module FINDS such hours for one customer's list. It never writes a visit and never changes the list.
 *
 * An hour counts only when every rule holds:
 *   1. The estimate page could offer it (the caller's `admit`: the customer grid and close, the request's dates,
 *      weekends, zone days, time of day, notice and season) and it starts where a stop starts, on a day the free-slot
 *      finder would use: an assignable technician, no absent or off tech-day, no blackout date (find-time's rules).
 *   2. Every stop in the chain may move under the 4:40 re-plan's own rules: day-replan fixedReason, read again with
 *      the day's full facts (status, hold, staff lock, office review, group, same customer twice, the 24-hour lock,
 *      the 24-hour text and, with GATE_NIGHT_TOLD_LOCK, confirmed, first or one-time, person-placed and told
 *      visits). Its customer also gets the 72-hour and 24-hour reminders BY TEXT (the sender's own channel rules), so
 *      the new time reaches them. Its time
 *      preference (the re-plan's loadPref) allows the new hour, and it still ends by the night tools' day close.
 *   3. Nothing else holds the new minutes: no unassigned visit, no other technician's visit while the occupancy
 *      check is technician-blind (the re-plan's blockedHoursFor rule), no schedule block.
 *   4. The route keeps every arrival window with the new visit in it: arrival-route.js evaluateArrivalPlacement on
 *      the moved day, the check the estimate page runs today.
 *   5. The new visit adds at least MIN_SAVING_MIN fewer drive minutes than the best free time in the list.
 * Drive minutes on both sides use the re-plan's straight-line leg (legMin) from the technician's start point: the
 * drive the new visit adds between the stop before it and the stop after it. The moved stops keep their order, so
 * they add no drive. $0: no Google, no AI.
 *
 * Modes (bookingMakeRoomMode, read at CALL time):
 *   off     unset or any other value. Callers never reach this module.
 *   shadow  find and record one booking_make_room_checks row per checked list. The customer's list does not change.
 *   on      GATE_BOOKING_MAKE_ROOM=true. Reserved for the offer, hold and move (a later change); today it records
 *           exactly like shadow.
 *
 * Never throws, spends nothing, sends nothing, and writes only its own log row.
 */
const logger = require('../logger');

const MIN_SAVING_MIN = 10;
const DEFAULT_BUDGET_MS = 4000;
const MAX_DATES = 21;
const MAX_FULL_CHECKS = 6;
const TABLE = 'booking_make_room_checks';
const TIMED_OUT = Symbol('timed_out');

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

const sameTech = (row, techId) => techId != null && row.technician_id != null && String(row.technician_id) === String(techId);

// One technician's timed stops with a pin, in start order: the order the chain walks.
function ownStops(rows, techId) {
  return rows.filter((row) => sameTech(row, techId) && bookedRange(row) && pointOf(row))
    .sort((a, b) => bookedRange(a).startMin - bookedRange(b).startMin || String(a.id).localeCompare(String(b.id)));
}

/**
 * The stops a new visit at [startMin, startMin + durationMin) pushes later, in order. `own` is the technician's timed
 * stops in start order. Each moved stop keeps its length and moves the same whole hours; the chain ends at the first
 * stop the moved ones no longer overlap. Returns { moves: [{ row, fromMin, toMin, widthMin }] } or { reason }. Pure.
 */
function buildChain(own, { startMin, durationMin, closeMin }) {
  const shift = shiftMinutesFor(durationMin);
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

// One hour on one technician-day, with the checks that need no read. Returns { candidate } or { reason }.
function tryHour({ day, startMin, env, request }) {
  const { durationMin } = request;
  const slot = { date: day.dateStr, windowStart: hhmm(startMin), windowEnd: hhmm(startMin + durationMin), durationMinutes: durationMin, techId: day.techId };
  if (!request.admit(slot)) return { reason: 'not_offerable' };
  const chain = buildChain(day.own, { startMin, durationMin, closeMin: env.closeMin });
  if (chain.reason) return { reason: chain.reason };
  const fixed = chain.moves.map((m) => env.fixedReason(m.row, day.quick)).find(Boolean);
  if (fixed) return { reason: `fixed_${fixed}` };
  const candidate = { dateStr: day.dateStr, techId: day.techId, startMin, durationMin, moves: chain.moves };
  if (hitsAny(chainRanges(candidate), day.taken)) return { reason: 'taken_by_other' };
  const { prev } = neighbours(day.own, startMin, day.home);
  candidate.detourMin = addedDrive(env.legMin, prev, request.point, pointOf(chain.moves[0].row));
  candidate.savingMin = request.bestFree ? request.bestFree.detourMin - candidate.detourMin : null;
  if (candidate.savingMin != null && candidate.savingMin < MIN_SAVING_MIN) return { reason: 'saving_below_bar' };
  return { candidate };
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
  return result?.feasible === true ? true : `route_${result?.reason || 'unknown'}`;
}

// The moved customer hears the new time only from the 72-hour and 24-hour texts, so both must be on and readable.
function remindersOn(prefs) {
  return !!prefs && prefs.unavailable !== true && prefs.smsEnabled !== false
    && prefs.serviceReminder72h !== false && prefs.serviceReminder24h !== false;
}

const TEXT_CHANNELS = new Set(['sms', 'both']);

// ...and both go out by text: the channels the reminder sender itself uses (resolve72hChannel for the 72-hour leg,
// which can promote a one-time visit to email; the stored 24-hour channel). Email or app only never moves.
async function remindersByText(prefs, row, env) {
  const channel72 = await env.resolve72hChannel(prefs.reminder72hChannel, row.id, {
    prefsUnavailable: prefs.unavailable,
    explicitChoice: prefs.reminder72hChannelExplicit,
    emailEnabled: prefs.emailEnabled,
  });
  return TEXT_CHANNELS.has(channel72) && TEXT_CHANNELS.has(prefs.reminder24hChannel);
}

// Why one moved stop may not move after all, from the day's full facts, or null.
async function moveBlockedReason(move, { conn, env, day, techId }) {
  const row = (day?.allRows || []).find((r) => String(r.id) === String(move.row.id));
  if (!row || !sameTech(row, techId) || bookedRange(row)?.startMin !== move.fromMin) return 'changed';
  const why = env.fixedReason(row, day);
  if (why) return `fixed_${why}`;
  let prefs;
  let pref;
  try {
    prefs = await env.getReminderPrefs(row.customer_id, { scheduledServiceId: row.id });
    if (!remindersOn(prefs)) return 'reminders_off';
    if (!(await remindersByText(prefs, row, env))) return 'reminders_not_text';
    pref = await env.loadPref(conn, row);
  } catch {
    return 'prefs_unreadable';
  }
  return pref && !(move.toMin >= pref.startMin && move.toMin < pref.endMin) ? 'preference' : null;
}

// The checks that read the database, for one candidate: schedule blocks, the route, then each moved stop's facts.
async function fullCheck(candidate, ctx) {
  const { conn, env, request, caches } = ctx;
  const blocks = await cached(caches.blocks, `${candidate.dateStr}|${candidate.techId}`, () => env.loadBlocks(conn, candidate.dateStr, candidate.techId));
  if (hitsAny(chainRanges(candidate), blocks || [])) return 'schedule_block';
  const route = await routeKeepsWindows(candidate, ctx);
  if (route !== true) return route;
  const day = await cached(caches.days, candidate.dateStr, () => env.loadDayContext(conn, candidate.dateStr, request.now));
  for (const move of candidate.moves) {
    const why = await moveBlockedReason(move, { conn, env, day, techId: candidate.techId });
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

function addDays(dateStr, days) {
  const at = new Date(`${dateStr}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// The request's dates (at most MAX_DATES) and every date the free list uses, in order.
function datesFor({ dateFrom, dateTo, pool }) {
  const dates = new Set(pool.map((slot) => slot?.date).filter(Boolean));
  for (let i = 0; i < MAX_DATES && addDays(dateFrom, i) <= dateTo; i++) dates.add(addDays(dateFrom, i));
  return [...dates].sort();
}

// The days, without this estimate's own hold. Null when a day cannot be read in time: a best free time judged on
// part of the list could read a saving that is not there.
async function loadDays(conn, env, { dates, holdIds, deadline, report }) {
  const days = new Map();
  for (const dateStr of dates) {
    const rows = await raceBudget(env.loadDayStops(conn, dateStr), deadline);
    if (rows === TIMED_OUT) {
      report.timedOut = true;
      return null;
    }
    days.set(dateStr, (rows || []).filter((row) => !holdIds.has(String(row.id))));
  }
  return days;
}

// The free-slot finder's own day and technician rules (find-time loadFindTimeContext): assignable technicians only,
// no absent or off tech-day, no blackout date (strict: an unreadable list stops the check). A stop left on such a
// day is never a place to book, so it is never a candidate.
async function loadOpenTechDays(conn, env, dates) {
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];
  const techIds = (await env.assignableTechIds(conn)).map(String);
  const blackout = await env.getBlackoutDates(dateFrom, dateTo, conn, { strict: true });
  const absent = techIds.length ? await env.absentTechDays(conn, { dateFrom, dateTo, technicianIds: techIds }) : new Set();
  const assignable = new Set(techIds);
  return (dateStr, techId) => assignable.has(String(techId)) && !blackout.has(dateStr) && !absent.has(`${techId}:${dateStr}`);
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
    getReminderPrefs: reminders.readReminderPrefs,
    resolve72hChannel: reminders.resolve72hChannel,
    assignableTechIds: async (conn) => (await eligibility.applyAssignable(conn('technicians')).select('technicians.id')).map((row) => row.id),
    absentTechDays: eligibility.absentTechDays,
    getBlackoutDates: require('./blackout-dates').getBlackoutDates,
    techBlind: () => !occupancy.techScopedConfirmActive(),
    closeMin: require('../auto-dispatch/candidate-slots').DAY_CLOSE,
    ownHoldIds,
  };
}

function summaryOf(candidate) {
  return {
    date: candidate.dateStr, start: hhmm(candidate.startMin), techId: candidate.techId,
    detourMin: candidate.detourMin, savingMin: candidate.savingMin,
    moves: candidate.moves.map((m) => ({ id: m.row.id, from: hhmm(m.fromMin), to: hhmm(m.toMin) })),
  };
}

// The candidates that need reads, best saving first, within the budget.
async function checkCandidates(candidates, { conn, env, request, deadline, report }) {
  const caches = { blocks: new Map(), routes: new Map(), days: new Map() };
  for (const candidate of candidates.sort(bySaving).slice(0, MAX_FULL_CHECKS)) {
    let why;
    try {
      why = await raceBudget(fullCheck(candidate, { conn, env, request, caches }), deadline);
    } catch {
      why = 'error';
    }
    if (why === TIMED_OUT) {
      report.timedOut = true;
      return;
    }
    report.checked += 1;
    if (why) tally(report, why);
    else report.passed.push(summaryOf(candidate));
  }
}

async function findMakeRoom(report, { conn, pool, point, durationMin, estimateId, dateFrom, dateTo, admit, now, deadline, deps }) {
  const base = deps || defaultDeps();
  const homes = await base.loadTechStartPoints(conn);
  const env = { ...base, homeOf: (techId) => base.homeFromMap(homes, techId), techBlind: base.techBlind() };
  const holdIds = await env.ownHoldIds(conn, estimateId);
  const dates = datesFor({ dateFrom, dateTo, pool });
  report.dates = dates.length;
  const dayRows = await loadDays(conn, env, { dates, holdIds, deadline, report });
  if (!dayRows) return;
  const bestFree = bestFreeTime(pool, { dayRows, homeOf: env.homeOf, point, legMin: env.legMin });
  report.free = { count: pool.length, best: bestFree };
  const request = { point, durationMin, admit, now, bestFree, estimateId };
  const open = await raceBudget(loadOpenTechDays(conn, env, dates), deadline);
  if (open === TIMED_OUT) {
    report.timedOut = true;
    return;
  }
  const candidates = [];
  for (const [dateStr, rows] of dayRows) {
    for (const techId of techIdsOf(rows)) {
      if (open(dateStr, techId)) candidates.push(...dayCandidates({ dateStr, rows, techId, env, request, report }));
      else tally(report, 'tech_day_closed');
    }
  }
  report.candidates = candidates.length;
  await checkCandidates(candidates, { conn, env, request, deadline, report });
}

function logReport(report) {
  const best = report.passed[0];
  const saving = best ? (best.savingMin == null ? 'no_free_time' : best.savingMin) : '-';
  logger.info(`[booking-make-room] mode=${report.mode} surface=${report.surface} free=${report.free ? report.free.count : '-'}`
    + ` best_free=${report.free?.best ? report.free.best.detourMin : '-'} dates=${report.dates} tried=${report.tried}`
    + ` candidates=${report.candidates} checked=${report.checked} passed=${report.passed.length} best_saving=${saving}`
    + ` moved=${best ? best.moves.length : '-'} timed_out=${report.timedOut} ms=${report.ms}`
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
 * @param {string} args.dateFrom        the request's first and last ET dates
 * @param {string} args.dateTo
 * @param {Function} args.admit         slot -> true when the page could offer it
 * @returns {Promise<object>} the report
 */
async function recordMakeRoomCheck({ mode, surface = 'estimate', estimateId = null, pool, coords, durationMinutes, dateFrom, dateTo, admit,
  now = new Date(), conn, deps, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const startedAt = Date.now();
  const report = { mode, surface, estimateId, durationMin: null, free: null, dates: 0, tried: 0, candidates: 0, checked: 0, passed: [], byReason: {}, timedOut: false, skipped: null, error: null, ms: 0 };
  const knex = conn || require('../../models/db');
  try {
    const point = pointOf(coords);
    report.durationMin = Number(durationMinutes) > 0 ? Math.round(Number(durationMinutes)) : 60;
    if (!point) report.skipped = 'no_pin';
    else if (typeof admit !== 'function' || !dateFrom || !dateTo) report.skipped = 'no_request';
    else {
      await findMakeRoom(report, {
        conn: knex, pool: Array.isArray(pool) ? pool : [], point, durationMin: report.durationMin, estimateId,
        dateFrom, dateTo, admit, now, deadline: startedAt + budgetMs, deps,
      });
    }
  } catch (err) {
    report.error = err?.message || String(err);
  }
  report.ms = Date.now() - startedAt;
  try { logReport(report); } catch { /* logging never breaks a check */ }
  try {
    await knex(TABLE).insert(checkRow(report));
  } catch (err) {
    logger.warn(`[booking-make-room] could not record the check: ${err.message}`);
  }
  return report;
}

module.exports = {
  bookingMakeRoomMode,
  recordMakeRoomCheck,
  _internals: { buildChain, bestFreeTime, addedDrive, neighbours, tryHour, remindersOn, remindersByText, moveBlockedReason, datesFor, bySaving, defaultDeps, MIN_SAVING_MIN, MAX_FULL_CHECKS },
};
