/**
 * Day and hour references in a labelled call transcript ("Agent: ..." /
 * "Caller: ..." lines), shared by the call reschedule applier's visit
 * selection and its agreement evidence (call-reschedule-evidence.js).
 *
 * A day mention carries every calendar date it could mean: a month and day,
 * today, tomorrow and the day after name one; a weekday or "next <weekday>"
 * names two (this week's and next week's), since ordinary speech uses both.
 * An hour mention carries its 24-hour value and whether minutes put it off
 * the hour. Mentions come back in the order they were spoken.
 */
'use strict';

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// "a.m." / "p.m." as single tokens, so neither the sentence splitter nor
// punctuation stripping can break "9 a.m." apart.
function joinMeridiem(s) {
  return String(s || '').replace(/\b([ap])\.\s?m\b\.?/gi, '$1m');
}
function normalize(s) {
  return joinMeridiem(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseTurns(transcript) {
  const turns = [];
  for (const line of String(transcript || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(agent|caller)\s*:\s*(.*)$/i);
    if (!m) return null; // unlabeled line: cannot trust turn boundaries, fail closed
    turns.push({ agent: m[1].toLowerCase() === 'agent', raw: m[2], ns: normalize(m[2]), interrogative: /\?/.test(m[2]) });
  }
  return turns;
}

function etDateOf(dateObj) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(dateObj).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function weekdayIdxOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}


// ---- day-reference extraction ----
// Each mention carries a Set of candidate calendar dates it could resolve to
// (a bare weekday/tomorrow/today/month-day names exactly one; "next
// <weekday>" names two, either of which is a legitimate reading — same for a
// bare weekday, genuinely ambiguous between the immediate occurrence and the
// one a week later in ordinary speech). A mention "resolves" the slot when
// the slot's date is one of its candidates.
function parseDayMentions(turnText, callDateStr, callWeekdayIdx) {
  const ns = normalize(turnText);
  const toks = ns.split(' ').filter(Boolean);
  const consumed = new Array(toks.length).fill(false);
  const mentions = [];

  for (let i = 0; i < toks.length; i += 1) {
    if (!consumed[i] && toks[i] === 'day' && toks[i + 1] === 'after' && toks[i + 2] === 'tomorrow') {
      mentions.push({ candidates: new Set([addDays(callDateStr, 2)]), kind: 'day_after_tomorrow', pos: i, end: i + 3 });
      consumed[i] = true; consumed[i + 1] = true; consumed[i + 2] = true;
    }
  }
  for (let i = 0; i < toks.length; i += 1) {
    if (!consumed[i] && toks[i] === 'tomorrow') {
      mentions.push({ candidates: new Set([addDays(callDateStr, 1)]), kind: 'tomorrow', pos: i, end: i + 1 });
      consumed[i] = true;
    }
  }
  for (let i = 0; i < toks.length; i += 1) {
    if (!consumed[i] && toks[i] === 'today') {
      mentions.push({ candidates: new Set([callDateStr]), kind: 'today', pos: i, end: i + 1 });
      consumed[i] = true;
    }
  }
  for (let i = 0; i < toks.length; i += 1) {
    if (!consumed[i] && toks[i] === 'next' && WEEKDAY_NAMES.includes(toks[i + 1]) && !consumed[i + 1]) {
      const wIdx = WEEKDAY_NAMES.indexOf(toks[i + 1]);
      const off1 = ((wIdx - callWeekdayIdx + 7) % 7) || 7;
      mentions.push({ candidates: new Set([addDays(callDateStr, off1), addDays(callDateStr, off1 + 7)]), kind: 'next_weekday', pos: i, end: i + 2 });
      consumed[i] = true; consumed[i + 1] = true;
    }
  }
  for (let i = 0; i < toks.length; i += 1) {
    if (!consumed[i] && WEEKDAY_NAMES.includes(toks[i])) {
      const wIdx = WEEKDAY_NAMES.indexOf(toks[i]);
      const off = ((wIdx - callWeekdayIdx + 7) % 7) || 7;
      mentions.push({ candidates: new Set([addDays(callDateStr, off), addDays(callDateStr, off + 7)]), kind: 'weekday', pos: i, end: i + 1 });
      consumed[i] = true;
    }
  }
  for (let i = 0; i < toks.length; i += 1) {
    if (!consumed[i] && MONTH_NAMES.includes(toks[i])) {
      const monIdx = MONTH_NAMES.indexOf(toks[i]);
      const dayTok = toks[i + 1];
      const dm = dayTok && dayTok.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
      if (dm) {
        const dayNum = Number(dm[1]);
        const callYear = Number(callDateStr.slice(0, 4));
        let candDate = `${callYear}-${String(monIdx + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
        if (daysBetween(callDateStr, candDate) < -300) {
          candDate = `${callYear + 1}-${String(monIdx + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
        }
        mentions.push({ candidates: new Set([candDate]), kind: 'month_day', pos: i, end: i + 2 });
        consumed[i] = true; consumed[i + 1] = true;
      }
    }
  }
  // Each kind is found in its own pass, so restore the order they were
  // SPOKEN in: last-mention-wins must read "not Friday, tomorrow" as tomorrow.
  return mentions.sort((a, b) => a.pos - b.pos);
}

const SPELLED_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// Minute words that put a spoken time off the hour ("two thirty",
// "two forty five"); "ten" and "five" are left out as they are also hours.
const MINUTE_WORDS = new Set(['fifteen', 'twenty', 'thirty', 'forty', 'fifty']);

// ---- hour-reference extraction (whole-call) ----
function inferBusinessHours(n) {
  if (n >= 7 && n <= 11) return 'am';
  if (n >= 1 && n <= 6) return 'pm';
  if (n === 12) return 'pm';
  return null;
}

// A bare "am" anywhere in the call is a period signal EXCEPT the ordinary
// verb ("you know where I am") — narrowed to "am" immediately preceded by
// "i", since scoping the period flags to the whole call (rather than a
// short window) hugely raises the odds of hitting that verb.
function wholeCallPeriodFlags(turnTexts) {
  const toks = turnTexts.map((t) => normalize(t)).join(' ').split(' ').filter(Boolean);
  return {
    hasMorning: toks.includes('morning'),
    hasAfternoon: toks.includes('afternoon'),
    hasAm: toks.some((t, i, arr) => t === 'am' && arr[i - 1] !== 'i'),
    hasPm: toks.includes('pm'),
  };
}

// Sentence-split WITHIN one turn (on . ! ?) so an end-of-sentence hour marker
// means end of a sentence, not end of the whole (often multi-sentence) turn.
function splitTurnSentences(turnText) {
  return joinMeridiem(turnText).split(/[.!?]+/).map((x) => x.trim()).filter(Boolean);
}

// Adds range support ("two to four" / "between eight and nine" — only the
// range START counts, per spec) and "after N" / "for N" as hour context
// only when N is 1-12 and is followed by am/pm/o'clock or is the last token
// of its sentence.
function extractHourMentionsWholeCall(turnText, flags) {
  const wordNum = (t) => (/^\d{1,2}$/.test(t) ? Number(t) : (SPELLED_NUMBERS[t] || null));
  const mentions = [];
  let offset = 0; // token offset of this sentence within the whole turn
  for (const sentence of splitTurnSentences(turnText)) {
    const toks = normalize(sentence).split(' ').filter(Boolean);
    // Collected per sentence with token positions, then emitted in spoken
    // order so "at 11, no, make it noon" ends on noon.
    const found = [];
    toks.forEach((t, i) => {
      if (t === 'noon') found.push({ hour24: 12, kind: 'noon', pos: i, end: offset + i + 1 });
      if (t === 'midnight') found.push({ hour24: 0, kind: 'midnight', pos: i, end: offset + i + 1 });
    });
    const consumed = new Array(toks.length).fill(false);
    const rangeStart = new Set();
    for (let i = 0; i < toks.length; i += 1) {
      if (toks[i] === 'between') {
        const n1 = wordNum(toks[i + 1]);
        if (n1 != null && toks[i + 2] === 'and') {
          const n2 = wordNum(toks[i + 3]);
          if (n2 != null) { rangeStart.add(i + 1); consumed[i + 3] = true; }
        }
      }
    }
    for (let i = 0; i < toks.length; i += 1) {
      const n1 = wordNum(toks[i]);
      if (n1 != null && (toks[i + 1] === 'to' || toks[i + 1] === 'through')) {
        const n2 = wordNum(toks[i + 2]);
        if (n2 != null) { rangeStart.add(i); consumed[i + 2] = true; }
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
      const isLastToken = i === toks.length - 1;
      // Minutes ("2:30" normalizes to "2 30", "two thirty", "two forty
      // five") or a half/quarter lead-in ("half past two") put the time off
      // the hour. A slot is always on the hour, so such a mention always
      // counts as an hour reference and can only disagree with the slot.
      let minuteToks = 0;
      if (/^\d{2}$/.test(next) && Number(next) >= 1 && Number(next) <= 59) minuteToks = 1;
      else if (MINUTE_WORDS.has(next)) minuteToks = next2 === 'five' && next !== 'fifteen' && next !== 'thirty' ? 2 : 1;
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
      const afterOrFor = (prev === 'after' || prev === 'for') && (period || oclockNext || isLastToken);
      const hourMarker = offHour || rangeStart.has(i) || period || oclockNext
        || prev === 'at' || prev === 'around' || prev === 'about'
        || next === 'ish' || afterOrFor;
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

/**
 * The calendar dates (YYYY-MM-DD, ET) the call names EXACTLY, from either
 * speaker. Only single-date references count (a month and day, today,
 * tomorrow, the day after): a weekday names two dates and proves neither.
 * Empty for an unlabeled transcript or an unreadable call time.
 */
function exactDatesNamed({ transcript, callStartedAt } = {}) {
  const started = new Date(String(callStartedAt || ''));
  const turns = parseTurns(transcript);
  if (Number.isNaN(started.getTime()) || !turns) return new Set();
  const callDate = etDateOf(started);
  const callWeekdayIdx = weekdayIdxOf(callDate);
  const dates = new Set();
  for (const turn of turns) {
    for (const m of parseDayMentions(turn.raw, callDate, callWeekdayIdx)) {
      if (m.candidates.size === 1) dates.add([...m.candidates][0]);
    }
  }
  return dates;
}

/**
 * Months the call names WITHOUT a day ("my December visit"), as YYYY-MM for
 * both this year and next: a loose reference to another occurrence of a
 * program is enough to leave the choice to a person. A month with a day is
 * an exact date (exactDatesNamed).
 */
function monthsReferenced({ transcript, callStartedAt } = {}) {
  const started = new Date(String(callStartedAt || ''));
  const turns = parseTurns(transcript);
  if (Number.isNaN(started.getTime()) || !turns) return new Set();
  const year = Number(etDateOf(started).slice(0, 4));
  const months = new Set();
  for (const turn of turns) {
    const toks = turn.ns.split(' ');
    for (let i = 0; i < toks.length; i += 1) {
      const idx = MONTH_NAMES.indexOf(toks[i]);
      if (idx < 0 || /^\d{1,2}(?:st|nd|rd|th)?$/.test(toks[i + 1] || '')) continue;
      const mm = String(idx + 1).padStart(2, '0');
      months.add(`${year}-${mm}`);
      months.add(`${year + 1}-${mm}`);
    }
  }
  return months;
}

/**
 * Every hour the call mentions, in spoken order: { hour24, offHour }, with
 * am/pm inferred from the whole call's period words. Empty for an unlabeled
 * transcript.
 */
function hoursMentioned({ transcript } = {}) {
  const turns = parseTurns(transcript);
  if (!turns) return [];
  const flags = wholeCallPeriodFlags(turns.map((t) => t.raw));
  return turns.flatMap((t) => extractHourMentionsWholeCall(t.raw, flags));
}

module.exports = {
  normalize, parseTurns, etDateOf, addDays, daysBetween, weekdayIdxOf,
  parseDayMentions, wholeCallPeriodFlags, extractHourMentionsWholeCall,
  exactDatesNamed, monthsReferenced, hoursMentioned,
};
