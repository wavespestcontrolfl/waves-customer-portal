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

async function reuseExistingQueueRow(trx, existing, uncertain) {
  if (!uncertain) return { queued: true, duplicate: true, ...existingOutcome(existing) };
  await trx('sms_log').where({ id: existing.id }).whereNotIn('status', ['sent', 'delivered'])
    .update({ status: 'blocked', metadata: trx.raw(
      "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('billing_email_uncertain', true)"),
    updated_at: new Date() });
  const current = await trx('sms_log').where({ id: existing.id }).first('id', 'status', 'metadata');
  return { queued: true, duplicate: true, ...existingOutcome(current) };
}

// A collision with an earlier caller can report not_sent while that
// caller's provider handoff is still in flight. A stale queued Email
// row is NOT proof that SendGrid refused it; hold it even past the
// template library's own stale-row reclaim window.
async function collidingEmailMessage(trx, key, customerId) {
  const emailMessage = await trx('email_messages').where({ idempotency_key: key })
    .first('status', 'provider_message_id', 'recipient_id', 'error_message', 'send_attempt_token');
  if (emailMessage?.recipient_id && String(emailMessage.recipient_id) !== String(customerId)) {
    return { blocked: { queued: false, code: 'BILLING_EMAIL_KEY_COLLISION',
      reason: 'An Email idempotency key belongs to another customer' } };
  }
  return { emailMessage };
}

function queuedRowMetadata(input, category, eventKey, key, siblings, holdUncertain) {
  const meta = input.metadata || {};
  return {
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
    original_message_type: meta.original_message_type || null,
    invoice_id: input.invoiceId || null,
    estimate_id: input.estimateId || null,
    appointment_id: input.appointmentId || null,
    charge_date: meta.charge_date || null,
    payment_method_id: meta.payment_method_id || null,
    expiry_month: meta.expiry_month || null,
    expiry_year: meta.expiry_year || null,
    expiry_stage: meta.expiry_stage || null,
    billing_mode_at_send: meta.billing_mode_at_send || null,
    customer_initiated: input.customerInitiated === true,
  };
}

async function insertQueuedRow(trx, input, category, metadata, accepted, holdUncertain) {
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
    if (existing) return reuseExistingQueueRow(trx, existing, uncertain);
    const collision = await collidingEmailMessage(trx, key, input.customerId);
    if (collision.blocked) return collision.blocked;
    const evidence = emailEvidence(collision.emailMessage);
    const accepted = evidence === 'accepted';
    const holdUncertain = !accepted && (uncertain || evidence === 'uncertain');
    const metadata = queuedRowMetadata(input, category, eventKey, key, siblings, holdUncertain);
    return insertQueuedRow(trx, input, category, metadata, accepted, holdUncertain);
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

// The Monday-warning-vs-daily-workflow entry points share a payment-method
// pin/customer/method resolution, then diverge on their own window rule.
const EXPIRY_ENTRY_POINTS = ['autopay_card_expiry_warning', 'payment_expiry_workflow'];

async function prechargeRefusal(meta, database) {
  if (meta.source_entry_point !== 'autopay_pre_charge_reminder') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.charge_date || '')) return refused('charge-date-missing');
  if (etDateString(addETDays(new Date(), 3)) !== meta.charge_date) return refused('charge-date-passed');
  const customer = await database('customers').where({ id: meta.customer_id }).first();
  if (!customer || customer.deleted_at || customer.active !== true || customer.autopay_enabled !== true
    || !(Number(customer.monthly_rate) > 0) || resolveBillingLane(customer).mode !== 'monthly_membership'
    || Number(customer.billing_day) !== Number(meta.charge_date.slice(-2))
    || isPaused(customer, new Date(`${meta.charge_date}T12:00:00Z`))) return refused('precharge-no-longer-eligible');
  return null;
}

// Pin completeness, customer liveness, and (Monday-warning-only) the autopay
// switch — the checks that gate both expiry entry points before either one's
// payment method is even looked up.
async function expiryCustomerRefusal(meta, database) {
  if (!meta.payment_method_id || !meta.expiry_month || !meta.expiry_year) return { refusal: refused('expiry-pin-missing') };
  const customer = await database('customers').where({ id: meta.customer_id }).first();
  if (!customer || customer.deleted_at || customer.active !== true) return { refusal: refused('customer-no-longer-active') };
  if (meta.source_entry_point === 'autopay_card_expiry_warning' && customer.autopay_enabled !== true) {
    return { refusal: refused('autopay-disabled') };
  }
  return { customer };
}

