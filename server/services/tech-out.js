/**
 * "Tech out today" (GATE_TECH_OUT_REDISTRIBUTE) — mark a technician absent
 * for a date and park every open stop on that tech-day as a ranked
 * `tech_out_overflow` dispatch alert ("who gets bumped first") for a human
 * to act on. This is the FOUNDATION slice: nothing is moved automatically —
 * the dispatcher reassigns or quick-moves each parked stop through the
 * existing board actions. Automatic reassignment through the canonical
 * rebooker is a follow-up PR built on this one.
 *
 * Sends NO customer communication of any kind and never changes a
 * customer's date, window or technician.
 *
 * technician_absences is the single source of truth for "who is out on
 * <date>": `assertAssignableTechnician(techId, { conn, date })` reads it, so
 * every assignment writer that threads the destination date (board drag,
 * schedule edit, rebooker date moves, lead/booking/IB creation) refuses the
 * absent tech for that day. Mark-out runs in ONE transaction that first
 * takes the tech-day fence and then the technician row FOR UPDATE (the
 * same order assignment writers use), so an in-flight assignment finishes
 * before the day is snapshotted — nothing can land on the day between the
 * snapshot and the absence becoming visible.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { gateEnvValue } = require('../config/feature-gates');
const { dayStopsQuery } = require('./scheduling/day-stops');
const { lockTechDays } = require('./scheduling/tech-day-lock');
const { createAlert, resolveAlert } = require('./dispatch-alerts');

const REASONS = ['sick', 'emergency', 'no_show', 'other'];
const MAX_NOTE_LENGTH = 300;
// The absent tech's stops that get parked. An en_route stop stays IN — a
// tech pulled off the road mid-drive still needs that stop covered by
// someone. on_site drops out: the tech is physically there, nothing to park.
const ABSENT_STOP_EXCLUDE_STATUSES = ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show', 'on_site'];
const ALERT_TYPE = 'tech_out_overflow';

function techOutEnabled() {
  return gateEnvValue('GATE_TECH_OUT_REDISTRIBUTE');
}

function serviceError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function customerDisplayName(row) {
  const first = row?.first_name || '';
  const lastInitial = row?.last_name ? String(row.last_name).trim().charAt(0).toUpperCase() : '';
  if (first && lastInitial) return `${first} ${lastInitial}.`;
  return first || null;
}

/** The uncleared technician_absences row for a tech+date, or null. */
async function getTechOut({ technicianId, date, conn = db }) {
  const row = await conn('technician_absences')
    .where({ technician_id: technicianId, absence_date: date })
    .whereNull('cleared_at')
    .first();
  return row || null;
}

/**
 * rankBumpOrder — pure. Sorts parked units "bump first" ascending by score:
 *   recurring (is_recurring true — a booster carries a parent but is NOT a
 *   series visit, see auto-dispatch/eligibility.js) +0, else +50
 *   status 'confirmed' +20
 * Ties → later window_start sorts first (more room to still move that day).
 * Returns new objects (does not mutate input) with `bump_reason` attached.
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

/**
 * Group a day's rows into units: a grouped visit (visit_id set) is ONE unit
 * represented by its earliest-window member; an ungrouped row is its own
 * unit. Rows arrive ordered by window_start, so the first member seen is
 * the representative.
 */
function unitsOf(stops) {
  const units = [];
  const byVisit = new Map();
  for (const stop of stops) {
    if (!stop.visit_id) { units.push({ representative: stop, members: [stop] }); continue; }
    const unit = byVisit.get(stop.visit_id);
    if (unit) unit.members.push(stop);
    else {
      const fresh = { representative: stop, members: [stop] };
      byVisit.set(stop.visit_id, fresh);
      units.push(fresh);
    }
  }
  return units;
}

/**
 * Rank `stops` and park each unit as a `tech_out_overflow` alert, inside the
 * caller's transaction. Shared by `parkTechDay` (marking a tech out — the
 * day's full open stop list) and `sweepAbsentTechDays` (the safety net —
 * only the stops some other writer already let land on the absent day,
 * uncovered by an existing alert). `extraPayload` lets a caller stamp extra
 * fields onto every alert's payload (the sweep adds `late_arrival: true`)
 * without disturbing `parkTechDay`'s own shape. Returns the summary stored
 * on the absence row (parkTechDay) or folded into the sweep's per-absence
 * count.
 */
