/**
 * "Tech out today" (GATE_TECH_OUT_REDISTRIBUTE) — mark a technician absent
 * for a date, redistribute every stop on that tech-day to another eligible
 * tech who can take it at the SAME promised arrival window, and park the
 * rest as ranked dispatch alerts for a human to decide who gets bumped.
 *
 * Sends NO customer communication of any kind — moves go through the
 * canonical rebooker (SmartRebooker.reschedule), the same mover every other
 * staff/system reschedule uses; nothing here touches SMS/email/reminders.
 *
 * technician_absences is the single source of truth for "who is out
 * today" — clearTechOut never re-assigns a moved stop back; a human
 * decides that on the board like any other reassignment.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { gateEnvValue } = require('../config/feature-gates');
const { dayStopsQuery, guardedCoordSelects } = require('./scheduling/day-stops');
const { applyAssignable } = require('./technician-eligibility');
const { inactiveCapabilitiesForServices } = require('./technician-capabilities');
const { arrivalWindowRoutingEnabled, checkArrivalPlacement } = require('./scheduling/arrival-route');
const { windowsOverlap, DEFAULT_EXCLUDE_STATUSES } = require('./scheduling/occupancy');
const { driveMin, resolveGeo, HQ } = require('./auto-dispatch/geo');
const SmartRebooker = require('./rebooker');
const { createAlert, resolveAlert } = require('./dispatch-alerts');
const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
const { emitDispatchJobUpdate } = require('./dispatch-assignment');

const REASONS = ['sick', 'emergency', 'no_show', 'other'];
const MAX_NOTE_LENGTH = 300;
// A resume's lease staleness window (finding 4): a 'running' redistribution
// younger than this is presumed genuinely in-flight (another request, or
// this one before it finished) and refuses a concurrent resume; older than
// this, the run that held it is presumed dead (crash, deploy) and it may
// be re-claimed.
const RESUME_LEASE_STALE_MINUTES = 10;
// The absent tech's own stops that redistribution considers moving. An
// en_route stop stays IN — a tech pulled off the road mid-drive still
// needs that stop covered by someone. on_site drops out: the tech is
// physically there, nothing to redistribute.
const ABSENT_STOP_EXCLUDE_STATUSES = ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show', 'on_site'];

function techOutEnabled() {
  return gateEnvValue('GATE_TECH_OUT_REDISTRIBUTE');
}

function serviceError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
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

function customerDisplayName(row) {
  const first = row?.first_name || '';
  const lastInitial = row?.last_name ? String(row.last_name).trim().charAt(0).toUpperCase() : '';
  if (first && lastInitial) return `${first} ${lastInitial}.`;
  return first || null;
}

/** The uncleared technician_absences row for a tech+date, or null. */
async function getTechOut({ technicianId, date }) {
  const row = await db('technician_absences')
    .where({ technician_id: technicianId, absence_date: date })
    .whereNull('cleared_at')
    .first();
  return row || null;
}

/**
 * True while THIS redistribution run's own absence row is still uncleared —
 * read fresh right before each write (tech-out P1), never a snapshot from
 * loop entry: a run must stop the instant "tech is back" clears the
 * absence mid-loop, never moving or parking another stop under an absence
 * that no longer exists. `absenceId` absent (every caller before this
 * guard existed, and a direct redistributeTechDay call that isn't tracking
 * an absence row) skips the read entirely — byte-identical to before.
 */
async function absenceStillUncleared(absenceId) {
  if (!absenceId) return true;
  const row = await db('technician_absences').where({ id: absenceId }).whereNull('cleared_at').first('id');
  return !!row;
}

/**
 * rankBumpOrder — pure. Sorts parked stops "bump first" ascending by score:
 *   recurring (is_recurring === true) +0, else +50
 *   status 'confirmed' +20
 * Ties → later window_start sorts first (more room to still move that day).
 * Returns new objects (does not mutate input) with `bump_reason` attached.
 *
 * is_recurring alone classifies "recurring" (not recurring_parent_id): a
 * series root carries is_recurring true with a null parent, while a
 * booster occurrence carries a parent but is stored is_recurring=false
 * precisely so cadence maintenance ignores it (see
 * auto-dispatch/eligibility.js) — recurring_parent_id alone would
 * misclassify a booster as the easiest-to-slide recurring visit.
 */
