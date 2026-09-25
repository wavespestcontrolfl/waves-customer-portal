const crypto = require('crypto');
const { explicitBillingChannels } = require('../billing-delivery-channels');

const BILLING_MESSAGE_CATEGORIES = Object.freeze({
  invoice: 'invoice', payment_link: 'invoice', invoice_followup: 'invoice',
  receipt: 'payment_receipt', deposit_receipt: 'payment_receipt',
  billing_reminder: 'billing', late_payment: 'billing', payment_expiry: 'billing',
  autopay: 'billing', autopay_pre_charge: 'billing',
  payment_failure: 'payment_issue', payment_failed: 'payment_issue',
  autopay_charge_failed: 'payment_issue', autopay_retry_failed: 'payment_issue',
  autopay_retry_final_failed: 'payment_issue', ach_retry_notice: 'payment_issue',
  ach_card_fallback: 'payment_issue', ach_suspended: 'payment_issue',
  bank_verification_incomplete: 'payment_issue', bank_verification_failed: 'payment_issue',
});

function billingDeliveryCategory(input) {
  if (['invoice', 'payment_issue', 'billing', 'payment_receipt'].includes(input.metadata?.billingDeliveryCategory)) {
    return input.metadata.billingDeliveryCategory;
  }
  const type = input.metadata?.original_message_type;
  return BILLING_MESSAGE_CATEGORIES[type] || ({
    payment_link: 'invoice', payment_failure: 'payment_issue',
    payment_receipt: 'payment_receipt', billing: 'billing', autopay: 'billing',
  })[input.purpose] || null;
}

function isBillingDeliveryCandidate(input) {
  const meta = input.metadata || {};
  if (input.audience !== 'customer' || !input.customerId || !['sms', 'push', 'email'].includes(input.channel)) return false;
  if (meta.humanAuthored || meta.media || meta.mediaUrls?.length || meta.bundled_review_request_id || meta.mms_fallback_reason) return false;
  if ((input.operatorInitiated || meta.adminUserId) && meta.useCustomerChannel !== true) return false;
  return Boolean(billingDeliveryCategory(input));
}

function usesBillingDeliveryPreferences(input, contactState) {
  if (!isBillingDeliveryCandidate(input)) return false;
  // A secondary contact's notice must never be copied to the account holder.
  const digits = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
  if (!contactState?.customer || String(contactState.customer.id) !== String(input.customerId)) return false;
  const suppliedRecipient = String(input.to || '').trim();
  if (suppliedRecipient) {
    return digits(suppliedRecipient).length === 10
      && digits(suppliedRecipient) === digits(contactState.customer.phone);
  }
  // Email and App can identify their recipient by the verified customer row.
  // Text remains unavailable without a caller-supplied phone; the dispatcher
  // records that leg as suppressed instead of borrowing another destination.
  return explicitBillingChannels(contactState.prefs, billingDeliveryCategory(input)) !== null;
}

function billingNotificationEventKey(input) {
  if (input.metadata?.notificationEventKey) return input.metadata.notificationEventKey;
  const eventId = input.metadata?.scheduled_sms_log_id || input.metadata?.stripe_event_id
    || input.metadata?.attempt_payment_id || input.metadata?.payment_id || input.paymentId;
  const identity = eventId || [input.invoiceId, input.appointmentId, input.estimateId, input.body].filter(Boolean).join(':');
  return `billing:${input.customerId}:${input.metadata?.original_message_type || input.purpose}:${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

function isReplayHold(result) {
  return result.deferred === true && ['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD', 'APP_PROVIDER_RETRY'].includes(result.code);
}

async function dispatchBillingChannels(input, prefs, sendLeg) {
  const category = billingDeliveryCategory(input);
  const selected = explicitBillingChannels(prefs, category);
  const channels = ['email', 'push', 'sms'].filter((channel) => selected.includes(channel)
    && !(channel === 'email' && input.hasEmailLeg === true));
  if (!channels.length) return {
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CHANNEL_EMAIL_ONLY',
    reason: 'The selected email is delivered by this notice’s email sender', channelResults: {},
  };

  const notificationEventKey = billingNotificationEventKey(input);
  const channelResults = {};
  // Each leg runs the complete guarded pipeline. Email and App use their
  // existing event deduplication; Text is last. A deferred earlier leg holds
  // Text as well, so the caller can replay without duplicating an accepted
  // text. A selected quiet-hours hold must survive an accepted email.
  for (const channel of channels) {
    if (channel === 'sms' && !String(input.to || '').trim()) {
      channelResults.sms = {
        sent: false, blocked: true, channel: 'sms', deliveryOutcome: 'not_sent',
        code: 'MISSING_SMS_RECIPIENT', reason: 'Text is selected but no phone recipient is available',
      };
      continue;
    }
    try {
      const metadata = { ...input.metadata, billingDeliveryLeg: channel,
        billingDeliveryCategory: category, notificationEventKey };
      // App acceptance is not proof that a selected Text was sent. Its event
      // key dedupes a replay if the process stops before the final Text leg.
      if (channel === 'push' && channels.includes('sms')) delete metadata.scheduled_sms_log_id;
      channelResults[channel] = await sendLeg({
        ...input, channel: channel === 'push' ? 'sms' : channel,
        metadata,
      });
    } catch (err) {
      const outcome = err.providerOutcome;
      channelResults[channel] = outcome?.deliveryOutcome === 'accepted'
        ? { ...outcome, sent: true, blocked: false, channel }
        : { sent: false, blocked: false, channel, deliveryOutcome: outcome?.deliveryOutcome || 'not_sent',
          code: 'BILLING_CHANNEL_FAILED', reason: err.message, retryable: true };
    }
    if (isReplayHold(channelResults[channel])) break;
  }
  const results = Object.values(channelResults);
  const accepted = [...results].reverse().find((result) => result.sent && result.deliveryOutcome === 'accepted');
  const retry = results.find((result) => result.retryable || result.deliveryOutcome === 'uncertain');
  const textAccepted = channelResults.sms?.sent && channelResults.sms.deliveryOutcome === 'accepted';
  const outcome = results.find(isReplayHold)
    || (!textAccepted && retry) || accepted || retry
    || results[results.length - 1];
  return { ...outcome, channelResults };
}

module.exports = {
  BILLING_MESSAGE_CATEGORIES, billingDeliveryCategory, isBillingDeliveryCandidate, usesBillingDeliveryPreferences,
  billingNotificationEventKey, dispatchBillingChannels,
};