async function parkStops(trx, {
  technicianId, date, reason, absentTechName, stops, extraPayload = {},
}) {
  const units = unitsOf(stops);
  const ranked = rankBumpOrder(units.map((u) => ({ ...u.representative, _members: u.members })));
  const parked = [];
  // Insert alerts in REVERSE bump order (bump #1 created LAST): the Action
  // Queue hydrates by created_at DESC and prepends socket events, so the
  // most recently inserted row lands on top. bump_order itself numbers
  // ascending from 1 in the payload.
  const created = new Array(ranked.length);
  for (let i = ranked.length - 1; i >= 0; i -= 1) {
    const rep = ranked[i];
    const memberIds = rep._members.map((m) => m.id);
    const alert = await createAlert({
      type: ALERT_TYPE,
      severity: 'warn',
      techId: technicianId,
      jobId: rep.id,
      payload: {
        date,
        reason,
        absent_tech_name: absentTechName || null,
        customer_name: customerDisplayName(rep),
        service_type: rep.service_type,
        window_start: rep.window_start,
        window_end: rep.window_end,
        bump_order: i + 1,
        bump_total: ranked.length,
        bump_reason: rep.bump_reason,
        ...(memberIds.length > 1 ? { visit_member_ids: memberIds } : {}),
        ...extraPayload,
      },
      trx,
    });
    created[i] = memberIds.map((id) => ({ job_id: id, alert_id: alert.id, bump_order: i + 1 }));
  }
  for (const entries of created) parked.push(...entries);

  return { total: stops.length, units: ranked.length, parked, moved: [], failed: [], status: 'complete' };
}

/**
 * Park every open stop on `technicianId`'s day for `date` as a ranked
 * overflow alert, inside the caller's transaction. Returns the summary
 * stored on the absence row. Exported for tests.
 */
async function parkTechDay(trx, { technicianId, date, reason, absentTechName }) {
  const stops = await dayStopsQuery(trx, {
    dateStr: date,
    technicianId,
    excludeStatuses: ABSENT_STOP_EXCLUDE_STATUSES,
    select: [
      'scheduled_services.id', 'scheduled_services.status', 'scheduled_services.service_type',
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.is_recurring', 'scheduled_services.visit_id',
      'customers.first_name', 'customers.last_name',
    ],
  }).orderBy('scheduled_services.window_start', 'asc');

  return parkStops(trx, {
    technicianId, date, reason, absentTechName, stops,
  });
}

/** Normalize a technician_absences.absence_date read back from Postgres (a
 * DATE column, returned as a JS Date at UTC midnight) to YYYY-MM-DD. A date
 * already a plain string (fake-db tests, or a value this process wrote in
 * the same tick) passes through unchanged. */
function absenceDateString(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * The safety net for every writer that can land a stop on a marked-out
 * tech's day besides `markTechOut` itself (recurring-child seeding excepted
 * — that one is date-aware at seed time). For every still-open absence
 * today or later, park whatever open stops that tech-day carries and are
 * NOT already covered by an open `tech_out_overflow` alert for that tech +
 * date (covered = the stop's own id is an alert's job_id, OR it appears in
 * an alert's payload.visit_member_ids — a grouped visit some OTHER writer
 * added a member to after the day was parked). Each absence runs in its
 * own transaction, fence first (same lock order as every assignment
 * writer), so a concurrent assignment queues instead of racing the sweep.
 * Idempotent: once a stop is covered by an alert, a later sweep tick skips
 * it — nothing to park twice.
 */
async function sweepAbsentTechDays({ now } = {}) {
  if (!techOutEnabled()) return { skipped: 'gate_off' };

  const today = etDateString(now);
  const absences = await db('technician_absences')
    .whereNull('cleared_at')
    .where('absence_date', '>=', today)
    .select('id', 'technician_id', 'absence_date', 'reason');

  let parked = 0;
  for (const absence of absences) {
    const technicianId = absence.technician_id;
    const date = absenceDateString(absence.absence_date);
    // Serial on purpose — each absence gets its own transaction, and these
    // are independent tech-days on a 5-minute cadence; nothing gained by
    // parallelizing a handful of rows against Railway's shared Postgres.
    const summary = await db.transaction(async (trx) => {
      // Fence first, same order as every assignment writer (markTechOut's
      // own header comment) — an in-flight assignment on this tech-day
      // finishes before the sweep snapshots it.
      await lockTechDays(trx, [{ techId: technicianId, date }]);

      const stops = await dayStopsQuery(trx, {
        dateStr: date,
        technicianId,
        excludeStatuses: ABSENT_STOP_EXCLUDE_STATUSES,
        select: [
          'scheduled_services.id', 'scheduled_services.status', 'scheduled_services.service_type',
          'scheduled_services.window_start', 'scheduled_services.window_end',
          'scheduled_services.is_recurring', 'scheduled_services.visit_id',
          'customers.first_name', 'customers.last_name',
        ],
      }).orderBy('scheduled_services.window_start', 'asc');
      if (stops.length === 0) return { total: 0, units: 0 };

      const openAlerts = await trx('dispatch_alerts')
        .where({ type: ALERT_TYPE, tech_id: technicianId })
        .whereNull('resolved_at')
        .whereRaw("payload->>'date' = ?", [date])
        .select('job_id', 'payload');
      const covered = new Set();
      for (const alert of openAlerts) {
        if (alert.job_id) covered.add(alert.job_id);
        const payload = typeof alert.payload === 'string' ? JSON.parse(alert.payload) : alert.payload;
        const memberIds = payload?.visit_member_ids;
        if (Array.isArray(memberIds)) memberIds.forEach((id) => covered.add(id));
      }

      const uncovered = stops.filter((s) => !covered.has(s.id));
      if (uncovered.length === 0) return { total: 0, units: 0 };

      const tech = await trx('technicians').where({ id: technicianId }).first('id', 'name');
      return parkStops(trx, {
        technicianId,
        date,
        reason: absence.reason,
        absentTechName: tech?.name,
        stops: uncovered,
        extraPayload: { late_arrival: true },
      });
    });

    parked += summary.total;
    logger.info(`[tech-out] sweep: absence ${absence.id} (tech ${technicianId}, ${date}) — ${summary.total} uncovered stop(s) parked`);
  }

  return { absences: absences.length, parked };
}

