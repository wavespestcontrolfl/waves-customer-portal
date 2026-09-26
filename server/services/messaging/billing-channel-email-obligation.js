const db = require('../../models/db');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { withCustomerCommsLock } = require('../../utils/customer-comms-lock');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { isPaused, getChargeableAutopayMethod, isBankMethodType } = require('../autopay-eligibility');
const { resolveBillingLane } = require('../billing-lane');

const ENTRY_POINT = 'billing_channel_email_deferred';
const RETRY_DELAY_MS = 5 * 60 * 1000;
const INVOICE_GUARDS = new Set([
  'invoice_followup_sequence', 'balance_reminder_workflow',
  'balance_reminder_late_payment_check', 'late_payment_checker',
]);

function obligationKey(eventKey) {
  return `billing_channel_email:${eventKey}:email`;
}

function emailEvidence(message, safeAttemptToken) {
  if (!message) return 'not_sent';
  if (message.provider_message_id || ['sent', 'delivered'].includes(message.status)) return 'accepted';
  if (message.status === 'failed'
    && (message.error_message === require('../email-template-library').ABORTED_BEFORE_DISPATCH
      || (safeAttemptToken && message.send_attempt_token === safeAttemptToken))) return 'not_sent';
  // A transport timeout is also persisted as failed. Only a recorded
  // pre-provider refusal or this owner's definite result permits retry.
  return 'uncertain';
}

function supportedGuard(input) {
  if (input.withSmsHandoff || input.withProviderHandoff || input.providerHandoffReservation) return false;
  if (!input.preDispatchCheck && !input.preSendCheck && !input.preProviderCheck && !input.providerPreSendCheck) return true;
  if (input.preSendCheck || input.preProviderCheck || input.providerPreSendCheck) return false;
  if (input.entryPoint === 'autopay_pre_charge_reminder') return Boolean(input.metadata?.charge_date);
  return INVOICE_GUARDS.has(input.entryPoint) && Boolean(input.invoiceId);
}

function existingOutcome(row) {
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  const uncertain = row.status === 'blocked' && metadata.billing_email_uncertain === true;
  const accepted = ['sent', 'delivered'].includes(row.status);
  const blocked = row.status === 'blocked';
  return {
    sent: accepted, channel: 'email', deliveryOutcome: uncertain ? 'uncertain' : accepted ? 'accepted' : 'not_sent',
    blocked, deferred: !accepted && !blocked, retryable: false,
    code: uncertain ? 'BILLING_EMAIL_DELIVERY_UNCERTAIN'
      : blocked ? 'BILLING_EMAIL_RETRY_EXHAUSTED'
        : accepted ? 'BILLING_EMAIL_ALREADY_DELIVERED' : 'BILLING_EMAIL_RETRY_OWNED',
    scheduledSmsLogId: row.id,
    siblingStates: metadata.billing_email_siblings || {},
  };
}

async function findObligation(customerId, eventKey, database = db) {
  const row = await database('sms_log').where({ customer_id: customerId })
    .whereRaw("metadata->>'billing_channel_email_key' = ?", [obligationKey(eventKey)])
    .first('id', 'status', 'metadata');
  return row ? existingOutcome(row) : null;
}

