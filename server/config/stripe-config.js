/**
 * Stripe configuration — merge into server/config/index.js when ready.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY        — sk_live_xxx or sk_test_xxx
 *   STRIPE_PUBLISHABLE_KEY   — pk_live_xxx or pk_test_xxx
 *   STRIPE_WEBHOOK_SECRET    — whsec_xxx (from Stripe dashboard → Webhooks)
 *   PAYMENT_PROCESSOR        — 'stripe' | 'square' | 'both' (default: 'both')
 */
module.exports = {
  secretKey: process.env.STRIPE_SECRET_KEY,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  paymentProcessor: process.env.PAYMENT_PROCESSOR || 'both',
};
