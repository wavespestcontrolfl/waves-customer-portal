/**
 * Day references in a labelled call transcript ("Agent: ..." / "Caller: ..."
 * lines), shared by the call reschedule applier's visit selection and its
 * agreement evidence (call-reschedule-evidence.js).
 *
 * A mention carries every calendar date it could mean: a month and day,
 * today, tomorrow and the day after name one; a weekday or "next <weekday>"
 * names two (this week's and next week's), since ordinary speech uses both.
 * Mentions come back in the order they were spoken.
 */
'use strict';

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

module.exports = {
  normalize, parseTurns, etDateOf, addDays, daysBetween, weekdayIdxOf, parseDayMentions, exactDatesNamed,
};
