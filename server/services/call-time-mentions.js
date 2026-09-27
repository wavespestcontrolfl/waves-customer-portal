/**
 * Day and hour references in a labelled call transcript ("Agent: ..." /
 * "Caller: ..." lines), used by the call reschedule applier's agreement
 * evidence (call-reschedule-evidence.js).
 *
 * A day mention carries every calendar date it could mean: today, tomorrow
 * and the day after name one; a month and day ("October 8", "the 8th of
 * October") names this year's and next year's; a weekday or "next <weekday>"
 * names this week's and next week's, and "the 8th" alone this month's or
 * next month's, since ordinary speech uses both. An hour mention carries its 24-hour value
 * and whether minutes put it off the hour. Mentions come back in the order
 * they were spoken. Dates are ET calendar
 * days (server/utils/datetime-et.js), relative to when the call started.
 */
'use strict';

const { etParts, etDateString, addETDays } = require('../utils/datetime-et');

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const RELATIVE_DAYS = { today: 0, tomorrow: 1 };
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

// "a.m." / "p.m." as single tokens, so neither the sentence splitter nor
// punctuation stripping can break "9 a.m." apart; "2pm" written together
// keeps its hour as a token of its own.
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
  return s.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b(?!\s*(?:hours?|hrs?|minutes?|mins?|miles?|inch(?:es)?|cups?|gallons?|ounces?|oz|pounds?|lbs?|acres?)\b)/gi,
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
    const year = hit.kind === 'month_day' && /^20\d{2}$/.test(toks[i + hit.len] || '') ? toks[i + hit.len] : null;
    const week = hit.weekday != null ? weekOfWeekday(toks, i, i + hit.len, hit.dates, started) : null;
    const dates = year ? [`${year}${hit.dates[0].slice(4)}`] : (week ? week.dates : hit.dates);
    const end = i + hit.len + (year ? 1 : 0) + (week ? week.after : 0);
    mentions.push({ candidates: new Set(dates), kind: hit.kind, pos: week ? i - week.before : i, end, ...(hit.weekday != null ? { weekday: hit.weekday } : {}) });
    i = end - 1;
  }
  return mentions;
}

const SPELLED_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NAMED_HOURS = { noon: 12, midnight: 0 };
// A part of the day said in the sentence sets an hour's am/pm when none is
// said with it ("Thursday evening at eight" is 8 PM).
const DAY_PART_PERIODS = { morning: 'am', afternoon: 'pm', evening: 'pm', tonight: 'pm' };
// Minute words that, after an hour, put a spoken time off the hour.
const MINUTE_WORDS = new Set(['fifteen', 'twenty', 'thirty', 'forty', 'fifty']);
// Words right before a number that make it a clock time: "at two".
const HOUR_LEADS = new Set(['at', 'around', 'about']);
// Words right before an hour that make it a bound, not the hour: "before
// noon", "by two", "after 2 pm", "until two".
const RELATIVE_HOUR_LEADS = new Set(['before', 'by', 'after', 'until', 'till', 'til']);
const TRAILING_BOUNDS = [['or', 'later'], ['or', 'earlier'], ['or', 'so'], ['or', 'after'], ['or', 'before'], ['at', 'the', 'latest'], ['at', 'the', 'earliest']];
// "Two o'clock" normalizes to "two o clock" or "two oclock".
const OCLOCK = new Set(['o', 'oclock']);
// A number running into a unit of time is a length, and one running into a
// counted thing a quantity ("at two properties"), not a clock time.
const DURATION_UNITS = new Set([
  'hour', 'hours', 'hr', 'hrs', 'minute', 'minutes', 'min', 'mins', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'property', 'properties', 'house', 'houses', 'home', 'homes', 'location', 'locations', 'unit', 'units', 'building', 'buildings',
  'option', 'options', 'people', 'dogs', 'cats', 'kids', 'children', 'room', 'rooms', 'bedrooms', 'bathrooms', 'spots', 'places',
  'addresses', 'lots', 'acres', 'visits', 'services', 'treatments', 'trees', 'palms', 'times',
]);
const DURATION_FILLER = new Set(['and', 'a', 'half', 'or', 'to', 'through', 'quarter']);
// Said right after an hour, part of it: "2 pm", "2 00 pm", "two o clock".
const CLOCK_TAIL = new Set(['am', 'pm', 'o', 'clock', 'oclock', '00']);
// Words that can only be about when: an hour from two to twelve ("one" also
// counts things — "one more question"), noon, am/pm, a part of the day, a
// weekday, a month ("may" is also a verb), today, tomorrow.
const TIME_WORDS = new Set([
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'noon', 'midnight', 'morning', 'afternoon', 'evening', 'today', 'tomorrow', ...WEEKDAY_NAMES,
  ...MONTH_NAMES.filter((m) => m !== 'may'),
]);
// Between two hours offered as alternatives ("at two or at four", "2 pm or 3").
const HOUR_FILLER = new Set(['at', 'around', 'about', 'am', 'pm', 'o', 'clock', 'oclock', '00']);
const HOUR_ALTERNATIVES = new Set(['or', 'and']);

