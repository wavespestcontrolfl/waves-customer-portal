// Shared payment resolution for the permanent receipt page, PDF and composer.
const db = require('../models/db');
const logger = require('./logger');

async function loadPaymentForInvoice(invoiceId, customerId, { stripePaymentIntentId = null, stripeChargeId = null, invoiceNumber = null } = {}) {
  try {
    const base = () => db('payments')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'refunded', 'processing'])
      .orderBy('created_at', 'desc');
    // Primary: payments tagged with this invoice in metadata.invoice_id.
    let row = await base()
      .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoiceId])
      .first();
    // Fallback for legacy / card-on-file rows that predate the metadata tag: resolve
    // by the invoice's own Stripe PaymentIntent / charge id. Without this a refunded
    // invoice can return no payment row → the receipt PDF would render no refund and
    // read as 'paid'.
    if (!row && (stripePaymentIntentId || stripeChargeId)) {
      row = await base()
        .where(function () {
          if (stripePaymentIntentId) this.orWhere('stripe_payment_intent_id', stripePaymentIntentId);
          if (stripeChargeId) this.orWhere('stripe_charge_id', stripeChargeId);
        })
        .first();
    }
    // Manual self-pay rows (cash/check/Zelle) carry NEITHER metadata nor a
    // PaymentIntent — their only link is the deterministic description
    // `Invoice <number> — <method>` admin-invoices.js writes. The billing
    // history resolves receipt links through this same linkage, so without it
    // here a refunded manual payment shows a Download action that then 409s
    // at the refund-record guard below (codex r5 P1).
    if (!row && invoiceNumber && /^[A-Za-z0-9-]+$/.test(String(invoiceNumber))) {
      row = await base()
        .where('description', 'like', `Invoice ${invoiceNumber} — %`)
        .first();
    }
    return row || null;
  } catch (err) {
    logger.warn(`[receipt-v2] payment lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = { loadPaymentForInvoice };
