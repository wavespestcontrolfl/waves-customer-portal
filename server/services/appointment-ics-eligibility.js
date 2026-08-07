/**
 * Single source of truth for "can we serve / advertise the .ics for this
 * visit?" — shared by routes/appointment-public.js (which serves the file)
 * and routes/schedule.js (which advertises the link in the portal payload).
 *
 * Lives here, not in either router, so neither has to require the other:
 * one definition, two consumers, no drift between the link and the file.
 */
const { parseETDateTime } = require('../utils/datetime-et');
const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');

// Statuses whose date/window still describe a real, future visit.
const UPCOMING_STATUSES = new Set(['pending', 'confirmed']);

// scheduled_date is a pg DATE: knex hands back a UTC-midnight Date, so slice
// the ISO day rather than converting through a timezone (which would render
// the preceding Eastern day).
function apptDateStr(scheduledDate) {
  if (!scheduledDate) return null;
  return scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
}

function hhmm(windowStart) {
  if (!windowStart) return null;
  return String(windowStart).slice(0, 5);
}

/** Instant the customer-quoted arrival window closes, or null. */
function arrivalWindowEndsAt(svc) {
  const date = apptDateStr(svc?.scheduled_date);
  const start = hhmm(svc?.window_start);
  if (!date || !start) return null;
  const startAt = parseETDateTime(`${date}T${start}`);
  if (!startAt || Number.isNaN(startAt.getTime())) return null;
  return new Date(startAt.getTime() + ARRIVAL_WINDOW_MINUTES * 60000);
}

/**
 * True when the visit is still upcoming by its own quoted window — the same
 * verdict the appointment page's 'upcoming' state expresses.
 */
function calendarIcsAvailable(svc, now = new Date()) {
  if (!svc) return false;
  if (!UPCOMING_STATUSES.has(String(svc.status || '').toLowerCase())) return false;
  const endsAt = arrivalWindowEndsAt(svc);
  if (!endsAt) return false;
  return endsAt >= now;
}

module.exports = { calendarIcsAvailable, arrivalWindowEndsAt, apptDateStr, hhmm, UPCOMING_STATUSES };
