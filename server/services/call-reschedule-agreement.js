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
 *     a bound like "before noon"), and every day it names is the slot's date.
 *     A quote naming no day grounds only a same-day change, where the slot
 *     keeps the moved appointment's date;
 *   - when the extraction names the moved appointment, a quote pinned to
 *     /scheduling/moved_appointment_date appears word for word in one turn
 *     and names that date: at least one day, every day it names that date.
 * A quote shorter than three words must be the speaker's whole turn ("Yes."),
 * never a fragment of a longer one ("yes" inside "yes, but not Thursday").
 * Anything missing, mis-attributed or ungrounded fails closed.
 *
 * Contract: groundRescheduleAgreement({ v2, transcript, callStartedAt }) ->
 *   { ok, reason, movedDate: 'YYYY-MM-DD' | null }
 */
'use strict';

const { etWallClockOfConfirmedStart } = require('./call-triage-flags');
const {
  normalize, parseTurns, parseDayMentions, extractHourMentions, hasUnexplainedNumber,
} = require('./call-time-mentions');

const MIN_FRAGMENT_WORDS = 3;

function padded(s) { return ` ${s} `; }

// Does this quote appear word for word inside one turn of this speaker? A
// quote under three words must be that whole turn.
function groundedIn(turns, quote, speaker) {
  const ns = normalize(quote);
  if (!ns) return false;
  const whole = ns.split(' ').length < MIN_FRAGMENT_WORDS;
  return turns.some((t) => t.agent === (speaker === 'agent') && (whole ? t.ns === ns : padded(t.ns).includes(padded(ns))));
}

// Is every day this quote names `date`? A weekday beside an explicit date
// only describes it ("Thursday, December 17"), so it must be that date's
// weekday; alone, a weekday names this week's or next week's.
function everyDayIs(days, date) {
  const pinned = days.some((d) => d.weekday == null);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return days.every((d) => (pinned && d.weekday != null ? d.weekday === weekday : d.candidates.has(date)));
}

// Does this quote name exactly this slot: at least one hour, every hour the
// slot's and on the hour, every day the slot's date — no day at all only
// when the slot keeps `sameDayAs` — and no other number it can't place?
function namesSlot(quote, slot, started, sameDayAs) {
  const hours = extractHourMentions(quote, started);
  const days = parseDayMentions(quote, started);
  return hours.length > 0 && hours.every((h) => h.hour24 === slot.hour24 && !h.offHour)
    && !hasUnexplainedNumber(quote, started)
    && everyDayIs(days, slot.date) && (days.length > 0 || slot.date === sameDayAs);
}

// Does this quote name exactly this date: at least one day, every day it?
function namesDate(quote, date, started) {
  const days = parseDayMentions(quote, started);
  return days.length > 0 && everyDayIs(days, date);
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

  // The extraction's quotes pinned to one field that appear word for word in
  // a turn of their stated speaker (and, when given, only that speaker's).
  const grounded = (fieldPath, speaker = null) => (Array.isArray(v2.evidence) ? v2.evidence : [])
    .filter((e) => e?.field_path === fieldPath && typeof e.quote === 'string' && (!speaker || e.speaker === speaker)
      && groundedIn(turns, e.quote, e.speaker));
  if (!grounded('/scheduling/agent_committed_booking', 'agent').length) return fail('agent_commitment_ungrounded');
  if (!grounded('/scheduling/caller_accepted_slot', 'caller').length) return fail('caller_acceptance_ungrounded');
  const movedDate = typeof scheduling.moved_appointment_date === 'string' ? scheduling.moved_appointment_date : null;
  if (movedDate && !grounded('/scheduling/moved_appointment_date').some((e) => namesDate(e.quote, movedDate, started))) {
    return fail('moved_appointment_ungrounded');
  }
  if (!grounded('/scheduling/confirmed_start_at').some((e) => namesSlot(e.quote, slot, started, movedDate))) {
    return fail('agreed_slot_ungrounded');
  }
  return { ok: true, reason: 'agreement_grounded', movedDate };
}

module.exports = { groundRescheduleAgreement };
