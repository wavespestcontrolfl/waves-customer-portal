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

// The Stripe ACH "processing" acknowledgment sends its own lifecycle email
// and carries no stable event key, so explicit routing would duplicate that
// email and could resend it on replay. It stays on its legacy path until its
// producer adopts the router contract.
const LEGACY_ONLY_MESSAGE_TYPES = new Set(['ach_payment_processing']);

function billingDeliveryCategory(input) {
  if (['invoice', 'payment_issue', 'billing', 'payment_receipt'].includes(input.metadata?.billingDeliveryCategory)) {
    return input.metadata.billingDeliveryCategory;
  }
  const type = input.metadata?.original_message_type;
  if (LEGACY_ONLY_MESSAGE_TYPES.has(type)) return null;
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
// notice. SUPPRESSION_LOOKUP_FAILED is the same kind of schedulable hold for
// an explicit Email/App leg whose suppression state could not be read, and
// BILLING_EMAIL_PREPARATION_HOLD for a retryable Email refusal before the
// provider handoff, or a definite SendGrid rejection after it
// (billing-channel-email.js). BILLING_TEXT_DEDUPE_UNAVAILABLE
// is the same kind of schedulable hold for an explicit Text leg whose dedupe
// state (the advisory-lock check, or the prior-accepted-send lookup) could
// not be read. BILLING_TEXT_LEG_IN_FLIGHT is the Text leg's own
// concurrency guard: a genuinely concurrent replay on the exact same
// customer+notice found either the non-blocking claim lock already taken
// or a fresh, unexpired claim row — never sent, so the caller retries
// shortly rather than racing the attempt already in flight (messaging/
// billing-text-leg-dedupe.js).
const REPLAY_HOLD_CODES = Object.freeze([
  'QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD', 'APP_PROVIDER_RETRY',
  'BILLING_PREFERENCES_CHANGED', 'SUPPRESSION_LOOKUP_FAILED', 'BILLING_EMAIL_PREPARATION_HOLD',
  'BILLING_TEXT_DEDUPE_UNAVAILABLE', 'BILLING_TEXT_LEG_IN_FLIGHT',
  // An active collections dispute hold (or an unverifiable one) on a delayed
  // pay-link leg: wait, never fail (collections/collection-hold.js).
  'COLLECTION_HOLD_DEFER',
]);

function isReplayHold(result) {
  if (result.bellPersisted === true || result.reason === 'app_event_already_visible') return false;
  return result.deferred === true && REPLAY_HOLD_CODES.includes(result.code);
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

// This is event settlement, not evidence that retry copy reached a device.
// Only the guarded push path can supply either bell witness.
function billingLegDeliveryState(channel, result = {}) {
  if (channel === 'push' && result.deliveryOutcome === 'not_sent'
    && result.reason === 'app_event_already_visible') return 'deduped';
  if (result.deliveryOutcome === 'accepted') return result.deduped ? 'deduped' : 'delivered';
  if (channel === 'email' && result.ok === true && result.deliveryOutcome === undefined) return result.deduped ? 'deduped' : 'delivered';
  return channel === 'push' && result.bellPersisted === true ? 'delivered' : null;
}

// A deduped Email/Text leg exposes the original acceptance as sentAt; a
// persisted App bell exposes eventVisibleAt. Return only valid stored evidence
// and leave legacy missing-evidence behavior to each caller.
function billingLegContactTime(result = {}) {
  const candidates = result.deduped && result.channelResults
    ? Object.entries(result.channelResults)
      .filter(([channel, leg]) => billingLegDeliveryState(channel, leg) === 'deduped')
      .flatMap(([, leg]) => [leg.sentAt, leg.eventVisibleAt])
      .concat([result.sentAt, result.eventVisibleAt, result.originalAt])
    : result.deduped ? [result.sentAt, result.eventVisibleAt, result.originalAt] : [result.eventVisibleAt];
  const times = candidates.filter(Boolean).map((candidate) => new Date(candidate))
    .filter((time) => !Number.isNaN(time.getTime()));
  return times.length ? new Date(Math.max(...times.map((time) => time.getTime()))) : null;
}

function storedEmailAcceptedAt(message = {}) {
  for (const candidate of [message?.sent_at, message?.created_at]) {
    if (candidate == null) continue;
    const time = new Date(candidate);
    if (!Number.isNaN(time.getTime())) return time;
  }
  return null;
}

// A replay may close progress only when every accepted rail belongs to an
// earlier episode. The same decision governs invoice and collections writers.
function previouslySettledBillingLegs(results) {
  const accepted = results.filter((result) => result?.sent === true || result?.ok === true);
  if (!accepted.length || accepted.some((result) => result.deduped !== true)) return null;
  const times = accepted.map(billingLegContactTime).filter(Boolean);
  return { originalAt: times.length
    ? new Date(Math.max(...times.map((time) => time.getTime()))) : null };
}

function originalBillingContactArgs(result) {
  const originalAt = result?.deduped ? billingLegContactTime(result) : null;
  return originalAt ? [{ occurredAt: originalAt }] : [];
}

function needsRetry(result) {
  if (result?.bellPersisted === true || result?.reason === 'app_event_already_visible') return false;
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
    : { ...outcome, sent: false, blocked: false, channel, deliveryOutcome: outcome?.deliveryOutcome || 'not_sent',
      code: 'BILLING_CHANNEL_FAILED', reason: outcome?.reason || outcome?.error || err.message, retryable: true };
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
  const settled = Object.entries(channelResults).reverse().map(([channel, result]) => {
    const state = billingLegDeliveryState(channel, result);
    if (!state) return null;
    // The aggregate reports settlement of the event. The leg retains its
    // actual native outcome and never gains a provider id or current bell.
    return { ...result, sent: true, blocked: false, deliveryOutcome: 'accepted',
      retryable: false, deferred: false, ...(state === 'deduped' ? { deduped: true } : {}) };
  }).filter(Boolean);
  const accepted = settled.find((result) => !result.deduped) || settled[0];
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
  // Stamped on every outcome so a producer that queues its own replay row
  // can persist it; the replay then reuses this key instead of hashing the
  // replay row's own id, and an accepted leg dedupes. Producers adopt that
  // in their own follow-up PRs.
  const notificationEventKey = billingNotificationEventKey(input);
  if (!channels.length) {
    // Only Email is selected and the caller's own email sender owns it:
    // CHANNEL_EMAIL_ONLY tells the caller to send that email. Anything else
    // here is a selection with no deliverable channel.
    const callerOwnsEmail = input.hasEmailLeg === true
      && explicitBillingChannels(prefs, category).includes('email');
    return callerOwnsEmail ? {
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CHANNEL_EMAIL_ONLY',
      reason: 'The selected email is delivered by this notice’s email sender', channelResults: {}, notificationEventKey,
    } : {
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'NO_BILLING_CHANNEL_SELECTED',
      reason: 'No delivery channel is selected for this billing notice', channelResults: {}, notificationEventKey,
    };
  }

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
  billingNotificationEventKey, dispatchBillingChannels, REPLAY_HOLD_CODES, isReplayHold, preferenceChangeHold, billingLegDeliveryState,
  billingLegContactTime, previouslySettledBillingLegs, originalBillingContactArgs, storedEmailAcceptedAt,
};
