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

function isPayLinkEnabled() {
  return isVoiceLatePaymentEnabled()
    && process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK === 'true';
}

module.exports = { isVoiceLatePaymentEnabled, isPayLinkEnabled };
