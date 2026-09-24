/**
 * "Tech out today" (GATE_TECH_OUT_REDISTRIBUTE) — mark a technician absent
 * for a date, redistribute every stop on that tech-day to another eligible
 * tech who can take it at the SAME promised arrival window, and park the
 * rest as ranked dispatch alerts for a human to decide who gets bumped.
 *
 * Sends NO customer communication of any kind — moves are silent
 * reassignments through the normal dispatch-assignment writer; nothing
 * here touches SMS/email/reminders beyond what assignDispatchJob already
 * does for a routine reassignment.
 *
 * technician_absences is the single source of truth for "who is out
 * today" — clearTechOut never re-assigns a moved stop back; a human
 * decides that on the board like any other reassignment.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { gateEnvValue } = require('../config/feature-gates');
const { dayStopsQuery, guardedCoordSelects } = require('./scheduling/day-stops');
const { applyAssignable } = require('./technician-eligibility');
const { inactiveCapabilitiesForServices } = require('./technician-capabilities');
const { arrivalWindowRoutingEnabled, checkArrivalPlacement } = require('./scheduling/arrival-route');
const { windowsOverlap, DEFAULT_EXCLUDE_STATUSES } = require('./scheduling/occupancy');
const { driveMin, resolveGeo, HQ } = require('./auto-dispatch/geo');
const { assignDispatchJob } = require('./dispatch-assignment');
const { createAlert, resolveAlert } = require('./dispatch-alerts');

const REASONS = ['sick', 'emergency', 'no_show', 'other'];
const MAX_NOTE_LENGTH = 300;
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
 * rankBumpOrder — pure. Sorts parked stops "bump first" ascending by score:
 *   recurring (recurring_parent_id set) +0, else +50
 *   status 'confirmed' +20
 * Ties → later window_start sorts first (more room to still move that day).
 * Returns new objects (does not mutate input) with `bump_reason` attached.
 */
function rankBumpOrder(stops) {
  const scored = (stops || []).map((stop) => {
    const recurring = !!stop.recurring_parent_id;
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
  return conflict ? { fits: false, conflict_reason: 'overlap' } : { fits: true };
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

/**
 * Decide where (if anywhere) `stop` lands. Returns either
 *   { placed: true, best: { id, name, detour_minutes } }
 * or
 *   { placed: false, near_misses: [{ technician_id, technician_name, conflict_reason }] }
 */
async function placeStop(stop, crew, date) {
  if (!crew.length) return { placed: false, near_misses: [] };

  const inactive = await inactiveCapabilitiesForServices(db, crew.map((c) => c.id), [{ service_type: stop.service_type }]);
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
    const near_misses = evaluations.slice(0, 3).map((e) => ({
      technician_id: e.tech.id, technician_name: e.tech.name, conflict_reason: e.conflict_reason,
    }));
    return { placed: false, near_misses };
  }

  const ranked = [];
  for (const e of fitting) {
    // Small crew; sequential keeps each read consistent.
    const { detour_minutes, stops_that_day } = await detourForTech(stop, e.tech.id, date);
    ranked.push({ tech: e.tech, detour_minutes, stops_that_day });
  }
  ranked.sort((a, b) => {
    const aDetour = a.detour_minutes;
    const bDetour = b.detour_minutes;
    if (aDetour == null && bDetour == null) return a.stops_that_day - b.stops_that_day;
    if (aDetour == null) return 1;
    if (bDetour == null) return -1;
    if (aDetour !== bDetour) return aDetour - bDetour;
    return a.stops_that_day - b.stops_that_day;
  });
  const winner = ranked[0];
  return {
    placed: true,
    best: { id: winner.tech.id, name: winner.tech.name, detour_minutes: winner.detour_minutes },
  };
}

/**
 * Move every movable stop off `technicianId`'s day for `date` onto another
 * eligible tech at the same promised window; park the rest as ranked
 * dispatch alerts. Processes stops sequentially — each assign is its own
 * transaction, and a later stop's fit test must see earlier moves.
 */
async function redistributeTechDay({ technicianId, date, reason, actorId }) {
  const absentTech = await db('technicians').where({ id: technicianId }).first('id', 'name');

  const stops = await dayStopsQuery(db, {
    dateStr: date,
    technicianId,
    excludeStatuses: ABSENT_STOP_EXCLUDE_STATUSES,
    select: [
      'scheduled_services.id', 'scheduled_services.customer_id', 'scheduled_services.status',
      'scheduled_services.service_type', 'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.recurring_parent_id',
      ...guardedCoordSelects(db),
      'customers.first_name', 'customers.last_name',
    ],
  }).orderBy('scheduled_services.window_start', 'asc');

  const crew = await applyAssignable(db('technicians'))
    .whereNot('technicians.id', technicianId)
    .whereNotExists(function excludeOtherAbsentees() {
      this.select(1).from('technician_absences as ta')
        .whereRaw('ta.technician_id = technicians.id')
        .andWhere('ta.absence_date', date)
        .whereNull('ta.cleared_at');
    })
    .select('technicians.id', 'technicians.name');

  const moved = [];
  const failed = [];
  const toPark = [];

  for (const stop of stops) {
    // Sequential by design: a later stop's fit test (and the crew's
    // occupancy) must see this move.
    const placement = await placeStop(stop, crew, date);
    if (placement.placed) {
      try {
        await assignDispatchJob({
          jobId: stop.id, technicianId: placement.best.id, actorId, expectTechnicianId: technicianId,
        });
        moved.push({
          job_id: stop.id,
          to_technician_id: placement.best.id,
          to_technician_name: placement.best.name,
          detour_minutes: placement.best.detour_minutes,
        });
      } catch (err) {
        failed.push({ job_id: stop.id, error: err.message });
      }
    } else {
      toPark.push({ stop, near_misses: placement.near_misses });
    }
  }

  const ranked = rankBumpOrder(toPark.map((p) => p.stop));
  const nearMissById = new Map(toPark.map((p) => [p.stop.id, p.near_misses]));
  const parked = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const stop = ranked[i];
    // createAlert is the sole writer; keep insertion order == bump_order.
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
        bump_reason: stop.bump_reason,
        near_misses: (nearMissById.get(stop.id) || []).slice(0, 3),
      },
    });
    parked.push({ job_id: stop.id, alert_id: alert.id, bump_order: i + 1 });
  }

  logger.info(`[tech-out] redistributed ${date} for ${absentTech?.name || technicianId}: ${moved.length} moved, ${parked.length} parked, ${failed.length} failed (of ${stops.length})`);

  return { total: stops.length, moved, parked, failed };
}

