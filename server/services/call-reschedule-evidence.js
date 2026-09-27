/**
 * Reschedule-only agreement evidence — for the AUTOMATIC path of
 * call-reschedule-apply.js ONLY (never humanOverride, which keeps its own
 * staff-approved contract). It REPLACES both the V2 `agent_committed_booking`
 * flag and hasAgentCommittedEvidence's grounding as the reschedule commitment
 * gate: a read-only replay of 1,089 real calls showed the V2 flag
 * under-scores real agreements badly enough that the reschedule applier
 * never moved a single visit.
 *
 * Deliberately separate from, and does NOT modify, hasAgentCommittedEvidence
 * in call-triage-flags.js — that function stays byte-identical, since it
 * also grounds the NEW-booking path for unknown callers, a different,
 * already-hardened contract this module has no bearing on.
 *
 * Algorithm: read the WHOLE transcript (both speakers) for day and hour
 * references. Last-mention-wins: the LAST day reference anywhere in the call
 * must resolve to the target slot's calendar date, and the LAST hour
 * reference must equal its hour — a later, different mention of either
 * automatically fails closed on its own (no separate "later turn conflicts"
 * bookkeeping needed). The last day reference is read with the ones chained
 * right before it: a weekday beside a date only describes that date
 * ("October 8, Thursday" is October 8), and alternatives ("Monday or
 * Thursday") must each be the slot. A range reference ("two to four",
 * "between eight and nine") counts its START as the hour. The slot itself
 * comes from `confirmedStartAt` (V2's own field), so the transcript's
 * resolved day+hour and V2's structured value are two independent sources
 * that must agree — that agreement is structural here, not a second runtime
 * diff.
 *
 * The first agent turn from the later of the two final references on must
 * affirm the slot: a commitment phrase, or a bare yes that states the slot
 * itself or is nothing but a short yes. An agent turn that asks the caller
 * anything but a closing question ("anything else?") is not an affirmation:
 * on the slot's own turn it is the agent putting the slot to the caller, and
 * the next agent turn must then affirm; later, it changes the subject and
 * fails closed. A hedge or unsettled condition ("let me check", "if we have
 * space") in the clauses stating the slot or from the turn completing it
 * onward fails closed, and so does a refusal ("I cannot make it", "never
 * mind") in those clauses or anywhere after the slot's final mention — the
 * SAME marker earlier in the call, before the slot was settled, is fine. A
 * negation on the slot's own words ("okay, but not Thursday", "I can't do
 * Thursday at two"), after it in the turn completing it, or anywhere up to
 * the affirming turn (the caller's "no" to a proposal) fails closed too;
 * after the affirmation, "no, that's all" only closes the call. A time with
 * minutes ("2:30", "two ten") never grounds an on-the-hour slot. Day and
 * hour references are parsed by call-time-mentions.js.
 *
 * Contract: rescheduleAgreementEvidence({ transcript, confirmedStartAt,
 * callStartedAt }) -> { ok, reason, window: { fromTurn, toTurn } | null,
 * excerpt: string | null }
 */
'use strict';

const { etDateString } = require('../utils/datetime-et');
const { etWallClockOfConfirmedStart } = require('./call-triage-flags');
const {
  normalize, parseTurns, parseDayMentions, splitTurnSentences, sentenceSpans, extractHourMentions,
} = require('./call-time-mentions');

// Fail-closed hedge/unsettled markers, matched as padded substrings.
const HEDGE_MARKERS = [
  ' call you back ', ' call him back ', ' call her back ', ' call them back ',
  ' calling you back ',
  ' let me check ', ' i ll check ', ' i will check ', ' we ll check ', ' we will check ',
  ' i ll have to see ', ' i will have to see ', ' we ll have to see ', ' we will have to see ',
  ' have to see ',
  ' maybe ', ' might ',
  ' not sure ', ' tentative ', ' tentatively ',
  ' get back to you ', ' getting back to you ',
  ' get in touch ', ' getting in touch ',
  ' after you feel better ',
  ' text you ', ' i ll text you ', ' we ll text you ',
  ' confirm later ', ' confirm it later ',
  // Availability conditions ("if we have space, we'll see you Thursday at
  // two") make the slot conditional, not agreed. Weather caveats are not
  // listed: the visit is still agreed, rain only moves it later.
  ' if we have space ', ' if we have room ', ' if we have an opening ', ' if we have availability ',
  ' if there s space ', ' if there s room ', ' if there s an opening ',
  ' if there is space ', ' if there is room ', ' if there is an opening ',
  ' if we can fit ', ' if we can squeeze ', ' if i can fit ', ' if i can squeeze ',
  ' depending on the schedule ', ' if the schedule allows ',
  // Still looking, not yet agreed ("okay, let me see what I have").
  ' let me see ', ' let me look ', ' let me find ', ' let me pull ', ' i ll look ', ' i will look ',
  ' need to check ', ' need to look ', ' see what i have ', ' see what we have ',
  ' see if i have ', ' see if we have ', ' check the schedule ', ' look at the schedule ',
];

