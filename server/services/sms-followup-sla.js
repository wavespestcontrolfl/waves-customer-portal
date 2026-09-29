'use strict';
// The follow-up SLA phrases a GATE_SMS_REAL_ANSWERS draft may carry, and the
// two deterministic questions the send/auto-send boundaries ask about them
// (PR #5119 Codex r3). Its own module so sms-auto-send can ask without
// loading (or being mocked away with) the whole drafter.

// Every phrase followupSlaPhrase (sms-shadow-drafter) can emit — the only
// follow-up timings a gate-on draft may quote, so their presence in a reply
// is a deterministic "this draft promises a human follow-up" signal.
const SLA_PHRASES = Object.freeze(['within the hour', 'by 9 AM this morning', 'by 9 AM tomorrow morning']);

const FOLLOWUP_PROMISED_NOTE = 'followup_promised';
const REAL_ANSWERS_VERSION_PREFIX = 'house_voice_v12';
// Same permissive spelling rule as config/feature-gates gateEnvValue, read
// at call time; local so this module stays dependency-free.
function realAnswersGateOn() {
  return ['1', 'true', 'on'].includes(String(process.env.GATE_SMS_REAL_ANSWERS || '').toLowerCase());
}

function replyPromisesFollowup(reply) {
  const text = String(reply || '').toLowerCase();
  return SLA_PHRASES.some((p) => text.includes(p.toLowerCase()));
}

// A draft's SLA phrase is frozen at generation, but an Agent Review card can
// sit up to 48h and a scheduled reply fires later still: the send seams ask
// whether the phrase the outgoing body carries is STILL the one the drafter
// would produce now. 'none' → no SLA phrase in the body; 'current' → every
// phrase present matches now; 'stale' → a different window has begun.
function slaPhraseStatus(body, now = new Date()) {
  const text = String(body || '').toLowerCase();
  const present = SLA_PHRASES.filter((p) => text.includes(p.toLowerCase()));
  if (!present.length) return 'none';
  const { followupSlaPhrase } = require('./sms-shadow-drafter'); // lazy: the drafter requires this module
  const current = followupSlaPhrase(now).toLowerCase();
  return present.every((p) => p.toLowerCase() === current) ? 'current' : 'stale';
}

// Did THIS draft promise an office follow-up? (Codex r5) The phrases are
// common English — a reviewed reply can truthfully say a technician arrives
// "within the hour" — so the send seams never judge a body by wording
// alone. A promised follow-up is one the draft recorded: the decision's
// persisted intended_actions carry the real-answers prompt's own marker,
// {"type":"escalate","note":"followup_promised"}, which it adds with the
// SLA phrase. Only that exact marker counts, so a draft from the older
// prompt that merely escalated is never touched (gate-off behavior is
// unchanged by PR #5119). Accepts the snapshot as an object or JSON string.
//
// A draft written by the real-answers prompt itself (stored prompt version
// house_voice_v12…) counts on ANY escalation: its held-category and
// cancellation rules promise the same follow-up timing but escalate with
// their own notes (pre-push audit P1). An older-prompt draft needs the
// explicit marker, which it never carries.
function draftPromisedFollowup(inputSnapshot, promptVersion = null) {
  let snap = inputSnapshot;
  if (typeof snap === 'string') {
    try { snap = JSON.parse(snap); } catch { return false; }
  }
  const actions = snap && Array.isArray(snap.intended_actions) ? snap.intended_actions : [];
  const realAnswersDraft = typeof promptVersion === 'string' && promptVersion.startsWith(REAL_ANSWERS_VERSION_PREFIX);
  return actions.some((a) => a && a.type === 'escalate' && (realAnswersDraft || a.note === FOLLOWUP_PROMISED_NOTE));
}

// The one question both send seams ask: is this an escalated draft whose
// follow-up phrase has gone stale for the current ET window?
function followupPromiseIsStale({ inputSnapshot, promptVersion = null, body, now = new Date() }) {
  return draftPromisedFollowup(inputSnapshot, promptVersion) && slaPhraseStatus(body, now) === 'stale';
}

// Follow-up #1 (Codex r6): an operator can keep the promise while editing
// its timing into wording the phrase list does not know ("within 60
// minutes"), which would otherwise read as "no promise" and send at any
// hour. On a draft that recorded a promised follow-up, an edit that removes
// every recognized timing phrase the drafted reply had is unsendable.
function followupPromiseEdited({ inputSnapshot, promptVersion = null, originalBody, body }) {
  if (!draftPromisedFollowup(inputSnapshot, promptVersion)) return false;
  if (originalBody == null) return false;
  return slaPhraseStatus(originalBody, new Date()) !== 'none' && slaPhraseStatus(body, new Date()) === 'none';
}

