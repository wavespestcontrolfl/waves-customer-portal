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
const { findValidCandidateSlots, SCORE_CAP } = require('./candidate-slots');
const { scoreAppointmentPlacement } = require('./scoring');
const {
  applyAutoDispatchMove, revalidatePlacement, unitMoveSize, previewGroupMove,
} = require('./apply');
const { toDateStr, shiftDateStr } = require('./dates');
const { stampedAddressDiverges } = require('../stamped-address');
const { ensureCustomerGeocoded } = require('../geocoder');
const audit = require('./audit');
const routeTiers = require('./route-tiers');
const flexTier = require('./flex-tier');

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

// Which model scored a placement (ids/numbers-only audit tag, GATE_AUTO_DISPATCH_SHARED_MODEL
// dispatch backlog item 3) — a tiny named helper rather than an inline
// `||` chain so it doesn't add its own branches to evaluatePlacement's
// complexity count.
function modelLabelFor(...placements) {
  for (const p of placements) {
    if (p && p.model) return p.model;
  }
  return 'legacy';
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

function loadEligibleServices(lockBoundary, lookaheadEnd, today) {
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
    .where(function () {
      this.where('scheduled_services.scheduled_date', '>', lockBoundary)
        .orWhere(function () {
          this.whereNotNull('scheduled_services.recurring_dispatch_due_date')
            .whereNull('scheduled_services.window_start')
            .where('scheduled_services.recurring_dispatch_due_date', '>=', shiftDateStr(today, -3));
        });
    })
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
      'customers.address_line1 as customer_address_line1',
      'customers.city as customer_city',
      'customers.zip as customer_zip',
      'customers.latitude as customer_latitude',
      'customers.longitude as customer_longitude',
      'customers.phone as customer_phone',
      'customers.first_name',
      'customers.last_name',
    )
    .orderByRaw('(scheduled_services.recurring_dispatch_due_date IS NOT NULL AND scheduled_services.window_start IS NULL) DESC')
    .orderBy('scheduled_services.scheduled_date', 'asc')
    .limit(5000);
}

// Whether an improvement clears the move bar for THIS visit — the ONE rule
// governing both the top-level move/no_change decision on `best` and which
// candidates may ever reach apply.js as a SLOT_TAKEN fallback candidate
// (GATE_AUTO_DISPATCH_SHARED_MODEL). An unplaced recurring due-date visit
// (a due date with no window_start yet) accepts ANY placement over none;
// every other visit needs its own improvement over the current placement to
// clear `threshold`. Factored out (Codex pre-push P1) so a fallback
// candidate is filtered by EXACTLY the rule `best` was — a below-threshold,
// or literally worse-than-current, placement must never reach apply.js.
function visitClearsMoveThreshold(service, improvement, threshold) {
  if (service.recurring_dispatch_due_date && !service.window_start) return true;
  return improvement >= threshold;
}

/**
 * The audit fields (`newPlacement`, `scores`, `routeMetrics`, `constraints`)
 * and rounded improvement for ONE candidate scored against ONE current
 * placement. Pulled out of evaluatePlacement (Codex pre-push P1) so
 * runAutoDispatch's pass-2 can re-run the SAME construction for whichever
 * candidate apply.js actually applied — a SLOT_TAKEN fallback can land on a
 * DIFFERENT candidate than `best`, and the audit must describe the one that
 * actually moved.
 */
