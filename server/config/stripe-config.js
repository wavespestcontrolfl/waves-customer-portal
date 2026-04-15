/**
 * Stripe configuration — merge into server/config/index.js when ready.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY        — sk_live_xxx or sk_test_xxx
 *   STRIPE_PUBLISHABLE_KEY   — pk_live_xxx or pk_test_xxx
 *   STRIPE_WEBHOOK_SECRET    — whsec_xxx (from Stripe dashboard → Webhooks)
 */
module.exports = {
  secretKey: process.env.STRIPE_SECRET_KEY,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  apiVersion: process.env.STRIPE_API_VERSION || '2024-12-18.acacia',
  paymentProcessor: 'stripe',
};
