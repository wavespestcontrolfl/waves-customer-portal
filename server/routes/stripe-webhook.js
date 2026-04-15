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

    if (!sig) {
      logger.warn('[stripe-webhook] Missing stripe-signature header — rejecting');
      return res.status(400).send('Missing stripe-signature header');
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

        case 'payment_intent.processing':
          await handlePaymentIntentProcessing(event.data.object);
          break;

        case 'payment_intent.requires_action':
          await handlePaymentIntentRequiresAction(event.data.object);
          break;

        case 'payment_intent.canceled':
          await handlePaymentIntentCanceled(event.data.object);
          break;

        case 'payment_intent.payment_failed':
          await handlePaymentIntentFailed(event.data.object);
          break;

        case 'charge.refunded':
          await handleChargeRefunded(event.data.object);
          break;

        case 'charge.dispute.created':
          await handleDisputeCreated(event.data.object);
          break;

        case 'charge.dispute.closed':
          await handleDisputeClosed(event.data.object);
          break;

        case 'charge.dispute.funds_withdrawn':
        case 'charge.dispute.funds_reinstated':
          await handleDisputeFunds(event.data.object, event.type);
          break;

        case 'mandate.updated':
          await handleMandateUpdated(event.data.object);
          break;

        case 'payment_method.detached':
          await handlePaymentMethodDetached(event.data.object);
          break;

        case 'setup_intent.succeeded':
          await handleSetupIntentSucceeded(event.data.object);
          break;

        case 'setup_intent.setup_failed':
          await handleSetupIntentFailed(event.data.object);
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
      logger.error(`[stripe-webhook] Handler error for ${event.type}: ${err.message}`, { stack: err.stack });

      // Record error and return 500 so Stripe retries (handlers are idempotent)
      await db('stripe_webhook_events')
        .where({ id: event.id })
        .update({ error: err.message })
        .catch(dbErr => logger.error(`[stripe-webhook] Failed to record error: ${dbErr.message}`));

      return res.status(500).json({ error: 'Handler failed, Stripe will retry' });
    }

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
    try {
      const paidInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first();
      if (paidInvoice) {
        await require('../services/invoice-followups').stopOnPayment(paidInvoice.id);
      }
    } catch (e) {
      logger.error(`[invoice-followups] stopOnPayment failed: ${e.message}`);
    }
  }

  // If ACH payment succeeded, resolve any pending ACH failures for this customer
  const pmType = paymentIntent.payment_method_types?.[0] || paymentIntent.last_payment_error?.payment_method?.type;
  if (pmType === 'us_bank_account') {
    try {
      const payment = await db('payments').where({ stripe_payment_intent_id: piId }).first();
      if (payment?.customer_id) {
        await db('ach_failure_log')
          .where({ customer_id: payment.customer_id, resolved: false })
          .update({ resolved: true, resolution: 'retry_success' })
          .catch(() => {});
        await db('customers').where({ id: payment.customer_id })
          .update({ ach_status: 'active', ach_failure_count: 0 })
          .catch(() => {});
        logger.info(`[stripe-webhook] ACH success — reset failure state for customer ${payment.customer_id}`);
      }
    } catch { /* non-critical */ }
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

  // ── ACH failure handling ──
  const pmType = paymentIntent.last_payment_error?.payment_method?.type;
  if (pmType === 'us_bank_account') {
    await handleAchFailure(paymentIntent, failureMessage);
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
    // Upsert the specific payout from this event — don't rely on a generic sync
    // that might not include this payout in its first page of results.
    await StripeBanking.upsertPayoutFromEvent(payout);
  } catch (err) {
    logger.error(`[stripe-webhook] Payout upsert failed: ${err.message}`);
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

/**
 * ACH failure handling — escalating response:
 * 1st fail: notify customer, Stripe auto-retries
 * 2nd fail (same invoice): switch to card, flag ACH needs_verification
 * 3rd fail (90 days): suspend ACH, switch default to card
 */
async function handleAchFailure(paymentIntent, failureReason) {
  const piId = paymentIntent.id;

  try {
    // Find the customer
    const payment = await db('payments').where({ stripe_payment_intent_id: piId }).first();
    if (!payment?.customer_id) return;
    const customer = await db('customers').where({ id: payment.customer_id }).first();
    if (!customer) return;

    // Log the failure
    try {
      await db('ach_failure_log').insert({
        customer_id: customer.id,
        stripe_payment_intent_id: piId,
        failure_reason: failureReason,
      });
    } catch { /* table may not exist yet */ }

    // Count recent ACH failures (last 90 days)
    let recentFailures = 0;
    try {
      recentFailures = Number((await db('ach_failure_log')
        .where({ customer_id: customer.id, resolved: false })
        .where('failure_date', '>=', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
        .count('* as cnt')
        .first())?.cnt || 0);
    } catch { /* table may not exist */ }

    // Send SMS notification
    try {
      const twilio = require('../services/twilio');
      const phone = customer.phone;
      if (phone) {
        if (recentFailures >= 3) {
          // 3rd failure — ACH suspended
          await twilio.sendSMS(phone,
            `Hi ${customer.first_name}, your bank payment failed again. We've updated your default payment to your card. To re-enable your 3% bank payment discount, update your bank account at ${process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com'}/billing. — Waves Pest Control`
          );
        } else if (recentFailures >= 2) {
          // 2nd failure — card fallback
          await twilio.sendSMS(phone,
            `Hi ${customer.first_name}, your bank payment failed again. We've switched this payment to your card on file. Your 3% bank payment discount will resume once your bank account is verified. — Waves Pest Control`
          );
        } else {
          // 1st failure — notify + auto-retry
          await twilio.sendSMS(phone,
            `Hi ${customer.first_name}, your bank payment didn't go through. We'll retry automatically in 3 business days. No action needed. — Waves Pest Control`
          );
        }
      }
    } catch (smsErr) {
      logger.error(`[stripe-webhook] ACH failure SMS failed: ${smsErr.message}`);
    }

    // Update customer ACH status based on failure count
    try {
      if (recentFailures >= 3) {
        // Suspend ACH — switch default to card
        await db('customers').where({ id: customer.id }).update({
          ach_status: 'suspended',
          ach_failure_count: recentFailures,
        });
        // Try to set card as default payment method
        const cardMethod = await db('payment_methods')
          .where({ customer_id: customer.id, method_type: 'card' })
          .first();
        if (cardMethod) {
          await db('payment_methods')
            .where({ customer_id: customer.id })
            .update({ is_default: false });
          await db('payment_methods')
            .where({ id: cardMethod.id })
            .update({ is_default: true });
        }
        logger.warn(`[stripe-webhook] ACH suspended for customer ${customer.id} — 3+ failures in 90 days`);
      } else if (recentFailures >= 2) {
        await db('customers').where({ id: customer.id }).update({
          ach_status: 'needs_verification',
          ach_failure_count: recentFailures,
        });
        logger.warn(`[stripe-webhook] ACH needs verification for customer ${customer.id}`);
      } else {
        await db('customers').where({ id: customer.id }).update({
          ach_failure_count: recentFailures,
        });
      }
    } catch (dbErr) {
      logger.error(`[stripe-webhook] ACH status update failed: ${dbErr.message}`);
    }

    // Notify the per-invoice follow-up engine — increments autopay-hold counters
    // and releases sequences once the threshold is crossed.
    try {
      await require('../services/invoice-followups').handleAutopayFailure(customer.id);
    } catch (e) {
      logger.error(`[invoice-followups] handleAutopayFailure failed: ${e.message}`);
    }
  } catch (err) {
    logger.error(`[stripe-webhook] ACH failure handler error: ${err.message}`);
  }
}

/**
 * payment_intent.processing — ACH money in flight (3–5 business days to clear).
 * Mark payment/invoice as processing so admin sees "pending bank transfer"
 * instead of "unpaid". Do NOT mark invoice paid until succeeded fires.
 */
async function handlePaymentIntentProcessing(paymentIntent) {
  const piId = paymentIntent.id;
  logger.info(`[stripe-webhook] PaymentIntent processing (ACH in flight): ${piId}`);

  await db('payments')
    .where({ stripe_payment_intent_id: piId })
    .update({ status: 'processing' })
    .catch(() => {});

  await db('invoices')
    .where({ stripe_payment_intent_id: piId })
    .whereNot({ status: 'paid' })
    .update({ status: 'processing' })
    .catch(() => {});
}

/**
 * payment_intent.requires_action — Customer must complete a step (e.g. micro-
 * deposit verification for ACH). Notify customer to finish setup.
 */
async function handlePaymentIntentRequiresAction(paymentIntent) {
  const piId = paymentIntent.id;
  const nextAction = paymentIntent.next_action?.type || 'unknown';
  logger.warn(`[stripe-webhook] PaymentIntent requires action: ${piId} (${nextAction})`);

  try {
    const payment = await db('payments').where({ stripe_payment_intent_id: piId }).first();
    if (payment?.customer_id) {
      const customer = await db('customers').where({ id: payment.customer_id }).first();
      if (customer?.phone) {
        const twilio = require('../services/twilio');
        await twilio.sendSMS(customer.phone,
          `Hi ${customer.first_name}, your bank account verification is incomplete. Please finish setup at ${process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com'}/billing to complete your payment. — Waves`
        );
      }
    }
  } catch (err) {
    logger.error(`[stripe-webhook] requires_action handler failed: ${err.message}`);
  }
}

/**
 * payment_intent.canceled — Stale or admin-cancelled PI. Mark payment cancelled.
 */
async function handlePaymentIntentCanceled(paymentIntent) {
  const piId = paymentIntent.id;
  logger.info(`[stripe-webhook] PaymentIntent canceled: ${piId}`);

  await db('payments')
    .where({ stripe_payment_intent_id: piId })
    .whereNotIn('status', ['paid', 'refunded'])
    .update({ status: 'canceled' })
    .catch(() => {});
}

/**
 * charge.dispute.created — ACH return or chargeback. ~60 days to respond.
 * Flip invoice back to unpaid, log dispute, alert admin.
 */
async function handleDisputeCreated(dispute) {
  const chargeId = dispute.charge;
  const reason = dispute.reason || 'unknown';
  const amount = (dispute.amount / 100).toFixed(2);
  logger.warn(`[stripe-webhook] Dispute created: ${dispute.id} on charge ${chargeId} — $${amount} (${reason})`);

  // Revert payment + invoice
  const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();
  if (payment) {
    await db('payments').where({ id: payment.id }).update({
      status: 'disputed',
      failure_reason: `Dispute: ${reason}`,
    }).catch(() => {});

    if (payment.invoice_id) {
      await db('invoices').where({ id: payment.invoice_id }).update({
        status: 'unpaid',
        paid_at: null,
      }).catch(() => {});
    }
  }

  // Admin notification
  try {
    await db('notifications').insert({
      recipient_type: 'admin',
      category: 'dispute',
      title: `\u26A0\uFE0F Dispute opened: $${amount}`,
      body: `Reason: ${reason}. Respond by ${dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString() : 'soon'}. Charge: ${chargeId}`,
      icon: '\u26A0\uFE0F',
      link: '/admin/invoices',
    });
  } catch (err) {
    logger.error(`[stripe-webhook] Dispute notification failed: ${err.message}`);
  }
}

/**
 * charge.dispute.closed — Dispute resolved (won, lost, or warning closed).
 */
async function handleDisputeClosed(dispute) {
  const chargeId = dispute.charge;
  const status = dispute.status;
  const amount = (dispute.amount / 100).toFixed(2);
  logger.info(`[stripe-webhook] Dispute closed: ${dispute.id} status=${status}`);

  const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();
  if (payment) {
    if (status === 'won' || status === 'warning_closed') {
      // Funds reinstated — restore paid status
      await db('payments').where({ id: payment.id }).update({ status: 'paid' }).catch(() => {});
      if (payment.invoice_id) {
        await db('invoices').where({ id: payment.invoice_id }).update({
          status: 'paid',
          paid_at: new Date().toISOString(),
        }).catch(() => {});
      }
    } else if (status === 'lost') {
      await db('payments').where({ id: payment.id }).update({ status: 'failed' }).catch(() => {});
    }
  }

  try {
    await db('notifications').insert({
      recipient_type: 'admin',
      category: 'dispute',
      title: `Dispute ${status}: $${amount}`,
      body: `Dispute on charge ${chargeId} closed as ${status}.`,
      icon: status === 'won' ? '\u2705' : '\u274C',
      link: '/admin/invoices',
    });
  } catch { /* non-critical */ }
}

/**
 * charge.dispute.funds_withdrawn / funds_reinstated — Cash flow visibility only.
 */
async function handleDisputeFunds(dispute, eventType) {
  const direction = eventType.endsWith('withdrawn') ? 'withdrawn' : 'reinstated';
  const amount = (dispute.amount / 100).toFixed(2);
  logger.info(`[stripe-webhook] Dispute funds ${direction}: $${amount} on ${dispute.id}`);
}

/**
 * mandate.updated — Customer revoked ACH authorization, or status changed.
 * If revoked/inactive, suspend autopay and flag the customer.
 */
async function handleMandateUpdated(mandate) {
  const status = mandate.status;
  const pmId = mandate.payment_method;
  logger.info(`[stripe-webhook] Mandate updated: ${mandate.id} status=${status} pm=${pmId}`);

  if (status === 'inactive') {
    try {
      const pm = await db('payment_methods').where({ stripe_payment_method_id: pmId }).first();
      if (pm?.customer_id) {
        await db('customers').where({ id: pm.customer_id }).update({
          ach_status: 'revoked',
          autopay_enabled: false,
        }).catch(() => {});
        logger.warn(`[stripe-webhook] ACH mandate revoked for customer ${pm.customer_id} — autopay disabled`);
      }
    } catch (err) {
      logger.error(`[stripe-webhook] Mandate update handler failed: ${err.message}`);
    }
  }
}

/**
 * setup_intent.setup_failed — Bank verification failed (wrong micro-deposits, etc.)
 */
async function handleSetupIntentFailed(setupIntent) {
  const reason = setupIntent.last_setup_error?.message || 'Unknown';
  logger.warn(`[stripe-webhook] SetupIntent failed: ${setupIntent.id} — ${reason}`);

  try {
    const customerId = setupIntent.metadata?.waves_customer_id;
    if (customerId) {
      const customer = await db('customers').where({ id: customerId }).first();
      if (customer?.phone) {
        const twilio = require('../services/twilio');
        await twilio.sendSMS(customer.phone,
          `Hi ${customer.first_name}, we couldn't verify your bank account. Please try again at ${process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com'}/billing or use a card. — Waves`
        );
      }
    }
  } catch { /* non-critical */ }
}

module.exports = router;
