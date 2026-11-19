/**
 * Display helpers for the public job offer page (/careers/offer/:token).
 *
 * Date values ('YYYY-MM-DD') are formatted without a time-zone shift. Instants
 * (expiresAt, signedAt) are formatted in Eastern time.
 */
import { etDateString, formatETDate, formatETDateOnly } from '../../lib/timezone';

export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
}

// A date can arrive as a bare 'YYYY-MM-DD' (no time zone) or as an instant.
// Bare dates keep their calendar day; instants are read in Eastern time.
function formatDay(value, options) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(text)) return formatETDateOnly(text, options);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  return formatETDate(d, options);
}

// 'Mon, Jan 4, 2027'
export function formatLongDate(value) {
  return formatDay(value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// 'Sat, Dec 12, 2026' from an instant, always read in Eastern time (an instant at
// 00:00 UTC is still the evening before in Eastern time).
export function formatLongInstant(value) {
  if (!value) return '';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return formatETDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// 'Apr 5' from a date value.
export function formatShortDate(value) {
  return formatETDateOnly(value, { month: 'short', day: 'numeric' });
}

// 'Fri, Dec 18' from an instant.
export function formatExpiry(value) {
  if (!value) return '';
  return formatETDate(value, { weekday: 'short', month: 'short', day: 'numeric' });
}

// 'Dec 11, 2026'
export function formatSentOn(value) {
  return formatDay(value, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function payLine(data) {
  const base = `${money(data.hourlyRate)} an hour`;
  if (data.stepRate == null || data.stepRate === '') return base;
  const from = data.stepEffectiveOn ? ` from ${formatShortDate(data.stepEffectiveOn)}` : '';
  return `${base}, ${money(data.stepRate)}${from}`;
}

export function signedNameValid(name) {
  const trimmed = String(name || '').trim();
  return trimmed.length >= 3 && trimmed.length <= 120 && trimmed.split(/\s+/).length >= 2;
}

// Monday=1 … Sunday=0 for a 'YYYY-MM-DD' value, without a time-zone shift.
function weekdayOf(dateValue) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

export function tomorrowET() {
  const [y, m, d] = etDateString().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// null when valid, else the message to show.
export function dateRequestProblem(value) {
  if (!value) return 'Pick a date.';
  const day = weekdayOf(value);
  if (day == null) return 'Pick a date.';
  if (value < tomorrowET()) return 'Pick a date in the future.';
  if (day < 1 || day > 4) return 'Start days are Monday to Thursday.';
  return null;
}
