/**
 * Day and hour references in a labelled call transcript ("Agent: ..." /
 * "Caller: ..." lines), used by the call reschedule applier's agreement
 * evidence (call-reschedule-evidence.js).
 *
 * A day mention carries every calendar date it could mean: today, tomorrow
 * and the day after name one; a month and day names this year's and next
 * year's; a weekday or "next <weekday>" names this week's and next week's,
 * since ordinary speech uses both. An hour mention carries its 24-hour value
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

const SPELLED_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
// Minute words that, after an hour, put a spoken time off the hour.
const MINUTE_WORDS = new Set(['fifteen', 'twenty', 'thirty', 'forty', 'fifty']);

function inferBusinessHours(n) {
  if (n >= 7 && n <= 11) return 'am';
  if (n >= 1 && n <= 6) return 'pm';
  if (n === 12) return 'pm';
  return null;
}

// Period words across the whole call. A bare "am" counts EXCEPT the verb
// ("you know where I am"), narrowed to "am" right after "i".
function wholeCallPeriodFlags(turnTexts) {
  const toks = turnTexts.map((t) => normalize(t)).join(' ').split(' ').filter(Boolean);
  return {
    hasMorning: toks.includes('morning'),
    hasAfternoon: toks.includes('afternoon'),
    hasAm: toks.some((t, i, arr) => t === 'am' && arr[i - 1] !== 'i'),
    hasPm: toks.includes('pm'),
  };
}

// Sentences WITHIN one turn (on . ! ?), so an end-of-sentence hour means the
// end of a sentence, not of the whole turn.
function splitTurnSentences(turnText) {
  return joinMeridiem(turnText).split(/[.!?]+/).map((x) => x.trim()).filter(Boolean);
}

// A token that, right after an hour, is its minutes: a number 1-59 ("2 10",
// "2:30" read as "2 30"), a spelled number or a minute word ("two ten",
// "two thirty").
function isMinuteToken(t) {
  return (/^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 59) || MINUTE_WORDS.has(t) || Object.hasOwn(SPELLED_NUMBERS, t);
}

/**
 * Hour mentions in one turn, in spoken order: { hour24, offHour, kind, pos,
 * end } with end the turn-level token index after the mention. A range
 * ("two to four", "between eight and nine") counts its START. "after N" /
 * "for N" is an hour only with am/pm, o'clock or at the end of a sentence.
 * Minutes after the hour ("two ten", "2:30", "two oh five") or a half/quarter
 * lead-in ("half past two") mark the time off the hour: a slot is always on
 * the hour, so such a mention can only disagree with one.
 */
function extractHourMentionsWholeCall(turnText, flags) {
  const wordNum = (t) => (/^\d{1,2}$/.test(t) ? Number(t) : (Object.hasOwn(SPELLED_NUMBERS, t) ? SPELLED_NUMBERS[t] : null));
  const mentions = [];
  let offset = 0; // token offset of this sentence within the whole turn
  for (const sentence of splitTurnSentences(turnText)) {
    const toks = normalize(sentence).split(' ').filter(Boolean);
    const found = [];
    toks.forEach((t, i) => {
      if (t === 'noon') found.push({ hour24: 12, kind: 'noon', pos: i, end: offset + i + 1 });
      if (t === 'midnight') found.push({ hour24: 0, kind: 'midnight', pos: i, end: offset + i + 1 });
    });
    const consumed = new Array(toks.length).fill(false);
    const rangeStart = new Set();
    for (let i = 0; i < toks.length; i += 1) {
      if (toks[i] === 'between' && wordNum(toks[i + 1]) != null && toks[i + 2] === 'and' && wordNum(toks[i + 3]) != null) {
        rangeStart.add(i + 1); consumed[i + 3] = true;
      }
      if (wordNum(toks[i]) != null && (toks[i + 1] === 'to' || toks[i + 1] === 'through') && wordNum(toks[i + 2]) != null) {
        rangeStart.add(i); consumed[i + 2] = true;
      }
    }
    for (let i = 0; i < toks.length; i += 1) {
      if (consumed[i]) continue;
      const n = wordNum(toks[i]);
      if (n == null || n < 1 || n > 12) continue;
      const prev = toks[i - 1] || '';
      const next = toks[i + 1] || '';
      const next2 = toks[i + 2] || '';
      const next3 = toks[i + 3] || '';
      let minuteToks = 0;
      if (next === 'oh' && isMinuteToken(next2)) minuteToks = 2;
      else if (isMinuteToken(next)) minuteToks = MINUTE_WORDS.has(next) && Object.hasOwn(SPELLED_NUMBERS, next2) ? 2 : 1;
      for (let k = 1; k <= minuteToks; k += 1) consumed[i + k] = true;
      const offHour = minuteToks > 0
        || ((prev === 'past' || prev === 'after' || prev === 'to') && (toks[i - 2] === 'half' || toks[i - 2] === 'quarter'));
      const afterMinutes = toks[i + 1 + minuteToks] || '';
      let period = null;
      if (minuteToks && (afterMinutes === 'am' || afterMinutes === 'pm')) period = afterMinutes;
      else if (next === 'am' || next === 'pm') period = next;
      else if (next === '00' && (next2 === 'am' || next2 === 'pm')) period = next2;
      else if (next === 'o' && next2 === 'clock' && (next3 === 'am' || next3 === 'pm')) period = next3;
      const oclockNext = (next === 'o' && next2 === 'clock') || next === 'oclock';
      const afterOrFor = (prev === 'after' || prev === 'for') && (period || oclockNext || i === toks.length - 1);
      const hourMarker = offHour || rangeStart.has(i) || period || oclockNext
        || prev === 'at' || prev === 'around' || prev === 'about' || next === 'ish' || afterOrFor;
      if (!hourMarker) continue;
      if (!period) {
        if (flags.hasMorning && !flags.hasAfternoon) period = 'am';
        else if (flags.hasAfternoon && !flags.hasMorning) period = 'pm';
        else if (flags.hasAm && !flags.hasPm) period = 'am';
        else if (flags.hasPm && !flags.hasAm) period = 'pm';
        else period = inferBusinessHours(n);
      }
      if (!period) continue;
      const hour24 = period === 'am' ? (n === 12 ? 0 : n) : (n === 12 ? 12 : n + 12);
      found.push({ hour24, offHour, kind: rangeStart.has(i) ? 'range_start' : (afterOrFor ? 'after_for' : 'hour'), pos: i, end: offset + i + 1 + minuteToks });
    }
    mentions.push(...found.sort((a, b) => a.pos - b.pos));
    offset += toks.length;
  }
  return mentions;
}

module.exports = {
  normalize, parseTurns, parseDayMentions,
  splitTurnSentences, wholeCallPeriodFlags, extractHourMentionsWholeCall,
};
