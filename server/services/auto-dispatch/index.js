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
const {
  isEligibleForAutoDispatch, heldOutOfAutoDispatch, isRecurringPlanActive, lapsedPlanKeys, planKey, isPersonPlacedVisit, VALID_STATUSES,
} = require('./eligibility');
const { getCustomerSchedulingPreferences } = require('./preferences');
const { findValidCandidateSlots, SCORE_CAP } = require('./candidate-slots');
const { resolveGeo } = require('./geo');
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
const moveRules = require('./move-rules');
const moveLimit = require('./move-limit');
const needsPerson = require('./needs-person-notice');

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
  // The gain move-rules.js judged the candidate on: the raw score difference,
  // less the default-time credit when the candidate is a day move.
  const improvement = moveRules.moveGain({
    service, current, currentScore, cand: candidate, candScore: candidateScore,
  });
  const scores = { old: currentScore.total_score, new: candidateScore.total_score, improvement };
  const routeMetrics = {
    current_detour_minutes: current.detour_minutes,
    candidate_detour_minutes: candidate.detour_minutes,
    day_move: moveRules.isDayMove(current, candidate),
    drive_saving_minutes: moveRules.driveSavingMinutes(current, candidate),
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
    // Ids and codes only: why this visit cannot stay in its slot.
    ...(current.conflict ? { conflict: current.conflict } : {}),
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

// A flex visit whose window collapsed for a stale anchor and found no same-day
// re-time: say why day moves were never possible, instead of an opaque
// NO_VALID_SLOT. Label only — the search itself is unchanged.
function staleAnchorReason(reason, tierMeta) {
  if (reason.code !== 'NO_VALID_SLOT' || !(tierMeta && tierMeta.anchor_stale)) return reason;
  return {
    code: 'DRIFT_ANCHOR_STALE',
    description: `Day moves are blocked: the visit was re-dated after an earlier auto move and is now more than ${2 * flexTier.FLEX_TIER_RADIUS_DAYS} days from its original date ${tierMeta.anchor}; no same-day re-time found either`,
  };
}

// Ids and codes only: the overlap or closed day a visit sits in, for an audit
// row with no candidate (a person must place it; Codex #6207 r14 P2).
function conflictOf(current) {
  return current && current.conflict ? { conflict: current.conflict } : {};
}

// The conflict an evaluation read for the visit's current placement, on a
// move or a no_change result alike; null when it read none.
function conflictIn(evalResult) {
  return evalResult.conflict || (evalResult.current && evalResult.current.conflict) || null;
}

// THE NEEDS-A-PERSON LEDGER. `run.conflicts` holds every visit an evaluation
// (or the move-limit gate) read in conflict; `run.clearedIds` holds the visits
// read placed and clear with the conflict read ON (gate off, the read never
// happened, so nothing is proven). Nothing is raised where a decision is
// logged: settleConflicts decides once, at the run's end, from what is true
// then. Per-call-site collection missed a path in each of two review rounds
// (Codex #6253 r1, r2).
function noteEvaluation(run, service, evalResult, ctx) {
  const id = String(service.id);
  const conflict = conflictIn(evalResult);
  if (conflict) {
    run.conflicts.set(id, {
      service, conflict, ctx, reason: evalResult.kind === 'no_change' ? evalResult.reason_code : null,
    });
    run.clearedIds.delete(id);
    return;
  }
  run.conflicts.delete(id);
  if (run.config.conflictMovesEnabled === true && !moveRules.isUnplacedDueDate(service)) run.clearedIds.add(id);
}

// Why a visit in conflict stayed where it is. It only picks the notice's wording.
function noteUnmoved(run, service, reasonCode) {
  const seen = run.conflicts.get(String(service.id));
  if (seen) seen.reason = reasonCode;
}

// The visit as it stands now: a move this run (its own, a group's, a partner's)
// may have changed its slot or freed the stop it overlapped. Returns null when
// it is no longer an open visit, { clear: true } when it no longer conflicts.
async function standingConflict(seen, id) {
  const row = await db('scheduled_services').where({ id })
    .first('scheduled_date', 'window_start', 'window_end', 'technician_id', 'status');
  if (!row || !VALID_STATUSES.has(row.status)) return null;
  const service = { ...seen.service, ...row };
  // Required lazily, like apply.js's conflict re-read.
  const conflict = await require('./candidate-slots')._internals.readCurrentConflict(service, seen.ctx);
  return conflict ? { service, conflict } : { clear: true };
}

// Run end: every visit still in conflict is handed to the notice, whatever
// path left it there (no slot, a guard, the per-run cap, a failed or partial
// write, a dry run). After any move the conflict is read again, so a visit
// this run fixed raises nothing and closes its standing notice. A re-read
// that fails keeps what the run saw. Never throws.
async function settleConflicts(run) {
  const reread = run.totals.changed > 0;
  for (const [id, seen] of run.conflicts) {
    let now = seen;
    try {
      if (reread) now = await standingConflict(seen, id);
    } catch (err) {
      logger.warn(`[auto-dispatch] conflict re-read failed for ${id}: ${err.message}`);
    }
    if (now && now.clear) run.clearedIds.add(id);
    else if (now) needsPerson.collectUnmoved(run.needsPerson, now.service, seen.reason, now.conflict);
  }
}

async function evaluatePlacement(service, prefs, ctx, config, lockBoundary) {
  const {
    current, candidates, drops, skipped,
  } = await findSlotsOrSkip(service, prefs, ctx);
  const prefsSnapshot = prefs.raw_snapshot;

  if (!current || candidates.length === 0) {
    const reason = staleAnchorReason(noSlotReason(drops, skipped), ctx.tierMeta);
    return {
      kind: 'no_change',
      reason_code: reason.code,
      reason_description: reason.description,
      conflict: (current && current.conflict) || null,
      audit: { prefsSnapshot, constraints: { blackout: prefs.blackout, lock_boundary: lockBoundary, preferred_day_indexes: prefs.preferred_day_indexes, preferred_time_window: prefs.preferred_time_window, drops, model: modelLabelFor(current), ...(ctx.tierMeta ? { route_tiers: ctx.tierMeta } : {}), ...conflictOf(current) } },
    };
  }

  const scoreCtx = { currentTechnicianId: service.technician_id, changeCount: service.auto_dispatch_change_count || 0 };
  const currentScore = scoreAppointmentPlacement(current, prefs, scoreCtx);
  // Every candidate's score, in encounter order — kept (not just the single
  // best) so a SLOT_TAKEN apply-time refusal (GATE_AUTO_DISPATCH_SHARED_MODEL)
  // can fall back to the next-best still-scored candidate rather than giving
  // up.
  const scored = candidates.map((cand) => ({ cand, sc: scoreAppointmentPlacement(cand, prefs, scoreCtx) }));

  // Already-moved visits must clear a higher bar (defeats the stability penalty)
  // so the job never thrashes the same customer day to day.
  const threshold = (service.auto_dispatch_change_count || 0) > 0
    ? Math.max(config.minScoreImprovement, config.removeStabilityFloor)
    : config.minScoreImprovement;

  // move-rules.js is the ONE rule for which candidate may move this visit:
  // `ranked.best` and every entry of `ranked.ranked` (apply.js's SLOT_TAKEN
  // fallback list, Codex pre-push P1) passed the same drive floor and score
  // bar — a below-bar or worse-than-current placement never reaches apply.js.
  // Ties keep encounter order.
  const ranked = moveRules.rankCandidates({
    service, current, currentScore, scored, threshold, config,
  });
  const { best } = ranked;

  const {
    improvement, newPlacement, scores, routeMetrics, constraints,
  } = buildPlacementAudit({
    current, currentScore, candidate: best, candidateScore: ranked.bestScore, service, prefs, lockBoundary, ctx, threshold,
  });

  // Capped AFTER scoring (Codex r1): with the gate on, findValidCandidateSlots
  // returns every survivor and each was scored above before this cap.
  const rankedCandidates = ranked.ranked.slice(0, ctx.scoreCap || SCORE_CAP);

  const auditCtx = {
    newPlacement, scores, prefsSnapshot, routeMetrics, constraints,
  };

  if (!ranked.qualifies) {
    return {
      kind: 'no_change', ...noMoveReason(ranked, improvement, threshold, routeMetrics, config), conflict: current.conflict || null, audit: auditCtx,
    };
  }
  return {
    kind: 'move', improvement, best, rankedCandidates, current, currentScore, threshold, audit: auditCtx,
    withoutConflict: ordinaryMoveOf(ranked, { current, currentScore, service, prefs, lockBoundary, ctx, threshold, prefsSnapshot }),
  };
}

// For a visit in conflict that an ordinary optimization would move anyway:
// the move apply mode makes once the overlapping partner has left, when the
// visit is evaluated with no conflict — its own slot, gain and audit numbers
// (Codex #6207 r10 P2). Null for every other visit.
function ordinaryMoveOf(ranked, { current, prefsSnapshot, ...rest }) {
  if (!ranked.normalBest) return null;
  const { conflict: _conflict, conflict_unit_ids: _unit, ...clear } = current;
  const {
    improvement, newPlacement, scores, routeMetrics, constraints,
  } = buildPlacementAudit({ ...rest, current: clear, candidate: ranked.normalBest, candidateScore: ranked.normalBestScore });
  return { improvement, best: ranked.normalBest, current: clear, audit: { newPlacement, scores, prefsSnapshot, routeMetrics, constraints } };
}

function overlapOf(evalResult) {
  const conflict = evalResult.current && evalResult.current.conflict;
  return conflict && conflict.kind === 'overlap' ? conflict : null;
}

function logDryRunRecommendation(run, service, evalResult, note = '') {
  run.totals.recommended++;
  return audit.logDecision(run.runId, { action: 'recommended', service, reason_code: 'DRY_RUN_RECOMMENDATION', reason_description: `${wouldMoveDescription(evalResult)}${note}`, ...evalResult.audit, appliedBy: 'auto_dispatch' });
}

// Dry run only: one recommendation per overlapping pair, in the order apply
// mode uses (byDueThenImprovement: the cheaper fix first). In apply mode
// pass 2 re-evaluates each visit against the live schedule, so once one
// visit of a pair has moved the other is no longer in conflict; a dry run
// moves nothing, so a visit whose every overlapping partner is already
// recommended is logged as staying (Codex #6207 r6 P2) — unless an ordinary
// optimization would move it anyway, as apply mode then does (r8 P2).
// The rows a recommended conflict fix moves: the visit and its group.
function unitIdsOf(pm) {
  const ids = pm.result.current && pm.result.current.conflict_unit_ids;
  return ids && ids.length ? ids.map(String) : [String(pm.service.id)];
}

async function recommendOverlapFixes(run) {
  // `movers`: rows a conflict fix moves for certain; only these clear a
  // partner's overlap. `estimated`: rows of an ordinary-rules estimate, which
  // apply mode may not make, so they clear nothing downstream (r14 P2).
  const movers = new Set();
  const estimated = new Set();
  for (const pm of run.dryRunOverlaps.sort(byDueThenImprovement)) {
    const partners = (overlapOf(pm.result).with || []).map(String);
    // A visit whose own unit is already recommended moves with it: one
    // recommendation for the unit, as apply mode makes one move (r9 P2).
    if (movers.has(String(pm.service.id)) || estimated.has(String(pm.service.id))) {
      await audit.logDecision(run.runId, { action: 'no_change', service: pm.service, reason_code: 'CONFLICT_PARTNER_MOVES', reason_description: 'This visit moves with its group, which is already recommended to move', ...pm.result.audit });
      continue;
    }
    const cleared = partners.length && partners.every((id) => movers.has(id));
    if (cleared && pm.result.withoutConflict) {
      // The partner's move clears the overlap; this visit then moves on the
      // ordinary rules, to the slot those rules pick.
      // An ESTIMATE: a dry run moves nothing, so this slot is scored on the
      // schedule before the partner's move; apply mode evaluates the visit
      // again after that move and may pick another slot or none. The row
      // says so (Codex #6207 r12 P2).
      for (const id of unitIdsOf(pm)) estimated.add(id);
      await logDryRunRecommendation(run, pm.service, pm.result.withoutConflict, ' after the overlapping visit moves (estimate: scored before that move)');
    } else if (cleared) {
      await audit.logDecision(run.runId, { action: 'no_change', service: pm.service, reason_code: 'CONFLICT_PARTNER_MOVES', reason_description: 'The overlapping visit is already recommended to move; this one stays', ...pm.result.audit });
    } else {
      for (const id of unitIdsOf(pm)) movers.add(id);
      await logDryRunRecommendation(run, pm.service, pm.result);
    }
  }
}

function signed(n) { return n >= 0 ? `+${n}` : String(n); }

function wouldMoveDescription(evalResult) {
  const conflict = evalResult.current && evalResult.current.conflict;
  return `Would move${(conflict && CONFLICT_PHRASE[conflict.kind]) || ''} (${signed(evalResult.improvement)})`;
}

// Why the nearest candidate did not move the visit: a move that cleared
// the score bar and saved too little drive, or a gain under the bar.
function noMoveReason(ranked, improvement, threshold, routeMetrics, config) {
  if (ranked.ceilingFailed) {
    return {
      reason_code: 'CONFLICT_NO_NEAR_SLOT',
      reason_description: `In conflict, but the nearest free slot adds ${-routeMetrics.drive_saving_minutes} drive minutes > ${config.conflictMaxAddedDriveMinutes} allowed; a person must place it`,
    };
  }
  if (ranked.floorFailed) {
    return {
      reason_code: 'NO_DRIVE_SAVING',
      reason_description: `Best move saves ${routeMetrics.drive_saving_minutes} drive minutes < ${config.minDayMoveDriveSavingMinutes} required`,
    };
  }
  return { reason_code: 'NO_SCORE_IMPROVEMENT', reason_description: `Best improvement ${improvement} < threshold ${threshold}` };
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

// Why the flex tier's own-schedule freeze holds a visit. A recurring child with
// no arrival window and no due date has no instant to freeze on (the freeze
// reads an uncomposable instant as frozen, fail closed), so it is skipped as
// before — but labelled for what it is, not as a 73-hour cutoff weeks away. A
// combined-allocation stamp does not change this: reservation_arrival_start
// returns NULL for a row with no window_start before it reads the stamp.
function frozenSkipReason(service) {
  const noWindow = !service.window_start && !service.recurring_dispatch_due_date;
  return noWindow
    ? { code: 'NO_ARRIVAL_WINDOW', description: 'Visit has no arrival window and no due date; auto-dispatch cannot place it' }
    : { code: 'WITHIN_73H', description: '73-hour cutoff reached on the visit\'s own schedule — frozen (independent of reminder evidence)' };
}

// Label only: flexTierMoveWindow collapses to the visit's own date when the
// band around the durable anchor no longer reaches it (a visit re-dated far
// from its anchor after an earlier auto move — the two ±radius bands cannot
// overlap beyond twice the radius). The same-day re-time search still runs on
// that one-day window; this only records why a day move cannot exist.
function staleAnchorMeta(window, origDate, anchor) {
  const orig = toDateStr(origDate);
  const collapsed = window.dateFrom === orig && window.dateTo === orig;
  const apart = Math.abs(routeTiers.daysBetween(anchor, orig)) > 2 * flexTier.FLEX_TIER_RADIUS_DAYS;
  return collapsed && apart ? { anchor_stale: true } : {};
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
    const frozen = frozenSkipReason(service);
    return skip(frozen.code, frozen.description);
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
      mode: 'flex', radius_days: flexTier.FLEX_TIER_RADIUS_DAYS, anchor, neighbors, window, ...staleAnchorMeta(window, service.scheduled_date, anchor),
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

// The move limit (move-limit.js) for one visit, from `counts` (the run's bulk
// read, or a fresh single-visit read in pass 2). Returns the skip row, or null
// when the visit may move. A visit that MUST move (an unplaced due date, or in
// conflict) and is at the limit is not moved, and a person is told instead.
async function moveLimitGate(service, ctx, run, counts) {
  const skip = moveLimit.limitSkip(service, counts, run.config);
  if (!skip) return null;
  if (!skip.unknown) {
    // Required lazily, like apply.js's conflict re-read.
    const conflict = await require('./candidate-slots')._internals.readCurrentConflict(service, ctx);
    // In conflict: the ledger (settleConflicts raises it). No arrival time
    // and no conflict: only this gate knows, so it is collected here.
    if (conflict) run.conflicts.set(String(service.id), { service, conflict, ctx, reason: skip.reason_code });
    else if (moveRules.isUnplacedDueDate(service)) needsPerson.collect(run.needsPerson, service, 'move_limit', null);
    else if (ctx.conflictMoves === true) run.clearedIds.add(String(service.id));
  }
  return skip;
}

// Pass 1's one bulk read of every loaded visit's automatic-move count. A
// failed read leaves null: every visit then skips, and the run is degraded.
async function loadRunMoveCounts(run, services) {
  run.moveCounts = await moveLimit.loadMoveCounts(db, services.map((s) => s.id), run.config);
  if (!run.moveCounts) run.guardReadDegraded = true;
}

// Pass 2's recheck: a fresh count for this one visit, so a move another run
// landed since pass 1 is seen. Returns the skip row or null.
async function recheckMoveLimit(pm, run) {
  const counts = await moveLimit.loadMoveCounts(db, [pm.service.id], run.config);
  if (!counts) run.guardReadDegraded = true;
  return moveLimitGate(pm.service, pm.ctx, run, counts);
}

// A day-move guard skip (or a grouped-move refusal), both { code,
// description }, in the { reason_code, reason_description } shape logged.
function guardSkipReason(skip) {
  return { reason_code: skip.code, reason_description: skip.description };
}

// One admin notice per visit that stays without a usable map point after the
// geocode self-heal, so a visit skipped every night is not left to nobody.
// Raised at the run's end under a per-run budget (raiseMissingGeoNotices).
// Best-effort: a notice failure is logged and never fails the run.
async function flagMissingGeo(service) {
  try {
    const date = toDateStr(service.scheduled_date);
    const { shortDateET } = require('../admin-alert-names');
    const notice = await require('../admin-alert-compose').raiseAdminAlert('schedule_conflict', {
      area: 'Schedule',
      action: await audit.namedVisitAction(service.customer_id,
        [(who) => `fix the address pin for ${who}'s visit`, (who) => `fix ${who}'s address pin`],
        'fix the address pin on a visit'),
      why: `Auto-dispatch skips the ${shortDateET(`${date}T12:00:00Z`)} visit until its address pin is fixed.`,
      severity: 'needs-you',
      link: `/admin/dispatch?tab=schedule&date=${date}&appointment=${encodeURIComponent(service.id)}`,
      subject: { type: 'visit', id: String(service.id) },
      doneWhen: 'visit_has_map_pin',
      who: 'person',
    }, {
      // bell: true — under GATE_ADMIN_BELL_POLICY a bell:false notice inserts
      // no row at all. One notice per visit and date (dedupeKey), so it rings
      // once; a recurrence after the run closed it reopens (refreshOnDedupe).
      bell: true,
      dedupeKey: audit.missingGeoKey({ id: service.id, date }),
      refreshOnDedupe: true,
      metadata: { scheduledServiceId: service.id, customerId: service.customer_id, scheduledDate: date },
    });
    // notifyAdmin resolves null when the write fails and a row with no id
    // when it suppresses: neither recorded a notice (Codex #6208 r14 P2).
    // A deduped write rings only when its refresh says so (r16 P2).
    return audit.noticeRang(notice);
  } catch (err) {
    logger.warn(`[auto-dispatch] missing-geo notice failed for ${service && service.id}: ${err.message}`);
    return false;
  }
}

// The missing-pin notice is for a visit on a live plan only: a lapsed plan's
// visit is not placed anyway. Fails open, like isRecurringPlanActive itself.
// The single-visit read, used only just before a NEW notice is raised.
async function missingGeoNoticeWanted(service) {
  try {
    return (await isRecurringPlanActive(service, db)).active;
  } catch (err) {
    logger.warn(`[auto-dispatch] plan check for the missing-geo notice failed for ${service && service.id}: ${err.message}`);
    return true;
  }
}

// Pass 1 only records the visit; nothing rings until the run ends, so a geocoder
// outage cannot raise one bell per visit (raiseMissingGeoNotices).
async function noticeMissingGeo(run, service, planCheck) {
  // A lapsed plan's visit is not placed, so nobody needs to fix its pin: a
  // standing notice for it closes at the run's end. This is the path for a
  // visit eligibility stopped before its own plan check (a stamped address
  // that differs from the customer's; Codex #6208 r6 P2).
  // `planCheck` is the answer eligibilityWithGeoHeal already read. A visit
  // with no answer yet (the divergent-address path, or past the geocode cap)
  // is NOT read here, one query per visit: the run's end reads every
  // collected series in one query (raiseMissingGeoNotices; r27 P2).
  if (planCheck && !planCheck.active) { run.pinOkIds.add(String(service.id)); return; }
  const date = toDateStr(service.scheduled_date);
  run.missingGeoWanted.push({ id: service.id, customer_id: service.customer_id, recurring_parent_id: service.recurring_parent_id, scheduled_date: date, date });
}

// A visit that passed eligibility has a usable pin: the run's end closes a
// standing missing-pin notice for it. Nothing else closes one early.
// A missing-pin visit whose plan has lapsed is no longer placed, so nobody
// needs to fix its pin: a standing notice for it closes at the run's end too
// (Codex #6208 r4 P2).
function logLapsedPlanSkip(run, service, skip) {
  run.pinOkIds.add(String(service.id));
  return logSkip(run, service, skip);
}

function notePinOk(run, service, elig) {
  if (elig.eligible) run.pinOkIds.add(String(service.id));
}

// An ineligible visit's skip: logged, plus the missing-map-point notice.
async function logIneligible(run, service, elig, planCheck) {
  await logSkip(run, service, elig);
  if (elig.reason_code === 'MISSING_GEO') await noticeMissingGeo(run, service, planCheck);
}

// Raise the missing-pin notices pass 1 collected: a visit with a standing
// notice is refreshed free, at most NEW_NOTICES_PER_RUN new ones ring, soonest
// date first. The rest wait for the next run. Best-effort.
// The notices are raised at the run's end, so staff may have fixed a pin (or
// the visit may have moved or closed) since pass 1 skipped it. Re-read the
// picked visits; one that now resolves a pin, or is no longer live on that
// date, raises nothing and joins the close list (Codex #6208 r6 P2).
// The visit is still open on that date for a customer who is still active:
// the conditions the run's own eligibility read applies (Codex #6208 r7 P2).
function stillLiveOn(row, date) {
  return !!row && ['pending', 'confirmed'].includes(String(row.status)) && toDateStr(row.scheduled_date) === date
    && row.customer_active !== false && !row.customer_deleted_at
    // Locked, excluded or customer-confirmed after pass 1: eligibility denies
    // it outright, so it is no longer skipped for its pin (r21, r24 P2).
    && !heldOutOfAutoDispatch(row);
}

async function stillMissingPin(run, picked) {
  if (!picked.length) return [];
  const rows = await db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .whereIn('scheduled_services.id', picked.map((p) => p.id))
    .select('scheduled_services.*', 'customers.latitude as customer_latitude', 'customers.longitude as customer_longitude',
      'customers.address_line1 as customer_address_line1', 'customers.city as customer_city', 'customers.zip as customer_zip',
      'customers.active as customer_active', 'customers.deleted_at as customer_deleted_at');
  const live = new Map((rows || []).map((r) => [String(r.id), r]));
  return picked.filter((p) => {
    const row = live.get(String(p.id));
    const waiting = stillLiveOn(row, p.date) && !resolveGeo(row);
    if (!waiting) run.pinOkIds.add(String(p.id));
    return waiting;
  });
}

async function raiseMissingGeoNotices(run) {
  if (!run.missingGeoWanted.length) return;
  try {
    // Re-read every wanted visit BEFORE the budget picks, so a visit fixed
    // since pass 1 does not hold a slot a later visit needs (Codex #6208 r9 P2).
    const stillOff = await stillMissingPin(run, run.missingGeoWanted);
    // One plan read for every collected series: a lapsed plan's visit raises
    // nothing and joins the close list (r6, r27 P2).
    const lapsed = await lapsedPlanKeys(stillOff, db);
    const waiting = stillOff.filter((row) => {
      if (!lapsed.has(planKey(row))) return true;
      run.pinOkIds.add(String(row.id));
      return false;
    });
    const standing = await audit.standingMissingGeoKeys();
    let left = await audit.ringsLeft();
    // Date order; a slot is spent only by a NEW notice that is raised. The
    // plan is read once more just before a NEW notice (at most the allowance
    // plus the dropped rows): one that lapsed in between raises nothing,
    // joins the close list and leaves its slot (r11 P2). A standing notice is
    // covered by the bulk read above.
    for (const row of audit.withinRingBudget(waiting, standing, Infinity, audit.missingGeoKey)) {
      // Allowance spent: nothing more is raised, a standing notice included.
      if (left <= 0) break;
      if (!standing.has(audit.missingGeoKey(row)) && !(await missingGeoNoticeWanted(row))) { run.pinOkIds.add(String(row.id)); continue; }
      // Only a write that rang spends a slot (r13, r14, r16 P2).
      if (await flagMissingGeo(row)) left -= 1;
    }
  } catch (err) {
    logger.error(`[auto-dispatch] missing-geo notices failed: ${err.message}`);
  }
}

// Close the missing-pin notices of visits whose pin this run found usable (and
// of visits no longer live on that date). Only after a pass 1 that finished
// with no failed visit. Best-effort.
async function closeMissingGeoNotices(run) {
  try {
    if (run.pass1Complete) await audit.retireMissingGeoNotices(run.pinOkIds, run.nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] missing-geo notice close failed: ${err.message}`);
  }
  // A visit the run no longer loads (inside the lock window, locked or
  // excluded) never enters pinOkIds: read every standing notice's own visit
  // too, so a pin fixed late still closes its notice (Codex #6208 r19 P2).
  try {
    await audit.maintainMissingGeoNotices(run.nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] missing-geo notice upkeep failed: ${err.message}`);
  }
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
  if (gate.skip) return logLapsedPlanSkip(run, service, gate.skip);
  notePinOk(run, service, gate.elig);
  if (!gate.elig.eligible) return logIneligible(run, service, gate.elig, gate.planCheck);

  // ── Day-move guard (only when a guard mode is active) ──
  const guard = dayMoveGuarded(guardMode, service)
    ? await resolveDayMoveWindow(guardMode, service, run.guardCtx, run.today, run.nowDate)
    : { window: null, meta: null, skip: null };
  if (guard.skip) return logSkip(run, service, guardSkipReason(guard.skip));

  // Plan-active gate (reuse the result if the geo self-heal already computed it).
  const planCheck = gate.planCheck || await isRecurringPlanActive(service, db);
  if (!planCheck.active) return logSkip(run, service, planCheck);

  const personPlaced = await isPersonPlacedVisit(service, db);
  if (personPlaced.degraded) run.guardReadDegraded = true;
  if (personPlaced.placed) return logSkip(run, service, personPlaced);

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
    // GATE_AUTO_DISPATCH_CONFLICT_MOVES: read the visit's current conflict.
    conflictMoves: config.conflictMovesEnabled === true,
    // ROUTE-TIERS: pre-intersected candidate window (null/absent when the
    // gate is off — candidate-slots then runs its legacy window math).
    ...(guard.window ? { tierWindow: guard.window, tierMeta: guard.meta } : {}),
  };
  // At most N automatic moves per visit: decided before any candidate search.
  const limited = await moveLimitGate(service, ctx, run, run.moveCounts);
  if (limited) return logSkip(run, service, limited);

  const evalResult = await evaluatePlacement(service, prefs, ctx, config, run.lockBoundary);
  totals.evaluated++;
  noteEvaluation(run, service, evalResult, ctx);

  // A grouped move is only as legal as its siblings (Codex #4995 r4 P2) —
  // preview the apply-time member guard now, in every mode (Codex #6055 r2:
  // a person-placed sibling must refuse a dry-run recommendation too), so
  // neither a recommendation nor a planned move carries one apply would refuse.
  const refusal = evalResult.kind === 'move'
    ? await previewGroupMove(service, evalResult.best, { ...config, prefs, lockBoundary: run.lockBoundary })
    : null;
  const noChange = evalResult.kind === 'no_change' ? evalResult : refusal && guardSkipReason(refusal);
  if (noChange) {
    noteUnmoved(run, service, noChange.reason_code);
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
    // An overlap is recommended at the end of the pass, in apply's own order
    // (recommendOverlapFixes), so the dry run names the visit apply would move.
    if (overlapOf(evalResult)) {
      run.dryRunOverlaps.push({ service, result: evalResult });
      return undefined;
    }
    return logDryRunRecommendation(run, service, evalResult);
  }
  run.plannedMoves.push({ service, prefs, ctx, result: evalResult });
  return undefined;
}

// Pass-2 order: due deadlines first (the earliest unplaced due date before
// its placement window closes), then visits in conflict (an overlap or a
// closed day: they cannot stay where they are; cheapest fix first), then
// descending route gain.
function byDueThenImprovement(a, b) {
  const aDue = !a.service.window_start ? toDateStr(a.service.recurring_dispatch_due_date) : null;
  const bDue = !b.service.window_start ? toDateStr(b.service.recurring_dispatch_due_date) : null;
  return Number(!!bDue) - Number(!!aDue)
    || (aDue && bDue ? aDue.localeCompare(bDue) : 0)
    || Number(inConflict(b)) - Number(inConflict(a))
    || cheaperConflictFix(a, b)
    || b.result.improvement - a.result.improvement;
}

// Of two visits in conflict, the one with the cheaper fix goes first: a
// same-day re-time before a day move, then the least added drive. When the
// two overlap each other, the first to move clears the conflict for both
// (the second re-evaluates live and stays), so the cheaper fix is the one
// applied (replay 2026-10-09: load order moved a visit to another day when
// its partner had a free hour the same day).
function cheaperConflictFix(a, b) {
  if (!inConflict(a) || !inConflict(b)) return 0;
  const m = (pm) => (pm.result.audit && pm.result.audit.routeMetrics) || {};
  return Number(!!m(a).day_move) - Number(!!m(b).day_move)
    || (Number(m(b).drive_saving_minutes) || 0) - (Number(m(a).drive_saving_minutes) || 0);
}

function inConflict(pm) {
  return !!(pm.result.current && pm.result.current.conflict);
}

// "Moved (+12.5)", naming the conflict the move cleared when there was one.
const CONFLICT_PHRASE = { overlap: ' off an overlapping stop', closed_day: ' off a closed day' };
function movedDescription(appliedAudit) {
  const conflict = appliedAudit.constraints && appliedAudit.constraints.conflict;
  return `Moved${(conflict && CONFLICT_PHRASE[conflict.kind]) || ''} (${signed(appliedAudit.improvement)})`;
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
    noteUnmoved(run, pm.service, guardSkip.code);
    return audit.logDecision(runId, { action: 'no_change', service: pm.service, reason_code: guardSkip.code, reason_description: guardSkip.description, ...pm.result.audit });
  }

  const limited = await recheckMoveLimit(pm, run);
  if (limited) {
    return audit.logDecision(runId, { action: 'no_change', service: pm.service, reason_code: limited.reason_code, reason_description: limited.reason_description, ...pm.result.audit });
  }

  const fresh = await evaluatePlacement(pm.service, pm.prefs, pm.ctx, config, lockBoundary);
  attempt.fresh = fresh;
  noteEvaluation(run, pm.service, fresh, pm.ctx);
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
    noteUnmoved(run, pm.service, 'MAX_CHANGES_REACHED');
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
    // The conflict that lifted the bar for this move; the move guard re-reads
    // it on the move transaction and refuses when it is gone.
    sourceConflict: (fresh.current && fresh.current.conflict) || null,
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
    reason_description: movedDescription(appliedAudit),
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
  noteUnmoved(run, pm.service, 'ERROR');
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
  // Cards an earlier run held but never summarized get their own push; this
  // run's cards are held under its id for its summary push.
  await require('../tech-visit-notifications').beginAutoDispatchRun(runId);
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
    dryRunOverlaps: [],
    quarantinedIds: new Set(),
    // Visits auto-dispatch cannot fix alone; raised once at run end (needs-person-notice.js).
    needsPerson: new Map(),
    moveCounts: new Map(),
    guardReadDegraded: false, // a failed guard read must not report a green run
    // Visits skipped for a missing pin on a live plan this run, and whether
    // pass 1 looked at every visit (their notices close only then).
    pinOkIds: new Set(),
    missingGeoWanted: [], // visits to raise a missing-pin notice for at the run's end
    pass1Complete: false,
    conflicts: new Map(), // id -> { service, conflict, ctx, reason }: every visit read in conflict (settleConflicts)
    clearedIds: new Set(), // visits read placed and clear with the conflict read on (notice close)
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
    await loadRunMoveCounts(run, services);

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

    run.pass1Complete = totals.failed === 0;

    if (config.mode === 'dry_run') await recommendOverlapFixes(run);
    else await runPassTwo(run);

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
  await raiseMissingGeoNotices(run);
  await closeMissingGeoNotices(run);
  await settleConflicts(run);
  await needsPerson.raiseNotices(run.needsPerson, { nowDate: run.nowDate, clearedIds: run.clearedIds });
  try {
    await audit.completeRun(runId, { status: runStatus, totals, error: runError });
  } finally {
    // One push per tech for the whole run (GATE_AUTO_DISPATCH_PUSH_SUMMARY),
    // after the per-visit cards it summarizes — sent even when the audit
    // update fails, since the per-visit pushes were held (Codex #5786 P2).
    // Best-effort; never throws.
    if (config.mode !== 'dry_run' && totals.changed > 0) {
      await require('../tech-visit-notifications').pushAutoDispatchSummary({ runId });
    }
  }
  logger.info(`[auto-dispatch] run ${runId} ${runStatus} evaluated=${totals.evaluated} skipped=${totals.skipped} recommended=${totals.recommended} changed=${totals.changed} failed=${totals.failed} geocoded=${run.geo.geocoded}/${run.geo.attempts}`);
  return { runId, status: runStatus, geocoded: run.geo.geocoded, geocode_attempts: run.geo.attempts, ...totals };
}

module.exports = { runAutoDispatch, loadEligibleServices, _internals: { loadCapabilityMap, makeCapabilityFn, evaluatePlacement } };