function rankBumpOrder(stops) {
  const scored = (stops || []).map((stop) => {
    const recurring = stop.is_recurring === true;
    const confirmed = stop.status === 'confirmed';
    const score = (recurring ? 0 : 50) + (confirmed ? 20 : 0);
    let bump_reason;
    if (recurring && !confirmed) bump_reason = 'Recurring routine visit, not yet confirmed — easiest to slide';
    else if (recurring && confirmed) bump_reason = 'Recurring visit the customer confirmed — slide with care';
    else if (!recurring && !confirmed) bump_reason = 'One-time visit, not yet confirmed — can still slide';
    else bump_reason = 'One-time visit the customer confirmed — bump last';
    return { ...stop, bump_score: score, bump_reason };
  });
  scored.sort((a, b) => {
    if (a.bump_score !== b.bump_score) return a.bump_score - b.bump_score;
    const aStart = String(a.window_start || '');
    const bStart = String(b.window_start || '');
    if (aStart === bStart) return 0;
    return aStart < bStart ? 1 : -1; // later window_start first
  });
  return scored;
}

/** Fit test for one (stop, candidate tech) pair, keeping the stop's own window. */
async function fitsWindow(stop, tech, date) {
  if (!stop.window_start) return { fits: false, conflict_reason: 'no_window' };
  const windowStart = stop.window_start;
  const durationMinutes = Number(stop.estimated_duration_minutes) || 60;
  const startMin = timeToMinutes(windowStart);
  const endMin = timeToMinutes(stop.window_end) ?? (startMin + durationMinutes);
  // A NULL window_end must still cover the visit's real duration — falling
  // back to windowStart itself would give it a zero-length window that can
  // never overlap anything (every conflict silently disappears).
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
      // The stop being placed is still sitting on the ABSENT tech (possibly
      // en_route) — its own current live-route membership must not gate a
      // DIFFERENT candidate's placement (arrival-route.js's activeTarget
      // short-circuit would otherwise report route_unverified for every
      // en_route stop, however open the candidate's route is).
      treatTargetAsPending: true,
    });
    return fit.feasible ? { fits: true } : { fits: false, conflict_reason: fit.reason };
  }

  const others = await db('scheduled_services')
    .where({ scheduled_date: date, technician_id: tech.id })
    .whereNot('id', stop.id)
    .whereNotIn('status', DEFAULT_EXCLUDE_STATUSES)
    .select('window_start', 'window_end', 'estimated_duration_minutes');
  const conflict = others.some((row) => {
    const oStart = timeToMinutes(row.window_start);
    if (oStart == null) return false; // windowless rows stay inert, same as occupancy.js
    const oEnd = timeToMinutes(row.window_end) ?? (oStart + (Number(row.estimated_duration_minutes) || 60));
    return windowsOverlap(startMin, endMin, oStart, oEnd);
  });
  if (conflict) return { fits: false, conflict_reason: 'overlap' };

  // Plain-overlap fallback has no arrival-route model to read blocks from —
  // read tech_schedule_blocks directly (same shape as arrival-route.js's own
  // read) so a candidate's time off / meeting / other non-available block
  // still refuses the placement.
  const blocks = await db('tech_schedule_blocks')
    .where({ date })
    .whereNot('block_type', 'available')
    .where((q) => q.where('technician_id', tech.id).orWhereNull('technician_id'))
    .select('start_time', 'end_time');
  const blocked = blocks.some((b) => {
    const bStart = timeToMinutes(b.start_time);
    const bEnd = timeToMinutes(b.end_time);
    if (bStart == null || bEnd == null) return false;
    return windowsOverlap(startMin, endMin, bStart, bEnd);
  });
  return blocked ? { fits: false, conflict_reason: 'schedule_block' } : { fits: true };
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
      'scheduled_services.estimated_duration_minutes', ...guardedCoordSelects(db),
    ],
  });
  const neighbors = rows.filter((r) => r.id !== stop.id);
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

