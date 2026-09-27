/**
 * Day references in a labelled call transcript ("Agent: ..." / "Caller: ..."
 * lines), used by the call reschedule applier to check that the words the
 * extraction recorded for the agreed day and the moved appointment name the
 * dates it claims (call-reschedule-agreement.js). Hours are not read here:
 * the extraction records the agreed hour's words itself (schema 1.17.0).
 *
 * A day mention carries every calendar date it could mean: today, tonight,
 * tomorrow and the day after name one; a month and day ("October 8", "the
 * 8th of October") names this year's and next year's; a weekday or "next
 * <weekday>" names this week's and next week's, and "the 8th" alone this
 * month's or next month's, since ordinary speech uses both. Mentions come
 * back in the order they were spoken. Dates are ET calendar days
 * (server/utils/datetime-et.js), relative to when the call started.
 */
'use strict';

const { etParts, etDateString, addETDays } = require('../utils/datetime-et');

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const RELATIVE_DAYS = { today: 0, tonight: 0, tomorrow: 1 };
// A month token: its full name or its first three letters, plus "sept" —
// the set reschedule-date-evidence.js reads ("Dec. 24" normalizes to "dec 24").
function monthIndexOf(tok) {
  if (tok === 'sept') return 8;
  return MONTH_NAMES.findIndex((name) => name === tok || name.slice(0, 3) === tok);
}
const DAY_OF_MONTH = /^(\d{1,2})(?:st|nd|rd|th)?$/;
// A day of the month said without its month needs the ordinal ("the 8th"):
// a bare "the 8" is too often something else.
const ORDINAL_DAY = /^(\d{1,2})(?:st|nd|rd|th)$/;

