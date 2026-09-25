const db = require('../models/db');
const logger = require('./logger');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');
const { billingChannelAllowed } = require('./billing-delivery-channels');
const { dateOnlyString } = require('../utils/date-only');
const { withCustomerCommsLock } = require('../utils/customer-comms-lock');
const { isEnabled } = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { loadRetryContext, classifyFailedPaymentRetry, DISPOSITIONS } = require('./retry-collectibility');

const ENTRY_POINT = 'billing_retry_email_deferred';
const DESCRIPTOR_FIELD = 'billing_retry_email_notice';
const COVERED_REASONS = new Set(['enrolled', 'deduped', 'no_email', 'no_customer']);

function retryDateKey(retryDate) {
  return dateOnlyString(retryDate) || String(retryDate || '').slice(0, 10);
}

function obligationKey(paymentId, retryDate) {
  return `payment.retry_notice:${paymentId}:${retryDateKey(retryDate)}`;
}

function pendingDescriptor({ customerId, paymentId, retryDate, preferenceState }) {
  return {
    key: obligationKey(paymentId, retryDate),
    customer_id: customerId,
    payment_id: paymentId,
    retry_date: retryDateKey(retryDate),
    preference_state: preferenceState === undefined ? 'unknown' : 'explicit',
    state: 'pending_decision',
  };
}

function mergePendingDescriptor(database, descriptor) {
  return database.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(?, ?::jsonb)", [
    DESCRIPTOR_FIELD, JSON.stringify(descriptor),
  ]);
}

function metadataObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

async function currentEmailChoice(customerId, database = db) {
  try {
    const prefs = await database('notification_prefs').where({ customer_id: customerId }).first();
    return billingChannelAllowed(prefs || {}, 'payment_issue', 'email');
  } catch (err) {
    logger.warn(`[billing-retry-email] preference lookup failed for ${customerId}; preserving a guarded replay: ${err.message}`);
    return undefined;
  }
}

async function clearDescriptor(trx, paymentId, key) {
  return trx('payments').where({ id: paymentId })
    .whereRaw("metadata->?->>'key' = ?", [DESCRIPTOR_FIELD, key])
    .update({ metadata: trx.raw('metadata - ?', [DESCRIPTOR_FIELD]) });
}

async function ensureObligation(descriptor, database = db) {
  const choice = await currentEmailChoice(descriptor.customer_id, database);
  const queueUnknownLegacy = choice === null && descriptor.preference_state === 'unknown';
  return withCustomerCommsLock(database, descriptor.customer_id, async (trx) => {
    const payment = await trx('payments').where({
      id: descriptor.payment_id, customer_id: descriptor.customer_id,
    }).first('id', 'status', 'next_retry_at', 'metadata');
    const current = metadataObject(payment?.metadata)[DESCRIPTOR_FIELD];
    if (!payment || current?.key !== descriptor.key) return { queued: false, stale: true };
    if (payment.status !== 'failed' || retryDateKey(payment.next_retry_at) !== descriptor.retry_date) {
      await clearDescriptor(trx, descriptor.payment_id, descriptor.key);
      return { queued: false, stale: true };
    }
    if (choice === false || (choice === null && !queueUnknownLegacy)) {
      await clearDescriptor(trx, descriptor.payment_id, descriptor.key);
      return { queued: false, unselected: choice === false, legacy: choice === null };
    }
    const customer = await trx('customers').where({ id: descriptor.customer_id }).first('id', 'phone');
    if (!customer) return { queued: false, unavailable: true };
    const existing = await trx('sms_log')
      .whereRaw("metadata->>'billing_retry_email_key' = ?", [descriptor.key])
      .first('id', 'status');
    if (existing) {
      await clearDescriptor(trx, descriptor.payment_id, descriptor.key);
      return { queued: true, id: existing.id, duplicate: true, key: descriptor.key };
    }
    const fallbackPhone = TWILIO_NUMBERS.getOutboundNumber();
    const [row] = await trx('sms_log').insert({
      customer_id: descriptor.customer_id,
      direction: 'outbound',
      from_phone: fallbackPhone,
      to_phone: customer.phone || '',
      message_body: 'Deferred payment retry email obligation',
      message_type: 'payment_retry_email',
      status: 'scheduled',
      scheduled_for: new Date(Date.now() + 5 * 60 * 1000),
      metadata: JSON.stringify({
        entry_point: ENTRY_POINT,
        requires_registered_dispatch: true,
        replay_purpose: 'payment_failure',
        billingDeliveryCategory: 'payment_issue',
        refresh_customer_phone: true,
        customer_id: descriptor.customer_id,
        payment_id: descriptor.payment_id,
        retry_date: descriptor.retry_date,
        preference_state: descriptor.preference_state,
        billing_retry_email_key: descriptor.key,
      }),
    }).returning('id');
    await clearDescriptor(trx, descriptor.payment_id, descriptor.key);
    return { queued: true, id: row.id, key: descriptor.key };
  });
}

