const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');

/**
 * Stripe Webhook Handler
 *
 * CRITICAL: This router must be mounted BEFORE the global express.json() parser.
 * Stripe signature verification requires the raw request body.
 *
 * Example in index.js:
 *   app.use('/api/stripe/webhook', require('./routes/stripe-webhook'));
 *   app.use(express.json()); // <-- after webhook route
 */

// Use express.raw() for Stripe signature verification
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!stripeConfig.webhookSecret) {
      logger.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — rejecting webhook');
      return res.status(500).send('Webhook secret not configured');
    }

    // ── Verify signature ──────────────────────────────────────
    let event;
    try {
      const stripe = new Stripe(stripeConfig.secretKey);
      event = stripe.webhooks.constructEvent(req.body, sig, stripeConfig.webhookSecret);
    } catch (err) {
      logger.error(`[stripe-webhook] Signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ── Idempotency check ─────────────────────────────────────
    try {
      const existing = await db('stripe_webhook_events')
        .where({ id: event.id })
        .first();

      if (existing && existing.processed) {
        logger.info(`[stripe-webhook] Duplicate event ${event.id} — skipping`);
        return res.status(200).json({ received: true, duplicate: true });
      }

      // Record the event
      if (!existing) {
        await db('stripe_webhook_events').insert({
          id: event.id,
          event_type: event.type,
          processed: false,
          payload: JSON.stringify(event.data),
          received_at: new Date().toISOString(),
        });
      }
    } catch (dbErr) {
      logger.error(`[stripe-webhook] DB idempotency check failed: ${dbErr.message}`);
      // Continue processing — better to process twice than miss an event
    }

    // ── Handle event ──────────────────────────────────────────
    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await handlePaymentIntentSucceeded(event.data.object);
          break;

        case 'payment_intent.payment_failed':
          await handlePaymentIntentFailed(event.data.object);
          break;

        case 'charge.refunded':
          await handleChargeRefunded(event.data.object);
          break;

        case 'payment_method.detached':
          await handlePaymentMethodDetached(event.data.object);
          break;

        case 'setup_intent.succeeded':
          await handleSetupIntentSucceeded(event.data.object);
          break;

        case 'payout.paid':
        case 'payout.failed':
        case 'payout.created':
          await handlePayoutEvent(event.data.object, event.type);
          break;

        default:
          logger.info(`[stripe-webhook] Unhandled event type: ${event.type}`);
      }

      // Mark as processed
      await db('stripe_webhook_events')
        .where({ id: event.id })
        .update({ processed: true, processed_at: new Date().toISOString() });

    } catch (err) {
      logger.error(`[stripe-webhook] Handler error for ${event.type}: ${err.message}`);

      // Record error but still return 200 (Stripe will retry on non-200)
      await db('stripe_webhook_events')
        .where({ id: event.id })
        .update({ error: err.message })
        .catch(() => {});
    }

    // Always return 200 to prevent Stripe retries (we handle errors internally)
    return res.status(200).json({ received: true });
  }
);

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════

/**
 * payment_intent.succeeded — Update payment/invoice to paid
 */
async function handlePaymentIntentSucceeded(paymentIntent) {
  const piId = paymentIntent.id;
  logger.info(`[stripe-webhook] PaymentIntent succeeded: ${piId}`);

  // Update payments table
  const updated = await db('payments')
    .where({ stripe_payment_intent_id: piId, status: 'processing' })
    .update({
      status: 'paid',
      stripe_charge_id: paymentIntent.latest_charge || null,
    });

  if (updated > 0) {
    logger.info(`[stripe-webhook] Updated ${updated} payment(s) to paid for PI: ${piId}`);
  }

  // Update invoices table
  const invoiceUpdated = await db('invoices')
    .where({ stripe_payment_intent_id: piId })
    .whereNot({ status: 'paid' })
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      stripe_charge_id: paymentIntent.latest_charge || null,
    });

  if (invoiceUpdated > 0) {
    logger.info(`[stripe-webhook] Updated ${invoiceUpdated} invoice(s) to paid for PI: ${piId}`);
  }
}

/**
 * payment_intent.payment_failed — Update to failed, log failure reason
 */
async function handlePaymentIntentFailed(paymentIntent) {
  const piId = paymentIntent.id;
  const failureMessage = paymentIntent.last_payment_error?.message || 'Unknown failure';
  const failureCode = paymentIntent.last_payment_error?.code || null;

  logger.warn(`[stripe-webhook] PaymentIntent failed: ${piId} — ${failureMessage}`);

  await db('payments')
    .where({ stripe_payment_intent_id: piId })
    .update({
      status: 'failed',
      failure_reason: `${failureMessage}${failureCode ? ` (${failureCode})` : ''}`,
    });

  // Fire-and-forget health rescore after payment failure
  try {
    const payment = await db('payments').where({ stripe_payment_intent_id: piId }).first();
    if (payment?.customer_id) {
      const customerHealth = require('../services/customer-health');
      customerHealth.scoreCustomer(payment.customer_id).catch(err => {
        logger.debug(`[stripe-webhook] Health rescore after payment failure: ${err.message}`);
      });
    }
  } catch (err) {
    logger.debug(`[stripe-webhook] Health rescore lookup failed: ${err.message}`);
  }
}

/**
 * charge.refunded — Update refund status on payments table
 */
async function handleChargeRefunded(charge) {
  const chargeId = charge.id;
  logger.info(`[stripe-webhook] Charge refunded: ${chargeId}`);

  const refundAmountCents = charge.amount_refunded || 0;
  const refundAmountDollars = refundAmountCents / 100;
  const isFullRefund = charge.refunded === true;

  await db('payments')
    .where({ stripe_charge_id: chargeId })
    .update({
      status: isFullRefund ? 'refunded' : 'paid',
      refund_amount: refundAmountDollars,
      refund_status: isFullRefund ? 'full' : 'partial',
    });

  // Fire-and-forget health rescore after refund
  try {
    const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();
    if (payment?.customer_id) {
      const customerHealth = require('../services/customer-health');
      customerHealth.scoreCustomer(payment.customer_id).catch(err => {
        logger.debug(`[stripe-webhook] Health rescore after refund: ${err.message}`);
      });
    }
  } catch (err) {
    logger.debug(`[stripe-webhook] Health rescore lookup failed: ${err.message}`);
  }
}

/**
 * payment_method.detached — Remove from our DB
 */
async function handlePaymentMethodDetached(paymentMethod) {
  const pmId = paymentMethod.id;
  logger.info(`[stripe-webhook] Payment method detached: ${pmId}`);

  const deleted = await db('payment_methods')
    .where({ stripe_payment_method_id: pmId })
    .del();

  if (deleted > 0) {
    logger.info(`[stripe-webhook] Removed ${deleted} payment method(s) from DB: ${pmId}`);
  }
}

/**
 * setup_intent.succeeded — Log for auditing
 */
async function handleSetupIntentSucceeded(setupIntent) {
  const customerId = setupIntent.metadata?.waves_customer_id || 'unknown';
  logger.info(`[stripe-webhook] SetupIntent succeeded for customer ${customerId}: ${setupIntent.id}`);
}

/**
 * payout.paid / payout.failed / payout.created — Sync payout and create notification
 */
async function handlePayoutEvent(payout, eventType) {
  logger.info(`[stripe-webhook] Payout event: ${eventType} ${payout.id} $${payout.amount / 100}`);

  try {
    const StripeBanking = require('../services/stripe-banking');
    await StripeBanking.syncPayouts(5);
  } catch (err) {
    logger.error(`[stripe-webhook] Payout sync failed: ${err.message}`);
  }

  try {
    if (eventType === 'payout.paid') {
      await db('notifications').insert({
        recipient_type: 'admin',
        category: 'payout',
        title: `Payout deposited: $${(payout.amount / 100).toFixed(2)}`,
        body: `Stripe payout of $${(payout.amount / 100).toFixed(2)} has been deposited to your Capital One account.`,
        icon: '\uD83C\uDFE6',
        link: '/admin/banking',
      });
    }

    if (eventType === 'payout.failed') {
      await db('notifications').insert({
        recipient_type: 'admin',
        category: 'payout',
        title: `Payout FAILED: $${(payout.amount / 100).toFixed(2)}`,
        body: `Payout failed: ${payout.failure_message || 'Unknown reason'}. Check your bank details.`,
        icon: '\u26A0\uFE0F',
        link: '/admin/banking',
      });
    }
  } catch (err) {
    logger.error(`[stripe-webhook] Payout notification failed: ${err.message}`);
  }
}

module.exports = router;
