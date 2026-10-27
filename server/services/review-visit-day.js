/**
 * The day a drafted review text speaks about (owner 2026-10-27, "FIX"): the
 * day the technician was at the visit.
 *
 * A real completion stamps service_records.service_date with the day the visit
 * CLOSES. A visit worked days earlier and closed late then reads as worked
 * today: on 2026-10-26 a close-out of Oct 3-25 visits sent nine customers
 * "Thanks for having us out today." The drafter takes its "today" / "day
 * after" wording, its "completed N days ago" fact, its history window and its
 * timing check from the date it is given, so that date is the earlier ET
 * calendar day of the record's date and the day the visit was worked.
 *
 * The day the visit was worked, by the service report's own staleness rule
 * (visit-timeline.js, also used by lawn-watering-late-close.js):
 *   1. its arrival stamp, unless the stamp is stale (before the scheduled day,
 *      or with no scheduled day more than 18 hours before the close: an
 *      earlier, aborted attempt);
 *   2. with no kept stamp, its scheduled day (only when the close is on or
 *      after it: an early close of a future visit has none);
 *   3. with neither, the raw arrival stamp.
 *
 * Only the date handed to the drafter moves. The review_requests row keeps the
 * record's date (rate page, click guard, retry reuse).
 */
const db = require('../models/db');
const { etCalendarDayOf } = require('../utils/datetime-et');
const { staleTimestampBounds, isStaleTimestamp } = require('./service-report/visit-timeline');

function instantOf(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * When the visit was worked: an ISO instant (an arrival stamp), a YYYY-MM-DD
 * day (the scheduled day), or null when nothing is known.
 */
function visitWorkedOn({ arrivedAt = null, scheduledDate = null, completedAt = null } = {}) {
  const arrival = instantOf(arrivedAt);
  const bounds = staleTimestampBounds(instantOf(completedAt), scheduledDate);
  if (arrival && !isStaleTimestamp(arrival, bounds)) return arrival;
  if (bounds.scheduledDay) return bounds.scheduledDay;
  return arrival;
}

/** The earlier ET calendar day of `recordDate` and `workedOn`; either alone when the other is missing. */
function draftVisitDate(recordDate, workedOn) {
  if (!workedOn) return recordDate || null;
  if (!recordDate) return workedOn;
  return etCalendarDayOf(workedOn) < etCalendarDayOf(recordDate) ? workedOn : recordDate;
}

/**
 * The date to hand the drafter for a touch about this visit. The record's own
 * visit first (record-first, like sendOutreachTouch's visit-context recovery),
 * else the cadence's visit. Any read failure keeps `recordDate` (today's
 * behavior).
 */
async function draftServiceDate({ recordDate = null, serviceRecordId = null, scheduledServiceId = null } = {}, database = db) {
  try {
    const record = serviceRecordId
      ? await database('service_records').where({ id: serviceRecordId }).first('scheduled_service_id', 'created_at')
      : null;
    const visitId = record?.scheduled_service_id || scheduledServiceId || null;
    if (!visitId) return recordDate || null;
    const visit = await database('scheduled_services').where({ id: visitId }).first('arrived_at', 'scheduled_date', 'completed_at');
    if (!visit) return recordDate || null;
    const workedOn = visitWorkedOn({
      arrivedAt: visit.arrived_at,
      scheduledDate: visit.scheduled_date,
      completedAt: visit.completed_at || record?.created_at || null,
    });
    return draftVisitDate(recordDate, workedOn);
  } catch {
    return recordDate || null;
  }
}

module.exports = { draftServiceDate, draftVisitDate, visitWorkedOn };