/** Mark a technician out for a date and redistribute their day. */
async function markTechOut({ technicianId, date, reason, note, actorId }) {
  if (!technicianId) throw serviceError(400, 'VALIDATION', 'technicianId is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw serviceError(400, 'VALIDATION', 'date must be YYYY-MM-DD');
  }
  if (String(date) < etDateString()) {
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
  try {
    const rows = await db('technician_absences')
      .insert({
        technician_id: technicianId, absence_date: date, reason, note: note || null, created_by: actorId || null,
      })
      .returning('*');
    absence = rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      throw serviceError(409, 'ALREADY_OUT', `${tech.name} is already marked out for ${date}`);
    }
    throw err;
  }

  const summary = await redistributeTechDay({ technicianId, date, reason, actorId });
  const [updated] = await db('technician_absences')
    .where({ id: absence.id })
    .update({ redistribution: JSON.stringify(summary) })
    .returning('*');

  return { absence: updated || { ...absence, redistribution: summary }, summary };
}

/** Clear a technician's absence for a date; resolves parked overflow alerts, moves nothing back. */
async function clearTechOut({ technicianId, date, actorId }) {
  const absence = await getTechOut({ technicianId, date });
  if (!absence) throw serviceError(404, 'NOT_OUT', 'Technician is not marked out for this date');

  const rows = await db('technician_absences')
    .where({ id: absence.id })
    .update({ cleared_at: db.fn.now(), cleared_by: actorId || null })
    .returning('*');
  const updated = rows[0];

  const openAlerts = await db('dispatch_alerts')
    .where({ type: 'tech_out_overflow', tech_id: technicianId })
    .whereNull('resolved_at')
    .whereRaw("payload->>'date' = ?", [date])
    .select('id');

  const resolvedAlerts = [];
  for (const { id } of openAlerts) {
    // resolveAlert is the sole writer; small set, order doesn't matter.
    const row = await resolveAlert({ id, resolvedBy: actorId, auto: true });
    if (row) resolvedAlerts.push(row);
  }

  logger.info(`[tech-out] cleared absence ${absence.id} for ${technicianId} on ${date}; resolved ${resolvedAlerts.length} overflow alert(s)`);

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
