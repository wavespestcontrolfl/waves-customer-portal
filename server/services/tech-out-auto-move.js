/**
 * "Tech out today" — AUTO-MOVE (PR B, on top of the park-only foundation in
 * services/tech-out.js). GATE_TECH_OUT_AUTO_MOVE, checked TOGETHER with
 * GATE_TECH_OUT_REDISTRIBUTE (autoMoveEnabled below — the canonical
 * call-time reader; the feature-gates map entry is for logGateStatus only).
 *
 * The alerts ARE the queue — no leases, no resume state. One chokepoint,
 * `autoAssignParkedAlert`, takes ONE open `tech_out_overflow` alert and
 * tries to move its stop to another eligible technician at the SAME date +
 * SAME window through the canonical mover (SmartRebooker.reschedule) — the
 * exact primitive every other staff/system reschedule uses. The date never
 * changes, so no series widening can trigger (rescheduleOnce only branches
 * into rescheduleSeries on a DATE delta); seriesPolicy:'single' is pinned
 * anyway, defense in depth.
 *
 * Sends NO customer communication of any kind. SmartRebooker.reschedule
 * itself never touches SMS/email/reminders — every customer-facing text
 * (reschedule confirmation, reminder resync) is composed by the ROUTE layer
 * AFTER the mover returns (routes/admin-dispatch.js's syncRescheduleReminder
 * / applySeriesMoveEffects), which this module never calls. The one
 * notification the mover fires post-commit is tech-visit-notifications.js's
 * notifyAssignmentChange — a STAFF-only in-app/push notice to the two techs
 * involved (CLAUDE.md: "staff-only, never a customer channel"), left on by
 * default here since it is not customer communication.
 *
 * Out of scope, always left parked for a human (never thrown away):
 *   - a grouped visit (alert carries >1 visit_member_ids, or the stop now
 *     carries a visit_id) — `grouped_visit_manual`
 *   - a call booking still awaiting office review (status 'pending', or a
 *     call-review source not yet customer_confirmed) — `office_review_pending`
 *   - anything but a plain 'confirmed' visit, or a live tracker state
 *     (en_route / on_property) — `live_status`
 *   - no eligible candidate technician, or every attempt the mover refused
 *     — `no_eligible_candidate`
 *   - the stop is no longer on the absent tech for that date (already moved,
 *     resolved, or edited elsewhere) — the rebooker's own `expect` CAS pin
 *     misses and this reads as the idempotent no-op `already_resolved`
 */
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const SmartRebooker = require('./rebooker');
const { LIVE_TRACK_STATES } = require('./cancellation-eligibility');
const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
const { applyAssignable, assertAssignableTechnician, NOT_ASSIGNABLE } = require('./technician-eligibility');
const { assertCapabilitiesActive, inactiveCapabilitiesForServices } = require('./technician-capabilities');
const { dayStopsQuery, guardedCoordSelects } = require('./scheduling/day-stops');
const { DEFAULT_EXCLUDE_STATUSES, windowsOverlap } = require('./scheduling/occupancy');
const { arrivalWindowRoutingEnabled, checkArrivalPlacement } = require('./scheduling/arrival-route');
const { resolveGeo, driveMin, HQ } = require('./auto-dispatch/geo');
const { resolveAlert, emitAlert } = require('./dispatch-alerts');
const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('./dispatch-assignment');
const { ALERT_TYPE, ABSENT_STOP_EXCLUDE_STATUSES, rankBumpOrder } = require('./tech-out');
const { LIVE_COMPLETION_CLAIM_STATUSES, lockStopForRow } = require('./visit-groups');

// Statuses that occupy no route capacity — exactly what the rebooker's
// probeMoveConflicts excludes (NOT_A_ROUTE_STOP_STATUSES + completed).
const FIT_EXCLUDE_STATUSES = [...DEFAULT_EXCLUDE_STATUSES, 'completed'];

// Up to this many fitting candidates get a real move attempt (best detour
// first) before an alert gives up and stays parked for a human.
const MAX_MOVE_ATTEMPTS = 3;

function autoMoveEnabled() {
  return gateEnvValue('GATE_TECH_OUT_AUTO_MOVE') && gateEnvValue('GATE_TECH_OUT_REDISTRIBUTE');
}

