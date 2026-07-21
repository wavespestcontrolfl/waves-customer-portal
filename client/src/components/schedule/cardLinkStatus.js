// Shared presentation mapping for the office "Text card / Auto Pay link"
// action (secure-card funnel, server/services/appointment-card-request.js).
// Consumed by the schedule editor's Cards on file panel (SchedulePage
// EditServiceModal) and the mobile appointment sheet — the two surfaces
// must describe the same server outcomes with the same words. Pure data
// ({ tone, text }) — each surface styles its own tones.

// Rollup of GET /admin/schedule/:id/card-request. Null = nothing worth
// showing (no request yet, Auto Pay not active) — the send action is
// available instead.
export function describeCardRequestState(data) {
  if (!data) return null;
  const reqStatus = data.request?.status;
  if (reqStatus === 'completed') return { tone: 'good', text: 'Card secured — Auto Pay active' };
  if (reqStatus === 'satisfied') return { tone: 'good', text: 'Auto Pay active — covered by saved card' };
  if (data.autopayActive) return { tone: 'good', text: 'Auto Pay active' };
  // A pending row or a consumed one-text-ever stamp both mean a link is
  // (or was) out — the funnel will never text this visit again, so offer
  // no send button, just the state.
  if (data.request?.sentAt || data.cardLinkSentAt) {
    return { tone: 'muted', text: 'Secure card link sent — awaiting customer' };
  }
  return null;
}

// The send action only renders when the lane is on and there is nothing
// to report yet. When GET failed (data null) the action hides — better a
// missing button than one that can only error.
export function canSendCardRequest(data) {
  return !!(data && data.enabled && !describeCardRequestState(data));
}

// Verbatim outcome of POST /admin/schedule/:id/card-request → friendly
// line. Every skip reason the funnel can return maps to words Virginia
// can act on; unknown reasons stay visible rather than pretending success.
export function describeCardRequestResult(result) {
  if (!result) return { tone: 'bad', text: 'Send failed — try again' };
  if (result.action === 'sent') return { tone: 'good', text: 'Secure card link texted' };
  if (result.action === 'auto_secured') return { tone: 'good', text: 'Card already on file — Auto Pay enrolled, no text needed' };
  const reason = String(result.reason || '');
  if (reason === 'payer_billed' || reason === 'payer_check_uncertain') {
    return { tone: 'muted', text: 'Skipped — this visit bills to a third-party payer' };
  }
  if (reason === 'autopay_already_active') return { tone: 'good', text: 'Auto Pay already active' };
  if (reason === 'link_already_sent' || reason === 'request_exists') {
    return { tone: 'muted', text: 'Secure link already sent for this visit' };
  }
  if (reason.startsWith('visit_not_live')) return { tone: 'muted', text: 'Skipped — visit is not in a live status' };
  if (reason === 'visit_in_past') return { tone: 'muted', text: 'Skipped — visit date is in the past' };
  if (reason === 'gate_off' || reason === 'template_inactive') {
    return { tone: 'muted', text: 'Card-link texting is switched off' };
  }
  if (reason === 'no_customer_phone') return { tone: 'bad', text: 'No phone number on file for this customer' };
  if (reason === 'send_outcome_uncertain') {
    return { tone: 'muted', text: 'Send status uncertain — check Communications before retrying' };
  }
  return { tone: 'muted', text: `Not sent (${reason || 'unknown'})` };
}
