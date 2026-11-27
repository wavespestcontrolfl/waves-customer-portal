/**
 * Which named day of the picker the customer asked about, for the texting AI's shadow drafter (texting AI gap 1, owner
 * 2026-11-26 "BUILD 1-6"). Pure and deterministic: no database read, no model call.
 *
 *   namedDayMatcher(text)
 *     -> null | (dayLabel) => string[]
 *   The days the customer named ("Thursday", "Dec 3", "12/3", "the 19th"), matched against a picker day label
 *   ("Thursday, December 3"): the names that day answers. The drafter adds the first day the picker offers for
 *   each name, even past its first three days; the picker's own horizon still bounds it.
 */
const { dateOnlyString } = require('../utils/date-only');

const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b|\b(tues?|weds?|thu|thur|thurs|fri)\b\.?/gi;
const WEEKDAY_ABBREV = { tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', weds: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/gi;
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;
const ORDINAL_RE = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;
// "Thursday, December 3" (availability.js fullDate and the scheduler's day label).
const LABEL_RE = /^([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})$/;
// A weekday right before its date ("Thursday Dec 10", "Thu, 12/10", "Friday the 11th") is one day, not two.
const PAIR_GAP_RE = /^[\s,]*$/;

function parseLabel(label) {
  const m = LABEL_RE.exec(String(label || '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  return month < 0 ? null : { weekday: m[1].toLowerCase(), month: month + 1, day: Number(m[3]) };
}

const fullYear = (raw) => (raw ? (raw.length === 2 ? 2000 + Number(raw) : Number(raw)) : null);

// Every day or date token in the text, in text order: { start, end, weekday } or { start, end, month?, day, year? }.
function dayTokens(body) {
  const tokens = [];
  const at = (m, fields) => tokens.push({ start: m.index, end: m.index + m[0].length, ...fields });
  for (const m of body.matchAll(WEEKDAY_RE)) at(m, { weekday: m[1] ? m[1].toLowerCase() : WEEKDAY_ABBREV[m[2].toLowerCase()] });
  for (const m of body.matchAll(MONTH_DAY_RE)) {
    at(m, { month: MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3))) + 1, day: Number(m[2]), year: fullYear(m[3]) });
  }
  for (const m of body.matchAll(NUMERIC_DATE_RE)) at(m, { month: Number(m[1]), day: Number(m[2]), year: fullYear(m[3]) });
  for (const m of body.matchAll(ORDINAL_RE)) at(m, { day: Number(m[1]) });
  return tokens
    .filter((t) => t.weekday || ((t.month === undefined || (t.month >= 1 && t.month <= 12)) && t.day >= 1 && t.day <= 31))
    .sort((a, b) => a.start - b.start);
}

function requestKey(r) {
  const date = r.month ? `date:${r.month}/${r.day}${r.year ? `/${r.year}` : ''}` : (r.day ? `day:${r.day}` : '');
  return [r.weekday ? `weekday:${r.weekday}` : '', date].filter(Boolean).join('+');
}

// The days the customer asked for, each one request: a weekday, a date (month and day, maybe a year), a day of the month,
// or a weekday paired with the date right after it.
function namedDaysIn(text) {
  const body = String(text || '');
  const tokens = dayTokens(body);
  const requests = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const paired = t.weekday && next && !next.weekday && PAIR_GAP_RE.test(body.slice(t.end, next.start));
    const r = paired ? { ...next, weekday: t.weekday } : t;
    if (paired) i += 1;
    requests.set(requestKey(r), r);
  }
  return [...requests.entries()].map(([key, r]) => ({ key, weekday: r.weekday || null, month: r.month || null, day: r.day || null, year: r.year || null }));
}

// A picker day answers a request when every part the customer gave matches. A year is checked against the day's ISO date; a
// day with no readable ISO date never answers a request with a year.
function answers(r, day, isoYear) {
  return (!r.weekday || r.weekday === day.weekday)
    && (!r.month || r.month === day.month)
    && (!r.day || r.day === day.day)
    && (!r.year || r.year === isoYear);
}

function namedDayMatcher(text) {
  const requests = namedDaysIn(text);
  if (!requests.length) return null;
  // The requests a picker day answers ([] = none): one key per request, so "Thursday or Friday" wants one day of each.
  return (label, isoDate = null) => {
    const day = parseLabel(label);
    if (!day) return [];
    const ymd = dateOnlyString(isoDate);
    const isoYear = ymd ? Number(ymd.slice(0, 4)) : null;
    return requests.filter((r) => answers(r, day, isoYear)).map((r) => r.key);
  };
}

module.exports = {
  namedDayMatcher,
  _internals: { parseLabel, namedDaysIn },
};