// "a.m." / "p.m." as single tokens, so punctuation stripping cannot break
// "9 a.m." apart and a quote matches its turn however either was punctuated;
// "2pm" written together keeps its hour as a token of its own.
function joinMeridiem(s) {
  return String(s || '')
    .replace(/\b([ap])\.\s?m\b\.?/gi, '$1m')
    .replace(/(\d)([ap]m)\b/gi, '$1 $2');
}
// A date written as numbers ("12/24", "12/24/27") reads as its month and day
// ("december 24", "december 24 2027"), so it is a mention like any other; a
// stated year is kept, so the mention names that year only. A fraction of a
// unit ("1/2 hour") is a length, not a date.
function spellNumericDates(s) {
  return s.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b(?!\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|miles?|inch(?:es)?|cups?|gallons?|ounces?|oz|pounds?|lbs?|acres?)\b)/gi,
    (whole, mo, d, yr) => {
      const month = Number(mo);
      const day = Number(d);
      if (month < 1 || month > 12 || day < 1 || day > 31) return whole;
      const year = yr && yr.length === 2 ? `20${yr}` : yr;
      return `${MONTH_NAMES[month - 1]} ${day}${year ? ` ${year}` : ''}`;
    });
}
function normalize(s) {
  return spellNumericDates(joinMeridiem(s)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// null on any unlabeled line: turn boundaries cannot be trusted, fail closed.
function parseTurns(transcript) {
  const turns = [];
  for (const line of String(transcript || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(agent|caller)\s*:\s*(.*)$/i);
    if (!m) return null;
    turns.push({ agent: m[1].toLowerCase() === 'agent', raw: m[2], ns: normalize(m[2]), interrogative: /\?/.test(m[2]) });
  }
  return turns;
}

// The ET calendar date `days` after the call's own ET date.
function dayAfterCall(started, days) {
  return etDateString(addETDays(started, days));
}

// A month and day without a year may mean this year's date or next year's
// ("March 24th" said in September means next March): both are kept, and a
// caller matches either.
function monthDayDates(monthIdx, dayNum, started) {
  const { year } = etParts(started);
  const md = `${String(monthIdx + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
  return [`${year}-${md}`, `${year + 1}-${md}`];
}

// "The 8th" with no month: the first date with that day of the month on or
// after the call's own day, and the one after it.
function dayOfMonthDates(dayNum, started) {
  const { year, month, day } = etParts(started);
  const dates = [];
  for (let k = 0; dates.length < 2 && k < 4; k += 1) {
    const y = year + Math.floor((month - 1 + k) / 12);
    const m = ((month - 1 + k) % 12) + 1;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (dayNum < 1 || dayNum > daysInMonth || (k === 0 && dayNum < day)) continue;
    dates.push(`${y}-${String(m).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`);
  }
  return dates;
}

// The ways a day is said, tried in order at each token: each returns
// { dates, kind, len[, weekday] } for a match there, else a falsy value.
// `toks` are the turn's tokens, `i` the position, `started` the call's start.
const DAY_FORMS = [
  (toks, i, started) => toks[i] === 'day' && toks[i + 1] === 'after' && toks[i + 2] === 'tomorrow'
    && { dates: [dayAfterCall(started, 2)], kind: 'day_after_tomorrow', len: 3 },
  (toks, i, started) => Object.hasOwn(RELATIVE_DAYS, toks[i])
    && { dates: [dayAfterCall(started, RELATIVE_DAYS[toks[i]])], kind: toks[i], len: 1 },
  (toks, i, started) => toks[i] === 'next' && WEEKDAY_NAMES.includes(toks[i + 1])
    && { dates: weekdayDates(toks[i + 1], started, true), kind: 'next_weekday', len: 2, weekday: WEEKDAY_NAMES.indexOf(toks[i + 1]) },
  // "This Thursday", "this coming Thursday", "coming Thursday": the nearest one only.
  (toks, i, started) => {
    const len = (toks[i] === 'this' ? 1 : 0) + (toks[i + (toks[i] === 'this' ? 1 : 0)] === 'coming' ? 1 : 0);
    const name = toks[i + len];
    return len > 0 && WEEKDAY_NAMES.includes(name)
      && { dates: weekdayDates(name, started).slice(0, 1), kind: 'weekday', len: len + 1, weekday: WEEKDAY_NAMES.indexOf(name) };
  },
  (toks, i, started) => WEEKDAY_NAMES.includes(toks[i])
    && { dates: weekdayDates(toks[i], started), kind: 'weekday', len: 1, weekday: WEEKDAY_NAMES.indexOf(toks[i]) },
  // "October 8", "October 8th"
  (toks, i, started) => monthIndexOf(toks[i]) >= 0 && DAY_OF_MONTH.test(toks[i + 1] || '')
    && { dates: monthDayDates(monthIndexOf(toks[i]), Number(DAY_OF_MONTH.exec(toks[i + 1])[1]), started), kind: 'month_day', len: 2 },
  // "October the 8th"
  (toks, i, started) => monthIndexOf(toks[i]) >= 0 && toks[i + 1] === 'the' && ORDINAL_DAY.test(toks[i + 2] || '')
    && { dates: monthDayDates(monthIndexOf(toks[i]), Number(ORDINAL_DAY.exec(toks[i + 2])[1]), started), kind: 'month_day', len: 3 },
  // "the 8th of October"
  (toks, i, started) => toks[i] === 'the' && ORDINAL_DAY.test(toks[i + 1] || '') && toks[i + 2] === 'of' && monthIndexOf(toks[i + 3] || '') >= 0
    && { dates: monthDayDates(monthIndexOf(toks[i + 3]), Number(ORDINAL_DAY.exec(toks[i + 1])[1]), started), kind: 'month_day', len: 4 },
  // "8th of October"
  (toks, i, started) => ORDINAL_DAY.test(toks[i]) && toks[i + 1] === 'of' && monthIndexOf(toks[i + 2] || '') >= 0
    && { dates: monthDayDates(monthIndexOf(toks[i + 2]), Number(ORDINAL_DAY.exec(toks[i])[1]), started), kind: 'month_day', len: 3 },
  // "the 8th"
  (toks, i, started) => toks[i] === 'the' && ORDINAL_DAY.test(toks[i + 1] || '')
    && { dates: dayOfMonthDates(Number(ORDINAL_DAY.exec(toks[i + 1])[1]), started), kind: 'day_of_month', len: 2 },
];

// A weekday said on the call: this week's and next week's.
function weekdayDates(name, started, next = false) {
  // The call's own weekday can be today ("Thursday at two" on a Thursday);
  // "next Thursday" never is.
  const off = ((WEEKDAY_NAMES.indexOf(name) - etParts(started).dayOfWeek + 7) % 7) || (next ? 7 : 0);
  return [dayAfterCall(started, off), dayAfterCall(started, off + 7)];
}

// "This week" / "next week" said right before or after a weekday ("Thursday
// next week", "next week Thursday", "Thursday of this week") picks the
// weekday's date in that calendar week (Sunday to Saturday), dropping the
// other: { dates, before, after } with the tokens it took on each side, or
// null when there is no such phrase.
function weekOfWeekday(toks, pos, end, dates, started) {
  const after = ['of', 'this', 'next'].includes(toks[end]) ? toks.slice(end, end + 3) : [];
  const phrase = toks.slice(end, end + 2).join(' ');
  const said = [phrase, after.join(' ').replace(/^of /, ''), toks.slice(pos - 2, pos).join(' ')].find((p) => p === 'this week' || p === 'next week');
  if (!said) return null;
  const weekStart = addETDays(started, -etParts(started).dayOfWeek + (said === 'next week' ? 7 : 0));
  const from = etDateString(weekStart);
  const to = etDateString(addETDays(weekStart, 6));
  const tookAfter = phrase === said ? 2 : (after.length === 3 && after.join(' ') === `of ${said}` ? 3 : 0);
  return { dates: dates.filter((d) => d >= from && d <= to), before: tookAfter ? 0 : 2, after: tookAfter };
}

/**
 * Day mentions in one turn, in spoken order: { candidates: Set<YYYY-MM-DD>,
 * kind, pos, end, weekday? } with pos/end the turn-level token span and
 * weekday (0 = Sunday) on a weekday mention. `started` is the call's start
 * (a Date).
 */
function parseDayMentions(turnText, started) {
  const toks = normalize(turnText).split(' ').filter(Boolean);
  const mentions = [];
  for (let i = 0; i < toks.length; i += 1) {
    const hit = DAY_FORMS.map((form) => form(toks, i, started)).find(Boolean);
    if (!hit) continue;
    // A stated year after a month and day ("December 24th, 2027") names that
    // year's date only.
    // "December 24th, 2027", "December 24th of 2027", "in 2027".
    const yearAt = i + hit.len + (['of', 'in'].includes(toks[i + hit.len]) ? 1 : 0);
    const year = hit.kind === 'month_day' && /^20\d{2}$/.test(toks[yearAt] || '') ? toks[yearAt] : null;
    const week = hit.weekday != null ? weekOfWeekday(toks, i, i + hit.len, hit.dates, started) : null;
    const dates = year ? [`${year}${hit.dates[0].slice(4)}`] : (week ? week.dates : hit.dates);
    const end = (year ? yearAt + 1 : i + hit.len) + (week ? week.after : 0);
    mentions.push({ candidates: new Set(dates), kind: hit.kind, pos: week ? i - week.before : i, end, ...(hit.weekday != null ? { weekday: hit.weekday } : {}) });
    i = end - 1;
  }
  return mentions;
}

module.exports = {
  normalize, parseTurns, parseDayMentions,
};
