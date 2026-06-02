const { assertInvoiceCollectible } = require('../services/invoice-helpers');

function shouldSkipClientPaymentErrorAlert(invoice) {
  if (!invoice) return false;
  try {
    assertInvoiceCollectible(invoice.status);
    return false;
  } catch {
    return true;
  }
}

// Stripe Elements emits `validation_error`s while the customer is still
// filling out the form — an incomplete card number, a missing CVC, a half-typed
// expiry. These are normal in-progress input states the customer corrects
// inline, not payment failures the office needs to act on. Suppressing them
// keeps the admin notification feed focused on genuine processing errors
// instead of flooding it with every keystroke-level validation message.
const INPUT_VALIDATION_CODES = new Set([
  'incomplete_number',
  'incomplete_cvc',
  'incomplete_expiry',
  'incomplete_zip',
  'incomplete_iban',
  'incomplete_payment_details',
  'invalid_number',
  'invalid_cvc',
  'invalid_expiry_month',
  'invalid_expiry_year',
  'invalid_expiry_month_past',
  'invalid_expiry_year_past',
]);

function isInputValidationNoise({ stripeType, code } = {}) {
  if (String(stripeType || '').trim().toLowerCase() === 'validation_error') return true;
  return INPUT_VALIDATION_CODES.has(String(code || '').trim().toLowerCase());
}

module.exports = {
  shouldSkipClientPaymentErrorAlert,
  isInputValidationNoise,
};
