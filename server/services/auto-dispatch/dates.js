/**
 * Date helpers for auto-dispatch.
 *
 * pg parses a `date` column to a JS Date (UTC midnight on Railway's TZ=UTC), not
 * a string — so `String(row.scheduled_date)` yields "Tue Aug 04 2026 ..." and
 * breaks YYYY-MM-DD parsing. toDateStr normalizes either shape, mirroring the
 * existing toDateStr in find-time.js.
 */
function toDateStr(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.split('T')[0];
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  return String(d).split('T')[0];
}

// Shift a 'YYYY-MM-DD' by whole calendar days (anchored at UTC noon so DST/midnight
// seams can't roll the date). Returns a 'YYYY-MM-DD' string.
function shiftDateStr(dateStr, days) {
  if (!dateStr) return dateStr;
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

module.exports = { toDateStr, shiftDateStr };