// Shared ranking: lower detour first, null (no geo to measure) sorts last,
// ties break on fewer stops already on that tech's day. Used both to pick
// the winning placement among fitting techs and to rank near-miss failures.
function compareDetour(a, b) {
  if (a.detour_minutes == null && b.detour_minutes == null) return a.stops_that_day - b.stops_that_day;
  if (a.detour_minutes == null) return 1;
  if (b.detour_minutes == null) return -1;
  if (a.detour_minutes !== b.detour_minutes) return a.detour_minutes - b.detour_minutes;
  return a.stops_that_day - b.stops_that_day;
}

/**
 * Decide where (if anywhere) `stop` lands. Returns either
 *   { placed: true, best: { id, name, detour_minutes } }
 * or
 *   { placed: false, near_misses: [{ technician_id, technician_name, conflict_reason, detour_minutes }] }
 *
 * `memberServiceTypes` (optional): for a grouped visit, the service_type of
 * EVERY member — a candidate inactive for ANY one of them cannot take the
 * unit, not just the representative's own service. Defaults to the
 * representative's own service_type (an ungrouped stop is its own unit).
 */
async function placeStop(stop, crew, date, memberServiceTypes) {
  if (!crew.length) return { placed: false, near_misses: [] };

  const capabilityRows = (memberServiceTypes && memberServiceTypes.length ? memberServiceTypes : [stop.service_type])
    .map((service_type) => ({ service_type }));
  const inactive = await inactiveCapabilitiesForServices(db, crew.map((c) => c.id), capabilityRows);
  const inactiveIds = new Set(inactive.map((r) => r.technician_id));

  const evaluations = [];
  for (const tech of crew) {
    if (inactiveIds.has(tech.id)) {
      evaluations.push({ tech, fits: false, conflict_reason: 'capability_inactive' });
      continue;
    }
    // Sequential by design: each stop's fit test must see the DB state
    // left by the previous stop's move.
    const fit = await fitsWindow(stop, tech, date);
    evaluations.push({ tech, fits: fit.fits, conflict_reason: fit.conflict_reason });
  }

  const fitting = evaluations.filter((e) => e.fits);
  if (!fitting.length) {
    // Rank every evaluated (non-fitting) tech by marginal detour too, so the
    // three near-misses shown are the closest calls, not just the first
    // three in crew order.
    const scored = [];
    for (const e of evaluations) {
      // Small crew; sequential keeps each read consistent with the moves
      // already applied earlier in this stop's own evaluation pass.
      const { detour_minutes, stops_that_day } = await detourForTech(stop, e.tech.id, date);
      scored.push({ ...e, detour_minutes, stops_that_day });
    }
    scored.sort(compareDetour);
    const near_misses = scored.slice(0, 3).map((e) => ({
      technician_id: e.tech.id, technician_name: e.tech.name, conflict_reason: e.conflict_reason,
      detour_minutes: e.detour_minutes,
    }));
    return { placed: false, near_misses };
  }

  const ranked = [];
  for (const e of fitting) {
    // Small crew; sequential keeps each read consistent.
    const { detour_minutes, stops_that_day } = await detourForTech(stop, e.tech.id, date);
    ranked.push({ tech: e.tech, detour_minutes, stops_that_day });
  }
  ranked.sort(compareDetour);
  const winner = ranked[0];
  return {
    placed: true,
    best: { id: winner.tech.id, name: winner.tech.name, detour_minutes: winner.detour_minutes },
  };
}

/**
 * The still-open tech_out_overflow alerts' ids for a tech+date — a resume
 * must not re-park them. Includes both the alert's own job_id (the
 * representative for a grouped visit) and every id in
 * payload.visit_member_ids (finding 1: a resume must skip a whole visit
 * when ANY member already has an open overflow alert), so a caller that
 * skips every id in this set naturally skips the whole visit.
 */
async function parkedJobIds({ technicianId, date }) {
  const rows = await db('dispatch_alerts')
    .where({ type: 'tech_out_overflow', tech_id: technicianId })
    .whereNull('resolved_at')
    .whereRaw("payload->>'date' = ?", [date])
    .select('job_id', 'payload');
  const ids = new Set();
  for (const row of rows) {
    if (row.job_id) ids.add(row.job_id);
    const memberIds = row.payload && row.payload.visit_member_ids;
    if (Array.isArray(memberIds)) for (const id of memberIds) ids.add(id);
  }
  return ids;
}

