/**
 * Technician birthdays as ordinary technician_absences rows (owner 2026-11-24:
 * each technician gets their own birthday off, one paid day; benefits ruling E6,
 * 2026-11-20).
 *
 * A daily tick (scheduler.js) writes one absence row for every ACTIVE technician
 * with a technicians.dob, for each such date inside the next HORIZON_DAYS days.
 * Because the day is an ordinary row, every reader of technician_absences already
 * honors it with no new code path: slot discovery (absentTechDays), the locked
 * commit-time rechecks (assertAssignableTechnician), the recurring seeders, auto-
 * dispatch, the dispatch board's out_today flag and the tech-out screens. The
 * 5-minute tech-out sweep (GATE_TECH_OUT_REDISTRIBUTE) then parks any visit that
 * still sits on that tech-day as an ordinary overflow alert for the dispatcher.
 *
 * Rules:
 *   - A Feb 29 birthday falls on Feb 28 in a year with no Feb 29.
 *   - Never write a row when the technician already has ANY absence row for that
 *     date. An uncleared row is "already out"; a CLEARED row is an office decision
 *     ("tech is back") that the tick never reverses, so a cleared birthday is not
 *     re-created.
 *   - Rows are written directly, never through markTechOut: no stop is parked or
 *     moved by this service, and no alert or message is created.
 *   - reason is the existing generic 'other' (tech-out's own list: sick, emergency,
 *     no_show, other), with no note, so the tech-out screens and alert cards show a
 *     plain "other" and no wording about why. Logs say "days off" only.
 *   - Inactive and prospective technicians, office staff and admins (not field-dispatchable), and a NULL dob,
 *     get nothing. A row
 *     already written stays if a dob later changes; the office clears it in the
 *     tech-out screen.
 *   - Idempotent: a second tick the same day writes nothing.
 * The schedule half has no gate: it sends nothing, charges nothing and deletes nothing.
 *
 * Pay half (GATE_TECH_BIRTHDAY_PAY, default off; owner 2026-11-24: one paid day, 10 hours at the
 * straight rate): on the day itself, the same tick records ONE payroll_time_off entry through the
 * payroll time-off service (createTimeOff, so its lock, final-week and W-2 rules hold). It is
 * written ON the day, never ahead: a technician who leaves, or a date the office changes, before
 * the day costs nothing to undo. A missed or failed tick is made up by the next ones for CATCH_UP_DAYS days
 * (the once-per-date audit rule below is what makes a repeat harmless). Turning the gate on therefore also
 * pays a birthday of the last CATCH_UP_DAYS days that has an open absence row. Rules:
 *   - kind 'holiday', 600 minutes, a generic note. 'pto' would draw the time-off bank; a holiday
 *     never does. (As any holiday entry does, it also pays the holiday work premium on a shift
 *     worked that day.)
 *   - Only for an active W-2 technician whose absence row for the date is still open: a row the
 *     office cleared ("tech is back") pays nothing. The row is read again under the tech-day fence
 *     in the same transaction that writes the entry, so a clear racing the tick cannot leave pay.
 *   - At most once per technician per date, ever: it is skipped when payroll_time_off already
 *     holds a row for the date (the office's own entry is never overwritten) OR the audit log
 *     shows an entry was once added for that technician and date (so an entry the office removed
 *     is not written again by a later tick).
 *   - The pay run reads it only with GATE_PAYROLL_TIME_OFF on; the pay run counts it once because
 *     payroll_time_off is unique on (technician, date).
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, dateOnlyString, validCalendarDate } = require('../utils/datetime-et');
const { lockTechDays } = require('./scheduling/tech-day-lock');

const HORIZON_DAYS = 120;
const ABSENCE_REASON = 'other';
// The paid day: 10 hours at the straight rate (handbook), a holiday-kind entry so the time-off bank is never drawn.
const PAY_KIND = 'holiday';
const PAY_HOURS = 10;
const PAY_NOTE = 'Paid day off';
// A tick that did not run (the scheduler was down at 03:25 ET) or failed is made up by the next ones, this many days back.
const CATCH_UP_DAYS = 7;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** { month, day } of a stored dob (Date or YYYY-MM-DD), or null when unreadable. Pure. */
function monthDayOf(dob) {
  if (dob == null || dob === '') return null;
  const day = validCalendarDate(dateOnlyString(dob));
  if (!day) return null;
  return { month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) };
}