function timeToMinutes(value) {
  if (value == null || value === '') return null;
  const [h, m] = String(value).split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

function minutesToTime(minutes) {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A non-available tech_schedule_blocks row (this tech's, or crew-wide) overlapping the window. */
async function blockedBySchedule(techId, date, startMin, endMin, conn = db) {
  const blocks = await conn('tech_schedule_blocks')
    .where({ date })
    .whereNot('block_type', 'available')
    .where((q) => q.where('technician_id', techId).orWhereNull('technician_id'))
    .select('start_time', 'end_time');
  return blocks.some((b) => {
    const bStart = timeToMinutes(b.start_time);
    const bEnd = timeToMinutes(b.end_time);
    if (bStart == null || bEnd == null) return false;
    return windowsOverlap(startMin, endMin, bStart, bEnd);
  });
}

/**
 * Per-candidate fit for one (stop, candidate tech) pair at the stop's own
 * window. The mover's commit-time occupancy probe is checked ONCE per stop
 * in autoAssignParkedAlert (it is tech-blind, so it is the same answer for
 * every candidate); this adds what that probe does not model per tech —
 * the candidate's own route (arrival placement when that routing model is
 * on, else a plain overlap read of the candidate's day) and, on EVERY path,
 * the candidate's tech_schedule_blocks. Everything here is stricter than
 * the commit, never looser, so a certified candidate is not refused for a
 * reason selection skipped.
 */
async function fitsWindow(stop, tech, date, conn = db) {
  if (!stop.window_start) return { fits: false, conflict_reason: 'no_window' };
  const windowStart = stop.window_start;
  const durationMinutes = Number(stop.estimated_duration_minutes) || 60;
  const startMin = timeToMinutes(windowStart);
  const endMin = timeToMinutes(stop.window_end) ?? (startMin + durationMinutes);
  const windowEnd = stop.window_end || minutesToTime(endMin);

  if (arrivalWindowRoutingEnabled()) {
    const fit = await checkArrivalPlacement({
      conn,
      serviceId: stop.id,
      date,
      technicianId: tech.id,
      excludeServiceIds: [stop.id],
      windowStart,
      windowEnd,
      durationMinutes,
      // The stop being placed is still sitting on the ABSENT tech — its own
      // current live-route membership must not gate a DIFFERENT candidate.
      treatTargetAsPending: true,
    });
    if (!fit.feasible) return { fits: false, conflict_reason: fit.reason };
  } else {
    const others = await conn('scheduled_services')
      .where({ scheduled_date: date, technician_id: tech.id })
      .whereNot('id', stop.id)
      // Same status set as the rebooker's commit probe: a finished visit
      // occupies nothing (never stricter than the commit, Codex r9 P2).
      .whereNotIn('status', FIT_EXCLUDE_STATUSES)
      // A lapsed estimate hold occupies nothing — same predicate as the
      // rebooker's kept-tech check and scheduling/occupancy.js.
      .where((q) => q.whereNull('reservation_expires_at').orWhereRaw('reservation_expires_at > NOW()'))
      .select('window_start', 'window_end', 'estimated_duration_minutes');
    const conflict = others.some((row) => {
      const oStart = timeToMinutes(row.window_start);
      if (oStart == null) return false;
      const oEnd = timeToMinutes(row.window_end) ?? (oStart + (Number(row.estimated_duration_minutes) || 60));
      return windowsOverlap(startMin, endMin, oStart, oEnd);
    });
    if (conflict) return { fits: false, conflict_reason: 'overlap' };
  }

  return (await blockedBySchedule(tech.id, date, startMin, endMin, conn))
    ? { fits: false, conflict_reason: 'schedule_block' }
    : { fits: true };
}

/** Marginal detour + stop count a tech's day would take on if it absorbed `stop`. */
async function detourForTech(stop, techId, date) {
  const geo = resolveGeo(stop);
  const rows = await dayStopsQuery(db, {
    dateStr: date,
    technicianId: techId,
    excludeStatuses: FIT_EXCLUDE_STATUSES,
    select: [
      'scheduled_services.id', 'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.reservation_expires_at',
      ...guardedCoordSelects(db),
    ],
  });
  // A lapsed estimate hold is not a route stop (same predicate as fitsWindow
  // and the rebooker's commit check) — never a count or an anchor.
  const now = Date.now();
  const neighbors = rows.filter((r) => r.id !== stop.id
    && (r.reservation_expires_at == null || new Date(r.reservation_expires_at).getTime() > now));
  if (!geo) return { detour_minutes: null, stops_that_day: neighbors.length + 1 };

  const myStart = timeToMinutes(stop.window_start) ?? 0;
  const sorted = neighbors
    .map((r) => {
      const startMin = timeToMinutes(r.window_start) ?? 0;
      const endMin = timeToMinutes(r.window_end) ?? (startMin + (Number(r.estimated_duration_minutes) || 60));
      return { geo: resolveGeo(r), startMin, endMin };
    })
    .filter((n) => n.geo)
    .sort((a, b) => a.startMin - b.startMin);

  const anchors = [{ geo: HQ, startMin: -Infinity }, ...sorted, { geo: HQ, startMin: Infinity }];
  let prev = anchors[0];
  let next = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length; i += 1) if (anchors[i].startMin <= myStart) prev = anchors[i];
  for (let i = anchors.length - 1; i >= 0; i -= 1) if (anchors[i].startMin >= myStart) next = anchors[i];

  const detour = Math.max(0, driveMin(prev.geo, geo) + driveMin(geo, next.geo) - driveMin(prev.geo, next.geo));
  return { detour_minutes: detour, stops_that_day: neighbors.length + 1 };
}

// Lower marginal detour first; a candidate with no resolvable geo sorts
// after every candidate that has one (never preferred over a measured
// route cost); ties (including "neither has geo") break on fewest stops
// already on that tech's day, then technician id for determinism.
function compareCandidates(a, b) {
  if (a.detour_minutes == null && b.detour_minutes == null) {
    return a.stops_that_day - b.stops_that_day || String(a.tech.id).localeCompare(String(b.tech.id));
  }
  if (a.detour_minutes == null) return 1;
  if (b.detour_minutes == null) return -1;
  if (a.detour_minutes !== b.detour_minutes) return a.detour_minutes - b.detour_minutes;
  return a.stops_that_day - b.stops_that_day || String(a.tech.id).localeCompare(String(b.tech.id));
}

/**
 * Rank the crew (excluding the absent tech, already filtered by the
 * caller) for `stop`: fitting candidates only, best detour/lightest day
 * first. Sequential fit checks by design — a small crew, and each check's
 * own DB read must be consistent with itself, not with an artificial
 * batch snapshot.
 */
async function rankCandidates(stop, crew, date) {
  if (!crew.length) return [];
  const inactive = await inactiveCapabilitiesForServices(db, crew.map((c) => c.id), [{ service_type: stop.service_type }]);
  const inactiveIds = new Set(inactive.map((r) => r.technician_id));

  const ranked = [];
  for (const tech of crew) {
    if (inactiveIds.has(tech.id)) continue;
    const fit = await fitsWindow(stop, tech, date);
    if (!fit.fits) continue;
    const { detour_minutes, stops_that_day } = await detourForTech(stop, tech.id, date);
    ranked.push({ tech, detour_minutes, stops_that_day });
  }
  ranked.sort(compareCandidates);
  return ranked;
}

/** Merge one key into an alert's JSONB payload without disturbing the rest. */
async function mergePayload(trx, alertId, patch) {
  await trx('dispatch_alerts')
    .where({ id: alertId })
    .update({
      payload: trx.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify(patch)]),
    });
}

