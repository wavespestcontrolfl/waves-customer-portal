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
      .map((raw) => ({ ns: normalize(raw), question: /\?/.test(raw), leadingNo: /^\s*no\s*,/i.test(raw) })).filter((x) => x.ns);
    turns.push({ agent: m[1].toLowerCase() === 'agent', raw: m[2], ns: normalize(m[2]), sentences });
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
// A caller naming the visit to move usually says why they can't keep it
// ("we're not going to be home tomorrow", "I can't make the 24th"): those
// availability phrases are not a negation of the move. "Do not move my 24th
// visit" still is.
const AVAILABILITY_PHRASES = / (?:can t|cant|cannot|can not|won t|wont|will not|not going to|not gonna|am not|are not|re not|m not|not) (?:be )?(?:able to )?(?:be )?(?:home|there|around|available|in town|make it|make that|make the|make my|make our|do it|do that|do the|do my)(?= )/g;
// Strips an availability phrase only where it governs the moved visit: the
// moved date's own words follow it directly ("not going to be home
// tomorrow" for tomorrow's visit). "I'm not home tomorrow, but my
// appointment is Friday" keeps its negation for a Friday move.
function stripAvailability(text, movedWords) {
  const padded2 = ` ${text} `;
  const mw = normalize(movedWords);
  return padded2.replace(AVAILABILITY_PHRASES, (m, offset) => {
    // The moved date's words must come next (after at most "on"/"the"),
    // with no clause break between: "not home tomorrow, but Friday works"
    // never strips for a Friday move.
    const after = padded2.slice(offset + m.length).replace(/^ (?:on |the |on the )?/, ' ');
    return after.startsWith(` ${mw} `) ? ' ' : m;
  }).trim();
}

function plainlySaid(turn, quote, { askingFails = false, movedDate = false, movedWords = null, commitment = false, slot = false, evidenceWords = null } = {}) {
  const around = sentencesAround(turn, quote);
  // An agent's leading "No," answers the caller ("No, we'll just pop in for
  // noon"); it is not a refusal of what follows (commitment, or a slot quote
  // the agent said).
  const answersNo = commitment || (slot && turn.agent);
  // Only before an affirmative head ("No, we'll ..."), never "No, Thursday at
  // two is unavailable".
  const text = around.map((x) => (answersNo && x.leadingNo && /^no (?:we|i) (?:ll|will) /.test(x.ns) ? x.ns.replace(/^no /, '') : x.ns)).join(' ');
  const screened = movedDate && movedWords ? stripAvailability(text, movedWords) : text;
  return Boolean(text) && !turnHasNegationOrHedge(screened) && !hasQualifiedAgreement(screened, evidenceWords, quote)
    && !hasUnresolvedAgreementCondition(screened)
    && !(askingFails && around.some((x) => x.question));
}

// The shared booking hedge screen predates these ordinary promise
// qualifiers. Bind them to the scheduling clause: doubt about an unrelated
// balance in the same sentence does not weaken a later definite promise.
const COMMITMENT_QUALIFIER_RE = /\b(?:hopefully|perhaps|possibly|probably|tentatively)\b/;
const AGREEMENT_PREDICATE_RE = /\b(?:arrive|book|come|mark|move|put|return|schedule|see|visit|works?|sounds?|perfect)\b/;
const AGREEMENT_CLAUSE_BOUNDARY_RE = /\s+(?:and|but)\s+(?=(?:i|our|the|we|you|your)\b)/;
function agreementClauses(text, evidenceWords, evidenceQuote) {
  const clauses = normalize(text).split(AGREEMENT_CLAUSE_BOUNDARY_RE);
  const pinned = normalize(evidenceQuote);
  const holding = clauses.filter((clause) => padded(clause).includes(padded(pinned)));
  // Evidence ownership wins over incidental repetitions of more slot words
  // in another clause. The whole holding clause is still screened, so a
  // model cannot quote just the unqualified tail of a tentative promise.
  if (holding.length) return holding;
  const phrases = (typeof evidenceWords === 'string'
    ? [evidenceWords]
    : [evidenceWords?.day, evidenceWords?.hour, evidenceWords?.period])
    .filter((word) => typeof word === 'string' && normalize(word));
  const scores = clauses.map((clause) => phrases.filter((phrase) => padded(clause).includes(padded(normalize(phrase)))).length);
  const strongest = Math.max(0, ...scores);
  if (strongest > 0) return clauses.filter((_clause, index) => scores[index] === strongest);
  const owned = clauses.filter((clause) => AGREEMENT_PREDICATE_RE.test(clause));
  return owned.length ? owned : clauses;
}
function hasQualifiedAgreement(text, evidenceWords, evidenceQuote) {
  return agreementClauses(text, evidenceWords, evidenceQuote).some((clause) => COMMITMENT_QUALIFIER_RE.test(clause));
}

