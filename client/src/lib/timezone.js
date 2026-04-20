// Eastern Time helpers for the Waves portal.
//
// The business operates exclusively in SW Florida (Manatee / Sarasota /
// Charlotte counties). All scheduling, dispatch, and reporting is done
// against the ET wall clock — never UTC, never browser-local. The DB
// stores UTC; only this layer converts.
//
// This is the client-side companion to server/utils/datetime-et.js —
// same semantics, same helper names where they overlap. One constant,
// imported everywhere. Do not sprinkle 'America/New_York' string
// literals through the codebase; import TIMEZONE from here.
//
// DST is handled automatically by Intl — do not hardcode offsets.

export const TIMEZONE = 'America/New_York';

// ── Parts ───────────────────────────────────────────────────────────
//
// Returns the ET wall-clock parts for a given absolute Date. Use this
// instead of d.getHours() / d.getDay() / d.getDate() when the semantics
// are "the ET calendar/hour/day-of-week this moment falls into".

export function etParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // Intl quirk: midnight reports as 24
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    dayOfWeek: dowMap[get('weekday')],
  };
}

// ── 'YYYY-MM-DD' date strings ──────────────────────────────────────

// The ET calendar date as 'YYYY-MM-DD' — drop-in replacement for
// d.toISOString().split('T')[0]. Never call toISOString() for a
// date-as-string; it returns UTC, and after 8 PM ET the UTC date
// has already rolled forward to tomorrow.
export function etDateString(date = new Date()) {
  const { year, month, day } = etParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// True when `dateStr` ('YYYY-MM-DD') is today in ET.
export function isETToday(dateStr) {
  return dateStr === etDateString();
}

// ── Minutes-since-midnight for now-lines ───────────────────────────
//
// Returns the current ET wall-clock time as minutes since ET-midnight.
// Use this in schedule grids for the red now-line rather than
// new Date().getHours() * 60 + new Date().getMinutes(), which reads
// the browser's local timezone.

export function etNowMinutes() {
  const { hour, minute } = etParts();
  return hour * 60 + minute;
}

// ── Formatters ─────────────────────────────────────────────────────
//
// Thin wrappers around toLocale*String pinned to ET so no caller has
// to remember to pass { timeZone } every time.

export function formatETDate(date, options = {}) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { timeZone: TIMEZONE, ...options });
}

export function formatETTime(date, options = {}) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric', minute: '2-digit', hour12: true,
    ...options,
  });
}

// Full human timestamp, ET-anchored. Useful for log lines / audit
// displays where you want "Apr 20, 2026, 2:15 PM".
export function formatETDateTime(date, options = {}) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString('en-US', { timeZone: TIMEZONE, ...options });
}

// ── Day arithmetic anchored to ET ──────────────────────────────────
//
// Returns a Date N ET-calendar-days away from `date`. Anchors at
// noon UTC to stay clear of DST seams.

export function addETDays(date, days) {
  const et = etParts(date);
  return new Date(Date.UTC(et.year, et.month - 1, et.day + days, 12, 0, 0));
}
