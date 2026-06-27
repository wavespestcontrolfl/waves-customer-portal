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
const { applyAutoDispatchMove, revalidatePlacement } = require('./apply');
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

/**
 * Score a single eligible service's current placement against its best valid
 * candidate slot. PURE of side effects (DB reads only, no mutation, no audit) so
 * it can run twice: once in the pass-1 scoring sweep, and again in pass-2 right
 * before applying a move — re-scoring against the now-live schedule so an earlier
 * apply this run that already captured the gain isn't double-counted.
 *
 * Returns a discriminated result:
 *   { kind: 'no_change', reason_code, reason_description, audit }
 *   { kind: 'move', improvement, best, threshold, audit }
 * where `audit` carries the named fields audit.logDecision consumes.
 */
async function evaluatePlacement(service, prefs, ctx, config, lockBoundary) {
  const { current, candidates, drops } = await findValidCandidateSlots(service, prefs, ctx);
  const prefsSnapshot = prefs.raw_snapshot;

  if (!current || candidates.length === 0) {
    // When an explicit portal preference is the reason nothing survived, say so —
    // a HARD preferred-day/time filter dropping every feasible slot is the
    // override working as designed, not a failure to optimize.
    const prefDropped = !!drops && (drops.preferred_day > 0 || drops.preferred_time > 0);
    return {
      kind: 'no_change',
      reason_code: prefDropped ? 'NO_SLOT_MATCHING_PREFERENCE' : 'NO_VALID_SLOT',
      reason_description: prefDropped
        ? 'No candidate slot honored the customer\'s explicit day/time preference'
        : 'No valid candidate slot found',
      audit: { prefsSnapshot, constraints: { blackout: prefs.blackout, lock_boundary: lockBoundary, preferred_day_indexes: prefs.preferred_day_indexes, preferred_time_window: prefs.preferred_time_window, drops } },
    };
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
  // Already-moved visits must clear a higher bar (defeats the stability penalty)
  // so the job never thrashes the same customer day to day.
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
  // apply preserves pending (restores it after the rebooker), so the projected
  // status must reflect that — don't claim a pending visit would be confirmed.
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
  const auditCtx = { newPlacement, scores, prefsSnapshot, routeMetrics, constraints };

  if (improvement < threshold) {
    return { kind: 'no_change', reason_code: 'NO_SCORE_IMPROVEMENT', reason_description: `Best improvement ${improvement} < threshold ${threshold}`, audit: auditCtx };
  }
  return { kind: 'move', improvement, best, threshold, audit: auditCtx };
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
  // Apply-mode only: qualifying moves found in the pass-1 sweep, applied
  // best-improvement-first in pass 2 so the change cap funds the largest gains.
  const plannedMoves = [];

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
        const evalResult = await evaluatePlacement(service, prefs, ctx, config, lockBoundary);
        totals.evaluated++;

        if (evalResult.kind === 'no_change') {
          await audit.logDecision(runId, { action: 'no_change', service, reason_code: evalResult.reason_code, reason_description: evalResult.reason_description, ...evalResult.audit });
          continue;
        }

        // A qualifying move. In dry_run we recommend it immediately (order is
        // irrelevant — nothing is applied). In apply mode we COLLECT it and
        // decide what actually moves in a second best-improvement-first pass,
        // so the per-run change cap spends its budget on the highest-value
        // moves rather than whichever happened to come first by scheduled_date.
        if (config.mode === 'dry_run') {
          totals.recommended++;
          await audit.logDecision(runId, { action: 'recommended', service, reason_code: 'DRY_RUN_RECOMMENDATION', reason_description: `Would move (+${evalResult.improvement})`, ...evalResult.audit, appliedBy: 'auto_dispatch' });
          continue;
        }
        plannedMoves.push({ service, prefs, ctx, result: evalResult });
      } catch (perErr) {
        totals.failed++;
        logger.error(`[auto-dispatch] service ${service && service.id} failed: ${perErr.message}`);
        try {
          await audit.logDecision(runId, { action: 'failed', service, reason_code: 'ERROR', reason_description: perErr.message, error: perErr.message });
        } catch (_) { /* swallow */ }
      }
    }

    // ── Pass 2 (apply mode): apply the collected moves BEST-IMPROVEMENT-FIRST ──
    // The cap bounds how many moves a run applies, so it must fund the LARGEST
    // route gains: apply in descending pass-1 improvement instead of first-by-
    // scheduled_date. Each move is RE-EVALUATED ONCE against the now-live schedule
    // right before the apply/cap decision, so a move whose gain an earlier apply
    // already captured is dropped (no_change), the cap-held backlog reflects
    // current value, and a failed apply logs the actually-attempted placement.
    //
    // Cost is O(pending) — one re-evaluation per qualifying move, the same per-
    // service work the old inline loop did. We deliberately do NOT re-sort the
    // remaining moves by fresh improvement after every apply (full greedy): that
    // is O(pending × cap) slot-finder calls and can overrun the daily cron when
    // many visits qualify. The fixed pass-1 order is near-optimal for the moves
    // that actually apply under a binding cap — they are the top-ranked ones,
    // applied earliest, where the pass-1 estimate has diverged least from live.
    if (config.mode !== 'dry_run' && plannedMoves.length) {
      plannedMoves.sort((a, b) => b.result.improvement - a.result.improvement);
      for (const pm of plannedMoves) {
        let fresh = null;
        try {
          // Supersession check FIRST: re-read the scored row, because an operator
          // may have locked/excluded/cancelled or moved this visit during the run
          // window. Without it, a now-ineligible visit would be re-scored from the
          // stale pass-1 snapshot and could surface as a cap-held "valid move held"
          // recommendation. Reporting-only — the apply path re-asserts this
          // atomically; this just keeps the audit log honest. One point-read per
          // planned move, so the pass stays O(pending).
          const live = await revalidatePlacement(pm.service);
          if (!live.ok) {
            await audit.logDecision(runId, { action: 'no_change', service: pm.service, reason_code: 'SUPERSEDED_DURING_RUN', reason_description: `Superseded by an operator during the run — ${live.reason}`, ...pm.result.audit });
            continue;
          }

          fresh = await evaluatePlacement(pm.service, pm.prefs, pm.ctx, config, lockBoundary);
          if (fresh.kind !== 'move') {
            // Re-scoring against the live schedule no longer clears the bar (an
            // earlier apply this run captured the gain, or the row changed).
            await audit.logDecision(runId, { action: 'no_change', service: pm.service, reason_code: fresh.reason_code, reason_description: `No longer qualifies on live re-evaluation — ${fresh.reason_description}`, ...fresh.audit });
            continue;
          }

          if (totals.changed >= config.maxChangesPerRun) {
            totals.recommended++; // cap-held but still a valid move — count it in the summary
            await audit.logDecision(runId, { action: 'recommended', service: pm.service, reason_code: 'MAX_CHANGES_REACHED', reason_description: `Per-run change cap ${config.maxChangesPerRun} reached (valid move held, +${fresh.improvement})`, ...fresh.audit });
            continue;
          }

          const result = await applyAutoDispatchMove(pm.service, fresh.best, runId, config);
          totals.changed++;
          await audit.logDecision(runId, {
            action: 'changed',
            service: pm.service,
            reason_code: 'CHANGE_APPLIED',
            reason_description: `Moved (+${fresh.improvement})`,
            oldPlacement: { date: toDateStr(pm.service.scheduled_date), window_start: pm.service.window_start, window_end: pm.service.window_end, technician_id: pm.service.technician_id, status: result.pre_status },
            newPlacement: { ...fresh.audit.newPlacement, status: result.post_status },
            scores: fresh.audit.scores,
            prefsSnapshot: fresh.audit.prefsSnapshot,
            routeMetrics: fresh.audit.routeMetrics,
            constraints: fresh.audit.constraints,
            appliedBy: 'auto_dispatch',
          });
        } catch (applyErr) {
          totals.failed++;
          logger.error(`[auto-dispatch] apply failed for ${pm.service && pm.service.id}: ${applyErr.message}`);
          try {
            // Prefer the fresh (actually-attempted) placement in the failure row;
            // fall back to the pass-1 audit if the re-evaluation itself threw.
            await audit.logDecision(runId, { action: 'failed', service: pm.service, reason_code: 'ERROR', reason_description: applyErr.message, ...((fresh && fresh.audit) || pm.result.audit), error: applyErr.message });
          } catch (_) { /* swallow */ }
        }
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
