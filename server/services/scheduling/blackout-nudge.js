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

function clearOfBlackout(dateStr, blackoutDates, { skipWeekends = false } = {}) {
  if (!dateStr || !(blackoutDates instanceof Set) || blackoutDates.size === 0) return dateStr;
  let candidate = dateStr;
  for (let nudge = 0; nudge < 14 && blackoutDates.has(candidate); nudge++) {
    let d = addETDays(parseETDateTime(`${candidate}T12:00`), 1);
    if (skipWeekends) {
      const { dayOfWeek } = etParts(d);
      if (dayOfWeek === 6) d = addETDays(d, 2);      // Sat → Mon
      else if (dayOfWeek === 0) d = addETDays(d, 1); // Sun → Mon
    }
    candidate = etDateString(d);
  }
  return candidate;
}

module.exports = { clearOfBlackout };
