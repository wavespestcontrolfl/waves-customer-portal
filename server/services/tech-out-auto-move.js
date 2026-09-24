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
 *   - any member status not in RESCHEDULABLE_STATUSES (en_route / on_site /
 *     in_progress / any other live or terminal state) — `live_status`
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
const { RESCHEDULABLE_STATUSES } = require('./reschedule-eligibility');
const { LIVE_TRACK_STATES } = require('./cancellation-eligibility');
const { applyAssignable, assertAssignableTechnician, NOT_ASSIGNABLE } = require('./technician-eligibility');
const { assertCapabilitiesActive, inactiveCapabilitiesForServices } = require('./technician-capabilities');
const { dayStopsQuery, guardedCoordSelects } = require('./scheduling/day-stops');
const { DEFAULT_EXCLUDE_STATUSES, windowsOverlap } = require('./scheduling/occupancy');
const { arrivalWindowRoutingEnabled, checkArrivalPlacement } = require('./scheduling/arrival-route');
const { resolveGeo, driveMin, HQ } = require('./auto-dispatch/geo');
const { resolveAlert, emitAlert } = require('./dispatch-alerts');
const { emitDispatchJobUpdate } = require('./dispatch-assignment');
const { ALERT_TYPE } = require('./tech-out');

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
async function blockedBySchedule(techId, date, startMin, endMin) {
  const blocks = await db('tech_schedule_blocks')
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
async function fitsWindow(stop, tech, date) {
  if (!stop.window_start) return { fits: false, conflict_reason: 'no_window' };
  const windowStart = stop.window_start;
  const durationMinutes = Number(stop.estimated_duration_minutes) || 60;
  const startMin = timeToMinutes(windowStart);
  const endMin = timeToMinutes(stop.window_end) ?? (startMin + durationMinutes);
  const windowEnd = stop.window_end || minutesToTime(endMin);

  if (arrivalWindowRoutingEnabled()) {
    const fit = await checkArrivalPlacement({
      conn: db,
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
    const others = await db('scheduled_services')
      .where({ scheduled_date: date, technician_id: tech.id })
      .whereNot('id', stop.id)
      .whereNotIn('status', DEFAULT_EXCLUDE_STATUSES)
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

  return (await blockedBySchedule(tech.id, date, startMin, endMin))
    ? { fits: false, conflict_reason: 'schedule_block' }
    : { fits: true };
}

/** Marginal detour + stop count a tech's day would take on if it absorbed `stop`. */
async function detourForTech(stop, techId, date) {
  const geo = resolveGeo(stop);
  const rows = await dayStopsQuery(db, {
    dateStr: date,
    technicianId: techId,
    excludeStatuses: DEFAULT_EXCLUDE_STATUSES,
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

async function annotateAttempt(alertId, reason) {
  try {
    const [row] = await db('dispatch_alerts')
      .where({ id: alertId })
      .whereNull('resolved_at')
      .update({
        payload: db.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ auto_attempt: { at: new Date().toISOString(), reason } })]),
      })
      .returning(['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by']);
    // Re-broadcast the still-open card so every open board shows the reason
    // now (useDispatchAlerts merges a known id), not after a reload.
    if (row) emitAlert(row);
  } catch (err) {
    logger.warn(`[tech-out-auto-move] failed to annotate alert ${alertId} (${reason}): ${err.message}`);
  }
}

/** The receiving technician's capability guard, re-checked atomically inside the mover's own transaction. */
function makeCapabilityGuard() {
  return async ({ trx, technicianId, service }) => {
    await assertCapabilitiesActive(trx, technicianId, [service], (rowId, why) => Object.assign(
      new Error(`Cannot auto-move stop ${rowId}: ${why}`),
      { statusCode: 409, status: 409, code: 'TECH_OUT_AUTO_MOVE_CAPABILITY_GUARD', isOperational: true },
    ));
  };
}

// Refusals from the in-transaction recheck below: the absence was cleared
// ("Tech is back") or the alert was resolved/dismissed after this run read
// it. Either way there is nothing left to do — a no-op, never a retry on
// the next candidate.
const STALE_CODES = new Set(['TECH_OUT_CLEARED', 'TECH_OUT_ALERT_RESOLVED']);
// The excluded batch changed between the read and the move (a sibling left
// the absent tech's day): the probe's exclusion is no longer true, so the
// move refuses and the alert stays parked for the next run to re-read.
const EXCLUSION_STALE = 'TECH_OUT_EXCLUSION_STALE';

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
function makeStillParkedGuard({ alertId, absentTechId, date, stopId, excludeServiceIds, toTechId, actorId }) {
  return async (trx) => {
    // The commit probe skips excludeServiceIds; that is only sound while
    // each of them still sits open on the absent tech's day. Re-read them
    // here, FOR SHARE, so none can leave that day until this move commits.
    // Other rebooker moves on this date already wait on the date-occupancy
    // lock the mover took before calling us, so this cannot cycle with one.
    const siblings = excludeServiceIds.filter((id) => id !== String(stopId));
    if (siblings.length) {
      const still = await trx('scheduled_services')
        .whereIn('id', siblings)
        .where({ technician_id: absentTechId, scheduled_date: date })
        .whereNotIn('status', DEFAULT_EXCLUDE_STATUSES)
        .orderBy('id')
        .forShare()
        .select('id');
      if (still.length !== siblings.length) {
        throw Object.assign(new Error('The absent technician\'s day changed during the move'), { statusCode: 409, code: EXCLUSION_STALE });
      }
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
  // A grouped visit the alert didn't know about (grouped after park) is a
  // human decision, same as the up-front alert-payload check.
  if (stop.visit_id) return { reason: 'grouped_visit_manual', skipped: false };
  if (!RESCHEDULABLE_STATUSES.has(String(stop.status))) return { reason: 'live_status', skipped: false };
  // The tracker can go live (en_route / on_property) before the operational
  // status syncs, so a 'confirmed' row may already be an active visit.
  if (LIVE_TRACK_STATES.includes(String(stop.track_state))) return { reason: 'live_status', skipped: false };
  const scheduledDateStr = stop.scheduled_date instanceof Date
    ? stop.scheduled_date.toISOString().slice(0, 10)
    : String(stop.scheduled_date || '').slice(0, 10);
  // Idempotent no-op: the stop already moved off the absent tech, or off
  // this date, by some other path (a dispatcher's manual reassignment, a
  // prior auto-move run) since this alert was parked.
  if (String(stop.technician_id || '') !== String(absentTechId || '') || scheduledDateStr !== String(date)) {
    return { reason: 'already_resolved', skipped: true };
  }
  return null;
}

async function loadMovableStop(alertId) {
  const alert = await db('dispatch_alerts').where({ id: alertId }).first();
  if (!alert) return { done: { moved: false, alert_id: alertId, skipped: 'alert_not_found' } };
  if (alert.type !== ALERT_TYPE) return { done: { moved: false, alert_id: alertId, skipped: 'wrong_type' } };
  if (alert.resolved_at) return { done: { moved: false, alert_id: alertId, skipped: 'already_resolved' } };

  const payload = (typeof alert.payload === 'string' ? JSON.parse(alert.payload) : alert.payload) || {};
  const date = payload.date;
  const absentTechId = alert.tech_id;

  // Grouped units are a human decision (PR B scope) — never auto-moved.
  const memberIds = Array.isArray(payload.visit_member_ids) ? payload.visit_member_ids : null;
  if (memberIds && memberIds.length > 1) {
    await annotateAttempt(alertId, 'grouped_visit_manual');
    return { done: { moved: false, alert_id: alertId, reason: 'grouped_visit_manual' } };
  }

  const jobId = alert.job_id || (memberIds && memberIds[0]) || null;
  if (!jobId) {
    await annotateAttempt(alertId, 'no_job_reference');
    return { done: { moved: false, alert_id: alertId, reason: 'no_job_reference' } };
  }

  // guardedCoordSelects reads customers.* as the coordinate fallback, so the
  // customer join is required (not optional) for this select to parse.
  const stop = await db('scheduled_services')
    .leftJoin('customers', 'customers.id', 'scheduled_services.customer_id')
    .where('scheduled_services.id', jobId)
    .first(
      'scheduled_services.id', 'scheduled_services.status', 'scheduled_services.service_type',
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.visit_id',
      'scheduled_services.technician_id', 'scheduled_services.scheduled_date',
      'scheduled_services.customer_id', 'scheduled_services.track_state', ...guardedCoordSelects(db),
    );
  const refusal = stopMoveRefusal(stop, absentTechId, date);
  if (refusal) {
    if (!refusal.skipped) await annotateAttempt(alertId, refusal.reason);
    return {
      done: refusal.skipped
        ? { moved: false, alert_id: alertId, skipped: refusal.reason }
        : { moved: false, alert_id: alertId, reason: refusal.reason },
    };
  }
  return { stop, date, absentTechId };
}

/**
 * Active + field-dispatchable technicians, not the absent tech, ranked
 * best-fit first for `stop` on `date`. assertAssignableTechnician is the
 * single canonical source of truth for BOTH flags together (and for
 * "also absent on this date") — called per candidate here, right before
 * ranking, so a race between the crew read and this check is still caught.
 */
/** Open stops still on the absent tech that day (the batch the mover may pass over). */
async function absentDayStopIds(absentTechId, date) {
  const rows = await db('scheduled_services')
    .where({ technician_id: absentTechId, scheduled_date: date })
    .whereNotIn('status', DEFAULT_EXCLUDE_STATUSES)
    .select('id');
  return rows.map((r) => String(r.id));
}

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
  if (lastErr.code === EXCLUSION_STALE) return 'schedule_changed';
  return `move_failed: ${lastErr.message}`;
}

/**
 * Try the ranked candidates in order through the canonical mover. The
 * alert resolves inside the successful move's own transaction (beforeMove),
 * so anything thrown here means nothing committed for that candidate.
 */
async function attemptMoves({ alertId, actorId, stop, date, absentTechId, window, excludeServiceIds, candidates }) {
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
          excludeServiceIds,
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
          },
          moveGuard: makeCapabilityGuard(),
          beforeMove: makeStillParkedGuard({
            alertId, absentTechId, date, stopId: stop.id, excludeServiceIds, toTechId: candidate.tech.id, actorId,
          }),
        },
      );
    } catch (err) {
      if (err && STALE_CODES.has(err.code)) return { moved: false, alert_id: alertId, skipped: 'already_resolved' };
      lastErr = err;
      // Same answer for every candidate: stop and let the next run re-read.
      if (err && (err.code === EXCLUSION_STALE || err.code === 'VISIT_MEMBERSHIP_CHANGED')) break;
      continue;
    }
    // Committed (stop + alert). The board broadcast is best-effort.
    try {
      await emitDispatchJobUpdate({ jobId: stop.id, actorId: actorId || null });
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
async function autoAssignParkedAlert({ alertId, actorId } = {}) {
  if (!autoMoveEnabled()) return { moved: false, alert_id: alertId, skipped: 'gate_off' };
  if (!alertId) throw Object.assign(new Error('alertId is required'), { status: 400, code: 'VALIDATION' });

  const loaded = await loadMovableStop(alertId);
  if (loaded.done) return loaded.done;
  const { stop, date, absentTechId } = loaded;

  // The mover's commit probe, read-only and with the SAME options the move
  // passes below: selection never certifies a move the commit would refuse.
  // That probe is tech-blind by design (one active field tech; see
  // scheduling/occupancy.js), so a stop whose window any other live stop
  // overlaps stays parked for a human. The absent tech's own open stops that
  // day are excluded, the same batch-mover convention rain-out uses: they are
  // leaving that route, so they must not block each other's rescue.
  const excludeServiceIds = await absentDayStopIds(absentTechId, date);
  const window = { start: stop.window_start, end: stop.window_end };
  const conflicts = await SmartRebooker.previewMoveConflicts(stop.id, date, window, { excludeServiceIds });
  if (conflicts.length) {
    await annotateAttempt(alertId, 'window_occupied');
    return { moved: false, alert_id: alertId, reason: 'window_occupied' };
  }

  const ranked = await eligibleRankedCandidates(stop, absentTechId, date);
  if (!ranked.length) {
    await annotateAttempt(alertId, 'no_eligible_candidate');
    return { moved: false, alert_id: alertId, reason: 'no_eligible_candidate' };
  }

  const outcome = await attemptMoves({
    alertId, actorId, stop, date, absentTechId, window, excludeServiceIds, candidates: ranked.slice(0, MAX_MOVE_ATTEMPTS),
  });
  if (outcome.moved || outcome.skipped) return outcome;
  const { reason } = outcome;
  await annotateAttempt(alertId, reason);
  return { moved: false, alert_id: alertId, reason };
}

/**
 * Process every OPEN `tech_out_overflow` alert for one tech-day, most-
 * protected unit first (reverse of bump_order — "bump last" stops get first
 * pick of the day's open capacity while it's still there). Each alert runs
 * through the one chokepoint above in its own mover transaction; a failure
 * on one alert never stops the rest.
 */
async function autoAssignTechDay({ technicianId, date, actorId } = {}) {
  if (!autoMoveEnabled()) return { skipped: 'gate_off', moved: [], left_parked: [] };
  if (!technicianId || !date) {
    throw Object.assign(new Error('technicianId and date are required'), { status: 400, code: 'VALIDATION' });
  }

  const alerts = await db('dispatch_alerts')
    .where({ type: ALERT_TYPE, tech_id: technicianId })
    .whereNull('resolved_at')
    .whereRaw("payload->>'date' = ?", [date])
    .orderByRaw("COALESCE(NULLIF(payload->>'bump_order', '')::int, 0) DESC")
    .select('id');

  const moved = [];
  const left_parked = [];
  for (const { id } of alerts) {
    let result;
    try {
      result = await autoAssignParkedAlert({ alertId: id, actorId });
    } catch (err) {
      logger.error(`[tech-out-auto-move] alert ${id} threw during batch auto-assign: ${err.message}`);
      left_parked.push({ alert_id: id, reason: `error: ${err.message}` });
      continue;
    }
    if (result.moved) moved.push(result);
    else if (!result.skipped) left_parked.push({ alert_id: id, reason: result.reason });
  }

  return { moved, left_parked };
}

module.exports = {
  autoMoveEnabled,
  autoAssignParkedAlert,
  autoAssignTechDay,
  MAX_MOVE_ATTEMPTS,
  _test: { fitsWindow, detourForTech, compareCandidates, rankCandidates },
};
