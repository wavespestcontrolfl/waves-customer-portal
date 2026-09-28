/**
 * Reschedule agreement grounding — the AUTOMATIC path of
 * call-reschedule-apply.js only (never humanOverride, which keeps its own
 * staff-approved contract).
 *
 * Owner decisions 2026-09-27: the V2 call extraction judges whether the
 * caller agreed to the reschedule, which existing appointment it moves
 * (schema 1.16.0: scheduling.caller_accepted_slot, moved_appointment_date),
 * and records the agreed time as the WORDS that said it (schema 1.17.0:
 * scheduling.agreed_slot_words {day, hour, period}, moved_appointment_words).
 * Reading times out of speech with a parser never converged under review
 * (#5071; #5092 rounds 1-3), so this module does not parse the conversation.
 * It checks that the extraction's quotes are real and hold the words it
 * recorded, and that those words are the agreed slot:
 *   - the agent's commitment (/scheduling/agent_committed_booking, speaker
 *     "agent") and the caller's acceptance (/scheduling/caller_accepted_slot,
 *     speaker "caller") each appear word for word in one turn of that
 *     speaker, in sentences that are not questions and are free of
 *     negation, hedges and open conditions (the booking check's own
 *     screens, call-triage-flags.js — a quote cut from "We will not see you
 *     Thursday" or "Will we see you Thursday at two?" does not ground);
 *   - an agreed-slot quote (/scheduling/confirmed_start_at) appears word for
 *     word in one turn and contains every recorded slot word; the hour word
 *     is one hour ("two", "2", "noon") and is the slot's; the period words
 *     state the slot's AM/PM (required unless the hour is noon or midnight:
 *     a time nobody put in the morning or afternoon is not agreed); the day
 *     words name the slot's date, or are absent only when the slot keeps the
 *     moved appointment's date;
 *   - when the extraction names the moved appointment, a quote pinned to
 *     /scheduling/moved_appointment_date appears word for word in one turn,
 *     in sentences free of negation, hedges and conditions ("Do not move my
 *     September 24th visit" does not ground; a question may), contains
 *     moved_appointment_words, and those words name that date.
 * Day words name one date: the next that fits from the call's day ("the
 * 1st" said on September 30 is October 1, never December 1); "next
 * Thursday", which can mean two dates, names none.
 * Which words are the final agreed ones (corrections, approximations,
 * ranges) is the extraction's judgement, as the owner ruled. A quote shorter
 * than three words must be the speaker's whole turn ("Yes."), never a
 * fragment of a longer one. Anything missing, mis-attributed or ungrounded
 * fails closed.
 *
 * Contract: groundRescheduleAgreement({ v2, transcript, callStartedAt }) ->
 *   { ok, reason, movedDate: 'YYYY-MM-DD' | null }
 */
'use strict';

const { etWallClockOfConfirmedStart, turnHasNegationOrHedge, turnHasUnresolvedConditional } = require('./call-triage-flags');
const { statedDateComponents } = require('./reschedule-date-evidence');
const { etDateString, etParts, addETDays, validCalendarDate } = require('../utils/datetime-et');

const MIN_FRAGMENT_WORDS = 3;

const HOUR_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
// Words that state a half of the day, and the half each states.
// A window ending at noon starts in the morning ("between 10 and noon"),
// and one ending at midnight starts in the evening.
const PERIOD_WORDS = {
  am: 'am', morning: 'am', pm: 'pm', afternoon: 'pm', evening: 'pm', tonight: 'pm', night: 'pm', noon: 'am', midnight: 'pm',
};

function padded(s) { return ` ${s} `; }