// The pinned method must still be the same chargeable Stripe card AND still
// be the one autopay would actually use — a pointer that moved on is a
// replaced card even if the old row is technically still intact.
async function expiryMethodRefusal(meta, database, customer) {
  const method = await database('payment_methods').where({ id: meta.payment_method_id, customer_id: meta.customer_id }).first();
  if (!method || method.processor !== 'stripe' || method.autopay_enabled !== true
    || !method.stripe_payment_method_id || isBankMethodType(method.method_type)
    || Number(method.exp_month) !== Number(meta.expiry_month)
    || Number(method.exp_year) % 100 !== Number(meta.expiry_year) % 100) return { refusal: refused('expiry-method-changed') };
  const selected = await selectedExpiryMethod(customer, meta.source_entry_point, database);
  if (String(selected?.id) !== String(method.id)) return { refusal: refused('expiry-method-replaced') };
  return { method };
}

function expiryMethodYearMonth(method) {
  return [Number(method.exp_year) < 100 ? Number(method.exp_year) + 2000 : Number(method.exp_year), Number(method.exp_month)];
}

// The daily workflow only warns for a card expiring this month or next —
// and only for a customer still worth warning (never a former one).
function paymentExpiryWorkflowWindowRefusal(customer, method) {
  const [year, month] = etDateString().split('-').map(Number);
  const [expiryYear, expiryMonth] = expiryMethodYearMonth(method);
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  if (!((expiryYear === year && expiryMonth === month) || (expiryYear === next[0] && expiryMonth === next[1]))) {
    return refused('expiry-window-passed');
  }
  const { FORMER_CUSTOMER_STAGES } = require('../customer-stages');
  if (FORMER_CUSTOMER_STAGES.includes(customer.pipeline_stage) || customer.pipeline_stage === 'lost') return refused('former-customer');
  return null;
}

