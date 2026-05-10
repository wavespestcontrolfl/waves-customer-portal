const { etDateString } = require('../utils/datetime-et');

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
  isAchMethodType,
  isAchPaymentIntent,
  invoicePaymentStatusForIntent,
  nextInvoiceStatusAfterFailedPayment,
};