// Lowercase words, punctuation dropped, with "a.m." / "p.m." kept as one
// word ("am") so a quote matches its turn however either was punctuated
// and the period words read the same whichever way they were written.
function joinMeridiem(s) {
  return String(s || '').replace(/\b([ap])\.\s?m\b\.?/gi, '$1m').replace(/(\d)([ap]m)\b/gi, '$1 $2');
}
function normalize(s) {
  return joinMeridiem(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The transcript's turns ({ agent, ns }); null on any unlabeled line, where
// turn boundaries cannot be trusted.
function parseTurns(transcript) {
  const turns = [];
  for (const line of String(transcript || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(agent|caller)\s*:\s*(.*)$/i);
    if (!m) return null;
    // Sentences (on . ! ?) with their normalized text, for the screen below.
    // Each keeps whether it was a question ("Will we see you Thursday at two?").
    const sentences = (joinMeridiem(m[2]).match(/[^.!?]+[.!?]*/g) || [])
      .map((raw) => ({ ns: normalize(raw), question: /\?/.test(raw) })).filter((x) => x.ns);
    turns.push({ agent: m[1].toLowerCase() === 'agent', ns: normalize(m[2]), sentences });
  }
  return turns;
}

// Where this quote appears word for word in a turn of this speaker: the
// turns it is found in. A quote under three words must be that whole turn.
function turnsHolding(turns, quote, speaker) {
  const ns = normalize(quote);
  if (!ns) return [];
  const whole = ns.split(' ').length < MIN_FRAGMENT_WORDS;
  return turns.filter((t) => t.agent === (speaker === 'agent') && (whole ? t.ns === ns : padded(t.ns).includes(padded(ns))));
}

// The sentences of this turn the quote touches, joined: a fragment quoted
// from "We will not see you Thursday at two" is read with its "not".
function sentencesAround(turn, quote) {
  const qt = normalize(quote).split(' ');
  const starts = [];
  let at = 0;
  for (const sentence of turn.sentences) { starts.push(at); at += sentence.ns.split(' ').length; }
  const tt = turn.ns.split(' ');
  const hits = [];
  for (let i = 0; i + qt.length <= tt.length; i += 1) {
    if (qt.every((w, k) => tt[i + k] === w)) hits.push([i, i + qt.length]);
  }
  return turn.sentences.filter((sentence, n) => {
    const from = starts[n];
    const to = from + sentence.ns.split(' ').length;
    return hits.some(([a, b]) => a < to && b > from);
  });
}

// Does the extraction's reading of this quote stand against the words said
// around it? The sentences it sits in must carry no negation, hedge or open
// condition — the booking check's own screens (call-triage-flags.js), applied
// to the quote's sentences rather than its whole turn so an unrelated "No
// worries." earlier in the turn does not void a real commitment — and, for a
// commitment, acceptance or slot, must not be a question.
function plainlySaid(turn, quote, askingFails) {
  const around = sentencesAround(turn, quote);
  const text = around.map((x) => x.ns).join(' ');
  return Boolean(text) && !turnHasNegationOrHedge(text) && !turnHasUnresolvedConditional(text)
    && !(askingFails && around.some((x) => x.question));
}

// Does this quote hold these recorded words, word for word?
function holds(quote, words) {
  const nw = normalize(words);
  return Boolean(nw) && padded(normalize(quote)).includes(padded(nw));
}

// The 24-hour clock value an hour word and its period words state, or null
// when the hour is not one hour, or no single half of the day is stated.
function twelveNamed(n, periodToks) {
  return n === 12 && periodToks.length === 1 && (periodToks[0] === 'noon' || periodToks[0] === 'midnight');
}

// The hour a word states, 1-12, or null.
function hourNumber(hourWords) {
  const tok = normalize(hourWords);
  const n = /^\d{1,2}$/.test(tok) ? Number(tok) : HOUR_WORDS[tok];
  return n >= 1 && n <= 12 ? n : null;
}

function statedHour(hourWords, periodWords) {
  const toks = normalize(hourWords).split(' ');
  if (toks.length !== 1) return null;
  const [tok] = toks;
  if (tok === 'noon') return 12;
  if (tok === 'midnight') return 0;
  const n = /^\d{1,2}$/.test(tok) ? Number(tok) : HOUR_WORDS[tok];
  if (!(n >= 1 && n <= 12)) return null;
  const periodToks = normalize(periodWords).split(' ');
  // "12 noon" / "12 midnight" name the hour itself; for any other hour noon
  // or midnight is a window's end (see PERIOD_WORDS). Twelve beside a
  // named end ("between 12 and midnight") is told apart by the slot quote,
  // which must then say the two words together (see twelveNamed).
  if (twelveNamed(n, periodToks)) return periodToks[0] === 'noon' ? 12 : 0;
  const halves = new Set(periodToks.filter((t) => Object.hasOwn(PERIOD_WORDS, t)).map((t) => PERIOD_WORDS[t]));
  if (halves.size !== 1) return null;
  return (n % 12) + (halves.has('pm') ? 12 : 0);
}

// "Next Thursday" / "this coming Thursday" read as the weekday (both are
// bounded to this week or next below); "tonight", "this morning", "this
// afternoon" and "this evening" are the call's own day.
const TODAY_WORDS = /^\s*(?:tonight|this (?:morning|afternoon|evening))\s*$/i;
// "This Thursday" / "this coming Thursday" is the nearest one. "Next
// Thursday" is left to the grammar, which does not read it: it can mean
// either of two dates, so it grounds none.
const NEAREST_LEAD = /^\s*(?:this coming|this|coming)\s+/i;

function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The one date these stated components name, counting from the call's ET
// day: a stated year names its date; otherwise the NEXT date that fits —
// a month and day this year or next, a day of the month this month or
// next, a weekday its next occurrence (today included). Null when none.
function nearestDate(said, started) {
  const today = etDateString(started);
  const [ty, tm] = today.split('-').map(Number);
  if (said.year !== undefined) return isoDate(said.year, said.month, said.day);
  if (said.month !== undefined) {
    const thisYear = isoDate(ty, said.month, said.day);
    return thisYear >= today ? thisYear : isoDate(ty + 1, said.month, said.day);
  }
  if (said.day !== undefined) {
    // This month's if still ahead, else the first later month that has
    // that day ("the 30th" said on January 31 is March 30).
    for (let k = 0; k <= 12; k += 1) {
      const y = ty + Math.floor((tm - 1 + k) / 12);
      const candidate = isoDate(y, ((tm - 1 + k) % 12) + 1, said.day);
      if (candidate >= today && validCalendarDate(candidate)) return candidate;
    }
    return null;
  }
  if (said.weekday !== undefined) return etDateString(addETDays(started, (said.weekday - etParts(started).dayOfWeek + 7) % 7));
  return null;
}

// Do these words name `date` (YYYY-MM-DD)? The words must be exactly one
// date the shared reschedule date grammar reads
// (reschedule-date-evidence.js statedDateComponents), every component they
// state must be the date's, and the date must be the one they name — the
// next that fits (nearestDate), never a later one.
function namesDate(words, date, started) {
  const said = statedDateComponents(String(words).replace(TODAY_WORDS, 'today').replace(NEAREST_LEAD, ''), started);
  if (!said) return false;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return (said.weekday === undefined || said.weekday === weekday) && nearestDate(said, started) === date;
}

// Do the recorded slot words state exactly this slot? No day words only
// when the slot keeps `movedDate`.
function wordsStateSlot(words, slot, started, movedDate) {
  if (statedHour(words.hour, words.period) !== slot.hour24) return false;
  return words.day ? namesDate(words.day, slot.date, started) : slot.date === movedDate;
}

// The moved appointment's recorded words name its date, and a grounded
// moved-date quote holds them.
function movedAppointmentGrounded(scheduling, quotes, started) {
  const words = scheduling.moved_appointment_words;
  return typeof words === 'string' && namesDate(words, scheduling.moved_appointment_date, started)
    && quotes.some((q) => holds(q, words));
}

// Every quote the grounding uses is screened; a question fails a statement
// of agreement, but a caller naming the visit to move usually asks ("Can you
// move my September 24th visit?").
const ASKING_FAILS = new Set([
  '/scheduling/agent_committed_booking', '/scheduling/caller_accepted_slot', '/scheduling/confirmed_start_at',
]);
function isPlain(holding, quote, fieldPath) {
  return holding.length > 0 && holding.every((turn) => plainlySaid(turn, quote, ASKING_FAILS.has(fieldPath)));
}

// The recorded words the slot quote must hold. "12 noon" must be said as
// such, not read off "between 12 and noon".
function slotPhrases(words) {
  const said = [words.day, words.hour, words.period].filter((w) => typeof w === 'string');
  if (twelveNamed(hourNumber(words.hour), normalize(words.period).split(' '))) said.push(`${words.hour} ${words.period}`);
  return said;
}

/**
 * Pure function. See file header for contract.
 */
function groundRescheduleAgreement({ v2, transcript, callStartedAt } = {}) {
  const fail = (reason) => ({ ok: false, reason, movedDate: null });
  const scheduling = v2?.scheduling || {};
  if (scheduling.caller_accepted_slot !== true) return fail('caller_did_not_accept');
  if (scheduling.agent_committed_booking !== true) return fail('agent_did_not_commit');
  const wall = etWallClockOfConfirmedStart(scheduling.confirmed_start_at);
  const started = new Date(String(callStartedAt || ''));
  if (!wall || Number.isNaN(started.getTime())) return fail('unparseable_slot');
  const slot = { date: wall.slice(0, 10), hour24: Number(wall.slice(11, 13)) };
  const turns = parseTurns(transcript);
  // Unlabeled lines (turn order cannot be trusted), or only one speaker on it.
  if (!turns || new Set(turns.map((t) => t.agent)).size < 2) return fail('unparseable_transcript');

  // The quotes pinned to one field that appear word for word in a turn of
  // their stated speaker (and, when given, only that speaker's), plainly
  // said wherever they appear (isPlain).
  const grounded = (fieldPath, speaker = null) => (Array.isArray(v2.evidence) ? v2.evidence : [])
    .filter((e) => e?.field_path === fieldPath && typeof e.quote === 'string' && (!speaker || e.speaker === speaker)
      && isPlain(turnsHolding(turns, e.quote, e.speaker), e.quote, fieldPath))
    .map((e) => e.quote);
  if (!grounded('/scheduling/agent_committed_booking', 'agent').length) return fail('agent_commitment_ungrounded');
  if (!grounded('/scheduling/caller_accepted_slot', 'caller').length) return fail('caller_acceptance_ungrounded');
  const movedDate = typeof scheduling.moved_appointment_date === 'string' ? scheduling.moved_appointment_date : null;
  if (movedDate && !movedAppointmentGrounded(scheduling, grounded('/scheduling/moved_appointment_date'), started)) {
    return fail('moved_appointment_ungrounded');
  }
  const words = scheduling.agreed_slot_words;
  if (typeof words?.hour !== 'string') return fail('agreed_slot_words_missing');
  if (!wordsStateSlot(words, slot, started, movedDate)) return fail('agreed_slot_words_mismatch');
  const said = slotPhrases(words);
  if (!grounded('/scheduling/confirmed_start_at').some((q) => said.every((w) => holds(q, w)))) {
    return fail('agreed_slot_ungrounded');
  }
  return { ok: true, reason: 'agreement_grounded', movedDate };
}

module.exports = { groundRescheduleAgreement };
