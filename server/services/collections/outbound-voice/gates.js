/**
 * Gates for the collections outbound-voice lane (PR B).
 *
 * GATE_VOICE_LATE_PAYMENT is the MASTER kill switch for every surface in this
 * lane — origination, the vestibule TwiML routes, the relay session mode, the
 * voicemail path, everything. Exact-'true' check, default OFF: every new
 * surface FAILS CLOSED without it (webhook routes answer with an empty
 * hangup, origination refuses, the relay session ends politely).
 *
 * GATE_VOICE_LATE_PAYMENT_PAYLINK sub-gates the ONE customer-facing
 * communication write in the lane (the mid-call pay-link SMS). It requires
 * the master gate too — a sub-gate alone can never light a dark lane.
 */

function isVoiceLatePaymentEnabled() {
  return process.env.GATE_VOICE_LATE_PAYMENT === 'true';
}

// GATE_VOICE_LATE_PAYMENT_AUTODIAL sub-gates the AUTOMATIC dial sweep (the
// ruled fully-automatic trigger, 2026-08-14) — flipped only after the
// supervised 5-call shakedown. Requires the master gate AND the PR A policy
// gate: an auto-dial without the policy engine evaluating would be a dial
// with no authorization boundary. Enumerate every gate.
function isAutoDialEnabled() {
  return isVoiceLatePaymentEnabled()
    && process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL === 'true'
    && process.env.GATE_COLLECTIONS_POLICY === 'true';
}

function isPayLinkEnabled() {
  // HARD dependency on the PR A policy gate (gh prb-r3): the rail-guard
  // consult passes unconditionally while GATE_COLLECTIONS_POLICY is off, so
  // the one customer-facing write in this lane must refuse to light without
  // the policy engine actually evaluating. Enumerate every gate.
  return isVoiceLatePaymentEnabled()
    && process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK === 'true'
    && process.env.GATE_COLLECTIONS_POLICY === 'true';
}

module.exports = { isVoiceLatePaymentEnabled, isPayLinkEnabled, isAutoDialEnabled };
