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

// ── <datetime-local> inputs, ET-anchored ───────────────────────────
//
// A `type="datetime-local"` input holds a naive 'YYYY-MM-DDTHH:mm'
// wall-clock string with no zone. These two helpers pin that wall clock
// to ET so an editor anywhere sees and enters ET, and the stored instant
// round-trips exactly. Never populate such an input from toISOString()
// (that shows UTC wall-clock, hours off the ET the rest of the UI shows).

// Instant → 'YYYY-MM-DDTHH:mm' ET wall-clock, for an input's `value`.
export function etDatetimeLocalValue(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const { year, month, day, hour, minute } = etParts(d);
  const p = (v) => String(v).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}`;
}

// 'YYYY-MM-DDTHH:mm' ET wall-clock → ISO instant string. Interprets the
// value as ET: guess the instant as if the wall clock were UTC, then correct
// by the actual ET offset (Intl handles DST). Correct twice — a single pass
// samples the offset at the as-if-UTC guess, which for early-morning times on
// a DST-change day sits on the wrong side of the transition (e.g. 2026-03-08
// 03:30 would resolve an hour off); the second pass samples at the corrected
// instant and lands on the right offset. The one irreducible case is the
// fall-back repeated hour, where a wall clock maps to two instants and this
// deterministically picks one.
function etOffsetAt(instant) {
  const p = etParts(new Date(instant));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant;
}
export function etDatetimeLocalToISO(value) {
  if (!value) return null;
  const [datePart, timePart] = String(value).split('T');
  if (!datePart || !timePart) return null;
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  if ([y, mo, d, h, mi].some(Number.isNaN)) return null;
  const targetWall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = targetWall - etOffsetAt(targetWall);
  utc = targetWall - etOffsetAt(utc);
  return new Date(utc).toISOString();
}

// ── Day arithmetic anchored to ET ──────────────────────────────────
//
// Returns a Date N ET-calendar-days away from `date`. Anchors at
// noon UTC to stay clear of DST seams.

export function addETDays(date, days) {
  const et = etParts(date);
  return new Date(Date.UTC(et.year, et.month - 1, et.day + days, 12, 0, 0));
}

// ── Week start (Monday, ET) ────────────────────────────────────────
//
// Returns the 'YYYY-MM-DD' of the ET-Monday containing `dateStr`.
// Sunday falls back into the *prior* Monday, matching Mon→Sun week
// layout used by the dispatch grid.

export function etStartOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Noon UTC = morning ET regardless of DST, so this anchor lands on
  // the same ET calendar day as `dateStr` and we can read its ET dow.
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const { dayOfWeek } = etParts(anchor);
  const offset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return etDateString(addETDays(anchor, -offset));
}