// An explicit refusal or withdrawal after the agreement ("that won't work",
// "never mind", "scratch that") undoes it. Checked only from the affirming
// phrase onward, so "Friday doesn't work, but we'll see you Thursday at two"
// (refusing another day first) still agrees.
const REFUSAL_MARKERS = [
  ' doesn t work ', ' does not work ', ' won t work ', ' will not work ', ' not going to work ',
  ' can t do that ', ' cannot do that ', ' can t make it ', ' cannot make it ', ' can t make that ',
  ' never mind ', ' nevermind ', ' forget it ', ' forget that ', ' scratch that ', ' cancel that ',
  ' actually no ', ' no wait ',
];

// The agent's non-interrogative affirming close. Ordinary short commitment
// closers ("got it", "done", "we'll mark it") sit alongside the more
// explicit ones — real misses on the dry-run replay showed both shapes.
// Commitment phrases: the agent taking the slot on ("we'll see you", "we'll
// switch it", "I'll put you down").
const COMMITMENT_MARKERS = [
  'i ll do that', 'i will do that', 'we ll do that', 'we will do that', 'we ll do it', 'let s do that', 'let s do it',
  'we ll see you', 'i ll see you', 'we will see you', 'i will see you',
  'we ll see him', 'we ll see her', 'we ll see them',
  'i ll put you down', 'we ll put you down', 'i will put you down', 'we will put you down',
  'i ll move you', 'we ll move you', 'i will move you', 'we will move you',
  'got you down', 'i ll get you down', 'we ll get you down',
  'sounds good', 'sounds great', 'sounds perfect',
  'we ll make it happen', 'i ll make it happen', 'we will make it happen',
  'we ll mark it', 'i ll mark it', 'we will mark it',
  'i ll change it', 'we ll change it', 'i will change it', 'we will change it',
  'i ll move it', 'we ll move it', 'i will move it', 'we will move it',
  'i ll switch it', 'we ll switch it', 'i will switch it', 'we will switch it',
];
// A bare yes. It confirms only when the agent states the slot in that same
// turn ("Okay, Thursday at two") or the turn is nothing but a short yes ("All
// right. Yep."): "Okay, we also have a mosquito special" confirms nothing.
const BARE_YES_MARKERS = [
  'okay', 'ok', 'alright', 'all right', 'perfect', 'great', 'awesome',
  'yep', 'yeah', 'yes', 'no problem', 'got it', 'done',
];
const SHORT_YES_MAX_TOKENS = 6;

function padded(s) { return ` ${s} `; }
function hasHedgeMarker(ns) {
  const p = padded(ns);
  return HEDGE_MARKERS.some((m) => p.includes(m));
}
function hasAnyMarker(ns, markers) {
  const p = padded(ns);
  return markers.some((m) => p.includes(padded(m)));
}
function affirmsSlot(turn, statesSlot) {
  if (hasAnyMarker(turn.ns, COMMITMENT_MARKERS)) return true;
  if (!hasAnyMarker(turn.ns, BARE_YES_MARKERS)) return false;
  return statesSlot || turn.ns.split(' ').length <= SHORT_YES_MAX_TOKENS;
}
function hasRefusalMarker(ns) {
  const p = padded(ns);
  return REFUSAL_MARKERS.some((m) => p.includes(m));
}

