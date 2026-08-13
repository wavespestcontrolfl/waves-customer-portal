/**
 * ROUTE-TIERS nightly intra-day reorder pass (tier 3: 72h–7d band).
 *
 * For each tech-day in the band it loads the day's stops (shared day-stops
 * scaffold — the same query the trusted /optimize endpoints use), runs the
 * shared optimizeRoute, and — only when the distance saving clears the
 * configured floor — rewrites route_order transactionally using the exact
 * write the trusted admin /optimize path performs (route_order = position).
 * DAY-MOVES NEVER HAPPEN HERE: this pass only reorders stops within a day.
 *
 * Freeze rules (owner-approved, all HARD):
 *   - A day containing ANY frozen visit is skipped whole — frozen = the visit
 *     starts within 72 hours OR its 72-hour reminder is recorded as sent
 *     (appointment_reminders.reminder_72h_sent; the reminder is the hard gate
 *     because its SMS promises "{day} at {time}"). Unreadable reminder status
 *     freezes the run's every day (fail closed).
 *   - Today is never touched (band starts tomorrow; the 8am day-open plus the
 *     72h clock already exclude it — the band floor makes it structural).
 *   - >25 geocoded stops for one tech-day = Google Routes cap → the tech-day
 *     is SKIPPED AND LOGGED, never silently truncated.
 *
 * Zero customer communication: route_order is a dispatch-board ordering
 * column; no reminder, SMS, or email path reads it. Nothing here touches
 * dates, windows, statuses, or techs.
 *
 * Every run writes ONE ledger row to route_optimization_planner_runs
 * (run_type 'route_tiers_nightly') summarizing the reorders it applied/skipped
 * plus the same night's auto-dispatch day-move run (from auto_dispatch_runs /
 * auto_dispatch_audit_logs). IDs and dates only — never customer PII.
 *
 * Gates: GATE_ROUTE_REORDER (this pass) — separate from GATE_ROUTE_TIERS
 * (day-move eligibility inside auto-dispatch); both dark by default.
 */
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { dayStopsQuery, guardedCoordSelects } = require('./scheduling/day-stops');
const { toDateStr } = require('./auto-dispatch/dates');
const { loadReminderFreeze, FREEZE_HOURS, TIER2_MIN_DAYS_OUT } = require('./auto-dispatch/route-tiers');

const GOOGLE_WAYPOINT_CAP = 25;
// The reorder pass models future days, where en_route/on_site can't occur;
// excluding them anyway keeps the set correct even on a manual re-run.
// 'rescheduled' phantoms and 'skipped' visits are not real stops (mirrors
// the candidate-slots neighbor exclusion).
const EXCLUDE_STATUSES = ['cancelled', 'completed', 'skipped', 'rescheduled', 'en_route', 'on_site'];

