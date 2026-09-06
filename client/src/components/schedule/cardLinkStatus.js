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
  const requestDone = reqStatus === 'completed' || reqStatus === 'satisfied';
  // The LIVE Auto Pay state decides "active", never the historical
  // request row (Codex #2921 P2): a card captured through the link can
  // later expire, be removed, or have Auto Pay paused — completion
  // billing reads the current state, so this panel must too.
  if (data.autopayActive) {
    return {
      tone: 'good',
      text: reqStatus === 'completed' ? 'Card secured — Auto Pay active' : 'Auto Pay active',
    };
  }
  if (requestDone) {
    // The funnel already ran for this visit (it will never text again),
    // but the protection has since lapsed — say so instead of "active".
    return {
      tone: 'bad',
      text: 'Auto Pay no longer active — card was secured but the method lapsed or was removed. Check the customer\'s saved payment methods.',
    };
  }
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

// Standalone Auto Pay setup link (Customers page, POST
// /admin/customers/:id/autopay-setup-link): no visit exists, so the
// visit-oriented wording below must not leak into these outcomes.
export function describeAutopaySetupLinkResult(result) {
  if (!result) return { tone: 'bad', text: 'Request failed — try again' };
  if (result.action === 'sent') {
    return { tone: 'good', text: result.channel === 'email' ? 'Auto Pay setup link emailed' : 'Auto Pay setup link texted' };
  }
  if (result.action === 'auto_secured') return { tone: 'good', text: 'A consented card was already on file — Auto Pay enrolled, no link needed' };
  if (result.action === 'link_created') {
    return { tone: 'good', text: result.copied ? 'Auto Pay setup link copied to clipboard' : 'Auto Pay setup link ready — copy it from below' };
  }
  const reason = String(result.reason || '');
  if (reason === 'gate_off') return { tone: 'muted', text: 'Auto Pay setup links are switched off (GATE_AUTOPAY_SETUP_LINK)' };
  if (reason === 'template_inactive') return { tone: 'muted', text: 'The Auto Pay setup text is inactive in Templates — copy the link instead' };
  if (reason === 'email_template_inactive') return { tone: 'muted', text: 'The Auto Pay setup email is inactive in Templates — copy the link instead' };
  if (reason === 'no_customer_email') return { tone: 'bad', text: 'No email address on file for this customer' };
  if (reason === 'email_prefs_check_uncertain') return { tone: 'bad', text: 'Could not confirm this customer\'s email preferences — try again in a moment' };
  if (reason === 'email_opted_out') return { tone: 'muted', text: 'Not sent — this customer has email notifications turned off. Copy or text the link instead' };
  if (reason === 'payer_billed') return { tone: 'muted', text: 'Skipped — this customer bills to a third-party payer' };
  // A transient lookup failure is NOT a confirmed payer — say so, so the
  // operator retries instead of assuming third-party billing.
  if (reason === 'payer_check_uncertain') return { tone: 'bad', text: 'Could not confirm who this customer bills to — try again in a moment' };
  if (reason === 'request_exists') return { tone: 'muted', text: 'A live Auto Pay setup link already exists for this customer' };
  // Shared vocabulary (already-active, paused, lane, SMS gate, phone, send
  // outcomes) is customer-scoped in the base formatter.
  return describeCardRequestResult(result);
}

// Verbatim outcome of POST /admin/schedule/:id/card-request → friendly
// line. Every skip reason the funnel can return maps to words Virginia
// can act on; unknown reasons stay visible rather than pretending success.
export function describeCardRequestResult(result) {
  if (!result) return { tone: 'bad', text: 'Send failed — try again' };
  if (result.action === 'sent') return { tone: 'good', text: 'Secure card link texted' };
  if (result.action === 'auto_secured') return { tone: 'good', text: 'Card already on file — Auto Pay enrolled, no text needed' };
  // Standalone Auto Pay setup link (Customers page): inline delivery hands
  // the link back instead of texting.
  if (result.action === 'link_created') {
    return { tone: 'good', text: result.copied ? 'Auto Pay setup link copied to clipboard' : 'Auto Pay setup link ready — copy it from below' };
  }
  const reason = String(result.reason || '');
  if (reason === 'customer_not_found') return { tone: 'bad', text: 'Customer not found' };
  if (reason === 'autopay_sms_gate_off') return { tone: 'muted', text: 'Auto Pay texts are switched off (GATE_AUTOPAY_CUSTOMER_SMS) — copy the link instead' };
  if (reason === 'autopay_paused') return { tone: 'muted', text: 'Auto Pay is already set up but paused — resume it instead of sending a setup link' };
  if (reason === 'unsupported_billing_lane') return { tone: 'muted', text: 'Not sent — this customer is on monthly dues, annual prepay, or a one-time job, so per-visit Auto Pay does not apply' };
  if (reason === 'completion_in_progress') return { tone: 'muted', text: 'The customer is finishing setup right now — check back in a few minutes' };
  if (reason.startsWith('enrollment_refused')) return { tone: 'bad', text: 'Saved card could not be enrolled — check the customer\'s payment methods' };
  if (reason === 'send_blocked' || reason === 'request_failed') return { tone: 'bad', text: 'Send failed — check Communications' };
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