/**
 * Stamp payload.auto_attempt on a still-open card and re-broadcast it.
 * `stillParked` ({ jobId, absentTechId, date }) makes the write conditional,
 * in the same statement, on the stop still being an open stop on the absent
 * tech's day — so a reassignment that landed after our read can never be
 * annotated onto a now-stale card. Returns whether a row was written.
 */
async function annotateAttempt(alertId, reason, stillParked = null) {
  try {
    const q = db('dispatch_alerts')
      .where({ id: alertId })
      .whereNull('resolved_at');
    if (stillParked) {
      q.whereExists(db('scheduled_services')
        .select(db.raw('1'))
        .where({ id: stillParked.jobId, technician_id: stillParked.absentTechId, scheduled_date: stillParked.date })
        .whereNotIn('status', ABSENT_STOP_EXCLUDE_STATUSES)
        .where((w) => w.whereNull('track_state').orWhereNot('track_state', 'complete')));
    }
    const [row] = await q
      .update({
        payload: db.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ auto_attempt: { at: new Date().toISOString(), reason } })]),
      })
      .returning(['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by']);
    // Re-broadcast the still-open card so every open board shows the reason
    // now (useDispatchAlerts merges a known id), not after a reload.
    if (row) emitAlert(row);
    return !!row;
  } catch (err) {
    logger.warn(`[tech-out-auto-move] failed to annotate alert ${alertId} (${reason}): ${err.message}`);
    return true; // unknown — never close a card on a failed write
  }
}

const NO_FIT = 'TECH_OUT_AUTO_MOVE_NO_FIT';

/**
 * The receiving technician, re-checked inside the mover's own transaction
 * (moveGuard runs after its destination tech-day fence): capabilities, then
 * the same per-tech fit ranking used — arrival placement or plain overlap,
 * plus schedule blocks. An assignment that landed on that technician after
 * ranking (the fence made us wait for it) is seen here, so the rebooker's
 * tech-blind probe is never the only commit-time check of this route.
 */