async function reconcilePendingNotices({ paymentId = null, limit = 50, database = db } = {}) {
  let query = database('payments')
    .whereRaw("metadata->?->>'state' = 'pending_decision'", [DESCRIPTOR_FIELD])
    .orderBy('updated_at', 'asc').limit(limit);
  if (paymentId) query = query.where({ id: paymentId });
  const payments = await query;
  let queued = 0;
  for (const payment of payments) {
    const descriptor = metadataObject(payment.metadata)[DESCRIPTOR_FIELD];
    if (!descriptor?.key) continue;
    try {
      const result = await ensureObligation(descriptor, database);
      if (result.queued) queued++;
    } catch (err) {
      logger.warn(`[billing-retry-email] descriptor ${descriptor.key} remains pending: ${err.message}`);
    }
  }
  return { checked: payments.length, queued };
}

async function automationCoverage(customerId, database = db) {
  try {
    const row = await database('automation_enrollments')
      .where({ customer_id: customerId, template_key: 'payment_failed' })
      .where(function deliveredOrActive() {
        this.where('status', 'active').orWhereNotNull('last_sent_at');
      })
      .where('enrolled_at', '>', new Date(Date.now() - 14 * 24 * 3600 * 1000))
      .first('id');
    return row ? true : false;
  } catch (err) {
    logger.warn(`[billing-retry-email] automation coverage unavailable for ${customerId}: ${err.message}`);
    return undefined;
  }
}

async function updateQueueMetadata(database, id, fields, { requireUnstarted = false } = {}) {
  let query = database('sms_log').where({ id, status: 'sending' });
  if (requireUnstarted) query = query.whereRaw("metadata->>'billing_retry_email_provider_started_at' IS NULL");
  return query.update({
    metadata: database.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(fields)]),
    updated_at: new Date(),
  });
}

async function clearProviderMarker(database, id) {
  return database('sms_log').where({ id, status: 'sending' }).update({
    metadata: database.raw("COALESCE(metadata, '{}'::jsonb) - 'billing_retry_email_provider_started_at'"),
    updated_at: new Date(),
  });
}

