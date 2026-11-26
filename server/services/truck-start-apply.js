/**
 * Truck sets the shift start (GATE_TRUCK_CLOCK_IN=start, owner 2026-11-26): the truck's
 * recorded first-arrival time is the official start of a technician's paid day. The app
 * Clock in button stays as the backup.
 *
 * services/truck-clock-in.js (shadow recording, called by the Bouncie receiver) writes one
 * truck_clock_in_shadow row per technician per Eastern work day. THIS file is the small
 * follow-up job that reads those rows (a cron tick every 2 minutes, time-tracking-crons.js)
 * and writes the shift. Nothing here runs in the webhook path.
 *
 * For each row of the CURRENT Eastern work day with no applied_at yet, in ONE transaction
 * that locks the row (FOR UPDATE SKIP LOCKED, so two ticks never take the same row) and then
 * the technician's work day (time-tracking lockTruckStartDay):
 *
 *   Eligibility, else the outcome is skipped:<reason> and the row is final:
 *     the GPS time is real (event_time_known) and not in the future; it falls on the row's
 *     Eastern work day and before that day's 11 PM auto-close, and the tick itself runs
 *     before the close; the technician is active; the vehicle agreement was COMPLETED at or
 *     before the GPS time (a later signature never backdates pay).
 *   Then, by what the day holds:
 *     no shift at all          clocked_in: a shift starting at the GPS time (time-tracking's
 *                              insertShift, source truck_gps), only if it overlaps nothing
 *                              and the row is not stale (30 minutes).
 *     one shift, starts later  moved_earlier: its start moves back to the GPS time (the
 *                              technician's favor), original kept and audited, only if no
 *                              other shift is in the gap and the week is open.
 *     one shift, starts more than 5 minutes earlier   flag_early_tap: pay unchanged, one
 *                              admin bell ("clocked in N min before the truck arrived").
 *     one shift, within 5 minutes earlier   ok_within_tolerance.
 *     anything else            needs_review: pay unchanged, one admin bell. That is several
 *                              shifts, a voided or office-edited shift, a shift closed before
 *                              the arrival, an overlap, a stale row or an approved/paid week.
 *   The outcome is stamped on the row (applied_at, applied_action, applied_detail) in the same
 *   transaction as the shift write, so a crash before commit leaves the row for the next tick
 *   and a row with applied_at is never processed again.
 *
 * The bell is raised after the commit (never inside the transaction); applied_detail.notified
 * records that it went out and the next tick retries a bell that failed. Sends nothing to a
 * customer, no text and no email, and no staff push.
 */
const db = require('../models/db');
const logger = require('./logger');
const timeTracking = require('./time-tracking');
const { hasCompletedIssuedRecord, VEHICLE_AGREEMENT_KEY } = require('./staff-onboarding');
const { truckClockInMode } = require('../config/feature-gates');
const { isStaffMaintenanceEnabled } = require('../middleware/staff-maintenance');
const { staffWorkDate } = require('../utils/staff-time-work-date');
const { parseETDateTime, formatETTime } = require('../utils/datetime-et');

const MIN = 60 * 1000;
const EARLY_TOLERANCE_MS = 5 * MIN;
const FUTURE_TOLERANCE_MS = 2 * MIN;
// A shift created from a row older than this is a late catch-up (the job was down, or the
// switch was just turned on): a person decides, the job does not backdate hours.
const MAX_START_LAG_MS = 30 * MIN;
const BATCH = 50;
const ALERT_LINK = '/admin/timetracking?tab=entries';
const ALERT_CATEGORY = 'payroll';

const SKIP = 'skipped:';
const errTag = (err) => (err && (err.code || err.name)) || 'error';

// 11 PM Eastern of the work day: the auto-close cron (time-tracking-crons.js) closes every
// open shift then, so nothing may start at or after it, and the job writes nothing once it ran.
function autoCloseAt(workDate) {
  return parseETDateTime(`${workDate}T23:00`);
}

