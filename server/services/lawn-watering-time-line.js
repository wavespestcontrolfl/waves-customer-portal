'use strict';

/**
 * The lawn watering-time line (owner 2026-11-14, decision 1A): one of two
 * fixed, owner-approved sentences, chosen from the live restriction policy
 * (server/config/irrigation-restrictions.js), or no line at all. The words
 * are fixed here and nowhere else; the visit page card and the lawn prep
 * guide both read wateringTimeLine().
 *
 * The owner wanted to recommend 6-8 AM watering, but the SWFWMD Modified
 * Phase III order (lawns one day a week; allowed hours 12:01-4 AM or 8-11:59
 * PM) makes 6-8 AM unlawful while it stands. So the line follows the rule:
 *   - the order's hours (one overnight window, one evening window): the
 *     midnight-to-4-AM sentence;
 *   - a rule that permits 6 to 8 AM (a window covering it, or an explicit
 *     noHourRestriction with no windows): the 6-to-8-AM sentence;
 *   - no rule, or hours that fit neither: no line.
 * Pure: no reads, no logging. The policy comes from currentRestrictionPolicy
 * for the customer's county and the visit's date.
 */

const MIDNIGHT_LINE = 'On your watering day, use the midnight to 4 AM window, not the evening one. A lawn that stays wet all night gets more fungus.';
const MORNING_LINE = 'On your watering days, water between 6 and 8 AM.';
// Grammar only: used when the rule allows one watering day a week.
const MORNING_LINE_ONE_DAY = 'On your watering day, water between 6 and 8 AM.';

const OVERNIGHT_STARTS = Object.freeze(['00:00', '00:01']);
const OVERNIGHT_END = '04:00';
const EVENING_NOT_BEFORE = '18:00';

const coversMorning = (w) => w.start <= '06:00' && w.end >= '08:00';

// The order's shape: exactly one overnight window (00:00 or 00:01 to 04:00)
// and one evening window starting 18:00 or later.
function isOrderShape(windows) {
  if (windows.length !== 2) return false;
  const overnight = windows.filter((w) => OVERNIGHT_STARTS.includes(w.start) && w.end === OVERNIGHT_END);
  const evening = windows.filter((w) => w.start >= EVENING_NOT_BEFORE);
  return overnight.length === 1 && evening.length === 1;
}

function wateringTimeLine(policy) {
  const days = Number(policy?.maxDaysPerWeek);
  if (!(days > 0)) return '';
  const windows = Array.isArray(policy.allowedHours) ? policy.allowedHours : null;
  const morningOk = windows ? windows.some(coversMorning) : policy.noHourRestriction === true;
  if (morningOk) return days === 1 ? MORNING_LINE_ONE_DAY : MORNING_LINE;
  if (days === 1 && windows && isOrderShape(windows)) return MIDNIGHT_LINE;
  return '';
}

module.exports = { wateringTimeLine, MIDNIGHT_LINE, MORNING_LINE, MORNING_LINE_ONE_DAY };