/** The date (YYYY-MM-DD) a birthday is kept on in `year`; Feb 29 is Feb 28 in a common year. Null for an unreadable dob. Pure. */
function birthdayDateInYear(dob, year) {
  const md = monthDayOf(dob);
  if (!md || !Number.isInteger(year)) return null;
  const day = md.month === 2 && md.day === 29 && !isLeapYear(year) ? 28 : md.day;
  return `${String(year).padStart(4, '0')}-${String(md.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Every birthday date within [fromStr, toStr] (inclusive YYYY-MM-DD), ascending. Pure. */
function birthdayDatesBetween(dob, fromStr, toStr) {
  const lo = dateOnlyString(fromStr);
  const hi = dateOnlyString(toStr);
  const fy = Number(String(lo).slice(0, 4));
  const ty = Number(String(hi).slice(0, 4));
  if (!Number.isInteger(fy) || !Number.isInteger(ty)) return [];
  const out = [];
  for (let year = fy; year <= ty; year += 1) {
    const d = birthdayDateInYear(dob, year);
    if (d && d >= lo && d <= hi) out.push(d);
  }
  return out;
}

/**
 * The pay half for ONE technician-day (see the header). Returns 'written' or 'skipped'; throws on a real failure.
 * The caller has checked the gate. It runs in ONE transaction that takes the tech-day fence first (the fence an
 * office clear takes), re-reads the open absence under it and writes the entry inside it, so a clear that commits
 * first is seen (nothing is paid) and a clear that starts later waits for the entry.
 */
async function recordPaidDay(conn, tech, date) {
  if (tech.employment_type !== 'w2') return 'skipped';
  return conn.transaction(async (trx) => {
    await lockTechDays(trx, [{ techId: tech.id, date }]);
    // The roster was read at the start of the pass: read the technician again, so a deactivation, a change of
    // employment or a corrected date of birth since then pays nothing. A plain read, not a row lock: payroll
    // settings take the payroll lock and then this row, so holding the row first would invert that order.
    const current = await trx('technicians').where({ id: tech.id })
      .first('employment_status', 'field_dispatchable', 'employment_type', trx.raw("to_char(dob, 'YYYY-MM-DD') AS dob"));
    if (!current || current.employment_status !== 'active' || current.field_dispatchable !== true || current.employment_type !== 'w2'
      || birthdayDateInYear(current.dob, Number(date.slice(0, 4))) !== date) return 'skipped';
    const open = await trx('technician_absences').where({ technician_id: tech.id, absence_date: date }).whereNull('cleared_at').first('id');
    if (!open) return 'skipped';
    if (await trx('payroll_time_off').where({ technician_id: tech.id, work_date: date }).first('id')) return 'skipped';
    // An entry once added for this date (the office may have removed it since) is never added again.
    const added = await trx('audit_log').where({ action: 'payroll.time_off_added' })
      .whereRaw("metadata->>'technician_id' = ? AND metadata->>'work_date' = ?", [tech.id, date]).first('id');
    if (added) return 'skipped';
    try {
      await require('./payroll-time-off').createTimeOff({
        technicianId: tech.id, workDate: date, kind: PAY_KIND, hours: PAY_HOURS, note: PAY_NOTE,
      }, null, trx);
    } catch (err) {
      // 409: a row appeared in between (never overwritten), the week's pay run is final, or the technician is not W-2.
      if (err && err.name === 'PayrollError' && err.status === 409) {
        logger.warn(`[tech-days-off] paid day for technician ${tech.id} on ${date} not recorded: ${err.message}`);
        return 'skipped';
      }
      throw err;
    }
    return 'written';
  });
}

/**
 * One technician-day: the absence row (today and later only), then the paid day (today and the last CATCH_UP_DAYS
 * days, gate on). Counts into `result`; never throws.
 */
async function syncOneDay(conn, tech, date, { writeAbsence, pay, result }) {
  if (writeAbsence) {
    try {
      const written = await conn.transaction(async (trx) => {
        await lockTechDays(trx, [{ techId: tech.id, date }]);
        // ANY row for the day, cleared or not: an uncleared one means already out, a cleared one is the office's call.
        const existing = await trx('technician_absences').where({ technician_id: tech.id, absence_date: date }).first('id');
        if (existing) return false;
        await trx('technician_absences').insert({ technician_id: tech.id, absence_date: date, reason: ABSENCE_REASON });
        return true;
      });
      if (written) result.written += 1; else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`[tech-days-off] could not write a day off for technician ${tech.id} on ${date}: ${err.message}`);
      return;
    }
  }
  if (!pay) return;
  try {
    if (await recordPaidDay(conn, tech, date) === 'written') result.paid += 1; else result.paySkipped += 1;
  } catch (err) {
    result.failed += 1;
    logger.error(`[tech-days-off] could not record the paid day for technician ${tech.id} on ${date}: ${err.message}`);
  }
}

/**
 * Write the missing rows. Returns { technicians, written, skipped, paid, paySkipped, failed }. One technician-day
 * per transaction under the tech-day fence (the same fence markTechOut takes), so a concurrent mark-out or
 * assignment queues instead of racing. A failure for one day is logged and does not stop the rest; the caller
 * decides what a non-zero `failed` means (the cron throws after the pass). `now` is read once: both ends of the
 * horizon come from that one instant. `technicianIds` limits the pass to those technicians.
 */
async function syncTechDaysOff({ now, conn = db, horizonDays = HORIZON_DAYS, technicianIds } = {}) {
  const instant = now instanceof Date ? now : new Date();
  const today = etDateString(instant);
  const horizon = etDateString(addETDays(instant, horizonDays));
  const catchUpFrom = etDateString(addETDays(instant, -CATCH_UP_DAYS));
  // The assignment rule (technician-eligibility.js): active and field-dispatchable. Office staff and admins have none.
  const query = conn('technicians').where('employment_status', 'active').where('field_dispatchable', true).whereNotNull('dob');
  if (Array.isArray(technicianIds)) query.whereIn('id', technicianIds);
  const techs = await query.select('id', 'employment_type', conn.raw("to_char(dob, 'YYYY-MM-DD') AS dob"));
  const payLive = require('../config/feature-gates').techBirthdayPayLive();
  const result = { technicians: techs.length, written: 0, skipped: 0, paid: 0, paySkipped: 0, failed: 0 };
  for (const tech of techs) {
    for (const date of birthdayDatesBetween(tech.dob, catchUpFrom, horizon)) {
      await syncOneDay(conn, tech, date, { writeAbsence: date >= today, pay: payLive && date <= today, result });
    }
  }
  if (result.written || result.paid || result.failed) {
    logger.info(`[tech-days-off] ${result.written} day(s) off written, ${result.skipped} already set, ${result.paid} paid day(s) recorded, ${result.failed} failed`);
  }
  return result;
}

module.exports = {
  HORIZON_DAYS,
  ABSENCE_REASON,
  birthdayDateInYear,
  birthdayDatesBetween,
  PAY_KIND,
  PAY_HOURS,
  PAY_NOTE,
  CATCH_UP_DAYS,
  syncTechDaysOff,
};