/**
 * Eligibility, pure. Returns null when the row may be applied, else the skip reason (final).
 * `agreementOk` is the answer to "was the vehicle agreement completed by event_at".
 */
function skipReason({ row, workDate, technician, agreementOk, now }) {
  const eventAt = row.event_at instanceof Date ? row.event_at : new Date(row.event_at);
  if (row.event_time_known !== true) return 'event_time_unknown';
  if (Number.isNaN(eventAt.getTime())) return 'event_time_invalid';
  if (eventAt.getTime() - now.getTime() > FUTURE_TOLERANCE_MS) return 'event_in_future';
  if (staffWorkDate(eventAt) !== workDate) return 'event_wrong_day';
  const close = autoCloseAt(workDate).getTime();
  if (eventAt.getTime() >= close) return 'after_auto_close';
  if (now.getTime() >= close) return 'after_auto_close';
  if (!technician || technician.active !== true) return 'technician_inactive';
  if (agreementOk !== true) return 'agreement_not_signed_by_event';
  return null;
}

const review = (reason, extra = {}) => ({ action: 'needs_review', detail: { reason, ...extra } });

/**
 * What to do with the day, pure. `entries` is every time entry of the technician's work day
 * (voided too). Returns { action, detail, mutate? } where mutate is 'create' or
 * { move: <shift row> }.
 */
function decideDay({ entries, eventAt, now }) {
  const shifts = entries.filter((e) => e.entry_type === 'shift');
  if (entries.some((e) => e.status === 'voided')) return review('shift_voided');
  if (!shifts.length) {
    if (entries.length) return review('entries_without_shift');
    if (now.getTime() - eventAt.getTime() > MAX_START_LAG_MS) {
      return review('row_too_old', { minutes_late: Math.round((now - eventAt) / MIN) });
    }
    return { action: 'clocked_in', detail: { clock_in: eventAt.toISOString() }, mutate: 'create' };
  }
  if (shifts.length > 1) return review('several_shifts', { shifts: shifts.length });

  const shift = shifts[0];
  const clockIn = new Date(shift.clock_in);
  const clockOut = shift.clock_out ? new Date(shift.clock_out) : null;
  if (clockOut && clockOut.getTime() <= eventAt.getTime()) return review('shift_closed_before_arrival');

  if (clockIn.getTime() > eventAt.getTime()) {
    if (shift.status === 'edited' || shift.edited_by || shift.original_clock_in) return review('shift_edited_by_office');
    if (!['active', 'completed'].includes(shift.status)) return review('shift_not_open');
    if (shift.approval_status && shift.approval_status !== 'pending') return review('shift_not_pending');
    return {
      action: 'moved_earlier',
      detail: {
        shift_id: shift.id,
        original_clock_in: clockIn.toISOString(),
        clock_in: eventAt.toISOString(),
        minutes_moved: Math.round(((clockIn - eventAt) / MIN) * 100) / 100,
      },
      mutate: { move: shift },
    };
  }

  const earlyMs = eventAt.getTime() - clockIn.getTime();
  const detail = { shift_id: shift.id, minutes_early: Math.round((earlyMs / MIN) * 100) / 100 };
  if (earlyMs > EARLY_TOLERANCE_MS) return { action: 'flag_early_tap', detail };
  return { action: 'ok_within_tolerance', detail };
}

const needsBell = (action) => action === 'flag_early_tap' || action === 'needs_review';

const REVIEW_WHY = {
  shift_voided: 'a shift that day was voided',
  entries_without_shift: 'the day has time entries but no shift',
  row_too_old: 'the arrival was recorded too long ago to start a shift now',
  several_shifts: 'the day has more than one shift',
  shift_closed_before_arrival: 'the shift ended before the truck arrived',
  shift_edited_by_office: 'the office already edited that shift',
  shift_not_open: 'that shift cannot be changed',
  shift_not_pending: 'that shift is already in review or approved',
  overlaps_existing_shift: 'another shift overlaps the time',
  week_closed: 'that week is approved or paid',
  write_refused: 'the time system refused the change',
};

