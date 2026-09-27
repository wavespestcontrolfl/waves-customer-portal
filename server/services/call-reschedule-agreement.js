/**
 * Reschedule agreement grounding — the AUTOMATIC path of
 * call-reschedule-apply.js only (never humanOverride, which keeps its own
 * staff-approved contract).
 *
 * Owner decision 2026-09-27: the V2 call extraction judges whether the caller
 * agreed to the reschedule and which existing appointment it moves (schema
 * 1.16.0: scheduling.caller_accepted_slot, judged over the whole call, and
 * scheduling.moved_appointment_date). Reading that meaning out of the
 * conversation with fixed word lists never converged under review (#5071),
 * so this module does not re-read the conversation. It only checks that the
 * extraction's own pinned quotes are real and name what it claims:
 *   - the agent's commitment (/scheduling/agent_committed_booking, speaker
 *     "agent") and the caller's acceptance (/scheduling/caller_accepted_slot,
 *     speaker "caller") each appear word for word in one turn of that
 *     speaker;
 *   - an agreed-slot quote (/scheduling/confirmed_start_at) appears word for
 *     word in one turn of its speaker and names the agreed time: at least one
 *     hour, every hour it names is the slot's, on the hour (never minutes, or
 *     a bound like "before noon"), every day it names is the slot's date,
 *     and it says no other number (an unmarked correction like "at two,
 *     actually three"). A quote naming no day grounds only a same-day change,
 *     where the slot keeps the moved appointment's date;
 *   - when the extraction names the moved appointment, a quote pinned to
 *     /scheduling/moved_appointment_date appears word for word in one turn
 *     and names that date: at least one day, every day it names that date.
 * Times, dates and numbers are judged over the whole sentence a quote sits
 * in: a quote that stops partway through a time ("Thursday at 2" of "Thursday
 * at 2:30 PM") or before a correction ("..., actually three") fails. Beside
 * the slot, a sentence may name the moved appointment's date ("from October
 * 8th to Thursday at two"), and the other way round.
 * A quote shorter than three words must be the speaker's whole turn ("Yes."),
 * never a fragment of a longer one ("yes" inside "yes, but not Thursday").
 * Anything missing, mis-attributed or ungrounded fails closed.
 *
 * Contract: groundRescheduleAgreement({ v2, transcript, callStartedAt }) ->
 *   { ok, reason, movedDate: 'YYYY-MM-DD' | null }
 */
'use strict';

const { etWallClockOfConfirmedStart } = require('./call-triage-flags');
const { normalize, parseTurns, readTurn } = require('./call-time-mentions');

const MIN_FRAGMENT_WORDS = 3;

// Where this quote appears word for word in a turn of this speaker: one
// { turn, from, to } per occurrence, with from/to its token span in the
// turn. A quote under three words must be that whole turn.
function placements(turns, quote, speaker) {
  const qt = normalize(quote).split(' ').filter(Boolean);
  if (!qt.length) return [];
  const whole = qt.length < MIN_FRAGMENT_WORDS;
  return turns.filter((t) => t.agent === (speaker === 'agent')).flatMap((turn) => {
    const tt = turn.ns.split(' ').filter(Boolean);
    if (whole) return tt.join(' ') === qt.join(' ') ? [{ turn, from: 0, to: tt.length }] : [];
    const at = [];
    for (let i = 0; i + qt.length <= tt.length; i += 1) {
      if (qt.every((w, k) => tt[i + k] === w)) at.push({ turn, from: i, to: i + qt.length });
    }
    return at;
  });
}

// The days, hours and unexplained numbers said in the sentences this placed
// quote touches, read from its whole turn: a correction said after the quote
// in the same sentence ("Thursday at two, actually three") counts. Null when
// a time or date runs past the ends of those sentences.
function readPlaced({ turn, from, to }, started) {
  const said = readTurn(turn.raw, started);
  const touched = said.sentences.filter((x) => x.from < to && x.to > from);
  const lo = Math.min(from, ...touched.map((x) => x.from));
  const hi = Math.max(to, ...touched.map((x) => x.to));
  const within = (m) => m.pos < hi && m.end > lo;
  const days = said.days.filter(within);
  const hours = said.hours.filter(within);
  if ([...days, ...hours].some((m) => m.pos < lo || m.end > hi)) return null;
  return { days, hours, unexplained: said.unexplained.filter((p) => p >= lo && p < hi) };
}

// Is every day said `date`? A weekday beside an explicit date only describes
// it ("Thursday, December 17"), so it must be that date's weekday; alone, a
// weekday names this week's or next week's. A day that can only be `other`
// (the other of the moved and agreed dates, "from October 8th to Thursday")
// is set aside first.
function everyDayIs(days, date, other = null) {
  const own = other ? days.filter((d) => d.candidates.has(date) || !d.candidates.has(other)) : days;
  const pinned = own.some((d) => d.weekday == null);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return own.length > 0 && own.every((d) => (pinned && d.weekday != null ? d.weekday === weekday : d.candidates.has(date)));
}

// Does this placed quote's sentence name exactly this slot: at least one
// hour, every hour the slot's and on the hour, every day the slot's date
// (or the moved appointment's) — no day at all only when the slot keeps
// `movedDate` — and no other number it can't place?
function namesSlot(placed, slot, started, movedDate) {
  const said = readPlaced(placed, started);
  if (!said || !said.hours.length || said.unexplained.length) return false;
  if (!said.hours.every((h) => h.hour24 === slot.hour24 && !h.offHour)) return false;
  return said.days.length ? everyDayIs(said.days, slot.date, movedDate) : slot.date === movedDate;
}

// Does this placed quote's sentence name exactly this date: at least one day,
// every day it (or the agreed slot's)?
function namesDate(placed, date, started, slotDate) {
  const said = readPlaced(placed, started);
  return Boolean(said) && everyDayIs(said.days, date, slotDate);
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

  // The extraction's quotes pinned to one field, each with where it appears
  // word for word in a turn of its stated speaker (and, when given, only
  // that speaker's); a quote found nowhere is dropped.
  const grounded = (fieldPath, speaker = null) => (Array.isArray(v2.evidence) ? v2.evidence : [])
    .filter((e) => e?.field_path === fieldPath && typeof e.quote === 'string' && (!speaker || e.speaker === speaker))
    .map((e) => placements(turns, e.quote, e.speaker))
    .filter((at) => at.length);
  // A quote said in several places must name the same thing in each.
  const anyNames = (fieldPath, names) => grounded(fieldPath).some((at) => at.every(names));
  if (!grounded('/scheduling/agent_committed_booking', 'agent').length) return fail('agent_commitment_ungrounded');
  if (!grounded('/scheduling/caller_accepted_slot', 'caller').length) return fail('caller_acceptance_ungrounded');
  const movedDate = typeof scheduling.moved_appointment_date === 'string' ? scheduling.moved_appointment_date : null;
  if (movedDate && !anyNames('/scheduling/moved_appointment_date', (p) => namesDate(p, movedDate, started, slot.date))) {
    return fail('moved_appointment_ungrounded');
  }
  if (!anyNames('/scheduling/confirmed_start_at', (p) => namesSlot(p, slot, started, movedDate))) {
    return fail('agreed_slot_ungrounded');
  }
  return { ok: true, reason: 'agreement_grounded', movedDate };
}

module.exports = { groundRescheduleAgreement };