async function queueObligation(input, category, eventKey, result, siblings = [], database = db) {
  if (!supportedGuard(input)) return {
    queued: false, code: 'BILLING_EMAIL_GUARD_UNSERIALIZABLE',
    reason: 'The producer eligibility check cannot be reconstructed on replay',
  };
  const uncertain = result?.deliveryOutcome !== 'not_sent';
  const key = obligationKey(eventKey);
  return withCustomerCommsLock(database, input.customerId, async (trx) => {
    const existing = await trx('sms_log').where({ customer_id: input.customerId })
      .whereRaw("metadata->>'billing_channel_email_key' = ?", [key])
      .first('id', 'status', 'metadata');
    if (existing) {
      if (uncertain) {
        await trx('sms_log').where({ id: existing.id }).whereNotIn('status', ['sent', 'delivered'])
          .update({ status: 'blocked', metadata: trx.raw(
            "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('billing_email_uncertain', true)"),
          updated_at: new Date() });
        const current = await trx('sms_log').where({ id: existing.id }).first('id', 'status', 'metadata');
        return { queued: true, duplicate: true, ...existingOutcome(current) };
      }
      return { queued: true, duplicate: true, ...existingOutcome(existing) };
    }
    // A collision with an earlier caller can report not_sent while that
    // caller's provider handoff is still in flight. A stale queued Email
    // row is NOT proof that SendGrid refused it; hold it even past the
    // template library's own stale-row reclaim window.
    const emailMessage = await trx('email_messages').where({ idempotency_key: key })
      .first('status', 'provider_message_id', 'recipient_id', 'error_message', 'send_attempt_token');
    if (emailMessage?.recipient_id && String(emailMessage.recipient_id) !== String(input.customerId)) {
      return { queued: false, code: 'BILLING_EMAIL_KEY_COLLISION',
        reason: 'An Email idempotency key belongs to another customer' };
    }
    const evidence = emailEvidence(emailMessage);
    const accepted = evidence === 'accepted';
    const holdUncertain = !accepted && (uncertain || evidence === 'uncertain');
    const metadata = {
      entry_point: ENTRY_POINT,
      requires_registered_dispatch: true,
      replay_purpose: input.purpose,
      customer_id: input.customerId,
      source_entry_point: input.entryPoint || null,
      billingDeliveryCategory: category,
      billingDeliveryLeg: 'email',
      channel: 'email',
      notificationEventKey: eventKey,
      billing_channel_email_key: key,
      billing_email_uncertain: holdUncertain,
      billing_email_siblings: Object.fromEntries(siblings.map((channel) => [channel, 'pending'])),
      original_message_type: input.metadata?.original_message_type || null,
      invoice_id: input.invoiceId || null,
      estimate_id: input.estimateId || null,
      appointment_id: input.appointmentId || null,
      charge_date: input.metadata?.charge_date || null,
      payment_method_id: input.metadata?.payment_method_id || null,
      expiry_month: input.metadata?.expiry_month || null,
      expiry_year: input.metadata?.expiry_year || null,
      expiry_stage: input.metadata?.expiry_stage || null,
      billing_mode_at_send: input.metadata?.billing_mode_at_send || null,
      customer_initiated: input.customerInitiated === true,
    };
    const [row] = await trx('sms_log').insert({
      customer_id: input.customerId,
      direction: 'outbound',
      from_phone: TWILIO_NUMBERS.getOutboundNumber(),
      // The registered dispatcher never sends Text and resolves the Email
      // recipient fresh. An empty phone is the existing email-queue contract.
      to_phone: '',
      message_body: input.body,
      message_type: input.metadata?.original_message_type || category,
      status: accepted ? 'sent' : holdUncertain ? 'blocked' : 'scheduled',
      scheduled_for: new Date(Date.now() + RETRY_DELAY_MS),
      metadata: JSON.stringify(metadata),
    }).returning('id');
    return { queued: true, id: row.id, uncertain: holdUncertain, accepted };
  });
}

async function markProviderStarted(id, database = db) {
  const changed = await database('sms_log').where({ id, status: 'sending' })
    .whereRaw("metadata->>'billing_email_provider_started_at' IS NULL")
    .whereRaw("COALESCE(metadata->>'billing_email_uncertain', 'false') <> 'true'")
    .update({ metadata: database.raw(
      "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('billing_email_provider_started_at', ?::timestamptz)",
      [new Date()],
    ), updated_at: new Date() });
  return changed === 1;
}

async function clearProviderStarted(id, database = db) {
  const owner = await database('sms_log').where({ id }).first('metadata');
  const meta = typeof owner?.metadata === 'string' ? JSON.parse(owner.metadata) : owner?.metadata;
  const message = meta?.billing_channel_email_key && await database('email_messages')
    .where({ idempotency_key: meta.billing_channel_email_key }).first('send_attempt_token');
  const changed = await database('sms_log').where({ id, status: 'sending' })
    .whereRaw("metadata->>'billing_email_provider_started_at' IS NOT NULL")
    .update({ metadata: database.raw(
      "(COALESCE(metadata, '{}'::jsonb) - 'billing_email_provider_started_at') || jsonb_build_object('billing_email_safe_attempt_token', ?::text)",
      [message?.send_attempt_token || null]),
      updated_at: new Date() });
  return changed === 1;
}

async function transitionSibling(queueId, channel, from, to, database = db) {
  if (!queueId || !['push', 'sms'].includes(channel)) return false;
  const changed = await database('sms_log').where({ id: queueId })
    .whereRaw("metadata->'billing_email_siblings'->>? = ?", [channel, from])
    .update({
      metadata: database.raw(
        "jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY['billing_email_siblings', ?::text], to_jsonb(?::text), true)",
        [channel, to],
      ),
      updated_at: new Date(),
    });
  return changed === 1;
}

async function claimSibling(queueId, channel, database = db) {
  return await transitionSibling(queueId, channel, 'pending', 'started', database)
    || transitionSibling(queueId, channel, 'not_sent', 'started', database);
}

function refused(code, retryable = false) {
  return { eligible: false, reason: code, retryable };
}

