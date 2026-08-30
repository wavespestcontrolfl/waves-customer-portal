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

// Off-Stripe "other ways to pay" block on the public pay page (2026-08-29).
// None of Zelle / Venmo / PayPal.me has a webhook into this system, so this is
// informational: the invoice stays open until the payment is recorded
// (POST /admin/invoices/:id/record-payment — by hand today, by the Gmail
// payment-notice reconciler once that lane ships). Driven entirely by env —
// all three vars unset ⇒ returns null and the GET payload is byte-identical
// to today. Kill switch: unset ZELLE_RECIPIENT / VENMO_HANDLE / PAYPAL_ME_HANDLE.
function manualPayOptionsFromEnv(env = process.env) {
  const zelle = String(env.ZELLE_RECIPIENT || '').trim();
  let venmo = String(env.VENMO_HANDLE || '').trim().replace(/^@/, '');
  if (venmo) venmo = `@${venmo}`;
  // PayPal.me handles are bare (https://paypal.me/<handle>); strip a pasted URL.
  const paypal = String(env.PAYPAL_ME_HANDLE || '').trim()
    .replace(/^https?:\/\/(www\.)?paypal\.me\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!zelle && !venmo && !paypal) return null;
  return {
    ...(zelle ? { zelle: { recipient: zelle } } : {}),
    ...(venmo ? { venmo: { handle: venmo } } : {}),
    ...(paypal ? { paypal: { handle: paypal } } : {}),
  };
}

module.exports = {
  shouldSkipClientPaymentErrorAlert,
  manualPayOptionsFromEnv,
};
