'use strict';
// The follow-up SLA phrases a GATE_SMS_REAL_ANSWERS draft may carry, and the
// two deterministic questions the send/auto-send boundaries ask about them
// (PR #5119 Codex r3). Its own module so sms-auto-send can ask without
// loading (or being mocked away with) the whole drafter.

// Every phrase followupSlaPhrase (sms-shadow-drafter) can emit — the only
// follow-up timings a gate-on draft may quote, so their presence in a reply
// is a deterministic "this draft promises a human follow-up" signal.
const SLA_PHRASES = Object.freeze(['within the hour', 'by 9 AM this morning', 'by 9 AM tomorrow morning']);

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

module.exports = { SLA_PHRASES, replyPromisesFollowup, slaPhraseStatus };
