/**
 * Display helpers for the public job offer page (/careers/offer/:token).
 *
 * Date values ('YYYY-MM-DD') are formatted without a time-zone shift. Instants
 * (expiresAt, signedAt) are formatted in Eastern time.
 */
import { addETDays, etDateString, etParts, formatETDate, formatETDateOnly } from '../../lib/timezone';

// Calendar dates ('YYYY-MM-DD') go through the shared Eastern helpers in
// lib/timezone.js. A day anchored at noon UTC is the same Eastern day all year.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const anchorOf = (value) => new Date(`${value}T12:00:00Z`);

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

// 0 Sunday .. 6 Saturday for a real 'YYYY-MM-DD' calendar date (Feb 30 is not one), else null.
function weekdayOf(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const at = anchorOf(value);
  if (Number.isNaN(at.getTime()) || etDateString(at) !== value) return null;
  return etParts(at).dayOfWeek;
}

// Tomorrow's calendar date in Eastern, 'YYYY-MM-DD'.
export function tomorrowET(now = new Date()) {
  return etDateString(addETDays(now, 1));
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';
const blank = (value) => value == null || value === '';
const positiveAmount = (value) =>
  (typeof value === 'number' || filled(value)) && Number.isFinite(Number(value)) && Number(value) > 0;

// True when an offer read carries every term the page shows: the job, a real
// start date, a rate above zero, the week, who they report to and pay day,
// and a pay step only with both its rate and its date (a date alone would drop
// a dated raise from the page). The page signs only such an offer, so no one
// signs a blank start date, a "$0.00 an hour" or an offer missing its raise.
export function hasOfferFacts(data) {
  const noStep = blank(data.stepRate) && blank(data.stepEffectiveOn);
  return filled(data.jobTitle) && filled(data.hoursLine) && filled(data.reportTo) && filled(data.payDayLine)
    && weekdayOf(data.startDate) !== null && positiveAmount(data.hourlyRate)
    && (noStep || (positiveAmount(data.stepRate) && weekdayOf(data.stepEffectiveOn) !== null));
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
