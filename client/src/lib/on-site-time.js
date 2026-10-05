// client/src/lib/on-site-time.js
//
// The "Time on-site" clock of the Complete service page: when the technician
// checked in, and the elapsed h:mm:ss since. Moved out of pages/admin/SchedulePage.jsx
// unchanged so the full completion form and the lawn Fast Complete sheet show the
// same clock from the same rule.

/** The check-in time of a visit: its on-site status-log entry, else `checkInTime`. */
export function onSiteTimeOf(service) {
  const entry = (service?.statusLog || []).find((e) => e.status === 'on_site');
  return entry ? entry.at : service?.checkInTime;
}

/** "m:ss", or "h:mm:ss" past the hour; "0:00" with no time. */
export function elapsedSince(isoTime) {
  if (!isoTime) return '0:00';
  const diff = Math.max(
    0,
    Math.floor((Date.now() - new Date(isoTime).getTime()) / 1000),
  );
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
