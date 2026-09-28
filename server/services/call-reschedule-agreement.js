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
 *     speaker, in sentences free of negation, hedges and open conditions
 *     (the booking check's own screens, call-triage-flags.js — a quote cut
 *     from "We will not see you Thursday" does not ground); the agent's
 *     sentence is not a question ("Will we see you Thursday at two?"), while
 *     the caller may ask for the exact slot ("Can you do Thursday at two?");
 *   - an agreed-slot quote (/scheduling/confirmed_start_at) appears word for
 *     word in one turn and contains every recorded slot word; the hour word
 *     is one hour ("two", "2", "noon") and is the slot's; the period words
 *     state the slot's AM/PM — or, when none were said (owner decision
 *     2026-09-28), the hour reads as business hours (7-11 morning, 12 and
 *     1-6 afternoon) and the quote must say no period at all; the day
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
// The whole phrases that state a half of the day, and the half each states.
// Closed: period words that are anything else ("pm-ish", "pm or so") state
// none. A window ending at noon starts in the morning ("between 10 and
// noon"), and one ending at midnight starts in the evening.
const PERIOD_PHRASES = {
  am: 'am', morning: 'am', 'in the morning': 'am', 'this morning': 'am',
  pm: 'pm', afternoon: 'pm', 'in the afternoon': 'pm', 'this afternoon': 'pm',
  evening: 'pm', 'in the evening': 'pm', 'this evening': 'pm', tonight: 'pm', 'at night': 'pm',
  noon: 'am', midnight: 'pm',
};
// The 24-hour range a part of the day covers; an hour outside it is not
// what the words state ("two at night" is not 14:00, and not reliably 02:00).
const PART_OF_DAY_HOURS = {
  morning: [5, 11], afternoon: [12, 17], evening: [17, 23], tonight: [17, 23], night: [17, 23],
};
function withinPartOfDay(phrase, hour24) {
  const part = phrase.split(' ').pop();
  if (!Object.hasOwn(PART_OF_DAY_HOURS, part)) return true;
  const [from, to] = PART_OF_DAY_HOURS[part];
  return hour24 >= from && hour24 <= to;
}

function padded(s) { return ` ${s} `; }
function stringOrNull(v) { return typeof v === 'string' ? v : null; }