// The one admin bell for a flag or a review (docs/admin-notifications.md). Never throws:
// returns true when the bell went out.
async function raiseStartBell({ row, technician, workDate, action, detail }, raise) {
  try {
    const first = String(technician?.name || 'technician').trim().split(/\s+/)[0].slice(0, 20) || 'technician';
    const eventAt = new Date(row.event_at);
    let spec;
    if (action === 'flag_early_tap') {
      const minutes = Math.round(Number(detail.minutes_early));
      spec = {
        area: 'Billing',
        action: `check ${first}'s early clock-in`,
        why: `Clocked in ${minutes} min before the truck arrived at the first stop — shop stop or check.`,
      };
    } else {
      spec = {
        area: 'Billing',
        action: `review ${first}'s truck start`,
        why: `The truck reached its first stop at ${formatETTime(eventAt)} but ${REVIEW_WHY[detail.reason] || 'the day is unclear'}; pay is unchanged.`,
      };
    }
    const { raiseAdminAlert } = raise ? { raiseAdminAlert: raise } : require('./admin-alert-compose');
    await raiseAdminAlert(ALERT_CATEGORY, {
      ...spec,
      severity: 'needs-you',
      link: ALERT_LINK,
      subject: { type: 'check', id: `truck-start:${row.technician_id}:${workDate}` },
      doneWhen: 'start_checked',
      who: 'person',
    }, {
      dedupeKey: `truck-start:${row.technician_id}:${workDate}`,
      bellDefault: true,
      metadata: { technicianId: row.technician_id, workDate, truckStart: action },
    });
    return true;
  } catch (err) {
    logger.error(`[truck-start] bell not raised (${errTag(err)})`);
    return false;
  }
}

async function markNotified(rowId) {
  await db('truck_clock_in_shadow')
    .where({ id: rowId })
    .whereRaw("applied_detail IS NOT NULL")
    .update({ applied_detail: db.raw("applied_detail || '{\"notified\": true}'::jsonb") });
}

// The outcome is final once stamped; the caller reads back what it needs for the bell.
async function stamp(trx, rowId, now, action, detail) {
  await trx('truck_clock_in_shadow')
    .where({ id: rowId })
    .whereNull('applied_at')
    .update({
      applied_at: now,
      applied_action: action,
      applied_detail: JSON.stringify({ ...detail, ...(needsBell(action) ? { notified: false } : {}) }),
    });
}

/**
 * Apply one row. Returns null when another tick holds it or it is already applied, else
 * { rowId, action, detail, bell? } with what was stamped.
 */
async function applyRow(rowId, now) {
  let result = null;
  await db.transaction(async (trx) => {
    const row = await trx('truck_clock_in_shadow')
      .where({ id: rowId })
      .whereNull('applied_at')
      .forUpdate()
      .skipLocked()
      .first('*', trx.raw('work_date::text AS work_date_text'));
    if (!row) return;
    const workDate = row.work_date_text;
    const eventAt = new Date(row.event_at);
    const done = async (action, detail, extra = {}) => {
      await stamp(trx, row.id, now, action, detail);
      result = { rowId: row.id, action, detail, row, workDate, ...extra };
    };

    // Cheap checks that need no lock: an unreal time or a closed day is final.
    const early = skipReason({ row, workDate, technician: { active: true }, agreementOk: true, now });
    if (early) {
      await done(`${SKIP}${early}`, { reason: early });
      return;
    }

    const { technician, entries } = await timeTracking.lockTruckStartDay(trx, row.technician_id, workDate);
    let agreementOk = false;
    if (technician?.active === true) {
      agreementOk = await hasCompletedIssuedRecord(trx, row.technician_id, VEHICLE_AGREEMENT_KEY, eventAt, { completedBy: eventAt });
    }
    const reason = skipReason({ row, workDate, technician, agreementOk, now });
    if (reason) {
      await done(`${SKIP}${reason}`, { reason }, { technician });
      return;
    }

    const decision = decideDay({ entries, eventAt, now });
    let { action, detail } = decision;
    if (decision.mutate) {
      // A savepoint: a refusal (approved or paid week, an overlap) undoes only the attempt.
      try {
        await trx.transaction(async (sp) => {
          if (decision.mutate === 'create') {
            const shift = await timeTracking.createTruckStartShift(sp, row.technician_id, {
              at: eventAt, now, lat: row.lat, lng: row.lng,
            });
            detail = { ...detail, shift_id: shift.id };
          } else {
            await timeTracking.moveShiftStartToTruck(sp, decision.mutate.move, { at: eventAt, now });
          }
        });
      } catch (err) {
        if (err?.statusCode !== 409 && err?.status !== 409) throw err;
        const why = err.code === 'SHIFT_OVERLAP' ? 'overlaps_existing_shift'
          : /approved|paid|final|Unlock|Reopen|Void its pay/i.test(err.message || '') ? 'week_closed' : 'write_refused';
        ({ action, detail } = review(why));
      }
    }
    await done(action, detail, { technician });
  });
  return result;
}

