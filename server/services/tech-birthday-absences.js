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
 *   - Inactive and prospective technicians, and a NULL dob, get nothing. A row
 *     already written stays if a dob later changes; the office clears it in the
 *     tech-out screen.
 *   - Idempotent: a second tick the same day writes nothing.
 * No gate: it sends nothing, charges nothing and deletes nothing.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, dateOnlyString } = require('../utils/datetime-et');
const { lockTechDays } = require('./scheduling/tech-day-lock');

const HORIZON_DAYS = 120;
const ABSENCE_REASON = 'other';

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** { month, day } of a stored dob (Date or YYYY-MM-DD), or null when unreadable. Pure. */
function monthDayOf(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob == null || dob === '' ? '' : dateOnlyString(dob)));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { month: mo, day: d };
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

/** YYYY-MM-DD plus N calendar days (UTC arithmetic on the parts, so a DST change never shifts it). Pure. */
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Write the missing rows. Returns { technicians, written, skipped, failed }. One technician-day per
 * transaction under the tech-day fence (the same fence markTechOut takes), so a concurrent mark-out
 * or assignment queues instead of racing. A failure for one day is logged and does not stop the rest.
 */
async function syncTechDaysOff({ now, conn = db, horizonDays = HORIZON_DAYS } = {}) {
  const today = etDateString(now);
  const horizon = addDaysToDateStr(today, horizonDays);
  const techs = await conn('technicians').where('employment_status', 'active').whereNotNull('dob').select('id', 'dob');
  const result = { technicians: techs.length, written: 0, skipped: 0, failed: 0 };
  for (const tech of techs) {
    for (const date of birthdayDatesBetween(tech.dob, today, horizon)) {
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
      }
    }
  }
  if (result.written || result.failed) logger.info(`[tech-days-off] ${result.written} day(s) off written, ${result.skipped} already set, ${result.failed} failed`);
  return result;
}

module.exports = {
  HORIZON_DAYS,
  ABSENCE_REASON,
  birthdayDateInYear,
  birthdayDatesBetween,
  addDaysToDateStr,
  syncTechDaysOff,
};