/**
 * Move every movable stop off `technicianId`'s day for `date` onto another
 * eligible tech at the same promised window; park the rest as ranked
 * dispatch alerts. Processes stops sequentially — each move is its own
 * transaction, and a later stop's fit test must see earlier moves.
 *
 * `absenceId` + `priorSummary` (optional): a RESUME of a run that threw
 * partway through (markTechOut) — `skipJobIds` are stops already parked by
 * the earlier attempt (never re-parked), and a thrown error here persists a
 * partial summary merged with `priorSummary` onto the absence row before
 * rethrowing, so a second resume never loses the first attempt's work.
 * Callers that omit them (the ordinary first run, and every existing
 * caller/test) get byte-identical behavior.
 */
async function redistributeTechDay({
  technicianId, date, reason, actorId, absenceId, skipJobIds, priorSummary,
} = {}) {
  const absentTech = await db('technicians').where({ id: technicianId }).first('id', 'name');

  const allStops = await dayStopsQuery(db, {
    dateStr: date,
    technicianId,
    excludeStatuses: ABSENT_STOP_EXCLUDE_STATUSES,
    select: [
      'scheduled_services.id', 'scheduled_services.customer_id', 'scheduled_services.status',
      'scheduled_services.service_type', 'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.recurring_parent_id',
      'scheduled_services.is_recurring', 'scheduled_services.visit_id',
      'scheduled_services.source_action', 'scheduled_services.customer_confirmed',
      ...guardedCoordSelects(db),
      'customers.first_name', 'customers.last_name',
    ],
  }).orderBy('scheduled_services.window_start', 'asc');

  // A resume must skip a whole grouped visit when ANY of its members
  // already carries an open overflow alert (finding 1) — parkedJobIds
  // (markTechOut) already returns the union of every alert's job_id and
  // payload.visit_member_ids, so widening the skip set to every member of
  // a visit any of whose ids appears there covers it.
  const skipVisitIds = new Set();
  if (skipJobIds && skipJobIds.size) {
    for (const s of allStops) {
      if (s.visit_id && skipJobIds.has(s.id)) skipVisitIds.add(s.visit_id);
    }
  }
  const stops = skipJobIds && skipJobIds.size
    ? allStops.filter((s) => !skipJobIds.has(s.id) && !(s.visit_id && skipVisitIds.has(s.visit_id)))
    : allStops;

  // allStops carries one row per visit member (finding 1): group them so
  // every member id — and every member's service_type, for the capability
  // check (finding 2) — is reachable from a visit's representative stop.
  const membersByVisit = new Map();
  for (const s of stops) {
    if (!s.visit_id) continue;
    if (!membersByVisit.has(s.visit_id)) membersByVisit.set(s.visit_id, []);
    membersByVisit.get(s.visit_id).push(s);
  }
  const memberIdsFor = (stop) => (
    stop.visit_id ? (membersByVisit.get(stop.visit_id) || [stop]).map((m) => m.id) : [stop.id]
  );
  const memberServiceTypesFor = (stop) => (
    stop.visit_id ? (membersByVisit.get(stop.visit_id) || [stop]).map((m) => m.service_type) : [stop.service_type]
  );
  // Process ONE representative per visit — everything else (capability
  // check, placement, the rebooker call) considers the whole visit through
  // it, and every member gets its own moved/parked entry from the result.
  const seenVisitIds = new Set();
  const units = [];
  for (const s of stops) {
    if (s.visit_id) {
      if (seenVisitIds.has(s.visit_id)) continue;
      seenVisitIds.add(s.visit_id);
    }
    units.push(s);
  }

  const crew = await applyAssignable(db('technicians'))
    .whereNot('technicians.id', technicianId)
    .whereNotExists(function excludeOtherAbsentees() {
      this.select(1).from('technician_absences as ta')
        .whereRaw('ta.technician_id = technicians.id')
        .andWhere('ta.absence_date', date)
        .whereNull('ta.cleared_at');
    })
    .select('technicians.id', 'technicians.name');

  const priorMoved = priorSummary?.moved || [];
  const priorParked = priorSummary?.parked || [];
  const priorTotal = priorSummary?.total;
  const moved = [...priorMoved];
  const failed = [];
  const toPark = [];

  // Re-checked on the move transaction itself (finding 2): the capability
  // pre-check above is a point-in-time read; a category flipped inactive
  // between it and the write is caught here, before the first write, for
  // BOTH the single-row path (keptTechId = the destination tech on a tech
  // change) and every grouped member's own re-point (visit-groups.js's
  // alignMember calls this at technicianId = the destination tech too).
  async function capabilityMoveGuard({ trx, technicianId: destTechId, service }) {
    if (!destTechId || !service || !service.service_type) return;
    const inactive = await inactiveCapabilitiesForServices(trx, [destTechId], [{ service_type: service.service_type }]);
    if (inactive.length) {
      throw Object.assign(new Error(`Technician ${destTechId} is not capable of ${service.service_type}`), {
        status: 409, statusCode: 409, code: 'CAPABILITY_INACTIVE',
      });
    }
  }

  let cancelled = false;

  try {
    for (const stop of units) {
      const memberIds = memberIdsFor(stop);
      // Office-review-pending bookings (finding 3): the office has not yet
      // confirmed this AI-created booking, so activateLegacyOutboundReviewRowIfNeeded
      // (rebooker post-commit) would run on a move the office hasn't seen
      // yet. Never moved — always parked for a human to review first.
      const isOfficeReviewPending = OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(stop.source_action)
        && !stop.customer_confirmed;
      if (isOfficeReviewPending) {
        toPark.push({ stop, near_misses: [], officeReviewPending: true, memberIds });
        continue;
      }

      // Sequential by design: a later stop's fit test (and the crew's
      // occupancy) must see this move.
      const placement = await placeStop(stop, crew, date, memberServiceTypesFor(stop));
      if (placement.placed) {
        // tech-out P1: a fresh read right before this move commits — not a
        // snapshot from loop entry — so a clear that landed on THIS or an
        // earlier iteration is caught before another stop moves under a
        // since-cleared absence. Stops the whole run: nothing further moves
        // or parks.
        if (absenceId && !(await absenceStillUncleared(absenceId))) {
          cancelled = true;
          break;
        }
        try {
          // The canonical mover: a grouped stop (visit_id set) moves its
          // whole visit as a unit; the destination day's occupancy is
          // re-probed under its own lock; keepStatus/allowLive admit an
          // en_route stop without forcing it back to 'confirmed'; `expect`
          // CAS-pins the absent tech so a concurrent reassignment (or a
          // second redistribution run) 409s instead of silently stealing
          // the stop. A thrown 409 (CAS/conflict) is recorded in `failed`
          // and the loop continues — every other error does too, since a
          // partial redistribution is recoverable but must not corrupt the
          // stops it already resolved.
          await SmartRebooker.reschedule(
            stop.id, date, { start: stop.window_start, end: stop.window_end }, 'tech_out', 'system',
            {
              technicianId: placement.best.id,
              keepStatus: true,
              allowLive: true,
              expect: { technician_id: technicianId },
              suppressTechNotice: false,
              moveGuard: capabilityMoveGuard,
            },
          );
          // moveVisitAsUnit moves every member of a grouped visit — one
          // moved entry (and one best-effort board broadcast) per member,
          // not just the representative (finding 1 + finding 8).
          for (const memberId of memberIds) {
            moved.push({
              job_id: memberId,
              to_technician_id: placement.best.id,
              to_technician_name: placement.best.name,
              detour_minutes: placement.best.detour_minutes,
            });
            try {
              await emitDispatchJobUpdate({ jobId: memberId, actorId });
            } catch (broadcastErr) {
              logger.warn(`[tech-out] dispatch board broadcast failed for ${memberId}: ${broadcastErr.message}`);
            }
          }
        } catch (err) {
          // A failed move (CAS race, destination conflict, rebooker refusal)
          // must not strand the stop on the absent tech with no path
          // forward: record it AND park it as an overflow alert so a human
          // decides, same as a stop nobody could fit. The chosen tech rides
          // along as the near miss so the dispatcher sees what was tried.
          failed.push({ job_id: stop.id, error: err.message });
          toPark.push({
            stop,
            move_error: err.message,
            memberIds,
            near_misses: [{
              technician_id: placement.best.id, technician_name: placement.best.name,
              conflict_reason: 'move_failed', detour_minutes: placement.best.detour_minutes,
            }],
          });
        }
      } else {
        toPark.push({ stop, near_misses: placement.near_misses, memberIds });
      }
    }

    const ranked = cancelled ? [] : rankBumpOrder(toPark.map((p) => p.stop));
    const nearMissById = new Map(toPark.map((p) => [p.stop.id, p.near_misses]));
    const moveErrorById = new Map(toPark.filter((p) => p.move_error).map((p) => [p.stop.id, p.move_error]));
    const memberIdsById = new Map(toPark.map((p) => [p.stop.id, p.memberIds]));
    const officeReviewIds = new Set(toPark.filter((p) => p.officeReviewPending).map((p) => p.stop.id));
    const newlyParkedByUnit = new Array(ranked.length);
    // Insert alerts in REVERSE bump order (highest bump_order — "bump
    // last" — created FIRST, bump #1 — "bump first" — created LAST): the
    // Action Queue hydrates by created_at DESC and prepends socket events,
    // so the most recently inserted row is newest and lands on top. bump_order
    // itself still numbers ascending from 1 in the payload either way.
    for (let i = ranked.length - 1; i >= 0; i -= 1) {
      // tech-out P1: same fresh re-check as the move guard above, right
      // before this alert write — a clear that landed since the units loop
      // (or on an earlier alert in this very loop) stops every remaining
      // alert too.
      if (absenceId && !(await absenceStillUncleared(absenceId))) {
        cancelled = true;
        break;
      }
      const stop = ranked[i];
      const memberIds = memberIdsById.get(stop.id) || [stop.id];
      const alert = await createAlert({
        type: 'tech_out_overflow',
        severity: 'warn',
        techId: technicianId,
        jobId: stop.id,
        payload: {
          date,
          reason,
          absent_tech_name: absentTech?.name || null,
          customer_name: customerDisplayName(stop),
          service_type: stop.service_type,
          window_start: stop.window_start,
          window_end: stop.window_end,
          bump_order: i + 1,
          bump_total: ranked.length,
          bump_reason: officeReviewIds.has(stop.id) ? 'Unreviewed office booking — review before moving' : stop.bump_reason,
          near_misses: (nearMissById.get(stop.id) || []).slice(0, 3),
          ...(moveErrorById.has(stop.id) ? { move_error: moveErrorById.get(stop.id) } : {}),
          ...(officeReviewIds.has(stop.id) ? { conflict_reason: 'office_review_pending' } : {}),
          ...(memberIds.length > 1 ? { visit_member_ids: memberIds } : {}),
        },
      });
      // One alert per unit, shared across every member of a grouped visit
      // (finding 1) — a single-stop unit gets its own one-entry array.
      newlyParkedByUnit[i] = memberIds.map((jobId) => ({ job_id: jobId, alert_id: alert.id, bump_order: i + 1 }));
    }
    // .filter(Boolean): a run cancelled partway through the alert loop
    // leaves the not-yet-reached indices as holes (never written, never
    // parked) — the array's own entries otherwise, unchanged.
    const parked = [...priorParked, ...newlyParkedByUnit.filter(Boolean).flat()];

    logger.info(`[tech-out] redistributed ${date} for ${absentTech?.name || technicianId}: ${moved.length} moved, ${parked.length} parked, ${failed.length} failed (of ${priorTotal ?? stops.length})${cancelled ? ' — CANCELLED (absence cleared mid-run)' : ''}`);

    return {
      total: priorTotal ?? stops.length, moved, parked, failed, status: cancelled ? 'cancelled' : 'complete',
    };
  } catch (err) {
    if (absenceId) {
      try {
        await db('technician_absences').where({ id: absenceId }).update({
          redistribution: JSON.stringify({
            total: priorTotal ?? stops.length, moved, parked: priorParked, failed, status: 'partial', error: err.message,
          }),
        }).returning('*');
      } catch (persistErr) {
        logger.error(`[tech-out] failed to persist partial redistribution for absence ${absenceId}: ${persistErr.message}`);
      }
    }
    throw err;
  }
}

