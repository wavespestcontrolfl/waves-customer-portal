// The processor's customer-attached lead-creation gate — ONE definition on
// purpose (extracted from call-recording-processor.js, codex P1 PR #3303
// r19): the call processor uses it to decide whether a customer-attached
// call may CREATE or REUSE a lead, and the attribution retire path applies
// the SAME gate as the linkage-decision mirror on phone-matched successors —
// two drifting copies would let a call the processor refused to link
// inherit a lead's funnel history anyway. Dependency-free by design, like
// non-lead-call-content.js (a jest partial mock of the processor must never
// blank it).

const LEAD_PIPELINE_STAGES = new Set([
  'new_lead',
  'contacted',
  'qualified',
  'estimate_needed',
  'estimate_draft',
  'estimate_sent',
  'estimate_viewed',
  'follow_up',
  'negotiating',
]);

function shouldCreateCallLeadForCustomer(customer, { createdCustomerFromCall = false } = {}) {
  if (!customer) return false;
  if (createdCustomerFromCall) return true;
  return LEAD_PIPELINE_STAGES.has(String(customer.pipeline_stage || '').toLowerCase());
}

module.exports = { LEAD_PIPELINE_STAGES, shouldCreateCallLeadForCustomer };
