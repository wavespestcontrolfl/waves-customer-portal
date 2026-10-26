/**
 * Dropped-call detector — flags a lead-path call that died mid-intake before
 * the service address was captured. Used by call-recording-processor.js to
 * open the always-on `call_dropped_mid_intake` review card (a call-back
 * card for the office). The detector is deterministic: no model call, no
 * message is ever sent from here.
 *
 * The automatic address-request text that used to ride this detector
 * (GATE_DROPPED_CALL_SMS, never on in production) was removed 2026-10-25.
 */

const MIN_CALL_SECONDS = 120;

// Farewell detection over the transcript tail. A dropped call ends
// mid-thought; a normal call ends with a goodbye exchange. Two tiers: STRONG
// farewells (bye / see you / talk soon / take care) count anywhere in the
// last three turns; WEAK acknowledgements (sounds good / thanks /
// appreciate it) are everyday mid-conversation phrases — "Sounds good —
// what's your service address?" right before the line dies must NOT read as
// a goodbye — so they count only in the FINAL utterance (codex P2).
const STRONG_FAREWELL_RE = new RegExp(
  [
    '\\bbye\\b', 'good-?bye', 'bye-?bye',
    // "see you" only as a closing — "I don't see you in our system" is an
    // OPEN question mid-intake, not a farewell (codex P2).
    "(?<!(?:do|ca)n'?t )see (you|ya)\\b(?! in\\b)", 'talk (to you|soon|later)',
    'have a (good|great|nice|wonderful)',
    'take care(?! of\\b)',
  ].join('|'),
  'i'
);
const WEAK_FAREWELL_RE = new RegExp(
  [
    'sounds good', "you're welcome", 'appreciate (it|you)', 'thank(s| you)',
    // Ordinary closings without a literal goodbye — "No, that's all" is a
    // completed call, not a drop (codex P1).
    "that'?s (all|it)", 'nothing else', "(i'?m|we'?re) (good|all set)", 'all set',
  ].join('|'),
  'i'
);
// POSITIVE drop evidence, tier 1: the final utterance trails off without
// sentence-terminal punctuation (mid-thought cutoff), or tier 2: the tail
// carries connection-trouble language. Absence of a farewell alone is NOT
// enough to call a completed conversation "dropped" (codex P1) — a
// customer-facing "our call dropped" text needs precision over recall.
const CONNECTION_TROUBLE_RE = /can you hear me|are you (there|still there)|hello\?|you cut out|lost you\b|breaking up/i;
function finalTurnTrailsOff(finalTurn) {
  // Strip the speaker label, then require the utterance to END mid-thought:
  // no . ! or ? terminal (a comma, dash, or bare word is cutoff evidence).
  const text = String(finalTurn || '').replace(/^\s*(Agent|Caller)\s*:\s*/i, '').trim();
  if (!text) return false;
  return !/[.!?]["')\]]?$/.test(text);
}

/**
 * Full drop-mid-intake detection: long enough to be a real conversation,
 * no service address captured by EITHER extraction leg (V1 flat or the
 * canonical V2 service_address — V2 can hold the street when primary
 * adoption is off or V1 missed it), and an abrupt transcript ending.
 */
function detectDroppedMidIntake({ durationSeconds, transcription, extracted = {}, v2Extraction = null } = {}) {
  const v1Street = String(extracted.address_line1 || '').trim();
  const v2Street = String(v2Extraction?.property?.service_address?.street_line_1 || '').trim();
  return Number(durationSeconds) >= MIN_CALL_SECONDS
    && !v1Street
    && !v2Street
    && endedAbruptly(transcription);
}

/**
 * True when the transcript looks like a call that died mid-conversation:
 * enough turns to be a real exchange, and no farewell language anywhere in
 * the last three turns. Deterministic — no model call.
 */
function endedAbruptly(transcription) {
  // Fold diarized continuation lines into their turns (mirrors the
  // processor's speakerTurns contract): a turn starts at a "Speaker:" label
  // and absorbs unlabelled wrap lines — counting physical lines as turns
  // both inflates the turn count and mis-identifies the final utterance
  // (codex P2).
  const turns = [];
  for (const line of String(transcription || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^[A-Za-z][A-Za-z0-9 ]{0,20}:/.test(t)) turns.push(t);
    else if (turns.length) turns[turns.length - 1] += ` ${t}`;
    else turns.push(t);
  }
  if (turns.length < 4) return false; // too short to judge — not "abrupt"
  const tail = turns.slice(-3).join(' ');
  const finalTurn = turns[turns.length - 1];
  if (STRONG_FAREWELL_RE.test(tail)) return false;
  // A weak farewell counts only at the CLOSE of the final utterance and
  // never outranks positive cutoff evidence — "Thanks — now what is your
  // service add" cut mid-word is a drop, not a thank-you ending (codex P2).
  const finalText = String(finalTurn).replace(/^\s*[A-Za-z][A-Za-z0-9 ]{0,20}:\s*/, '').trim();
  const trailsOff = finalTurnTrailsOff(finalTurn);
  if (!trailsOff && WEAK_FAREWELL_RE.test(finalText.slice(-32))) return false;
  return trailsOff || CONNECTION_TROUBLE_RE.test(tail);
}

module.exports = {
  endedAbruptly,
  detectDroppedMidIntake,
  MIN_CALL_SECONDS,
  _private: { STRONG_FAREWELL_RE, WEAK_FAREWELL_RE },
};
