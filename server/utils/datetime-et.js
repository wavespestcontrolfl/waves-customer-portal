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

module.exports = { TZ, parseETDateTime, formatETDay, formatETDate, formatETTime };
