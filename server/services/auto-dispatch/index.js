/**
 * Auto-Dispatch orchestrator.
 *
 * Daily (or manually triggered) pass over FUTURE recurring scheduled_services
 * that are outside the 14-day lock window. For each eligible visit it scores the
 * current placement against travel-aware candidate slots that honor customer
 * preferences, and — only when the gain clears the configured threshold —
 * records a recommendation (dry_run) or applies the move (apply).
 *
 * Conservative by construction: dry_run default, per-run change cap, stability
 * floor for already-moved visits, every evaluated/skipped service is audited,
 * and the move primitive is the same transactional rebooker staff use.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { getAutoDispatchConfig } = require('./config');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { isEligibleForAutoDispatch, isRecurringPlanActive } = require('./eligibility');
const { getCustomerSchedulingPreferences } = require('./preferences');
const { findValidCandidateSlots } = require('./candidate-slots');
const { scoreAppointmentPlacement } = require('./scoring');
const { applyAutoDispatchMove } = require('./apply');
const { toDateStr } = require('./dates');
const { ensureCustomerGeocoded } = require('../geocoder');
const audit = require('./audit');

// Self-heal MISSING_GEO: geocode the customer (fills customers.latitude/longitude
// from their address) and re-check eligibility, so a not-yet-geocoded recurring
// customer is optimized the first time the optimizer sees them rather than being
// silently skipped. Safe in both modes — it writes only customer coordinates,
// never scheduled_services. Returns { recheck, geocoded }.
async function geocodeAndRecheck(service, eligCtx) {
  try {
    const geo = await ensureCustomerGeocoded(service.customer_id);
    if (geo && geo.lat != null && geo.lng != null) {
      service.customer_latitude = geo.lat;
      service.customer_longitude = geo.lng;
      return { recheck: isEligibleForAutoDispatch(service, eligCtx), geocoded: true };
    }
  } catch (e) {
    logger.warn(`[auto-dispatch] geocode retry failed for customer ${service.customer_id}: ${e.message}`);
  }
  return {
    recheck: { eligible: false, reason_code: 'MISSING_GEO', reason_description: 'No usable geo (geocode attempt did not resolve the address)' },
    geocoded: false,
  };
}

async function loadCapabilityMap() {
  // Fail closed: the deactivated-tech HARD filter depends on this data. An empty
  // map would report every tech as 'missing' (a soft penalty only), so a read
  // failure could let apply mode move work onto a disabled tech. Throw → the run
  // aborts rather than optimizing without the hard constraint.
  const map = new Map();
  const rows = await db('technician_capabilities')
    .select('technician_id', 'service_category', 'capability_level', 'active');
  for (const r of rows) {
    map.set(`${r.technician_id}:${r.service_category}`, { level: r.capability_level, active: r.active !== false });
  }
  return map;
}

function makeCapabilityFn(map) {
  return (techId, category) => {
    if (!techId) return 'missing';
    const row = map.get(`${techId}:${category}`);
    if (!row) return 'missing';
    if (row.active === false) return 'deactivated';
    return row.level || 'qualified';
  };
}

function loadEligibleServices(lockBoundary, lookaheadEnd) {
  return db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    // is_recurring=true only — booster-month rows carry a recurring_parent_id but
    // is_recurring=false and must not be swept (see waveguard-existing-services.js).
    .where('scheduled_services.is_recurring', true)
    // Child occurrences only — the parent row is the generation template (see
    // eligibility PARENT_TEMPLATE_ROW).
    .whereNotNull('scheduled_services.recurring_parent_id')
    // Archiving a customer sets customers.deleted_at without clearing `active`,
    // so filter it here like the reminder/billing crons do.
    .whereNull('customers.deleted_at')
    .whereIn('scheduled_services.status', ['pending', 'confirmed'])
    .where('scheduled_services.scheduled_date', '>', lockBoundary)
    .where('scheduled_services.scheduled_date', '<=', lookaheadEnd)
    .where(function () {
      this.where('scheduled_services.auto_dispatch_locked', false)
        .orWhereNull('scheduled_services.auto_dispatch_locked');
    })
    .where(function () {
      this.where('scheduled_services.auto_dispatch_excluded', false)
        .orWhereNull('scheduled_services.auto_dispatch_excluded');
    })
    .select(
      'scheduled_services.*',
      'customers.active as customer_active',
      'customers.latitude as customer_latitude',
      'customers.longitude as customer_longitude',
      'customers.phone as customer_phone',
      'customers.first_name',
      'customers.last_name',
    )
    .orderBy('scheduled_services.scheduled_date', 'asc')
    .limit(5000);
}

async function runAutoDispatch(opts = {}) {
  const config = getAutoDispatchConfig(opts);
  const triggeredBy = opts.triggeredBy || 'cron';
  const nowDate = new Date();
  const today = etDateString(nowDate);
  const lockBoundary = etDateString(addETDays(nowDate, config.lockWindowDays));
  const lookaheadEnd = etDateString(addETDays(nowDate, config.lookaheadDays));
  const totals = { evaluated: 0, skipped: 0, recommended: 0, changed: 0, failed: 0 };

  const runId = await audit.startRun(config, triggeredBy);
  logger.info(`[auto-dispatch] run ${runId} mode=${config.mode} lock>${lockBoundary} lookahead<=${lookaheadEnd}`);

  let runStatus = 'completed';
  let runError = null;
  let geocodeAttempts = 0; // counts API attempts (success OR fail) — bounds the cap
  let geocoded = 0;        // successes only — for the run summary
  const geoCache = new Map(); // customer_id -> {lat,lng}|null, so repeat visits of one customer don't re-attempt

  try {
    const capMap = await loadCapabilityMap();
    const capabilityFor = makeCapabilityFn(capMap);
    const services = await loadEligibleServices(lockBoundary, lookaheadEnd);

    for (const service of services) {
      try {
        const eligCtx = { today, lockBoundary, lockWindowDays: config.lockWindowDays };
        let elig = isEligibleForAutoDispatch(service, eligCtx);
        let planCheck = null;

        // Self-heal a not-yet-geocoded customer, then re-check — but BEFORE the
        // plan-active gate (don't spend the geocode budget on a lapsed plan we'd
        // skip anyway) and deduped per customer (a customer's later visits would
        // just read the coords the first row saved, so they must not re-attempt).
        if (!elig.eligible && elig.reason_code === 'MISSING_GEO') {
          planCheck = await isRecurringPlanActive(service, db);
          if (!planCheck.active) {
            totals.skipped++;
            await audit.logDecision(runId, { action: 'skipped', service, reason_code: planCheck.reason_code, reason_description: planCheck.reason_description });
            continue;
          }
          const cust = service.customer_id;
          if (geoCache.has(cust)) {
            const cached = geoCache.get(cust);
            if (cached) {
              service.customer_latitude = cached.lat;
              service.customer_longitude = cached.lng;
              elig = isEligibleForAutoDispatch(service, eligCtx);
            }
          } else if (geocodeAttempts < config.maxGeocodesPerRun) {
            geocodeAttempts++; // one Google API call per NEW customer, success or not
            const res = await geocodeAndRecheck(service, eligCtx);
            geoCache.set(cust, res.geocoded ? { lat: service.customer_latitude, lng: service.customer_longitude } : null);
            if (res.geocoded) geocoded++;
            elig = res.recheck;
          }
        }

        if (!elig.eligible) {
          totals.skipped++;
          await audit.logDecision(runId, { action: 'skipped', service, reason_code: elig.reason_code, reason_description: elig.reason_description });
          continue;
        }

        // Plan-active gate (reuse the result if the geo self-heal already computed it).
        if (!planCheck) planCheck = await isRecurringPlanActive(service, db);
        if (!planCheck.active) {
          totals.skipped++;
          await audit.logDecision(runId, { action: 'skipped', service, reason_code: planCheck.reason_code, reason_description: planCheck.reason_description });
          continue;
        }

        const prefs = await getCustomerSchedulingPreferences(service.customer_id, service.service_type);
        if (config.requirePortalPreferences && !prefs.has_explicit_prefs) {
          totals.skipped++;
          await audit.logDecision(runId, { action: 'skipped', service, reason_code: 'NO_PORTAL_PREFERENCES', reason_description: 'Customer has no explicit scheduling preferences' });
          continue;
        }

        const ctx = {
          db,
          nowDate,
          lockWindowDays: config.lockWindowDays,
          lookaheadDays: config.lookaheadDays,
          dateToleranceDays: config.dateToleranceDays,
          capabilityFor,
          topN: 60,
        };
        const { current, candidates } = await findValidCandidateSlots(service, prefs, ctx);
        totals.evaluated++;

        const prefsSnapshot = prefs.raw_snapshot;
        if (!current || candidates.length === 0) {
          await audit.logDecision(runId, { action: 'no_change', service, reason_code: 'NO_VALID_SLOT', reason_description: 'No valid candidate slot found', prefsSnapshot, constraints: { blackout: prefs.blackout, lock_boundary: lockBoundary } });
          continue;
        }

        const scoreCtx = { currentTechnicianId: service.technician_id, changeCount: service.auto_dispatch_change_count || 0 };
        const currentScore = scoreAppointmentPlacement(current, prefs, scoreCtx);
        let best = null;
        let bestScore = null;
        for (const cand of candidates) {
          const sc = scoreAppointmentPlacement(cand, prefs, scoreCtx);
          if (!bestScore || sc.total_score > bestScore.total_score) { best = cand; bestScore = sc; }
        }

        const improvement = Math.round((bestScore.total_score - currentScore.total_score) * 100) / 100;
        // Already-moved visits must clear a higher bar (defeats the stability
        // penalty) so the job never thrashes the same customer day to day.
        const threshold = (service.auto_dispatch_change_count || 0) > 0
          ? Math.max(config.minScoreImprovement, config.removeStabilityFloor)
          : config.minScoreImprovement;

        const scores = { old: currentScore.total_score, new: bestScore.total_score, improvement };
        const routeMetrics = {
          current_detour_minutes: current.detour_minutes,
          candidate_detour_minutes: best.detour_minutes,
          candidate_total_drive_minutes: best.total_drive_minutes,
          stops_that_day: best.stops_that_day,
          current_score_breakdown: currentScore,
          candidate_score_breakdown: bestScore,
        };
        // apply preserves pending (restores it after the rebooker), so the
        // projected status must reflect that — don't claim a pending visit
        // would be confirmed in the dry-run/cap-held audit.
        const projectedStatus = service.status === 'pending' ? 'pending' : 'confirmed';
        const newPlacement = { date: best.date, window_start: best.start_time, window_end: best.end_time, technician_id: best.technician_id, status: projectedStatus };
        const constraints = {
          lock_boundary: lockBoundary,
          blackout: prefs.blackout,
          threshold,
          capability_level: best.capability_level,
          preferred_days: prefs.preferred_days,
          effective_time_window: prefs.effective_time_window && prefs.effective_time_window.key,
        };

        if (improvement < threshold) {
          await audit.logDecision(runId, { action: 'no_change', service, reason_code: 'NO_SCORE_IMPROVEMENT', reason_description: `Best improvement ${improvement} < threshold ${threshold}`, newPlacement, scores, prefsSnapshot, routeMetrics, constraints });
          continue;
        }

        if (config.mode === 'dry_run') {
          totals.recommended++;
          await audit.logDecision(runId, { action: 'recommended', service, reason_code: 'DRY_RUN_RECOMMENDATION', reason_description: `Would move (+${improvement})`, newPlacement, scores, prefsSnapshot, routeMetrics, constraints, appliedBy: 'auto_dispatch' });
          continue;
        }

        // apply mode
        if (totals.changed >= config.maxChangesPerRun) {
          totals.recommended++; // cap-held but still a found move — count it in the summary
          await audit.logDecision(runId, { action: 'recommended', service, reason_code: 'MAX_CHANGES_REACHED', reason_description: `Per-run change cap ${config.maxChangesPerRun} reached`, newPlacement, scores, prefsSnapshot, routeMetrics, constraints });
          continue;
        }
        try {
          const result = await applyAutoDispatchMove(service, best, runId, config);
          totals.changed++;
          await audit.logDecision(runId, {
            action: 'changed',
            service,
            reason_code: 'CHANGE_APPLIED',
            reason_description: `Moved (+${improvement})`,
            oldPlacement: { date: toDateStr(service.scheduled_date), window_start: service.window_start, window_end: service.window_end, technician_id: service.technician_id, status: result.pre_status },
            newPlacement: { ...newPlacement, status: result.post_status },
            scores,
            prefsSnapshot,
            routeMetrics,
            constraints,
            appliedBy: 'auto_dispatch',
          });
        } catch (applyErr) {
          totals.failed++;
          await audit.logDecision(runId, { action: 'failed', service, reason_code: 'ERROR', reason_description: applyErr.message, newPlacement, scores, prefsSnapshot, routeMetrics, constraints, error: applyErr.message });
        }
      } catch (perErr) {
        totals.failed++;
        logger.error(`[auto-dispatch] service ${service && service.id} failed: ${perErr.message}`);
        try {
          await audit.logDecision(runId, { action: 'failed', service, reason_code: 'ERROR', reason_description: perErr.message, error: perErr.message });
        } catch (_) { /* swallow */ }
      }
    }

    if (totals.failed > 0) runStatus = 'completed_with_errors';
  } catch (fatal) {
    runStatus = 'failed';
    runError = fatal.message;
    logger.error(`[auto-dispatch] run ${runId} fatal: ${fatal.message}`);
  }

  await audit.completeRun(runId, { status: runStatus, totals, error: runError });
  logger.info(`[auto-dispatch] run ${runId} ${runStatus} evaluated=${totals.evaluated} skipped=${totals.skipped} recommended=${totals.recommended} changed=${totals.changed} failed=${totals.failed} geocoded=${geocoded}/${geocodeAttempts}`);
  return { runId, status: runStatus, geocoded, geocode_attempts: geocodeAttempts, ...totals };
}

module.exports = { runAutoDispatch, loadEligibleServices, _internals: { loadCapabilityMap, makeCapabilityFn } };