function intEnv(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function getRouteReorderConfig(overrides = {}) {
  return {
    // Minimum distance saving (vs the CURRENT stop order) required to apply a
    // reorder. Default 805 m ≈ 0.5 mi — modest but non-trivial, so the board
    // isn't reshuffled nightly for noise. Distance is the threshold metric
    // because optimizeRoute reports unoptimized DISTANCE (not duration) for
    // the before-side; duration is still recorded in the ledger.
    minSavingsMeters: overrides.minSavingsMeters
      ?? intEnv('ROUTE_REORDER_MIN_SAVINGS_METERS', 805, { min: 0, max: 1000000 }),
    // Blast-radius cap on applied tech-day reorders per run (auto-dispatch's
    // change-cap idea applied to this pass's unit of change).
    maxAppliesPerRun: overrides.maxAppliesPerRun
      ?? intEnv('ROUTE_REORDER_MAX_APPLIES_PER_RUN', 20, { min: 0, max: 1000 }),
  };
}

/** Stops ordered as the board currently runs them: route_order asc (nulls
 *  last), then window start, then id — the "before" baseline savings are
 *  measured against. */
function currentOrder(stops) {
  return [...stops].sort((a, b) => {
    const ra = a.route_order == null ? Infinity : Number(a.route_order);
    const rb = b.route_order == null ? Infinity : Number(b.route_order);
    if (ra !== rb) return ra - rb;
    const wa = String(a.window_start || a.time_window || '');
    const wb = String(b.window_start || b.time_window || '');
    if (wa !== wb) return wa < wb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

/** True when the visit starts within FREEZE_HOURS of `now` (windowless visits
 *  freeze off the canonical 08:00 slot time the reminder system uses). */
function withinFreezeClock(dateStr, windowStart, now) {
  const start = String(windowStart || '08:00').slice(0, 5);
  const appt = parseETDateTime(`${dateStr}T${start}:00`);
  if (!appt || Number.isNaN(appt.getTime())) return true; // unparseable ⇒ frozen (fail closed)
  return appt.getTime() - now.getTime() < FREEZE_HOURS * 3600000;
}

async function runRouteReorder(opts = {}) {
  const config = getRouteReorderConfig(opts);
  const now = opts.now || new Date();
  const today = etDateString(now);
  const bandStart = etDateString(addETDays(now, 1));
  const bandEnd = etDateString(addETDays(now, TIER2_MIN_DAYS_OUT - 1)); // today+6: <7 days out
  const summary = {
    run_type: 'route_tiers_nightly',
    band: { start: bandStart, end: bandEnd },
    applied: [],
    skipped: [],
    failed: [],
  };
  const techIds = new Set();
  let status = 'completed';

  try {
    for (let offset = 1; offset < TIER2_MIN_DAYS_OUT; offset++) {
      const dateStr = etDateString(addETDays(now, offset));
      let stops;
      try {
        stops = await dayStopsQuery(db, {
          dateStr,
          excludeStatuses: EXCLUDE_STATUSES,
          select: [
            'scheduled_services.id', 'scheduled_services.technician_id',
            'scheduled_services.route_order', 'scheduled_services.window_start',
            'scheduled_services.time_window', 'scheduled_services.service_type',
            'scheduled_services.zone',
            ...guardedCoordSelects(db),
          ],
        });
      } catch (loadErr) {
        status = 'completed_with_errors';
        summary.failed.push({ date: dateStr, reason: 'LOAD_FAILED', error: loadErr.message });
        continue;
      }
      if (!stops || stops.length === 0) continue;

      // ── Day-level freeze: ANY frozen visit freezes the whole day. ──
      const clockFrozen = stops.some((s) => withinFreezeClock(dateStr, s.window_start, now));
      if (clockFrozen) {
        summary.skipped.push({ date: dateStr, reason: 'WITHIN_72H', stops: stops.length });
        continue;
      }
      const freeze = await loadReminderFreeze(db, stops.map((s) => s.id));
      if (freeze.failed) {
        // Fail closed — cannot prove no reminder went out for this day.
        summary.skipped.push({ date: dateStr, reason: 'REMINDER_STATUS_UNKNOWN', stops: stops.length });
        continue;
      }
      if (stops.some((s) => freeze.frozen.has(s.id))) {
        summary.skipped.push({ date: dateStr, reason: 'REMINDER_SENT_FROZEN', stops: stops.length });
        continue;
      }

      // ── Per tech-day reorder. Unassigned stops (no tech) have no route to
      // reorder within — they are left untouched and noted. ──
      const byTech = new Map();
      for (const s of stops) {
        if (!s.technician_id) continue;
        if (!byTech.has(s.technician_id)) byTech.set(s.technician_id, []);
        byTech.get(s.technician_id).push(s);
      }
      const unassigned = stops.filter((s) => !s.technician_id).length;
      if (unassigned > 0) {
        summary.skipped.push({ date: dateStr, reason: 'UNASSIGNED_STOPS_LEFT_IN_PLACE', stops: unassigned });
      }

      for (const [techId, techStops] of byTech) {
        techIds.add(techId);
        const entryBase = { date: dateStr, technician_id: techId, stops: techStops.length };
        try {
          const withCoords = techStops.filter((s) => parseFloat(s.lat) && parseFloat(s.lng));
          if (withCoords.length > GOOGLE_WAYPOINT_CAP) {
            // Google Routes cap — skip and SAY SO; never silently truncate.
            logger.warn(`[route-reorder] ${dateStr} tech ${techId}: ${withCoords.length} geocoded stops exceeds the ${GOOGLE_WAYPOINT_CAP}-waypoint cap — day skipped, not truncated`);
            summary.skipped.push({ ...entryBase, reason: 'OVER_WAYPOINT_CAP', geocoded: withCoords.length });
            continue;
          }
          if (withCoords.length < 2) {
            summary.skipped.push({ ...entryBase, reason: 'TOO_FEW_GEOCODED_STOPS', geocoded: withCoords.length });
            continue;
          }
          if (summary.applied.length >= config.maxAppliesPerRun) {
            summary.skipped.push({ ...entryBase, reason: 'MAX_APPLIES_REACHED' });
            continue;
          }

          const RouteOptimizer = require('./route-optimizer');
          // Baseline = the CURRENT running order, so "saved" means saved vs
          // what the tech would actually drive today, not vs an arbitrary
          // query order. ALL of the tech's stops go in (like the trusted
          // /optimize path) — optimizeRoute routes the geocoded ones and
          // appends coordless stops at the end, so the whole day gets a
          // consistent route_order sequence.
          const ordered = currentOrder(techStops);
          const result = await RouteOptimizer.optimizeRoute(
            ordered.map((s) => ({ id: s.id, lat: parseFloat(s.lat) || null, lng: parseFloat(s.lng) || null, serviceType: s.service_type })),
            { startLat: RouteOptimizer.HQ.lat, startLng: RouteOptimizer.HQ.lng, endAtStart: true, techId },
          );
          const savedMeters = Math.max(0, (result.unoptimizedDistanceMeters || 0) - (result.totalDistanceMeters || 0));
          const metrics = {
            before_distance_meters: result.unoptimizedDistanceMeters || 0,
            after_distance_meters: result.totalDistanceMeters || 0,
            after_duration_seconds: result.totalDurationSeconds || 0,
            saved_meters: savedMeters,
            source: result.source,
          };
          if (savedMeters < config.minSavingsMeters) {
            summary.skipped.push({ ...entryBase, reason: 'BELOW_MIN_SAVINGS', ...metrics });
            continue;
          }

          // Same write as the trusted /optimize path (route_order = position),
          // but transactional so a mid-write failure can't leave a half-
          // reordered day.
          await db.transaction(async (trx) => {
            for (let i = 0; i < result.orderedStops.length; i++) {
              await trx('scheduled_services')
                .where({ id: result.orderedStops[i].id })
                .update({ route_order: i + 1 });
            }
          });
          summary.applied.push({ ...entryBase, ...metrics });
          logger.info(`[route-reorder] ${dateStr} tech ${techId}: reordered ${withCoords.length} stops, saved ~${Math.round(savedMeters)} m (${metrics.source})`);
        } catch (techErr) {
          status = 'completed_with_errors';
          summary.failed.push({ ...entryBase, reason: 'ERROR', error: techErr.message });
          logger.error(`[route-reorder] ${dateStr} tech ${techId} failed: ${techErr.message}`);
        }
      }
    }
  } catch (fatal) {
    status = 'failed';
    summary.fatal_error = fatal.message;
    logger.error(`[route-reorder] run fatal: ${fatal.message}`);
  }

  // ── Ledger: one route_optimization_planner_runs row per nightly run. ──
  const ledger = await writeLedgerRow({ status, today, bandStart, bandEnd, techIds, config, summary });
  return { status, ledgerId: ledger, applied: summary.applied.length, skipped: summary.skipped.length, failed: summary.failed.length };
}

/** Summarize the same night's auto-dispatch day-move run for the ledger
 *  (best-effort — a read failure must not lose the reorder ledger row). */
async function loadAutoDispatchSummary(today) {
  try {
    const run = await db('auto_dispatch_runs')
      .orderBy('created_at', 'desc')
      .first('id', 'status', 'mode', 'total_evaluated', 'total_skipped', 'total_recommended', 'total_changed', 'total_failed', 'created_at');
    if (!run || toDateStr(run.created_at) !== today) return { run: null, moves: [] };
    const moves = await db('auto_dispatch_audit_logs')
      .where({ auto_dispatch_run_id: run.id, action: 'changed' })
      .select('scheduled_service_id', 'old_scheduled_date', 'new_scheduled_date', 'old_technician_id', 'new_technician_id', 'score_improvement')
      .limit(500);
    return {
      run: {
        id: run.id,
        status: run.status,
        mode: run.mode,
        evaluated: run.total_evaluated,
        skipped: run.total_skipped,
        recommended: run.total_recommended,
        changed: run.total_changed,
        failed: run.total_failed,
      },
      moves: moves.map((m) => ({
        scheduled_service_id: m.scheduled_service_id,
        from: toDateStr(m.old_scheduled_date),
        to: toDateStr(m.new_scheduled_date),
        old_technician_id: m.old_technician_id,
        new_technician_id: m.new_technician_id,
        improvement: m.score_improvement,
      })),
    };
  } catch (e) {
    return { run: null, moves: [], error: e.message };
  }
}

async function writeLedgerRow({ status, today, bandStart, bandEnd, techIds, config, summary }) {
  try {
    const autoDispatch = await loadAutoDispatchSummary(today);
    const [row] = await db('route_optimization_planner_runs')
      .insert({
        run_type: 'route_tiers_nightly',
        status,
        start_date: bandStart,
        end_date: bandEnd,
        technician_ids: JSON.stringify([...techIds]),
        service_types: JSON.stringify([]),
        constraints: JSON.stringify({
          gate: 'GATE_ROUTE_REORDER',
          min_savings_meters: config.minSavingsMeters,
          max_applies_per_run: config.maxAppliesPerRun,
          waypoint_cap: GOOGLE_WAYPOINT_CAP,
          freeze_hours: FREEZE_HOURS,
        }),
        result: JSON.stringify({
          reorders: summary.applied,
          skips: summary.skipped,
          failures: summary.failed,
          auto_dispatch: autoDispatch,
          ...(summary.fatal_error ? { fatal_error: summary.fatal_error } : {}),
        }),
        applied_count: summary.applied.length,
        skipped_count: summary.skipped.length,
        failed_count: summary.failed.length,
      })
      .returning(['id']);
    return (row && (row.id || row)) || null;
  } catch (e) {
    logger.error(`[route-reorder] ledger insert failed: ${e.message}`);
    return null;
  }
}

/** Cron entry — double-checks the gate so a stale scheduler can never run it. */
async function runRouteReorderIfEnabled() {
  if (!gateEnvValue('GATE_ROUTE_REORDER')) return { status: 'gate_off' };
  return runRouteReorder();
}

module.exports = {
  runRouteReorder,
  runRouteReorderIfEnabled,
  getRouteReorderConfig,
  _internals: { currentOrder, withinFreezeClock, loadAutoDispatchSummary, EXCLUDE_STATUSES, GOOGLE_WAYPOINT_CAP },
};