function makeMoveGuard(stop, date) {
  return async ({ trx, technicianId, service }) => {
    await assertCapabilitiesActive(trx, technicianId, [service], (rowId, why) => Object.assign(
      new Error(`Cannot auto-move stop ${rowId}: ${why}`),
      { statusCode: 409, status: 409, code: 'TECH_OUT_AUTO_MOVE_CAPABILITY_GUARD', isOperational: true },
    ));
    const fit = await fitsWindow(stop, { id: technicianId }, date, trx);
    if (!fit.fits) {
      throw Object.assign(new Error(`Technician no longer fits this window (${fit.conflict_reason})`), {
        statusCode: 409, status: 409, code: NO_FIT, isOperational: true,
      });
    }
  };
}

// Refusals from the in-transaction recheck below: the absence was cleared
// ("Tech is back") or the alert was resolved/dismissed after this run read
// it. Either way there is nothing left to do — a no-op, never a retry on
// the next candidate.
const STALE_CODES = new Set(['TECH_OUT_CLEARED', 'TECH_OUT_ALERT_RESOLVED']);
// A completion holds a live claim on the stop: no candidate can take it now.
const COMPLETION_IN_FLIGHT = 'TECH_OUT_COMPLETION_IN_FLIGHT';

/**
 * Runs inside the mover's own transaction (options.beforeMove — after its
 * date-occupancy + destination tech-day fences, before any row lock or
 * write). Re-reads the absence and the alert FOR SHARE: clearTechOut takes
 * the absence FOR UPDATE and resolveAlert UPDATEs the alert, so each either
 * commits before this read (and the move refuses) or waits for this move to
 * commit. clearTechOut never waits on a lock this transaction holds (its
 * only other lock is the ABSENT tech-day fence, which the mover does not
 * take), so the wait cannot cycle.
 */
function makeStillParkedGuard({ alertId, absentTechId, date, stopId, toTechId, actorId }) {
  return async (trx) => {
    // A completion already claimed this visit (the claim touches none of the
    // expect-pinned fields, and the single-row mover has no claim guard):
    // reassigning it now would let the completion finish under the old tech.
    // Checked under the stop lock the completion writer takes before it
    // inserts its claim (complete-scheduled-service.js), held through this
    // move — so a claim either landed first (refused here) or waits for the
    // move to commit. Same relative position the rebooker's own solo-visit
    // recheck takes this lock in (after the date/tech fences, before any
    // row lock), so it adds no ordering inversion. A stop that moved under
    // the peek (VISIT_STOP_MOVED) surfaces as a plain CAS-style 409.
    try {
      await lockStopForRow(trx, stopId);
    } catch (lockErr) {
      if (lockErr && lockErr.code === 'VISIT_STOP_MOVED') {
        throw Object.assign(new Error('The stop changed concurrently'), { statusCode: 409 });
      }
      throw lockErr;
    }
    const liveClaim = await trx('service_completion_attempts')
      .where({ service_id: stopId })
      .whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES)
      .first('id');
    if (liveClaim) {
      throw Object.assign(new Error('This visit is being completed'), { statusCode: 409, code: COMPLETION_IN_FLIGHT });
    }
    const absence = await trx('technician_absences')
      .where({ technician_id: absentTechId, absence_date: date })
      .whereNull('cleared_at')
      .forShare()
      .first('id');
    if (!absence) {
      throw Object.assign(new Error('Technician is no longer marked out for this date'), { statusCode: 409, code: 'TECH_OUT_CLEARED' });
    }
    const alert = await trx('dispatch_alerts')
      .where({ id: alertId })
      .whereNull('resolved_at')
      .forShare()
      .first('id');
    if (!alert) {
      throw Object.assign(new Error('Overflow alert was already resolved'), { statusCode: 409, code: 'TECH_OUT_ALERT_RESOLVED' });
    }
    // Resolve the card on the MOVE's own transaction: the stop moving and
    // its alert closing commit (or roll back) together, so a crash between
    // them can never leave a moved stop with an open card. resolveAlert
    // broadcasts only after the outer commit. auto:true — a systemic
    // resolution, not a manual dismiss (same convention as clearTechOut).
    await mergePayload(trx, alertId, { auto_moved: { to_technician_id: toTechId, at: new Date().toISOString() } });
    await resolveAlert({ id: alertId, resolvedBy: actorId || null, trx, auto: true });
  };
}