/**
 * Mark a technician out for a date and redistribute their day.
 *
 * A second POST for the same tech+date normally 409s ALREADY_OUT — but when
 * the existing uncleared row's own redistribution never finished (null, or
 * status !== 'complete' — a prior run threw partway through), this instead
 * RESUMES it: only the stops still on the absent tech that are not already
 * parked as an open tech_out_overflow alert are re-evaluated, and the result
 * merges onto the earlier partial summary. `resumed: true` marks that path
 * in the response; the route answers 200 for a resume, 201 for a fresh mark.
 */
async function markTechOut({ technicianId, date, reason, note, actorId }) {
  if (!technicianId) throw serviceError(400, 'VALIDATION', 'technicianId is required');
  const normalizedDate = validCalendarDate(date);
  if (!normalizedDate) {
    throw serviceError(400, 'VALIDATION', 'date must be a valid calendar date (YYYY-MM-DD)');
  }
  if (normalizedDate < etDateString()) {
    throw serviceError(409, 'PAST_DATE', 'Cannot mark a technician out for a past date');
  }
  if (!REASONS.includes(reason)) {
    throw serviceError(400, 'VALIDATION', `reason must be one of ${REASONS.join(', ')}`);
  }
  if (note != null && String(note).length > MAX_NOTE_LENGTH) {
    throw serviceError(400, 'VALIDATION', `note must be ${MAX_NOTE_LENGTH} characters or fewer`);
  }
  // Any employment status is fine — a sick tech is still a tech. Only
  // confirm the row exists.
  const tech = await db('technicians').where({ id: technicianId }).first('id', 'name');
  if (!tech) throw serviceError(400, 'VALIDATION', 'Technician not found');

  let absence;
  let resumed = false;
  // priorRedistribution: the summary a RESUMED run merges onto — captured
  // BEFORE the claim below overwrites the row's redistribution with the
  // fresh lease, so a resume never loses the earlier attempt's moved/
  // parked/failed lists (finding 4).
  let priorRedistribution = null;
  try {
    // Serialized with every assignment writer (tech-out P1): assignDispatchJob
    // / the rebooker's assertAssignableTechnician reads this technician row
    // FOR SHARE while committing a move. Taking FOR UPDATE here first means
    // an in-flight assignment either finishes and commits (its own commit
    // already checked eligibility at that moment) or is blocked behind this
    // lock — either way, this absence row does not exist for any reader
    // until AFTER this transaction commits, so redistribution's day-stops
    // scan (which starts once this returns, outside this transaction) never
    // races a concurrent write that has not yet seen the absence.
    const rows = await db.transaction(async (trx) => {
      await trx('technicians').where({ id: technicianId }).forUpdate().first('id');
      return trx('technician_absences')
        .insert({
          technician_id: technicianId, absence_date: normalizedDate, reason, note: note || null, created_by: actorId || null,
          // The lease (finding 4): a fresh mark starts 'running' immediately —
          // the partial unique index (WHERE cleared_at IS NULL) already
          // serializes concurrent inserts for the same tech+date, so no
          // separate claim is needed here, only for a RESUME below.
          redistribution: JSON.stringify({ status: 'running', started_at: new Date().toISOString() }),
        })
        .returning('*');
    });
    absence = rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      const existing = await getTechOut({ technicianId, date: normalizedDate });
      if (!existing) {
        // The row that caused the unique-constraint miss is already gone
        // (cleared between the failed insert and this read) — the safe
        // read is "already out", not a silent fall-through.
        throw serviceError(409, 'ALREADY_OUT', `${tech.name} is already marked out for ${normalizedDate}`);
      }
      priorRedistribution = existing.redistribution;
      // Atomic claim (finding 4): only a row that is unstarted (null),
      // partial (a prior run threw), or 'running' with a stale lease (the
      // run that held it died without persisting partial/complete) may be
      // resumed. Zero rows back ⇒ either truly complete, or another
      // request is genuinely running this resume right now — either way
      // this request 409s instead of racing it.
      const claimed = await db('technician_absences')
        .where({ id: existing.id })
        .whereNull('cleared_at')
        .whereRaw(`(
          redistribution IS NULL
          OR redistribution->>'status' = 'partial'
          OR (redistribution->>'status' = 'running' AND (redistribution->>'started_at')::timestamptz < now() - interval '${RESUME_LEASE_STALE_MINUTES} minutes')
        )`)
        .update({ redistribution: JSON.stringify({ status: 'running', started_at: new Date().toISOString() }) })
        .returning('*');
      if (!claimed.length) {
        throw serviceError(409, 'ALREADY_OUT', `${tech.name} is already marked out for ${normalizedDate}`);
      }
      resumed = true;
      [absence] = claimed;
    } else {
      throw err;
    }
  }

  const skipJobIds = resumed ? await parkedJobIds({ technicianId, date: normalizedDate }) : null;
  const summary = await redistributeTechDay({
    technicianId,
    date: normalizedDate,
    // A resume continues the ORIGINAL absence's own reason, not whatever
    // this new POST body happened to carry — the tech's reason for being
    // out did not change between attempts.
    reason: resumed ? (absence.reason || reason) : reason,
    actorId,
    absenceId: absence.id,
    skipJobIds,
    priorSummary: resumed ? priorRedistribution : null,
  });
  const [updated] = await db('technician_absences')
    .where({ id: absence.id })
    .update({ redistribution: JSON.stringify(summary) })
    .returning('*');

  return { absence: updated || { ...absence, redistribution: summary }, summary, resumed };
}