async function selectedExpiryMethod(customer, source, database) {
  // Both producers first use the charge path's current method. The Monday
  // warning alone falls back to the expired card it would have charged when
  // no method is chargeable. An expired pointer must not outrank a healthy
  // default — the charge path would fall through to that default.
  const current = await getChargeableAutopayMethod(customer, database, { now: new Date(), rethrow: true });
  if (current || source !== 'autopay_card_expiry_warning') return current;
  const methods = await database('payment_methods')
    .where({ customer_id: customer.id, processor: 'stripe', autopay_enabled: true })
    .whereNotNull('stripe_payment_method_id')
    .orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'asc' }])
    .select('id', 'method_type', 'is_default');
  const pointer = methods.find((item) => String(item.id) === String(customer.autopay_payment_method_id));
  return pointer && !isBankMethodType(pointer.method_type)
    ? pointer : methods.find((item) => item.is_default === true && !isBankMethodType(item.method_type)) || null;
}

async function producerEligible(meta, database = db) {
  if (meta.source_entry_point === 'autopay_pre_charge_reminder') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.charge_date || '')) return refused('charge-date-missing');
    if (etDateString(addETDays(new Date(), 3)) !== meta.charge_date) return refused('charge-date-passed');
    const customer = await database('customers').where({ id: meta.customer_id }).first();
    if (!customer || customer.deleted_at || customer.active !== true || customer.autopay_enabled !== true
      || !(Number(customer.monthly_rate) > 0) || resolveBillingLane(customer).mode !== 'monthly_membership'
      || Number(customer.billing_day) !== Number(meta.charge_date.slice(-2))
      || isPaused(customer, new Date(`${meta.charge_date}T12:00:00Z`))) return refused('precharge-no-longer-eligible');
  }
  if (['autopay_card_expiry_warning', 'payment_expiry_workflow'].includes(meta.source_entry_point)) {
    if (!meta.payment_method_id || !meta.expiry_month || !meta.expiry_year) return refused('expiry-pin-missing');
    const customer = await database('customers').where({ id: meta.customer_id }).first();
    if (!customer || customer.deleted_at || customer.active !== true) return refused('customer-no-longer-active');
    if (meta.source_entry_point === 'autopay_card_expiry_warning' && customer.autopay_enabled !== true) {
      return refused('autopay-disabled');
    }
    const method = await database('payment_methods').where({ id: meta.payment_method_id, customer_id: meta.customer_id }).first();
    if (!method || method.processor !== 'stripe' || method.autopay_enabled !== true
      || !method.stripe_payment_method_id || isBankMethodType(method.method_type)
      || Number(method.exp_month) !== Number(meta.expiry_month)
      || Number(method.exp_year) % 100 !== Number(meta.expiry_year) % 100) return refused('expiry-method-changed');
    const selected = await selectedExpiryMethod(customer, meta.source_entry_point, database);
    if (String(selected?.id) !== String(method.id)) return refused('expiry-method-replaced');
    const [year, month] = etDateString().split('-').map(Number);
    const expiryYear = Number(method.exp_year) < 100 ? Number(method.exp_year) + 2000 : Number(method.exp_year);
    const expiryMonth = Number(method.exp_month);
    if (meta.source_entry_point === 'payment_expiry_workflow') {
      const next = month === 12 ? [year + 1, 1] : [year, month + 1];
      if (!((expiryYear === year && expiryMonth === month) || (expiryYear === next[0] && expiryMonth === next[1]))) {
        return refused('expiry-window-passed');
      }
      const { FORMER_CUSTOMER_STAGES } = require('../customer-stages');
      if (FORMER_CUSTOMER_STAGES.includes(customer.pipeline_stage) || customer.pipeline_stage === 'lost') return refused('former-customer');
      if (!['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)) {
        const paid = await database('payments').where({ customer_id: customer.id, status: 'paid' }).first('id');
        const upcoming = await database('scheduled_services').where({ customer_id: customer.id })
          .whereIn('status', ['pending', 'confirmed']).where('scheduled_date', '>=', etDateString()).first('id');
        if (!paid && !upcoming) return refused('payment-relationship-ended');
      }
    } else {
      const horizon = etDateString(addETDays(new Date(), 60));
      const first = `${expiryYear}-${String(expiryMonth).padStart(2, '0')}-01`;
      if (first > horizon) return refused('expiry-window-passed');
      const expired = `${expiryYear}-${String(expiryMonth).padStart(2, '0')}` < etDateString().slice(0, 7);
      if ((meta.expiry_stage === 'expired') !== expired) return refused('expiry-stage-changed');
    }
    const { getCardExpiryExemptions } = require('../annual-prepay-renewals');
    const { isCardExpiryExemptMethod } = require('../card-expiry-exemptions');
    const horizon = meta.source_entry_point === 'payment_expiry_workflow'
      ? new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10)
      : etDateString(addETDays(new Date(), 60));
    const exemptions = await getCardExpiryExemptions(horizon);
    if (isCardExpiryExemptMethod(exemptions, customer.id, method.id)) return refused('prepay-covered');
  }
  if (meta.invoice_id) {
    const verdict = await require('../invoice-helpers').selfPayAtDispatch(meta.invoice_id, database)();
    if (verdict.ok !== true) return refused(verdict.code || 'invoice-not-self-pay');
  }
  return { eligible: true };
}

