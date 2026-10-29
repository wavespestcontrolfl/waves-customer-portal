/**
 * Route check for customer-facing time lists (GATE_CUSTOMER_ROUTE_CHECK,
 * owner 2026-10-29, "Route Check Everywhere" build 3).
 *
 * The dispatcher's 2-hour arrival-window route check (arrival-route.js) says
 * whether a visit placed at a start would make ANOTHER customer arrive after
 * their promised window. The customer pickers (/book, public reschedule and
 * re-service, the inspection link, the commercial first visit, the estimate
 * page) were built on the older gap engine, which does not run that check.
 * This module runs it over a list the picker ALREADY built, as a DROP-ONLY
 * filter: a slot is removed only when the check says 'arrival_window'. Every
 * other outcome keeps the slot.
 *
 * Modes (customerRouteCheckMode, read at CALL time):
 *   off     unset or any other value. Callers never reach this module.
 *   shadow  compute and log, return today's list.
 *   on      GATE_CUSTOMER_ROUTE_CHECK=true. Return the list without the
 *           slots that would make another customer late.
 *
 * Safety rules (all tested):
 *   - Each OFFERED slot is evaluated at its own date, start minute (10:45 is
 *     evaluated at 10:45, never at an hour list) and technician, for the
 *     duration the legacy engine used. One route context per (date,
 *     technician) per request.
 *   - Filter only: order and object shapes are the input's, never mutated.
 *   - Floor: if removals would leave nothing dated today..today+6 (ET), the
 *     original list is returned (report.floorKept).
 *   - Budget about 1500 ms: slots not yet evaluated are kept (timedOut).
 *   - Never throws: on any error the original list comes back (report.error).
 *   - Spends nothing: the default route-optimizer estimate drives every leg
 *     (the GPS-fitted clock under GATE_DRIVE_CLOCK). No Google, no road
 *     check, no spender, no provider travel.
 */
const logger = require('../logger');

const DEFAULT_BUDGET_MS = 1500;
const FLOOR_DAYS = 6;
const MAX_REMOVED_LINES = 5;

function customerRouteCheckMode() {
  try {
    const gates = require('../../config/feature-gates');
    const mode = typeof gates.customerRouteCheckMode === 'function' ? gates.customerRouteCheckMode() : 'off';
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

// The offered slot's date, start minute and technician, from either list
// shape: the booking slot (start_time, technician_id) or the estimate slot
// (windowStart, techId).
function defaultPick(slot) {
  const date = String(slot?.date || '').slice(0, 10);
  const startMin = minutesOf(slot?.start_time ?? slot?.startTime24 ?? slot?.windowStart);
  const technicianId = slot?.technician_id ?? slot?.technician?.id ?? slot?.techId ?? null;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && startMin != null ? { date, startMin, technicianId } : null;
}

function todayEtString(today) {
  if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}/.test(today)) return today.slice(0, 10);
  const { etDateString } = require('../../utils/datetime-et');
  return etDateString(today instanceof Date ? today : new Date());
}