/**
 * Load the alert + its stop and decide whether there is anything for the
 * chokepoint to even ATTEMPT. Returns one of:
 *   { done: <the chokepoint's own return value> }  — skip/refuse, already annotated if needed
 *   { stop, date, absentTechId }                    — movable; caller ranks candidates and attempts the move
 * Split out of autoAssignParkedAlert to keep its own complexity readable —
 * every branch here is a scope exclusion or an idempotency check, never a
 * move attempt.
 */
/**
 * Pure: why `stop` (as read right now) cannot be attempted, or null if it
 * can. `skipped: true` means idempotent no-op (never annotated — nothing
 * changed that a dispatcher needs telling about); `skipped: false` means a
 * scope exclusion worth annotating on the alert for AlertCard to show.
 */
function stopMoveRefusal(stop, absentTechId, date) {
  if (!stop) return { reason: 'stop_not_found', skipped: false };
  const scheduledDateStr = stop.scheduled_date instanceof Date
    ? stop.scheduled_date.toISOString().slice(0, 10)
    : String(stop.scheduled_date || '').slice(0, 10);
  // Stale card: the stop already left the absent tech's day by some other
  // path (a dispatcher's reassignment, a prior run, a date move), or is
  // finished / superseded. Nothing to move; the caller closes the card.
  // A status the parking query itself no longer selects (completed,
  // cancelled, skipped, no_show, rescheduled, on_site) means the stop no
  // longer needs reassigning either — same list, so both sides agree.
  if (String(stop.technician_id || '') !== String(absentTechId || '')
    || scheduledDateStr !== String(date)
    || ABSENT_STOP_EXCLUDE_STATUSES.includes(String(stop.status))
    // Geofence auto-completion advances the tracker to 'complete' without
    // touching status — a finished visit, same as status 'completed'.
    || stop.track_state === 'complete') {
    return { reason: 'already_resolved', skipped: true, stale: true };
  }
  // A grouped visit the alert didn't know about (grouped after park) is a
  // human decision, same as the up-front alert-payload check.
  if (stop.visit_id) return { reason: 'grouped_visit_manual', skipped: false };
  // A call booking still awaiting office review is never touched: the
  // mover's post-commit legacy activation would confirm it (reminders, lead
  // conversion, review card) as a side effect of a technician change.
  if (stop.status === 'pending'
    || (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(stop.source_action) && !stop.customer_confirmed)) {
    return { reason: 'office_review_pending', skipped: false };
  }
  // Only a plain confirmed visit moves; anything else is live or terminal.
  if (stop.status !== 'confirmed') return { reason: 'live_status', skipped: false };
  // The tracker can go live (en_route / on_property) before the operational
  // status syncs, so a 'confirmed' row may already be an active visit.
  if (LIVE_TRACK_STATES.includes(String(stop.track_state))) return { reason: 'live_status', skipped: false };
  return null;
}

// guardedCoordSelects reads customers.* as the coordinate fallback, so the
// customer join is required (not optional) for this select to parse.
function readStop(jobId) {
  return db('scheduled_services')
    .leftJoin('customers', 'customers.id', 'scheduled_services.customer_id')
    .where('scheduled_services.id', jobId)
    .first(
      'scheduled_services.id', 'scheduled_services.status', 'scheduled_services.service_type',
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.visit_id',
      'scheduled_services.technician_id', 'scheduled_services.scheduled_date',
      'scheduled_services.customer_id', 'scheduled_services.track_state',
      'scheduled_services.source_action', 'scheduled_services.customer_confirmed', ...guardedCoordSelects(db),
    );
}

async function loadMovableStop(alertId) {
  const alert = await db('dispatch_alerts').where({ id: alertId }).first();
  if (!alert) return { done: { moved: false, alert_id: alertId, skipped: 'alert_not_found' } };
  if (alert.type !== ALERT_TYPE) return { done: { moved: false, alert_id: alertId, skipped: 'wrong_type' } };
  if (alert.resolved_at) return { done: { moved: false, alert_id: alertId, skipped: 'already_resolved' } };

  const payload = (typeof alert.payload === 'string' ? JSON.parse(alert.payload) : alert.payload) || {};
  const date = payload.date;
  const absentTechId = alert.tech_id;

  const memberIds = Array.isArray(payload.visit_member_ids) ? payload.visit_member_ids : null;
  const jobId = alert.job_id || (memberIds && memberIds[0]) || null;
  if (!jobId) {
    await annotateAttempt(alertId, 'no_job_reference');
    return { done: { moved: false, alert_id: alertId, reason: 'no_job_reference' } };
  }

  // Stale check FIRST, grouped cards included: a card whose own stop left
  // the absent day is closed, never re-annotated as a grouped refusal.
  const stop = await readStop(jobId);
  const staleCheck = stopMoveRefusal(stop, absentTechId, date);
  if (staleCheck && staleCheck.stale) {
    await resolveStaleAlert(alertId);
    return { done: { moved: false, alert_id: alertId, skipped: 'already_resolved' } };
  }
  // Grouped units are a human decision (PR B scope) — judged on the stop's
  // CURRENT membership (stop.visit_id, refused in stopMoveRefusal), never the
  // card's parking-time visit_member_ids: a group that dissolved since leaves
  // an ordinary stop that may move; its former siblings still on the absent
  // tech are re-parked by the sweep once this card resolves (covers nothing).

  // Any other refusal (scope exclusion) is worth telling a dispatcher about.
  if (staleCheck) return { done: await refuseOrClose(alertId, staleCheck.reason, jobId, absentTechId, date) };
  return { stop, date, absentTechId };
}