/** Mark a technician out for a date and park their day, atomically. */
async function markTechOut({ technicianId, date, reason, note, actorId }) {
  if (!technicianId) throw serviceError(400, 'VALIDATION', 'technicianId is required');
  if (!validCalendarDate(date)) throw serviceError(400, 'VALIDATION', 'date must be a valid calendar date (YYYY-MM-DD)');
  if (String(date) < etDateString()) throw serviceError(409, 'PAST_DATE', 'Cannot mark a technician out for a past date');
  if (!REASONS.includes(reason)) throw serviceError(400, 'VALIDATION', `reason must be one of ${REASONS.join(', ')}`);
  if (note != null && String(note).length > MAX_NOTE_LENGTH) {
    throw serviceError(400, 'VALIDATION', `note must be ${MAX_NOTE_LENGTH} characters or fewer`);
  }

  return db.transaction(async (trx) => {
    // Serialize with assignment writers: they take the tech-day fence FIRST
    // and then read this row FOR SHARE inside the transaction
    // (dispatch-assignment.js applyAssignment, rebooker.js, the IB movers).
    // Same order here — fence, then the row FOR UPDATE — so a concurrent
    // mark-out and assignment queue on the fence instead of deadlocking.
    await lockTechDays(trx, [{ techId: technicianId, date }]);
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate().first('id', 'name');
    if (!tech) throw serviceError(400, 'VALIDATION', 'Technician not found');

    let absence;
    try {
      const rows = await trx('technician_absences')
        .insert({
          technician_id: technicianId, absence_date: date, reason, note: note || null, created_by: actorId || null,
        })
        .returning('*');
      absence = rows[0];
    } catch (err) {
      if (err && err.code === '23505') throw serviceError(409, 'ALREADY_OUT', `${tech.name} is already marked out for ${date}`);
      throw err;
    }

    const summary = await parkTechDay(trx, { technicianId, date, reason, absentTechName: tech.name });
    const [updated] = await trx('technician_absences')
      .where({ id: absence.id })
      .update({ redistribution: JSON.stringify(summary) })
      .returning('*');

    logger.info(`[tech-out] ${tech.name} out ${date} (${reason}): ${summary.total} stop(s) in ${summary.units} unit(s) parked`);
    return { absence: updated || { ...absence, redistribution: summary }, summary };
  });
}

/** Clear a technician's absence for a date and resolve its parked alerts, atomically. Moves nothing. */
async function clearTechOut({ technicianId, date, actorId }) {
  return db.transaction(async (trx) => {
    const absence = await trx('technician_absences')
      .where({ technician_id: technicianId, absence_date: date })
      .whereNull('cleared_at')
      .forUpdate()
      .first();
    if (!absence) throw serviceError(404, 'NOT_OUT', 'Technician is not marked out for this date');

    const rows = await trx('technician_absences')
      .where({ id: absence.id })
      .update({ cleared_at: trx.fn.now(), cleared_by: actorId || null })
      .returning('*');

    const openAlerts = await trx('dispatch_alerts')
      .where({ type: ALERT_TYPE, tech_id: technicianId })
      .whereNull('resolved_at')
      .whereRaw("payload->>'date' = ?", [date])
      .select('id');
    const resolvedAlerts = [];
    for (const { id } of openAlerts) {
      // resolveAlert is the sole writer; it broadcasts after this commit.
      const row = await resolveAlert({ id, resolvedBy: actorId, trx, auto: true });
      if (row) resolvedAlerts.push(row);
    }

    logger.info(`[tech-out] cleared absence ${absence.id} for ${technicianId} on ${date}; resolved ${resolvedAlerts.length} overflow alert(s)`);
    return { absence: rows[0], resolvedAlerts };
  });
}

module.exports = {
  REASONS,
  ALERT_TYPE,
  techOutEnabled,
  getTechOut,
  markTechOut,
  clearTechOut,
  parkTechDay,
  sweepAbsentTechDays,
  rankBumpOrder,
  _test: { unitsOf, customerDisplayName },
};
