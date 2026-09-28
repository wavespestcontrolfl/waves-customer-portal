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

module.exports = { SLA_PHRASES, FOLLOWUP_PROMISED_NOTE, realAnswersGateOn, replyPromisesFollowup, slaPhraseStatus, draftPromisedFollowup, followupPromiseIsStale };