/**
 * Clear a technician's absence for a date; resolves parked overflow alerts,
 * moves nothing back.
 *
 * The absence UPDATE and every resolveAlert run inside ONE db.transaction
 * (finding 5): a resolveAlert rejection rolls the clear back too, so the
 * absence never ends up cleared with its overflow alerts left dangling
 * open (or vice versa).
 */
async function clearTechOut({ technicianId, date, actorId }) {
  const resolvedAlerts = [];
  const updated = await db.transaction(async (trx) => {
    // Lock the absence row FOR UPDATE and re-read its live redistribution
    // status under that lock (tech-out P1): the pre-transaction read a plain
    // clear used to do is unlocked and can be stale by the time this commits
    // — a genuinely in-flight run (fresh 'running' lease) must not have its
    // absence pulled out from under it mid-move. A STALE lease (the run that
    // held it died — crash, deploy) is presumed dead and clears normally,
    // same staleness window markTechOut's own resume claim uses.
    const absence = await trx('technician_absences')
      .where({ technician_id: technicianId, absence_date: date })
      .whereNull('cleared_at')
      .forUpdate()
      .first();
    if (!absence) throw serviceError(404, 'NOT_OUT', 'Technician is not marked out for this date');
    const { redistribution } = absence;
    if (redistribution && redistribution.status === 'running') {
      const startedAtMs = redistribution.started_at ? new Date(redistribution.started_at).getTime() : NaN;
      const isStale = Number.isFinite(startedAtMs)
        && (Date.now() - startedAtMs) > RESUME_LEASE_STALE_MINUTES * 60 * 1000;
      if (!isStale) {
        throw serviceError(409, 'REDISTRIBUTION_RUNNING', 'A redistribution run is still in progress for this absence — try again once it finishes');
      }
    }

    const rows = await trx('technician_absences')
      .where({ id: absence.id })
      .update({ cleared_at: trx.fn.now(), cleared_by: actorId || null })
      .returning('*');

    // Queried INSIDE this same transaction, never a pre-snapshot (tech-out
    // P1): a pre-read taken before the lock above could miss an alert a
    // still-running redistribution parks between that read and this commit,
    // leaving it open forever once the absence clears.
    const openAlerts = await trx('dispatch_alerts')
      .where({ type: 'tech_out_overflow', tech_id: technicianId })
      .whereNull('resolved_at')
      .whereRaw("payload->>'date' = ?", [date])
      .select('id');
    for (const { id } of openAlerts) {
      // resolveAlert is the sole writer; small set, order doesn't matter.
      // A rejection here throws out of this callback and rolls the whole
      // transaction back — the clear above included.
      const row = await resolveAlert({
        id, resolvedBy: actorId, auto: true, trx,
      });
      if (row) resolvedAlerts.push(row);
    }
    return rows[0];
  });

  logger.info(`[tech-out] cleared absence ${updated.id} for ${technicianId} on ${date}; resolved ${resolvedAlerts.length} overflow alert(s)`);

  return { absence: updated, resolvedAlerts };
}

module.exports = {
  REASONS,
  techOutEnabled,
  getTechOut,
  markTechOut,
  clearTechOut,
  redistributeTechDay,
  rankBumpOrder,
};
