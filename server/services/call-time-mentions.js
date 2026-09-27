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
// A date written as numbers ("12/24", "12/24/26") reads as its month and day
// ("december 24"), so it is a mention like any other. The year is dropped: a
// month and day already stands for this year's and next year's date. A stray
// match ("1/2 hour") can only add a mention, which only ever adds review.
function spellNumericDates(s) {
  return s.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g, (whole, mo, d) => {
    const month = Number(mo);
    const day = Number(d);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${MONTH_NAMES[month - 1]} ${day}` : whole;
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
    && { dates: weekdayDates(toks[i + 1], started), kind: 'next_weekday', len: 2, weekday: WEEKDAY_NAMES.indexOf(toks[i + 1]) },
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

// A weekday said on the call: this week's and next week's, never the call's
// own day.
function weekdayDates(name, started) {
  const off = ((WEEKDAY_NAMES.indexOf(name) - etParts(started).dayOfWeek + 7) % 7) || 7;
  return [dayAfterCall(started, off), dayAfterCall(started, off + 7)];
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
    mentions.push({ candidates: new Set(hit.dates), kind: hit.kind, pos: i, end: i + hit.len, ...(hit.weekday != null ? { weekday: hit.weekday } : {}) });
    i += hit.len - 1;
  }
  return mentions;
}

const SPELLED_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NAMED_HOURS = { noon: 12, midnight: 0 };
// Minute words that, after an hour, put a spoken time off the hour.
const MINUTE_WORDS = new Set(['fifteen', 'twenty', 'thirty', 'forty', 'fifty']);
// Words right before a number that make it a clock time: "at two".
const HOUR_LEADS = new Set(['at', 'around', 'about']);
// "Two o'clock" normalizes to "two o clock" or "two oclock".
const OCLOCK = new Set(['o', 'oclock']);
// A number running into a unit of time is a length, not a clock time.
const DURATION_UNITS = new Set(['hour', 'hours', 'hr', 'hrs', 'minute', 'minutes', 'min', 'mins']);
const DURATION_FILLER = new Set(['and', 'a', 'half', 'or', 'to', 'through', 'quarter']);
// Said right after an hour, part of it: "2 pm", "2 00 pm", "two o clock".
const CLOCK_TAIL = new Set(['am', 'pm', 'o', 'clock', 'oclock', '00']);
// Words that can only be about when: an hour from two to twelve ("one" also
// counts things — "one more question"), noon, am/pm, a part of the day, a
// weekday, a month ("may" is also a verb), today, tomorrow.
const TIME_WORDS = new Set([
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'noon', 'midnight', 'am', 'pm', 'morning', 'afternoon', 'evening', 'today', 'tomorrow', ...WEEKDAY_NAMES,
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
 * hour reads as business hours (7-11 morning; 12 and 1-6 afternoon), or a
 * range's start from its end's am/pm: a period said about another time ("my
 * 9 AM visit") says nothing about it.
 */
function extractHourMentions(turnText) {
  const mentions = [];
  let offset = 0; // token offset of this sentence within the whole turn
  for (const sentence of splitTurnSentences(turnText)) {
    const toks = normalize(sentence).split(' ').filter(Boolean);
    let rangeEnd = -1;
    for (let i = 0; i < toks.length; i += 1) {
      if (Object.hasOwn(NAMED_HOURS, toks[i])) mentions.push({ hour24: NAMED_HOURS[toks[i]], offHour: false, pos: offset + i, end: offset + i + 1 });
      const n = hourNumber(toks[i]);
      if (n == null || i === rangeEnd) continue;
      const after = i + 1 + minuteTokensAfter(toks, i);
      rangeEnd = rangeEndAfter(toks, i, after);
      const offHour = after > i + 1 || (['past', 'after', 'to'].includes(toks[i - 1]) && ['half', 'quarter'].includes(toks[i - 2]));
      const period = periodAfter(toks, after);
      const marked = offHour || rangeEnd > 0 || period || OCLOCK.has(toks[after]) || HOUR_LEADS.has(toks[i - 1]) || toks[i + 1] === 'ish';
      if (!marked || runsIntoDuration(toks, after)) continue;
      let end = Math.max(after, rangeEnd + 1);
      while (CLOCK_TAIL.has(toks[end])) end += 1;
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
  return (HOUR_ALTERNATIVES.has(toks[next]) && hourNumber(toks[skip(next + 1, 1)]) != null)
    || (HOUR_ALTERNATIVES.has(toks[prev]) && hourNumber(toks[skip(prev - 1, -1)]) != null);
}

// Does this text talk about when, beyond the mentions parsed from it — an
// hour no marker makes a clock time ("make that three"), a part of the day,
// a weekday or month? A number running into a unit of time is a length.
function talksTime(ns) {
  const toks = ns.split(' ');
  return toks.some((tok, i) => (TIME_WORDS.has(tok) || /^(?:[1-9]|1[0-2])$/.test(tok)) && !runsIntoDuration(toks, i + 1));
}

module.exports = {
  normalize, parseTurns, parseDayMentions,
  splitTurnSentences, sentenceSpans, extractHourMentions, offeredWithAnotherHour, talksTime,
};