/**
 * Active + field-dispatchable technicians, not the absent tech, ranked
 * best-fit first for `stop` on `date`. assertAssignableTechnician is the
 * single canonical source of truth for BOTH flags together (and for
 * "also absent on this date") — called per candidate here, right before
 * ranking, so a race between the crew read and this check is still caught.
 */
async function resolveStaleAlert(alertId) {
  try {
    await resolveAlert({ id: alertId, resolvedBy: null, auto: true });
  } catch (err) {
    logger.warn(`[tech-out-auto-move] failed to close stale alert ${alertId}: ${err.message}`);
  }
}

/** Open stops still on the absent tech that day (the batch the mover may pass over). */
async function eligibleRankedCandidates(stop, absentTechId, date) {
  const crew = await applyAssignable(db('technicians'))
    .whereNot('technicians.id', absentTechId)
    .select('technicians.id', 'technicians.name');
  const eligible = [];
  for (const tech of crew) {
    try {
      await assertAssignableTechnician(tech.id, { conn: db, date });
      eligible.push(tech);
    } catch (err) {
      if (err.code !== NOT_ASSIGNABLE) throw err;
    }
  }
  if (!eligible.length) return [];
  return rankCandidates(stop, eligible, date);
}

/** Refusal reason for the last mover error once every attempt is spent. */
function refusalReason(lastErr) {
  if (!lastErr) return 'no_eligible_candidate';
  // Grouped into a visit between our read and the move: the same
  // manual-decision rule as the up-front visit_id check.
  if (lastErr.code === 'VISIT_MEMBERSHIP_CHANGED') return 'grouped_visit_manual';
  if (lastErr.code === NO_FIT) return 'no_eligible_candidate';
  if (lastErr.code === COMPLETION_IN_FLIGHT) return 'completion_in_progress';
  return `move_failed: ${lastErr.message}`;
}

/**
 * Try the ranked candidates in order through the canonical mover. The
 * alert resolves inside the successful move's own transaction (beforeMove),
 * so anything thrown here means nothing committed for that candidate.
 */
