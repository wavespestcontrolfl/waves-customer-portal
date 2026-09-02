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

// Off-Stripe "other ways to pay" block on the public pay page (2026-08-29;
// Zelle-only since 2026-09-02 — Venmo and PayPal were dropped over their
// fees). Zelle has no webhook into this system, so this is informational:
// the invoice stays open until the payment is recorded (POST
// /admin/invoices/:id/record-payment — by hand today, by the Gmail
// payment-notice reconciler once that lane ships). Driven entirely by env —
// ZELLE_RECIPIENT unset ⇒ returns null and the GET payload is byte-identical
// to today. Kill switch: unset ZELLE_RECIPIENT.
function manualPayOptionsFromEnv(env = process.env) {
  const zelle = String(env.ZELLE_RECIPIENT || '').trim();
  return zelle ? { zelle: { recipient: zelle } } : null;
}

module.exports = {
  shouldSkipClientPaymentErrorAlert,
  manualPayOptionsFromEnv,
};
