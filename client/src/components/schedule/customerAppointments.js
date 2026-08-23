import { etDateString } from '../../lib/timezone';

// Appointment lists for the schedule-side customer drawers, derived from the
// admin customer-detail payload:
//   data.upcomingScheduled — future, active-only (server-filtered in ET)
//   data.scheduled         — newest-first history, capped
// Dates are 'YYYY-MM-DD' (or an ISO stamp on that day); compare the day
// prefix as a string — never new Date('YYYY-MM-DD'), which parses as UTC.

const HIDDEN_UPCOMING_STATUSES = ['completed', 'cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'];

export function apptDateKey(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return m ? m[1] : '';
}

const byDateAsc = (a, b) => apptDateKey(a.scheduled_date).localeCompare(apptDateKey(b.scheduled_date))
  || String(a.window_start || '').localeCompare(String(b.window_start || ''));
const byDateDesc = (a, b) => byDateAsc(b, a);

const isUpcoming = (s, today) =>
  apptDateKey(s.scheduled_date) >= today
  && !HIDDEN_UPCOMING_STATUSES.includes(String(s.status || '').toLowerCase());

// Upcoming: prefer the server's active-only list; fall back to filtering
// `scheduled` by ET-today when an older payload lacks it.
export function upcomingAppointments(data, today = etDateString()) {
  if (Array.isArray(data?.upcomingScheduled)) return [...data.upcomingScheduled].sort(byDateAsc);
  const scheduled = Array.isArray(data?.scheduled) ? data.scheduled : [];
  return scheduled.filter((s) => isUpcoming(s, today)).sort(byDateAsc);
}

// Previous: history rows that are NOT upcoming by the same date/status
// predicate, newest first. Classified per-row (not by membership in the
// server's upcoming list) because that list is capped independently of
// `scheduled` — an active future visit past its cap must not show as past.
export function previousAppointments(data, today = etDateString()) {
  const scheduled = Array.isArray(data?.scheduled) ? data.scheduled : [];
  return scheduled.filter((s) => !isUpcoming(s, today)).sort(byDateDesc);
}

// History panel: the current visit (by id) and the nearest upcoming visit
// first, then the most recent PAST visits, newest first — capped. Never a
// plain DESC slice: a 24-visit fixed series would fill the cap with its
// farthest-future rows and hide today's visit and the recent past.
export function appointmentHistory(data, limit, { today = etDateString(), currentId = null } = {}) {
  const scheduled = Array.isArray(data?.scheduled) ? data.scheduled : [];
  const upcoming = scheduled.filter((s) => isUpcoming(s, today)).sort(byDateAsc);
  const head = [];
  const current = currentId != null ? scheduled.find((s) => s.id === currentId) : null;
  if (current) head.push(current);
  if (upcoming[0] && !head.includes(upcoming[0])) head.push(upcoming[0]);
  const past = scheduled
    .filter((s) => !isUpcoming(s, today) && !head.includes(s))
    .sort(byDateDesc);
  const rows = [...head, ...past];
  return limit ? rows.slice(0, limit) : rows;
}
