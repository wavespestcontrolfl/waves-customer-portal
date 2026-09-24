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
      },
      trx,
    });
    created[i] = memberIds.map((id) => ({ job_id: id, alert_id: alert.id, bump_order: i + 1 }));
  }
  for (const entries of created) parked.push(...entries);

  return { total: stops.length, units: ranked.length, parked, moved: [], failed: [], status: 'complete' };
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
  rankBumpOrder,
  _test: { unitsOf, customerDisplayName },
};