async function attemptMoves({ alertId, actorId, stop, date, absentTechId, window, candidates, qualityDates }) {
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      await SmartRebooker.reschedule(
        // 'admin': a dispatcher pressed the button, and the date never
        // changes — the owner-blackout and seasonal guards that bind
        // customer/system date moves do not apply to a same-day reassignment
        // (same initiator as the board's own manual moves).
        stop.id, date, window, 'tech_out_auto_move', 'admin',
        {
          technicianId: candidate.tech.id,
          keepStatus: true,
          seriesPolicy: 'single',
          // Never the whole-visit mover: with visitPolicy 'single' the unit
          // branch is skipped and the single-row CAS carries expect.visit_id
          // IS NULL, so a stop grouped after our read refuses (409) instead
          // of widening into a move of every member. The unit mover honors
          // `expect` only on its no-op branch, so pinning expect alone is
          // not enough.
          visitPolicy: 'single',
          actorId: actorId || null,
          // Schedule-quality refresh is collected, not run per move — the
          // caller flushes every touched date once (qualityDates contract).
          qualityDates,
          // Atomic re-assertion, inside the mover's own move transaction, of
          // exactly what was read: a concurrent change (manual reassignment,
          // a second run, a status edit) misses this CAS as a plain 409.
          expect: {
            visit_id: null,
            technician_id: absentTechId,
            scheduled_date: date,
            window_start: stop.window_start,
            window_end: stop.window_end,
            status: stop.status,
            // The non-live tracker state we read: a tech going en_route or
            // on_property after that read misses this CAS (409), never moves.
            track_state: stop.track_state ?? null,
            // Pinned so a row cannot slip into office review mid-move.
            customer_confirmed: stop.customer_confirmed ?? null,
            // The span the in-transaction fit (moveGuard) derives an
            // open-ended window from — an edit after ranking misses the CAS.
            estimated_duration_minutes: stop.estimated_duration_minutes ?? null,
            // The category moveGuard checked capabilities against.
            service_type: stop.service_type ?? null,
          },
          moveGuard: makeMoveGuard(stop, date),
          beforeMove: makeStillParkedGuard({
            alertId, absentTechId, date, stopId: stop.id, toTechId: candidate.tech.id, actorId,
          }),
        },
      );
    } catch (err) {
      if (err && STALE_CODES.has(err.code)) return { moved: false, alert_id: alertId, skipped: 'already_resolved' };
      lastErr = err;
      // A plain 409 is the expect CAS missing — the stop itself changed, so
      // no other candidate can succeed; the caller's refuseOrClose re-reads
      // it and closes a now-stale card (a racing manual reassignment).
      if (err && (err.statusCode === 409 || err.status === 409) && !err.code) break;
      // Same answer for every candidate: stop and let the next run re-read.
      if (err && (err.code === 'VISIT_MEMBERSHIP_CHANGED' || err.code === COMPLETION_IN_FLIGHT)) break;
      continue;
    }
    // Committed (stop + alert). The board broadcast is best-effort.
    try {
      await emitDispatchJobUpdate({ jobId: stop.id, actorId: actorId || null, qualityDates });
    } catch (broadcastErr) {
      logger.warn(`[tech-out-auto-move] board broadcast failed for ${stop.id}: ${broadcastErr.message}`);
    }
    return { moved: true, alert_id: alertId, job_id: stop.id, to_technician_id: candidate.tech.id };
  }
  return { moved: false, alert_id: alertId, reason: refusalReason(lastErr) };
}

/**
 * Take ONE open `tech_out_overflow` alert and try to move its stop to
 * another eligible technician at the same date + window. Returns:
 *   { moved: true,  alert_id, to_technician_id }
 *   { moved: false, alert_id, reason }               — refused, alert stays open
 *   { moved: false, alert_id, skipped: '<reason>' }   — not our alert / already handled
 *
 * Idempotent: an alert that is missing, not this type, already resolved, or
 * whose stop no longer sits on the absent tech for that date is a no-op —
 * never thrown away, never double-moved.
 */
async function autoAssignParkedAlert({ alertId, actorId, qualityDates = null } = {}) {
  if (!autoMoveEnabled()) return { moved: false, alert_id: alertId, skipped: 'gate_off' };
  if (!alertId) throw Object.assign(new Error('alertId is required'), { status: 400, code: 'VALIDATION' });
  // A batch passes its own Set and flushes once; a lone call owns its flush.
  if (!qualityDates) {
    const own = new Set();
    try {
      return await autoAssignParkedAlert({ alertId, actorId, qualityDates: own });
    } finally {
      await flushDispatchQualityDates(own);
    }
  }

  const loaded = await loadMovableStop(alertId);
  if (loaded.done) return loaded.done;
  const { stop, date, absentTechId } = loaded;

  // The mover's commit probe, read-only and with the SAME options the move
  // passes below: selection never certifies a move the commit would refuse.
  // That probe is tech-blind by design (one active field tech; see
  // scheduling/occupancy.js) and sees EVERY live stop — the absent tech's
  // other stops included, deliberately: no exclusion list can tell which of
  // them will really leave that window (Codex r3–r5 on #4759), so a window
  // any other live stop overlaps stays parked for a human.
  const window = { start: stop.window_start, end: stop.window_end };
  const conflicts = await SmartRebooker.previewMoveConflicts(stop.id, date, window);
  if (conflicts.length) return refuseOrClose(alertId, 'window_occupied', stop.id, absentTechId, date);

  const ranked = await eligibleRankedCandidates(stop, absentTechId, date);
  if (!ranked.length) return refuseOrClose(alertId, 'no_eligible_candidate', stop.id, absentTechId, date);

  const outcome = await attemptMoves({
    alertId, actorId, stop, date, absentTechId, window, qualityDates,
    candidates: ranked.slice(0, MAX_MOVE_ATTEMPTS),
  });
  if (outcome.moved || outcome.skipped) return outcome;
  return refuseOrClose(alertId, outcome.reason, stop.id, absentTechId, date);
}

/**
 * The ONE exit for a refusal after the stop was loaded. The stop may have
 * left the absent tech's day while this run ranked / probed / attempted (a
 * racing manual reassignment, a status change): a stale card is closed,
 * never annotated and left open as a phantom.
 */