/**
 * One tick. Does nothing unless GATE_TRUCK_CLOCK_IN reads exactly `start`, and nothing while
 * staff maintenance mode is on. Only rows of the CURRENT Eastern work day are touched.
 * `raise` is a test seam for the admin bell; `technicianIds` limits the tick to those
 * technicians (the tests use it so a shared database's other rows stay untouched).
 */
async function applyTruckStarts({ now = new Date(), raise = null, technicianIds = null } = {}) {
  const summary = { applied: 0, skipped: 0, bells: 0, errors: 0 };
  if (truckClockInMode() !== 'start') return { ...summary, off: true };
  if (isStaffMaintenanceEnabled()) return { ...summary, maintenance: true };

  const workDate = staffWorkDate(now);
  const scoped = (query, column) => (technicianIds ? query.whereIn(column, technicianIds) : query);
  const ids = await scoped(db('truck_clock_in_shadow'), 'technician_id')
    .where({ work_date: workDate })
    .whereNull('applied_at')
    .orderBy('event_at')
    .limit(BATCH)
    .pluck('id');

  for (const id of ids) {
    try {
      const result = await applyRow(id, now);
      if (!result) continue;
      if (result.action.startsWith(SKIP)) summary.skipped += 1; else summary.applied += 1;
      logger.info(`[truck-start] tech=${result.row.technician_id} ${result.workDate} ${result.action}`);
      if (needsBell(result.action)) {
        const technician = result.technician
          || await db('technicians').where({ id: result.row.technician_id }).first('id', 'name');
        const sent = await raiseStartBell({
          row: result.row, technician, workDate: result.workDate, action: result.action, detail: result.detail,
        }, raise);
        if (sent) { await markNotified(id); summary.bells += 1; }
      }
    } catch (err) {
      summary.errors += 1;
      logger.error(`[truck-start] row not applied, next tick retries (${errTag(err)})`);
    }
  }

  // A bell that failed after its commit: today's flagged rows still marked notified=false.
  const pending = await scoped(db('truck_clock_in_shadow as s'), 's.technician_id')
    .join('technicians as t', 't.id', 's.technician_id')
    .where('s.work_date', workDate)
    .whereIn('s.applied_action', ['flag_early_tap', 'needs_review'])
    .whereRaw("s.applied_detail->>'notified' = 'false'")
    .select('s.id', 's.technician_id', 's.event_at', 's.applied_action', 's.applied_detail', 't.name');
  for (const row of pending) {
    const sent = await raiseStartBell({
      row, technician: { name: row.name }, workDate, action: row.applied_action, detail: row.applied_detail || {},
    }, raise);
    if (sent) { await markNotified(row.id); summary.bells += 1; }
  }
  return summary;
}

module.exports = {
  applyTruckStarts,
  EARLY_TOLERANCE_MS,
  MAX_START_LAG_MS,
  _test: { skipReason, decideDay, applyRow, autoCloseAt },
};
