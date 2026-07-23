/**
 * Owner blackout days — shared lookup for every surface that offers or
 * commits customer-facing dates (admin Settings → Scheduling → Blackout
 * days; table: schedule_blackout_dates).
 *
 * Two layers, one enforcement point:
 *   - one-off dates      (table: schedule_blackout_dates)
 *   - weekly days off    (system_settings key `schedule_weekly_days_off`:
 *                         JSON array of JS day-of-week ints, 0=Sun…6=Sat —
 *                         every matching date is treated as blacked out)
 *
 * Consumers:
 *   - scheduling/find-time.js       (offer enumeration: /book, reschedule,
 *                                    estimate route-aware slots, AI searches)
 *   - estimate-slot-availability.js (ASAP capacity fallback enumerates its
 *                                    own dates)
 *   - rebooker.findRescheduleOptions (rain-out SMS alternates)
 *   - routes/booking.js /confirm + slot-reservation reserveSlot (REDEMPTION
 *     re-check: a signed offer minted before the blackout was added must not
 *     stay bookable)
 *   - recurring-appointment-seeder   (nudges recurring children off closed
 *                                    days)
 *
 * All helpers FAIL OPEN (empty set / false) — an availability or commit
 * outage is worse than an offered day off; the office alert + dispatch board
 * still surface anything that slips through.
 */

const db = require('../../models/db');
const logger = require('../logger');

const WEEKLY_DAYS_OFF_KEY = 'schedule_weekly_days_off';

function toDateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).split('T')[0];
}

// Day-of-week (0=Sun…6=Sat) of a YYYY-MM-DD string. The noon anchor keeps
// the calendar date stable across server timezones (same trick as
// find-time's enumerateDates).
function dowOfDateStr(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay();
}

// Set of day-of-week ints the business takes off every week. Fail-open
// (empty set), like the date helpers.
async function getWeeklyDaysOff() {
  try {
    const row = await db('system_settings').where('key', WEEKLY_DAYS_OFF_KEY).first('value');
    if (!row || !row.value) return new Set();
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  } catch (err) {
    logger.warn(`[blackout-dates] weekly days-off lookup failed (failing open): ${err.message}`);
    return new Set();
  }
}

// Concrete YYYY-MM-DD dates within [fromStr, toStr] whose day-of-week is in
// dowSet. Pure — exported for tests.
function expandWeeklyDaysOff(fromStr, toStr, dowSet) {
  const dates = [];
  if (!dowSet || !dowSet.size) return dates;
  const start = new Date(fromStr + 'T12:00:00');
  const end = new Date(toStr + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (dowSet.has(d.getDay())) dates.push(toDateStr(d));
  }
  return dates;
}

// Set of YYYY-MM-DD blackout dates within [fromStr, toStr] (inclusive) —
// one-off dates plus every weekly-day-off occurrence in the range.
async function getBlackoutDates(fromStr, toStr) {
  let dates = new Set();
  try {
    const rows = await db('schedule_blackout_dates')
      .whereBetween('date', [fromStr, toStr])
      .select('date');
    dates = new Set(rows.map((r) => toDateStr(r.date)));
  } catch (err) {
    logger.warn(`[blackout-dates] range lookup failed (failing open): ${err.message}`);
  }
  const weekly = await getWeeklyDaysOff();
  for (const d of expandWeeklyDaysOff(fromStr, toStr, weekly)) dates.add(d);
  return dates;
}

// True when a single date is blacked out (one-off or weekly). Accepts
// YYYY-MM-DD strings OR JS Date values (pg DATE columns arrive as either
// depending on the caller) — String() on a Date is a locale string that
// would silently never match.
async function isBlackoutDate(dateVal) {
  const dateStr = toDateStr(dateVal);
  if (!dateStr) return false;
  const weekly = await getWeeklyDaysOff();
  if (weekly.has(dowOfDateStr(dateStr))) return true;
  try {
    const row = await db('schedule_blackout_dates')
      .where('date', dateStr)
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[blackout-dates] date lookup failed (failing open): ${err.message}`);
    return false;
  }
}

module.exports = {
  getBlackoutDates,
  isBlackoutDate,
  getWeeklyDaysOff,
  expandWeeklyDaysOff,
  WEEKLY_DAYS_OFF_KEY,
};