async function refuseOrClose(alertId, reason, stopId, absentTechId, date) {
  // One conditional statement: annotate only while the stop is still open on
  // the absent day; nothing written ⇒ the card went stale (or was resolved)
  // meanwhile, so close it. The 5-minute sweep reconciles anything later.
  const written = await annotateAttempt(alertId, reason, { jobId: stopId, absentTechId, date });
  if (!written) {
    await resolveStaleAlert(alertId);
    return { moved: false, alert_id: alertId, skipped: 'already_resolved' };
  }
  return { moved: false, alert_id: alertId, reason };
}

/**
 * Process every OPEN `tech_out_overflow` alert for one tech-day, most-
 * protected unit first (mostProtectedFirst — "bump last" stops get first
 * pick of the day's open capacity while it's still there). Each alert runs
 * through the one chokepoint above in its own mover transaction; a failure
 * on one alert never stops the rest.
 */
/**
 * Order a tech-day's open cards most-protected first. payload.bump_order is
 * batch-local (mark-out numbers from 1, and every sweep batch of late
 * arrivals restarts at 1), so it cannot compare cards across batches:
 * re-score each card's CURRENT stop with the same rankBumpOrder the parking
 * used, and walk that "bump first" order backwards. A card whose stop is
 * gone sorts last (the chokepoint closes it as stale).
 */
async function mostProtectedFirst(alerts) {
  const jobIds = alerts.map((a) => a.job_id).filter(Boolean);
  const stops = jobIds.length
    ? await db('scheduled_services').whereIn('id', jobIds).select('id', 'is_recurring', 'status', 'window_start')
    : [];
  const byJob = new Map(stops.map((st) => [String(st.id), st]));
  const known = alerts.filter((a) => a.job_id && byJob.has(String(a.job_id)));
  const unknown = alerts.filter((a) => !(a.job_id && byJob.has(String(a.job_id))));
  const bumpFirst = rankBumpOrder(known.map((a) => ({ ...byJob.get(String(a.job_id)), alert_id: a.id })));
  return [
    ...bumpFirst.reverse().map((r) => ({ id: r.alert_id, job_id: r.id })),
    ...unknown.map((a) => ({ id: a.id, job_id: a.job_id || null })),
  ];
}

async function autoAssignTechDay({ technicianId, date, actorId } = {}) {
  if (!autoMoveEnabled()) return { skipped: 'gate_off', moved: [], left_parked: [] };
  if (!technicianId || !date) {
    throw Object.assign(new Error('technicianId and date are required'), { status: 400, code: 'VALIDATION' });
  }

  const alerts = await mostProtectedFirst(await db('dispatch_alerts')
    .where({ type: ALERT_TYPE, tech_id: technicianId })
    .whereNull('resolved_at')
    .whereRaw("payload->>'date' = ?", [date])
    .select('id', 'job_id'));

  const moved = [];
  const left_parked = [];
  const failed = [];
  // One schedule-quality refresh for the whole run, after every move.
  const qualityDates = new Set();
  try {
    for (const { id, job_id: jobId } of alerts) {
      let result;
      try {
        result = await autoAssignParkedAlert({ alertId: id, actorId, qualityDates });
      } catch (err) {
        // Isolated: one alert's unexpected failure never stops the rest. The
        // card says so (safe reason, never the raw error) and the response
        // reports it, so the drawer can say the run was not a clean zero.
        logger.error(`[tech-out-auto-move] alert ${id} threw during batch auto-assign: ${err.message}`);
        // Same stale-aware exit as every other refusal: a card whose stop
        // left the absent day meanwhile is closed, not stamped as failed.
        let closedAsStale = false;
        if (jobId) {
          closedAsStale = !!(await refuseOrClose(id, 'auto_move_error', jobId, technicianId, date)).skipped;
        } else {
          await annotateAttempt(id, 'auto_move_error');
        }
        if (!closedAsStale) failed.push({ alert_id: id, reason: 'auto_move_error' });
        continue;
      }
      if (result.moved) moved.push(result);
      else if (!result.skipped) left_parked.push({ alert_id: id, reason: result.reason });
    }
  } finally {
    await flushDispatchQualityDates(qualityDates);
  }
  return { moved, left_parked, failed };
}

module.exports = {
  autoMoveEnabled,
  autoAssignParkedAlert,
  autoAssignTechDay,
  MAX_MOVE_ATTEMPTS,
  _test: { fitsWindow, detourForTech, compareCandidates, rankCandidates },
};
