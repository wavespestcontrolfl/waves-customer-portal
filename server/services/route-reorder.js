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

/**
 * Distance of an ordered stop sequence (HQ → stops → HQ) under the ONE shared
 * in-house model (route-optimizer's haversine legs through fallbackLegMetrics,
 * which is gate-consistent for meters). Savings decisions must compare BEFORE
 * and AFTER under the SAME model: optimizeRoute's own reported numbers mix
 * models (unoptimized = raw straight-line, optimized = Google road meters or
 * the road-factored fallback), so subtracting them is not a like-for-like
 * saving (codex round-2 P1). Google/fallback still choose the ORDER; this
 * model decides whether that order is worth writing. Coordless stops
 * contribute nothing on either side.
 */
function modelDistanceMeters(RouteOptimizer, orderedStops) {
  let prev = RouteOptimizer.HQ;
  let total = 0;
  for (const s of orderedStops) {
    const lat = parseFloat(s.lat);
    const lng = parseFloat(s.lng);
    if (!lat || !lng) continue;
    total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, lat, lng)).meters;
    prev = { lat, lng };
  }
  total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, RouteOptimizer.HQ.lat, RouteOptimizer.HQ.lng)).meters;
  return total;
}

/**
 * True when the proposed stop order contradicts the stops' window_start
 * chronology: any stop with a fixed window placed AFTER a stop whose window
 * starts later. Stops without a window_start are unconstrained. Ties are fine
 * (same window = same band, any order works).
 */
