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
 * Co-visit rows (isCoVisitPair) are merged into one fixed planner stop; after the search, the app's own
 * simulateArrivalRoute re-simulates the baseline and the best plan (./app-sim.js) and has the last word.
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
const { planDay, DEFAULT_OPTIONS } = require('./planner');
const { coVisitGroups, coVisitMinutes, appSimCheck, finalVerdict } = require('./app-sim');
const { applyAcceptedDay, reconcileApplied } = require('./apply');

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
  const { _internals, CUSTOMER_PREMISE_ALIASES } = require('../route-reorder');
  return dayStopsQuery(conn, {
    dateStr,
    excludeStatuses: EXCLUDED_STATUSES,
    select: [
      'scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.customer_id',
      'scheduled_services.visit_id', 'scheduled_services.status',
      'scheduled_services.window_start', 'scheduled_services.window_end', 'scheduled_services.time_window',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.service_type',
      'scheduled_services.is_recurring', 'scheduled_services.is_callback',
      // Identity and premise fields the co-visit helpers (isCoVisitPair) read, exactly as the 04:20 pass selects them.
      'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
      'scheduled_services.service_address_city', 'scheduled_services.service_address_zip',
      ...CUSTOMER_PREMISE_ALIASES,
      'scheduled_services.auto_dispatch_locked', 'scheduled_services.auto_dispatch_excluded',
      'scheduled_services.reservation_expires_at', 'scheduled_services.route_order', 'scheduled_services.created_at',
      // Apply mode's version hash reads these (the shadow plan ignores them).
      'scheduled_services.scheduled_date', 'scheduled_services.customer_confirmed', 'scheduled_services.updated_at',
      // The columns the move's CAS pins (apply mode): the stored location, not the guarded pin the planner reads.
      'scheduled_services.property_id', 'scheduled_services.service_address_state', 'scheduled_services.recurring_dispatch_due_date',
      conn.raw('scheduled_services.lat AS raw_lat'), conn.raw('scheduled_services.lng AS raw_lng'),
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

/** The date's live rows and the facts every tech-day plan of that date reads. Null when the date has no rows. Throws on a failed read. */
async function loadDayContext(conn, dateStr, now) {
  const rows = await loadDayStops(conn, dateStr);
  if (!rows || rows.length === 0) return null;
  const sent24 = await loadReminder24hSent(conn, rows.map((r) => r.id));
  return { dateStr, now, allRows: rows, visitCounts: countBy(rows, 'visit_id'), customerCounts: countBy(rows, 'customer_id'), sent24 };
}

/**
 * A version of the date's rows that changes when anything the plan or the write depends on changes (apply mode):
 * every row's id, date, window, technician, status, confirmation, staff locks, hold and last update.
 */
function versionHash(rows) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
  const parts = rows.map((r) => [
    String(r.id), iso(r.scheduled_date), r.window_start == null ? null : String(r.window_start), r.window_end == null ? null : String(r.window_end),
    r.technician_id == null ? null : String(r.technician_id), r.status, r.customer_confirmed === true, r.auto_dispatch_locked === true,
    r.auto_dispatch_excluded === true, iso(r.reservation_expires_at), iso(r.updated_at),
  ]).sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
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

/**
 * One planner stop for a group of entries: a lone row, or a co-visit group (same customer, property and window)
 * merged into ONE fixed stop charged the co-visit helpers' on-site minutes, so the search can never separate it.
 */
function plannerStop(group) {
  const lead = group[0].row;
  const start = hhmmToMin(lead.window_start);
  // A booked end is the window; with none, the visit holds its estimated duration (as rowHours and the app's occupancy do), else 60.
  const widthOf = (r) => Math.max(0, (r.window_end ? hhmmToMin(r.window_end) : start + (Number(r.estimated_duration_minutes) || 60)) - start);
  return {
    id: lead.id,
    lat: Number(lead.lat),
    lng: Number(lead.lng),
    slotStartMin: start,
    slotWidthMin: Math.max(...group.map((e) => widthOf(e.row))),
    // No booked end: a move keeps it open (the writer clears the end instead of persisting one) and a rollback restores NULL.
    openEnd: group.length === 1 && !lead.window_end,
    workMin: group.length > 1 ? coVisitMinutes(group.map((e) => e.row)) : workDuration(lead),
    movable: group.every((e) => !e.why),
    pref: group[0].pref || null,
  };
}

/** Every stop that keeps its hour and why; a fixed stop that already overlapped a block as booked carries a note. */
function fixedList(entries, grandfathered) {
  const grand = new Set(grandfathered || []);
  return entries.filter((e) => e.why).map((e) => ({
    id: e.row.id, why: e.why, ...(grand.has(e.row.id) ? { note: 'overlaps_block_as_booked' } : {}),
  }));
}

function planRow({ runId, techId, dateStr, entries, result, check, verdict, mode = 'shadow', planId = null }) {
  // The numbers are the app's own simulation (route-reorder-window-fit simulateArrivalRoute); the planner's stand in
  // only where that simulation gave none.
  const current = check.current || result.current;
  const planned = check.planned || (result.best && !check.current ? result.best : null);
  return {
    ...(planId ? { id: planId } : {}),
    run_id: runId,
    mode,
    technician_id: techId,
    service_date: dateStr,
    stop_count: entries.length,
    current_drive_min: current.driveMin,
    planned_drive_min: planned ? planned.driveMin : null,
    saved_min: verdict.savedMin,
    current_end_min: current.endMin,
    planned_end_min: planned ? planned.endMin : null,
    accepted: verdict.accepted,
    reason: verdict.reason,
    changes: JSON.stringify(verdict.accepted ? result.changes.map((c) => ({ id: c.id, from: minToHhmm(c.fromMin), to: minToHhmm(c.toMin) })) : []),
    fixed: JSON.stringify(fixedList(entries, result.grandfathered)),
  };
}

/**
 * Plans one tech-day. Returns { skip: {reason} } for a day that is not planned, else the plan with everything the
 * insert, the summary and (apply mode) the writer need.
 */
async function computeTechDay(conn, env, { dateStr, techId, rows, dayContext }) {
  const reason = skipReason(rows);
  if (reason) return { skip: { reason } };
  const blocks = await loadBlocks(conn, dateStr, techId);
  if (blocksWholeDay(blocks, env.openMin, env.closeMin)) return { skip: { reason: 'DAY_BLOCKED' } };
  const origin = homeFromMap(env.techHomes, techId);
  const entries = rows.map((row) => ({ row, why: fixedReason(row, dayContext), pref: null }));
  await attachPrefs(conn, entries);
  // Co-visit rows (one physical stop) are merged into one planner stop; the baselines name each group by its first row.
  const entryById = new Map(entries.map((e) => [String(e.row.id), e]));
  const rowGroups = coVisitGroups(promisedWindowOrder(rows));
  const groups = rowGroups.map((g) => g.map((r) => entryById.get(String(r.id))));
  const leaderOf = new Map(rowGroups.flatMap((g) => g.map((r) => [String(r.id), g[0].id])));
  const { staleReasons, baselines } = baselinesFor(rows);
  const stops = groups.map(plannerStop);
  const result = planDay({
    stops,
    origin,
    departureMin: env.departureMin,
    legMin,
    options: {
      blockedHours: blockedHoursFor(dayContext.allRows, techId, env.techBlind),
      blocks,
      baselines: baselines.map((b) => ({ ...b, order: [...new Set(b.order.map((id) => leaderOf.get(String(id))))] })),
      firstHour: env.openMin / 60,
      closeMin: env.closeMin,
    },
  });
  // The app's own simulator has the last word on the planner's best plan.
  const check = appSimCheck({
    groups: rowGroups, baselineOrder: result.current.order, best: result.best, origin,
    departureMin: env.departureMin, marginMin: DEFAULT_OPTIONS.marginMin,
  });
  const verdict = finalVerdict(result, check, DEFAULT_OPTIONS.minSavingMin);
  const members = new Map(rowGroups.map((g) => [String(g[0].id), g.map((r) => r.id)]));
  const finalResult = { ...result, grandfathered: result.grandfathered.flatMap((id) => members.get(String(id)) || [id]) };
  return {
    entries, rowGroups, stops, blocks, origin, staleReasons, check, verdict, dayContext,
    result: finalResult, plannerResult: result, hash: versionHash(dayContext.allRows),
  };
}

function skipDay(summary, { dateStr, techId, reason, stops }) {
  summary.skipped.push({ date: dateStr, technician_id: techId, reason, stops });
  logger.info(`[day-replan] ${dateStr} tech ${techId}: skipped (${reason}, ${stops} stops)`);
}

/** Apply mode: writes an accepted plan (./apply.js) and records the outcome on its plan row. Never throws. */
async function applyPlan(conn, env, { dateStr, techId, plan, planId, summary }) {
  const { deps } = env;
  const replan = async () => {
    const ctx = await loadDayContext(conn, dateStr, deps.now());
    const techRows = ctx && groupByTech(ctx.allRows).find(([id]) => String(id) === String(techId));
    return techRows ? computeTechDay(conn, env, { dateStr, techId, rows: techRows[1], dayContext: ctx }) : null;
  };
  let outcome;
  try {
    outcome = await applyAcceptedDay({ conn, env, dateStr, techId, plan, replan, deps });
  } catch (err) {
    logger.error(`[day-replan] ${dateStr} tech ${techId}: apply failed (${err.message})`);
    outcome = { status: 'failed', reason: `error:${String(err.code || 'unknown').slice(0, 40)}`, moved: 0 };
  }
  summary.apply.push({ date: dateStr, technician_id: techId, status: outcome.status, reason: outcome.reason, moved: outcome.moved });
  if (outcome.status === 'applied') summary.appliedVisits += outcome.moved;
  logger.info(`[day-replan] ${dateStr} tech ${techId}: apply ${outcome.status} (${outcome.reason}, ${outcome.moved} visits)`);
  try {
    await conn(PLAN_TABLE).where({ id: planId }).update({
      apply_status: outcome.status, apply_reason: outcome.reason, ...(outcome.status === 'applied' ? { applied_at: conn.fn.now() } : {}),
    });
  } catch (err) {
    logger.error(`[day-replan] ${dateStr} tech ${techId}: could not record the apply outcome (${err.message})`);
  }
  return outcome;
}

/** Returns true when apply mode attempted writes for the day (its rows may have changed). */
async function planTechDay(conn, env, { dateStr, techId, rows, dayContext }, summary) {
  const plan = await computeTechDay(conn, env, { dateStr, techId, rows, dayContext });
  if (plan.skip) {
    skipDay(summary, { dateStr, techId, reason: plan.skip.reason, stops: rows.length });
    return false;
  }
  const { entries, check, verdict, staleReasons, result, plannerResult } = plan;
  const apply = env.mode === 'apply';
  const planId = apply ? crypto.randomUUID() : null;
  await conn(PLAN_TABLE).insert(planRow({
    runId: env.runId, techId, dateStr, entries, result, check, verdict, ...(apply ? { mode: 'apply', planId } : {}),
  }));
  summary.days += 1;
  // Which current route the saving was measured against, and the planner's own figures, stay out of the table:
  // they are in the returned summary and the log line.
  summary.plans.push({
    date: dateStr,
    technician_id: techId,
    baseline: plannerResult.current.baseline,
    baseline_drive_min: plannerResult.current.baselineDrives,
    stored_order_stale: staleReasons,
    planner: { accepted: plannerResult.accepted, reason: plannerResult.reason, saved_min: plannerResult.savedMin },
    app_sim: check,
  });
  if (verdict.accepted) {
    summary.accepted += 1;
    summary.savedMin += verdict.savedMin;
    summary.changedVisits += result.changes.length;
  }
  if (!apply || !verdict.accepted) return false;
  const outcome = await applyPlan(conn, env, { dateStr, techId, plan, planId, summary });
  return outcome.status !== 'skipped';
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
  let dayContext;
  try {
    dayContext = await loadDayContext(conn, dateStr, now);
  } catch (err) {
    summary.failed.push({ date: dateStr, reason: 'LOAD_FAILED' });
    logger.error(`[day-replan] ${dateStr}: load failed (${err.message}); day skipped`);
    return;
  }
  if (!dayContext) return;
  let techDays = groupByTech(dayContext.allRows);
  for (const [techId, firstRows] of techDays) {
    try {
      // Apply mode: once a tech-day was written, the date's rows changed. The next technician plans from a fresh read
      // (their blocked hours and version hash must see the new hours).
      let rows = firstRows;
      if (dayContext.stale) {
        dayContext = (await loadDayContext(conn, dateStr, env.deps ? env.deps.now() : now)) || dayContext;
        techDays = groupByTech(dayContext.allRows);
        rows = (techDays.find(([id]) => String(id) === String(techId)) || [null, firstRows])[1];
      }
      if (await planTechDay(conn, env, { dateStr, techId, rows, dayContext }, summary)) dayContext.stale = true;
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
/** The run's environment: start points, the departure minute, the occupancy rule, the night pass's day bounds. */
async function buildEnv(conn, { apply, runId, deps }) {
  // Same reader occupancy.js uses: tech-blind (another technician's row blocks an hour too) unless the gate is on.
  const { techScopedConfirmActive } = require('../scheduling/occupancy');
  // The night pass's own day bounds (candidate-slots.js DAY_OPEN / DAY_CLOSE, the after_hours rule), not a copy.
  const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
  return {
    runId,
    mode: apply ? 'apply' : 'shadow',
    techHomes: await loadTechStartPoints(conn),
    departureMin: await dayDepartureMinutes(conn),
    techBlind: !techScopedConfirmActive(),
    openMin: DAY_OPEN,
    closeMin: DAY_CLOSE,
    deps: apply ? (deps || applyDeps()) : null,
  };
}

async function runDayReplanIfEnabled({ now = new Date(), conn = db, deps = null } = {}) {
  const mode = dayReplanMode();
  if (mode === 'off') return { status: 'off' };
  const apply = mode === 'apply';
  const runId = crypto.randomUUID();
  const summary = { status: 'completed', runId, days: 0, accepted: 0, savedMin: 0, changedVisits: 0, plans: [], skipped: [], failed: [] };
  // Apply mode only: what the writer did, per tech-day.
  if (apply) Object.assign(summary, { apply: [], appliedVisits: 0 });
  let env;
  try {
    env = await buildEnv(conn, { apply, runId, deps });
  } catch (err) {
    logger.error(`[day-replan] could not read start points or departure time (${err.message}); nothing planned`);
    return { ...summary, status: 'failed' };
  }
  // A day committed on an earlier run whose after-commit syncs did not finish is made to match again (apply and shadow alike).
  summary.repaired = await reconcileApplied(conn, () => env.deps || deps || applyDeps(), { today: etDateString(now) });
  for (const dateStr of horizonDates(now)) {
    await planDate(conn, env, dateStr, now, summary);
  }
  // A day the writer could not write (nothing changed) shows in the job's health.
  if (summary.failed.length || (summary.apply || []).some((a) => a.status === 'failed')) summary.status = 'completed_with_errors';
  const baselines = summary.plans.reduce((counts, p) => ({ ...counts, [p.baseline]: (counts[p.baseline] || 0) + 1 }), {});
  const byStatus = apply ? summary.apply.reduce((counts, a) => ({ ...counts, [a.status]: (counts[a.status] || 0) + 1 }), {}) : {};
  const applied = apply ? ` apply=${JSON.stringify(byStatus)} appliedVisits=${summary.appliedVisits}` : '';
  const recovered = summary.repaired ? ` repaired=${summary.repaired}` : '';
  logger.info(`[day-replan] ${env.mode} run ${runId}: days=${summary.days} accepted=${summary.accepted} savedMin=${summary.savedMin} changedVisits=${summary.changedVisits} baselines=${JSON.stringify(baselines)} skipped=${summary.skipped.length} failed=${summary.failed.length}${applied}${recovered}`);
  return summary;
}

/** Locks every live row of the date (in id order) before the day is read again: the scheduling fence's row locks. */
async function lockDayRows(conn, dateStr) {
  const { _internals } = require('../route-reorder');
  return conn('scheduled_services')
    .where('scheduled_date', dateStr)
    .whereNotIn('status', EXCLUDED_STATUSES)
    .whereRaw(_internals.LIVE_HOLD_SQL)
    .orderBy('id')
    .forUpdate()
    .select('id');
}

/** The writer's collaborators, loaded when apply mode runs (never in shadow or off, except the repair of a committed day). */
function applyDeps() {
  const nightWriter = require('../auto-dispatch/apply');
  const occupancy = require('../scheduling/occupancy');
  const afterMove = require('./after-move');
  const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
  return {
    fixedReason,
    rowHours,
    excludedStatuses: EXCLUDED_STATUSES,
    // The rebooker's own occupancy statuses for a move: a completed morning visit never blocks an afternoon one.
    occupancyExcludeStatuses: [...NOT_A_ROUTE_STOP_STATUSES, 'completed'],
    findConflicts: occupancy.findConflictingVisits,
    syncMovedReminders: nightWriter.syncMovedReminders,
    locationFields: nightWriter.LOCATION_FIELDS,
    // The scheduling fence the day is written under: date occupancy first, then the tech-days (the ordering contract).
    acquireOccupancyLock: occupancy.acquireOccupancyLock,
    lockTechDays: require('../scheduling/tech-day-lock').lockTechDays,
    lockDayRows,
    loadDayRows: loadDayStops,
    versionHash,
    loadBlocks,
    trackTokenExpiry: require('../track-token-expiry').scheduledServiceTrackTokenExpiry,
    // The rebooker's strict test for a night writer (a day the company is closed).
    isBlackoutDate: (dateStr) => require('../scheduling/blackout-dates').isBlackoutDate(dateStr, undefined, { strict: true }),
    afterMoveEffects: afterMove.afterMoveEffects,
    repairMoved: afterMove.repairMoved,
    now: () => new Date(),
  };
}

module.exports = { runDayReplanIfEnabled, _internals: { applyDeps, lockDayRows, plannerStop, versionHash, loadDayContext, computeTechDay, rowHours, baselinesFor, loadBlocks, blocksWholeDay, dryWindowPref, blockedHoursFor, fixedReason, skipReason, horizonDates, LOCK_HOURS } };