// Lowercase words, punctuation dropped, with "a.m." / "p.m." kept as one
// word ("am") so a quote matches its turn however either was punctuated
// and the period words read the same whichever way they were written.
// The dot after "p.m." also ends the sentence when a new sentence follows
// ("two p.m. Do not forget the gate code."): it is kept then, unless the
// next word is a weekday or month that the time runs into ("10 a.m.
// Thursday").
const RUNS_INTO = /^(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
function joinMeridiem(s) {
  return String(s || '')
    .replace(/\b([ap])\.\s?m\b(\.?)(?=(\s+)(\S+)|)/gi, (_m, ap, dot, _gap, next) => {
      const endsSentence = dot && /^[A-Z]/.test(next || '') && !RUNS_INTO.test(next);
      return `${ap}m${endsSentence ? '.' : ''}`;
    })
    .replace(/(\d)([ap]m)\b/gi, '$1 $2');
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
// worries." earlier in the turn does not void a real commitment — and, for
// the agent's commitment and the slot, must not be a question.
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

function businessHour(n) {
  if (n >= 7 && n <= 11) return n;
  if (n === 12) return 12;
  return n >= 1 && n <= 6 ? n + 12 : null;
}

function statedHour(hourWords, periodWords) {
  const toks = normalize(hourWords).split(' ');
  if (toks.length !== 1) return null;
  const [tok] = toks;
  if (tok === 'noon') return 12;
  if (tok === 'midnight') return 0;
  const n = /^\d{1,2}$/.test(tok) ? Number(tok) : HOUR_WORDS[tok];
  if (!(n >= 1 && n <= 12)) return null;
  // No period said (owner decision 2026-09-28, reschedules): business
  // hours — 7-11 the morning, 12 and 1-6 the afternoon; other hours state
  // nothing. The slot quote must then say no period at all (statesSlotWords).
  if (typeof periodWords !== 'string') return businessHour(n);
  const periodToks = normalize(periodWords).split(' ');
  // "12 noon" / "12 midnight" name the hour itself; for any other hour noon
  // or midnight is a window's end (see PERIOD_PHRASES). Twelve beside a
  // named end ("between 12 and midnight") is told apart by the slot quote,
  // which must then say the two words together (see twelveNamed).
  if (twelveNamed(n, periodToks)) return periodToks[0] === 'noon' ? 12 : 0;
  const phrase = periodToks.join(' ');
  if (!Object.hasOwn(PERIOD_PHRASES, phrase)) return null;
  // Twelve with a part of the day ("12 tonight", "12 in the morning") says
  // noon or midnight only loosely: it states an hour only with am/pm.
  if (n === 12 && phrase !== 'am' && phrase !== 'pm') return null;
  const hour24 = (n % 12) + (PERIOD_PHRASES[phrase] === 'pm' ? 12 : 0);
  return withinPartOfDay(phrase, hour24) ? hour24 : null;
}

// "Next Thursday" / "this coming Thursday" read as the weekday (both are
// bounded to this week or next below); "tonight", "this morning", "this
// afternoon" and "this evening" are the call's own day.
// Matched on the normalized words, so "tonight." reads as "tonight".
const TODAY_WORDS = /^(?:tonight|this (?:morning|afternoon|evening))$/;
// "This Thursday" / "this coming Thursday" is the nearest one. "Next
// Thursday" is left to the grammar, which does not read it: it can mean
// either of two dates, so it grounds none.
const DAY_AFTER_TOMORROW = /^(?:the )?day after tomorrow$/;
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
    // This year's if still ahead, else the first later year that has it
    // ("February 29" waits for a leap year).
    for (let k = 0; k <= 8; k += 1) {
      const candidate = isoDate(ty + k, said.month, said.day);
      if (candidate >= today && validCalendarDate(candidate)) return candidate;
    }
    return null;
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
  if (DAY_AFTER_TOMORROW.test(normalize(words))) return etDateString(addETDays(started, 2)) === date;
  const said = statedDateComponents(TODAY_WORDS.test(normalize(words)) ? 'today' : String(words).replace(NEAREST_LEAD, ''), started);
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

// Every quote the grounding uses is screened; a question fails the agent's
// commitment and the slot it states. A caller may ask: a request for exactly
// the slot the agent then commits to is acceptance under the extraction
// contract ("Can you do Thursday at two?"), and a caller naming the visit to
// move usually asks ("Can you move my September 24th visit?").
const ASKING_FAILS = new Set(['/scheduling/agent_committed_booking', '/scheduling/confirmed_start_at']);
function isPlain(holding, quote, fieldPath) {
  return holding.length > 0 && holding.every((turn) => plainlySaid(turn, quote, ASKING_FAILS.has(fieldPath)));
}

// Is a number a clock hour or a named one? A clock's ":00" minutes ("2:00
// PM" normalizes to "2 00 pm") are not another hour.
function isHourToken(t) {
  return (/^\d+$/.test(t) && !/^0+$/.test(t)) || Object.hasOwn(HOUR_WORDS, t) || t === 'noon' || t === 'midnight';
}

// Words that, right after an hour, are its minutes ("two thirty", "2 15",
// "two oh five"), and words that, right before it, count minutes to or past
// it ("quarter past two", "ten to two", "half past", "twenty of two").
const MINUTE_WORDS = new Set([
  'oh', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty', 'quarter', 'half',
]);
const MINUTES_BEFORE = new Set(['past', 'after', 'to', 'til', 'till', 'of', 'before']);

// Does the hour in this quote carry minutes, on either side? Appointment
// starts are on the hour, so such a quote never states the slot.
function hourHasMinutes(toks, [ha, hb]) {
  const next = toks[hb] || '';
  return (/^\d+$/.test(next) && !/^0+$/.test(next)) || MINUTE_WORDS.has(next) || Object.hasOwn(HOUR_WORDS, next)
    || isMinuteCount(toks[ha - 1]) // "half two", "quarter two", "October 2, 2 PM" all fail closed
    || (MINUTES_BEFORE.has(toks[ha - 1]) && isMinuteCount(toks[ha - 2]));
}

// A minute count said before "to"/"past": "ten", "quarter", "15", "minutes"
// ("ten minutes to two"). "Move it to two" has none, so its "to" is not one.
function isMinuteCount(t) {
  return Boolean(t) && (/^\d+$/.test(t) || MINUTE_WORDS.has(t) || Object.hasOwn(HOUR_WORDS, t) || t === 'minutes');
}

// Every token span where `words` sits in `toks`.
function spans(toks, words) {
  const w = normalize(words).split(' ');
  const out = [];
  for (let i = 0; i + w.length <= toks.length; i += 1) if (w.every((x, k) => toks[i + k] === x)) out.push([i, i + w.length]);
  return out;
}

// Is the recorded hour said on the hour, and do the period words belong to
// it in this quote? Some
// occurrence of each must sit with no other hour between them, so the PM of
// "between 10 and 2 PM" is never lent to the 10. No period words: nothing
// to check.
function periodIsTheHours(quote, words) {
  const toks = normalize(quote).split(' ');
  const hours = spans(toks, words.hour);
  // Every place the hour is said must be on the hour ("two thirty" never
  // grounds "two").
  if (hours.some((span) => hourHasMinutes(toks, span))) return false;
  if (typeof words.period !== 'string') return true;
  return hours.some(([ha, hb]) => spans(toks, words.period).some(([pa, pb]) => {
    const between = pa >= hb ? toks.slice(hb, pa) : toks.slice(pb, ha);
    return !between.some(isHourToken);
  }));
}

// Does this slot quote hold every recorded word, with the period its hour's
// and the hour on the hour?
function statesSlotWords(quote, words, turns) {
  return slotPhrases(words).every((w) => holds(quote, w)) && periodIsTheHours(quote, words) && twelveSaidTogether(quote, words)
    // An hour read as business hours: the sentences the quote sits in must
    // state no half of the day and name no noon/midnight bound — "Thursday
    // at two" cut from "Thursday at two in the morning" never falls back.
    && (typeof words.period === 'string' || /^(?:noon|midnight)$/.test(normalize(words.hour))
      || !statesAnyPeriod(sentencesHolding(turns, quote)));
}

// The sentences, in every turn that holds this quote, that the quote
// touches, as one normalized text.
function sentencesHolding(turns, quote) {
  const nq = padded(normalize(quote));
  return turns.filter((t) => padded(t.ns).includes(nq))
    .flatMap((t) => sentencesAround(t, quote)).map((x) => x.ns).join(' ') || normalize(quote);
}

function statesAnyPeriod(quote) {
  return halvesSaid(quote).length > 0 || /\b(?:noon|midnight)\b/.test(normalize(quote));
}

// Does this agent commitment quote commit to the recorded slot? It must say
// the recorded hour, on the hour (periodIsTheHours's minute check), any day
// words the slot records (none at all for a same-day change), and no am/pm
// or part of the day but the slot's.
function commitsToSlot(quote, words, hour24, turns) {
  const withoutPeriod = { ...words, period: null };
  return holds(quote, words.hour) && periodIsTheHours(quote, withoutPeriod)
    && (typeof words.day === 'string' ? holds(quote, words.day) : !namesAnyDay(quote))
    // Read in the sentences it sits in: "at two" cut from "at two AM".
    && halvesSaid(sentencesHolding(turns, quote)).every((half) => half === (hour24 >= 12 ? 'pm' : 'am'));
}

// Does this quote name a day at all (a weekday, a month, today/tomorrow/
// tonight, or an ordinal)? A same-day change records no day words, so its
// commitment must name none ("see you Friday at two PM" is another day).
const DAY_WORDS = new Set([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sun', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'today', 'tonight', 'tomorrow',
]);
function namesAnyDay(quote) {
  return normalize(quote).split(' ').some((t) => DAY_WORDS.has(t) || /^\d{1,2}(?:st|nd|rd|th)$/.test(t));
}

// The halves of the day this quote's am/pm and part-of-day words state
// ("at two AM" -> am), so a commitment in the other half never counts.
const HALF_WORDS = { am: 'am', morning: 'am', pm: 'pm', afternoon: 'pm', evening: 'pm', tonight: 'pm', night: 'pm' };
// Every half of the day said, whatever it describes: "your morning
// appointment" may be the old visit or the new one, and the words cannot
// tell which, so an unstated hour beside it fails closed (Codex #5163 r1).
function halvesSaid(quote) {
  const toks = normalize(quote).split(' ');
  return toks.filter((t, i) => Object.hasOwn(HALF_WORDS, t) && (t !== 'am' || amIsMeridiem(toks[i - 1], toks[i - 2])))
    .map((t) => HALF_WORDS[t]);
}

// "Am" is also the verb ("I am moving you to two"): it is the morning only
// right after a number, "o'clock", a day or "in the" ("10 AM", "Thursday
// AM", "two in the a.m.").
function amIsMeridiem(prev, prev2) {
  return Boolean(prev) && (/^\d+$/.test(prev) || Object.hasOwn(HOUR_WORDS, prev) || prev === 'clock' || prev === 'oclock'
    || DAY_WORDS.has(prev) || (prev === 'the' && prev2 === 'in'));
}

// The recorded words the slot quote must hold.
function slotPhrases(words) {
  return [words.day, words.hour, words.period].filter((w) => typeof w === 'string');
}

// "12 noon" / "12:00 midnight" must be said together (see twelveNamed).
function twelveSaidTogether(quote, words) {
  if (!twelveNamed(hourNumber(words.hour), normalize(words.period).split(' '))) return true;
  return holds(quote, `${words.hour} ${words.period}`) || holds(quote, `${words.hour} 00 ${words.period}`);
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
  const commitments = grounded('/scheduling/agent_committed_booking', 'agent');
  if (!commitments.length) return fail('agent_commitment_ungrounded');
  if (!grounded('/scheduling/caller_accepted_slot', 'caller').length) return fail('caller_acceptance_ungrounded');
  const movedDate = stringOrNull(scheduling.moved_appointment_date);
  if (movedDate && !movedAppointmentGrounded(scheduling, grounded('/scheduling/moved_appointment_date'), started)) {
    return fail('moved_appointment_ungrounded');
  }
  const words = scheduling.agreed_slot_words;
  if (typeof words?.hour !== 'string') return fail('agreed_slot_words_missing');
  if (!wordsStateSlot(words, slot, started, movedDate)) return fail('agreed_slot_words_mismatch');
  if (!grounded('/scheduling/confirmed_start_at').some((q) => statesSlotWords(q, words, turns))) return fail('agreed_slot_ungrounded');
  // The agent committed to THIS slot: the commitment quote says its hour,
  // on the hour, and no day but the slot's.
  if (!commitments.some((q) => commitsToSlot(q, words, slot.hour24, turns))) return fail('agent_commitment_not_the_slot');
  return { ok: true, reason: 'agreement_grounded', movedDate };
}

module.exports = { groundRescheduleAgreement };
