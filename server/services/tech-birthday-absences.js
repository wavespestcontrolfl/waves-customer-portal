/**
 * Technician days off from a date of birth (owner 2026-11-24: each technician gets their own birthday off, one
 * paid day; benefits ruling E6, 2026-11-20).
 *
 * A daily tick (scheduler.js, 03:25 ET) writes one technician_absences row for every ACTIVE, FIELD-DISPATCHABLE
 * technician (the assignment rule of technician-eligibility.js; office staff and admins get none) with a
 * technicians.dob, for each such date inside the next HORIZON_DAYS days. Because the day is an ordinary row,
 * every reader of technician_absences already honors it with no new code path: slot discovery (absentTechDays),
 * the locked commit-time rechecks (assertAssignableTechnician), the recurring seeders, auto-dispatch, the
 * dispatch board's out_today flag and the tech-out screens. The 5-minute tech-out sweep
 * (GATE_TECH_OUT_REDISTRIBUTE) then parks any visit that still sits on that tech-day as an ordinary overflow
 * alert for the dispatcher. The office can look up and clear one of these rows whatever that gate says
 * (routes/admin-tech-out.js).
 *
 * PAY IS RECORDED BY THE OFFICE. Nothing here writes payroll_time_off or anything else in payroll, and nothing here
 * raises a notification. An ops bell OUTSIDE the portal prompts the office to add the paid day (10 hours, a
 * 'holiday' entry in Payroll, Time off: a holiday entry never draws the time-off bank; a 'pto' one does).
 *
 * Each row this service inserts is announced after its transaction commits with tech-out's own emitAbsenceChange,
 * exactly as a tech-out mark does: the public estimate slot cache is dropped (a cached offer would otherwise keep
 * showing the newly blocked day for up to five minutes) and the admin dispatch board refreshes its roster. It parks
 * and moves no stop.
 *
 * Rules:
 *   - A Feb 29 birthday falls on Feb 28 in a year with no Feb 29.
 *   - Never write a row when the technician already has ANY absence row for that date. An uncleared row is
 *     "already out"; a CLEARED row is an office decision ("tech is back") that the tick never reverses, so a
 *     cleared day is not re-created.
 *   - Rows are written directly, never through markTechOut: no stop is parked or moved by this service, and no
 *     alert or message is created.
 *   - reason is the existing generic 'other' (tech-out's own list: sick, emergency, no_show, other), with no
 *     note, so the tech-out screens and alert cards show a plain "other". Logs say "days off" only.
 *   - Inactive and prospective technicians, office staff and admins (not field-dispatchable), and a NULL dob, get
 *     nothing. A row already written stays if a dob later changes; the office clears it in the tech-out screen.
 *   - Idempotent: a second tick the same day writes nothing and announces nothing.
 * No gate: it sends nothing, charges nothing, writes no pay and deletes nothing.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, dateOnlyString, validCalendarDate } = require('../utils/datetime-et');
const { lockTechDays } = require('./scheduling/tech-day-lock');

const HORIZON_DAYS = 120;
const ABSENCE_REASON = 'other';
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

/** One technician-day: the absence row, announced after it commits. Counts into `result`; never throws. */
async function syncOneDay(conn, tech, date, result) {
  try {
    const absenceId = await conn.transaction(async (trx) => {
      await lockTechDays(trx, [{ techId: tech.id, date }]);
      // ANY row for the day, cleared or not: an uncleared one means already out, a cleared one is the office's call.
      const existing = await trx('technician_absences').where({ technician_id: tech.id, absence_date: date }).first('id');
      if (existing) return null;
      const [row] = await trx('technician_absences')
        .insert({ technician_id: tech.id, absence_date: date, reason: ABSENCE_REASON }).returning('id');
      return (row && row.id) || row || true;
    });
    if (!absenceId) { result.skipped += 1; return; }
    result.written += 1;
    // After the commit, best-effort (it never throws): flush the slot cache and refresh the board, as a tech-out mark does.
    require('./tech-out').emitAbsenceChange({
      technicianId: tech.id, date, out: true, absenceId: absenceId === true ? null : absenceId,
    });
  } catch (err) {
    result.failed += 1;
    logger.error(`[tech-days-off] could not write a day off for technician ${tech.id}: ${err.code || "write_failed"}`);
  }
}

/**
 * Write the missing rows. Returns { technicians, written, skipped, failed }. One technician-day
 * per transaction under the tech-day fence (the same fence markTechOut takes), so a concurrent mark-out or
 * assignment queues instead of racing. A failure for one day is logged and does not stop the rest; the caller
 * decides what a non-zero `failed` means (the cron throws after the pass). `now` is read once: both ends of the
 * horizon come from that one instant. `technicianIds` limits the pass to those technicians.
 */
async function syncTechDaysOff({ now, conn = db, horizonDays = HORIZON_DAYS, technicianIds } = {}) {
  const instant = now instanceof Date ? now : new Date();
  const today = etDateString(instant);
  const horizon = etDateString(addETDays(instant, horizonDays));
  // The assignment rule (technician-eligibility.js): active and field-dispatchable. Office staff and admins have none.
  const query = conn('technicians').where('employment_status', 'active').where('field_dispatchable', true).whereNotNull('dob');
  if (Array.isArray(technicianIds)) query.whereIn('id', technicianIds);
  const techs = await query.select('id', conn.raw("to_char(dob, 'YYYY-MM-DD') AS dob"));
  const result = { technicians: techs.length, written: 0, skipped: 0, failed: 0 };
  for (const tech of techs) {
    for (const date of birthdayDatesBetween(tech.dob, today, horizon)) {
      await syncOneDay(conn, tech, date, result);
    }
  }
  if (result.written || result.failed) {
    logger.info(`[tech-days-off] ${result.written} day(s) off written, ${result.skipped} already set, ${result.failed} failed`);
  }
  return result;
}

module.exports = {
  HORIZON_DAYS,
  ABSENCE_REASON,
  birthdayDateInYear,
  birthdayDatesBetween,
  syncTechDaysOff,
};
