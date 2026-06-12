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

function sanitizeProviderError(value) {
  if (!value) return '';
  return String(value)
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted-phone]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function formatProviderError(err) {
  if (!err) return 'twilio threw';
  if (err.providerError) return sanitizeProviderError(err.providerError);
  const parts = [];
  if (err.code) parts.push(`Twilio ${err.code}`);
  if (err.status) parts.push(`HTTP ${err.status}`);
  if (err.message) parts.push(sanitizeProviderError(err.message));
  return parts.filter(Boolean).join(': ') || 'twilio threw';
}

function providerFailureCode(err, error) {
  if (err && err.code) return String(err.code);
  const match = String(error || '').match(/\bTwilio\s+(\d{4,6})\b/i);
  return match ? match[1] : null;
}

function providerFailureStatus(err, error) {
  if (err && err.status) return Number(err.status);
  const match = String(error || '').match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function classifyProviderFailure(err, fallbackError) {
  const error = err ? formatProviderError(err) : (sanitizeProviderError(fallbackError) || 'twilio rejected');
  const twilioCode = providerFailureCode(err, error);
  const httpStatus = providerFailureStatus(err, error);
  const lc = String(error || fallbackError || '').toLowerCase();

  const terminalTwilioCodes = new Set([
    '21211', // invalid To number
    '21408', // permission denied for destination region
    '21606', // From number cannot send SMS
    '21608', // unverified trial destination
    '21610', // recipient unsubscribed
    '21612', // no route available
    '21614', // number is not mobile/SMS-capable
  ]);
  const retryableTwilioCodes = new Set([
    '20429', // Twilio rate limit
  ]);

  if (terminalTwilioCodes.has(twilioCode)) {
    return { retryable: false, terminal: true, twilioCode, httpStatus, error };
  }
  if (retryableTwilioCodes.has(twilioCode)) {
    return { retryable: true, terminal: false, twilioCode, httpStatus, error, retryAfterMs: 5 * 60 * 1000 };
  }
  if (httpStatus === 429 || httpStatus === 408 || httpStatus >= 500) {
    return { retryable: true, terminal: false, twilioCode, httpStatus, error, retryAfterMs: 5 * 60 * 1000 };
  }
  if (/timeout|timed out|econnreset|etimedout|eai_again|socket hang up|network|temporar/.test(lc)) {
    return { retryable: true, terminal: false, twilioCode, httpStatus, error, retryAfterMs: 5 * 60 * 1000 };
  }
  return { retryable: false, terminal: false, twilioCode, httpStatus, error };
}

function mediaUrlsAllowed(input) {
  const metadata = input.metadata || {};
  return metadata.allowMediaUrls === true || !!metadata.adminUserId;
}

function providerMediaUrls(input) {
  const urls = input.metadata && input.metadata.mediaUrls;
  if (!Array.isArray(urls) || urls.length === 0) return undefined;
  if (!mediaUrlsAllowed(input)) return undefined;
  return urls;
}

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
      mediaUrls: providerMediaUrls(input),
      media: input.metadata && input.metadata.media,
      customerLocationId: input.metadata && input.metadata.customerLocationId,
      agentDecisionId: input.metadata && input.metadata.agentDecisionId,
      parkedDecisionIds: input.metadata && input.metadata.parkedDecisionIds,
      scheduledSmsLogId: input.metadata && input.metadata.scheduled_sms_log_id,
      agentDraft: input.metadata && input.metadata.agentDraft,
      suggestedReply: input.metadata && input.metadata.suggestedReply,
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
      const failure = classifyProviderFailure(null, result.error || (result.guardBlocked ? 'sms-guard blocked' : result.gateBlocked ? 'feature gate blocked' : 'twilio rejected'));
      return {
        sent: false,
        provider: 'twilio',
        error: failure.error,
        retryable: failure.retryable,
        terminal: failure.terminal,
        providerErrorCode: failure.twilioCode,
        providerHttpStatus: failure.httpStatus,
        retryAfterMs: failure.retryAfterMs,
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
    const failure = classifyProviderFailure(err);
    return {
      sent: false,
      provider: 'twilio',
      error: failure.error,
      retryable: failure.retryable,
      terminal: failure.terminal,
      providerErrorCode: failure.twilioCode,
      providerHttpStatus: failure.httpStatus,
      retryAfterMs: failure.retryAfterMs,
    };
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
    case 'appointment_reminder_72h': return 'reminder_72h';
    case 'appointment_reminder_24h': return 'appointment_reminder';
    case 'appointment_confirmation': return 'appointment_confirmation';
    case 'appointment_cancellation': return 'appointment_cancelled';
    case 'tech_en_route':       return 'tech_en_route';
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
  _internals: {
    formatProviderError,
    classifyProviderFailure,
    mediaUrlsAllowed,
    providerFailureCode,
    providerFailureStatus,
    providerMediaUrls,
    sanitizeProviderError,
  },
};