function violatesWindowChronology(orderedStops, sourceStops) {
  const windowById = new Map(sourceStops.map((s) => [s.id, s.window_start ? String(s.window_start).slice(0, 5) : null]));
  let lastWindow = null;
  for (const stop of orderedStops) {
    const win = windowById.get(stop.id);
    if (!win) continue;
    if (lastWindow != null && win < lastWindow) return true;
    lastWindow = win;
  }
  return false;
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
      const freeze = await loadReminderFreeze(db, stops.map((s) => s.id), now);
      if (freeze.failed) {
        // Fail closed AND fail loud — cannot prove no reminder went out for
        // this day, and an outage that silently disables the whole pass must
        // not leave the nightly run green (status + failed_count surface it
        // as an exception on the dispatch card).
        status = 'completed_with_errors';
        summary.failed.push({ date: dateStr, reason: 'REMINDER_STATUS_UNKNOWN', stops: stops.length });
        logger.error(`[route-reorder] ${dateStr}: reminder-freeze read failed — day frozen (fail closed)`);
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
          if (withCoords.length !== techStops.length) {
            // A stop without usable coordinates has no defensible position in
            // an autonomously computed order (optimizeRoute would push it to
            // the end with zero evidence that's driveable). An operator can
            // make that call on the board; this pass skips the tech-day.
            summary.skipped.push({ ...entryBase, reason: 'COORDLESS_STOPS', geocoded: withCoords.length });
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
          // SAME-MODEL before/after — never subtract Google road meters from a
          // straight-line baseline (codex round-2 P1).
          const beforeMeters = modelDistanceMeters(RouteOptimizer, ordered);
          const afterMeters = modelDistanceMeters(RouteOptimizer, result.orderedStops);
          const savedMeters = Math.max(0, beforeMeters - afterMeters);
          const metrics = {
            before_distance_meters: beforeMeters,
            after_distance_meters: afterMeters,
            optimizer_distance_meters: result.totalDistanceMeters || 0,
            after_duration_seconds: result.totalDurationSeconds || 0,
            saved_meters: savedMeters,
            source: result.source,
          };
          if (savedMeters < config.minSavingsMeters) {
            summary.skipped.push({ ...entryBase, reason: 'BELOW_MIN_SAVINGS', ...metrics });
            continue;
          }

          // Window chronology guard: the optimizer sees only coordinates, so a
          // pure-distance order could put a later fixed window before an
          // earlier one — an infeasible running order. If the optimized
          // sequence would violate the stops' window_start chronology, skip
          // the tech-day rather than write an order the tech cannot drive.
          if (violatesWindowChronology(result.orderedStops, techStops)) {
            summary.skipped.push({ ...entryBase, reason: 'WINDOW_ORDER_CONFLICT', ...metrics });
            continue;
          }

          // Same write as the trusted /optimize path (route_order = position),
          // but transactional AND revalidated at COMMIT time: the optimizer
          // call can take seconds, so inside the transaction the tech-day is
          // row-locked and re-read, and the write only proceeds when it still
          // matches the optimized snapshot — same membership (nothing added,
          // moved, cancelled, reassigned), same window_starts (the chronology
          // guard's inputs), and still unfrozen (the 15-min reminder cron may
          // have sent during the gap; freeze state is re-read on the trx).
          // Any drift rolls the whole tech-day back untouched.
          const stale = (msg) => Object.assign(new Error(msg), { code: 'STALE_TECH_DAY' });
          try {
            // SERIALIZABLE: FOR UPDATE locks existing rows but cannot stop a
            // phantom — a stop INSERTED/reassigned into this tech-day after
            // the membership SELECT. Serializable isolation predicate-locks
            // the read; a concurrent membership change aborts THIS transaction
            // with a serialization failure (40001), which is handled below as
            // a stale tech-day skip. Especially relevant while the 4:10
            // auto-dispatch run may still be applying moves under its own
            // advisory lock.
            await db.transaction(async (trx) => {
              // MEMBERSHIP FENCE (codex GitHub round P1): the writers that can
              // add/reassign a stop onto this tech-day already serialize on
              // the tech-scoped 'slot-reserve' advisory xact lock — the
              // rebooker's move transaction (rebooker.js kept-tech lock),
              // slot-reservation.js estimate reserves, and createSelfBooking
              // all take `hashtext('slot-reserve'), hashtext('tech:date')`.
              // Taking the SAME lock here (blocking, xact-scoped) before the
              // membership read fences those writers for the duration of the
              // reorder commit: they queue behind us; anything that committed
              // before we got the lock is visible to the re-read below.
              // Single lock per trx (one tech-day), taken before any row
              // locks — no ordering inversion with the date→tech contract in
              // scheduling/occupancy.js (tech-lock-only is the accepted
              // slot-reservation pattern). The IB assign/swap/move tools hold
              // the same fence via scheduling/tech-day-lock.js AND null the
              // stop's route_order on entry.
              //
              // Deliberately NOT fenced: pure INSERT paths (appointment
              // creation, recurring top-ups, estimate acceptance). No insert
              // path anywhere sets route_order — only optimizer paths write
              // it — and every consumer orders COALESCE(route_order, 999),
              // so a stop inserted after this commit appends AFTER the
              // ordered run: deterministic, never interleaved, identical to
              // a booking landing after the shipped manual /optimize, and
              // folded in by the next nightly pass while the day is in band.
              // The fence's real job is writers that can CARRY or CLOBBER a
              // non-null route_order (reassign/move/swap/rebooker/manual
              // reorder mid-run — the latter caught by the commit guard's
              // route_order re-check).
              await trx.raw(
                'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
                ['slot-reserve', `${techId}:${dateStr}`],
              );
              const live = await trx('scheduled_services')
                .where('scheduled_services.scheduled_date', dateStr)
                .where('scheduled_services.technician_id', techId)
                .whereNotIn('scheduled_services.status', EXCLUDE_STATUSES)
                // Lock the scheduled_services rows only — FOR UPDATE cannot
                // target the nullable side of the customers left join.
                .forUpdate('scheduled_services')
                .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
                .select('scheduled_services.id', 'scheduled_services.window_start',
                  'scheduled_services.route_order', ...guardedCoordSelects(trx));
              const num = (v) => (v == null || v === '' ? null : parseFloat(v));
              const snapshot = new Map(techStops.map((s) => [s.id, {
                window: s.window_start ? String(s.window_start).slice(0, 5) : null,
                routeOrder: s.route_order == null ? null : Number(s.route_order),
                lat: num(s.lat),
                lng: num(s.lng),
              }]));
              if (live.length !== techStops.length) throw stale('tech-day membership changed during the run');
              for (const row of live) {
                const snap = snapshot.get(row.id);
                if (!snap) throw stale(`stop ${row.id} joined the tech-day during the run`);
                const win = row.window_start ? String(row.window_start).slice(0, 5) : null;
                if (win !== snap.window) throw stale(`stop ${row.id} window changed during the run`);
                // route_order too: a dispatcher's manual reorder landing while
                // the optimizer ran must WIN — never overwrite the operator's
                // newer order with the autonomous one (codex round-3 P1).
                const ro = row.route_order == null ? null : Number(row.route_order);
                if (ro !== snap.routeOrder) throw stale(`stop ${row.id} route_order changed during the run`);
                // Effective (divergence-guarded) coordinates too — the order
                // was computed FOR those points; an address/coord change
                // mid-optimization invalidates it (codex round-12 P1).
                if (num(row.lat) !== snap.lat || num(row.lng) !== snap.lng) {
                  throw stale(`stop ${row.id} coordinates changed during the run`);
                }
              }
              // Freeze re-check at commit time (fail closed on unreadable).
              const commitNow = opts.now || new Date();
              const commitFreeze = await loadReminderFreeze(trx, techStops.map((s) => s.id), commitNow);
              if (commitFreeze.failed) {
                // Guard OUTAGE, not a superseded day — must fail LOUD like the
                // day-level read (recorded as a failure, degrades run status),
                // while the throw still rolls the write back.
                throw Object.assign(new Error('reminder status unreadable at commit'), { code: 'REMINDER_GUARD_OUTAGE' });
              }
              if (techStops.some((s) => commitFreeze.frozen.has(s.id))) throw stale('a 72h reminder was sent during the run');
              if (techStops.some((s) => withinFreezeClock(dateStr, s.window_start, commitNow))) {
                throw stale('day entered the 72h freeze window during the run');
              }
              for (let i = 0; i < result.orderedStops.length; i++) {
                const updated = await trx('scheduled_services')
                  .where({ id: result.orderedStops[i].id })
                  .where('scheduled_date', dateStr)
                  .where('technician_id', techId)
                  .whereNotIn('status', EXCLUDE_STATUSES)
                  .update({ route_order: i + 1 });
                if (updated !== 1) throw stale(`stop ${result.orderedStops[i].id} changed during the run`);
              }
            }, { isolationLevel: 'serializable' });
          } catch (writeErr) {
            if (writeErr.code === 'REMINDER_GUARD_OUTAGE') {
              // Fail closed AND loud: the reorder rolled back, and the outage
              // is a FAILURE (status + failed_count), never a quiet skip.
              status = 'completed_with_errors';
              summary.failed.push({ ...entryBase, reason: 'REMINDER_STATUS_UNKNOWN', error: writeErr.message });
              logger.error(`[route-reorder] ${dateStr} tech ${techId}: reminder-freeze read failed at commit — rolled back (fail closed)`);
              continue;
            }
            // 40001 = serialization_failure: a concurrent transaction touched
            // (or inserted into) this tech-day — same treatment as any other
            // superseded day: roll back, skip, never retry blindly.
            if (writeErr.code === '40001') {
              summary.skipped.push({ ...entryBase, reason: 'STALE_TECH_DAY', detail: 'serialization conflict — tech-day changed concurrently' });
              logger.warn(`[route-reorder] ${dateStr} tech ${techId}: serialization conflict — rolled back`);
              continue;
            }
            if (writeErr.code === 'STALE_TECH_DAY') {
              summary.skipped.push({ ...entryBase, reason: 'STALE_TECH_DAY', detail: writeErr.message });
              logger.warn(`[route-reorder] ${dateStr} tech ${techId}: superseded during the run — rolled back (${writeErr.message})`);
              continue;
            }
            throw writeErr;
          }
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
  // A lost ledger row means the promised audit record is missing — the run
  // must surface as an exception, never report green (codex round-13 P1).
  const finalStatus = ledger == null && status === 'completed' ? 'completed_with_errors' : status;
  return { status: finalStatus, ledgerId: ledger, applied: summary.applied.length, skipped: summary.skipped.length, failed: summary.failed.length };
}

/** Summarize the same night's auto-dispatch day-move run for the ledger
 *  (best-effort — a read failure must not lose the reorder ledger row). */
async function loadAutoDispatchSummary(today) {
  try {
    // THAT NIGHT'S CRON run specifically — a manual (possibly dry_run) run
    // started after 4:10 must not shadow it, or the ledger reports the wrong
    // (often zero) day-moves. triggered_by='cron' is stamped by audit.startRun
    // from the scheduler's runAutoDispatch({ triggeredBy: 'cron' }).
    // Latest cron run of ANY status — filtering to successful statuses let a
    // failed 4:10 run vanish from the ledger (run:null) or be shadowed by an
    // earlier successful run from the same day; a failed night must be
    // VISIBLE in the ledger, status preserved.
    const run = await db('auto_dispatch_runs')
      .where('triggered_by', 'cron')
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

/**
 * Ledger a tick that could not run because the shared writer lock was held
 * (e.g. the 4:10 auto-dispatch run still active at 4:20). Without this row
 * the night looks identical to a successful run in job health — a skipped
 * tick must be visible as skipped, never as success-with-no-output.
 */
async function recordSkippedTick(reason, now = new Date()) {
  const bandStart = etDateString(addETDays(now, 1));
  const bandEnd = etDateString(addETDays(now, TIER2_MIN_DAYS_OUT - 1));
  try {
    const [row] = await db('route_optimization_planner_runs')
      .insert({
        run_type: 'route_tiers_nightly',
        status: 'skipped',
        start_date: bandStart,
        end_date: bandEnd,
        technician_ids: JSON.stringify([]),
        service_types: JSON.stringify([]),
        constraints: JSON.stringify({ gate: 'GATE_ROUTE_REORDER' }),
        result: JSON.stringify({ skip_reason: reason, reorders: [], skips: [], failures: [] }),
        applied_count: 0,
        skipped_count: 0,
        failed_count: 0,
      })
      .returning(['id']);
    return (row && (row.id || row)) || null;
  } catch (e) {
    logger.error(`[route-reorder] skipped-tick ledger insert failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  runRouteReorder,
  runRouteReorderIfEnabled,
  recordSkippedTick,
  getRouteReorderConfig,
  _internals: { currentOrder, withinFreezeClock, violatesWindowChronology, modelDistanceMeters, loadAutoDispatchSummary, EXCLUDE_STATUSES, GOOGLE_WAYPOINT_CAP },
};
