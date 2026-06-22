const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { publicPortalUrl } = require('../utils/portal-url');
const { formatDisplayDate, dateOnlyString } = require('../utils/date-only');
const { currency } = require('./email-template');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { invoiceAmountDue } = require('./invoice-helpers');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const TRANSACTIONAL_GROUP = 'transactional_required';

function clean(value) {
  return String(value || '').trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function portalBillingUrl() {
  return `${publicPortalUrl()}/?tab=billing`;
}

function stableDateKey(value) {
  return dateOnlyString(value) || (value ? String(value).slice(0, 10) : dateOnlyString(new Date()));
}

function stableEventKey(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime()) && String(value).includes('T')) return parsed.toISOString();
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function money(value) {
  if (value == null || value === '') return '';
  return currency(value);
}

function displayDate(value) {
  if (!value) return '';
  return formatDisplayDate(value, { fallback: '' });
}

function displayReason(value, fallback = '') {
  const reason = clean(value || fallback);
  if (!reason) return '';
  return reason.includes('_')
    ? reason.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
    : reason;
}

function methodParts(method = {}) {
  const type = clean(method.method_type || method.payment_method_type || method.type || 'card') || 'card';
  const bankLast4 = clean(method.bank_last_four);
  const last4 = clean(method.last_four || method.last4 || bankLast4);
  const cardBrand = clean(method.card_brand || method.brand);
  const bankName = clean(method.bank_name || method.bankName);
  const brand = cardBrand || (type === 'ach' || type === 'us_bank_account' ? (bankName || 'Bank account') : '');
  const label = brand && last4
    ? `${brand} ending in ${last4}`
    : last4
      ? `your saved payment method ending in ${last4}`
      : 'your saved payment method';

  return {
    brand: brand || 'your saved payment method',
    last4,
    type,
    label,
    expirationMonth: clean(method.exp_month || method.expMonth),
    expirationYear: clean(method.exp_year || method.expYear),
  };
}

function assignMethodPayload(payload, method, prefix = 'payment_method') {
  const parts = methodParts(method);
  payload[`${prefix}_brand`] = parts.brand;
  payload[`${prefix}_last4`] = parts.last4;
  payload[`${prefix}_type`] = parts.type;
  payload[`${prefix}_label`] = parts.label;
  return parts;
}

async function loadCustomer(customerId) {
  if (!customerId) return null;
  return db('customers')
    .where({ id: customerId })
    .select('id', 'first_name', 'last_name', 'company_name', 'email', 'phone')
    .first();
}

async function loadPaymentMethod(paymentMethodId) {
  if (!paymentMethodId) return null;
  return db('payment_methods').where({ id: paymentMethodId }).first();
}

async function loadPrefs(customerId) {
  return db('notification_prefs')
    .where({ customer_id: customerId })
    .first()
    .catch((err) => {
      logger.warn(`[payment-lifecycle-email] notification_prefs lookup failed for ${customerId}: ${err.message}`);
      return null;
    });
}

async function logPaymentLifecycleEmailAttempt({
  customerId,
  invoiceId = null,
  paymentId = null,
  paymentMethodId = null,
  refundId = null,
  paymentPlanId = null,
  templateKey,
  eventType,
  status,
  providerMessageId = null,
  sentAt = null,
  failureReason = null,
}) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'email_outbound',
      subject: `${eventType} email ${status}`,
      body: failureReason
        ? `${eventType} email ${status}: ${failureReason}`
        : `${eventType} email ${status}.`,
      metadata: JSON.stringify({
        customer_id: customerId,
        invoice_id: invoiceId,
        payment_id: paymentId,
        payment_method_id: paymentMethodId,
        refund_id: refundId,
        payment_plan_id: paymentPlanId,
        template_key: templateKey,
        channel: 'email',
        event_type: eventType,
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
      }),
    });
  } catch (err) {
    logger.warn(`[payment-lifecycle-email] audit log failed for ${eventType}/${customerId}: ${err.message}`);
  }
}

