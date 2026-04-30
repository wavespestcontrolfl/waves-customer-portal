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
  // template kill-switch mapping when the purpose-based default would
  // route to the wrong sms_templates row. invoice.js:402 uses this to
  // keep invoice SMS controlled by the `invoice_sent` template
  // (purpose=billing/payment_link would otherwise map to a different
  // template, breaking the per-template kill-switch). Codex P1 on
  // PR #537 — keep this override pathway when reverting #526.
  const messageType =
    (input.metadata && input.metadata.original_message_type) ||
    mapPurposeToMessageType(input.purpose);
  try {
    const result = await TwilioService.sendSMS(input.to, input.body, {
      customerId: input.customerId || null,
      messageType,
      fromNumber: input.metadata && input.metadata.fromNumber,
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
    case 'billing':             return 'billing_reminder';
    case 'payment_link':        return 'payment_link';
    case 'estimate_followup':   return 'manual';
    case 'review_request':      return 'review_request';
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