// A negation turns the slot down ("okay, but not Thursday", "I can't do
// Thursday at two", "no" to "would Thursday at two work?"), however politely
// the agent then acknowledges it. "t" is an n't contraction once normalized
// ("can't" reads "can t"). A bare "no" answers what came before it ("No, we
// will see you Thursday at two"), so before the slot it counts only right
// against it ("no Thursday openings"). Courtesy phrases refuse nothing.
const NEGATING_WORDS = new Set(['not', 'never', 'cannot', 't']);
const NO_WORDS = new Set(['no', 'nope', 'nah']);
const COURTESY_NEGATIONS = [
  'no problem', 'not a problem', 'no worries', 'no need', 'don t worry', 'don t forget',
  'don t need to be home', 'don t need to be there', 'don t have to be home', 'don t have to be there',
];
function withoutCourtesy(toks) {
  let p = padded(toks.join(' '));
  for (const phrase of COURTESY_NEGATIONS) {
    while (p.includes(padded(phrase))) p = p.replace(padded(phrase), ' ');
  }
  return p.split(' ').filter(Boolean);
}
function hasNegation(ns) {
  return withoutCourtesy(ns.split(' ')).some((tok) => NEGATING_WORDS.has(tok) || NO_WORDS.has(tok));
}
// Is a slot word ({ pos, end }, turn-level) negated in its clause: by any
// negation after the clause's last slot word, `slotEnd` ("Thursday at two
// isn't good"), by "no" right against it, or by "not"/"can't" before it that
// no commitment to the slot overrides ("not Friday, we will see you
// Thursday" commits after the "not"). A correction between the day and the
// hour ("Thursday at 11, no, make it noon") is before the hour, not after.
function negatesSlotWord(clause, word, slotEnd) {
  if (hasNegation(clause.toks.slice(slotEnd - clause.start).join(' '))) return true;
  const before = withoutCourtesy(clause.toks.slice(0, word.pos - clause.start));
  if (NO_WORDS.has(before[before.length - 1])) return true;
  const lastNegation = before.findLastIndex((tok) => NEGATING_WORDS.has(tok));
  return lastNegation >= 0 && !hasAnyMarker(before.slice(lastNegation + 1).join(' '), COMMITMENT_MARKERS);
}

// A question that asks nothing about the slot ("anything else?").
const CLOSING_QUESTIONS = ['anything else', 'something else', 'what else', 'any questions', 'any other questions', 'any other question'];
function isClosingQuestion(ns) {
  return CLOSING_QUESTIONS.some((q) => padded(ns).includes(padded(q)));
}

// Day references right before the last one, with nothing between but these,
// describe the same day ("October 8, Thursday", "Thursday the 8th") or offer
// alternatives ("Monday or Thursday").
const SAME_DAY_FILLER = new Set(['the', 'on']);
const ALTERNATIVE_JOINERS = new Set(['or', 'and']);

// Does the call's last day reference name the slot's date? It is read with
// the references chained right before it: a weekday beside a date only
// describes that date, so it must be the date's weekday ("October 8,
// Thursday" names October 8, never the nearest Thursday); alternatives must
// each be the slot, since the call never settled between them.
function lastDayNamesSlot(dayRefs, turns, slotDate) {
  const chain = [dayRefs[dayRefs.length - 1]];
  let alternatives = false;
  for (let k = dayRefs.length - 2; k >= 0 && dayRefs[k].turnIdx === chain[0].turnIdx; k -= 1) {
    const between = turns[chain[0].turnIdx].ns.split(' ').slice(dayRefs[k].end, chain[0].pos);
    if (!between.every((t) => SAME_DAY_FILLER.has(t) || ALTERNATIVE_JOINERS.has(t))) break;
    alternatives = alternatives || between.some((t) => ALTERNATIVE_JOINERS.has(t));
    chain.unshift(dayRefs[k]);
  }
  const pinned = !alternatives && chain.some((m) => m.weekday == null);
  const slotWeekday = new Date(`${slotDate}T12:00:00Z`).getUTCDay();
  return chain.every((m) => (pinned && m.weekday != null ? m.weekday === slotWeekday : m.candidates.has(slotDate)));
}

// Words that start a new clause: "Friday doesn't work, BUT we'll see you
// Thursday at two" refuses Friday, not Thursday.
const CLAUSE_BREAKS = new Set(['but', 'so', 'however', 'although', 'though', 'instead']);

