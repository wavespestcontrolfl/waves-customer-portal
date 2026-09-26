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
  // ach_payment_processing is sent with purpose 'payment_failure' (stripe-
  // webhook.js's sendBillingSms) purely for its send-window/consent policy —
  // the notice itself is a no-action "your ACH payment is processing"
  // acknowledgment, not a problem. Every other original_message_type on
  // that purpose (payment_failed, autopay_charge_failed, autopay_retry_*,
  // ach_retry_notice, ach_card_fallback, ach_suspended, bank_verification_*)
  // is a genuine actionable issue and stays payment_issue; this is the one
  // routine confirmation among them.
  ach_payment_processing: 'payment_receipt',
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

// The one list of codes a deferred hold can carry. The four legacy codes
// were copy-pasted across every one-shot producer (billing-cron.js,
// stripe-webhook.js, complete-scheduled-service.js) alongside this file's own
// isReplayHold — a single exported set keeps them from drifting apart.
// BILLING_PREFERENCES_CHANGED is the schedulable shape a preference-change
// refusal on an explicit billing leg now returns (Codex r3 P1 on PR #4843):
// without it here too, a producer's copy of the old 4-code list would never
// persist a retry for it and an Email-only -> Text-only race would drop the
// notice. BILLING_LEG_RETRY (Codex r4 P1 on PR #4843) is the normalized
// shape billingDispatchOutcome now stamps onto ANY leg outcome that is
// retryable and definitely not_sent but arrives under its own one-off code
// (a retryable provider failure, a locked-recheck channel mismatch, a
// hand-rolled leg refusal) — see normalizeRetryableHold below. Without a
// single normalized code here, every new one-off retryable code would need
// its own manual addition to this list (the pattern this fixes: rounds kept
// finding "one more outcome type" a producer's copy of this list rejected).
// A Set (not an array) so every consumer — this file's own isReplayHold and
// invoice.js's hold-literal sites (Codex r4 P2 on #4843) — checks it with
// the same O(1) `.has(code)`, never a re-copied `[...].includes(code)`.
const REPLAY_HOLD_CODES = Object.freeze(new Set([
  'QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD', 'APP_PROVIDER_RETRY',
  'BILLING_PREFERENCES_CHANGED', 'BILLING_LEG_RETRY',
]));

function isReplayHold(result) {
  return result.deferred === true && REPLAY_HOLD_CODES.has(result.code);
}

// Structural fix (Codex r4 P1 on PR #4843): a leg outcome that is retryable
// AND definitely not_sent (nothing went out for that leg) but isn't already
// a recognized replay hold gets normalized into one HERE, at the single
// place every dispatch path funnels through, instead of teaching every
// one-shot producer's own copy of REPLAY_HOLD_CODES about each new one-off
// code a provider or boundary check happens to return. An outcome that is
// already accepted, already a replay hold, or merely `uncertain` (delivery
// unproven — re-sending it risks a duplicate) is left untouched: an
// uncertain leg must never be converted into an automatic replay.
function normalizeRetryableHold(outcome) {
  const accepted = outcome.sent === true && outcome.deliveryOutcome === 'accepted';
  if (accepted || isReplayHold(outcome)) return outcome;
  if (outcome.retryable === true && outcome.deliveryOutcome === 'not_sent') {
    return {
      ...outcome,
      code: 'BILLING_LEG_RETRY',
      deferred: true,
      retryable: true,
      nextAllowedAt: outcome.nextAllowedAt || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      originalCode: outcome.code,
    };
  }
  return outcome;
}

// Shared core shape for every "the customer changed their billing delivery
// preference mid-dispatch" refusal — consent.js's BILLING_PREFERENCES_CHANGED
// and its explicit-leg CHANNEL_NOT_SELECTED, and send-customer-message.js's
// push-leg preference_changed branch. ONE code (BILLING_PREFERENCES_CHANGED)
// so a caller checking against REPLAY_HOLD_CODES/isReplayHold treats all
// three the same: a schedulable hold, not a terminal drop, so the caller's
// replay re-fans-out under the same notificationEventKey against the
// customer's now-current choice. Callers spread in their own `ok`/`sent`/
// `blocked`/`auditLogId` — this only owns the fields that must agree.
function preferenceChangeHold(overrides = {}) {
  return {
    code: 'BILLING_PREFERENCES_CHANGED',
    reason: 'Billing delivery choices changed before delivery',
    deferred: true,
    retryable: true,
    deliveryOutcome: 'not_sent',
    nextAllowedAt: new Date(Date.now() + 60 * 1000).toISOString(),
    ...overrides,
  };
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
    // Email and App legs identify their recipient by the verified customerId
    // (usesBillingDeliveryPreferences falls back to the customer row when no
    // phone is supplied) — the fan-out already verified the caller-supplied
    // phone belongs to the account holder before any leg ran (the top-level
    // usesBillingDeliveryPreferences digit check in send-customer-message.js,
    // before dispatchBillingChannels is ever called). Spreading the ORIGINAL
    // `to` into every leg instead bound Email/App to that SMS phone snapshot:
    // if the customer's phone changes mid-dispatch, each leg's own fresh
    // consent recheck (providerPreparationCheck -> usesBillingDeliveryPreferences)
    // compares that stale phone against the customer's NEW one and refuses
    // with a terminal BILLING_RECIPIENT_CHANGED, even though Email/App never
    // needed a phone at all (Codex r3 P1 on PR #4843).
    return await sendLeg({
      ...input, to: channel === 'sms' ? input.to : null,
      channel: channel === 'push' ? 'sms' : channel,
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
  return { ...normalizeRetryableHold(outcome), channelResults };
}

async function dispatchBillingChannels(input, prefs, sendLeg) {
  const category = billingDeliveryCategory(input);
  const channels = selectedLegs(input, prefs, category);
  // Structural fix (pre-push audit P1 on #4843): computed BEFORE the
  // early return too, and stamped onto EVERY outcome this function
  // returns. A producer that enqueues its own replay row for a billing
  // hold (stripe-webhook.js, billing-cron.js, complete-scheduled-service.js,
  // estimate-deposits.js, invoice.js) reads it off the result and persists
  // it in the queued row's metadata, so the 8AM replay's own
  // billingNotificationEventKey() call finds the SAME persisted key
  // (checked first, before it would otherwise hash the replay row's own
  // now-present scheduled_sms_log_id into a DIFFERENT key) and an
  // already-accepted leg (e.g. Email) is recognized as already-sent
  // instead of resent.
  const notificationEventKey = billingNotificationEventKey(input);
  if (!channels.length) return {
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CHANNEL_EMAIL_ONLY',
    reason: 'The selected email is delivered by this notice’s email sender', channelResults: {}, notificationEventKey,
  };

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
  return { ...billingDispatchOutcome(channelResults), notificationEventKey };
}

module.exports = {
  BILLING_MESSAGE_CATEGORIES, billingDeliveryCategory, isBillingDeliveryCandidate, usesBillingDeliveryPreferences,
  billingNotificationEventKey, dispatchBillingChannels, REPLAY_HOLD_CODES, isReplayHold, preferenceChangeHold,
  normalizeRetryableHold,
};
