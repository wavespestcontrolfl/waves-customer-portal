/**
 * Day references in a labelled call transcript ("Agent: ..." / "Caller: ..."
 * lines), used by the call reschedule applier's visit selection.
 *
 * A day mention carries every calendar date it could mean: today, tomorrow
 * and the day after name one; a month and day names this year's and next
 * year's; a weekday or "next <weekday>" names this week's and next week's,
 * since ordinary speech uses both.
 * Mentions come back in the order they were spoken. Dates are ET calendar
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

// "a.m." / "p.m." as single tokens, so punctuation stripping cannot break
// "9 a.m." apart.
function joinMeridiem(s) {
  return String(s || '').replace(/\b([ap])\.\s?m\b\.?/gi, '$1m');
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

// Mentions that name one day (a month and day in either year, today,
// tomorrow, the day after), unlike a weekday, which could be this week's or
// next week's.
const EXACT_KINDS = new Set(['day_after_tomorrow', 'today', 'tomorrow', 'month_day']);

/**
 * Day mentions in one turn, in spoken order: { candidates: Set<YYYY-MM-DD>,
 * kind, pos, end } with pos/end the turn-level token span. `started` is the
 * call's start (a Date).
 */
function parseDayMentions(turnText, started) {
  const toks = normalize(turnText).split(' ').filter(Boolean);
  const weekday = etParts(started).dayOfWeek;
  const weekdayDates = (name) => {
    const off = ((WEEKDAY_NAMES.indexOf(name) - weekday + 7) % 7) || 7;
    return [dayAfterCall(started, off), dayAfterCall(started, off + 7)];
  };
  const mentions = [];
  for (let i = 0; i < toks.length; i += 1) {
    const [t, t1, t2] = [toks[i], toks[i + 1], toks[i + 2]];
    let hit = null;
    if (t === 'day' && t1 === 'after' && t2 === 'tomorrow') hit = { dates: [dayAfterCall(started, 2)], kind: 'day_after_tomorrow', len: 3 };
    else if (Object.hasOwn(RELATIVE_DAYS, t)) hit = { dates: [dayAfterCall(started, RELATIVE_DAYS[t])], kind: t, len: 1 };
    else if (t === 'next' && WEEKDAY_NAMES.includes(t1)) hit = { dates: weekdayDates(t1), kind: 'next_weekday', len: 2 };
    else if (WEEKDAY_NAMES.includes(t)) hit = { dates: weekdayDates(t), kind: 'weekday', len: 1 };
    else if (monthIndexOf(t) >= 0 && DAY_OF_MONTH.test(t1 || '')) {
      hit = { dates: monthDayDates(monthIndexOf(t), Number(DAY_OF_MONTH.exec(t1)[1]), started), kind: 'month_day', len: 2 };
    }
    if (!hit) continue;
    mentions.push({ candidates: new Set(hit.dates), kind: hit.kind, pos: i, end: i + hit.len });
    i += hit.len - 1;
  }
  return mentions;
}

function callStart(callStartedAt) {
  const started = new Date(String(callStartedAt || ''));
  return Number.isNaN(started.getTime()) ? null : started;
}

/**
 * The calendar dates (YYYY-MM-DD, ET) the call names by day, from either
 * speaker: a month and day (as this year's and next year's date), today,
 * tomorrow, the day after. A weekday could be this week's or next week's and
 * counts as neither. Empty for an unlabeled transcript or an unreadable call
 * time.
 */
function exactDatesNamed({ transcript, callStartedAt } = {}) {
  const started = callStart(callStartedAt);
  const turns = parseTurns(transcript);
  const dates = new Set();
  if (!started || !turns) return dates;
  for (const turn of turns) {
    for (const m of parseDayMentions(turn.raw, started)) {
      if (EXACT_KINDS.has(m.kind)) m.candidates.forEach((d) => dates.add(d));
    }
  }
  return dates;
}

/**
 * Months the call names WITHOUT a day ("my December visit"), as YYYY-MM for
 * both this year and next: a loose reference to another visit is enough to
 * leave the choice to a person. A month with a day is an exact date.
 */
function monthsReferenced({ transcript, callStartedAt } = {}) {
  const started = callStart(callStartedAt);
  const turns = parseTurns(transcript);
  const months = new Set();
  if (!started || !turns) return months;
  const { year } = etParts(started);
  for (const turn of turns) {
    const toks = turn.ns.split(' ');
    toks.forEach((tok, i) => {
      const idx = monthIndexOf(tok);
      if (idx < 0 || DAY_OF_MONTH.test(toks[i + 1] || '')) return;
      const mm = String(idx + 1).padStart(2, '0');
      months.add(`${year}-${mm}`);
      months.add(`${year + 1}-${mm}`);
    });
  }
  return months;
}

module.exports = { normalize, parseTurns, parseDayMentions, exactDatesNamed, monthsReferenced };
