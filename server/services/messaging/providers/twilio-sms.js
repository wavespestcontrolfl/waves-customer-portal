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

const DELIVERY_OUTCOMES = new Set(['accepted', 'not_sent', 'uncertain']);

function explicitDeliveryOutcome(value) {
  return DELIVERY_OUTCOMES.has(value) ? value : null;
}

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

// Permanent Twilio rejections. Nothing was sent. The sender-side ones are
// OUR configuration's problem, not the recipient's: fixing the sender or
// account makes a later send to the same number viable, so a lane holding
// a permanent one-text-per-number claim releases it for these instead of
// consuming it (missed-call-text-back.js). The rest are about the
// recipient.
const SENDER_SIDE_TERMINAL_TWILIO_CODES = Object.freeze([
  '21408', // permission denied for destination region
  '21606', // From number cannot send SMS
  '21608', // unverified trial destination
]);
const RECIPIENT_TERMINAL_TWILIO_CODES = Object.freeze([
  '21211', // invalid To number
  '21610', // recipient unsubscribed
  '21612', // no route available
  '21614', // number is not mobile/SMS-capable
]);

function classifyProviderFailure(err, fallbackError) {
  const error = err ? formatProviderError(err) : (sanitizeProviderError(fallbackError) || 'twilio rejected');
  const twilioCode = providerFailureCode(err, error);
  const httpStatus = providerFailureStatus(err, error);
  const lc = String(error || fallbackError || '').toLowerCase();

  const terminalTwilioCodes = new Set([...SENDER_SIDE_TERMINAL_TWILIO_CODES, ...RECIPIENT_TERMINAL_TWILIO_CODES]);
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

// Explicit billing Text legs (metadata.billingDeliveryLeg === 'sms') get an
// idempotency check before they reach Twilio at all — see
// billing-text-leg-dedupe.js for why (Email/App already dedupe an explicit
// billing leg on the same notificationEventKey; Text had no such guard).
// Every other caller (legacy SMS with no billingDeliveryLeg, non-billing
// sends, the push leg) short-circuits withBillingTextLegLock's own guard
// and reaches sendViaTwilioOnce completely unchanged.
async function sendViaTwilio(input, hooks = {}) {
  const { withBillingTextLegLock } = require('../billing-text-leg-dedupe');
  return withBillingTextLegLock(input, () => sendViaTwilioOnce(input, hooks));
}

async function sendViaTwilioOnce(input, {
  preSendCheck, providerPreSendCheck, onDispatchStart, onDispatchAbort, onDispatchRejected, withSmsHandoff, providerHandoffReservation,
  // codex #5018 structural fix (post-r7): threaded straight through, same
  // as onDispatchStart/onDispatchAbort/onDispatchRejected above.
  logInHandoff,
} = {}) {
  const providerCoordination = require('../provider-handoff-reservation');
  const internalProviderReservation = providerCoordination.isProviderHandoffHandle(providerHandoffReservation)
    ? providerHandoffReservation
    : null;
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
      // The visit this message is about (every appointment purpose carries
      // it) — push routing hands it to the push sink, which resolves the
      // visit's saved property for the app's deep link.
      appointmentId: input.appointmentId || null,
      explicitPushOnly: input.channel === 'push',
      skipPushRouting: Boolean(input.metadata?.appFallbackReason || input.metadata?.billingDeliveryLeg),
      notificationEventKey: input.metadata?.notificationEventKey,
      invoiceId: input.invoiceId,
      // Persisted on the accepted sms_log row (services/twilio.js) so a
      // later replay's dedupe lookup (billing-text-leg-dedupe.js) can scope
      // its notificationEventKey match to an explicit billing Text leg —
      // never a legacy send or another producer's own unrelated key.
      billingDeliveryLeg: input.metadata?.billingDeliveryLeg || undefined,
      billingDeliveryCategory: input.metadata?.billingDeliveryLeg
        ? require('../billing-channel-routing').billingDeliveryCategory(input) : undefined,
      requestNotification: input.metadata?.appOnly ? { id: input.metadata.service_request_id,
        status: input.metadata.request_status, version: input.metadata.request_status_version } : undefined,
      messageType,
      // The explicit addition to twilio.js's OWN annual-offer guard (the
      // authoritative check, run at the actual provider boundary) — its
      // content derivation over the final body covers the rest.
      estimateId: input.estimateId || null,
      estimateIds: Array.isArray(input.estimateIds) ? input.estimateIds : undefined,
      // Round 8 P1: send-customer-message.js's own wrapper already rewrote
      // and cleared these above when this policy applies, so threading it
      // through here is a defense-in-depth no-op for wrapper-routed sends
      // (rewriteWithheldEstimateLinks finds nothing left to rewrite) — it's
      // what makes twilio.js's OWN rewrite actually reachable for a raw/
      // direct sendSMS caller that never goes through this wrapper at all.
      withheldLinkPolicy: input.withheldLinkPolicy,
      // Push channel routing (services/twilio.js) treats operator-initiated
      // sends as sms_only — the operator explicitly chose the SMS channel.
      operatorInitiated: input.operatorInitiated === true,
      fromNumber: internalProviderReservation?.context?.fromNumber
        || (input.metadata && input.metadata.fromNumber),
      mediaUrls: providerMediaUrls(input),
      media: input.metadata && input.metadata.media,
      customerLocationId: input.metadata && input.metadata.customerLocationId,
      // Operator hand-typed the body (Comms composer) — exempt from the
      // stale-month guard, which targets automated template renders. Set only
      // by the manual-compose route, never inferred from messageType (which is
      // overloaded across automated senders that reuse 'manual'). See
      // services/sms-guard.js.
      humanAuthored: !!(input.metadata && input.metadata.humanAuthored === true),
      agentDecisionId: input.metadata && input.metadata.agentDecisionId,
      parkedDecisionIds: input.metadata && input.metadata.parkedDecisionIds,
      scheduledSmsLogId: input.metadata && input.metadata.scheduled_sms_log_id,
      // Which sms_templates row rendered this body — set by callers that
      // render through router.getTemplate / renderSmsTemplate /
      // renderRequiredSmsTemplate and thread the exact key they requested
      // into metadata.templateKey (never inferred here). Persisted on the
      // accepted sms_log row as template_key/template_variant_id
      // (services/twilio.js) and flows into messaging_audit_log.metadata
      // as-is via input.metadata below.
      templateKey: input.metadata && input.metadata.templateKey,
      templateVariantId: input.metadata && input.metadata.templateVariantId,
      // Durable linkage back to the review ask this text IS. The
      // stranded-send reconciliation proves a send from it, so an ask
      // whose template carries no review link (the private check-ins)
      // is still provable — a body-fragment search can never find one.
      reviewRequestId: input.metadata && input.metadata.review_request_id,
      agentDraft: input.metadata && input.metadata.agentDraft,
      suggestedReply: input.metadata && input.metadata.suggestedReply,
      // Preserve admin attribution. services/twilio.js writes
      // sms_log.admin_user_id from this option; without forwarding,
      // operator-driven sends (Comms inbox, IB) lose the audit trail
      // that distinguishes them from system-initiated sends.
      adminUserId: input.metadata && input.metadata.adminUserId,
      // Awaited by twilio.js immediately before messages.create() — the
      // send-window boundary re-check must run at the actual provider
      // handoff, after sendSMS's own internal awaits (redirect check,
      // template lookup, customer/location query).
      preSendCheck,
      providerPreSendCheck,
      // The REAL attempt boundary (codex #5018 r15 P1) — awaited by
      // twilio.js immediately before dispatchStarted flips true and
      // messages.create() runs, AFTER providerPreSendCheck's own refusal
      // path has already cleared.
      onDispatchStart,
      // codex #5018 r15 pre-push P1: lets the caller undo its own marker
      // when twilio.js's post-onDispatchStart window recheck refuses.
      onDispatchAbort,
      // codex #5196 r4 P2: fired instead of onDispatchAbort when
      // messages.create() throws a definitive rejection, still inside the
      // handoff lock.
      onDispatchRejected,
      withSmsHandoff,
      // codex #5018 structural fix (post-r7): gates twilio.js's in-
      // transaction sms_log insert (dispatch()'s own comment there).
      // Omitted (the default), twilio.js falls back to origin/main's
      // post-handoff, out-of-transaction insert.
      logInHandoff,
      providerHandoffReservation: internalProviderReservation,
      // The opaque owner token is issued only from the complete canonical
      // input and callback contract. Raw Twilio callers cannot bypass the
      // generic reservation merely by reusing the ai_gratitude message type.
      providerReservationOwner: providerCoordination.gratitudeReservationOwner(input, {
        providerPreSendCheck,
        withSmsHandoff,
      }),
    });

    if (!result) {
      return { sent: false, provider: 'twilio', deliveryOutcome: 'uncertain', error: 'twilio.sendSMS returned undefined' };
    }
    // sendSMS's own coded refusals are BLOCKS, not provider failures:
    //  - preSendBlocked: the caller's preSendCheck refused at the provider
    //    handoff (send-window boundary race) and carries its own deferral
    //    contract, so sendCustomerMessage maps it back onto the
    //    QUIET_HOURS_HOLD vocabulary callers reschedule on;
    //  - guardBlocked + code: the owned-number recipient guard (a Waves
    //    line is never a customer). Without this branch the generic
    //    success:false path below would record PROVIDER_FAILURE and the
    //    queued-send lanes would retry a send that can never succeed.
    const suppressed = result.suppressed || result.gateBlocked || result.templateDisabled;
    // Review delivery timestamps and cadence advancement require an actual
    // send. Normalize suppression before any review caller can stamp success.
    if ((input.channel === 'push' && (suppressed || result.guardBlocked))
      || (input.purpose === 'review_request' && suppressed)) {
      return { sent: false, blocked: true, provider: input.channel === 'push' ? 'push' : 'twilio', deliveryOutcome: 'not_sent', code: 'DELIVERY_SUPPRESSED', error: result.error || result.sid, validator: 'delivery_guard' };
    }
    if (result.appUnavailable) {
      return { sent: false, provider: 'push', deliveryOutcome: 'not_sent', appUnavailable: true, error: result.error || 'push_unavailable', ...(result.eventVisibleAt ? { eventVisibleAt: result.eventVisibleAt } : {}), ...(result.bellPersisted ? { bellPersisted: true } : {}) };
    }
    if (result.appPending) {
      return { sent: false, blocked: true, provider: 'push', deliveryOutcome: explicitDeliveryOutcome(result.deliveryOutcome) || 'uncertain', code: 'PUSH_IN_FLIGHT', error: 'push_in_flight', retryable: true, deferred: true, nextAllowedAt: new Date(Date.now() + 60000).toISOString(), ...(result.bellPersisted ? { bellPersisted: true } : {}) };
    }
    if (result.appRetryable) {
      if (Number.isFinite(result.retryAfterMs)) {
        const retryAfterMs = Math.max(60000, result.retryAfterMs);
        return { sent: false, provider: 'push', deliveryOutcome: explicitDeliveryOutcome(result.deliveryOutcome) || 'uncertain', code: 'APP_PROVIDER_RETRY', error: result.error,
          retryable: true, deferred: true, retryAfterMs, nextAllowedAt: new Date(Date.now() + retryAfterMs).toISOString(), ...(result.bellPersisted ? { bellPersisted: true } : {}) };
      }
      return { sent: false, blocked: true, provider: 'push', deliveryOutcome: explicitDeliveryOutcome(result.deliveryOutcome) || 'uncertain', code: 'APP_DELIVERY_HOLD', error: result.error, retryable: true, deferred: true, nextAllowedAt: new Date(Date.now() + 60000).toISOString(), ...(result.bellPersisted ? { bellPersisted: true } : {}) };
    }
    if (result.preSendBlocked || (result.guardBlocked && result.code)) {
      return {
        sent: false,
        provider: 'twilio',
        deliveryOutcome: 'not_sent',
        blocked: true,
        code: result.code,
        error: result.error,
        validator: result.validator || (result.preSendBlocked ? 'check_send_window_boundary' : 'check_owned_number_recipient'),
        retryable: result.retryable === true,
        deferred: result.deferred === true,
        nextAllowedAt: result.nextAllowedAt,
        raw: result,
      };
    }
    if (result.success === false) {
      const failure = classifyProviderFailure(null, result.error || (result.guardBlocked ? 'sms-guard blocked' : result.gateBlocked ? 'feature gate blocked' : 'twilio rejected'));
      return {
        sent: false,
        provider: 'twilio',
        // A returned refusal with no lower-layer provenance is conservative:
        // a legacy/mock result might have lost an SDK response. Current
        // sendSMS tags every thrown SDK outcome at the messages.create seam.
        deliveryOutcome: explicitDeliveryOutcome(result.deliveryOutcome)
          || (result.guardBlocked || result.gateBlocked || result.templateDisabled ? 'not_sent' : 'uncertain'),
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
        deliveryOutcome: 'not_sent',
        providerMessageId: 'owner-silence',
        sentAt: new Date().toISOString(),
        raw: result,
      };
    }
    if (result.pushRouted) {
      // GATE_PUSH_CHANNEL_ROUTING: a push_first template with PROVEN device
      // delivery — no SMS was sent; history rows were written by the
      // routing layer inside twilio.js.
      return {
        sent: true,
        provider: 'push',
        deliveryOutcome: 'accepted',
        providerMessageId: result.sid || 'push:delivered',
        sentAt: new Date().toISOString(),
        raw: result,
      };
    }
    return {
      sent: true,
      provider: 'twilio',
      deliveryOutcome: result.suppressed || result.gateBlocked || result.templateDisabled
        ? 'not_sent'
        : (explicitDeliveryOutcome(result.deliveryOutcome) || 'uncertain'),
      providerMessageId: result.sid || null,
      sentAt: new Date().toISOString(),
      raw: result,
      ...(result.withheldLinksRewritten ? { withheldLinksRewritten: result.withheldLinksRewritten } : {}),
    };
  } catch (err) {
    const failure = classifyProviderFailure(err);
    const serviceOutcome = err?.providerOutcome || {};
    const deliveryOutcome = explicitDeliveryOutcome(serviceOutcome.deliveryOutcome) || 'uncertain';
    if (deliveryOutcome === 'accepted') {
      return {
        sent: true,
        provider: 'twilio',
        deliveryOutcome,
        providerMessageId: serviceOutcome.providerMessageId || null,
        sentAt: serviceOutcome.sentAt || new Date().toISOString(),
        error: failure.error,
        providerAlerted: true,
      };
    }
    // A synchronous 21610 is recorded inside TwilioService.sendSMS (the
    // choke point every sender passes through) — see messaging/sync-optout.js.
    return {
      sent: false,
      provider: 'twilio',
      deliveryOutcome,
      error: failure.error,
      retryable: failure.retryable,
      terminal: failure.terminal,
      providerErrorCode: failure.twilioCode,
      providerHttpStatus: failure.httpStatus,
      retryAfterMs: failure.retryAfterMs,
      // TwilioService.sendSMS throws only AFTER scheduling its own
      // twilio_failure bell for the API exception — callers that own a
      // failure alert of their own must not raise a second one for the
      // same provider event.
      providerAlerted: true,
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
    case 'tech_arrived':        return 'tech_arrived';
    case 'service_completion':  return 'service_complete';
    case 'billing':             return 'billing_reminder';
    case 'payment_receipt':     return 'receipt';
    case 'payment_failure':     return 'payment_failure';
    case 'autopay':             return 'autopay';
    case 'payment_link':        return 'payment_link';
    case 'estimate_followup':   return 'manual';
    case 'booking_abandonment_followup': return 'manual';
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
  // Shared with the voice bridge (services/call-bridge.js): the same
  // definitive-vs-ambiguous split decides whether a failed calls.create()
  // may still have reached Twilio.
  classifyProviderFailure,
  SENDER_SIDE_TERMINAL_TWILIO_CODES,
  // Shared with the booking-link lane, which treats a recipient-side
  // rejection as an expected refusal rather than a lane failure.
  RECIPIENT_TERMINAL_TWILIO_CODES,
  // Shared with sendCustomerMessage so the wrapper's MMS-vs-SMS decision
  // (GSM normalization exemption) uses the SAME predicate that decides
  // whether media URLs actually reach Twilio.
  mediaUrlsAllowed,
  _internals: {
    formatProviderError,
    classifyProviderFailure,
    mediaUrlsAllowed,
    providerFailureCode,
    providerFailureStatus,
    providerMediaUrls,
    sanitizeProviderError,
    explicitDeliveryOutcome,
  },
};