async function replayPaymentRetryNotice(meta = {}, database = db) {
  const payment = await database('payments').where({ id: meta.payment_id }).first();
  if (!payment || String(payment.customer_id) !== String(meta.customer_id)) {
    return { sent: false, blocked: true, code: 'PAYMENT_OWNERSHIP_CHANGED', deliveryOutcome: 'not_sent' };
  }
  if (payment.status !== 'failed' || payment.superseded_by_payment_id || Number(payment.retry_count || 0) >= 3
      || retryDateKey(payment.next_retry_at) !== retryDateKey(meta.retry_date)) {
    return { sent: false, blocked: true, code: 'PAYMENT_RETRY_SUPERSEDED', deliveryOutcome: 'not_sent' };
  }
  const customer = await database('customers').where({ id: meta.customer_id }).first();
  if (!customer) return { sent: false, blocked: true, code: 'CUSTOMER_NOT_FOUND', deliveryOutcome: 'not_sent' };
  try {
    const ctx = loadRetryContext({ conn: database });
    const eligibility = await classifyFailedPaymentRetry({ payment, customer, ctx, conn: database });
    if (ctx.lookupWarnings.length) throw new Error('Retry eligibility lookup unavailable');
    if (eligibility.disposition !== DISPOSITIONS.CHARGE) {
      return { sent: false, blocked: true, code: 'PAYMENT_RETRY_NO_LONGER_ELIGIBLE',
        reason: eligibility.reason, deliveryOutcome: 'not_sent' };
    }
  } catch {
    return { sent: false, retryable: true, code: 'PAYMENT_RETRY_ELIGIBILITY_UNAVAILABLE', deliveryOutcome: 'not_sent' };
  }
  const choice = await currentEmailChoice(meta.customer_id, database);
  if (choice === undefined) {
    return { sent: false, retryable: true, code: 'BILLING_PREFS_UNAVAILABLE', deliveryOutcome: 'not_sent' };
  }
  if (choice !== true && !(choice === null && meta.preference_state === 'unknown')) {
    return { sent: false, blocked: true, code: 'BILLING_EMAIL_NOT_SELECTED', deliveryOutcome: 'not_sent' };
  }
  if (meta.billing_retry_email_provider_started_at) {
    return { sent: false, blocked: true, code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN', deliveryOutcome: 'uncertain' };
  }

  let mode = meta.billing_retry_email_mode;
  if (!mode) {
    const covered = await automationCoverage(meta.customer_id, database);
    if (covered === undefined) {
      return { sent: false, retryable: true, code: 'AUTOMATION_COVERAGE_UNAVAILABLE', deliveryOutcome: 'not_sent' };
    }
    if (covered) return { sent: true, channel: 'email', code: 'AUTOMATION_COVERED', deliveryOutcome: 'accepted' };
    if (isEnabled('paymentFailedEnroll')) {
      const result = await require('./automation-enroll').enrollSequenceFromEvent({
        templateKey: 'payment_failed', customerId: meta.customer_id, dedupe: 14,
        recipient: 'billing', checkSuppression: true, retryFailedUnsent: false,
        source: 'billing_retry_email_deferred',
      });
      if (COVERED_REASONS.has(result?.reason)) {
        return { sent: true, channel: 'email', code: 'AUTOMATION_ENROLLED', deliveryOutcome: 'accepted' };
      }
      if (result?.reason === 'error') {
        return { sent: false, retryable: true, code: 'AUTOMATION_ENROLL_FAILED', deliveryOutcome: 'not_sent' };
      }
    }
    mode = 'branded';
    if (!meta.scheduled_sms_log_id
        || await updateQueueMetadata(database, meta.scheduled_sms_log_id, { billing_retry_email_mode: mode }) !== 1) {
      return { sent: false, retryable: true, code: 'BILLING_EMAIL_MODE_PERSIST_FAILED', deliveryOutcome: 'not_sent' };
    }
  }

  let providerStarted = false;
  const beforeProviderHandoff = async () => {
    if (!meta.scheduled_sms_log_id) return false;
    const stamped = await updateQueueMetadata(database, meta.scheduled_sms_log_id, {
      billing_retry_email_provider_started_at: new Date().toISOString(),
    }, { requireUnstarted: true });
    providerStarted = stamped === 1;
    return providerStarted;
  };
  let result;
  try {
    result = await PaymentLifecycleEmail.sendPaymentRetryNotice({
      customerId: meta.customer_id,
      paymentId: meta.payment_id,
      retryDate: meta.retry_date,
      idempotencyKey: meta.billing_retry_email_key || obligationKey(meta.payment_id, meta.retry_date),
      beforeProviderHandoff,
    });
  } catch {
    return providerStarted
      ? { sent: false, blocked: true, code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN', deliveryOutcome: 'uncertain' }
      : { sent: false, retryable: true, code: 'BILLING_EMAIL_PREP_FAILED', deliveryOutcome: 'not_sent' };
  }
  if (result?.ok === true && result.deliveryOutcome === 'accepted') {
    return { sent: true, channel: 'email', deliveryOutcome: 'accepted', providerMessageId: result.messageId || null };
  }
  if (result?.deliveryOutcome === 'not_sent') {
    if (providerStarted && await clearProviderMarker(database, meta.scheduled_sms_log_id) !== 1) {
      return { sent: false, blocked: true, code: 'BILLING_EMAIL_MARKER_CLEAR_FAILED', deliveryOutcome: 'uncertain' };
    }
    return result.retryable === true
      ? { sent: false, retryable: true, code: 'BILLING_EMAIL_RETRY', deliveryOutcome: 'not_sent', reason: result.reason }
      : { sent: false, blocked: true, code: result.reason || 'BILLING_EMAIL_NOT_SENT', deliveryOutcome: 'not_sent' };
  }
  return { sent: false, blocked: true, code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN', deliveryOutcome: 'uncertain' };
}

async function sendPaymentRetryNotice({ customerId, paymentId, retryDate, legacy = false }) {
  if (legacy) return PaymentLifecycleEmail.sendPaymentRetryNotice({ customerId, paymentId, retryDate });
  const choice = await currentEmailChoice(customerId);
  if (choice !== null) return { ok: false, skipped: true, reason: 'deferred_owner_required', retryable: true };
  return PaymentLifecycleEmail.sendPaymentRetryNotice({ customerId, paymentId, retryDate });
}

module.exports = {
  ENTRY_POINT,
  DESCRIPTOR_FIELD,
  obligationKey,
  pendingDescriptor,
  mergePendingDescriptor,
  currentEmailChoice,
  ensureObligation,
  reconcilePendingNotices,
  sendPaymentRetryNotice,
  replayPaymentRetryNotice,
};
