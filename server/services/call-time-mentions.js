/**
 * Day references in a labelled call transcript ("Agent: ..." / "Caller: ..."
 * lines), used by the call reschedule applier's visit selection.
 *
 * A day mention carries every calendar date it could mean: a month and day,
 * today, tomorrow and the day after name one; a weekday or "next <weekday>"
 * names two (this week's and next week's), since ordinary speech uses both.
 * Mentions come back in the order they were spoken. Dates are ET calendar
 * days (server/utils/datetime-et.js), relative to when the call started.
 */
'use strict';

const { etParts, etDateString, addETDays } = require('../utils/datetime-et');

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const RELATIVE_DAYS = { today: 0, tomorrow: 1 };
const DAY_OF_MONTH = /^(\d{1,2})(?:st|nd|rd|th)?$/;

// "a.m." / "p.m." as single tokens, so punctuation stripping cannot break
// "9 a.m." apart.
function joinMeridiem(s) {
  return String(s || '').replace(/\b([ap])\.\s?m\b\.?/gi, '$1m');
}
function normalize(s) {
  return joinMeridiem(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

// A month and day in the call's year, or the next year's when that date is
// more than ~10 months behind the call ("January 3rd" said in December).
function monthDayDate(monthIdx, dayNum, started) {
  const { year } = etParts(started);
  const md = `${String(monthIdx + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
  return `${year}-${md}` < dayAfterCall(started, -300) ? `${year + 1}-${md}` : `${year}-${md}`;
}

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
    else if (t in RELATIVE_DAYS) hit = { dates: [dayAfterCall(started, RELATIVE_DAYS[t])], kind: t, len: 1 };
    else if (t === 'next' && WEEKDAY_NAMES.includes(t1)) hit = { dates: weekdayDates(t1), kind: 'next_weekday', len: 2 };
    else if (WEEKDAY_NAMES.includes(t)) hit = { dates: weekdayDates(t), kind: 'weekday', len: 1 };
    else if (MONTH_NAMES.includes(t) && DAY_OF_MONTH.test(t1 || '')) {
      hit = { dates: [monthDayDate(MONTH_NAMES.indexOf(t), Number(DAY_OF_MONTH.exec(t1)[1]), started)], kind: 'month_day', len: 2 };
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
 * The calendar dates (YYYY-MM-DD, ET) the call names EXACTLY, from either
 * speaker. Only single-date references count (a month and day, today,
 * tomorrow, the day after): a weekday names two dates and proves neither.
 * Empty for an unlabeled transcript or an unreadable call time.
 */
function exactDatesNamed({ transcript, callStartedAt } = {}) {
  const started = callStart(callStartedAt);
  const turns = parseTurns(transcript);
  const dates = new Set();
  if (!started || !turns) return dates;
  for (const turn of turns) {
    for (const m of parseDayMentions(turn.raw, started)) {
      if (m.candidates.size === 1) dates.add([...m.candidates][0]);
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
      const idx = MONTH_NAMES.indexOf(tok);
      if (idx < 0 || DAY_OF_MONTH.test(toks[i + 1] || '')) return;
      const mm = String(idx + 1).padStart(2, '0');
      months.add(`${year}-${mm}`);
      months.add(`${year + 1}-${mm}`);
    });
  }
  return months;
}

module.exports = { normalize, parseTurns, parseDayMentions, exactDatesNamed, monthsReferenced };
