// Eastern Time date helpers.
//
// Railway runs with TZ=UTC. A naive ISO string like "2026-04-17T12:30" passed to
// new Date() is interpreted as server-local (UTC), then formatTime converts it
// back to ET — shifting the displayed time by 4–5 hours. parseETDateTime treats
// naive strings as ET wall-clock and returns the correct absolute Date.

const TZ = 'America/New_York';

function parseETDateTime(input) {
  if (input instanceof Date) return input;
  if (typeof input !== 'string') return new Date(input);
  const naive = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (!naive) return new Date(input);
  const [, y, mo, d, h, mi, s] = naive;
  const utcGuess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(utcGuess));
  const p = (t) => parseInt(parts.find(x => x.type === t).value, 10);
  let etH = p('hour'); if (etH === 24) etH = 0;
  const etAsUtc = Date.UTC(p('year'), p('month') - 1, p('day'), etH, p('minute'), p('second'));
  const offsetMs = utcGuess - etAsUtc;
  return new Date(utcGuess + offsetMs);
}

function formatETDay(dt) {
  return dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: TZ });
}

function formatETDate(dt) {
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: TZ });
}

function formatETTime(dt) {
  return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ });
}

// Returns the ET wall-clock parts for a given absolute Date.
// Server runs UTC, so getHours/getDay/etc read UTC — use this instead.
function etParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find(x => x.type === t)?.value;
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

// ET calendar date as 'YYYY-MM-DD' — safe replacement for .toISOString().split('T')[0].
function etDateString(date = new Date()) {
  const { year, month, day } = etParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Returns a Date N ET-calendar-days away from `date`. Handles month/year rollover
// via Date.UTC overflow. Anchors at noon UTC to stay clear of DST seams.
function addETDays(date, days) {
  const et = etParts(date);
  return new Date(Date.UTC(et.year, et.month - 1, et.day + days, 12, 0, 0));
}

// Midnight ET on the first day of `date`'s ET month — use for month-to-date WHERE bounds.
function startOfETMonth(date = new Date()) {
  const { year, month } = etParts(date);
  return parseETDateTime(`${year}-${String(month).padStart(2, '0')}-01T00:00`);
}

// ET-calendar period helpers — every helper below returns a YYYY-MM-DD string
// (the same shape as toISOString().split('T')[0]). These replace the
// `new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0]`
// idiom, which reads UTC from the Date and is off-by-one after 8 PM ET.
//
// Month offset: 0 = this month, -1 = last month, +1 = next month.
function etMonthStart(date = new Date(), offset = 0) {
  const { year, month } = etParts(date);
  // month is 1-12; JS Date.UTC handles overflow cleanly.
  const d = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Last day of the ET calendar month (offset = 0 this month, -1 last, etc.).
function etMonthEnd(date = new Date(), offset = 0) {
  const { year, month } = etParts(date);
  // Day 0 of next month = last day of target month.
  const d = new Date(Date.UTC(year, month + offset, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// First day of the ET calendar quarter containing `date`.
function etQuarterStart(date = new Date()) {
  const { year, month } = etParts(date);
  const qMonth = Math.floor((month - 1) / 3) * 3 + 1; // 1, 4, 7, 10
  return `${year}-${String(qMonth).padStart(2, '0')}-01`;
}

// First day of the ET calendar year containing `date`.
function etYearStart(date = new Date()) {
  return `${etParts(date).year}-01-01`;
}

// Monday (ISO week start) of the ET week containing `date`, as YYYY-MM-DD.
function etWeekStart(date = new Date()) {
  const { dayOfWeek } = etParts(date);
  // Sun=0, Mon=1, ... Sat=6. Monday is the anchor; Sunday wraps back 6.
  const offsetToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return etDateString(addETDays(date, offsetToMonday));
}

module.exports = {
  TZ, parseETDateTime, formatETDay, formatETDate, formatETTime,
  etParts, etDateString, addETDays, startOfETMonth,
  etMonthStart, etMonthEnd, etQuarterStart, etYearStart, etWeekStart,
};