// A customer past the "obviously still a customer" pipeline stages only
// keeps the warning while they still have a payment or an upcoming visit —
// otherwise the relationship has ended and the card is nobody's business.
async function paymentExpiryWorkflowRelationshipRefusal(customer, database) {
  if (['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)) return null;
  const paid = await database('payments').where({ customer_id: customer.id, status: 'paid' }).first('id');
  const upcoming = await database('scheduled_services').where({ customer_id: customer.id })
    .whereIn('status', ['pending', 'confirmed']).where('scheduled_date', '>=', etDateString()).first('id');
  if (!paid && !upcoming) return refused('payment-relationship-ended');
  return null;
}

// The Monday warning covers a 60-day horizon and must still agree with the
// expired/soon stage it was queued under — a card that crossed that line
// since queuing is stale evidence, not a fresh warning.
function autopayCardExpiryWindowRefusal(meta, method) {
  const [expiryYear, expiryMonth] = expiryMethodYearMonth(method);
  const horizon = etDateString(addETDays(new Date(), 60));
  const first = `${expiryYear}-${String(expiryMonth).padStart(2, '0')}-01`;
  if (first > horizon) return refused('expiry-window-passed');
  const expired = `${expiryYear}-${String(expiryMonth).padStart(2, '0')}` < etDateString().slice(0, 7);
  if ((meta.expiry_stage === 'expired') !== expired) return refused('expiry-stage-changed');
  return null;
}

// Shared by both expiry entry points: an annual-prepay customer whose
// coverage already spans the warning window gets no card-expiry noise.
async function cardExpiryExemptionRefusal(meta, customer, method) {
  const { getCardExpiryExemptions } = require('../annual-prepay-renewals');
  const { isCardExpiryExemptMethod } = require('../card-expiry-exemptions');
  const [year, month] = etDateString().split('-').map(Number);
  const horizon = meta.source_entry_point === 'payment_expiry_workflow'
    ? new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10)
    : etDateString(addETDays(new Date(), 60));
  const exemptions = await getCardExpiryExemptions(horizon);
  if (isCardExpiryExemptMethod(exemptions, customer.id, method.id)) return refused('prepay-covered');
  return null;
}

async function expiryRefusal(meta, database) {
  if (!EXPIRY_ENTRY_POINTS.includes(meta.source_entry_point)) return null;
  const customerCheck = await expiryCustomerRefusal(meta, database);
  if (customerCheck.refusal) return customerCheck.refusal;
  const { customer } = customerCheck;
  const methodCheck = await expiryMethodRefusal(meta, database, customer);
  if (methodCheck.refusal) return methodCheck.refusal;
  const { method } = methodCheck;
  if (meta.source_entry_point === 'payment_expiry_workflow') {
    const windowRefusal = paymentExpiryWorkflowWindowRefusal(customer, method);
    if (windowRefusal) return windowRefusal;
    const relationshipRefusal = await paymentExpiryWorkflowRelationshipRefusal(customer, database);
    if (relationshipRefusal) return relationshipRefusal;
  } else {
    const windowRefusal = autopayCardExpiryWindowRefusal(meta, method);
    if (windowRefusal) return windowRefusal;
  }
  return cardExpiryExemptionRefusal(meta, customer, method);
}

async function invoiceSelfPayRefusal(meta, database) {
  if (!meta.invoice_id) return null;
  const verdict = await require('../invoice-helpers').selfPayAtDispatch(meta.invoice_id, database)();
  if (verdict.ok !== true) return refused(verdict.code || 'invoice-not-self-pay');
  return null;
}

async function producerEligible(meta, database = db) {
  const precharge = await prechargeRefusal(meta, database);
  if (precharge) return precharge;
  const expiry = await expiryRefusal(meta, database);
  if (expiry) return expiry;
  const invoice = await invoiceSelfPayRefusal(meta, database);
  if (invoice) return invoice;
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

function deliveryUncertainOutcome() {
  return { sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN' };
}

// Re-reads the queued row and refuses replay outright when a prior attempt
// already left an unresolved provider fence — that row is not this replay's
// to retry.
async function replayQueuedRowState(meta, database) {
  const row = await database('sms_log').where({ id: meta.scheduled_sms_log_id, customer_id: meta.customer_id })
    .first('id', 'message_body', 'metadata');
  if (!row) return { refusal: { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'EMAIL_OBLIGATION_MISSING' } };
  const rowMeta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  if (rowMeta.billing_email_provider_started_at || rowMeta.billing_email_uncertain === true) {
    return { refusal: deliveryUncertainOutcome() };
  }
  return { row, rowMeta };
}

// The canonical Email row this replay owns may already have a definite
// provider verdict recorded against its idempotency key — a collision, a
// prior acceptance, or a prior uncertain hold all resolve replay right here.
async function replayEmailMessageOutcome(meta, rowMeta, database) {
  const message = await database('email_messages').where({ idempotency_key: obligationKey(meta.notificationEventKey) })
    .first('status', 'provider_message_id', 'recipient_id', 'error_message', 'send_attempt_token');
  if (message?.recipient_id && String(message.recipient_id) !== String(meta.customer_id)) {
    return { resolved: { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_EMAIL_KEY_COLLISION' } };
  }
  const evidence = emailEvidence(message, rowMeta.billing_email_safe_attempt_token);
  if (evidence === 'accepted') return { resolved: { sent: true, channel: 'email', deliveryOutcome: 'accepted',
    deduped: true, providerMessageId: message.provider_message_id || null } };
  if (evidence === 'uncertain') return { resolved: deliveryUncertainOutcome() };
  return {};
}

// The registered dispatcher's own pre-send fence: refuse a producer that has
// gone stale since queuing, then claim the provider-started fence before
// handing off, so a crash mid-handoff is recorded as uncertain rather than
// silently retried.
function replayPreSendCheck(meta, database, fence) {
  return async () => {
    let fresh;
    try {
      fresh = await producerEligible(meta, database);
    } catch { return { ok: false, code: 'billing-email-eligibility-unavailable', retryable: true }; }
    if (!fresh.eligible) return { ok: false, code: fresh.reason, retryable: fresh.retryable === true };
    try {
      fence.providerStarted = await markProviderStarted(meta.scheduled_sms_log_id, database);
      if (!fence.providerStarted) {
        fence.uncertain = true;
        return { ok: false, code: 'BILLING_EMAIL_PROVIDER_FENCE_FAILED' };
      }
      return { ok: true };
    } catch {
      fence.uncertain = true;
      return { ok: false, code: 'BILLING_EMAIL_PROVIDER_FENCE_FAILED' };
    }
  };
}

function replaySendInput(meta, row, database, fence) {
  return {
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
    preSendCheck: replayPreSendCheck(meta, database, fence),
  };
}

async function dispatchReplaySend(input) {
  try { return { result: await require('./send-customer-message').sendCustomerMessage(input) }; }
  catch { return { refusal: deliveryUncertainOutcome() }; }
}

// A fence claimed but never resolved to a definite result, or a definite
// not_sent whose fence could not be cleared, both leave the retry decision
// unsafe — either is reported uncertain rather than trusted.
async function finalizeReplayResult(meta, database, fence, result) {
  if (fence.uncertain || result?.deliveryOutcome === 'uncertain') return deliveryUncertainOutcome();
  if (fence.providerStarted && result?.deliveryOutcome === 'not_sent'
    && !await clearProviderStarted(meta.scheduled_sms_log_id, database)) return deliveryUncertainOutcome();
  return result;
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
  const state = await replayQueuedRowState(meta, database);
  if (state.refusal) return state.refusal;
  const messageOutcome = await replayEmailMessageOutcome(meta, state.rowMeta, database);
  if (messageOutcome.resolved) return messageOutcome.resolved;
  const fence = { providerStarted: false, uncertain: false };
  const input = replaySendInput(meta, state.row, database, fence);
  const dispatch = await dispatchReplaySend(input);
  if (dispatch.refusal) return dispatch.refusal;
  return finalizeReplayResult(meta, database, fence, dispatch.result);
}

module.exports = { ENTRY_POINT, obligationKey, supportedGuard, findObligation, queueObligation,
  claimSibling, transitionSibling, producerEligible, recheck, replay };
