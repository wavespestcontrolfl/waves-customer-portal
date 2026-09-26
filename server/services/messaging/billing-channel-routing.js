const crypto = require('crypto');
const { explicitBillingChannels } = require('../billing-delivery-channels');
const { etDateString } = require('../../utils/datetime-et');

const BILLING_MESSAGE_CATEGORIES = Object.freeze({
  invoice: 'invoice', payment_link: 'invoice', invoice_followup: 'invoice',
  receipt: 'payment_receipt', deposit_receipt: 'payment_receipt',
  billing_reminder: 'billing', late_payment: 'billing', payment_expiry: 'billing',
  autopay: 'billing', autopay_pre_charge: 'billing',
  balance_reminder: 'billing', annual_prepay_payment_reminder: 'billing',
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
  // With no event id, an identical recurring reminder (e.g. payment_expiry
  // repeated after 30 days) hashes to the same body forever. Folding in the
  // ET calendar day lets the same notice recur on a later day while still
  // deduping resends within the same day.
  const identity = eventId
    || [input.invoiceId, input.appointmentId, input.estimateId, etDateString(), input.body].filter(Boolean).join(':');
  return `billing:${input.customerId}:${input.metadata?.original_message_type || input.purpose}:${crypto.createHash('sha256').update(String(identity)).digest('hex')}`;
}

function isReplayHold(result) {
  return result.deferred === true && ['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD', 'APP_PROVIDER_RETRY'].includes(result.code);
}

function needsRetry(result) {
  return result?.retryable || result?.deliveryOutcome === 'uncertain';
}

function selectedLegs(input, prefs, category) {
  const selected = explicitBillingChannels(prefs, category);
  return ['email', 'push', 'sms'].filter((channel) => selected.includes(channel)
    && !(channel === 'email' && input.hasEmailLeg === true));
}

function legFailure(channel, err) {
  const outcome = err.providerOutcome;
  return outcome?.deliveryOutcome === 'accepted'
    ? { ...outcome, sent: true, blocked: false, channel }
    : { sent: false, blocked: false, channel, deliveryOutcome: outcome?.deliveryOutcome || 'not_sent',
      code: 'BILLING_CHANNEL_FAILED', reason: err.message, retryable: true };
}

// One leg through the complete guarded pipeline.
async function sendBillingLeg({ input, channel, channels, channelResults, category, notificationEventKey, sendLeg }) {
  if (channel === 'sms' && !String(input.to || '').trim()) {
    return {
      sent: false, blocked: true, channel: 'sms', deliveryOutcome: 'not_sent',
      code: 'MISSING_SMS_RECIPIENT', reason: 'Text is selected but no phone recipient is available',
    };
  }
  try {
    const metadata = { ...input.metadata, billingDeliveryLeg: channel,
      billingDeliveryCategory: category, notificationEventKey };
    // App acceptance cannot settle pending Email or Text. Its event key
    // dedupes a replay while those selected channels remain unfinished.
    if (channel === 'push' && (channels.includes('sms') || needsRetry(channelResults.email))) {
      delete metadata.scheduled_sms_log_id;
    }
    return await sendLeg({
      ...input, channel: channel === 'push' ? 'sms' : channel,
      metadata,
    });
  } catch (err) {
    return legFailure(channel, err);
  }
}

// A replay hold wins; an unfinished Text outranks an earlier acceptance so
// the caller retries it; otherwise the latest acceptance, then any retry.
function billingDispatchOutcome(channelResults) {
  const results = Object.values(channelResults);
  const accepted = [...results].reverse().find((result) => result.sent && result.deliveryOutcome === 'accepted');
  const retry = results.find(needsRetry);
  const textRetry = needsRetry(channelResults.sms) && channelResults.sms;
  const textAccepted = channelResults.sms?.sent && channelResults.sms.deliveryOutcome === 'accepted';
  const outcome = results.find(isReplayHold)
    || (!textAccepted && (textRetry || retry)) || accepted || retry
    || results[results.length - 1];
  return { ...outcome, channelResults };
}

async function dispatchBillingChannels(input, prefs, sendLeg) {
  const category = billingDeliveryCategory(input);
  const channels = selectedLegs(input, prefs, category);
  if (!channels.length) return {
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CHANNEL_EMAIL_ONLY',
    reason: 'The selected email is delivered by this notice’s email sender', channelResults: {},
  };

  const notificationEventKey = billingNotificationEventKey(input);
  const channelResults = {};
  // Email and App use their existing event deduplication; Text is last. A
  // deferred earlier leg holds Text as well, so the caller can replay without
  // duplicating an accepted text. A selected quiet-hours hold must survive an
  // accepted email.
  for (const channel of channels) {
    channelResults[channel] = await sendBillingLeg({
      input, channel, channels, channelResults, category, notificationEventKey, sendLeg,
    });
    if (isReplayHold(channelResults[channel])) break;
  }
  return billingDispatchOutcome(channelResults);
}

module.exports = {
  BILLING_MESSAGE_CATEGORIES, billingDeliveryCategory, isBillingDeliveryCandidate, usesBillingDeliveryPreferences,
  billingNotificationEventKey, dispatchBillingChannels,
};
