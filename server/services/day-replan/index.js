/**
 * Nightly day re-plan, SHADOW only (owner ruling 2026-11-03, PR 1 of 3). Gate: GATE_DAY_REPLAN.
 *
 * The owner wants each day's route re-planned as leniently as possible to save drive time. Any
 * visit may get a new hour (first visits, one-time visits, hand-placed and customer-confirmed
 * visits too). The only lock is 24 hours: a visit whose 24-hour reminder is due or sent never
 * changes. NO text goes out about the change: the 24-hour reminder carries the new time, and the
 * night writer already re-syncs reminders silently.
 *
 * This job plans each technician-day from tomorrow out to DAY_REPLAN_DAYS_AHEAD (default 14) with
 * the pure planner (./planner.js) and writes what it WOULD do to day_replan_plans: ids, minutes and
 * HH:MM only, never a name, address or phone number. It NEVER writes scheduled_services or
 * appointment_reminders, sends nothing and raises no notification. Drive times use the free
 * straight-line model (no Google, no AI, no paid call). 'apply' (GATE_DAY_REPLAN=true) behaves
 * exactly like 'shadow' until a later PR writes the new hours.
 *
 * A stop is MOVABLE only when all hold; everything else stays FIXED at its hour:
 *   status pending or confirmed, not an estimate-slot hold, no staff lock (auto_dispatch_locked or
 *   auto_dispatch_excluded), not part of a grouped visit (another live row shares its visit_id), no
 *   other live stop that day for the same customer (co-visits stay together), its appointment starts
 *   more than 24.25 hours from now (America/New_York), and its 24-hour reminder is not sent.
 * Also enforced for movable stops: the technician's tech_schedule_blocks (own and global, every type but
 * 'available') may not overlap a stop's service interval; hours held by unassigned (and, while occupancy is
 * tech-blind, other technicians') visits are taken; the day closes at the night pass's DAY_CLOSE (after_hours);
 * and, only in dry-time mode 'true' with no customer-set time, a rain-sensitive stop stays in its dry window.
 * The night pass's 'weekend' filter (skip_weekends series) is a date rule: this job never changes a date.
 * A day is skipped (and the reason logged) with fewer than 2 stops, a day-long schedule block, a stop without coordinates, a
 * stop without a time, or a stop already en route or on site.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { dayReplanMode } = require('../../config/feature-gates');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { dayStopsQuery, guardedCoordSelects } = require('../scheduling/day-stops');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { workDuration, currentOrder, promisedWindowOrder, staleOrderReasons } = require('../route-reorder-window-fit');
const { getCustomerSchedulingPreferences } = require('../auto-dispatch/preferences');
const { windowByKey } = require('../auto-dispatch/dry-time');
const RouteOptimizer = require('../route-optimizer');
const { planDay } = require('./planner');

const DEFAULT_DAYS_AHEAD = 14;
const MAX_DAYS_AHEAD = 30;
// A visit whose appointment starts within this many hours is locked (the 24-hour reminder's reach).
const LOCK_HOURS = 24.25;
const MOVABLE_STATUSES = ['pending', 'confirmed'];
const EXCLUDED_STATUSES = ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show'];
const IN_PROGRESS_STATUSES = ['en_route', 'on_site'];
const PLAN_TABLE = 'day_replan_plans';

function daysAhead() {
  const raw = Number.parseInt(process.env.DAY_REPLAN_DAYS_AHEAD, 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_DAYS_AHEAD;
  return Math.min(raw, MAX_DAYS_AHEAD);
}

function horizonDates(now) {
  const count = daysAhead();
  return Array.from({ length: count }, (_, i) => etDateString(addETDays(now, i + 1)));
}

function hhmmToMin(value) {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

function minToHhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function hasCoords(row) {
  if (row.lat == null || row.lng == null) return false;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
}

function legMin(a, b) {
  return RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(a.lat, a.lng, b.lat, b.lng)).minutes;
}

async function loadDayStops(conn, dateStr) {
  const { _internals } = require('../route-reorder');
  return dayStopsQuery(conn, {
    dateStr,
    excludeStatuses: EXCLUDED_STATUSES,
    select: [
      'scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.customer_id',
      'scheduled_services.visit_id', 'scheduled_services.status',
      'scheduled_services.window_start', 'scheduled_services.window_end', 'scheduled_services.time_window',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.service_type',
      'scheduled_services.is_recurring', 'scheduled_services.is_callback',
      'scheduled_services.auto_dispatch_locked', 'scheduled_services.auto_dispatch_excluded',
      'scheduled_services.reservation_expires_at', 'scheduled_services.route_order', 'scheduled_services.created_at',
      ...guardedCoordSelects(conn),
    ],
  }).whereRaw(_internals.LIVE_HOLD_SQL);
}

/** Ids whose 24-hour reminder is recorded as sent. Throws when the read fails (the caller skips the day). */
async function loadReminder24hSent(conn, ids) {
  if (!ids.length) return new Set();
  const rows = await conn('appointment_reminders')
    .whereIn('scheduled_service_id', ids)
    .select('scheduled_service_id', 'reminder_24h_sent');
  return new Set(rows.filter((r) => r.reminder_24h_sent === true).map((r) => r.scheduled_service_id));
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    if (row[key] == null) continue;
    counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  }
  return counts;
}

