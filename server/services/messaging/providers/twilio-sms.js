/**
 * Twilio SMS provider adapter.
 *
 * Thin shim over services/twilio.js sendSMS(). Keeps the existing
 * twilio.js layer intact (owner-silence kill switch, feature gates,
 * sms-guard template-render check, per-template kill switch — all
 * of those continue to apply) and just adapts the wrapper's
 * SendCustomerMessageInput shape to twilio.js's (to, body, options).
 */

const TwilioService = require('../../twilio');

async function sendViaTwilio(input) {
  // metadata.original_message_type lets a caller force a specific
  // legacy messageType (e.g. 'lead_response', 'invoice', 'manual')
  // through to TwilioService.sendSMS so the existing
  // admin-sms-templates kill-switch keys (lead_auto_reply_biz,
  // invoice_sent, etc.) keep working. The wrapper's `purpose` enum
  // drives consent / suppression / segment / voice policy + audit;
  // the messageType string drives the per-template ops kill switch
  // and the logo-attach behavior in services/twilio.js.
  //
  // Used by:
  //   invoice.js:402             — original_message_type: 'invoice'
  //   lead-response-tools.js     — original_message_type: 'lead_response'
  //   (and any future migration where purpose-based mapping would
  //    bypass an established template kill-switch row)
  const messageType =
    (input.metadata && input.metadata.original_message_type) ||
    mapPurposeToMessageType(input.purpose);
  try {
    const result = await TwilioService.sendSMS(input.to, input.body, {
      customerId: input.customerId || null,
      messageType,
      fromNumber: input.metadata && input.metadata.fromNumber,
      mediaUrls: input.metadata && input.metadata.mediaUrls,
      customerLocationId: input.metadata && input.metadata.customerLocationId,
      // Preserve admin attribution. services/twilio.js writes
      // sms_log.admin_user_id from this option; without forwarding,
      // operator-driven sends (Comms inbox, IB) lose the audit trail
      // that distinguishes them from system-initiated sends.
      adminUserId: input.metadata && input.metadata.adminUserId,
    });

    if (!result) {
      return { sent: false, provider: 'twilio', error: 'twilio.sendSMS returned undefined' };
    }
    if (result.success === false) {
      return {
        sent: false,
        provider: 'twilio',
        error: result.error || (result.guardBlocked ? 'sms-guard blocked' : result.gateBlocked ? 'feature gate blocked' : 'twilio rejected'),
        raw: result,
      };
    }
    if (result.suppressed) {
      // Owner-SMS kill switch upstream — treat as sent for our flow but
      // record it.
      return {
        sent: true,
        provider: 'twilio',
        providerMessageId: 'owner-silence',
        sentAt: new Date().toISOString(),
        raw: result,
      };
    }
    return {
      sent: true,
      provider: 'twilio',
      providerMessageId: result.sid || null,
      sentAt: new Date().toISOString(),
      raw: result,
    };
  } catch (err) {
    return { sent: false, provider: 'twilio', error: err.message || 'twilio threw' };
  }
}

/**
 * Map our purpose enum to the existing twilio.js messageType strings so
 * the per-template kill-switch (sms_templates.disabled) keeps working.
 */
function mapPurposeToMessageType(purpose) {
  switch (purpose) {
    case 'conversational':      return 'ai_assistant';
    case 'appointment':         return 'appointment_reminder';
    case 'appointment_confirmation': return 'appointment_confirmation';
    case 'billing':             return 'billing_reminder';
    case 'payment_receipt':     return 'receipt';
    case 'payment_failure':     return 'payment_failure';
    case 'autopay':             return 'autopay';
    case 'payment_link':        return 'payment_link';
    case 'estimate_followup':   return 'manual';
    case 'review_request':      return 'review_request';
    case 'referral':            return 'referral';
    case 'retention':           return 'manual';
    case 'marketing':           return 'manual';
    case 'internal_briefing':   return 'internal_alert';
    case 'support_resolution':  return 'manual';
    default:                    return 'manual';
  }
}

module.exports = {
  sendViaTwilio,
  mapPurposeToMessageType,
};
