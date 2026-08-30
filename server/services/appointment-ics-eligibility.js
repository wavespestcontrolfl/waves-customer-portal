/**
 * Single source of truth for "can we serve / advertise the .ics for this
 * visit?" — shared by routes/appointment-public.js (which serves the file)
 * and routes/schedule.js (which advertises the link in the portal payload).
 *
 * Lives here, not in either router, so neither has to require the other:
 * one definition, two consumers, no drift between the link and the file.
 */
const { parseETDateTime, etCalendarDayOf } = require('../utils/datetime-et');
const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');

// Statuses whose date/window still describe a real, future visit.
const UPCOMING_STATUSES = new Set(['pending', 'confirmed']);

// Date normalization is NOT re-implemented here: utils/datetime-et's
// etCalendarDayOf is the canonical helper for telling a pg DATE (string or
// UTC-midnight Date, read literally) from a real timestamp (converted through
// the ET wall clock). A local slice would mis-handle a non-midnight timestamp
// (codex #3249 r4 P1).
function apptDateStr(scheduledDate) {
  if (!scheduledDate) return null;
  return etCalendarDayOf(scheduledDate);
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

/**
 * The instant a GROUPED stop's quoted window closes: the later of the
 * earliest member's arrival promise and the latest chained member's end
 * (two overlapping 09-10 services promise arrival through 11:00 and must
 * not go past at 10:00). Null when no member has a window. Shared math for
 * the grouped verdict below and the appointment page's grouped state.
 */
function groupedStopEndsAt(members) {
  const rows = Array.isArray(members) ? members : [];
  const date = apptDateStr(rows[0]?.scheduled_date);
  if (!date) return null;
  const starts = rows.map((m) => hhmm(m.window_start)).filter(Boolean).sort();
  const ends = rows.map((m) => hhmm(m.window_end)).filter(Boolean).sort();
  const bounds = [];
  if (starts.length) {
    const promise = arrivalWindowEndsAt({ scheduled_date: date, window_start: starts[0] });
    if (promise) bounds.push(promise.getTime());
  }
  if (ends.length) {
    const latest = parseETDateTime(`${date}T${ends[ends.length - 1]}`);
    if (latest && !Number.isNaN(latest.getTime())) bounds.push(latest.getTime());
  }
  return bounds.length ? new Date(Math.max(...bounds)) : null;
}

/**
 * Grouped-stop ICS verdict — the ONE definition of "can we serve/advertise
 * the calendar file for this stop", shared by routes/appointment-public.js
 * (which serves it) and routes/schedule.js (which advertises the link), so
 * the portal never shows a link the public route rejects (codex #3609
 * uncapped audit P1). Servable only while the members still form ONE quiet
 * stop: one date, one technician, connected windows, nobody underway or
 * awaiting rebook, a real start to file as DTSTART, and the stop's own
 * window not yet elapsed. `members` = the visit's live members.
 */
function groupedIcsVerdict(members, now = new Date()) {
  const blocked = { blocked: true, endsAt: null };
  const rows = Array.isArray(members) ? members : [];
  if (rows.length < 2) return blocked;
  const status = (m) => String(m.status || '').toLowerCase();
  if (rows.some((m) => ['rescheduled', 'en_route', 'on_site'].includes(status(m)))) return blocked;
  if (new Set(rows.map((m) => apptDateStr(m.scheduled_date) || '')).size > 1) return blocked;
  if (new Set(rows.map((m) => String(m.technician_id || ''))).size > 1) return blocked;
  // Lazy require: visit-groups requires route-adjacent modules of its own.
  if (!require('./visit-groups').windowedMembersConnected(rows)) return blocked;
  if (!rows.some((m) => hhmm(m.window_start))) return blocked; // no DTSTART to file
  const endsAt = groupedStopEndsAt(rows);
  if (!endsAt || endsAt < now) return blocked;
  return { blocked: false, endsAt };
}

module.exports = { calendarIcsAvailable, arrivalWindowEndsAt, apptDateStr, hhmm, UPCOMING_STATUSES, groupedStopEndsAt, groupedIcsVerdict };