function buildPlacementAudit({
  current, currentScore, candidate, candidateScore, service, prefs, lockBoundary, ctx, threshold,
}) {
  const improvement = Math.round((candidateScore.total_score - currentScore.total_score) * 100) / 100;
  const scores = { old: currentScore.total_score, new: candidateScore.total_score, improvement };
  const routeMetrics = {
    current_detour_minutes: current.detour_minutes,
    candidate_detour_minutes: candidate.detour_minutes,
    candidate_total_drive_minutes: candidate.total_drive_minutes,
    stops_that_day: candidate.stops_that_day,
    current_score_breakdown: currentScore,
    candidate_score_breakdown: candidateScore,
    // Which model scored this visit (ids/numbers only) — GATE_AUTO_DISPATCH_SHARED_MODEL,
    // dispatch backlog item 3: a dry-run night's audit rows must say which
    // arithmetic produced the numbers being reviewed.
    model: modelLabelFor(current, candidate),
  };
  // apply preserves pending (restores it after the rebooker), so the projected
  // status must reflect that — don't claim a pending visit would be confirmed.
  const projectedStatus = service.status === 'pending' ? 'pending' : 'confirmed';
  const newPlacement = { date: candidate.date, window_start: candidate.start_time, window_end: candidate.end_time, technician_id: candidate.technician_id, status: projectedStatus };
  const constraints = {
    lock_boundary: lockBoundary,
    blackout: prefs.blackout,
    threshold,
    capability_level: candidate.capability_level,
    preferred_days: prefs.preferred_days,
    effective_time_window: prefs.effective_time_window && prefs.effective_time_window.key,
    ...(ctx.tierMeta ? { route_tiers: ctx.tierMeta } : {}),
  };
  return {
    improvement, newPlacement, scores, routeMetrics, constraints,
  };
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
 *   { kind: 'move', improvement, best, rankedCandidates, current, currentScore, threshold, audit }
 * where `audit` carries the named fields audit.logDecision consumes, and
 * `current`/`currentScore` let a caller re-audit a different (fallback)
 * candidate later with buildPlacementAudit.
 */
// findValidCandidateSlots, failing closed where the shared model cannot
// establish what it would compare (GATE_AUTO_DISPATCH_SHARED_MODEL — an
// unreadable visit group, Codex r3 P1; no single technician for an
// unassigned visit's day, r7): the visit is not evaluated at all —
// `skipped` carries the ids-only reason — rather than scored on a guess.
// Any other error propagates as before.
async function findSlotsOrSkip(service, prefs, ctx) {
  try {
    return await findValidCandidateSlots(service, prefs, ctx);
  } catch (err) {
    if (err && err.skipEvaluation === true) {
      return { current: null, candidates: [], drops: null, skipped: { code: err.code, description: `${err.message} — not evaluated` } };
    }
    throw err;
  }
}

// Why no candidate survived. When an explicit portal preference is the
// reason, say so — a HARD preferred-day/time filter dropping every feasible
// slot is the override working as designed, not a failure to optimize.
function noSlotReason(drops, skipped) {
  if (skipped) return skipped;
  const prefDropped = !!drops && (drops.preferred_day > 0 || drops.preferred_time > 0);
  return prefDropped
    ? { code: 'NO_SLOT_MATCHING_PREFERENCE', description: 'No candidate slot honored the customer\'s explicit day/time preference' }
    : { code: 'NO_VALID_SLOT', description: 'No valid candidate slot found' };
}

async function evaluatePlacement(service, prefs, ctx, config, lockBoundary) {
  const {
    current, candidates, drops, skipped,
  } = await findSlotsOrSkip(service, prefs, ctx);
  const prefsSnapshot = prefs.raw_snapshot;

  if (!current || candidates.length === 0) {
    const reason = noSlotReason(drops, skipped);
    return {
      kind: 'no_change',
      reason_code: reason.code,
      reason_description: reason.description,
      audit: { prefsSnapshot, constraints: { blackout: prefs.blackout, lock_boundary: lockBoundary, preferred_day_indexes: prefs.preferred_day_indexes, preferred_time_window: prefs.preferred_time_window, drops, model: modelLabelFor(current), ...(ctx.tierMeta ? { route_tiers: ctx.tierMeta } : {}) } },
    };
  }

  const scoreCtx = { currentTechnicianId: service.technician_id, changeCount: service.auto_dispatch_change_count || 0 };
  const currentScore = scoreAppointmentPlacement(current, prefs, scoreCtx);
  let best = null;
  let bestScore = null;
  // Every candidate's score, in encounter order — kept (not just the single
  // best) so a SLOT_TAKEN apply-time refusal (GATE_AUTO_DISPATCH_SHARED_MODEL)
  // can fall back to the next-best still-scored candidate rather than giving
  // up. Does not change which candidate wins `best`/`bestScore` below (still
  // the first strictly-greater score encountered) — this is additional
  // bookkeeping only.
  const scored = [];
  for (const cand of candidates) {
    const sc = scoreAppointmentPlacement(cand, prefs, scoreCtx);
    scored.push({ cand, sc });
    if (!bestScore || sc.total_score > bestScore.total_score) { best = cand; bestScore = sc; }
  }

  // Already-moved visits must clear a higher bar (defeats the stability penalty)
  // so the job never thrashes the same customer day to day.
  const threshold = (service.auto_dispatch_change_count || 0) > 0
    ? Math.max(config.minScoreImprovement, config.removeStabilityFloor)
    : config.minScoreImprovement;

  const {
    improvement, newPlacement, scores, routeMetrics, constraints,
  } = buildPlacementAudit({
    current, currentScore, candidate: best, candidateScore: bestScore, service, prefs, lockBoundary, ctx, threshold,
  });

  // Stable sort (Node/V8 Array#sort is stable): ties keep candidates' original
  // encounter order, matching the strict `>` tie-break above — rankedCandidates[0]
  // is always the SAME object as `best` whenever `best` itself qualifies.
  // Filtered to candidates that themselves clear the SAME move threshold
  // (Codex pre-push P1): apply.js's SLOT_TAKEN fallback must never be
  // offered a placement that would not have qualified as `best` on its own.
  // Capped by TOTAL SCORE (Codex r1): with the gate on, findValidCandidateSlots
  // returns every survivor and each was scored above before this cap.
  const rankedCandidates = scored.slice()
    .sort((a, b) => b.sc.total_score - a.sc.total_score)
    .filter((s) => visitClearsMoveThreshold(
      service, Math.round((s.sc.total_score - currentScore.total_score) * 100) / 100, threshold,
    ))
    .slice(0, ctx.scoreCap || SCORE_CAP)
    .map((s) => s.cand);

  const auditCtx = {
    newPlacement, scores, prefsSnapshot, routeMetrics, constraints,
  };

  if (!visitClearsMoveThreshold(service, improvement, threshold)) {
    return { kind: 'no_change', reason_code: 'NO_SCORE_IMPROVEMENT', reason_description: `Best improvement ${improvement} < threshold ${threshold}`, audit: auditCtx };
  }
  return {
    kind: 'move', improvement, best, rankedCandidates, current, currentScore, threshold, audit: auditCtx,
  };
}

// The audit fields for whichever candidate apply.js ACTUALLY applied
// (`result.applied`, which may be a SLOT_TAKEN fallback rather than
// `fresh.best`) — pulled out of runAutoDispatch's pass-2 (Codex pre-push P1)
// so this lookup/rescore/rebuild doesn't add its own branches to that
// function's already-large complexity count. Falls back to `fresh.best`
// when the applier didn't report `applied` (a plain mock, or a version of
// apply.js that predates this lane), so the common case is unaffected. A
// candidate a post-SLOT_TAKEN re-evaluation offered (`result.evaluation`) is
// scored against THAT evaluation's current placement and threshold — the
// comparison that authorized the move (Codex pre-push P1).
function buildAppliedPlacementAudit(fresh, service, prefs, ctx, lockBoundary, result) {
  const evaluation = result.evaluation || fresh;
  const appliedCandidate = result.applied || fresh.best;
  const scoreCtx = { currentTechnicianId: service.technician_id, changeCount: service.auto_dispatch_change_count || 0 };
  const appliedScore = scoreAppointmentPlacement(appliedCandidate, prefs, scoreCtx);
  const built = buildPlacementAudit({
    current: evaluation.current, currentScore: evaluation.currentScore, candidate: appliedCandidate, candidateScore: appliedScore,
    service, prefs, lockBoundary, ctx, threshold: evaluation.threshold,
  });
  // attempts (ids/numbers only): how many candidates apply.js tried before
  // this one landed — 1 when the first attempt succeeded, or when the
  // applier didn't report it (a plain mock, or a pre-lane version).
  return { ...built, attempts: result.attempts || 1 };
}

// The audit fields for a FAILED apply: the candidate apply.js tried LAST
// (Codex r1 — a SLOT_TAKEN fallback can fail on a different candidate than
// `fresh.best`), else the fresh placement, else the pass-1 audit when the
// re-evaluation itself threw. apply.js attaches `lastAttempted` /
// `attemptsTried` / `lastEvaluation` only under
// GATE_AUTO_DISPATCH_SHARED_MODEL, so gate off the row is unchanged. The
// comparison is the one that authorized the last attempt: a post-SLOT_TAKEN
// re-evaluation's (`lastEvaluation`), else `fresh` (Codex pre-push P1).
function failedPlacementAudit(fresh, pm, lockBoundary, applyErr) {
  const attempted = fresh && fresh.kind === 'move' && applyErr && applyErr.lastAttempted;
  if (!attempted) return (fresh && fresh.audit) || pm.result.audit;
  const evaluation = applyErr.lastEvaluation || fresh;
  const { service, prefs, ctx } = pm;
  const scoreCtx = { currentTechnicianId: service.technician_id, changeCount: service.auto_dispatch_change_count || 0 };
  const attemptedScore = scoreAppointmentPlacement(applyErr.lastAttempted, prefs, scoreCtx);
  const built = buildPlacementAudit({
    current: evaluation.current, currentScore: evaluation.currentScore, candidate: applyErr.lastAttempted, candidateScore: attemptedScore,
    service, prefs, lockBoundary, ctx, threshold: evaluation.threshold,
  });
  return {
    newPlacement: built.newPlacement,
    scores: built.scores,
    prefsSnapshot: prefs.raw_snapshot,
    routeMetrics: { ...built.routeMetrics, attempts: applyErr.attemptsTried || 1 },
    constraints: built.constraints,
  };
}

// The `scheduled_date` floor loadEligibleServices() queries with. ROUTE-TIERS
// loads from its own tier-2 floor (today+6 — the days-out ladder decides the
// rest per visit); FLEX-TIER loads from tomorrow on — its precise cutoff is
// the 73h freeze, checked per visit against the live reminder row, so a
// coarser SQL floor here only costs a few extra unfrozen-but-too-close reads,
// never misses one; legacy loads from its own flat lock boundary. Byte for
// byte the old behavior when neither gate is on.
function resolveLoadBoundary(guardMode, nowDate, lockBoundary, today) {
  if (guardMode === 'tiers') return etDateString(addETDays(nowDate, routeTiers.TIER2_MIN_DAYS_OUT - 1));
  if (guardMode === 'flex') return today;
  return lockBoundary;
}

// eligibility.js's ctx for the active guard mode — a plain object build, kept
// out of runAutoDispatch so its ternaries don't count against that
// function's complexity.
function buildEligCtx(guardMode, today, lockBoundary, lockWindowDays) {
  const base = { today, lockBoundary, lockWindowDays };
  if (guardMode === 'tiers') return { ...base, routeTiers: { enabled: true, today } };
  if (guardMode === 'flex') return { ...base, flexTier: { enabled: true } };
  return base;
}

// Bulk per-run guard context for the active mode. ROUTE-TIERS needs the
// reminder freeze (its 72.25h band) + drift-anchor evidence; FLEX-TIER needs
// the reminder freeze (its own, tighter 73h band) + the SAME drift-anchor
// evidence (its ±5 days are measured from the durable original date too) +
// each visit's series neighbors. Both FAIL CLOSED: a failed read must
// freeze/guard-unknown every visit rather than move without the check.
// Pulled out of runAutoDispatch to keep its complexity budget (see
// buildPlacementAudit above). Returns { reminderFreeze, anchorMap, neighborMap, degraded }.
async function loadGuardContext(guardMode, services, nowDate) {
  if (guardMode === 'legacy') {
    return {
      reminderFreeze: null, anchorMap: null, neighborMap: null, degraded: false,
    };
  }
  const ids = services.map((s) => s.id);
  const freezeHours = guardMode === 'flex' ? flexTier.FLEX_TIER_FREEZE_HOURS : routeTiers.REMINDER_SENDABLE_HOURS;
  const reminderFreeze = await routeTiers.loadReminderFreeze(db, ids, nowDate, freezeHours);
  // ALL ids, not just change_count>0 — the durable move records (not the
  // best-effort stamp) decide whether a visit has spent drift budget.
  const anchorMap = await routeTiers.loadAnchorMap(db, ids);
  const neighborMap = guardMode === 'flex' ? await flexTier.loadSeriesNeighbors(db, services) : null;
  const degraded = (reminderFreeze && reminderFreeze.failed)
    || anchorMap === null
    || (guardMode === 'flex' && neighborMap === null);
  if (degraded) {
    // Fail closed AND fail loud: the per-visit skips keep every visit safe,
    // but an outage that silently disables all day-moves must not leave cron
    // health green (the run completes as completed_with_errors).
    logger.error(`[auto-dispatch] ${guardMode} guard read failed (reminder freeze, anchor${guardMode === 'flex' ? ' or series-neighbor' : ''} evidence) — all day-moves frozen this run`);
  }
  return {
    reminderFreeze, anchorMap, neighborMap, degraded,
  };
}

// FLEX-TIER window for one visit (past the shared reminder freeze), shared
// by pass 1 (the bulk-read neighbor map and anchor) and the apply-time
// recheck (a fresh neighbor read, the pass-1 anchor — durable evidence).
// Reminder evidence only ever ADDS a freeze (a sent flag, or the sender's
// own claimable band read off appointment_reminders ROWS) — a visit with NO
// reminder row at all is invisible to that check, and the flex ctx skips
// eligibility.js's days-out lock entirely, so the 73h cutoff is ALSO
// enforced directly from the visit's own canonical arrival (Codex pre-push
// P1; an unreadable arrival throws, and the run records it). The ±5-day
// window is anchored to the durable original date (route-tiers'
// resolveAnchor), so it is never reset by an earlier move. A null neighbor
// map is a failed read — skip.degraded, so the caller folds it into the
// run's health (Codex #4995 r6 P2); a visit merely missing from the map is
// refused on its own.
async function flexWindowFor(service, {
  neighborMap, anchor, today, nowDate,
}) {
  const skip = (code, description, degraded) => ({ window: null, meta: null, skip: { code, description, ...(degraded ? { degraded } : {}) } });
  if (await flexTier.ownScheduleFrozen(db, service, nowDate)) {
    return skip('WITHIN_73H', '73-hour cutoff reached on the visit\'s own schedule — frozen (independent of reminder evidence)');
  }
  if (!neighborMap) return skip('SERIES_NEIGHBORS_UNKNOWN', 'Series occurrence order could not be read — no move (fail closed)', true);
  const neighbors = neighborMap.get(service.id);
  if (!neighbors) return skip('SERIES_NEIGHBORS_UNKNOWN', 'Visit missing from its own series read — no move (fail closed)');
  if (!anchor) return skip('DRIFT_ANCHOR_UNKNOWN', 'Recurrence anchor could not be derived — no move (fail closed)');
  const window = flexTier.flexTierMoveWindow({ origDate: service.scheduled_date, anchorDate: anchor, today, neighbors });
  if (!window) {
    return skip('FLEX_WINDOW_EXHAUSTED', `No legal candidate dates left within ±${flexTier.FLEX_TIER_RADIUS_DAYS} days of the visit's date and its original date ${anchor}, clamped by the series' adjacent occurrence`);
  }
  return {
    window, meta: {
      mode: 'flex', radius_days: flexTier.FLEX_TIER_RADIUS_DAYS, anchor, neighbors, window,
    }, skip: null,
  };
}

// The day-move window for ONE visit under the active guard mode — pulled out
// of runAutoDispatch's per-service loop (same complexity-budget reason as
// above) so GATE_AUTO_DISPATCH_FLEX_TIER's own branches never add to that
// loop. `today` is the ET date the caller wants this decided against (the
// run's own `today` on pass 1); `nowDate` is the matching absolute clock
// (flex mode's own-schedule freeze needs hours, not whole days). Returns
// { window, meta, skip }; `skip` is {code, description} when the visit
// cannot move this run/window.
async function resolveDayMoveWindow(guardMode, service, guardCtx, today, nowDate) {
  if (guardMode === 'legacy') return { window: null, meta: null, skip: null };
  const { reminderFreeze, anchorMap, neighborMap } = guardCtx;
  if (!reminderFreeze || reminderFreeze.failed) {
    return { window: null, meta: null, skip: { code: 'REMINDER_STATUS_UNKNOWN', description: 'Reminder-sent status unreadable — frozen (fail closed)' } };
  }
  if (reminderFreeze.frozen.has(service.id)) {
    return { window: null, meta: null, skip: { code: 'REMINDER_SENT_FROZEN', description: `${guardMode === 'flex' ? '73-hour' : '72-hour'} reminder already sent — visit is frozen` } };
  }
  if (guardMode === 'flex') {
    return flexWindowFor(service, {
      neighborMap, anchor: routeTiers.resolveAnchor(service, anchorMap), today, nowDate,
    });
  }
  const dateStr = toDateStr(service.scheduled_date);
  const anchor = routeTiers.resolveAnchor(service, anchorMap);
  if (!anchor) {
    return { window: null, meta: null, skip: { code: 'DRIFT_ANCHOR_UNKNOWN', description: 'Recurrence anchor could not be derived — no move (fail closed)' } };
  }
  const daysOut = routeTiers.daysBetween(today, dateStr);
  const radius = routeTiers.tierRadiusForDaysOut(daysOut);
  const window = routeTiers.tierMoveWindow({
    origDate: service.scheduled_date, anchorDate: anchor, today, radius,
  });
  if (!window) {
    return { window: null, meta: null, skip: { code: 'DRIFT_BUDGET_EXHAUSTED', description: `No legal candidate dates left within tier radius ±${radius} and drift budget ±${routeTiers.DRIFT_BUDGET_DAYS} of anchor ${anchor}` } };
  }
  return {
    window, meta: {
      mode: 'tiers', days_out: daysOut, radius, anchor, drift_budget_days: routeTiers.DRIFT_BUDGET_DAYS, window,
    }, skip: null,
  };
}

// Apply-time re-check for the active day-move guard: the reminder freeze
// re-read against the LIVE clock right before applying, and the window
// recomputed against the CURRENT ET date (a slow or manual run crossing ET
// midnight must not apply yesterday's window). `meta` is the pass-1 tierMeta
// this visit was scored with — the tier ladder's durable evidence (its
// anchor) is REUSED, never re-queried, since it only ever grows (a
// cumulative record of past moves). The flex tier's series-neighbor bounds
// are NOT durable evidence the same way — a sibling occurrence can be
// inserted or edited between pass 1 and this recheck — so they are re-read
// fresh here (Codex pre-push P1) rather than reusing the pass-1 capture.
// This is still a pre-transaction, best-effort fast-fail: the write path
// re-validates the same bounds again, atomically, inside the rebooker's own
// move transaction (apply.js's makeMoveGuard/makeMemberGuard), which is the
// authoritative check against a concurrent insert/edit. Pulled out of
// runAutoDispatch's pass-2 loop for the same complexity-budget reason as
// resolveDayMoveWindow. Returns { window, meta, skip }; skip.degraded flags
// a read failure the caller must fold into the run's health status.
async function recheckDayMoveWindow(guardMode, service, meta, nowDate) {
  if (guardMode === 'legacy') return { window: null, meta: null, skip: null };
  const freezeHours = guardMode === 'flex' ? flexTier.FLEX_TIER_FREEZE_HOURS : routeTiers.REMINDER_SENDABLE_HOURS;
  const applyFreeze = await routeTiers.loadReminderFreeze(db, [service.id], nowDate, freezeHours);
  if (applyFreeze.failed) {
    return { window: null, meta: null, skip: { code: 'REMINDER_STATUS_UNKNOWN', description: 'Reminder-sent status unreadable at apply time — frozen (fail closed)', degraded: true } };
  }
  if (applyFreeze.frozen.has(service.id)) {
    return { window: null, meta: null, skip: { code: 'REMINDER_SENT_FROZEN', description: `${guardMode === 'flex' ? '73-hour' : '72-hour'} reminder was sent during the run — visit is frozen` } };
  }
  const todayNow = etDateString(nowDate);
  if (guardMode === 'flex') {
    return flexWindowFor(service, {
      neighborMap: await flexTier.loadSeriesNeighbors(db, [service]), anchor: meta && meta.anchor, today: todayNow, nowDate,
    });
  }
  const daysOutNow = routeTiers.daysBetween(todayNow, toDateStr(service.scheduled_date));
  const radiusNow = routeTiers.tierRadiusForDaysOut(daysOutNow);
  const anchorNow = meta && meta.anchor;
  const window = radiusNow > 0 && anchorNow
    ? routeTiers.tierMoveWindow({
      origDate: service.scheduled_date, anchorDate: anchorNow, today: todayNow, radius: radiusNow,
    })
    : null;
  if (!window) {
    return { window: null, meta: null, skip: { code: 'TIER_LOCKED', description: `No longer legally movable at apply time (${daysOutNow} days out)` } };
  }
  return {
    window, meta: {
      ...meta, days_out: daysOutNow, radius: radiusNow, window,
    }, skip: null,
  };
}

// Whether a visit's day move runs through the active guard mode: never in
// legacy mode, and never for the unplaced due-date shape — a first
// placement with no time yet, not a day move (its own ±3-day due-date bound
// applies). Shared by pass 1 and the apply-time recheck.
function dayMoveGuarded(guardMode, service) {
  return guardMode !== 'legacy' && !(service.recurring_dispatch_due_date && !service.window_start);
}

// One skipped visit: counted and logged (every pass-1 gate's early exit).
async function logSkip(run, service, { reason_code: reasonCode, reason_description: reasonDescription }) {
  run.totals.skipped++;
  await audit.logDecision(run.runId, {
    action: 'skipped', service, reason_code: reasonCode, reason_description: reasonDescription,
  });
}

// A day-move guard skip (or a grouped-move refusal), both { code,
// description }, in the { reason_code, reason_description } shape logged.
function guardSkipReason(skip) {
  return { reason_code: skip.code, reason_description: skip.description };
}

// Eligibility, self-healing a not-yet-geocoded customer first — but BEFORE
// the plan-active gate (don't spend the geocode budget on a lapsed plan we'd
// skip anyway) and deduped per customer (a customer's later visits would
// just read the coords the first row saved, so they must not re-attempt).
// Returns { elig, planCheck } (planCheck when the self-heal already read
// it), or { skip } for the lapsed plan found on the way.
async function eligibilityWithGeoHeal(service, eligCtx, run) {
  const elig = isEligibleForAutoDispatch(service, eligCtx);
  if (elig.eligible || elig.reason_code !== 'MISSING_GEO' || stampedAddressDiverges(service)) return { elig, planCheck: null };
  const planCheck = await isRecurringPlanActive(service, db);
  if (!planCheck.active) return { skip: planCheck };
  const { geo } = run;
  const cust = service.customer_id;
  if (geo.cache.has(cust)) {
    const cached = geo.cache.get(cust);
    if (!cached) return { elig, planCheck };
    service.customer_latitude = cached.lat;
    service.customer_longitude = cached.lng;
    return { elig: isEligibleForAutoDispatch(service, eligCtx), planCheck };
  }
  if (geo.attempts >= run.config.maxGeocodesPerRun) return { elig, planCheck };
  geo.attempts++; // one Google API call per NEW customer, success or not
  const res = await geocodeAndRecheck(service, eligCtx);
  geo.cache.set(cust, res.geocoded ? { lat: service.customer_latitude, lng: service.customer_longitude } : null);
  if (res.geocoded) geo.geocoded++;
  return { elig: res.recheck, planCheck };
}

// Pass 1 for one visit: eligibility (with the geo self-heal), the day-move
// guard, the plan and preference gates and scoring — then, in dry_run, a
// recommendation, or in apply mode a planned move for pass 2. Every early
// exit logs its own decision.
async function evaluateServiceForRun(service, run) {
  const { config, guardMode, totals } = run;
  const eligCtx = buildEligCtx(guardMode, run.today, run.lockBoundary, config.lockWindowDays);
  const gate = await eligibilityWithGeoHeal(service, eligCtx, run);
  if (gate.skip) return logSkip(run, service, gate.skip);
  if (!gate.elig.eligible) return logSkip(run, service, gate.elig);

  // ── Day-move guard (only when a guard mode is active) ──
  const guard = dayMoveGuarded(guardMode, service)
    ? await resolveDayMoveWindow(guardMode, service, run.guardCtx, run.today, run.nowDate)
    : { window: null, meta: null, skip: null };
  if (guard.skip) return logSkip(run, service, guardSkipReason(guard.skip));

  // Plan-active gate (reuse the result if the geo self-heal already computed it).
  const planCheck = gate.planCheck || await isRecurringPlanActive(service, db);
  if (!planCheck.active) return logSkip(run, service, planCheck);

  const prefs = await getCustomerSchedulingPreferences(service.customer_id, service.service_type);
  if (config.requirePortalPreferences && !prefs.has_explicit_prefs) {
    return logSkip(run, service, { reason_code: 'NO_PORTAL_PREFERENCES', reason_description: 'Customer has no explicit scheduling preferences' });
  }

  const ctx = {
    db,
    nowDate: run.nowDate,
    lockWindowDays: config.lockWindowDays,
    lookaheadDays: config.lookaheadDays,
    dateToleranceDays: config.dateToleranceDays,
    capabilityFor: run.capabilityFor,
    topN: 60,
    // ROUTE-TIERS: pre-intersected candidate window (null/absent when the
    // gate is off — candidate-slots then runs its legacy window math).
    ...(guard.window ? { tierWindow: guard.window, tierMeta: guard.meta } : {}),
  };
  const evalResult = await evaluatePlacement(service, prefs, ctx, config, run.lockBoundary);
  totals.evaluated++;

  // FLEX-TIER (Codex #4995 r4 P2): a grouped move is only as legal as its
  // siblings — preview the apply-time member guard now, so neither a dry-run
  // recommendation nor a planned move carries one apply would refuse.
  const refusal = evalResult.kind === 'move' && guardMode === 'flex'
    ? await previewGroupMove(service, evalResult.best, { ...config, prefs, lockBoundary: run.lockBoundary })
    : null;
  const noChange = evalResult.kind === 'no_change' ? evalResult : refusal && guardSkipReason(refusal);
  if (noChange) {
    return audit.logDecision(run.runId, {
      action: 'no_change', service, reason_code: noChange.reason_code, reason_description: noChange.reason_description, ...evalResult.audit,
    });
  }

  // A qualifying move. In dry_run we recommend it immediately (order is
  // irrelevant — nothing is applied). In apply mode we COLLECT it and
  // decide what actually moves in a second best-improvement-first pass,
  // so the per-run change cap spends its budget on the highest-value
  // moves rather than whichever happened to come first by scheduled_date.
  if (config.mode === 'dry_run') {
    totals.recommended++;
    return audit.logDecision(run.runId, { action: 'recommended', service, reason_code: 'DRY_RUN_RECOMMENDATION', reason_description: `Would move (+${evalResult.improvement})`, ...evalResult.audit, appliedBy: 'auto_dispatch' });
  }
  run.plannedMoves.push({ service, prefs, ctx, result: evalResult });
  return undefined;
}

// Pass-2 order: due deadlines first (the earliest unplaced due date before
// its placement window closes), then descending route gain.
function byDueThenImprovement(a, b) {
  const aDue = !a.service.window_start ? toDateStr(a.service.recurring_dispatch_due_date) : null;
  const bDue = !b.service.window_start ? toDateStr(b.service.recurring_dispatch_due_date) : null;
  return Number(!!bDue) - Number(!!aDue)
    || (aDue && bDue ? aDue.localeCompare(bDue) : 0)
    || b.result.improvement - a.result.improvement;
}

// Re-check the active day-move guard right before applying — pass 1 read it
// before a potentially long scoring pass, and the freeze must stay the HARD
// gate at apply time too. The residual race after this point is closed by
// the rebooker's atomic `expect` (it pins the ORIGINAL scheduled_date; a
// visit whose date slipped near enough for its reminder to fire has
// necessarily changed date and 409s). Refreshes the planned move's ctx on
// success; returns the skip otherwise (a read failure degrades the run).
async function recheckPlannedMove(pm, run) {
  if (!dayMoveGuarded(run.guardMode, pm.service)) return null;
  const recheckNow = new Date();
  const recheck = await recheckDayMoveWindow(run.guardMode, pm.service, pm.ctx.tierMeta, recheckNow);
  if (recheck.skip) {
    if (recheck.skip.degraded) run.guardReadDegraded = true;
    return recheck.skip;
  }
  pm.ctx.tierWindow = recheck.window;
  pm.ctx.tierMeta = recheck.meta;
  // The re-evaluation filters destinations against the flex freeze
  // (candidate-slots) — measured from now, not pass 1.
  pm.ctx.nowDate = recheckNow;
  return null;
}

// Pass 2 for one planned move: the supersession check, the apply-time guard
// recheck, a live re-evaluation and the per-run cap, then the apply and its
// audit. Resolves to `fresh` — the live re-evaluation — for the failure
// audit when a step throws.
async function applyPlannedMove(pm, run, attempt) {
  const { runId, config, totals, lockBoundary } = run;
  // Supersession check FIRST: re-read the scored row, because an operator
  // may have locked/excluded/cancelled or moved this visit during the run
  // window. Without it, a now-ineligible visit would be re-scored from the
  // stale pass-1 snapshot and could surface as a cap-held "valid move held"
  // recommendation. Reporting-only — the apply path re-asserts this
  // atomically; this just keeps the audit log honest. One point-read per
  // planned move, so the pass stays O(pending).
  const live = await revalidatePlacement(pm.service);
  if (!live.ok) {
    return audit.logDecision(runId, { action: 'no_change', service: pm.service, reason_code: 'SUPERSEDED_DURING_RUN', reason_description: `Superseded by an operator during the run — ${live.reason}`, ...pm.result.audit });
  }
  const guardSkip = await recheckPlannedMove(pm, run);
  if (guardSkip) {
    return audit.logDecision(runId, { action: 'no_change', service: pm.service, reason_code: guardSkip.code, reason_description: guardSkip.description, ...pm.result.audit });
  }

  const fresh = await evaluatePlacement(pm.service, pm.prefs, pm.ctx, config, lockBoundary);
  attempt.fresh = fresh;
  if (fresh.kind !== 'move') {
    // Re-scoring against the live schedule no longer clears the bar (an
    // earlier apply this run captured the gain, or the row changed).
    return audit.logDecision(runId, { action: 'no_change', service: pm.service, reason_code: fresh.reason_code, reason_description: `No longer qualifies on live re-evaluation — ${fresh.reason_description}`, ...fresh.audit });
  }

  // A grouped row moves its whole visit: reserve EVERY member row against
  // the per-run cap before applying (codex #3609 r7).
  const unitSize = await unitMoveSize(pm.service, fresh.best);
  if (totals.changed + unitSize > config.maxChangesPerRun) {
    totals.recommended++; // cap-held but still a valid move — count it in the summary
    const grouped = unitSize > 1 ? `, grouped visit of ${unitSize}` : '';
    return audit.logDecision(runId, { action: 'recommended', service: pm.service, reason_code: 'MAX_CHANGES_REACHED', reason_description: `Per-run change cap ${config.maxChangesPerRun} reached (valid move held, +${fresh.improvement}${grouped})`, ...fresh.audit });
  }

  // Next-best still-scored candidates (GATE_AUTO_DISPATCH_SHARED_MODEL) —
  // apply falls back to one of these on a SLOT_TAKEN refusal instead of
  // failing the visit outright. No effect when the gate is off.
  // `rescore` (Codex r1): after a SLOT_TAKEN, re-run this visit's own
  // evaluation against the now-current schedule before the next attempt.
  const result = await applyAutoDispatchMove(pm.service, fresh.best, runId, {
    ...config, remainingChanges: config.maxChangesPerRun - totals.changed, prefs: pm.prefs, lockBoundary,
    alternateCandidates: fresh.rankedCandidates,
    rescore: () => evaluatePlacement(pm.service, pm.prefs, pm.ctx, config, lockBoundary),
  });
  totals.changed += result.movedCount || 1;
  // A SLOT_TAKEN fallback (Codex pre-push P1) can land on a DIFFERENT
  // candidate than `fresh.best` — re-derive the audit from whichever one
  // `result.applied` says actually moved, never the first-tried placement.
  // For the common (non-fallback) case this reproduces fresh.audit exactly
  // (same pure inputs).
  const appliedAudit = buildAppliedPlacementAudit(fresh, pm.service, pm.prefs, pm.ctx, lockBoundary, result);
  return audit.logDecision(runId, {
    action: 'changed',
    service: pm.service,
    reason_code: 'CHANGE_APPLIED',
    reason_description: `Moved (+${appliedAudit.improvement})`,
    oldPlacement: { date: toDateStr(pm.service.scheduled_date), window_start: pm.service.window_start, window_end: pm.service.window_end, technician_id: pm.service.technician_id, status: result.pre_status },
    newPlacement: { ...appliedAudit.newPlacement, status: result.post_status },
    scores: appliedAudit.scores,
    prefsSnapshot: fresh.audit.prefsSnapshot,
    routeMetrics: { ...appliedAudit.routeMetrics, attempts: appliedAudit.attempts },
    constraints: appliedAudit.constraints,
    appliedBy: 'auto_dispatch',
  });
}

// A failed pass-2 apply: counted, and logged with the placement it tried. A
// partial grouped move already changed rows — they count — and its
// stragglers are quarantined for the rest of the run (see runPassTwo).
async function recordApplyFailure(pm, fresh, applyErr, run) {
  run.totals.failed++;
  run.totals.changed += applyErr.movedCount || 0;
  const failedMembers = Array.isArray(applyErr.failedMembers) ? applyErr.failedMembers : [];
  for (const id of failedMembers) run.quarantinedIds.add(String(id));
  logger.error(`[auto-dispatch] apply failed for ${pm.service.id}: ${applyErr.message}`);
  try {
    await audit.logDecision(run.runId, { action: 'failed', service: pm.service, reason_code: 'ERROR', reason_description: applyErr.message, ...failedPlacementAudit(fresh, pm, run.lockBoundary, applyErr), error: applyErr.message });
  } catch (_) { /* swallow */ }
}

// ── Pass 2 (apply mode): due deadlines first, then route improvement ──
// Fund the earliest unplaced due dates before their placement window closes.
// Equal deadlines and ordinary optimization keep descending route gains.
// Each move is RE-EVALUATED ONCE against the now-live schedule
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
//
// Stragglers of a PARTIAL grouped move (codex #3609 r31 P1): the failed
// member sits at its original placement and passes revalidatePlacement
// (which never compares visit_id), so its own pass-2 entry would re-evaluate
// it and move it independently after the detach seam dissolves the broken
// group — while the first result already declared the stop incomplete and
// staff-owned. Quarantine those ids for the rest of the run (rain-out's own
// pattern for unit-move stragglers).
async function runPassTwo(run) {
  run.plannedMoves.sort(byDueThenImprovement);
  for (const pm of run.plannedMoves) {
    if (run.quarantinedIds.has(String(pm.service.id))) {
      await audit.logDecision(run.runId, { action: 'no_change', service: pm.service, reason_code: 'VISIT_MOVE_INCOMPLETE', reason_description: 'Straggler of a partial grouped move earlier this run — staff repair owns this stop', ...pm.result.audit });
      continue;
    }
    const attempt = { fresh: null };
    try {
      await applyPlannedMove(pm, run, attempt);
    } catch (applyErr) {
      await recordApplyFailure(pm, attempt.fresh, applyErr, run);
    }
  }
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
  // This run's summary push counts only cards this run holds.
  require('../tech-visit-notifications').discardHeldAutoDispatchCards();
  logger.info(`[auto-dispatch] run ${runId} mode=${config.mode} lock>${lockBoundary} lookahead<=${lookaheadEnd}`);

  let runStatus = 'completed';
  let runError = null;
  // GUARD MODE: 'tiers' (GATE_ROUTE_TIERS), 'flex' (GATE_AUTO_DISPATCH_FLEX_TIER,
  // takes precedence), or 'legacy' (neither — the flat lock, byte for byte).
  // Resolved once in config.js (getAutoDispatchConfig) so apply.js's
  // grouped-member guard, which receives this SAME config object, reads
  // the identical mode — never a second, independently-derived decision.
  const run = {
    runId,
    config,
    guardMode: config.guardMode,
    nowDate,
    today,
    lockBoundary,
    totals,
    // geo self-heal: attempts (success OR fail) bound the cap, geocoded
    // counts successes for the summary, and the cache (customer_id ->
    // {lat,lng}|null) keeps a customer's later visits from re-attempting.
    geo: { cache: new Map(), attempts: 0, geocoded: 0 },
    // Apply-mode only: qualifying moves found in the pass-1 sweep, applied
    // best-improvement-first in pass 2 so the change cap funds the largest gains.
    plannedMoves: [],
    quarantinedIds: new Set(),
    guardReadDegraded: false, // a failed guard read must not report a green run
  };

  try {
    run.capabilityFor = makeCapabilityFn(await loadCapabilityMap());
    const loadBoundary = resolveLoadBoundary(run.guardMode, nowDate, lockBoundary, today);
    const services = await loadEligibleServices(loadBoundary, lookaheadEnd, today);

    // Guard-mode bulk context: reminder-freeze + (tiers') drift anchors or
    // (flex's) series neighbors, one query pair at most. FAIL CLOSED — a
    // failed read freezes/guard-unknowns every visit rather than moving
    // without the check.
    run.guardCtx = await loadGuardContext(run.guardMode, services, nowDate);
    run.guardReadDegraded = run.guardCtx.degraded;

    for (const service of services) {
      try {
        await evaluateServiceForRun(service, run);
      } catch (perErr) {
        totals.failed++;
        logger.error(`[auto-dispatch] service ${service && service.id} failed: ${perErr.message}`);
        try {
          await audit.logDecision(runId, { action: 'failed', service, reason_code: 'ERROR', reason_description: perErr.message, error: perErr.message });
        } catch (_) { /* swallow */ }
      }
    }

    if (config.mode !== 'dry_run') await runPassTwo(run);

    if (totals.failed > 0 || run.guardReadDegraded) runStatus = 'completed_with_errors';
  } catch (fatal) {
    runStatus = 'failed';
    runError = fatal.message;
    logger.error(`[auto-dispatch] run ${runId} fatal: ${fatal.message}`);
  }

  // Existing handoffs still need office escalation while placement is paused.
  // This audit only maintains staff alerts; it never moves appointments.
  try {
    await audit.flagUnplacedVisits(config);
  } catch (err) {
    totals.failed++;
    if (runStatus === 'completed') runStatus = 'completed_with_errors';
    logger.error(`[auto-dispatch] unplaced visit escalation failed: ${err.message}`);
  }
  await audit.completeRun(runId, { status: runStatus, totals, error: runError });
  // One push per tech for the whole run (GATE_AUTO_DISPATCH_PUSH_SUMMARY),
  // after the per-visit cards it summarizes. Best-effort; never throws.
  if (config.mode !== 'dry_run' && totals.changed > 0) {
    await require('../tech-visit-notifications').pushAutoDispatchSummary({ runId });
  }
  logger.info(`[auto-dispatch] run ${runId} ${runStatus} evaluated=${totals.evaluated} skipped=${totals.skipped} recommended=${totals.recommended} changed=${totals.changed} failed=${totals.failed} geocoded=${run.geo.geocoded}/${run.geo.attempts}`);
  return { runId, status: runStatus, geocoded: run.geo.geocoded, geocode_attempts: run.geo.attempts, ...totals };
}

module.exports = { runAutoDispatch, loadEligibleServices, _internals: { loadCapabilityMap, makeCapabilityFn, evaluatePlacement } };