// Sentences WITHIN one turn (on . ! ?): an hour's minutes, am/pm or range
// never run across a sentence end.
function splitTurnSentences(turnText) {
  return joinMeridiem(turnText).split(/[.!?]+/).map((x) => x.trim()).filter(Boolean);
}

// The same sentences with each one's turn-level token span [start, end), its
// normalized text, and whether it ends in a question mark.
function sentenceSpans(turnText) {
  const spans = [];
  let offset = 0;
  for (const [, text, stop] of joinMeridiem(turnText).matchAll(/([^.!?]*)([.!?]*)/g)) {
    if (!text.trim()) continue;
    const ns = normalize(text);
    const size = ns ? ns.split(' ').length : 0;
    spans.push({ start: offset, end: offset + size, ns, question: stop.includes('?') });
    offset += size;
  }
  return spans;
}

// A number 1-12, as digits or a word, else null.
function hourNumber(t) {
  const n = /^\d{1,2}$/.test(t || '') ? Number(t) : (Object.hasOwn(SPELLED_NUMBERS, t) ? SPELLED_NUMBERS[t] : null);
  return n >= 1 && n <= 12 ? n : null;
}

// A token that, right after an hour, is its minutes: a number 1-59 ("2 10",
// "2:30" read as "2 30"), a spelled number or a minute word ("two ten",
// "two thirty").
function isMinuteToken(t) {
  return (/^\d{1,2}$/.test(t || '') && Number(t) >= 1 && Number(t) <= 59) || MINUTE_WORDS.has(t) || Object.hasOwn(SPELLED_NUMBERS, t);
}

// How many tokens after the hour at `i` are its minutes: "two ten", "2 30",
// "two oh five", "two thirty five".
function minuteTokensAfter(toks, i) {
  if ((toks[i + 1] === 'oh' || toks[i + 1] === 'o') && isMinuteToken(toks[i + 2])) return 2;
  if (!isMinuteToken(toks[i + 1])) return 0;
  return MINUTE_WORDS.has(toks[i + 1]) && Object.hasOwn(SPELLED_NUMBERS, toks[i + 2]) ? 2 : 1;
}

// "Two to four", "2 pm to 4 pm", "between two and four": a range whose start
// is the hour at `i`, its minutes ending at `after`. The index of its end, or
// -1.
function rangeEndAfter(toks, i, after) {
  let j = after;
  while (HOUR_FILLER.has(toks[j])) j += 1;
  const joined = toks[j] === 'to' || toks[j] === 'through' || (toks[j] === 'and' && toks[i - 1] === 'between');
  return joined && hourNumber(toks[j + 1]) != null ? j + 1 : -1;
}

