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

    // ── Idempotency claim (atomic) ────────────────────────────
    //
    // Two concurrent retries from Stripe (or a manual replay racing a live
    // delivery) used to both pass a SELECT-then-INSERT check and run the
    // event handler twice — duplicating dispute / payout admin
    // notifications, double-attempting save-card persistence, etc. The
    // per-row `processed` flag below filters the trivial case where a
    // retry arrives after we finished, but the SELECT-then-INSERT window
    // before the row exists is what we couldn't cover.
    //
    // Replace with a single atomic claim: INSERT … ON CONFLICT(id) DO
    // NOTHING. If we get a row back, we own this event and proceed.
    // Otherwise another worker has it; check the existing row's processed
    // flag and return 200 (already done) or 503 (still in flight — let
    // Stripe retry once the other worker finishes / fails).
    let claimed = false;
    try {
      const inserted = await db('stripe_webhook_events')
        .insert({
          id: event.id,
          event_type: event.type,
          processed: false,
          payload: JSON.stringify(event.data),
          received_at: new Date().toISOString(),
        })
        .onConflict('id')
        .ignore()
        .returning('id');
      claimed = inserted.length > 0;
    } catch (dbErr) {
      logger.error(`[stripe-webhook] Idempotency claim insert failed: ${dbErr.message}`);
      // Fall through — without a successful claim we can't safely run
      // side effects, but we also can't tell whether a duplicate exists.
      // Return 503 so Stripe retries.
      return res.status(503).json({ error: 'Idempotency claim failed' });
    }

    if (!claimed) {
      const existing = await db('stripe_webhook_events').where({ id: event.id }).first().catch(() => null);
      if (existing?.processed) {
        logger.info(`[stripe-webhook] Duplicate event ${event.id} — already processed, skipping`);
        return res.status(200).json({ received: true, duplicate: true });
      }
      // Another worker holds the row but hasn't finished. Tell Stripe to
      // retry — by the time the retry lands, the other worker will have
      // either committed processed=true (we 200) or crashed (we claim).
      logger.warn(`[stripe-webhook] Event ${event.id} in-flight on another worker — asking Stripe to retry`);
      return res.status(503).json({ error: 'Event in-flight, retry' });
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

  // ── Auto-send payment receipt SMS ─────────────────────────
  //
  // Single source of truth for "payment succeeded → text the customer a
  // receipt." Runs for every Stripe payment path (Payment Element on
  // /pay/:token, Tap to Pay, autopay charges, Payment Links, etc.).
  //
  // sendReceipt() is idempotent against invoices.receipt_sent_at, so
  // duplicate webhooks (Stripe retries on 5xx) and the legacy
  // /pay/:token/confirm fire-and-forget call won't double-send.
  //
  // Fire-and-forget — the invoice is already marked paid; a Twilio
  // outage shouldn't make Stripe retry the whole webhook. Logged loudly
  // so operators can manually resend via the admin "SEND RECEIPT" button.
  //
  // Wait until enrichment + save-card persistence below have a chance
  // to run by deferring to setImmediate, so card_brand / card_last_four
  // are populated when the receipt template renders {card_line}.
  if (invoiceUpdated > 0) {
    setImmediate(async () => {
      try {
        const paidInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first();
        if (!paidInvoice) return;
        const InvoiceService = require('../services/invoice');
        const result = await InvoiceService.sendReceipt(paidInvoice.id);
        if (result?.sent === false && result.reason !== 'already-sent') {
          logger.warn(`[stripe-webhook] Receipt not sent for invoice ${paidInvoice.invoice_number}: ${result.reason}`);
        }
      } catch (err) {
        logger.error(`[stripe-webhook] Auto-receipt failed for PI ${piId}: ${err.message}`, { stack: err.stack });
      }
    });
  }

  // ── Card-present enrichment (Tap to Pay on iPhone) ─────────
  //
  // For card_present PIs the brand/last4/wallet live on the Charge's
  // payment_method_details, not on the PaymentIntent itself, and Stripe
  // doesn't include charges in the webhook event payload by default. We
  // fetch the charge and backfill payment_method / card_brand /
  // card_last_four on the invoice so the admin portal shows what the
  // customer actually tapped with (physical card vs Apple Pay wallet).
  //
  // Fire-and-forget — the invoice is already marked paid above, enrichment
  // is display metadata only. A missing charge fetch or a schema change in
  // Stripe's response should never leave an unpaid invoice.
  //
  // Guard on payment_method_types to skip the ACH / online-card paths that
  // the existing handler below already covers. The tap_to_pay metadata tag
  // is belt-and-suspenders in case Stripe ever ships a PI with multiple
  // method types that includes card_present but isn't actually our flow.
  const isCardPresent =
    paymentIntent.payment_method_types?.includes('card_present') ||
    paymentIntent.metadata?.source === 'tap_to_pay';
  if (isCardPresent && paymentIntent.latest_charge) {
    try {
      const stripe = new Stripe(stripeConfig.secretKey);
      const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
      const cp = charge?.payment_method_details?.card_present;
      if (cp) {
        // wallet.type: 'apple_pay' | 'google_pay' | null (null = physical
        // card tapped). We record apple_pay / google_pay verbatim so the
        // admin portal can show "Apple Pay — Visa •4242" vs plain
        // "Visa •4242". Default to 'card_present' so we never overwrite
        // with an empty string.
        const walletType = cp.wallet?.type || null;
        const paymentMethod = walletType || 'card_present';
        const cardBrand = cp.brand || null;           // visa / mastercard / amex / discover / etc
        const cardLastFour = cp.last4 || null;        // 4 chars; last4 of DPAN for wallets

        await db('invoices')
          .where({ stripe_payment_intent_id: piId })
          .update({
            payment_method: paymentMethod,
            card_brand: cardBrand,
            card_last_four: cardLastFour,
          });
        logger.info(
          `[stripe-webhook] card_present enriched PI ${piId}: ${paymentMethod} ${cardBrand || '?'} •${cardLastFour || '????'}`,
        );
      } else {
        logger.warn(`[stripe-webhook] card_present PI ${piId} had no card_present details on charge`);
      }
    } catch (err) {
      logger.error(`[stripe-webhook] card_present enrichment failed for ${piId}: ${err.message}`);
    }
  }

  // ── Save payment method on the customer if they opted in ─────
  //
  // When the /pay/:token page sets `setup_future_usage: 'off_session'`
  // on the PI (customer ticked "Save this card on file"), Stripe attaches
  // the pm to the Stripe customer automatically on success. We still need
  // to mirror it into our payment_methods table so the rest of the
  // system (autopay, admin Card on File, portal card list) can see it.
  //
  // Also back-fills the payment_method_id FK on any consent rows that
  // were recorded before this webhook landed.
  if (
    paymentIntent.metadata?.save_card_opt_in === 'true' &&
    paymentIntent.setup_future_usage &&
    paymentIntent.payment_method &&
    paymentIntent.metadata?.waves_customer_id
  ) {
    const wavesCustomerId = paymentIntent.metadata.waves_customer_id;
    const stripePmId = paymentIntent.payment_method;
    try {
      const StripeService = require('../services/stripe');
      const ConsentService = require('../services/payment-method-consents');
      // Check if we already saved this pm (e.g. from a duplicate webhook)
      const existing = await db('payment_methods').where({ stripe_payment_method_id: stripePmId }).first();
      const saved = existing || await StripeService.savePaymentMethod(wavesCustomerId, stripePmId);
      await ConsentService.linkPaymentMethodId(stripePmId, saved.id);
      logger.info(`[stripe-webhook] Save-card opt-in persisted: pm ${stripePmId} → payment_methods ${saved.id}`);
    } catch (err) {
      // Non-fatal — the charge already succeeded. Log loudly so we can
      // manually reconcile if the save failed.
      logger.error(`[stripe-webhook] Save-card persist failed for PI ${piId} (pm ${stripePmId}): ${err.message}`);
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
            `Hi ${customer.first_name}, your bank payment failed again. We've updated your default payment to your card. Card payments include a 3.99% processing fee — update your bank account at ${process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com'}/billing to pay with no added fee. — Waves Pest Control`
          );
        } else if (recentFailures >= 2) {
          // 2nd failure — card fallback
          await twilio.sendSMS(phone,
            `Hi ${customer.first_name}, your bank payment failed again. We've switched this payment to your card on file. Card payments include a 3.99% processing fee — you can switch back to bank payment once your account is verified. — Waves Pest Control`
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
      body: `Reason: ${reason}. Respond by ${dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) : 'soon'}. Charge: ${chargeId}`,
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
