const { etDateString } = require('../utils/datetime-et');
const { computeChargeAmount } = require('./stripe-pricing');

function normalizeMethodType(value) {
  return String(value || '').trim().toLowerCase();
}

function isAchMethodType(value) {
  const method = normalizeMethodType(value);
  return method === 'ach'
    || method === 'us_bank_account'
    || method === 'bank'
    || method === 'bank_account';
}

function isAchPaymentIntent(paymentIntent, actualMethodType) {
  const actual = normalizeMethodType(actualMethodType);
  if (actual) return isAchMethodType(actual);

  const selected = normalizeMethodType(paymentIntent?.metadata?.selected_method_category);
  if (selected) return isAchMethodType(selected);

  const types = Array.isArray(paymentIntent?.payment_method_types)
    ? paymentIntent.payment_method_types
    : [];
  return types.some(isAchMethodType) && paymentIntent?.status === 'processing';
}

function isTerminalInvoicePaymentIntent(paymentIntent, actualMethodType) {
  const actual = normalizeMethodType(actualMethodType);
  if (actual === 'card_present') return true;
  if (normalizeMethodType(paymentIntent?.metadata?.source) === 'tap_to_pay') return true;

  const types = Array.isArray(paymentIntent?.payment_method_types)
    ? paymentIntent.payment_method_types.map(normalizeMethodType)
    : [];
  return types.includes('card_present');
}

function methodFamily(value) {
  const method = normalizeMethodType(value);
  if (!method) return null;
  return isAchMethodType(method) ? 'ach' : 'card';
}

function selectedMethodFamily(paymentIntent) {
  const selected = normalizeMethodType(paymentIntent?.metadata?.selected_method_category);
  if (selected) return methodFamily(selected);

  const types = Array.isArray(paymentIntent?.payment_method_types)
    ? paymentIntent.payment_method_types.map(normalizeMethodType).filter(Boolean)
    : [];
  if (types.length === 1) return methodFamily(types[0]);

  return null;
}

function chargeAmountCents(paymentIntent) {
  const received = Number(paymentIntent?.amount_received || 0);
  if (received > 0) return received;
  return Number(paymentIntent?.amount || 0);
}

function expectedChargeCents(invoiceBaseAmount, actualMethodType) {
  if (!actualMethodType || invoiceBaseAmount === undefined || invoiceBaseAmount === null) return null;
  const amount = Number(invoiceBaseAmount);
  if (!Number.isFinite(amount)) return null;
  return Math.round(computeChargeAmount(amount, actualMethodType).total * 100);
}

function assertInvoicePaymentIntentTenderMatches(paymentIntent, actualMethodType, invoiceBaseAmount) {
  const selectedFamily = selectedMethodFamily(paymentIntent);
  const actualFamily = methodFamily(actualMethodType);

  if (selectedFamily && actualFamily && selectedFamily !== actualFamily) {
    throw new Error('Payment method changed after the invoice total was calculated. Please refresh the invoice and try again.');
  }

  const actualCents = chargeAmountCents(paymentIntent);
  const expectedCents = expectedChargeCents(invoiceBaseAmount, actualMethodType);
  if (expectedCents !== null && actualCents > 0 && Math.abs(actualCents - expectedCents) > 1) {
    throw new Error('Payment amount does not match the selected payment method. Please refresh the invoice and try again.');
  }
}

function invoicePaymentStatusForIntent(paymentIntent, actualMethodType) {
  const status = paymentIntent?.status;
  if (status === 'succeeded') return 'paid';
  if (status === 'processing' && isAchPaymentIntent(paymentIntent, actualMethodType)) {
    return 'processing';
  }

  const expected = isAchPaymentIntent(paymentIntent, actualMethodType)
    ? 'succeeded or processing'
    : 'succeeded';
  throw new Error(`PaymentIntent status is "${status}", expected "${expected}"`);
}

function nextInvoiceStatusAfterFailedPayment(invoice, now = new Date()) {
  if (!invoice) return 'sent';

  const due = dateOnlyString(invoice.due_date);
  if (due && due < etDateString(now)) {
    return 'overdue';
  }

  if (invoice.viewed_at) return 'viewed';
  return 'sent';
}

function dateOnlyString(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match ? match[1] : null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getUTCFullYear(),
      String(value.getUTCMonth() + 1).padStart(2, '0'),
      String(value.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }

  return null;
}

module.exports = {
  assertInvoicePaymentIntentTenderMatches,
  isAchMethodType,
  isAchPaymentIntent,
  isTerminalInvoicePaymentIntent,
  invoicePaymentStatusForIntent,
  nextInvoiceStatusAfterFailedPayment,
};
