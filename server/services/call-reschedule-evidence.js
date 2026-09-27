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
 * bookkeeping needed). A range reference ("two to four", "between eight and
 * nine") counts its START as the hour. The slot itself comes from
 * `confirmedStartAt` (V2's own field), so the transcript's resolved day+hour
 * and V2's structured value are two independent sources that must agree —
 * that agreement is structural here, not a second runtime diff.
 *
 * The first agent turn from the later of the two final references on must
 * affirm the slot: a commitment phrase, or a bare yes that states the slot
 * itself or is nothing but a short yes; the slot's own turn may be the
 * agent proposing it as a question, but any other agent question in between
 * changes the subject and fails closed. A hedge or
 * unsettled condition ("let me check", "if we have space") in the clauses
 * stating the slot or from the turn completing it onward fails closed, and so
 * does a refusal ("I cannot make it", "never mind") in those clauses or
 * anywhere after the slot's final mention — the SAME marker earlier in the
 * call, before the slot was settled, is fine. A time with minutes ("2:30",
 * "two ten") never grounds an on-the-hour slot. Day and hour references are
 * parsed by call-time-mentions.js.
 *
 * Contract: rescheduleAgreementEvidence({ transcript, confirmedStartAt,
 * callStartedAt }) -> { ok, reason, window: { fromTurn, toTurn } | null,
 * excerpt: string | null }
 */
'use strict';

const { etDateString } = require('../utils/datetime-et');
const { etWallClockOfConfirmedStart } = require('./call-triage-flags');
const {
  normalize, parseTurns, parseDayMentions, splitTurnSentences, wholeCallPeriodFlags, extractHourMentionsWholeCall,
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

// Words that start a new clause: "Friday doesn't work, BUT we'll see you
// Thursday at two" refuses Friday, not Thursday.
const CLAUSE_BREAKS = new Set(['but', 'so', 'however', 'although', 'though', 'instead']);

// The clause of a turn holding the token at turn-level position `pos`: its
// sentence, from the last clause break before `pos` to the sentence's end.
function clauseAt(turnRaw, pos) {
  let offset = 0;
  for (const sentence of splitTurnSentences(turnRaw)) {
    const toks = normalize(sentence).split(' ').filter(Boolean);
    if (pos < offset + toks.length) {
      let start = 0;
      for (let i = pos - offset - 1; i >= 0; i -= 1) {
        if (CLAUSE_BREAKS.has(toks[i])) { start = i + 1; break; }
      }
      return toks.slice(start).join(' ');
    }
    offset += toks.length;
  }
  return '';
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
  if (!turns || !turns.length) return { ok: false, reason: 'unparseable_transcript', window: null, excerpt: null };
  if (!turns.some((t) => t.agent) || !turns.some((t) => !t.agent)) {
    return { ok: false, reason: 'one_sided_transcript', window: null, excerpt: null };
  }

  // Period signal (am/pm/morning/afternoon) scoped to the WHOLE call.
  const flags = wholeCallPeriodFlags(turns.map((t) => t.raw));

  const dayRefs = [];
  const hourRefs = [];
  turns.forEach((t, idx) => {
    parseDayMentions(t.raw, slot.started).forEach((m) => dayRefs.push({ ...m, turnIdx: idx }));
    extractHourMentionsWholeCall(t.raw, flags).forEach((m) => hourRefs.push({ ...m, turnIdx: idx }));
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
  if (!lastDay.candidates.has(slot.date)) return { ok: false, reason: 'last_day_ref_mismatch', window: null, excerpt: null };
  if (lastHour.hour24 !== slot.hour24 || lastHour.offHour) return { ok: false, reason: 'last_hour_ref_mismatch', window: null, excerpt: null };

  // V2's confirmed_start_at and the transcript-resolved day+hour are checked
  // against the SAME `slot` object derived from confirmed_start_at, so
  // agreement between the two sources is structural here, not a separate
  // runtime comparison — there is no second, independently-derived slot to
  // diff against.
  const anchorIdx = Math.max(lastDay.turnIdx, lastHour.turnIdx);
  const failAt = (reason, toTurn = anchorIdx) => ({ ok: false, reason, window: { fromTurn: anchorIdx, toTurn }, excerpt: excerptOf(turns, anchorIdx, toTurn, 2) });

  // A hedge or unsettled condition in the clauses stating the slot ("if we
  // have space, Thursday at two"), or anywhere from the turn completing it
  // onward, however politely acknowledged, means the slot was not agreed. The
  // same marker earlier in the call, before the slot was settled, is fine.
  const hedgeText = [
    clauseAt(turns[lastDay.turnIdx].raw, lastDay.pos),
    clauseAt(turns[lastHour.turnIdx].raw, lastHour.end - 1),
    ...turns.slice(anchorIdx).map((t) => t.ns),
  ];
  if (hedgeText.some(hasHedgeMarker)) return failAt('hedge_on_slot');

  // A refusal in the clause that states the slot ("I cannot make it Thursday
  // at two", "Thursday at two won't work") or anywhere after its final
  // mention, however politely acknowledged ("okay"), means the slot was not
  // agreed. A refusal in an earlier clause turns down another option
  // ("Friday doesn't work, but we'll see you Thursday at two").
  const cut = Math.max(lastDay.turnIdx === anchorIdx ? lastDay.end : 0, lastHour.turnIdx === anchorIdx ? lastHour.end : 0);
  const slotText = [
    clauseAt(turns[lastDay.turnIdx].raw, lastDay.pos),
    clauseAt(turns[lastHour.turnIdx].raw, lastHour.end - 1),
    turns[anchorIdx].ns.split(' ').slice(cut).join(' '),
    ...turns.slice(anchorIdx + 1).map((t) => t.ns),
  ];
  if (slotText.some(hasRefusalMarker)) return failAt('slot_refused');

  // The FIRST agent turn from the slot on must affirm it. The slot's own turn
  // may be the agent proposing it as a question ("so you want two to
  // four?"), but any other agent question in between changes the subject
  // ("would you like text reminders?"), and an agent statement that does not
  // affirm does not settle it: either way the slot was not agreed.
  const asks = (turn) => /\?\s*$/.test(turn.raw.trim());
  let affirmIdx = -1;
  for (let i = anchorIdx; i < turns.length; i += 1) {
    if (!turns[i].agent) continue;
    if (asks(turns[i]) && i === anchorIdx) continue;
    if (!asks(turns[i]) && affirmsSlot(turns[i], i === anchorIdx)) affirmIdx = i;
    break;
  }
  if (affirmIdx === -1) return failAt('no_affirming_agent_turn');

  return {
    ok: true,
    reason: 'agreement_established',
    window: { fromTurn: anchorIdx, toTurn: affirmIdx },
    excerpt: excerptOf(turns, anchorIdx, affirmIdx, 2),
  };
}

module.exports = { rescheduleAgreementEvidence };