// The clause of a turn holding the token at turn-level position `pos`: its
// sentence's tokens from the last clause break before `pos` to the
// sentence's end, and the turn-level position of the first of them.
function clauseAt(turnRaw, pos) {
  let offset = 0;
  for (const sentence of splitTurnSentences(turnRaw)) {
    const toks = normalize(sentence).split(' ').filter(Boolean);
    if (pos < offset + toks.length) {
      let start = 0;
      for (let i = pos - offset - 1; i >= 0; i -= 1) {
        if (CLAUSE_BREAKS.has(toks[i])) { start = i + 1; break; }
      }
      return { toks: toks.slice(start), start: offset + start };
    }
    offset += toks.length;
  }
  return { toks: [], start: pos };
}

// Slot facts, ET-calendar based. No day-count cap on the slot itself: the
// cap belongs on each MENTION KIND — a relative word (weekday, tomorrow,
// today) only ever names a date ~0-14 days out, while a month and day is
// exact at any distance. A slot before the call's own day is refused.
function slotFacts(confirmedStartAt, callStartedAt) {
  const wall = etWallClockOfConfirmedStart(confirmedStartAt);
  const started = new Date(String(callStartedAt || ''));
  if (!wall || Number.isNaN(started.getTime())) return null;
  const date = wall.slice(0, 10);
  if (date < etDateString(started)) return null;
  return { date, hour24: Number(wall.slice(11, 13)), started };
}

function excerptOf(turns, fromTurn, toTurn, extra = 0) {
  const end = Math.min(turns.length - 1, toTurn + extra);
  return turns.slice(fromTurn, end + 1)
    .map((t) => `${t.agent ? 'Agent' : 'Caller'}: ${t.raw}`)
    .join('\n');
}

/**
 * Pure function. See file header for contract.
 */