function floorEndDate(todayEt) {
  const end = new Date(`${todayEt}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + FLOOR_DAYS);
  return end.toISOString().slice(0, 10);
}

function newReport(surface, mode, offered) {
  return {
    surface: surface || '-', mode, offered,
    removed: 0, keptUnverified: 0, keptOther: 0, evaluated: 0, errors: 0,
    byReason: {}, floorKept: false, timedOut: false, error: null, skipped: null,
    firstStopHour: null, removedSlots: [],
  };
}

// Hour of the earliest timed stop on this technician's day, from the context
// already loaded (for a later day-start study).
function firstStopHourOf(context, technicianId) {
  let earliest = null;
  for (const row of context?.rows || []) {
    if (row.technician_id !== technicianId) continue;
    const start = minutesOf(row.window_start);
    if (start != null && (earliest == null || start < earliest)) earliest = start;
  }
  return earliest == null ? null : Math.floor(earliest / 60);
}

function logReport(report, startedAt) {
  const hour = report.firstStopHour == null ? '-' : String(report.firstStopHour).padStart(2, '0');
  logger.info(`[customer-route-check] surface=${report.surface} mode=${report.mode} offered=${report.offered}`
    + ` removed=${report.removed} kept_unverified=${report.keptUnverified} kept_other=${report.keptOther}`
    + ` floor_kept=${report.floorKept} timed_out=${report.timedOut} first_stop_hour=${hour} ms=${Date.now() - startedAt}`
    + (report.error ? ` error=${String(report.error).slice(0, 120)}` : ''));
  for (const row of report.removedSlots.slice(0, MAX_REMOVED_LINES)) {
    logger.info(`[customer-route-check] removed surface=${report.surface} date=${row.date} start=${row.start}`
      + ` tech=${row.technicianId || '-'} late=${row.lateVisitId || '-'}`);
  }
}

function tally(report, result, slotInfo) {
  report.evaluated += 1;
  const reason = result?.feasible ? 'feasible' : (result?.reason || 'unknown');
  report.byReason[reason] = (report.byReason[reason] || 0) + 1;
  if (reason === 'arrival_window') {
    report.removed += 1;
    report.removedSlots.push({ date: slotInfo.date, start: hhmm(slotInfo.startMin), technicianId: slotInfo.technicianId,
      lateVisitId: result.lateVisitId || result.lateStopId || null });
    return true;
  }
  if (reason === 'route_unverified') report.keptUnverified += 1;
  else report.keptOther += 1;
  return false;
}

// Loads the route context of one (date, technician) once per request. A
// failed load is remembered (null), so a bad day is never retried.
function contextLoader({ arrivalRoute, conn, target, now }) {
  const cache = new Map();
  return (date, technicianId) => {
    const key = `${date}|${technicianId}`;
    if (!cache.has(key)) {
      const loading = arrivalRoute.loadArrivalRouteContext({
        conn, date, technicianId, now,
        ...(target.prospective ? { prospective: target.prospective } : { serviceId: target.serviceId }),
        excludeServiceIds: target.excludeServiceIds || [],
        ...(target.excludeEstimateId ? { excludeEstimateId: target.excludeEstimateId } : {}),
      }).then((context) => ({ context, firstStopHour: firstStopHourOf(context, technicianId) }),
        () => ({ context: null, failed: true, firstStopHour: null }));
      cache.set(key, loading);
    }
    return cache.get(key);
  };
}

function raceBudget(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(null);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), remaining); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hasPin(prospective) {
  const lat = Number(prospective?.lat);
  const lng = Number(prospective?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
}

// Why a request is not checked at all (null = check it).
function skipReason({ runMode, original, target, arrivalRoute }) {
  if (runMode === 'off') return 'off';
  if (!original.length) return 'empty';
  if (!arrivalRoute.arrivalWindowRoutingEnabled()) return 'arrival_windows_off';
  return !target || (!target.serviceId && !hasPin(target.prospective)) ? 'no_target' : null;
}

async function evaluateAll({ arrivalRoute, slots, target, durationMinutes, conn, pick, deadline, report }) {
  const load = contextLoader({ arrivalRoute, conn, target, now: new Date() });
  const remove = new Set();
  let firstStopHour = null;
  for (let i = 0; i < slots.length; i++) {
    if (Date.now() >= deadline) { report.timedOut = true; break; }
    const info = pick(slots[i]);
    if (!info) { report.keptOther += 1; continue; }
    if (!info.technicianId) {
      report.evaluated += 1;
      report.byReason.route_unverified = (report.byReason.route_unverified || 0) + 1;
      report.keptUnverified += 1;
      continue;
    }
    try {
      const loaded = await raceBudget(load(info.date, info.technicianId), deadline);
      if (!loaded) { report.timedOut = true; break; }
      if (firstStopHour == null && loaded.firstStopHour != null) firstStopHour = loaded.firstStopHour;
      if (loaded.failed) {
        report.errors += 1;
        report.keptOther += 1;
        continue;
      }
      const result = arrivalRoute.evaluateArrivalPlacement(loaded.context, {
        windowStart: hhmm(info.startMin), windowEnd: hhmm(info.startMin + durationMinutes), durationMinutes,
      });
      if (tally(report, result, info)) remove.add(i);
    } catch {
      report.errors += 1;
      report.keptOther += 1;
    }
  }
  report.firstStopHour = firstStopHour;
  return remove;
}

// Removals that would leave nothing dated today..today+6 keep the list whole.
function floorBlocks({ slots, remove, pick, today }) {
  if (!remove.size) return false;
  const todayEt = todayEtString(today);
  const end = floorEndDate(todayEt);
  return !slots.some((slot, i) => {
    if (remove.has(i)) return false;
    const date = pick(slot)?.date;
    return date != null && date >= todayEt && date <= end;
  });
}

/**
 * @param {object} args
 * @param {string} args.surface   'book' | 'reschedule' | 'reservice' | 'inspection' |
 *                                'commercial_first_visit' | 'voice' | 'estimate' (route list + ASAP windows together)
 * @param {Array}  args.slots     the picker's offered slots (any shape pick() can read)
 * @param {object} args.target    { prospective: { lat, lng, estimated_duration_minutes },
 *                                  excludeServiceIds?, excludeEstimateId? } for a new
 *                                visit or a move that carries the customer's pin, or
 *                                { serviceId } for a stored visit (its own row excluded)
 * @param {number} args.durationMinutes  the duration the legacy engine used (fallback 60)
 * @param {Date|string} args.today
 * @param {object} [args.conn]    knex connection (default: the app db)
 * @param {string} [args.mode]    'shadow' | 'on' (default: the gate)
 * @param {Function} [args.pick]  slot -> { date, startMin, technicianId }
 * @param {number} [args.budgetMs]
 * @returns {Promise<{ slots: Array, report: object }>} never throws
 */
async function filterOfferedSlots({ surface, slots, target, durationMinutes, today, conn, mode, pick = defaultPick, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const startedAt = Date.now();
  const original = Array.isArray(slots) ? slots : [];
  const runMode = mode || customerRouteCheckMode();
  const report = newReport(surface, runMode, original.length);
  try {
    report.skipped = skipReason({ runMode, original, target, arrivalRoute: require('./arrival-route') });
    if (report.skipped) return { slots: original, report };
    const arrivalRoute = require('./arrival-route');
    const duration = Number(durationMinutes) > 0 ? Number(durationMinutes) : 60;
    const checkTarget = target.prospective
      ? { ...target, prospective: { ...target.prospective, estimated_duration_minutes: duration } } : target;
    const remove = await evaluateAll({
      arrivalRoute, slots: original, target: checkTarget, durationMinutes: duration,
      conn: conn || require('../../models/db'), pick, deadline: startedAt + budgetMs, report,
    });
    if (floorBlocks({ slots: original, remove, pick, today })) {
      report.floorKept = true;
      return { slots: original, report };
    }
    if (runMode !== 'on' || !remove.size) return { slots: original, report };
    return { slots: original.filter((_, i) => !remove.has(i)), report };
  } catch (err) {
    report.error = err?.message || String(err);
    return { slots: original, report };
  } finally {
    if (!report.skipped && runMode !== 'off') {
      try { logReport(report, startedAt); } catch { /* logging never breaks a picker */ }
    }
  }
}

module.exports = { customerRouteCheckMode, filterOfferedSlots, _internals: { defaultPick, floorEndDate, DEFAULT_BUDGET_MS } };
