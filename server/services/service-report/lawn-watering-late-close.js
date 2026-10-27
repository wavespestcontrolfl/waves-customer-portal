/**
 * Lawn watering, late close (owner ruling 2026-10-27, "go" on the watering-alert scope).
 *
 * A lawn visit closed on a later ET day than the day it was worked gets no
 * watering steps, no watering text and no office alert. The steps are anchored
 * to the completion instant ("today's treatment", "by Tue 12 PM"), so a visit
 * worked Oct 3 and closed Oct 26 (a backlog close-out run as a real completion,
 * not a backfill) read as treated Oct 26: three customers were told to water in
 * by Nov 9 for a treatment whose window had closed Oct 17-23, and eight visits
 * with no photo read raised an office alert asking for steps weeks later. No
 * accurate "today" text exists for such a visit (the backfill path says the
 * same of its completion text: "a 'we just finished' text today would be a lie").
 *
 * The day the visit was worked, in order:
 *   1. the first arrival stamp the report's own staleness rule keeps
 *      (visit-timeline.js: a stamp before the scheduled day is an earlier,
 *      aborted attempt; with no scheduled day, a stamp more than 18 hours
 *      before the close is);
 *   2. with no kept stamp, the scheduled day;
 *   3. with neither, the first raw arrival stamp (the 18-hour rule above
 *      drops exactly the stamp a late close leaves behind).
 * Late = that day is before the completion's ET day and, when an arrival
 * instant is known, the close is LATE_CLOSE_MIN_HOURS or more after it, so a
 * visit that runs past midnight keeps its text.
 */
const { etDateString } = require('../../utils/datetime-et');
const { staleTimestampBounds, isStaleTimestamp } = require('./visit-timeline');

// No lawn visit is worked for 12 hours; a close that long after the arrival,
// on a later day, is a close of an earlier day's work.
const LATE_CLOSE_MIN_HOURS = 12;
const HOUR_MS = 60 * 60 * 1000;

function instantOf(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * @param {object} input
 * @param {Array}  input.arrivals        arrival stamps, in the report's candidate order
 * @param {Array}  input.scheduledDates  the record's and the scheduled visit's scheduled_date
 * @param {*}      input.completedAt     the completion instant the steps would be anchored to
 * @returns {boolean} true only for a visit closed on a later day than it was worked
 */
function lawnVisitClosedLate({ arrivals = [], scheduledDates = [], completedAt = null } = {}) {
  const done = instantOf(completedAt);
  if (!done) return false;
  const doneDay = etDateString(new Date(done));
  const lateFrom = (arrival) => etDateString(new Date(arrival)) < doneDay
    && Date.parse(done) - Date.parse(arrival) >= LATE_CLOSE_MIN_HOURS * HOUR_MS;

  const stamps = (Array.isArray(arrivals) ? arrivals : []).map(instantOf).filter(Boolean);
  const bounds = staleTimestampBounds(done, ...(Array.isArray(scheduledDates) ? scheduledDates : []));
  const kept = stamps.find((stamp) => !isStaleTimestamp(stamp, bounds));
  if (kept) return lateFrom(kept);
  // bounds.scheduledDay is set only when the close is on or after it (an early
  // close-out of a future visit has none), so a later close day means late.
  if (bounds.scheduledDay) return bounds.scheduledDay < doneDay;
  return stamps.length ? lateFrom(stamps[0]) : false;
}

module.exports = { lawnVisitClosedLate, LATE_CLOSE_MIN_HOURS };