function rescheduleAgreementEvidence({ transcript, confirmedStartAt, callStartedAt } = {}) {
  const slot = slotFacts(confirmedStartAt, callStartedAt);
  if (!slot) return { ok: false, reason: 'unparseable_or_out_of_range_slot', window: null, excerpt: null };
  const turns = parseTurns(transcript);
  if (!turns) return { ok: false, reason: 'unparseable_transcript', window: null, excerpt: null };
  // Both speakers must be on it: an agreement takes two sides.
  if (new Set(turns.map((t) => t.agent)).size < 2) return { ok: false, reason: 'one_sided_transcript', window: null, excerpt: null };

  const dayRefs = [];
  const hourRefs = [];
  turns.forEach((t, idx) => {
    parseDayMentions(t.raw, slot.started).forEach((m) => dayRefs.push({ ...m, turnIdx: idx }));
    extractHourMentions(t.raw).forEach((m) => hourRefs.push({ ...m, turnIdx: idx }));
  });
  if (!dayRefs.length) return { ok: false, reason: 'no_day_ref_in_call', window: null, excerpt: null };
  if (!hourRefs.length) return { ok: false, reason: 'no_hour_ref_in_call', window: null, excerpt: null };

  // Last-mention-wins: the LAST day ref and LAST hour ref anywhere in the
  // call must each resolve to the slot. A later, different mention of
  // either automatically becomes the new "last" and fails this check on its
  // own — that IS the "a later, different day or hour fails closed" rule,
  // with no extra bookkeeping needed.
  const lastDay = dayRefs[dayRefs.length - 1];
  const lastHour = hourRefs[hourRefs.length - 1];
  if (!lastDayNamesSlot(dayRefs, turns, slot.date)) return { ok: false, reason: 'last_day_ref_mismatch', window: null, excerpt: null };
  if (lastHour.hour24 !== slot.hour24 || lastHour.offHour) return { ok: false, reason: 'last_hour_ref_mismatch', window: null, excerpt: null };

  // V2's confirmed_start_at and the transcript-resolved day+hour are checked
  // against the SAME `slot` object derived from confirmed_start_at, so
  // agreement between the two sources is structural here, not a separate
  // runtime comparison — there is no second, independently-derived slot to
  // diff against.
  const anchorIdx = Math.max(lastDay.turnIdx, lastHour.turnIdx);
  const failAt = (reason, toTurn = anchorIdx) => ({ ok: false, reason, window: { fromTurn: anchorIdx, toTurn }, excerpt: excerptOf(turns, anchorIdx, toTurn, 2) });
  // The slot's day and hour words (an on-the-hour mention is one token,
  // ending at `end`), the clauses stating them, and the rest of the turn
  // completing the slot.
  const dayWord = { turnIdx: lastDay.turnIdx, pos: lastDay.pos, end: lastDay.end };
  const hourWord = { turnIdx: lastHour.turnIdx, pos: lastHour.end - 1, end: lastHour.end };
  const dayClause = clauseAt(turns[dayWord.turnIdx].raw, dayWord.pos);
  const hourClause = clauseAt(turns[hourWord.turnIdx].raw, hourWord.pos);
  const slotEndIn = (clause, word, other) => (other.turnIdx === word.turnIdx && other.pos >= clause.start
    && other.pos < clause.start + clause.toks.length ? Math.max(word.end, other.end) : word.end);
  const cut = Math.max(...[dayWord, hourWord].filter((w) => w.turnIdx === anchorIdx).map((w) => w.end));
  const slotClauses = [dayClause.toks.join(' '), hourClause.toks.join(' '), turns[anchorIdx].ns.split(' ').slice(cut).join(' ')];

  // A hedge or unsettled condition in the clauses stating the slot ("if we
  // have space, Thursday at two"), or anywhere from the turn completing it
  // onward, however politely acknowledged, means the slot was not agreed. The
  // same marker earlier in the call, before the slot was settled, is fine.
  if ([...slotClauses.slice(0, 2), ...turns.slice(anchorIdx).map((t) => t.ns)].some(hasHedgeMarker)) return failAt('hedge_on_slot');

  // A refusal in the clause that states the slot ("I cannot make it Thursday
  // at two", "Thursday at two won't work") or anywhere after its final
  // mention, however politely acknowledged ("okay"), means the slot was not
  // agreed. A refusal in an earlier clause turns down another option
  // ("Friday doesn't work, but we'll see you Thursday at two").
  if ([...slotClauses, ...turns.slice(anchorIdx + 1).map((t) => t.ns)].some(hasRefusalMarker)) return failAt('slot_refused');

  // Does an agent turn put a question to the caller: the slot stated as one
  // ("would Thursday at two work? Please let me know"), or any question but
  // a closing one ("Thursday at two. Does that work for you?")?
  const asksCaller = (idx) => sentenceSpans(turns[idx].raw).some((sentence) => sentence.question
    && (!isClosingQuestion(sentence.ns) || [lastDay.turnIdx === idx ? lastDay.pos : -1, lastHour.turnIdx === idx ? lastHour.end - 1 : -1]
      .some((pos) => pos >= sentence.start && pos < sentence.end)));

  // The FIRST agent turn from the slot on must affirm it. The slot's own turn
  // may be the agent putting it to the caller ("so you want two to four?"),
  // and the next agent turn then decides; any later agent question changes
  // the subject ("would you like text reminders?"), and an agent statement
  // that does not affirm does not settle it: either way the slot was not
  // agreed.
  const agentTurnFrom = (from) => turns.findIndex((t, i) => i >= from && t.agent);
  let affirmIdx = agentTurnFrom(anchorIdx);
  if (affirmIdx === anchorIdx && asksCaller(affirmIdx)) affirmIdx = agentTurnFrom(anchorIdx + 1);
  if (affirmIdx === -1 || asksCaller(affirmIdx) || !affirmsSlot(turns[affirmIdx], affirmIdx === anchorIdx)) return failAt('no_affirming_agent_turn');

  // A negation on the slot's own words, after it in the turn completing it,
  // or anywhere up to the affirming turn (the caller's "no" to the proposal,
  // the agent's "okay, I don't have that") turned it down. After the
  // affirmation only the explicit refusals above count: "no, that's all"
  // closes the call.
  if (negatesSlotWord(dayClause, dayWord, slotEndIn(dayClause, dayWord, hourWord))
    || negatesSlotWord(hourClause, hourWord, slotEndIn(hourClause, hourWord, dayWord))
    || [slotClauses[2], ...turns.slice(anchorIdx + 1, affirmIdx + 1).map((t) => t.ns)].some(hasNegation)) {
    return failAt('slot_refused', affirmIdx);
  }

  return {
    ok: true,
    reason: 'agreement_established',
    window: { fromTurn: anchorIdx, toTurn: affirmIdx },
    excerpt: excerptOf(turns, anchorIdx, affirmIdx, 2),
  };
}

module.exports = { rescheduleAgreementEvidence };