function startsMoreThanLockAway(row, dateStr, now) {
  const start = parseETDateTime(`${dateStr}T${String(row.window_start).slice(0, 5)}`);
  return start.getTime() - now.getTime() > LOCK_HOURS * 3600000;
}

/** Why a stop stays fixed at its hour, or null when it may move. */
function fixedReason(row, { dateStr, now, visitCounts, customerCounts, sent24 }) {
  if (!MOVABLE_STATUSES.includes(row.status)) return 'status';
  if (row.reservation_expires_at) return 'hold';
  if (row.auto_dispatch_locked === true || row.auto_dispatch_excluded === true) return 'staff_lock';
  if (row.visit_id != null && visitCounts.get(row.visit_id) > 1) return 'grouped';
  if (row.customer_id != null && customerCounts.get(row.customer_id) > 1) return 'same_customer';
  if (!startsMoreThanLockAway(row, dateStr, now)) return 'within_24h';
  if (sent24.has(row.id)) return 'reminder_24h_sent';
  return null;
}

/** Hours a row's booked window covers (window_start up to window_end, else start + estimate, else 60 min), at least one. */
function rowHours(row) {
  const start = hhmmToMin(row.window_start);
  const end = row.window_end ? hhmmToMin(row.window_end) : start + (Number(row.estimated_duration_minutes) || 60);
  const first = Math.floor(start / 60);
  const last = Math.max(first, Math.ceil(Math.max(end, start + 1) / 60) - 1);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * Hours held by live timed rows that are not this technician's route stops. The app's occupancy check
 * (scheduling/occupancy.js) blocks an hour for EVERY technician when an unassigned row holds it, and, while it
 * is tech-blind (GATE_MULTI_TECH_CONFIRM off), when another technician's row holds it too.
 * `rows` is the whole date's live rows, so expired estimate-slot holds are already out.
 */
function blockedHoursFor(rows, techId, techBlind) {
  const hours = new Set();
  for (const row of rows) {
    if (!row.window_start) continue;
    const own = row.technician_id != null && String(row.technician_id) === String(techId);
    if (own) continue;
    if (row.technician_id == null || techBlind) for (const h of rowHours(row)) hours.add(h);
  }
  return [...hours].sort((a, b) => a - b);
}

/**
 * The technician's unavailable intervals on a date: their own tech_schedule_blocks and the global ones
 * (technician_id NULL), every block_type but 'available'. The same read arrival-route.js makes, but always (it
 * loads them only in capacity mode). Throws when the read fails.
 */
async function loadBlocks(conn, dateStr, techId) {
  const rows = await conn('tech_schedule_blocks')
    .where({ date: dateStr }).whereNot('block_type', 'available')
    .where((q) => q.where('technician_id', techId).orWhereNull('technician_id'))
    .select('id', 'start_time', 'end_time');
  return rows
    .map((r) => ({ startMin: hhmmToMin(r.start_time), endMin: hhmmToMin(r.end_time) }))
    .filter((b) => Number.isFinite(b.startMin) && Number.isFinite(b.endMin) && b.endMin > b.startMin);
}

/** True when one block covers the whole working day (open to close). */
function blocksWholeDay(blocks, openMin, closeMin) {
  return blocks.some((b) => b.startMin <= openMin && b.endMin >= closeMin);
}

/** Why the whole tech-day is not planned, or null. */
function skipReason(rows) {
  if (rows.length < 2) return 'FEWER_THAN_2_STOPS';
  if (rows.some((r) => IN_PROGRESS_STATUSES.includes(r.status))) return 'STOP_IN_PROGRESS';
  if (rows.some((r) => !r.window_start)) return 'UNTIMED_STOP';
  if (rows.some((r) => !hasCoords(r))) return 'STOP_WITHOUT_COORDINATES';
  return null;
}

/**
 * The dry window as a hard time filter for a movable stop, or null. Only when the night pass would apply it:
 * dry-time mode 'true' (off and shadow, production today, are ignored as the night pass ignores them), no
 * customer-set time, a rain-sensitive class (not rain-proof) and a window in season (window_key set).
 */
function dryWindowPref(info) {
  if (!info || info.mode !== 'true' || info.customer_time || info.class === 'proof' || !info.window_key) return null;
  const window = windowByKey(info.window_key);
  return window ? { startMin: window.startMin, endMin: window.endMin } : null;
}

/** The stop's hard time window as { startMin, endMin }: the customer's explicit one, else the dry window, else null. Throws when the read fails. */
async function loadPref(conn, row) {
  if (row.customer_id == null) return null;
  const prefs = await getCustomerSchedulingPreferences(row.customer_id, row.service_type, conn);
  const window = prefs && prefs.preferred_time_window;
  if (window) return { startMin: window.startMin, endMin: window.endMin };
  return dryWindowPref(prefs && prefs.dry_time);
}

/** Adds the preference to each movable stop; one that cannot be read becomes FIXED (fail closed). */
async function attachPrefs(conn, entries) {
  for (const entry of entries) {
    if (entry.why) continue;
    try {
      entry.pref = await loadPref(conn, entry.row);
    } catch (err) {
      entry.why = 'pref_unknown';
      logger.warn(`[day-replan] preference read failed for a stop (${err.message}); it stays fixed`);
    }
  }
}

function plannerStop(entry) {
  const { row } = entry;
  const start = hhmmToMin(row.window_start);
  const end = row.window_end ? hhmmToMin(row.window_end) : start + 60;
  return {
    id: row.id,
    lat: Number(row.lat),
    lng: Number(row.lng),
    slotStartMin: start,
    slotWidthMin: Math.max(0, end - start),
    workMin: workDuration(row),
    movable: !entry.why,
    pref: entry.pref || null,
  };
}

/** Every stop that keeps its hour and why; a fixed stop that already overlapped a block as booked carries a note. */
function fixedList(entries, grandfathered) {
  const grand = new Set(grandfathered || []);
  return entries.filter((e) => e.why).map((e) => ({
    id: e.row.id, why: e.why, ...(grand.has(e.row.id) ? { note: 'overlaps_block_as_booked' } : {}),
  }));
}

function planRow({ runId, techId, dateStr, entries, result }) {
  const best = result.best;
  return {
    run_id: runId,
    mode: 'shadow',
    technician_id: techId,
    service_date: dateStr,
    stop_count: entries.length,
    current_drive_min: result.current.driveMin,
    planned_drive_min: best ? best.driveMin : null,
    saved_min: result.savedMin,
    current_end_min: result.current.endMin,
    planned_end_min: best ? best.endMin : null,
    accepted: result.accepted,
    reason: result.reason,
    changes: JSON.stringify(result.changes.map((c) => ({ id: c.id, from: minToHhmm(c.fromMin), to: minToHhmm(c.toMin) }))),
    fixed: JSON.stringify(fixedList(entries, result.grandfathered)),
  };
}

async function planTechDay(conn, env, { dateStr, techId, rows, dayContext }, summary) {
  const reason = skipReason(rows);
  if (reason) {
    summary.skipped.push({ date: dateStr, technician_id: techId, reason, stops: rows.length });
    logger.info(`[day-replan] ${dateStr} tech ${techId}: skipped (${reason}, ${rows.length} stops)`);
    return;
  }
  const blocks = await loadBlocks(conn, dateStr, techId);
  if (blocksWholeDay(blocks, env.openMin, env.closeMin)) {
    summary.skipped.push({ date: dateStr, technician_id: techId, reason: 'DAY_BLOCKED', stops: rows.length });
    logger.info(`[day-replan] ${dateStr} tech ${techId}: skipped (DAY_BLOCKED, ${rows.length} stops)`);
    return;
  }
  const entries = rows.map((row) => ({ row, why: fixedReason(row, dayContext), pref: null }));
  await attachPrefs(conn, entries);
  const { staleReasons, baselines } = baselinesFor(rows);
  const result = planDay({
    stops: entries.map(plannerStop),
    origin: homeFromMap(env.techHomes, techId),
    departureMin: env.departureMin,
    legMin,
    options: {
      blockedHours: blockedHoursFor(dayContext.allRows, techId, env.techBlind),
      blocks,
      baselines,
      firstHour: env.openMin / 60,
      closeMin: env.closeMin,
    },
  });
  await conn(PLAN_TABLE).insert(planRow({ runId: env.runId, techId, dateStr, entries, result }));
  summary.days += 1;
  // Which current route the saving was measured against stays out of the table: it is in the returned summary and the log line.
  summary.plans.push({
    date: dateStr,
    technician_id: techId,
    baseline: result.current.baseline,
    baseline_drive_min: result.current.baselineDrives,
    stored_order_stale: staleReasons,
  });
  if (result.accepted) {
    summary.accepted += 1;
    summary.savedMin += result.savedMin;
    summary.changedVisits += result.changes.length;
  }
}

/**
 * The current routes to measure savings against, the way the app reads a day: the STORED order (route_order,
 * nulls after by window start; route-reorder-window-fit currentOrder) when it is a real plan, and always the
 * CLOCK order (promised-window order, ignoring stored numbers). Stored numbers with a null, a duplicate, a gap or
 * a later promise numbered ahead of an earlier one are leftover numbering and not a candidate (the same
 * staleOrderReasons the app and the 04:20 pass use; arrival-route.js falls back to clock order for them). The
 * planner simulates each and keeps the one that drives less; a tie keeps the stored order.
 */
function baselinesFor(rows) {
  const clock = { name: 'clock', order: promisedWindowOrder(rows).map((r) => r.id) };
  const staleReasons = staleOrderReasons(rows, rows, { futureDay: true });
  if (staleReasons.length) return { staleReasons, baselines: [clock] };
  return { staleReasons, baselines: [{ name: 'stored', order: currentOrder(rows).map((r) => r.id) }, clock] };
}

function groupByTech(rows) {
  const byTech = new Map();
  for (const row of rows) {
    if (!row.technician_id) continue;
    if (!byTech.has(row.technician_id)) byTech.set(row.technician_id, []);
    byTech.get(row.technician_id).push(row);
  }
  for (const [techId, techRows] of byTech) byTech.set(techId, currentOrder(techRows));
  return [...byTech.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

async function planDate(conn, env, dateStr, now, summary) {
  let rows;
  let sent24;
  try {
    rows = await loadDayStops(conn, dateStr);
    if (!rows || rows.length === 0) return;
    sent24 = await loadReminder24hSent(conn, rows.map((r) => r.id));
  } catch (err) {
    summary.failed.push({ date: dateStr, reason: 'LOAD_FAILED' });
    logger.error(`[day-replan] ${dateStr}: load failed (${err.message}); day skipped`);
    return;
  }
  const dayContext = { dateStr, now, allRows: rows, visitCounts: countBy(rows, 'visit_id'), customerCounts: countBy(rows, 'customer_id'), sent24 };
  for (const [techId, techRows] of groupByTech(rows)) {
    try {
      await planTechDay(conn, env, { dateStr, techId, rows: techRows, dayContext }, summary);
    } catch (err) {
      summary.failed.push({ date: dateStr, technician_id: techId, reason: 'PLAN_FAILED' });
      logger.error(`[day-replan] ${dateStr} tech ${techId}: plan failed (${err.message})`);
    }
  }
}

/**
 * @returns {Promise<{status: string, runId?: string, days?: number, accepted?: number, savedMin?: number,
 *   changedVisits?: number, skipped?: object[], failed?: object[]}>}
 */
async function runDayReplanIfEnabled({ now = new Date(), conn = db } = {}) {
  const mode = dayReplanMode();
  if (mode === 'off') return { status: 'off' };
  if (mode === 'apply') logger.info('[day-replan] GATE_DAY_REPLAN=true: apply is not built yet; running as shadow');
  const runId = crypto.randomUUID();
  const summary = { status: 'completed', runId, days: 0, accepted: 0, savedMin: 0, changedVisits: 0, plans: [], skipped: [], failed: [] };
  let env;
  try {
    // Same reader occupancy.js uses: tech-blind (another technician's row blocks an hour too) unless the gate is on.
    const { techScopedConfirmActive } = require('../scheduling/occupancy');
    // The night pass's own day bounds (candidate-slots.js DAY_OPEN / DAY_CLOSE, the after_hours rule), not a copy.
    const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
    env = {
      runId,
      techHomes: await loadTechStartPoints(conn),
      departureMin: await dayDepartureMinutes(conn),
      techBlind: !techScopedConfirmActive(),
      openMin: DAY_OPEN,
      closeMin: DAY_CLOSE,
    };
  } catch (err) {
    logger.error(`[day-replan] could not read start points or departure time (${err.message}); nothing planned`);
    return { ...summary, status: 'failed' };
  }
  for (const dateStr of horizonDates(now)) {
    await planDate(conn, env, dateStr, now, summary);
  }
  if (summary.failed.length) summary.status = 'completed_with_errors';
  const baselines = summary.plans.reduce((counts, p) => ({ ...counts, [p.baseline]: (counts[p.baseline] || 0) + 1 }), {});
  logger.info(`[day-replan] shadow run ${runId}: days=${summary.days} accepted=${summary.accepted} savedMin=${summary.savedMin} changedVisits=${summary.changedVisits} baselines=${JSON.stringify(baselines)} skipped=${summary.skipped.length} failed=${summary.failed.length}`);
  return summary;
}

module.exports = { runDayReplanIfEnabled, _internals: { baselinesFor, loadBlocks, blocksWholeDay, dryWindowPref, blockedHoursFor, fixedReason, skipReason, horizonDates, LOCK_HOURS } };