// "Two hours", "two and a half hours", "two or three hours", "two to three
// hours": the numbers from `j` on run into a unit of time.
function runsIntoDuration(toks, j) {
  let k = j;
  while (DURATION_FILLER.has(toks[k]) || hourNumber(toks[k]) != null) k += 1;
  return DURATION_UNITS.has(toks[k]);
}

// The am/pm said after an hour and its minutes, past any "00" or "o'clock"
// ("2 pm", "2 00 pm", "two o clock pm"), or null.
function periodAfter(toks, j) {
  let k = j;
  while (toks[k] === '00' || toks[k] === 'clock' || OCLOCK.has(toks[k])) k += 1;
  return toks[k] === 'am' || toks[k] === 'pm' ? toks[k] : null;
}

// Is the hour at `i`, its mention ending at `end`, inexact: minutes before
// it ("half past two", "twenty past two", "ten minutes past two", "ten to
// two"), or a bound before it ("before noon", "by two", "until two") or after
// it ("two or later", "noon at the latest")? Such a mention never grounds an
// on-the-hour slot. A range's end ("one to two") never reaches here.
function inexactAt(toks, i, end) {
  return (['past', 'after', 'to', 'til', 'till'].includes(toks[i - 1])
    && (['half', 'quarter', 'minute', 'minutes'].includes(toks[i - 2]) || isMinuteToken(toks[i - 2])))
    || RELATIVE_HOUR_LEADS.has(toks[i - 1])
    || TRAILING_BOUNDS.some((bound) => toks.slice(end, end + bound.length).join(' ') === bound.join(' '));
}

function clockHour(n, period) {
  return (n % 12) + (period === 'pm' ? 12 : 0);
}

// An hour with no am/pm of its own. A range's start takes its time from the
// end's stated am/pm and the range's length ("eight to ten pm" is 8 PM, "11
// to 1 pm" is 11 AM); otherwise it reads as business hours: 7-11 in the
// morning, 12 and 1-6 in the afternoon.
function rangeStartHour(toks, n, rangeEnd) {
  const endPeriod = rangeEnd > 0 ? periodAfter(toks, rangeEnd + 1) : null;
  if (!endPeriod) return clockHour(n, n >= 7 && n <= 11 ? 'am' : 'pm');
  const end = hourNumber(toks[rangeEnd]);
  return (clockHour(end, endPeriod) - ((end - n + 12) % 12) + 24) % 24;
}

/**
 * Hour mentions in one turn, in spoken order: { hour24, offHour, pos, end },
 * the turn-level token span of the number, its minutes and am/pm (a range's
 * whole span). A number is a clock time
 * only when something marks it as one: "at", "around" or "about" before it;
 * "ish", am/pm or o'clock after it; being a range's start ("two to four",
 * "between eight and nine" — the end belongs to the range); or minutes
 * ("two ten", "2:30", "two oh five") or a half/quarter lead-in ("half past
 * two"), both of which put it off the hour — a slot is always on the hour,
 * so such a mention can only disagree with one. A number running into a unit
 * of time is a length ("about two hours"). With no am/pm said with it, an
 * hour takes a part of the day said in its sentence ("Thursday evening at
 * eight"), else a range's start its end's am/pm, else business hours (7-11
 * morning; 12 and 1-6 afternoon): a period said about another time ("my 9
 * AM visit") says nothing about it.
 */