async function recheck(meta) {
  try {
    if (!meta.customer_id || !meta.notificationEventKey || meta.billingDeliveryLeg !== 'email'
      || meta.channel !== 'email') return refused('invalid-email-obligation');
    if (meta.billing_email_provider_started_at || meta.billing_email_uncertain === true) return refused('billing-email-delivery-uncertain');
    return await producerEligible(meta);
  } catch {
    return refused('billing-email-eligibility-unavailable', true);
  }
}

async function replay(meta, database = db) {
  if (!meta.scheduled_sms_log_id) return {
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'EMAIL_OBLIGATION_ID_MISSING',
  };
  const eligibility = await recheck(meta);
  if (!eligibility.eligible) return {
    sent: false, blocked: !eligibility.retryable, retryable: eligibility.retryable === true,
    deliveryOutcome: 'not_sent', code: eligibility.reason,
  };
  const row = await database('sms_log').where({ id: meta.scheduled_sms_log_id, customer_id: meta.customer_id })
    .first('id', 'message_body', 'metadata');
  if (!row) return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'EMAIL_OBLIGATION_MISSING' };
  const rowMeta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  if (rowMeta.billing_email_provider_started_at || rowMeta.billing_email_uncertain === true) return {
    sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN',
  };
  const message = await database('email_messages').where({ idempotency_key: obligationKey(meta.notificationEventKey) })
    .first('status', 'provider_message_id', 'recipient_id', 'error_message', 'send_attempt_token');
  if (message?.recipient_id && String(message.recipient_id) !== String(meta.customer_id)) return {
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_EMAIL_KEY_COLLISION',
  };
  const evidence = emailEvidence(message, rowMeta.billing_email_safe_attempt_token);
  if (evidence === 'accepted') return {
    sent: true, channel: 'email', deliveryOutcome: 'accepted', deduped: true,
    providerMessageId: message.provider_message_id || null,
  };
  if (evidence === 'uncertain') return {
    sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN',
  };
  let providerStarted = false;
  let fenceUncertain = false;
  const input = {
    to: '', body: row.message_body, channel: 'email', audience: 'customer',
    purpose: meta.replay_purpose, customerId: meta.customer_id,
    invoiceId: meta.invoice_id || undefined, estimateId: meta.estimate_id || undefined,
    appointmentId: meta.appointment_id || undefined,
    customerInitiated: meta.customer_initiated === true,
    entryPoint: ENTRY_POINT,
    metadata: {
      original_message_type: meta.original_message_type,
      notificationEventKey: meta.notificationEventKey,
      billingDeliveryCategory: meta.billingDeliveryCategory,
      billingDeliveryLeg: 'email',
      billing_mode_at_send: meta.billing_mode_at_send,
    },
    preSendCheck: async () => {
      let fresh;
      try {
        fresh = await producerEligible(meta, database);
      } catch { return { ok: false, code: 'billing-email-eligibility-unavailable', retryable: true }; }
      if (!fresh.eligible) return { ok: false, code: fresh.reason, retryable: fresh.retryable === true };
      try {
        providerStarted = await markProviderStarted(meta.scheduled_sms_log_id, database);
        if (!providerStarted) {
          fenceUncertain = true;
          return { ok: false, code: 'BILLING_EMAIL_PROVIDER_FENCE_FAILED' };
        }
        return { ok: true };
      } catch {
        fenceUncertain = true;
        return { ok: false, code: 'BILLING_EMAIL_PROVIDER_FENCE_FAILED' };
      }
    },
  };
  let result;
  try { result = await require('./send-customer-message').sendCustomerMessage(input); }
  catch { return { sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN' }; }
  if (fenceUncertain || result?.deliveryOutcome === 'uncertain') return {
    sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN',
  };
  if (providerStarted && result?.deliveryOutcome === 'not_sent'
    && !await clearProviderStarted(meta.scheduled_sms_log_id, database)) return {
    sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN',
  };
  return result;
}

module.exports = { ENTRY_POINT, obligationKey, supportedGuard, findObligation, queueObligation,
  claimSibling, transitionSibling, producerEligible, recheck, replay };
