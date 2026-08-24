/**
 * Nudge a series date forward off blackout days (one-off owner blackouts +
 * weekly days off, resolved by scheduling/blackout-dates.getBlackoutDates).
 * A blocked follow-up moves forward a day at a time — re-applying the
 * forward weekend shift when the series skips weekends — until clear;
 * skipping the visit entirely would silently shrink the customer's plan.
 *
 * Weekly days off are BUSINESS closures, so the nudge applies regardless of
 * the row's own skip_weekends preference (they arrive inside blackoutDates).
 *
 * Pure (no DB) — ONE implementation shared by the recurring seeder and every
 * admin-schedule series generator, so their blackout behavior cannot drift.
 */

const { parseETDateTime, etParts, etDateString, addETDays } = require('../../utils/datetime-et');

// `blackout` is either a Set of YYYY-MM-DD strings (the seeder's preloaded
// shape) or { dates: Set, weeklyDaysOff: Set } (getBlackoutLayers): the
// weeklyDaysOff day-of-week layer applies to EVERY date, so weekly closures
// hold even past whatever horizon the dates Set was expanded over.
function isBlackedOut(dateStr, blackout) {
  if (!dateStr || !blackout) return false;
  const dates = blackout instanceof Set ? blackout : blackout.dates;
  if (dates instanceof Set && dates.has(dateStr)) return true;
  const weekly = blackout instanceof Set ? null : blackout.weeklyDaysOff;
  if (weekly instanceof Set && weekly.size > 0) {
    const { dayOfWeek } = etParts(parseETDateTime(`${dateStr}T12:00`));
    if (weekly.has(dayOfWeek)) return true;
  }
  return false;
}

// Returns the cleared date, or NULL when the bounded search exhausts (e.g.
// a run of 3+ consecutive closed weeks, or every weekday configured off):
// callers must SKIP a null candidate — refusing to generate beats silently
// booking a business closure.
function clearOfBlackout(dateStr, blackout, { skipWeekends = false } = {}) {
  if (!isBlackedOut(dateStr, blackout)) return dateStr;
  let candidate = dateStr;
  for (let nudge = 0; nudge < 21; nudge++) {
    let d = addETDays(parseETDateTime(`${candidate}T12:00`), 1);
    if (skipWeekends) {
      const { dayOfWeek } = etParts(d);
      if (dayOfWeek === 6) d = addETDays(d, 2);      // Sat → Mon
      else if (dayOfWeek === 0) d = addETDays(d, 1); // Sun → Mon
    }
    candidate = etDateString(d);
    if (!isBlackedOut(candidate, blackout)) return candidate;
  }
  return null;
}

module.exports = { clearOfBlackout, isBlackedOut };