// Follow-up #7 (Codex r9): the window comparison alone repeats — "by 9 AM
// tomorrow morning" drafted Monday night reads as current Tuesday night,
// after the promised Tuesday-morning deadline passed. The phrase plus the
// decision's draft time pin the actual deadline: within the hour → drafted
// + 60 min; by 9 AM this morning / tomorrow morning → that 9 AM ET.
function followupDeadline(phrase, draftedAt) {
  const at = draftedAt instanceof Date ? draftedAt : new Date(draftedAt);
  if (!Number.isFinite(at.getTime())) return null;
  const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
  const p = String(phrase || '').toLowerCase();
  if (p === 'within the hour') return new Date(at.getTime() + 60 * 60 * 1000);
  if (p === 'by 9 am this morning') return parseETDateTime(`${etDateString(at)}T09:00:00`);
  if (p === 'by 9 am tomorrow morning') {
    // The phrase is only ever generated after 8 PM ET. A decision row
    // inserted after midnight (draft started before it) still means the
    // 9 AM of ITS OWN date, not a day later (Codex #5194 r2).
    const { etParts } = require('../utils/datetime-et');
    const generatedBeforeMidnight = etParts(at).hour < 8;
    return parseETDateTime(`${etDateString(generatedBeforeMidnight ? at : addETDays(at, 1))}T09:00:00`);
  }
  return null;
}
// The deadline is the ORIGINAL promise's (Codex #5194 r4): an operator who
// updates "by 9 AM tomorrow morning" to the now-current "by 9 AM this
// morning" on Tuesday at 8 AM has not moved the deadline, so it is derived
// from the drafted reply's phrase and draft time; the outgoing body's
// phrase is used only when the drafted reply carried none.
function followupDeadlinePassed({ body, originalBody = null, draftedAt, now = new Date() }) {
  if (draftedAt == null) return false;
  const source = [originalBody, body].find((t) => t != null && slaPhraseStatus(t, now) !== 'none');
  if (source == null) return false;
  const text = String(source).toLowerCase();
  return SLA_PHRASES.some((p) => {
    if (!text.includes(p.toLowerCase())) return false;
    const deadline = followupDeadline(p, draftedAt);
    return Boolean(deadline) && now.getTime() > deadline.getTime();
  });
}

// Both send seams ask one question: may this escalated draft's follow-up
// promise go out as written? null when yes, else the reason.
function followupPromiseBlockReason({ inputSnapshot, promptVersion = null, originalBody = null, body, draftedAt = null, now = new Date() }) {
  if (draftPromisedFollowup(inputSnapshot, promptVersion) && followupDeadlinePassed({ body, originalBody, draftedAt, now })) return 'sla_deadline_passed';
  if (followupPromiseIsStale({ inputSnapshot, promptVersion, body, now })) return 'sla_phrase_stale';
  if (followupPromiseEdited({ inputSnapshot, promptVersion, originalBody, body })) return 'sla_phrase_edited';
  return null;
}

// Codex #5194 P2 ("Timestamp the SLA when its facts are generated"): the
// FOLLOW-UP SLA RIGHT NOW phrase a draft carries is rendered off the instant
// sms-shadow-drafter built its facts block (generateGroundedDraft's
// factsAt), not off the agent_decisions row's own created_at — created_at
// lands only after the whole draft→verify→revise loop finishes, which can
// cross the 8am/8pm ET phrase boundary the phrase itself was computed
// against. Both send seams (agent-decision-send-checks.js's followupBlock
// and the scheduler's queued-SMS SLA block) call this ONE helper instead of
// each re-deriving the choice, so they can't drift apart. `decision` is
// whatever a `agent_decisions` read handed back — a plain object with
// `input_snapshot` (string or already-parsed) and `created_at` is enough,
// so both seams' partial column selects work unchanged. A row written
// before this change (or one whose caller predates the field, or an
// unparseable/garbage value) carries no usable facts_generated_at and falls
// back to created_at — the ONLY anchor those rows ever had.
function slaDraftedAt(decision) {
  let snapshot = decision?.input_snapshot;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
  }
  const raw = snapshot && typeof snapshot === 'object' ? snapshot.facts_generated_at : null;
  if (typeof raw === 'string' && raw) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return decision?.created_at ?? null;
}

module.exports = {
  SLA_PHRASES, FOLLOWUP_PROMISED_NOTE, realAnswersGateOn, replyPromisesFollowup, slaPhraseStatus,
  draftPromisedFollowup, followupPromiseIsStale, followupPromiseEdited, followupPromiseBlockReason,
  followupDeadline, followupDeadlinePassed, slaDraftedAt,
};