function extractHourMentions(turnText) {
  const mentions = [];
  let offset = 0; // token offset of this sentence within the whole turn
  for (const sentence of splitTurnSentences(turnText)) {
    const toks = normalize(sentence).split(' ').filter(Boolean);
    const dayParts = new Set(toks.filter((t) => Object.hasOwn(DAY_PART_PERIODS, t)).map((t) => DAY_PART_PERIODS[t]));
    const sentencePeriod = dayParts.size === 1 ? [...dayParts][0] : null;
    let rangeEnd = -1;
    for (let i = 0; i < toks.length; i += 1) {
      if (Object.hasOwn(NAMED_HOURS, toks[i])) mentions.push({ hour24: NAMED_HOURS[toks[i]], offHour: inexactAt(toks, i, i + 1), pos: offset + i, end: offset + i + 1 });
      const n = hourNumber(toks[i]);
      if (n == null || i === rangeEnd) continue;
      const after = i + 1 + minuteTokensAfter(toks, i);
      rangeEnd = rangeEndAfter(toks, i, after);
      let end = Math.max(after, rangeEnd + 1);
      while (CLOCK_TAIL.has(toks[end])) end += 1;
      const offHour = after > i + 1 || inexactAt(toks, i, end);
      const period = periodAfter(toks, after) || sentencePeriod;
      const marked = offHour || rangeEnd > 0 || period || OCLOCK.has(toks[after]) || HOUR_LEADS.has(toks[i - 1]) || toks[i + 1] === 'ish';
      if (!marked || runsIntoDuration(toks, after)) continue;
      mentions.push({ hour24: period ? clockHour(n, period) : rangeStartHour(toks, n, rangeEnd), offHour, pos: offset + i, end: offset + end });
      i = after - 1;
    }
    offset += toks.length;
  }
  return mentions;
}

// Is the hour spanning [pos, end) of these tokens offered with another
// number joined to it by "or"/"and" ("two or four", "at two or at four", "2
// pm or 3"), even one no marker makes a clock time? A range ("between two
// and four") is one mention, never an alternative.
function offeredWithAnotherHour(toks, pos, end) {
  const skip = (k, step) => { let j = k; while (HOUR_FILLER.has(toks[j])) j += step; return j; };
  const next = skip(end, 1);
  const prev = skip(pos - 1, -1);
  const isHour = (t) => hourNumber(t) != null || Object.hasOwn(NAMED_HOURS, t || '');
  return (HOUR_ALTERNATIVES.has(toks[next]) && isHour(toks[skip(next + 1, 1)]))
    || (HOUR_ALTERNATIVES.has(toks[prev]) && isHour(toks[skip(prev - 1, -1)]));
}

// A day said relative to the slot or the calendar ("a week later", "next
// week", "another day") is another time too.
const RELATIVE_DAY_PHRASES = [
  'next week', 'week later', 'weeks later', 'following week', 'week after', 'next month', 'month later', 'another day',
  'different day', 'later that week', 'later in the week', 'earlier in the week', 'next weekend', 'the weekend', 'day later', 'days later',
];
// The hours of the day a part-of-day word covers.
const DAY_PARTS = { morning: [7, 11], afternoon: [12, 17], evening: [17, 21] };
// "One" is a time only right after these ("make that one", "switch it to
// one"): elsewhere it counts things ("one more thing").
const ONE_LEADS = new Set(['that', 'it', 'to']);

// Does this text, read beside the mentions parsed from it, talk about a
// time other than `hour24` — an hour no marker makes a clock time ("make that
// three", read as business hours), a part of the day that does not hold it,
// a day relative to the slot ("a week later"), a month or other time word?
// The same hour said again unmarked ("we'll switch it to two") is not another
// time, and a number running into a unit of time is a length.
function talksOtherTime(ns, hour24) {
  const toks = ns.split(' ');
  if (RELATIVE_DAY_PHRASES.some((phrase) => ` ${ns} `.includes(` ${phrase} `))) return true;
  return toks.some((tok, i) => {
    const one = tok === 'one' && ONE_LEADS.has(toks[i - 1]);
    if (!one && !TIME_WORDS.has(tok) && !/^(?:[1-9]|1[0-2])$/.test(tok)) return false;
    if (runsIntoDuration(toks, i + 1)) return false;
    const n = hourNumber(tok);
    if (n != null) return rangeStartHour(toks, n, -1) !== hour24;
    const part = DAY_PARTS[tok];
    return !part || hour24 < part[0] || hour24 > part[1];
  });
}

module.exports = {
  normalize, parseTurns, parseDayMentions,
  splitTurnSentences, sentenceSpans, extractHourMentions, offeredWithAnotherHour, talksOtherTime,
};
