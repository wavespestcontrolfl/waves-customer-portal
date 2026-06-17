const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { triggerNotification } = require('./notification-triggers');

const STRIPE_ID_RE = /\b(?:pi|pm|ch|seti|evt|cus|src)_[A-Za-z0-9_]+\b/g;
const MAX_MESSAGE_LENGTH = 500;

const PHASE_LABELS = {
  setup: 'setup',
  update_amount: 'payment total update',
  quote: 'surcharge quote',
  finalize: 'final payment confirmation',
  confirm: 'local payment confirmation',
  consent: 'save-method consent',
  stripe_confirm: 'Stripe confirmation',
  express_confirm: 'wallet confirmation',
  payment_form_init: 'payment form load',
  payment_form_submit: 'payment form submit',
  payment_method_create: 'payment method creation',
  next_action: 'additional verification',
  payment_status: 'payment status',
};

function cleanString(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function truncate(value, max = MAX_MESSAGE_LENGTH) {
  const text = cleanString(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function normalizeErrorMessage(value) {
  return truncate(value || 'Payment error')
    .replace(STRIPE_ID_RE, '[stripe_id]')
    .toLowerCase();
}

function displayErrorMessage(error, message) {
  const raw = message || error?.message || error?.raw?.message || 'Payment error';
  return truncate(raw);
}

function normalizePhase(value) {
  const phase = cleanString(value, 'unknown').toLowerCase().replace(/[^a-z0-9_:-]/g, '_');
  return truncate(phase, 60);
}

function normalizeMethod(value) {
  const method = cleanString(value, 'unknown').toLowerCase().replace(/[^a-z0-9_:-]/g, '_');
  return truncate(method, 60);
}

function methodLabel(methodCategory) {
  const method = normalizeMethod(methodCategory);
  if (method === 'us_bank_account' || method === 'ach' || method === 'bank_account') return 'Bank account';
  if (method === 'card_present') return 'Tap to Pay';
  if (method === 'apple_pay' || method === 'google_pay' || method === 'link' || method === 'express_checkout') return 'Wallet';
  if (method === 'card') return 'Card';
  return 'Payment method';
}

function phaseLabel(phase) {
  const normalized = normalizePhase(phase);
  return PHASE_LABELS[normalized] || normalized.replace(/_/g, ' ');
}

function customerLabel(customer) {
  if (!customer) return 'customer';
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  return name || customer.phone || 'customer';
}

function buildDedupeKey({ invoiceId, paymentIntentId, phase, methodCategory, errorMessage }) {
  const raw = [
    invoiceId || 'no_invoice',
    paymentIntentId || 'no_pi',
    normalizePhase(phase),
    normalizeMethod(methodCategory),
    normalizeErrorMessage(errorMessage),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Client-side Stripe.js form-validation errors (incomplete card number, CVC, or
// expiry) are typing-in-progress events, not payment failures — Stripe.js blocks
// them in the browser before anything ever reaches Stripe (no PaymentIntent
// confirm, no charge, no decline). They must never raise a "bill payment error"
// admin alert, or they drown out the real failures (declines, network errors,
// the ACH tender-switch case) that genuinely need attention.
//
// Scope carefully: the customer pay page (`PayPageV2`) reports *every* client
// error through `POST /pay/:token/error` with `source: 'client'`, copying
// `err.type` into `metadata.stripe_type` — not just `elements.submit()`. The same
// path also carries `confirmPayment` (ACH/wallet, phase `stripe_confirm` /
// `express_confirm`) and `handleNextAction` (3DS, phase `next_action`) failures,
// where a `validation_error` (e.g. a stale client secret or bad next-action
// param) IS a real stuck payment that no server catch or webhook will cover.
// So a bare `validation_error` *type* is only treated as form-not-finished at the
// `payment_form_submit` phase; the `incomplete_*` field codes are unambiguous and
// suppressed regardless of phase.
function isClientFormValidationError(input = {}) {
  if (normalizePhase(input.source || 'server') !== 'client') return false;
  const code = cleanString(input.code || input.error?.code).toLowerCase();
  if (/^incomplete_/.test(code)) return true;
  const stripeType = cleanString(input.metadata?.stripe_type).toLowerCase();
  return stripeType === 'validation_error' && normalizePhase(input.phase) === 'payment_form_submit';
}

async function alertBillPaymentError(input = {}) {
  const invoice = input.invoice || {};
  if (!invoice.id) return { notified: false, skipped: true, reason: 'missing_invoice' };

  if (isClientFormValidationError(input)) {
    return { notified: false, skipped: true, reason: 'client_validation_error' };
  }

  const phase = normalizePhase(input.phase);
  const methodCategory = normalizeMethod(input.methodCategory || invoice.payment_method || 'unknown');
  const errorMessage = displayErrorMessage(input.error, input.message);
  const paymentIntentId = truncate(input.paymentIntentId || invoice.stripe_payment_intent_id || '', 128) || null;
  const source = normalizePhase(input.source || 'server');
  const errorCode = truncate(input.code || input.error?.code || input.error?.raw?.code || '', 100) || null;
  const dedupeKey = buildDedupeKey({
    invoiceId: invoice.id,
    paymentIntentId,
    phase,
    methodCategory,
    errorMessage,
  });

  let customer = input.customer || null;
  if (!customer && invoice.customer_id) {
    customer = await db('customers').where({ id: invoice.customer_id }).first().catch((err) => {
      logger.warn(`[bill-payment-alerts] customer lookup failed for invoice ${invoice.id}: ${err.message}`);
      return null;
    });
  }

  const metadata = {
    ...(input.metadata || {}),
    status_code: input.statusCode || null,
    source,
  };

  let row;
  try {
    const inserted = await db('bill_payment_error_alerts')
      .insert({
        dedupe_key: dedupeKey,
        invoice_id: invoice.id,
        customer_id: invoice.customer_id || null,
        payment_intent_id: paymentIntentId,
        phase,
        method_category: methodCategory,
        source,
        error_code: errorCode,
        error_message: errorMessage,
        metadata: JSON.stringify(metadata),
        notified_at: new Date(),
      })
      .onConflict('dedupe_key')
      .merge({
        occurrence_count: db.raw('bill_payment_error_alerts.occurrence_count + 1'),
        last_seen_at: db.fn.now(),
        error_message: errorMessage,
        error_code: errorCode,
        metadata: JSON.stringify(metadata),
      })
      .returning(['id', 'occurrence_count']);
    row = inserted?.[0] || null;
  } catch (err) {
    logger.error(`[bill-payment-alerts] dedupe write failed for invoice ${invoice.id}: ${err.message}`);
    return { notified: false, error: err.message };
  }

  if (Number(row?.occurrence_count || 1) > 1) {
    logger.info(`[bill-payment-alerts] duplicate suppressed for invoice ${invoice.invoice_number || invoice.id} phase=${phase}`);
    return { notified: false, duplicate: true, alertId: row?.id || null };
  }

  await triggerNotification('bill_payment_error', {
    amount: Number(invoice.total || 0),
    customerName: customerLabel(customer),
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number || null,
    phase,
    phaseLabel: phaseLabel(phase),
    methodCategory,
    methodLabel: methodLabel(methodCategory),
    reason: errorMessage,
    paymentIntentId,
    source,
  });

  return { notified: true, alertId: row?.id || null };
}

module.exports = {
  alertBillPaymentError,
  __private: {
    buildDedupeKey,
    isClientFormValidationError,
    normalizeErrorMessage,
    normalizePhase,
    normalizeMethod,
    methodLabel,
    phaseLabel,
  },
};
