// Shared call-content classification: is this call's extraction a new sales
// lead, or an existing-customer / non-sales call?
//
// ONE definition on purpose (extracted from call-recording-processor.js,
// codex P1 PR #3303 r18): the call processor uses it to decide whether a
// call may create or reuse a lead, and the attribution retire path uses the
// SAME predicate as the durable-evidence gate on phone-matched successors —
// two drifting copies would let a call the processor refused to link
// inherit a lead's funnel history anyway.

// Call types that are NOT new sales leads. spam/voicemail are handled by their
// own booleans + early return; these are the existing-customer/non-sales calls
// the classifier now labels so they stop spawning leads. Kept narrow on purpose:
// a genuine new prospect is `new_inquiry`, so vetoing on these never drops a real
// lead, it only stops re-triaging people who already bought or aren't buying.
const NON_LEAD_CALL_TYPES = new Set([
  'existing_customer_scheduling',
  'existing_customer_service',
  'complaint',
  'billing',
  'wrong_number',
]);

// Content-based veto: the call is not a new lead when the model explicitly says
// so (is_lead === false) or labels it a non-lead call_type. Both signals are
// optional — when the model omits them (or extraction fell back), this returns
// false so behavior matches the legacy pipeline-stage-only gate.
function isNonLeadCallContent(extracted = {}) {
  if (extracted && extracted.is_lead === false) return true;
  const callType = String(extracted?.call_type || '').trim().toLowerCase();
  return NON_LEAD_CALL_TYPES.has(callType);
}

module.exports = { NON_LEAD_CALL_TYPES, isNonLeadCallContent };
