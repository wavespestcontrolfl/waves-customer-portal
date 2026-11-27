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
const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b|\b(tues?|weds?|thu|thur|thurs|fri)\b\.?/gi;
const WEEKDAY_ABBREV = { tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', weds: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
const ORDINAL_RE = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;
// "Thursday, December 3" (availability.js fullDate and the scheduler's day label).
const LABEL_RE = /^([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})$/;

function parseLabel(label) {
  const m = LABEL_RE.exec(String(label || '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  return month < 0 ? null : { weekday: m[1].toLowerCase(), month: month + 1, day: Number(m[3]) };
}

function namedDaysIn(text) {
  const body = String(text || '');
  const weekdays = new Set();
  const dates = [];
  const daysOfMonth = new Set();
  for (const m of body.matchAll(WEEKDAY_RE)) weekdays.add(m[1] ? m[1].toLowerCase() : WEEKDAY_ABBREV[m[2].toLowerCase()]);
  for (const m of body.matchAll(MONTH_DAY_RE)) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3))) + 1;
    dates.push({ month, day: Number(m[2]) });
  }
  for (const m of body.matchAll(NUMERIC_DATE_RE)) dates.push({ month: Number(m[1]), day: Number(m[2]) });
  for (const m of body.matchAll(ORDINAL_RE)) daysOfMonth.add(Number(m[1]));
  return { weekdays, dates: dates.filter((d) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31), daysOfMonth };
}

function namedDayMatcher(text) {
  const named = namedDaysIn(text);
  if (!named.weekdays.size && !named.dates.length && !named.daysOfMonth.size) return null;
  // The names a picker day answers ([] = none): one key per name, so "Thursday or Friday" wants one day of each.
  return (label) => {
    const day = parseLabel(label);
    if (!day) return [];
    return [
      ...(named.weekdays.has(day.weekday) ? [`weekday:${day.weekday}`] : []),
      ...named.dates.filter((d) => d.month === day.month && d.day === day.day).map((d) => `date:${d.month}/${d.day}`),
      ...(named.daysOfMonth.has(day.day) ? [`day:${day.day}`] : []),
    ];
  };
}

module.exports = {
  namedDayMatcher,
  _internals: { parseLabel, namedDaysIn },
};