async function sendLifecycleTemplate({
  customerId,
  templateKey,
  eventType,
  payload = {},
  idempotencyKey,
  invoiceId = null,
  paymentId = null,
  paymentMethodId = null,
  refundId = null,
  paymentPlanId = null,
  categories = [],
}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };

  const prefs = await loadPrefs(customer.id);

  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {})
    .filter((entry) => isEmailLike(entry.email));
  if (!recipient?.email) {
    await logPaymentLifecycleEmailAttempt({
      customerId: customer.id,
      invoiceId,
      paymentId,
      paymentMethodId,
      refundId,
      paymentPlanId,
      templateKey,
      eventType,
      status: 'skipped',
      failureReason: 'missing_email',
    });
    return { ok: false, skipped: true, reason: 'missing_email' };
  }

  const firstName = firstToken(recipient.name) || firstToken(customer.first_name) || 'there';
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || customer.company_name
    || firstName;
  const finalPayload = {
    first_name: firstName,
    customer_name: customerName,
    customer_portal_url: portalBillingUrl(),
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    company_email: CONTACT_EMAIL,
    ...payload,
  };

  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: recipient.email,
      payload: finalPayload,
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: `${eventType}:${customer.id}`,
      idempotencyKey,
      categories: ['payment', eventType.replace(/[^a-zA-Z0-9_-]/g, '_'), ...categories],
      suppressionGroupKey: TRANSACTIONAL_GROUP,
    });

    if (result.deduped) {
      return {
        ok: !!result.sent,
        deduped: true,
        blocked: !!result.blocked,
        messageId: result.message?.provider_message_id || null,
      };
    }

    const status = result.sent ? 'sent' : result.blocked ? 'blocked' : 'failed';
    await logPaymentLifecycleEmailAttempt({
      customerId: customer.id,
      invoiceId,
      paymentId,
      paymentMethodId,
      refundId,
      paymentPlanId,
      templateKey,
      eventType,
      status,
      providerMessageId: result.message?.provider_message_id || null,
      sentAt: result.message?.sent_at || null,
      failureReason: result.sent ? null : result.reason || result.message?.error_message || 'email_not_sent',
    });

    return result.sent
      ? { ok: true, messageId: result.message?.provider_message_id || null }
      : { ok: false, blocked: !!result.blocked, reason: result.reason || 'email_not_sent' };
  } catch (err) {
    await logPaymentLifecycleEmailAttempt({
      customerId: customer.id,
      invoiceId,
      paymentId,
      paymentMethodId,
      refundId,
      paymentPlanId,
      templateKey,
      eventType,
      status: 'failed',
      failureReason: err.message,
    });
    logger.error(`[payment-lifecycle-email] ${eventType} failed for ${customer.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function sendAutopayEnabled({ customerId, paymentMethodId, enabledDate = new Date(), idempotencyKey } = {}) {
  const method = await loadPaymentMethod(paymentMethodId);
  const payload = {
    autopay_enabled_date: displayDate(enabledDate),
  };
  assignMethodPayload(payload, method || {});
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.autopay_enabled',
    eventType: 'payment.autopay_enabled',
    payload,
    paymentMethodId: paymentMethodId || null,
    idempotencyKey: idempotencyKey || `payment.autopay_enabled:${customerId}:${paymentMethodId || 'none'}:${stableEventKey(enabledDate)}`,
  });
}

async function sendPaymentMethodUpdated({
  customerId,
  oldPaymentMethodId = null,
  newPaymentMethodId,
  updatedAt = new Date(),
  idempotencyKey,
} = {}) {
  const [oldMethod, newMethod] = await Promise.all([
    loadPaymentMethod(oldPaymentMethodId),
    loadPaymentMethod(newPaymentMethodId),
  ]);
  const payload = {
    payment_method_updated_date: displayDate(updatedAt),
    old_payment_method_last4: methodParts(oldMethod || {}).last4,
    old_payment_method_label: oldMethod ? methodParts(oldMethod).label : '',
  };
  assignMethodPayload(payload, newMethod || {}, 'new_payment_method');
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.method_updated',
    eventType: 'payment.method_updated',
    payload,
    paymentMethodId: newPaymentMethodId || null,
    idempotencyKey: idempotencyKey || `payment.method_updated:${customerId}:${oldPaymentMethodId || 'none'}:${newPaymentMethodId || 'none'}:${stableEventKey(updatedAt)}`,
  });
}

function expiryStageFor(method, now = new Date()) {
  const month = Number(method?.exp_month);
  const year = Number(method?.exp_year);
  if (!month || !year) return null;
  const expirationEnd = new Date(year, month, 0, 23, 59, 59);
  const daysUntil = Math.ceil((expirationEnd.getTime() - now.getTime()) / 86400000);
  if (daysUntil < 0) return 'expired';
  if (daysUntil <= 7) return '7_day';
  if (daysUntil <= 30) return '30_day';
  return null;
}

async function sendPaymentMethodExpiring({
  customerId,
  paymentMethodId,
  reminderStage,
  now = new Date(),
  idempotencyKey,
} = {}) {
  const method = await loadPaymentMethod(paymentMethodId);
  if (!method) return { ok: false, skipped: true, reason: 'payment_method_not_found' };
  const stage = reminderStage || expiryStageFor(method, now);
  if (!stage) return { ok: false, skipped: true, reason: 'outside_expiry_window' };
  const payload = {};
  const parts = assignMethodPayload(payload, method);
  payload.expiration_month = parts.expirationMonth;
  payload.expiration_year = parts.expirationYear;
  payload.expiration_label = parts.expirationMonth && parts.expirationYear
    ? `${parts.expirationMonth}/${parts.expirationYear}`
    : '';
  return sendLifecycleTemplate({
    customerId: customerId || method.customer_id,
    templateKey: 'payment.method_expiring',
    eventType: 'payment.method_expiring',
    payload,
    paymentMethodId: method.id,
    idempotencyKey: idempotencyKey || `payment.method_expiring:${method.customer_id}:${method.id}:${payload.expiration_month}:${payload.expiration_year}:${stage}`,
    categories: [`payment_method_expiring_${stage}`],
  });
}

async function invoiceForPayment(payment, explicitInvoiceId = null) {
  const metadata = asObject(payment?.metadata);
  const invoiceId = explicitInvoiceId || payment?.invoice_id || metadata.invoice_id || null;
  if (invoiceId) return db('invoices').where({ id: invoiceId }).first().catch(() => null);
  return null;
}

async function sendPaymentRetryNotice({
  customerId,
  paymentId,
  invoiceId = null,
  retryDate,
  idempotencyKey,
} = {}) {
  const payment = paymentId ? await db('payments').where({ id: paymentId }).first() : null;
  if (!payment) return { ok: false, skipped: true, reason: 'payment_not_found' };
  const invoice = await invoiceForPayment(payment, invoiceId);
  // Third-party Bill-To: payer-billed invoices never retry against a homeowner
  // saved card (save-card is suppressed for them), but guard the notice anyway
  // so a stray retry can't text/email the homeowner the payer's pay link.
  if (invoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const method = await loadPaymentMethod(payment.payment_method_id);
  const effectiveRetryDate = retryDate || payment.next_retry_at;
  if (!effectiveRetryDate) return { ok: false, skipped: true, reason: 'missing_retry_date' };
  const payUrl = invoice?.token
    ? `${publicPortalUrl()}/pay/${invoice.token}`
    : portalBillingUrl();
  const payload = {
    invoice_title: invoice?.title || invoice?.service_type || clean(payment.description).replace(/\s+—\s+FAILED$/i, '') || 'your Waves invoice',
    invoice_number: invoice?.invoice_number || '',
    amount_due: money(payment.amount || invoice?.total),
    failed_payment_date: displayDate(payment.payment_date || payment.created_at),
    retry_date: displayDate(effectiveRetryDate),
    pay_url: payUrl,
  };
  assignMethodPayload(payload, method || {});
  const effectiveCustomerId = customerId || payment.customer_id;
  return sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.retry_notice',
    eventType: 'payment.retry_notice',
    payload,
    invoiceId: invoice?.id || invoiceId || null,
    paymentId: payment.id,
    paymentMethodId: payment.payment_method_id || null,
    idempotencyKey: idempotencyKey || `payment.retry_notice:${invoice?.id || invoiceId || 'no_invoice'}:${payment.id}:${stableDateKey(effectiveRetryDate)}`,
  });
}

async function sendPaymentFailed({
  customerId,
  paymentIntentId,
  attemptId,
  invoiceId = null,
  paymentId = null,
  idempotencyKey,
} = {}) {
  let invoice = invoiceId ? await db('invoices').where({ id: invoiceId }).first().catch(() => null) : null;
  let payment = paymentId ? await db('payments').where({ id: paymentId }).first().catch(() => null) : null;
  if (!payment && paymentIntentId) {
    payment = await db('payments').where({ stripe_payment_intent_id: paymentIntentId }).first().catch(() => null);
  }
  if (!invoice && payment) invoice = await invoiceForPayment(payment, invoiceId);
  if (!invoice && paymentIntentId) {
    invoice = await db('invoices').where({ stripe_payment_intent_id: paymentIntentId }).first().catch(() => null);
  }
  // Third-party Bill-To: a payer-billed invoice's payment lifecycle belongs to
  // the payer AP contact. These templates resolve recipients off the invoice's
  // customer_id (the homeowner) and embed the pay link, so skip them for payer
  // invoices rather than notify the homeowner of the payer's failed payment.
  // (Phase 1 has no payer-facing lifecycle emails.)
  if (invoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const payUrl = invoice?.token
    ? `${publicPortalUrl()}/pay/${invoice.token}`
    : portalBillingUrl();
  const method = payment ? methodParts({
    method_type: payment.method_type,
    card_brand: payment.card_brand,
    brand: payment.card_brand,
    last_four: payment.card_last_four || payment.last_four,
  }) : null;
  const payload = {
    payment_url: payUrl,
    invoice_title: invoice?.title || invoice?.service_type || clean(payment?.description).replace(/\s+[-\u2014]\s+FAILED$/i, '') || '',
    invoice_number: invoice?.invoice_number || '',
    // No payments row yet on an interactive failure → fall back to amount DUE
    // (total − applied credit), not the gross total, to match /pay and the charge.
    amount_due: money(payment?.amount || (invoice ? invoiceAmountDue(invoice) : 0)),
    failed_payment_date: displayDate(payment?.payment_date || payment?.created_at),
    retry_date: displayDate(payment?.next_retry_at),
    payment_method_label: method?.last4 ? method.label : '',
  };
  const effectiveCustomerId = customerId || invoice?.customer_id || payment?.customer_id;
  if (!effectiveCustomerId) return { ok: false, skipped: true, reason: 'customer_not_resolved' };
  const dedupeKey = idempotencyKey
    || `payment.failed:${paymentIntentId || invoice?.id || effectiveCustomerId}:${attemptId || 'no_attempt'}`;
  return sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.failed',
    eventType: 'payment.failed',
    payload,
    invoiceId: invoice?.id || invoiceId || null,
    paymentId: payment?.id || paymentId || null,
    paymentMethodId: payment?.payment_method_id || null,
    idempotencyKey: dedupeKey,
  });
}

async function sendAchProcessing({
  customerId,
  invoiceId,
  paymentId = null,
  amountPaid = null,
  initiatedAt = new Date(),
  expectedClearDate = null,
  idempotencyKey,
} = {}) {
  const invoice = invoiceId ? await db('invoices').where({ id: invoiceId }).first().catch(() => null) : null;
  if (!invoice) return { ok: false, skipped: true, reason: 'invoice_not_found' };
  // Third-party Bill-To: ACH-processing notice routes to the invoice customer_id
  // (homeowner) with the pay link — skip for payer invoices (the payer AP paid,
  // not the homeowner). Phase 1 has no payer-facing lifecycle emails.
  if (invoice.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const payUrl = invoice.token
    ? `${publicPortalUrl()}/pay/${invoice.token}`
    : portalBillingUrl();
  const payload = {
    invoice_title: invoice.title || invoice.service_type || `Invoice ${invoice.invoice_number || ''}`.trim() || 'your Waves invoice',
    invoice_number: invoice.invoice_number || '',
    amount_paid: money(amountPaid != null ? amountPaid : invoice.total),
    payment_initiated_date: displayDate(initiatedAt),
    expected_clear_date: expectedClearDate ? displayDate(expectedClearDate) : '',
    pay_url: payUrl,
  };
  const effectiveCustomerId = customerId || invoice.customer_id;
  return sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.ach_processing',
    eventType: 'payment.ach_processing',
    payload,
    invoiceId: invoice.id,
    paymentId,
    idempotencyKey: idempotencyKey || `payment.ach_processing:${invoice.id}`,
  });
}

async function sendPaymentPlanConfirmed({
  customerId,
  paymentPlanId,
  paymentMethodId = null,
  plan = {},
  invoiceId = null,
  idempotencyKey,
} = {}) {
  // Third-party Bill-To: a payment plan on a payer-billed invoice is the payer's
  // arrangement — don't email the homeowner the plan/balance details.
  const planInvoiceId = invoiceId || plan?.invoice_id || null;
  if (planInvoiceId) {
    const planInvoice = await db('invoices').where({ id: planInvoiceId }).first().catch(() => null);
    if (planInvoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  }
  const method = await loadPaymentMethod(paymentMethodId);
  const payload = {
    plan_start_date: displayDate(plan.plan_start_date || plan.start_date),
    total_balance: money(plan.total_balance),
    payment_amount: money(plan.payment_amount),
    payment_frequency: clean(plan.payment_frequency || plan.frequency),
    next_payment_date: displayDate(plan.next_payment_date),
  };
  assignMethodPayload(payload, method || {});
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.plan_confirmed',
    eventType: 'payment.plan_confirmed',
    payload,
    paymentMethodId,
    paymentPlanId: paymentPlanId || null,
    idempotencyKey: idempotencyKey || `payment.plan_confirmed:${paymentPlanId || 'manual'}:${customerId}`,
  });
}

async function sendRefundIssued({
  customerId,
  paymentId,
  refundId,
  refundAmount,
  refundDate = new Date(),
  refundReason,
  idempotencyKey,
} = {}) {
  const payment = paymentId ? await db('payments').where({ id: paymentId }).first() : null;
  if (!payment) return { ok: false, skipped: true, reason: 'payment_not_found' };
  // Third-party Bill-To: a refund of a payer-billed invoice's payment belongs to
  // the payer AP contact, not the homeowner — don't email the service recipient
  // the payer's refund details.
  const refundInvoice = await invoiceForPayment(payment);
  if (refundInvoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const method = await loadPaymentMethod(payment.payment_method_id);
  const effectiveCustomerId = customerId || payment.customer_id;
  const effectiveRefundId = refundId || payment.stripe_refund_id || `payment-${payment.id}`;
  const payload = {
    refund_amount: money(refundAmount || payment.refund_amount),
    refund_date: displayDate(refundDate || payment.refunded_at || new Date()),
    refund_reason: displayReason(refundReason || payment.refund_reason, 'Account adjustment'),
    original_payment_date: displayDate(payment.payment_date),
    receipt_url: clean(payment.receipt_url),
  };
  assignMethodPayload(payload, method || {
    card_brand: payment.card_brand,
    last_four: payment.card_last_four,
    method_type: payment.method_type,
  });
  return sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.refund_issued',
    eventType: 'payment.refund_issued',
    payload,
    paymentId: payment.id,
    paymentMethodId: payment.payment_method_id || null,
    refundId: effectiveRefundId,
    idempotencyKey: idempotencyKey || `payment.refund_issued:${effectiveRefundId}:${effectiveCustomerId}`,
  });
}

module.exports = {
  sendAutopayEnabled,
  sendPaymentMethodUpdated,
  sendPaymentMethodExpiring,
  sendPaymentRetryNotice,
  sendPaymentFailed,
  sendAchProcessing,
  sendPaymentPlanConfirmed,
  sendRefundIssued,
  _private: {
    methodParts,
    assignMethodPayload,
    expiryStageFor,
    sendLifecycleTemplate,
  },
};