// Keep the shared fail-closed condition screen over the complete sentence so
// an opening condition still governs a later coordinated promise. Only mask
// "pending" when it is plainly the state of an unrelated account/balance
// noun; clause-leading "Pending approval" and scheduling conditions remain.
const UNRELATED_PENDING_STATUS_RE = /\b(?:account|balance|charge|invoice|payment|plan(?:\s+renewal)?|refund|renewal)\s+(?:is|are|was|were|remains?|stays?)\s+(?:(?:already|currently|just|possibly|probably|still)\s+){0,3}pending\b(?=\s+(?:and|but)\s+(?:i|our|the|we|you|your)\b|$)/g;
function hasUnresolvedAgreementCondition(text) {
  return turnHasUnresolvedConditional(normalize(text).replace(UNRELATED_PENDING_STATUS_RE, 'unresolved account status'));
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
  if (typeof periodWords !== 'string') return /^0/.test(tok) ? null : businessHour(n); // "02" is a 24-hour clock
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
function movedAppointmentGrounded(scheduling, quotes, turns, started) {
  const words = scheduling.moved_appointment_words;
  return typeof words === 'string' && namesDate(words, scheduling.moved_appointment_date, started)
    && quotes.some((q) => holds(q, words)
      && !movedAppointmentHasUnrecordedRelativeDate(sentencesHolding(turns, q), words));
}

// Every quote the grounding uses is screened; a question fails the agent's
// commitment and the slot it states. A caller may ask: a request for exactly
// the slot the agent then commits to is acceptance under the extraction
// contract ("Can you do Thursday at two?"), and a caller naming the visit to
// move usually asks ("Can you move my September 24th visit?").
const ASKING_FAILS = new Set(['/scheduling/agent_committed_booking', '/scheduling/confirmed_start_at']);
function isPlain(holding, quote, fieldPath, movedWords = null, evidenceWords = null) {
  const how = {
    movedWords,
    evidenceWords,
    askingFails: ASKING_FAILS.has(fieldPath),
    movedDate: fieldPath === '/scheduling/moved_appointment_date',
    commitment: fieldPath === '/scheduling/agent_committed_booking',
    slot: fieldPath === '/scheduling/confirmed_start_at',
  };
  return holding.length > 0 && holding.every((turn) => plainlySaid(turn, quote, how));
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
  // "two zero five", "two o five" (but "two o'clock" is on the hour).
  const zeroMinutes = next === 'zero' || (next === 'o' && toks[hb + 1] !== 'clock');
  return (/^\d+$/.test(next) && !/^0+$/.test(next)) || MINUTE_WORDS.has(next) || Object.hasOwn(HOUR_WORDS, next) || zeroMinutes
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
  const hours = hourSpans(toks, words);
  if (!hours.length) return false;
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
// The only shapes an hour with no period may be said in for the
// business-hours reading: led by "at"/"to"/"for"/"between" or a day
// ("Tuesday, 2 to 4"), and followed by nothing, "o'clock", a range end, or
// a day. "Around two", "by two", "two or four", "two-ish" never qualify.
const EXACT_LEADS = new Set(['at', 'to', 'for', 'between']);
const EXACT_TAILS = new Set(['o', 'oclock', 'on', 'then', 'this', 'next', 'please', 'sharp']);
// Judged over the whole turns that hold the quote, and EVERY place a turn
// says the hour must be exact: "at two" cut from "at two or four" fails.
function saidExactly(quote, words, turns) {
  const nq = padded(normalize(quote));
  const holding = turns.filter((t) => padded(t.ns).includes(nq));
  return holding.length > 0 && holding.every((t) => hourExactIn(t.raw, words, !t.agent));
}

// Days that may lead straight into an hour ("Tuesday, 2 to 4"). Never a
// month: the "2" of "March 2" is the date, not a time.
const HOUR_LEAD_DAYS = new Set([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sun', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'today', 'tonight', 'tomorrow',
]);
// Once the exact hour is said, the rest of the turn may only be courtesy
// from this closed list. Anything else — a correction ("actually three"),
// an alternative ("or four"), doubt ("I think", "approximately"), a length
// ("two to four hours") — sends the call to the office.
const AFTER_HOUR_WORDS = new Set([
  ',', ';', 'o', 'clock', 'oclock', 'on', 'then', 'this', 'please', 'sharp', 'and', 'so',
  'we', 'will', 'ill', 'll', 'see', 'you', 'guys', 'the', 'a', 'tech', 'technician', 'call', 'text', 'much',
  'thank', 'thanks', 'okay', 'ok', 'great', 'perfect', 'good', 'sounds', 'works', 'that', 'is', 'it', 'its', 's',
  'all', 'set', 'be', 'there', 'have', 'nice', 'day', 'bye', 'yes', 'yeah', 'yep', 'for', 'your', 'appointment', 'visit',
  'them', 'him', 'her', 'us', 'sure', 'alright', 'awesome', 'wonderful', 'then',
]);
// A caller may add "I'll let them know" after the hour; from the agent
// "I will let you know" / "let me know" is a follow-up offer, not a booking.
const CALLER_AFTER_HOUR_WORDS = new Set(['i', 'let', 'me', 'know']);

// Anywhere in a turn whose hour takes the business-hours reading: an
// alternative, correction or approximation ("at three or Thursday at two",
// "actually", "arrive around Thursday at two") sends the call to the office.
const ALTERNATIVE_WORDS = new Set([
  'or', 'either', 'actually', 'instead', 'rather',
  'around', 'about', 'approximately', 'roughly', 'ish', 'maybe', 'probably', 'sometime', 'somewhere',
]);

// Find recorded date phrases in the punctuation-preserving token stream.
// Commas inside a date ("Thursday, October 10") and the period in an
// abbreviated month ("Oct. 10") do not break the phrase; the returned
// indexes still refer to `toks`.
const ABBREVIATED_MONTHS = new Set(['jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
const ABBREVIATED_MONTH_PERIOD_RE = new RegExp(String.raw`\b(${[...ABBREVIATED_MONTHS].join('|')})\.(?=\s*\d)`, 'g');
function dateSpans(toks, day) {
  if (typeof day !== 'string') return [];
  const lexical = toks.flatMap((token, index) => {
    const monthPeriod = token === ';' && ABBREVIATED_MONTHS.has(toks[index - 1]) && /^\d{1,2}(?:st|nd|rd|th)?$/.test(toks[index + 1] || '');
    return token === ',' || monthPeriod ? [] : [{ token, index }];
  });
  return spans(lexical.map(({ token }) => token), day)
    .map(([start, end]) => [lexical[start].index, lexical[end - 1].index + 1]);
}

function hourSpans(toks, words) {
  const dates = dateSpans(toks, words.day);
  // The recorded calendar phrase owns these numerals in both the exact-hour
  // and minute/period checks ("October 10 at 10", "10/10 at 10").
  return spans(toks, words.hour)
    .filter(([start, end]) => !dates.some(([dateStart, dateEnd]) => start >= dateStart && end <= dateEnd));
}

// Is the hour at this span said exactly: an exact lead, an exact tail, and
// only courtesy after it? Marks the tokens it explains (the hour, ":00", a
// range end) in `explained`.
// "9 o'clock" with no lead word only at a clause start or after a plain
// yes: never after a verb that bounds or rejects it ("by 9 o'clock",
// "avoid 9 o'clock", "anything but 9 o'clock").
const OCLOCK_OPENERS = new Set([',', 'okay', 'ok', 'yes', 'yeah', 'yep', 'sure', 'so', 'then', 'alright']);
function exactLead(toks, ha, next, hb) {
  const prev = toks[ha - 1];
  // "9 o'clock" needs no lead word, unless the word before bounds it.
  const oclock = (next === 'oclock' || (next === 'o' && toks[hb + 1] === 'clock')) && OCLOCK_OPENERS.has(prev ?? ',');
  return oclock || EXACT_LEADS.has(prev) || HOUR_LEAD_DAYS.has(prev) || (prev === ',' && HOUR_LEAD_DAYS.has(toks[ha - 2]));
}

function isRangeEnd(toks, prev, next, hb) {
  return (next === 'to' || next === 'through' || (next === 'and' && prev === 'between'))
    && (hourNumber(toks[hb + 1]) != null || /^(?:noon|midnight)$/.test(toks[hb + 1] || ''));
}

function isCourtesy(t, callerTurn) {
  return AFTER_HOUR_WORDS.has(t) || HOUR_LEAD_DAYS.has(t) || (callerTurn && CALLER_AFTER_HOUR_WORDS.has(t));
}

function exactHourAt(toks, [ha, end], dayIdx, explained, callerTurn) {
  const prev = toks[ha - 1];
  const hb = toks[end] === '00' ? end + 1 : end; // "2:00" is exact; what follows it decides
  const next = toks[hb];
  const lead = exactLead(toks, ha, next, hb);
  const rangeEnd = isRangeEnd(toks, prev, next, hb);
  const tail = next === undefined || EXACT_TAILS.has(next) || isCourtesy(next, callerTurn) || rangeEnd;
  const from = rangeEnd ? hb + 2 : hb;
  const clean = toks.slice(from).every((t, k) => isCourtesy(t, callerTurn) || dayIdx.has(from + k));
  for (let k = ha; k < hb; k += 1) explained.add(k);
  if (rangeEnd) explained.add(hb + 1);
  return lead && tail && clean && (prev !== 'between' || rangeEnd);
}

function hourExactIn(text, words, callerTurn = false) {
  // Tokens keeping clause punctuation, so "at two, a tech will call" ends
  // the hour at the comma.
  // The period of an abbreviated month ("Oct. 10") belongs to the date, not
  // to a clause boundary.
  const toks = joinMeridiem(text).toLowerCase().replace(ABBREVIATED_MONTH_PERIOD_RE, '$1 ')
    .replace(/[,.;!?]/g, ' , ').replace(/[^a-z0-9,]+/g, ' ').trim().split(/\s+/);
  if (toks.some((t) => ALTERNATIVE_WORDS.has(t))) return false;
  // Tokens of the recorded day words ("October 10") are the date, not an hour.
  // A day phrase describing an appointment ("your 10th appointment") is a
  // count, not the date, and gets no exemption.
  const dayIdx = new Set((typeof words.day === 'string' ? spans(toks, words.day) : [])
    .filter(([, b]) => !/^(?:appointment|appointments|visit|visits|treatment|service|time)$/.test(toks[b] || ''))
    .flatMap(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k)));
  const at = spans(toks, words.hour).filter(([a]) => !dayIdx.has(a));
  const explained = new Set(dayIdx);
  const exact = at.length > 0 && at.every((span) => exactHourAt(toks, span, dayIdx, explained, callerTurn));
  // No other number or hour word anywhere in the turn.
  return exact && toks.every((t, k) => explained.has(k) || !(/^\d+$/.test(t) || hourNumber(t) != null || t === 'noon' || t === 'midnight'));
}

// A relative qualifier attached to the appointment day has to be part of
// the recorded day words. Requiring the date itself inside the matched
// phrase keeps unrelated timing in the same sentence ("the plan renews a
// week from now, and we will see you Thursday") from invalidating the slot.
function regexpEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function phraseRanges(text, phrase) {
  const words = normalize(phrase);
  if (!words) return [];
  const re = new RegExp(String.raw`\b${regexpEscape(words).replace(/\s+/g, String.raw`\s+`)}\b`, 'g');
  return [...normalize(text).matchAll(re)].map((match) => [match.index, match.index + match[0].length]);
}
function rangeDistance([a, b], [c, d]) {
  if (b < c) return c - b;
  if (d < a) return a - d;
  return 0;
}
function hasUnrecordedRelativeDate(text, day, anchor, ownedAnchorRanges = null) {
  if (typeof day !== 'string') return false;
  const coreDay = normalize(day).replace(NEAREST_LEAD, '').replace(/^the\s+/, '');
  if (!coreDay) return false;
  const target = String.raw`(?:the\s+)?${regexpEscape(coreDay).replace(/\s+/g, String.raw`\s+`)}`;
  const count = String.raw`(?:[a-z]+|\d+)`;
  const units = String.raw`(?:full\s+)?(?:days?|weeks?)`;
  const relative = new RegExp(String.raw`\b(?:`
    + String.raw`(?:next|following)\s+(?:coming\s+)?${target}`
    + String.raw`|(?:next|following)\s+weeks?\s+(?:on\s+)?${target}`
    + String.raw`|${target}\s+(?:after|before)\s+(?:next|this(?:\s+one)?)`
    + String.raw`|${target}\s+(?:of\s+(?:the\s+)?)?(?:next|following)\s+weeks?`
    + String.raw`|${target}\s+(?:the\s+)?weeks?\s+(?:after|before)\s+next`
    + String.raw`|${target}\s+${count}\s+${units}\s+(?:from\s+(?:now|today)|later|hence)`
    + String.raw`|${target}\s+(?:in|within|after)\s+(?:${count}\s+){1,3}${units}`
    + String.raw`|${count}\s+${units}\s+from\s+${target}`
    + String.raw`|(?:in|within|after)\s+(?:${count}\s+){1,3}${units}\s+(?:on\s+)?${target}`
    + String.raw`)\b`, 'g');
  const normalized = normalize(text);
  const relativeRanges = [...normalized.matchAll(relative)].map((match) => [match.index, match.index + match[0].length]);
  if (!relativeRanges.length) return false;
  const dayRanges = phraseRanges(normalized, coreDay);
  const anchorRanges = ownedAnchorRanges || phraseRanges(normalized, anchor);
  if (!dayRanges.length || !anchorRanges.length) return true;
  const distance = (range) => Math.min(...anchorRanges.map((other) => rangeDistance(range, other)));
  const nearest = Math.min(...dayRanges.map(distance));
  const appointmentDays = dayRanges.filter((range) => distance(range) === nearest);
  return relativeRanges.some(([from, to]) => appointmentDays.some(([dayFrom, dayTo]) => dayFrom < to && dayTo > from));
}

// A moved-date quote can contain unrelated dates too. Anchor its recorded
// date to the nearest words that identify the appointment being moved,
// rather than to the quote's total range (which may cover both dates). The
// full holding sentence is still checked, so a fragment cannot omit a
// qualifier attached to the selected appointment.
const MOVE_ACTION_RE = /\b(?:mov(?:e|ed|ing)|reschedul(?:e|ed|ing)|chang(?:e|ed|ing)|shift(?:ed|ing)?)\b/g;
const APPOINTMENT_NOUN_RE = /\b(?:appointments?|bookings?|services?|visits?)\b/g;
function movedAppointmentHasUnrecordedRelativeDate(text, day) {
  const normalized = normalize(text);
  const ranges = (re) => [...normalized.matchAll(re)]
    .map((match) => [match.index, match.index + match[0].length]);
  // An explicit move action is the strongest owner. Fall back to the visit
  // noun for terse turns such as "my Thursday appointment, please."
  const actions = ranges(MOVE_ACTION_RE);
  const owners = actions.length ? actions : ranges(APPOINTMENT_NOUN_RE);
  return hasUnrecordedRelativeDate(normalized, day, day, owners.length ? owners : null);
}

function statesSlotWords(quote, words, turns, agreementQuotes = []) {
  return slotPhrases(words).every((w) => holds(quote, w)) && periodIsTheHours(quote, words) && twelveSaidTogether(quote, words)
    && !hasUnrecordedRelativeDate(sentencesHolding(turns, quote), words.day, words.hour)
    && (typeof words.period === 'string' || /^(?:noon|midnight)$/.test(normalize(words.hour)) || saidExactly(quote, words, turns))
    // An hour read as business hours: the sentences the quote sits in must
    // state no half of the day and name no noon/midnight bound — "Thursday
    // at two" cut from "Thursday at two in the morning" never falls back.
    && (typeof words.period === 'string' || /^(?:noon|midnight)$/.test(normalize(words.hour))
      || ![quote, ...agreementQuotes].some((q) => mayStatePeriod(sentencesHolding(turns, q))));
}

// The sentences, in every turn that holds this quote, that the quote
// touches, as one normalized text.
function sentencesHolding(turns, quote) {
  const nq = padded(normalize(quote));
  return turns.filter((t) => padded(t.ns).includes(nq))
    .flatMap((t) => sentencesAround(t, quote)).map((x) => x.ns).join(' ') || normalize(quote);
}

// Before an unstated hour is read as business hours, the sentences of the
// slot, commitment and acceptance quotes must carry NO sign of a half of the
// day in any form: am/pm (also spelled "a m", "p m", or away from the hour:
// "two sharp a.m."), a part of the day, noon or midnight. Only the verb "am"
// right after "I" ("I am", "I really am") is exempt. Broad on purpose: any
// doubt goes to the office.
const PERIOD_SIGNS = new Set(['pm', 'morning', 'afternoon', 'evening', 'tonight', 'night', 'noon', 'midnight']);
function mayStatePeriod(text) {
  const toks = normalize(text).split(' ');
  return toks.some((t, i) => PERIOD_SIGNS.has(t)
    || ((t === 'a' || t === 'p') && toks[i + 1] === 'm') // "a m" / "p m" spelled apart
    || (t === 'am' && !isVerbAm(toks, i)));
}

// Does this agent commitment quote commit to the recorded slot? It must say
// the recorded hour, on the hour (periodIsTheHours's minute check), any day
// words the slot records (none at all for a same-day change), and no am/pm
// or part of the day but the slot's.
function commitsToSlot(quote, words, hour24, turns) {
  const withoutPeriod = { ...words, period: null };
  const around = sentencesHolding(turns, quote);
  const unstatedHour = typeof words.period !== 'string' && !/^(?:noon|midnight)$/.test(normalize(words.hour));
  return holds(quote, words.hour) && periodIsTheHours(quote, withoutPeriod)
    && !hasUnrecordedRelativeDate(around, words.day, words.hour)
    // Offering alternatives is not committing ("No, we'll see you Thursday
    // at two or Friday at three"), and a trailing "right" asks ("see you
    // at 9, right."); "right now" mid-sentence does not.
    && !/ (?:or|either) /.test(padded(around)) && !/(?:^| )right$/.test(around)
    // The agent need not repeat the day when its sentence is plain
    // commitment ("Yep, we'll see them at 9", plainCommitment); otherwise it
    // must say the recorded day, and a same-day change's commitment names
    // none.
    && (typeof words.day === 'string' ? holds(around, words.day) || plainCommitment(around, words) : !namesAnyDay(around))
    // An hour read as business hours must be said exactly by the agent too
    // ("we should arrive around two" fails).
    && (!unstatedHour || saidExactly(quote, words, turns))
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
// A commitment that leaves the day to the caller's words may say nothing
// but these (plus the hour and its period words): "Yep, we'll see them at
// 9". Anything else ("in two days", "May 3", "9/25", a weekday) and it must
// say the recorded day itself.
const PLAIN_COMMIT_WORDS = new Set([
  'we', 'll', 'will', 'i', 'ill', 'see', 'you', 'them', 'him', 'her', 'guys', 'at', 'to', 'for', 'be', 'there', 'come',
  'out', 'pop', 'in', 'put', 'down', 'switch', 'it', 'move', 'moved', 'make', 'mark', 'get', 'have', 'the', 'a',
  'tech', 'technician', 'okay', 'ok', 'yep', 'yes', 'yeah', 'sure', 'sounds', 'good', 'great', 'perfect', 'then',
  'so', 'and', 'all', 'set', 've', 'got', 'your', 'appointment', 'visit', 'just', 's', 'over',
  'o', 'clock', 'oclock', '00', 'thank', 'thanks', 'awesome', 'alright',
]);
function plainCommitment(text, words) {
  const allowed = new Set([...normalize(words.hour).split(' '), ...normalize(words.period || '').split(' ').filter(Boolean)]);
  return normalize(text).split(' ').every((t) => PLAIN_COMMIT_WORDS.has(t) || allowed.has(t));
}

// Words that say a day relatively ("in two days", "the day after", "next
// week"): a commitment using them names a day too.
const RELATIVE_DAY_WORDS = new Set(['days', 'week', 'weeks', 'weekend', 'next', 'following', 'yesterday']);
function namesAnyDay(quote) {
  const toks = normalize(quote).split(' ');
  return toks.some((t, i) => DAY_WORDS.has(t) || RELATIVE_DAY_WORDS.has(t) || /^\d{1,2}(?:st|nd|rd|th)$/.test(t)
    // "May 3" (the month, not the verb), and a written date "9/24".
    || (t === 'may' && /^\d/.test(toks[i + 1] || ''))
    // "the day after", "a day later" (a bare "day" in "have a nice day" is not)
    || (t === 'day' && /^(?:after|later|before)$/.test(toks[i + 1] || ''))
    || (/^\d{1,2}$/.test(t) && /^\d{1,2}$/.test(toks[i + 1] || '') && toks[i + 1] !== '00'));
}

// The halves of the day this quote's am/pm and part-of-day words state
// ("at two AM" -> am), so a commitment in the other half never counts.
const HALF_WORDS = { am: 'am', morning: 'am', pm: 'pm', afternoon: 'pm', evening: 'pm', tonight: 'pm', night: 'pm' };
// Every half of the day said, whatever it describes: "your morning
// appointment" may be the old visit or the new one, and the words cannot
// tell which (Codex #5163 r1). "a m" / "p m" spelled apart count, and "am"
// anywhere counts unless it is the verb right after "I" ("I am", "I really
// am") — the same reading as mayStatePeriod.
function halvesSaid(quote) {
  const toks = normalize(quote).split(' ');
  return toks.flatMap((t, i) => {
    if ((t === 'a' || t === 'p') && toks[i + 1] === 'm') return [t === 'a' ? 'am' : 'pm'];
    if (t === 'am') return isVerbAm(toks, i) ? [] : ['am'];
    return Object.hasOwn(HALF_WORDS, t) ? [HALF_WORDS[t]] : [];
  });
}

// Only "I am" and "I <adverb> am" are the verb; "I mean AM", "I said AM",
// "I prefer AM" state the morning.
const AM_ADVERBS = new Set(['really', 'also', 'just', 'still', 'actually', 'now', 'definitely', 'certainly']);
function isVerbAm(toks, i) {
  return toks[i - 1] === 'i' || (AM_ADVERBS.has(toks[i - 1]) && toks[i - 2] === 'i');
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
      && isPlain(turnsHolding(turns, e.quote, e.speaker), e.quote, fieldPath, stringOrNull(scheduling.moved_appointment_words),
        fieldPath === '/scheduling/moved_appointment_date' ? scheduling.moved_appointment_words : scheduling.agreed_slot_words))
    .map((e) => e.quote);
  const commitments = grounded('/scheduling/agent_committed_booking', 'agent');
  if (!commitments.length) return fail('agent_commitment_ungrounded');
  if (!grounded('/scheduling/caller_accepted_slot', 'caller').length) return fail('caller_acceptance_ungrounded');
  const movedDate = stringOrNull(scheduling.moved_appointment_date);
  if (movedDate && !movedAppointmentGrounded(scheduling, grounded('/scheduling/moved_appointment_date'), turns, started)) {
    return fail('moved_appointment_ungrounded');
  }
  const words = scheduling.agreed_slot_words;
  if (typeof words?.hour !== 'string') return fail('agreed_slot_words_missing');
  if (!wordsStateSlot(words, slot, started, movedDate)) return fail('agreed_slot_words_mismatch');
  const agreementQuotes = [...commitments, ...grounded('/scheduling/caller_accepted_slot', 'caller')];
  if (!grounded('/scheduling/confirmed_start_at').some((q) => statesSlotWords(q, words, turns, agreementQuotes))) return fail('agreed_slot_ungrounded');
  // The agent committed to THIS slot: the commitment quote says its hour,
  // on the hour, and no day but the slot's.
  if (!commitments.some((q) => commitsToSlot(q, words, slot.hour24, turns))) return fail('agent_commitment_not_the_slot');
  return { ok: true, reason: 'agreement_grounded', movedDate };
}

module.exports = { groundRescheduleAgreement };
