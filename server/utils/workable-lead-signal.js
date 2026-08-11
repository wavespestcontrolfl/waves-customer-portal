// The processor's customer-LESS lead-creation gate — ONE definition on
// purpose (extracted from call-recording-processor.js, pre-push P1 PR
// #3303 r20): the call processor uses it to decide whether a customer-less
// call carries enough signal to mint a workable lead, and the attribution
// retire path applies the SAME gate as the linkage-decision mirror on
// customer-less phone-matched successors — two drifting copies would let a
// call the processor refused to link inherit a lead's funnel history
// anyway. Dependency-free by design, like call-lead-customer-gate.js and
// non-lead-call-content.js (a jest partial mock of the processor must
// never blank it). EMAIL_RE moved here with it (newsletter-subscribers
// re-exports — same pattern as estimate-claim-sql's helpers).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasWorkableLeadSignal({ extracted = {}, phone = null, voicemail = false } = {}) {
  const text = (v) => String(v == null ? '' : v).trim();
  const hasServiceIntent = !!(text(extracted.matched_service) || text(extracted.requested_service));
  if (!phone) {
    return hasServiceIntent && EMAIL_RE.test(text(extracted.email).toLowerCase());
  }
  const hasReachback = !!(text(extracted.email) || text(extracted.address_line1));
  return hasServiceIntent && (hasReachback || voicemail === true);
}

module.exports = { EMAIL_RE, hasWorkableLeadSignal };
