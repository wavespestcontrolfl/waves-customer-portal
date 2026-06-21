const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const { classifyExistingWebhookEvent, STALE_CLAIM_WINDOW_MS } = require('./stripe-webhook-helpers');
const { triggerNotification } = require('../services/notification-triggers');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const { etDateString, etParts, addETDays } = require('../utils/datetime-et');
const {
  assertInvoicePaymentIntentTenderMatches,
  isAchPaymentIntent,
  isTerminalInvoicePaymentIntent,
  nextInvoiceStatusAfterFailedPayment,
} = require('../services/stripe-invoice-state');
const { computeChargeAmount } = require('../services/stripe-pricing');
const { isEnabled } = require('../config/feature-gates');
const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('../services/invoice-helpers');
const { publicPortalUrl } = require('../utils/portal-url');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const ReceiptDeliveryQueue = require('../services/receipt-delivery-queue');
const INVOICE_TERMINAL_PAYMENT_STATUSES = INVOICE_UNCOLLECTIBLE_STATUSES.filter(s => s !== 'processing');

// Build a "First Last" string from a customer row, falling back to phone
// then a generic 'customer'. Used to fill the body of the bell + push
// notifications fired from the Stripe webhook handlers below — without
// this they'd just say "$X.XX from customer" with no identifier.
function customerLabel(customer) {
  if (!customer) return 'customer';
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  return name || customer.phone || 'customer';
}

async function sendBillingSms(customer, body, metadata = {}) {
  if (!customer?.phone || !customer?.id) {
    return { sent: false, blocked: true, code: 'MISSING_CUSTOMER_CONTACT' };
  }
  return sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'payment_failure',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'stripe_webhook',
    metadata,
  });
}

// Advance `from` by `days` ET weekdays (Mon–Fri). Used to render the
// "expected to clear" date in the ACH-processing acknowledgment so the
// copy ("3–5 business days") doesn't surface a weekend date when the
// payment was initiated late in the week.
//
// Uses ET calendar helpers because Railway runs TZ=UTC: a Sunday-evening-ET
// payment is already Monday UTC, so native getDay()/getDate() would count
// the wrong weekday and shift the "expected to clear" date by a day.
function addBusinessDays(from, days) {
  let cursor = from;
  let added = 0;
  while (added < days) {
    cursor = addETDays(cursor, 1);
    const dow = etParts(cursor).dayOfWeek;
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return cursor;
}

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

// Cached Stripe SDK. Two prior callers (signature verify + card_present
// charge enrichment) constructed `new Stripe(secret)` per request, which
// instantiates a new HTTP agent each time and skipped the apiVersion
// pin — so the webhook's reads were on whatever default version Stripe's
// account was last set to (drift hazard). Match services/stripe.js's
// pinned version exactly so behavior across the two SDK sites is
// identical.
let _stripe;
function getStripe() {
  if (_stripe) return _stripe;
  if (!stripeConfig.secretKey) return null;
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia' });
  return _stripe;
}

async function paymentDetailsFromIntent(paymentIntent) {
  const details = {
    paymentMethod: paymentIntent.payment_method_types?.[0] || null,
    cardBrand: null,
    cardLastFour: null,
    cardFunding: null,
    isWallet: false,
    receiptUrl: null,
  };
  let resolvedFromStripeDetails = false;

  if (paymentIntent.latest_charge) {
    try {
      const stripe = getStripe();
      if (stripe) {
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
        details.receiptUrl = charge?.receipt_url || null;
        const pmd = charge?.payment_method_details;
        if (pmd?.card) {
          details.paymentMethod = 'card';
          details.cardBrand = pmd.card.brand?.toUpperCase() || null;
          details.cardLastFour = pmd.card.last4 || null;
          details.cardFunding = pmd.card.funding || null;
          details.isWallet = !!pmd.card.wallet;
          resolvedFromStripeDetails = true;
        } else if (pmd?.card_present) {
          // card_present funding is needed so the surcharge-bypass guard can tell
          // a credit Tap-to-Pay charge from debit. Brand/last4 are enriched
          // separately for the payment row; we only need funding here.
          details.paymentMethod = 'card_present';
          details.cardFunding = pmd.card_present.funding || null;
          resolvedFromStripeDetails = true;
        } else if (pmd?.us_bank_account) {
          details.paymentMethod = 'us_bank_account';
          details.cardLastFour = pmd.us_bank_account.last4 || null;
          resolvedFromStripeDetails = true;
        } else if (pmd?.type) {
          details.paymentMethod = pmd.type;
          resolvedFromStripeDetails = true;
        }
      }
    } catch (err) {
      logger.warn(`[stripe-webhook] charge detail lookup failed for PI ${paymentIntent.id}: ${err.message}`);
    }
  }

  if (resolvedFromStripeDetails || !paymentIntent.payment_method) return details;

  try {
    const stripe = getStripe();
    if (!stripe) return details;
    const pm = typeof paymentIntent.payment_method === 'string'
      ? await stripe.paymentMethods.retrieve(paymentIntent.payment_method)
      : paymentIntent.payment_method;
    if (pm?.card) {
      details.paymentMethod = 'card';
      details.cardBrand = pm.card.brand?.toUpperCase() || details.cardBrand;
      details.cardLastFour = pm.card.last4 || details.cardLastFour;
      details.cardFunding = pm.card.funding || details.cardFunding;
      details.isWallet = !!pm.card.wallet || details.isWallet;
    } else if (pm?.us_bank_account) {
      details.paymentMethod = 'us_bank_account';
      details.cardLastFour = pm.us_bank_account.last4 || details.cardLastFour;
    } else if (pm?.type) {
      details.paymentMethod = pm.type;
    }
  } catch (err) {
    logger.warn(`[stripe-webhook] payment method lookup failed for PI ${paymentIntent.id}: ${err.message}`);
  }

  return details;
}

async function findInvoiceForPaymentIntent(paymentIntent) {
  const byPaymentIntent = await db('invoices')
    .where({ stripe_payment_intent_id: paymentIntent.id })
    .first();
  const invoiceId = paymentIntent.metadata?.waves_invoice_id || null;
  if (byPaymentIntent) {
    if (invoiceId && String(byPaymentIntent.id) !== String(invoiceId)) {
      logger.warn(
        `[stripe-webhook] PI ${paymentIntent.id} metadata invoice ${invoiceId} conflicts with local invoice ${byPaymentIntent.id}; using local binding`,
      );
    }
    return byPaymentIntent;
  }

  if (invoiceId) {
    const byMetadata = await db('invoices').where({ id: invoiceId }).first();
    if (byMetadata?.stripe_payment_intent_id
      && String(byMetadata.stripe_payment_intent_id) !== String(paymentIntent.id)) {
      logger.warn(
        `[stripe-webhook] PI ${paymentIntent.id} metadata invoice ${invoiceId} is already bound to ${byMetadata.stripe_payment_intent_id}; ignoring metadata fallback`,
      );
      return null;
    }
    if (byMetadata) return byMetadata;
  }
  return null;
}

function centsToDollars(cents) {
  const n = Number(cents || 0);
  return Math.round((n / 100) * 100) / 100;
}

async function recordOrphanSucceededPaymentIntent(paymentIntent, amount, reason) {
  const latestCharge = paymentIntent.latest_charge;
  const stripeChargeId = typeof latestCharge === 'string'
    ? latestCharge
    : latestCharge?.id || null;

  try {
    await db('stripe_orphan_charges')
      .insert({
        stripe_payment_intent_id: paymentIntent.id,
        stripe_charge_id: stripeChargeId,
        // Fall back to the terminal PI's metadata keys (invoice_id/customer_id)
        // so a quarantined card-present charge keeps the linkage operators need
        // to reconcile it; online PIs use the waves_-prefixed keys.
        customer_id: paymentIntent.metadata?.waves_customer_id || paymentIntent.metadata?.customer_id || null,
        invoice_id: paymentIntent.metadata?.waves_invoice_id || paymentIntent.metadata?.invoice_id || null,
        amount,
        source: 'invoice_payment_webhook',
        original_db_error: reason.slice(0, 1000),
      })
      .onConflict('stripe_payment_intent_id')
      .ignore();
  } catch (err) {
    logger.error(`[stripe-webhook] Failed to record orphan succeeded PI ${paymentIntent.id}: ${err.message}`);
    throw err;
  }
}

// Durable record for a statement PI that collected money but was NOT settled
// (surcharge bypass or stale/orphan PI). customer_health_alerts.customer_id is
// NOT NULL so a statement (no homeowner) alert there silently fails; the orphan-
// charges queue tolerates a null customer and is the operator's manual
// refund/reconcile list. Throws on failure so the webhook retries until durable;
// onConflict-ignore keeps it idempotent on redelivery.
async function recordStatementPaymentIssue(paymentIntent, statementId, reason) {
  const latestCharge = paymentIntent.latest_charge;
  const stripeChargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id || null;
  const amount = (paymentIntent.amount_received || paymentIntent.amount || 0) / 100;
  await db('stripe_orphan_charges')
    .insert({
      stripe_payment_intent_id: paymentIntent.id,
      stripe_charge_id: stripeChargeId,
      customer_id: null,
      invoice_id: null,
      amount,
      source: 'statement_pay_webhook',
      original_db_error: `statement S-${statementId}: ${String(reason).slice(0, 960)}`,
    })
    .onConflict('stripe_payment_intent_id')
    .ignore();
}

// NOTE: customer_health_alerts.alert_type is varchar(30) — keep alertType
// values at 30 chars or fewer. The old '*_webhook'-suffixed names (34 and 40
// chars) overflowed the column and every insert silently failed.
async function alertSurchargeBypass(paymentIntent, invoice, alertType, severity, title, description, metadata = {}) {
  try {
    await db('customer_health_alerts').insert({
      customer_id: invoice?.customer_id || paymentIntent.metadata?.waves_customer_id || null,
      alert_type: alertType,
      severity,
      title,
      description,
      // customer_health_alerts has trigger_data, not metadata — the old
      // column name made every one of these alerts silently fail.
      trigger_data: JSON.stringify({
        stripe_payment_intent_id: paymentIntent.id,
        invoice_number: invoice?.invoice_number,
        ...metadata,
      }),
    });
  } catch (alertErr) {
    logger.error(`[stripe-webhook] Surcharge alert failed for PI ${paymentIntent.id}: ${alertErr.message}`);
  }
}

async function shouldQuarantineUnfinalizedCardPayment(paymentIntent, details, invoice, { exemptWallets = true } = {}) {
  const piMeta = paymentIntent.metadata || {};
  if (piMeta.surcharge_policy_version || !paymentIntent.payment_method) return null;

  const recordedSurchargeCents = Math.max(
    Math.round(Number(piMeta.card_surcharge || 0) * 100),
    Number(paymentIntent.amount_details?.surcharge?.amount || 0),
  );
  if (recordedSurchargeCents > 0) return null;

  const methodTypes = paymentIntent.payment_method_types || [];
  const isCard = details.paymentMethod === 'card' || methodTypes.includes('card');
  // Card-present surcharge enforcement is armed only when the feature is live;
  // until then card_present base-only is the intended behavior and must NOT be
  // quarantined. When armed, an un-finalized card_present PI (no
  // surcharge_policy_version) means an old/bypassing client confirmed base-only.
  const isCardPresent =
    (details.paymentMethod === 'card_present' || methodTypes.includes('card_present'))
    && isEnabled('terminalSurcharge');
  if (!isCard && !isCardPresent) return null;
  // The caller skips terminal PIs in its generic quarantine block; this flag
  // lets it quarantine specifically a card_present surcharge bypass.
  const terminalSurchargeBypass = isCardPresent;

  if (details.cardFunding) {
    if (details.cardFunding === 'credit' && (!details.isWallet || !exemptWallets)) {
      return {
        reason: `Credit card PI ${paymentIntent.id} succeeded without surcharge finalization`,
        alertType: 'wh_surcharge_under_collection',
        severity: 'high',
        title: `Surcharge under-collection (webhook) — invoice ${invoice?.invoice_number || 'unknown'}`,
        description: `Credit card payment confirmed via webhook without surcharge finalization. PI: ${paymentIntent.id}. Charged base-only and was not settled locally.`,
        metadata: { card_funding: details.cardFunding },
        terminalSurchargeBypass,
      };
    }
    return null;
  }

  const stripe = getStripe();
  if (!stripe) {
    return {
      reason: `Could not verify card funding for unfinalized PI ${paymentIntent.id}: Stripe is not configured`,
      alertType: 'wh_surcharge_unknown_funding',
      severity: 'high',
      title: `Unknown funding on unfinalized card - invoice ${invoice?.invoice_number || 'unknown'}`,
      description: `Card payment succeeded without surcharge finalization and webhook funding verification could not run. PI: ${paymentIntent.id}. Not settled locally until manual review verifies whether surcharge was required.`,
      metadata: { funding_lookup_error: 'stripe_not_configured' },
      terminalSurchargeBypass,
    };
  }

  try {
    const pmId = typeof paymentIntent.payment_method === 'string'
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id;
    if (!pmId) return null;

    const pmObj = await stripe.paymentMethods.retrieve(pmId);
    const funding = pmObj.card?.funding || pmObj.card_present?.funding || null;
    const isWallet = !!pmObj.card?.wallet;
    if (funding === 'credit' && (!isWallet || !exemptWallets)) {
      return {
        reason: `Credit card PI ${paymentIntent.id} succeeded without surcharge finalization`,
        alertType: 'wh_surcharge_under_collection',
        severity: 'high',
        title: `Surcharge under-collection (webhook) — invoice ${invoice?.invoice_number || 'unknown'}`,
        description: `Credit card payment confirmed via webhook without surcharge finalization. PI: ${paymentIntent.id}. Charged base-only and was not settled locally.`,
        metadata: { card_funding: funding },
        terminalSurchargeBypass,
      };
    }
  } catch (pmErr) {
    logger.error(`[stripe-webhook] Could not verify funding for unfinalized card PI ${paymentIntent.id}: ${pmErr.message}`);
    return {
      reason: `Could not verify card funding for unfinalized PI ${paymentIntent.id}: ${pmErr.message}`,
      alertType: 'wh_surcharge_unknown_funding',
      severity: 'high',
      title: `Unknown funding on unfinalized card - invoice ${invoice?.invoice_number || 'unknown'}`,
      description: `Card payment succeeded without surcharge finalization and funding lookup failed. PI: ${paymentIntent.id}. Not settled locally until manual review verifies whether surcharge was required.`,
      metadata: { funding_lookup_error: pmErr.message },
      terminalSurchargeBypass,
    };
  }

  return null;
}

async function lockPaymentIntentPaymentRow(trx, piId) {
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    ['stripe.pi.payment', String(piId)],
  );
}

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
      const stripe = getStripe();
      if (!stripe) {
        logger.error('[stripe-webhook] STRIPE_SECRET_KEY not set — cannot verify signature');
        return res.status(500).send('Stripe not configured');
      }
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
      const classification = classifyExistingWebhookEvent(existing);

      if (classification === 'duplicate') {
        logger.info(`[stripe-webhook] Duplicate event ${event.id} — already processed, skipping`);
        return res.status(200).json({ received: true, duplicate: true });
      }

      if (classification === 'reclaim') {
        // Two re-claim sub-cases handled by one atomic UPDATE:
        //   (a) failed-attempt reclaim — catch block below recorded
        //       `error` and returned 500 so Stripe retries. Without
        //       a way out of the in-flight 503 path, events stay
        //       permanently unapplied after a transient DB blip.
        //   (b) stale-claim reclaim — a worker claimed the row, then
        //       crashed before writing either processed=true or an
        //       error. We use `received_at` as the lease timestamp;
        //       anything older than STALE_CLAIM_WINDOW_MS is assumed
        //       abandoned. Without this, a crash mid-handler stranded
        //       the event forever (Codex P1 #490).
        //
        // The UPDATE's WHERE matches the union of both cases; we also
        // bump received_at to refresh the lease for the new attempt.
        // Two concurrent retries arriving here race for rowcount=1 —
        // only one wins and re-runs the handler.
        const staleCutoff = new Date(Date.now() - STALE_CLAIM_WINDOW_MS).toISOString();
        const reclaimed = await db('stripe_webhook_events')
          .where({ id: event.id, processed: false })
          .where(function () {
            this.whereNotNull('error').orWhere('received_at', '<', staleCutoff);
          })
          .update({ error: null, received_at: new Date().toISOString() });
        if (reclaimed > 0) {
          const reason = existing.error ? `prior error: ${existing.error}` : 'stale claim (worker likely crashed)';
          logger.warn(`[stripe-webhook] Re-claiming event ${event.id} — ${reason}`);
          // Fall through to the handler dispatch — we now own the row.
        } else {
          // Lost the re-claim race to another worker.
          logger.warn(`[stripe-webhook] Event ${event.id} re-claim lost — asking Stripe to retry`);
          return res.status(503).json({ error: 'Event re-claim race lost, retry' });
        }
      } else {
        // True in-flight — another worker holds the row, no failed
        // marker, claim is fresh. Tell Stripe to retry. By the time
        // the retry lands, the other worker will have either committed
        // processed=true (we 200), written `error` (we re-claim), or
        // gone past the stale window (we re-claim).
        logger.warn(`[stripe-webhook] Event ${event.id} in-flight on another worker — asking Stripe to retry`);
        return res.status(503).json({ error: 'Event in-flight, retry' });
      }
    }

    // ── Handle event ──────────────────────────────────────────
    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await handlePaymentIntentSucceeded(event.data.object);
          break;

        case 'payment_intent.processing':
          await handlePaymentIntentProcessing(event.data.object, event.created, event.id);
          break;

        case 'payment_intent.requires_action':
          await handlePaymentIntentRequiresAction(event.data.object);
          break;

        case 'payment_intent.canceled':
          await handlePaymentIntentCanceled(event.data.object);
          break;

        case 'payment_intent.payment_failed':
          // Pass event.id so the failure-notification dedupe key can use
          // it as the per-attempt identifier when paymentIntent.latest_charge
          // is absent (rare authorize-only fail). Each Stripe event has a
          // distinct id, so this preserves per-attempt dedupe granularity
          // even in the no-charge case.
          await handlePaymentIntentFailed(event.data.object, event.id);
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
// P3 — payer statement PaymentIntents (metadata.waves_statement_id) settle the
// CONSOLIDATED statement, never an individual invoice. Isolated from the invoice
// PI lifecycle so legacy invoice_id intents are unchanged. Idempotent: succeeded
// on an already-paid statement is a no-op; processing/revert are conditional on
// the statement's ACTIVE PI, so a stale/replaced PI's events match nothing. NOT
// feature-gated — a confirmed money event must settle regardless of the flag.
async function handleStatementPaymentIntentEvent(paymentIntent, eventType) {
  const statementId = Number(paymentIntent.metadata?.waves_statement_id);
  if (!Number.isInteger(statementId) || statementId <= 0) return;
  const piId = paymentIntent.id;
  const Settle = require('../services/payer-statement-settle');

  if (eventType === 'succeeded') {
    const meta = paymentIntent.metadata || {};
    const baseCents = meta.base_amount != null ? Math.round(parseFloat(meta.base_amount) * 100) : null;
    const totalCents = paymentIntent.amount_received || paymentIntent.amount || 0;
    const surchargeCents = baseCents != null ? Math.max(0, totalCents - baseCents) : 0;
    const cardFunding = meta.card_funding && meta.card_funding !== 'unknown' ? meta.card_funding : null;

    // Settled method from the ACTUAL attached PaymentMethod (not the PI's
    // allowed-types list — statement PIs allow BOTH card + us_bank_account, so a
    // base-amount debit/prepaid card would otherwise be misrecorded as ACH).
    const details = await paymentDetailsFromIntent(paymentIntent);
    const paymentMethod = details.paymentMethod === 'us_bank_account' ? 'ach' : 'card';

    // Surcharge-bypass guard (mirrors the invoice path): setup mints a BASE,
    // client-confirmable PI, so a credit-card payer could skip /quote+/finalize
    // and confirm at base. If a card succeeded WITHOUT surcharge finalization,
    // quarantine + alert — do NOT settle base-only (under-collection).
    // exemptWallets:false — a credit Apple/Google Pay confirmed at base must also
    // be quarantined (statements surcharge the full card family, no wallet exempt).
    const quarantine = await shouldQuarantineUnfinalizedCardPayment(paymentIntent, details, { invoice_number: `S-${statementId}` }, { exemptWallets: false });
    if (quarantine) {
      await recordStatementPaymentIssue(paymentIntent, statementId, `surcharge bypass: ${quarantine.reason}`);
      logger.warn(`[stripe-webhook] statement S-${statementId} PI ${piId} quarantined (surcharge bypass): ${quarantine.reason}`);
      return;
    }

    await db.transaction(async (trx) => {
      const stmt = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
      if (!stmt) { logger.warn(`[stripe-webhook] statement ${statementId} not found for PI ${piId}`); return; }

      // Active-PI binding: only the statement's CURRENT PI may settle it. A
      // stale/replaced PI that nonetheless collected money is an over-collection
      // (e.g. the AP confirmed an old client secret) — alert for manual refund,
      // never settle/cascade on it. settleStatementPaid is idempotent on
      // already-paid, but a non-active success must not be treated as the
      // settling charge.
      if (stmt.stripe_payment_intent_id && String(stmt.stripe_payment_intent_id) !== String(piId)) {
        await recordStatementPaymentIssue(paymentIntent, statementId, `orphan payment: succeeded PI ${piId} but active PI is ${stmt.stripe_payment_intent_id} (status ${stmt.status}) — manual refund/review`);
        logger.warn(`[stripe-webhook] statement S-${statementId} orphan success on PI ${piId} (active ${stmt.stripe_payment_intent_id})`);
        return;
      }

      await Settle.settleStatementPaid(statementId, {
        paymentMethod,
        processor: 'stripe',
        stripePaymentIntentId: piId,
        stripeChargeId: paymentIntent.latest_charge || null,
        amountCents: totalCents,
        baseAmountCents: baseCents,
        surchargeAmountCents: surchargeCents,
        surchargeRateBps: meta.surcharge_rate_bps != null ? Number(meta.surcharge_rate_bps) : 0,
        surchargePolicyVersion: meta.surcharge_policy_version || null,
        cardFunding,
        source: 'stripe_webhook',
        database: trx,
      });
    });
    logger.info(`[stripe-webhook] statement S-${statementId} settled paid via PI ${piId}`);
  } else if (eventType === 'processing') {
    const moved = await Settle.markStatementProcessing(statementId, piId);
    if (moved) logger.info(`[stripe-webhook] statement S-${statementId} → processing (ACH in flight) via PI ${piId}`);
  } else if (eventType === 'failed' || eventType === 'canceled') {
    await db.transaction((trx) => Settle.revertStatementProcessing(statementId, piId, { database: trx }));
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  const piId = paymentIntent.id;
  logger.info(`[stripe-webhook] PaymentIntent succeeded: ${piId}`);

  // P3: a payer-statement PI settles the consolidated statement (cascade), not an
  // invoice — route it before any invoice/tender logic and return.
  if (paymentIntent.metadata?.waves_statement_id) {
    await handleStatementPaymentIntentEvent(paymentIntent, 'succeeded');
    return;
  }

  // Estimate-acceptance deposits are not invoice payments — route them to
  // the deposit ledger BEFORE any invoice/tender logic runs against them.
  if (paymentIntent.metadata?.purpose === 'estimate_deposit') {
    const { handleDepositIntentSucceeded } = require('../services/estimate-deposits');
    await handleDepositIntentSucceeded(paymentIntent);
    return;
  }

  const chargedCents = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
  const chargedTotal = chargedCents > 0 ? Math.round((chargedCents / 100) * 100) / 100 : null;
  const details = await paymentDetailsFromIntent(paymentIntent);
  const invoiceForTenderGuard = await findInvoiceForPaymentIntent(paymentIntent);
  const invoiceForTenderGuardStatus = String(invoiceForTenderGuard?.status || '').toLowerCase();
  const surchargeQuarantine = await shouldQuarantineUnfinalizedCardPayment(
    paymentIntent,
    details,
    invoiceForTenderGuard,
  );
  // Card-present surcharge bypass: a terminal credit PI never finalized through
  // /apply-surcharge. The generic block below skips terminal PIs, so enforce it
  // here — don't mark the invoice paid; record the orphan + alert so the
  // under-collection is loud, not silent. Only set when the surcharge gate is on.
  if (surchargeQuarantine?.terminalSurchargeBypass
    && invoiceForTenderGuard
    && !INVOICE_TERMINAL_PAYMENT_STATUSES.includes(invoiceForTenderGuardStatus)) {
    logger.error(`[stripe-webhook] Quarantining terminal surcharge-bypass PI ${piId}: ${surchargeQuarantine.reason}`);
    await alertSurchargeBypass(
      paymentIntent,
      invoiceForTenderGuard,
      surchargeQuarantine.alertType,
      surchargeQuarantine.severity,
      surchargeQuarantine.title,
      surchargeQuarantine.description,
      surchargeQuarantine.metadata,
    );
    await recordOrphanSucceededPaymentIntent(
      paymentIntent,
      chargedTotal ?? centsToDollars(paymentIntent.amount),
      surchargeQuarantine.reason,
    );
    return;
  }
  if (surchargeQuarantine
    && invoiceForTenderGuard
    && !INVOICE_TERMINAL_PAYMENT_STATUSES.includes(invoiceForTenderGuardStatus)
    && !isTerminalInvoicePaymentIntent(paymentIntent, details.paymentMethod)) {
    logger.error(`[stripe-webhook] Quarantining succeeded invoice PI ${piId}: ${surchargeQuarantine.reason}`);
    await alertSurchargeBypass(
      paymentIntent,
      invoiceForTenderGuard,
      surchargeQuarantine.alertType,
      surchargeQuarantine.severity,
      surchargeQuarantine.title,
      surchargeQuarantine.description,
      surchargeQuarantine.metadata,
    );
    await recordOrphanSucceededPaymentIntent(
      paymentIntent,
      chargedTotal ?? centsToDollars(paymentIntent.amount),
      surchargeQuarantine.reason,
    );
    return;
  }
  if (invoiceForTenderGuard
    && !INVOICE_TERMINAL_PAYMENT_STATUSES.includes(invoiceForTenderGuardStatus)
    && !isTerminalInvoicePaymentIntent(paymentIntent, details.paymentMethod)) {
    const invoiceBaseAmount = Number(invoiceForTenderGuard.total);
    try {
      assertInvoicePaymentIntentTenderMatches(paymentIntent, details.paymentMethod, invoiceBaseAmount);
    } catch (err) {
      logger.error(
        `[stripe-webhook] Refusing succeeded invoice PI ${piId}: ${err.message} ` +
        `(invoice=${invoiceForTenderGuard.id}, method=${details.paymentMethod || 'unknown'}, amount=${chargedCents}c)`,
      );
      await recordOrphanSucceededPaymentIntent(
        paymentIntent,
        chargedTotal ?? centsToDollars(paymentIntent.amount),
        `Rejected invoice payment tender mismatch for invoice ${invoiceForTenderGuard.id}: ${err.message}`,
      );
      return;
    }
  }

  // Update payments table
  const paymentUpdates = {
    status: 'paid',
    stripe_charge_id: paymentIntent.latest_charge || null,
  };
  if (chargedTotal !== null) paymentUpdates.amount = chargedTotal;
  if (details.receiptUrl) paymentUpdates.receipt_url = details.receiptUrl;
  if (details.cardBrand) paymentUpdates.card_brand = details.cardBrand;
  if (details.cardLastFour) paymentUpdates.card_last_four = details.cardLastFour;
  let fallbackLinkedInvoiceId = null;
  const updated = await db('payments')
    .where({ stripe_payment_intent_id: piId, status: 'processing' })
    .update(paymentUpdates);

  if (updated > 0) {
    logger.info(`[stripe-webhook] Updated ${updated} payment(s) to paid for PI: ${piId}`);
  } else {
    await db.transaction(async (trx) => {
      await lockPaymentIntentPaymentRow(trx, piId);
      const existingPayment = await trx('payments')
        .where({ stripe_payment_intent_id: piId })
        .forUpdate()
        .first();
      if (existingPayment) {
        // 'disputed' is terminal here: a delayed/reclaimed succeeded
        // event arriving after charge.dispute.created must not flip a
        // chargeback back to paid (dispute resolution owns that row now).
        if (!['paid', 'refunded', 'disputed'].includes(existingPayment.status)) {
          await trx('payments').where({ id: existingPayment.id }).update(paymentUpdates);
        }
        return;
      }

      const invoice = await findInvoiceForPaymentIntent(paymentIntent);
      if (!invoice?.customer_id) {
        await recordOrphanSucceededPaymentIntent(
          paymentIntent,
          chargedTotal ?? centsToDollars(paymentIntent.amount),
          `No locally collectible invoice matched succeeded PI ${piId}`,
        );
        return;
      }

      const lockedInvoice = await trx('invoices')
        .where({ id: invoice.id })
        .forUpdate()
        .first();
      if (!lockedInvoice) return;

      const activePi = lockedInvoice.stripe_payment_intent_id
        ? String(lockedInvoice.stripe_payment_intent_id)
        : '';
      if (INVOICE_TERMINAL_PAYMENT_STATUSES.includes(String(lockedInvoice.status || '').toLowerCase())
        || (lockedInvoice.status === 'processing' && activePi !== String(piId))
        || (activePi && activePi !== String(piId))) {
        logger.warn(
          `[stripe-webhook] Skipping paid fallback row for PI ${piId}; ` +
          `invoice ${invoice.id} status=${lockedInvoice.status || 'unknown'} active_pi=${activePi || 'none'}`,
        );
        return;
      }

      const fallbackInvoiceUpdates = {
        status: 'paid',
        paid_at: new Date().toISOString(),
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: paymentIntent.latest_charge || null,
      };
      if (chargedTotal !== null) fallbackInvoiceUpdates.total = chargedTotal;
      if (details.paymentMethod) fallbackInvoiceUpdates.payment_method = details.paymentMethod;
      if (details.cardBrand) fallbackInvoiceUpdates.card_brand = details.cardBrand;
      if (details.cardLastFour) fallbackInvoiceUpdates.card_last_four = details.cardLastFour;
      if (details.receiptUrl) fallbackInvoiceUpdates.receipt_url = details.receiptUrl;

      const invoiceLinked = await trx('invoices')
        .where({ id: lockedInvoice.id })
        .whereNotIn('status', INVOICE_TERMINAL_PAYMENT_STATUSES)
        .where(function activePaidIntentGuard() {
          this.whereNull('stripe_payment_intent_id')
            .orWhere({ stripe_payment_intent_id: piId });
        })
        .update(fallbackInvoiceUpdates);
      if (!invoiceLinked) {
        throw new Error(`Invoice ${invoice.id} no longer matches PI ${piId}`);
      }
      fallbackLinkedInvoiceId = lockedInvoice.id;

      const metadataBaseAmount = Number(paymentIntent.metadata?.base_amount ?? invoice.total);
      const metadataCardSurcharge = Number(paymentIntent.metadata?.card_surcharge ?? 0);
      await trx('payments').insert({
        customer_id: invoice.customer_id,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: paymentIntent.latest_charge || null,
        payment_date: etDateString(),
        amount: chargedTotal ?? centsToDollars(paymentIntent.amount),
        base_amount_cents: Math.round(Number(paymentIntent.metadata?.base_amount || invoice.total) * 100),
        surcharge_amount_cents: Math.round(Number(paymentIntent.metadata?.card_surcharge || 0) * 100),
        surcharge_rate_bps: Number(paymentIntent.metadata?.surcharge_rate_bps || 0),
        surcharge_policy_version: paymentIntent.metadata?.surcharge_policy_version || null,
        card_funding: paymentIntent.metadata?.card_funding || null,
        card_brand: details.cardBrand || null,
        status: 'paid',
        description: metadataCardSurcharge > 0
          ? `Invoice ${invoice.invoice_number} (includes $${metadataCardSurcharge.toFixed(2)} card processing fee)`
          : `Invoice ${invoice.invoice_number}`,
        receipt_url: details.receiptUrl || null,
        card_last_four: details.cardLastFour || null,
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          stripe_receipt_url: details.receiptUrl || null,
          base_amount: metadataBaseAmount,
          card_surcharge: metadataCardSurcharge,
          charged_amount: chargedTotal ?? centsToDollars(paymentIntent.amount),
          payment_method: details.paymentMethod || paymentIntent.payment_method_types?.[0] || null,
          payment_state: 'paid',
        }),
      });
      logger.info(`[stripe-webhook] Inserted missing paid payment row for PI: ${piId}`);
    });
  }

  // A disputed chargeback owns this PI now — a late or reclaimed
  // succeeded event must not flip the dispute-reverted invoice back to
  // paid. (Dispute-won restores it via handleDisputeClosed.)
  const disputedPayment = await db('payments')
    .where({ stripe_payment_intent_id: piId, status: 'disputed' })
    .first();
  if (disputedPayment) {
    logger.warn(`[stripe-webhook] PI ${piId} has a disputed payment (${disputedPayment.id}) — skipping invoice-paid update from succeeded event`);
    return;
  }

  // Update invoices table
  const invoiceUpdates = {
    status: 'paid',
    paid_at: new Date().toISOString(),
    stripe_charge_id: paymentIntent.latest_charge || null,
  };
  if (chargedTotal !== null) invoiceUpdates.total = chargedTotal;
  if (details.paymentMethod) invoiceUpdates.payment_method = details.paymentMethod;
  if (details.cardBrand) invoiceUpdates.card_brand = details.cardBrand;
  if (details.cardLastFour) invoiceUpdates.card_last_four = details.cardLastFour;
  if (details.receiptUrl) invoiceUpdates.receipt_url = details.receiptUrl;
  let invoiceUpdated = await db('invoices')
    .where({ stripe_payment_intent_id: piId })
    .whereNotIn('status', INVOICE_TERMINAL_PAYMENT_STATUSES)
    .update(invoiceUpdates);
  if (fallbackLinkedInvoiceId && invoiceUpdated === 0) {
    invoiceUpdated = 1;
  }

  if (invoiceUpdated > 0) {
    logger.info(`[stripe-webhook] Updated ${invoiceUpdated} invoice(s) to paid for PI: ${piId}`);
    try {
      const paidInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first();
      if (paidInvoice) {
        await require('../services/invoice-followups').stopOnPayment(paidInvoice.id)
          .catch((e) => logger.error(`[invoice-followups] stopOnPayment failed: ${e.message}`));
        await require('../services/annual-prepay-renewals').syncTermForInvoicePayment(paidInvoice);
      }
    } catch (e) {
      logger.error(`[stripe-webhook] annual prepay activation failed: ${e.message}`);
    }
  }
  // Awaited inline so the side effect runs inside the same processing
  // path as the webhook event row (processed=true is written by the
  // outer handler only after this returns). Run even when the invoice was
  // already paid so webhook retry after a mid-flight crash can recover.
  // ReviewService.create is idempotent by service_record_id.
  await scheduleReviewAfterPaidInvoice(piId);

  // ── Auto-send payment receipt (SMS + email) ───────────────
  //
  // Single source of truth for "payment succeeded → notify the customer."
  // Runs for every Stripe payment path (Payment Element on /pay/:token,
  // Tap to Pay, autopay charges, Payment Links, etc.).
  //
  // SMS: InvoiceService.sendReceipt() is idempotent against
  //   invoices.receipt_sent_at, so duplicate webhooks (Stripe retries on
  //   5xx) and the legacy /pay/:token/confirm fire-and-forget call won't
  //   double-send.
  // Email: sendReceiptEmail() with an idempotency key (`receipt_email_auto:
  //   {invoiceId}`) — the email_messages.idempotency_key unique index gives
  //   the same dedupe guarantee on the email side, without depending on
  //   receipt_sent_at (which only stamps after SMS).
  //
  // Channels run independently — a missing phone / missing email skips
  // that channel but the other still fires. The durable queue keeps a
  // retryable record instead of losing the send when Twilio/SendGrid or
  // this process hiccups after Stripe has already been acknowledged.
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
      const stripe = getStripe();
      if (!stripe) throw new Error('Stripe SDK not configured');
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
  // system (admin Card on File, portal card list, and later explicit
  // autopay selection) can see it.
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
      const currentAutopayMethod = await db('payment_methods')
        .where({
          customer_id: wavesCustomerId,
          processor: 'stripe',
          is_default: true,
          autopay_enabled: true,
        })
        .whereNotNull('stripe_payment_method_id')
        .first('id');
      const saved = existing || await StripeService.savePaymentMethod(wavesCustomerId, stripePmId, {
        enableAutopay: false,
        makeDefault: !currentAutopayMethod,
      });
      await ConsentService.linkPaymentMethodId(stripePmId, saved.id);
      if (!existing) {
        PaymentLifecycleEmail.sendPaymentMethodUpdated({
          customerId: wavesCustomerId,
          newPaymentMethodId: saved.id,
          updatedAt: saved.created_at || new Date(),
          idempotencyKey: `payment.method_updated:${wavesCustomerId}:${saved.id}:save_card_opt_in`,
        }).catch((emailErr) => {
          logger.warn(`[stripe-webhook] Save-card email failed for PI ${piId}: ${emailErr.message}`);
        });
      }
      logger.info(`[stripe-webhook] Save-card opt-in persisted: pm ${stripePmId} → payment_methods ${saved.id}`);
    } catch (err) {
      // Non-fatal — the charge already succeeded. Log loudly so we can
      // manually reconcile if the save failed.
      logger.error(`[stripe-webhook] Save-card persist failed for PI ${piId} (pm ${stripePmId}): ${err.message}`);
    }
  }

  const paidInvoice = await db('invoices')
    .where({ stripe_payment_intent_id: piId })
    .where({ status: 'paid' })
    .first();
  if (paidInvoice) {
    await ReceiptDeliveryQueue.enqueueReceiptDelivery({
      invoiceId: paidInvoice.id,
      stripePaymentIntentId: piId,
      source: 'stripe_webhook',
    });
    ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain({ delayMs: 3000, limit: 5 });
  }

  // If ACH payment succeeded, resolve any pending ACH failures for this customer
  const pmType = paymentIntent.payment_method_types?.[0] || paymentIntent.last_payment_error?.payment_method?.type;
  if (pmType === 'us_bank_account') {
    try {
      const payment = await db('payments').where({ stripe_payment_intent_id: piId }).first();
      if (payment?.customer_id) {
        // Third-party Bill-To: a payer/AP bank transfer clearing must not
        // reactivate the homeowner's suspended/needs-verification ACH state —
        // the payer's payment row sits under the service customer's id but is
        // not the homeowner's bank account. (Symmetric to the handleAchFailure
        // guard.)
        const achInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first().catch(() => null);
        if (achInvoice?.payer_id) {
          logger.info(`[stripe-webhook] ACH success on payer-billed invoice ${achInvoice.invoice_number} (PI ${piId}) — not resetting homeowner ACH state`);
        } else {
          await db('ach_failure_log')
            .where({ customer_id: payment.customer_id, resolved: false })
            .update({ resolved: true, resolution: 'retry_success' })
            .catch(() => {});
          await db('customers').where({ id: payment.customer_id })
            .update({ ach_status: 'active', ach_failure_count: 0 })
            .catch(() => {});
          logger.info(`[stripe-webhook] ACH success — reset failure state for customer ${payment.customer_id}`);
        }
      }
    } catch { /* non-critical */ }
  }

  // ── Bell + push for the admin team ──
  //
  // Fire-and-forget via Promise.catch (NOT awaited) so the webhook 2xx
  // is not gated on notification fan-out. triggerNotification does a
  // DB read for active admins + per-user prefs + sequential
  // webpush.sendNotification calls per push subscription — awaiting it
  // inline could push the webhook past Stripe's timeout and trigger
  // retry storms even though the core payment writes already committed
  // (codex P1 on PR #534). Emit only when the PI is bound to one of
  // our invoices — otherwise there's nothing to deep-link into.
  //
  // Dedupe: Stripe's at-least-once delivery + multi-event flows (a
  // single real payment can produce `payment_intent.succeeded` AND
  // `charge.succeeded` with distinct event.id values) mean the
  // existing event.id-keyed dedupe in stripe_webhook_events doesn't
  // catch duplicates at the PAYMENT INTENT level. The
  // stripe_payment_notification_log table claims (PI, outcome) atomically
  // via INSERT ... ON CONFLICT DO NOTHING — only the first claimer fires.
  notifyPaymentSuccess(paymentIntent).catch((err) => {
    logger.warn(`[stripe-webhook] payment_succeeded notify failed: ${err.message}`);
  });
}

async function scheduleReviewAfterPaidInvoice(piId) {
  try {
    const paidInvoice = await db('invoices')
      .where({ stripe_payment_intent_id: piId })
      .select('id', 'customer_id', 'service_record_id', 'invoice_number')
      .first();
    if (!paidInvoice?.customer_id || !paidInvoice?.service_record_id) return;

    const serviceRecord = await db('service_records')
      .where({ id: paidInvoice.service_record_id })
      .select('structured_notes')
      .first();
    let structuredNotes = serviceRecord?.structured_notes || {};
    if (typeof structuredNotes === 'string') {
      try { structuredNotes = JSON.parse(structuredNotes); } catch { structuredNotes = {}; }
    }
    if (structuredNotes.requestReview === false) {
      logger.info(`[stripe-webhook] Skipping paid-invoice review request for invoice ${paidInvoice.invoice_number || paidInvoice.id}: completion opted out`);
      return;
    }
    if (structuredNotes.visitOutcome && structuredNotes.visitOutcome !== 'completed') {
      logger.info(`[stripe-webhook] Skipping paid-invoice review request for invoice ${paidInvoice.invoice_number || paidInvoice.id}: visit outcome ${structuredNotes.visitOutcome}`);
      return;
    }

    const ReviewService = require('../services/review-request');
    // ReviewService.create dedupes by service_record_id (returns the
    // existing row instead of inserting), so this is safe under webhook
    // retries.
    const request = await ReviewService.create({
      customerId: paidInvoice.customer_id,
      serviceRecordId: paidInvoice.service_record_id,
      triggeredBy: 'auto',
      delayMinutes: 120,
    });
    logger.info(`[stripe-webhook] Queued review request ${request.id} after invoice ${paidInvoice.invoice_number || paidInvoice.id} payment`);
  } catch (err) {
    logger.error(`[stripe-webhook] Paid-invoice review request schedule failed for PI ${piId}: ${err.message}`);
  }
}

async function notifyPaymentSuccess(paymentIntent) {
  const piId = paymentIntent.id;
  // Successes are one-shot per PI — attempt_id is a constant so the
  // dedupe semantics here are identical to the original (PI, outcome)
  // key. The attempt_id column exists for the failure path's per-charge
  // granularity (codex P1 follow-up to #546).
  const claim = await db.raw(
    `INSERT INTO stripe_payment_notification_log (payment_intent_id, outcome, attempt_id)
     VALUES (?, ?, ?)
     ON CONFLICT (payment_intent_id, outcome, attempt_id) DO NOTHING
     RETURNING payment_intent_id`,
    [piId, 'succeeded', 'one_shot']
  );
  if (claim.rowCount === 0) {
    logger.info(`[stripe-webhook] payment_succeeded notification already dispatched for PI ${piId}, skipping`);
    return;
  }
  const paidInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first();
  if (!paidInvoice?.customer_id) return;
  const customer = await db('customers').where({ id: paidInvoice.customer_id }).first();
  await triggerNotification('payment_succeeded', {
    amount: (paymentIntent.amount_received || paymentIntent.amount || 0) / 100,
    customerName: customerLabel(customer),
    invoiceId: paidInvoice.id,
  });
}

/**
 * payment_intent.payment_failed — Update to failed, log failure reason
 */
async function handlePaymentIntentFailed(paymentIntent, eventId) {
  const piId = paymentIntent.id;
  if (paymentIntent.metadata?.waves_statement_id) {
    await handleStatementPaymentIntentEvent(paymentIntent, 'failed');
    return;
  }
  const failureMessage = paymentIntent.last_payment_error?.message || 'Unknown failure';
  const failureCode = paymentIntent.last_payment_error?.code || null;
  // Friendly version for human-facing surfaces (bell + push). Raw Stripe
  // strings like "The provided PaymentMethod has failed authentication.
  // You can provide payment_method_data or a new PaymentMethod to attempt
  // to fulfill this PaymentIntent again." are developer messages and
  // unreadable in a notification banner. We keep the raw text in
  // payments.failure_reason / ach_failure_log.failure_reason for
  // diagnostics; only the bell body uses the friendly version.
  const { friendlyStripeError } = require('../services/stripe');
  const friendlyFailure = paymentIntent.last_payment_error
    ? friendlyStripeError(paymentIntent.last_payment_error)
    : 'Payment could not be completed.';

  logger.warn(`[stripe-webhook] PaymentIntent failed: ${piId} — ${failureMessage}`);

  // Terminal-status guard: Stripe doesn't guarantee event ordering, and
  // pay-page PIs are reused across attempts — a late-delivered
  // payment_failed from attempt 1 must not demote a row that attempt 2's
  // succeeded event (or a refund/dispute) already settled.
  await db('payments')
    .where({ stripe_payment_intent_id: piId })
    .whereNotIn('status', ['paid', 'refunded', 'disputed'])
    .update({
      status: 'failed',
      failure_reason: `${failureMessage}${failureCode ? ` (${failureCode})` : ''}`,
    });

  const failedInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first();
  if (failedInvoice?.status === 'processing') {
    const nextStatus = nextInvoiceStatusAfterFailedPayment(failedInvoice);
    // Clearing ach_processing_notified_at means a re-attempted ACH on
    // the same invoice (different bank account, customer retries, etc.)
    // will trigger a fresh "we got it" acknowledgment when its
    // payment_intent.processing fires. Without this, the per-invoice
    // dedupe lock from the first attempt would permanently suppress
    // notifications for every subsequent attempt on the same invoice.
    await db('invoices')
      .where({ id: failedInvoice.id })
      .update({
        status: nextStatus,
        paid_at: null,
        ach_processing_notified_at: null,
      });
  }

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

  // ── Bell + push for the admin team ──
  //
  // Fire-and-forget via Promise.catch (NOT awaited) so the webhook 2xx
  // is not gated on notification fan-out. Same reasoning + dedupe
  // pattern as the succeeded handler — see notifyPaymentSuccess()
  // above. Emit even when no invoice is bound — payment_failed is
  // urgent enough that an orphan PI failure still warrants a bell
  // entry; link defaults to /admin/revenue in that case.
  notifyPaymentFailed(paymentIntent, friendlyFailure, eventId).catch((err) => {
    logger.warn(`[stripe-webhook] payment_failed notify failed: ${err.message}`);
  });

  // ── Customer email for interactive (non-autopay, non-ACH) failures ──
  //
  // Autopay failures are already covered by billing-cron, which sends the
  // `payment.retry_notice` template once a retry has been scheduled —
  // emailing here would duplicate. ACH failures have their own dedicated
  // SMS + retry path in handleAchFailure. The remaining case — a card
  // payment that fails interactively (Pay page, customer-initiated) —
  // had no customer follow-up. We now send the `payment.failed` Waves
  // template so the customer gets a branded "we couldn't process that"
  // notice with a link back to retry or update their card. Idempotency
  // is per (PI, attempt) so a re-emitted webhook doesn't double-send.
  const isAutopay = paymentIntent.metadata?.type === 'monthly_autopay';
  if (pmType !== 'us_bank_account' && !isAutopay) {
    const attemptId = paymentIntent.latest_charge || eventId || 'no_charge';
    PaymentLifecycleEmail.sendPaymentFailed({
      paymentIntentId: piId,
      attemptId,
    }).catch((err) => {
      logger.warn(`[stripe-webhook] payment_failed customer email failed: ${err.message}`);
    });
  }
}

async function notifyPaymentFailed(paymentIntent, friendlyFailure, eventId) {
  const piId = paymentIntent.id;
  // Failures are NOT one-shot per PI: /api/pay/:token/update-amount
  // mutates an existing PI's amount and the customer can fail again
  // with the same PI. Stripe emits a separate payment_intent.payment_failed
  // event per attempt, each with a distinct latest_charge. Keying dedupe
  // on (PI, 'failed') alone (the original code in #546) suppressed every
  // failure after the first; operator never saw subsequent legitimate
  // failures.
  //
  // Attempt-id resolution (most stable to least):
  //   1. paymentIntent.latest_charge — set whenever a charge object was
  //      created for the attempt (the common case)
  //   2. event.id — Stripe guarantees uniqueness per Event; covers the
  //      rare authorize-fail path where the PI fails before creating a
  //      charge (e.g. risk-based auth refusal)
  //   3. 'no_charge' sentinel — last-ditch fallback if both are absent
  //      (should not happen in practice; defensive only)
  //
  // Codex P1 follow-up to #546.
  const attemptId = paymentIntent.latest_charge || eventId || 'no_charge';
  const claim = await db.raw(
    `INSERT INTO stripe_payment_notification_log (payment_intent_id, outcome, attempt_id)
     VALUES (?, ?, ?)
     ON CONFLICT (payment_intent_id, outcome, attempt_id) DO NOTHING
     RETURNING payment_intent_id`,
    [piId, 'failed', attemptId]
  );
  if (claim.rowCount === 0) {
    logger.info(`[stripe-webhook] payment_failed notification already dispatched for PI ${piId} attempt ${attemptId}, skipping`);
    return;
  }
  const failedInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first();
  let customer = null;
  if (failedInvoice?.customer_id) {
    customer = await db('customers').where({ id: failedInvoice.customer_id }).first();
  } else {
    const payment = await db('payments').where({ stripe_payment_intent_id: piId }).first();
    if (payment?.customer_id) {
      customer = await db('customers').where({ id: payment.customer_id }).first();
    }
  }
  await triggerNotification('payment_failed', {
    amount: (paymentIntent.amount || 0) / 100,
    customerName: customerLabel(customer),
    reason: friendlyFailure,
    invoiceId: failedInvoice?.id || null,
  });
}

/**
 * charge.refunded — Update refund status on payments table
 */
async function handleChargeRefunded(charge) {
  const chargeId = charge.id;
  logger.info(`[stripe-webhook] Charge refunded: ${chargeId}`);

  // Estimate deposits have no payments row — a dashboard refund (or the
  // webhook echo of our own refunds: stale deposit, exempt-path sweep,
  // unapplied remainder) must flip the deposit ledger so reversed money can
  // never satisfy acceptance or be credited, then skip the payments path
  // entirely. The cumulative refunded amount lets the handler recognize the
  // echo of a refund it already stamped (a partial remainder refund must not
  // flip a legitimately credited row).
  const { handleDepositChargeReversed } = require('../services/estimate-deposits');
  const depositReversal = await handleDepositChargeReversed(charge.payment_intent, 'charge.refunded', {
    amountRefundedCents: Number(charge.amount_refunded) > 0 ? Number(charge.amount_refunded) : null,
  });
  if (depositReversal.handled) return;

  const latestRefund = Array.isArray(charge.refunds?.data) ? charge.refunds.data[0] : null;
  const refundId = latestRefund?.id || charge.latest_refund || null;
  const refundDate = latestRefund?.created ? new Date(latestRefund.created * 1000) : new Date();
  const refundReason = latestRefund?.reason || 'Account adjustment';
  const refundAmountCents = latestRefund?.amount || charge.amount_refunded || 0;
  const refundAmountDollars = refundAmountCents / 100;
  const cumulativeRefundAmountDollars = (charge.amount_refunded || refundAmountCents) / 100;
  const isFullRefund = charge.refunded === true;

  await db('payments')
    .where({ stripe_charge_id: chargeId })
    .update({
      status: isFullRefund ? 'refunded' : 'paid',
      refund_amount: cumulativeRefundAmountDollars,
      refund_status: isFullRefund ? 'full' : 'partial',
      stripe_refund_id: refundId,
    });

  const refundedPayment = await db('payments').where({ stripe_charge_id: chargeId }).first();
  if (refundedPayment?.customer_id) {
    PaymentLifecycleEmail.sendRefundIssued({
      customerId: refundedPayment.customer_id,
      paymentId: refundedPayment.id,
      refundId: refundId || chargeId,
      refundAmount: refundAmountDollars,
      refundDate,
      refundReason,
    }).catch((emailErr) => {
      logger.warn(`[stripe-webhook] Refund issued email failed for charge ${chargeId}: ${emailErr.message}`);
    });
  }

  // Notify admin bell + push of refund
  try {
    await triggerNotification('payment_refunded', {
      amount: refundAmountDollars,
      isFullRefund,
      invoiceId: refundedPayment?.invoice_id || null,
    });
  } catch (e) {
    logger.warn(`[stripe-webhook] refund triggerNotification failed: ${e.message}`);
  }

  // Fire-and-forget health rescore after refund
  try {
    const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();
    if (isFullRefund && payment) {
      try {
        await require('../services/annual-prepay-renewals').syncTermForRefundedPayment(payment);
      } catch (err) {
        logger.warn(`[stripe-webhook] annual prepay refund sync skipped for charge ${chargeId}: ${err.message}`);
      }
    }
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
    // Third-party Bill-To: an AP bank failure on a payer-billed invoice must not
    // mutate the homeowner's ACH status (suspension, card-default flip) or text
    // them the retry/suspension notices — that bank account is the payer's.
    const achInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first().catch(() => null);
    if (achInvoice?.payer_id) {
      logger.info(`[stripe-webhook] ACH failure on payer-billed invoice ${achInvoice.invoice_number} (PI ${piId}) — skipping homeowner ACH handling`);
      return;
    }
    const customer = await db('customers').where({ id: payment.customer_id }).first();
    if (!customer) return;

    // Insert + count + state-update wrapped in one transaction with a
    // per-customer advisory lock. Two concurrent ACH failures (e.g.,
    // an autopay charge and a one-off invoice failing within seconds
    // of each other) used to both insert into ach_failure_log, both
    // run a separate count, and could both see the same recentFailures
    // value — escalating twice or skipping a step. Same advisory-lock
    // pattern as the terminal handoff mint serialization.
    let recentFailures = 0;
    await db.transaction(async (trx) => {
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['ach.escalation', String(customer.id)],
      );

      try {
        await trx('ach_failure_log').insert({
          customer_id: customer.id,
          stripe_payment_intent_id: piId,
          failure_reason: failureReason,
        });
      } catch { /* table may not exist yet */ }

      // Count is now guaranteed to include the just-inserted row because
      // the advisory lock serialized this whole block per customer.
      try {
        recentFailures = Number((await trx('ach_failure_log')
          .where({ customer_id: customer.id, resolved: false })
          .where('failure_date', '>=', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
          .count('* as cnt')
          .first())?.cnt || 0);
      } catch { /* table may not exist */ }

      // ACH status update lives inside the transaction so the customer
      // row's ach_status / ach_failure_count match the count we just
      // computed. A concurrent failure handler waiting on the lock
      // will see this state when it acquires next.
      try {
        if (recentFailures >= 3) {
          await trx('customers').where({ id: customer.id }).update({
            ach_status: 'suspended',
            ach_failure_count: recentFailures,
          });
          const cardMethod = await trx('payment_methods')
            .where({ customer_id: customer.id, method_type: 'card' })
            .first();
          if (cardMethod) {
            await trx('payment_methods')
              .where({ customer_id: customer.id })
              .update({ is_default: false });
            await trx('payment_methods')
              .where({ id: cardMethod.id })
              .update({ is_default: true });
          }
          logger.warn(`[stripe-webhook] ACH suspended for customer ${customer.id} — 3+ failures in 90 days`);
        } else if (recentFailures >= 2) {
          await trx('customers').where({ id: customer.id }).update({
            ach_status: 'needs_verification',
            ach_failure_count: recentFailures,
          });
          logger.warn(`[stripe-webhook] ACH needs verification for customer ${customer.id}`);
        } else {
          await trx('customers').where({ id: customer.id }).update({
            ach_failure_count: recentFailures,
          });
        }
      } catch (dbErr) {
        logger.error(`[stripe-webhook] ACH status update failed: ${dbErr.message}`);
        throw dbErr;
      }
    });

    // Send SMS outside the transaction so a slow provider call doesn't
    // hold the per-customer advisory lock against concurrent failures.
    try {
      if (customer.phone) {
        let body;
        let messageType;
        const billingUrl = `${publicPortalUrl()}/billing`;
        if (recentFailures >= 3) {
          messageType = 'ach_suspended';
        } else if (recentFailures >= 2) {
          messageType = 'ach_card_fallback';
        } else {
          messageType = 'ach_retry_notice';
        }
        body = await renderRequiredSmsTemplate(messageType, {
          first_name: customer.first_name || 'there',
          billing_url: billingUrl,
        }, {
          workflow: messageType,
          entity_type: 'payment_intent',
          entity_id: paymentIntent.id,
        });
        const smsResult = await sendBillingSms(customer, body, {
          original_message_type: messageType,
          stripe_payment_intent_id: paymentIntent.id,
          recent_failures: recentFailures,
        });
        if (!smsResult.sent) {
          logger.warn(`[stripe-webhook] ACH failure SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
      }
    } catch (smsErr) {
      logger.error(`[stripe-webhook] ACH failure SMS failed: ${smsErr.message}`);
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
 *
 * `eventCreated` is the Stripe event's unix-seconds timestamp — i.e. the
 * moment Stripe recorded the processing transition, which is the closest
 * proxy we have for "customer authorized the ACH transfer". Don't use
 * paymentIntent.created: the PI is minted at /pay/:token/setup and reused
 * via /update-amount, so it can predate authorization by hours or days.
 *
 * `eventId` is the Stripe event id and is unique per processing-transition
 * delivery. It's used in the email idempotency key so that a re-attempted
 * ACH against the same PI (services/stripe.js updates the existing PI in
 * requires_payment_method instead of minting a new one) still gets a
 * fresh acknowledgment email, while genuine duplicate webhook deliveries
 * of the same event remain deduped at the email_messages level.
 */
async function handlePaymentIntentProcessing(paymentIntent, eventCreated = null, eventId = null) {
  const piId = paymentIntent.id;
  logger.info(`[stripe-webhook] PaymentIntent processing (ACH in flight): ${piId}`);
  if (paymentIntent.metadata?.waves_statement_id) {
    await handleStatementPaymentIntentEvent(paymentIntent, 'processing');
    return;
  }
  const invoice = await findInvoiceForPaymentIntent(paymentIntent);
  const isAch = isAchPaymentIntent(paymentIntent, paymentIntent.metadata?.selected_method_category);
  if (!isAch) {
    logger.info(`[stripe-webhook] Ignoring non-ACH PaymentIntent processing event: ${piId}`);
    return;
  }
  const stripe = getStripe();
  if (stripe) {
    const currentIntent = await stripe.paymentIntents.retrieve(piId);
    if (currentIntent.status !== 'processing') {
      logger.info(`[stripe-webhook] Ignoring stale processing event for PI ${piId}; current status is ${currentIntent.status}`);
      return;
    }
  }

  const amount = centsToDollars(paymentIntent.amount);
  const metadataBaseAmount = Number(paymentIntent.metadata?.base_amount ?? invoice?.total ?? amount);
  const metadataCardSurcharge = Number(paymentIntent.metadata?.card_surcharge ?? 0);

  const paymentMetadata = JSON.stringify({
    invoice_id: invoice?.id || paymentIntent.metadata?.waves_invoice_id || null,
    base_amount: metadataBaseAmount,
    card_surcharge: metadataCardSurcharge,
    charged_amount: amount,
    payment_method: isAch ? 'us_bank_account' : paymentIntent.payment_method_types?.[0] || null,
    payment_state: 'processing',
  });

  if (!invoice?.id) {
    logger.warn(`[stripe-webhook] No invoice found for ACH processing PI: ${piId}`);
    return;
  }

  await db.transaction(async (trx) => {
    await lockPaymentIntentPaymentRow(trx, piId);

    const lockedInvoice = await trx('invoices')
      .where({ id: invoice.id })
      .forUpdate()
      .first();

    if (!lockedInvoice) return;
    if (INVOICE_TERMINAL_PAYMENT_STATUSES.includes(String(lockedInvoice.status || '').toLowerCase())) {
      logger.info(`[stripe-webhook] Skipping processing event for terminal invoice ${invoice.id} status=${lockedInvoice.status} on PI: ${piId}`);
      return;
    }

    const activePi = lockedInvoice.stripe_payment_intent_id
      ? String(lockedInvoice.stripe_payment_intent_id)
      : '';
    if (activePi && activePi !== String(piId)) {
      logger.warn(
        `[stripe-webhook] Ignoring stale ACH processing PI ${piId} for invoice ${invoice.id}; ` +
        `active PI is ${activePi}`,
      );
      return;
    }

    const expected = computeChargeAmount(parseFloat(lockedInvoice.total), 'us_bank_account');
    const expectedCents = Math.round(expected.total * 100);
    const actualCents = Number(paymentIntent.amount || 0);
    if (actualCents !== expectedCents) {
      logger.error(
        `[stripe-webhook] ACH processing amount mismatch on PI ${piId}. ` +
        `Expected ${expectedCents}c from invoice ${lockedInvoice.id}; got ${actualCents}c.`,
      );
      if (stripe) {
        try {
          await stripe.paymentIntents.cancel(piId);
        } catch (cancelErr) {
          logger.warn(`[stripe-webhook] Could not cancel mismatched processing PI ${piId}: ${cancelErr.message}`);
        }
      }
      return;
    }

    const existingPayment = await trx('payments')
      .where({ stripe_payment_intent_id: piId })
      .forUpdate()
      .first();
    // 'disputed' is terminal too: a delayed/reclaimed processing event
    // must not pull a chargeback back to processing (which would also
    // flip the reopened invoice below, hiding it from dunning).
    if (['paid', 'refunded', 'canceled', 'cancelled', 'disputed'].includes(existingPayment?.status)) {
      logger.info(`[stripe-webhook] Skipping processing downgrade for terminal payment row on PI: ${piId}`);
      return;
    }

    if (existingPayment) {
      await trx('payments')
        .where({ id: existingPayment.id })
        .update({
          status: 'processing',
          failure_reason: null,
          amount,
          metadata: paymentMetadata,
        });
    } else {
      if (!invoice?.customer_id) return;

      await trx('payments').insert({
        customer_id: invoice.customer_id,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        payment_date: etDateString(),
        amount,
        base_amount_cents: Math.round(Number(paymentIntent.metadata?.base_amount || invoice.total) * 100),
        surcharge_amount_cents: Math.round(Number(paymentIntent.metadata?.card_surcharge || 0) * 100),
        surcharge_rate_bps: Number(paymentIntent.metadata?.surcharge_rate_bps || 0),
        surcharge_policy_version: paymentIntent.metadata?.surcharge_policy_version || null,
        card_funding: paymentIntent.metadata?.card_funding || null,
        card_brand: null,
        status: 'processing',
        description: `Invoice ${invoice.invoice_number} (bank payment pending)`,
        metadata: paymentMetadata,
      });
    }

    await trx('invoices')
      .where({ id: lockedInvoice.id })
      .whereNotIn('status', INVOICE_TERMINAL_PAYMENT_STATUSES)
      .where(function activeProcessingIntentGuard() {
        this.whereNull('stripe_payment_intent_id')
          .orWhere({ stripe_payment_intent_id: piId });
      })
      .update({
        status: 'processing',
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        payment_method: isAch ? 'us_bank_account' : paymentIntent.payment_method_types?.[0] || null,
        total: amount,
      });
  });

  // ── Customer-facing ACH "we got it, processing" acknowledgment ──
  //
  // The customer initiated a bank transfer; ACH takes 3–5 business days
  // to clear. Without an acknowledgment the invoice silently flips from
  // Sent → Processing in the portal and the customer hears nothing
  // until the receipt fires days later (or worse, a failure SMS).
  //
  // At-most-once dispatch via a claim-style UPDATE on
  // invoices.ach_processing_notified_at: the worker whose update flips
  // the column from NULL to a timestamp wins the one-shot lock and
  // proceeds to send. Concurrent duplicates and Stripe replays lose
  // the race (affected rows == 0) and bail. A failure to deliver after
  // the claim is deliberately not retried here — see the prior threads
  // on this PR for the trade-off rationale; the per-attempt clear in
  // handlePaymentIntentFailed handles the realistic re-attempt case.
  // Channels run independently: missing phone skips SMS but email
  // still fires, and vice versa.
  //
  // Fire-and-forget via setImmediate so a Twilio/SendGrid hiccup
  // doesn't make Stripe retry the entire webhook (which would re-run
  // the amount-mismatch + status guards above).
  setImmediate(async () => {
    try {
      const freshInvoice = await db('invoices').where({ id: invoice.id }).first();
      if (!freshInvoice) return;
      if (freshInvoice.ach_processing_notified_at) return;
      if (freshInvoice.status !== 'processing') return;

      // Third-party Bill-To: an AP ACH payment processing on a payer-billed
      // invoice must not text/email the homeowner the bank-transfer notice (the
      // sendAchProcessing email also self-guards, but the direct SMS below
      // wouldn't). The payer AP contact authorized this transfer, not the
      // service recipient.
      if (freshInvoice.payer_id) return;

      const customer = freshInvoice.customer_id
        ? await db('customers').where({ id: freshInvoice.customer_id }).first()
        : null;
      if (!customer) return;

      // Atomic claim: the UPDATE doubles as the dedupe lock. Two concurrent
      // workers (Stripe duplicate delivery, processing-after-downgrade
      // replay) both reach the pre-read with notified_at NULL; only the one
      // whose UPDATE flips rows from 0 to 1 proceeds to dispatch. The
      // status filter also closes a race with payment_intent.succeeded —
      // if .succeeded flipped the invoice to 'paid' between the pre-read
      // and this UPDATE, affectedRows is 0 and we bail rather than send a
      // contradictory "processing" message after the receipt fired.
      // Stripe doesn't guarantee webhook ordering. A stale processing
      // event for a prior, abandoned PI on the same invoice could
      // otherwise win this claim and send an acknowledgment for the
      // wrong attempt. The transaction above already bound
      // invoices.stripe_payment_intent_id to piId, so requiring it
      // here matches "this event is for the currently active PI."
      const claimed = await db('invoices')
        .where({ id: freshInvoice.id })
        .where({ status: 'processing' })
        .where({ stripe_payment_intent_id: piId })
        .whereNull('ach_processing_notified_at')
        .update({ ach_processing_notified_at: new Date() });
      if (!claimed) return;

      if (customer.phone) {
        try {
          const smsBody = await renderRequiredSmsTemplate('ach_payment_processing', {
            first_name: customer.first_name || 'there',
            invoice_number: freshInvoice.invoice_number || '',
          }, {
            workflow: 'ach_payment_processing',
            entity_type: 'invoice',
            entity_id: freshInvoice.id,
          });
          const smsResult = await sendBillingSms(customer, smsBody, {
            original_message_type: 'ach_payment_processing',
            stripe_payment_intent_id: piId,
            invoice_id: freshInvoice.id,
          });
          if (!smsResult.sent) {
            logger.warn(`[stripe-webhook] ACH processing SMS blocked/failed for invoice ${freshInvoice.invoice_number}: ${smsResult.code || smsResult.reason || 'unknown'}`);
          }
        } catch (smsErr) {
          logger.error(`[stripe-webhook] ACH processing SMS failed for invoice ${freshInvoice.invoice_number}: ${smsErr.message}`);
        }
      }

      // Anchor on the Stripe event's recorded transition time — that's
      // the closest proxy for "customer authorized the transfer." Never
      // use paymentIntent.created: the PI is minted upstream at
      // /pay/:token/setup and reused via /update-amount, so its created
      // timestamp can predate authorization by hours or days. Fall back
      // to now() only when the event timestamp wasn't threaded through.
      const initiatedAt = eventCreated
        ? new Date(eventCreated * 1000)
        : new Date();
      const expectedClearDate = addBusinessDays(initiatedAt, 5);
      const emailResult = await PaymentLifecycleEmail.sendAchProcessing({
        customerId: freshInvoice.customer_id,
        invoiceId: freshInvoice.id,
        amountPaid: amount,
        initiatedAt,
        expectedClearDate,
        // Scope by event id, not just (invoice, PI). services/stripe.js
        // updates an existing PI in requires_payment_method on retry
        // instead of minting a new one, so piId is stable across attempts
        // and a key of `{invoiceId}:{piId}` would dedupe forever after the
        // first send. Every payment_intent.processing delivery has a
        // unique event id; duplicate webhook deliveries of the *same*
        // event share an id (so email_messages.idempotency_key still
        // dedupes those), but a genuine new attempt fires a new event id
        // and gets a fresh email. Falls back to (invoice, PI) if the
        // event id wasn't threaded — preserves the prior behavior.
        idempotencyKey: eventId
          ? `payment.ach_processing:${freshInvoice.id}:${eventId}`
          : `payment.ach_processing:${freshInvoice.id}:${piId}`,
      }).catch((err) => ({ ok: false, error: err.message }));
      if (!emailResult?.ok) {
        const reason = emailResult?.reason || emailResult?.error || 'unknown';
        if (reason !== 'missing_email' && reason !== 'customer_not_found') {
          logger.warn(`[stripe-webhook] ACH processing email not sent for invoice ${freshInvoice.invoice_number}: ${reason}`);
        }
      }
    } catch (err) {
      logger.error(`[stripe-webhook] ACH processing acknowledgment failed for PI ${piId}: ${err.message}`, { stack: err.stack });
    }
  });
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
        const body = await renderRequiredSmsTemplate('bank_verification_incomplete', {
          first_name: customer.first_name || 'there',
          billing_url: `${publicPortalUrl()}/billing`,
        }, {
          workflow: 'bank_verification_incomplete',
          entity_type: 'payment_intent',
          entity_id: piId,
        });
        const smsResult = await sendBillingSms(
          customer,
          body,
          { original_message_type: 'bank_verification_incomplete', stripe_payment_intent_id: piId }
        );
        if (!smsResult.sent) {
          logger.warn(`[stripe-webhook] Requires-action SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
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
  if (paymentIntent.metadata?.waves_statement_id) {
    await handleStatementPaymentIntentEvent(paymentIntent, 'canceled');
    return;
  }

  // Deposit PIs have no payments row — mark the pending ledger row terminal
  // instead (which advances the retry generation so the next deposit
  // attempt mints a fresh PI rather than reusing this canceled secret).
  if (paymentIntent.metadata?.purpose === 'estimate_deposit') {
    const { handleDepositIntentCanceled } = require('../services/estimate-deposits');
    await handleDepositIntentCanceled(paymentIntent);
    return;
  }

  // No .catch — a failed write must propagate so the event is retried.
  await db('payments')
    .where({ stripe_payment_intent_id: piId })
    .whereNotIn('status', ['paid', 'refunded', 'disputed'])
    .update({ status: 'canceled' });
}

/**
 * Resolve the invoice a payments row collected against. payments has no
 * invoice_id column — the linkage lives in metadata JSON (invoice_id /
 * waves_invoice_id) and on invoices.stripe_payment_intent_id.
 */
async function findInvoiceForPayment(payment) {
  let meta = {};
  try {
    meta = payment.metadata
      ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata)
      : {};
  } catch (e) { /* unparseable metadata — fall through to PI lookup */ }
  const metaInvoiceId = meta.dispute_invoice_id || meta.invoice_id || meta.waves_invoice_id || null;
  if (metaInvoiceId) {
    const invoice = await db('invoices').where({ id: metaInvoiceId }).first();
    if (invoice) return invoice;
  }
  if (payment.stripe_payment_intent_id) {
    return db('invoices')
      .where({ stripe_payment_intent_id: payment.stripe_payment_intent_id })
      .first();
  }
  return null;
}

/**
 * charge.dispute.created — ACH return or chargeback. ~60 days to respond.
 * Flip invoice back to overdue, log dispute, alert admin.
 */
// Statement chargeback (P3): a statement settlement's `payments` row is keyed by
// statement_id (no invoice_id), so the invoice-keyed dispute path no-ops and would
// leave payer_statements + every child invoice silently `paid` after a clawback.
// Reverse the cascade so AR/dunning see it owed again; restore on a won dispute.
// Both idempotent + run under the statement row lock.
async function reverseStatementCascadeForDispute(statementId, reason) {
  await db.transaction(async (trx) => {
    const stmt = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
    if (!stmt || stmt.status !== 'paid') return; // only a paid statement reverses
    const { priorPayableStatus } = require('../services/payer-statement-settle');
    const now = new Date();
    await trx('payer_statements').where({ id: statementId })
      .update({
        status: priorPayableStatus(stmt),
        paid_at: null,
        // Clear the settled PI/charge: /setup + reconcile treat a lingering
        // succeeded PI as the active payment and 409, so the reopened AR could
        // never be re-collected. The disputed `payments` row keeps the PI/charge
        // for the audit trail.
        stripe_payment_intent_id: null,
        stripe_charge_id: null,
        updated_at: now,
      });
    // Reopen the children the cascade settled (paid → draft = accrued again).
    await trx('invoices').where({ payer_statement_id: statementId }).where('status', 'paid')
      .update({ status: 'draft', paid_at: null, updated_at: now });
  });
  logger.warn(`[stripe-webhook] statement S-${statementId} chargeback (${reason}) — reverted to owed; child invoices reopened`);
}

async function restoreStatementCascadeForDispute(statementId) {
  await db.transaction(async (trx) => {
    const stmt = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
    // Skip if already paid (re-collected after the reversal) or void.
    if (!stmt || stmt.status === 'paid' || stmt.status === 'void') return;
    const now = new Date();
    await trx('payer_statements').where({ id: statementId })
      .update({ status: 'paid', paid_at: now, updated_at: now });
    await trx('invoices').where({ payer_statement_id: statementId }).whereNotIn('status', ['void', 'paid'])
      .update({ status: 'paid', paid_at: now, updated_at: now });
  });
  logger.info(`[stripe-webhook] statement S-${statementId} dispute won — cascade restored to paid`);
}

async function handleDisputeCreated(dispute) {
  const chargeId = dispute.charge;
  const reason = dispute.reason || 'unknown';
  const amount = (dispute.amount / 100).toFixed(2);
  logger.warn(`[stripe-webhook] Dispute created: ${dispute.id} on charge ${chargeId} — $${amount} (${reason})`);

  // Deposit PIs have no payments row — flip the deposit ledger (disputed
  // money can never satisfy acceptance) and skip the payments path.
  const { handleDepositChargeReversed } = require('../services/estimate-deposits');
  const depositReversal = await handleDepositChargeReversed(dispute.payment_intent, 'dispute.created');
  if (depositReversal.handled) return;

  // Revert payment + invoice
  // These are critical ledger writes: no .catch — a failure must
  // propagate so the event is NOT marked processed and Stripe retries.
  const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();
  let createdPaymentMeta = {};
  if (payment) {
    try {
      createdPaymentMeta = payment.metadata
        ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata)
        : {};
    } catch (e) { /* unparseable legacy metadata */ }
    // Ordering guard: if dispute.closed for THIS dispute was already
    // processed (Stripe doesn't guarantee order — a retried created can
    // land after won/lost), the final state owns the row. Flipping a
    // won charge back to disputed/overdue would reopen collection for
    // money already reinstated.
    if (createdPaymentMeta.dispute_final && createdPaymentMeta.dispute_id === dispute.id) {
      logger.warn(`[stripe-webhook] Dispute ${dispute.id} already closed (${createdPaymentMeta.dispute_final}) — created event is a late replay, skipping ledger writes`);
    } else {
    await db('payments').where({ id: payment.id }).update({
      status: 'disputed',
      failure_reason: `Dispute: ${reason}`,
    });

    if (payment.statement_id) {
      // Statement chargeback — reverse the cascade (the invoice path below
      // no-ops on a statement settlement and would leave it silently paid).
      await reverseStatementCascadeForDispute(payment.statement_id, `dispute.created (${reason})`);
    } else {
    // payments has no invoice_id column — the linkage lives in the
    // metadata JSON and on invoices.stripe_payment_intent_id. 'overdue'
    // (not 'unpaid', which no open-invoice query matches) puts the
    // clawed-back invoice back into dunning and balance sums.
    // Reopen 'processing' as well as 'paid': an ACH return can arrive
    // while the invoice is still processing (or before the succeeded
    // event lands), and the disputed-PI guard in the succeeded handler
    // would otherwise leave it stuck there.
    const invoice = await findInvoiceForPayment(payment);
    const invoicePi = invoice?.stripe_payment_intent_id ? String(invoice.stripe_payment_intent_id) : null;
    const disputedPi = payment.stripe_payment_intent_id ? String(payment.stripe_payment_intent_id) : null;
    // Only reopen when THIS disputed payment still settles the invoice —
    // if a different PI (or a cash/check reconcile with no PI) owns it,
    // the money in question isn't what's backing the invoice.
    if (invoice && ['paid', 'processing'].includes(invoice.status)
      && invoicePi && disputedPi && invoicePi === disputedPi) {
      // Persist the binding on the payment row BEFORE clearing the
      // invoice's PI: card-on-file payment rows don't carry invoice_id
      // in metadata, and dispute-closed (won) must still find this
      // invoice to restore it.
      await db('payments').where({ id: payment.id }).update({
        metadata: JSON.stringify({ ...createdPaymentMeta, dispute_invoice_id: invoice.id }),
      });

      await db('invoices').where({ id: invoice.id }).update({
        status: 'overdue',
        paid_at: null,
        // Clear the PI linkage: the pay page and card-on-file paths
        // treat a lingering non-canceled intent as "payment already in
        // progress" and would refuse re-collection on the reopened
        // invoice. The disputed payments row keeps the original PI for
        // the audit trail.
        stripe_payment_intent_id: null,
        stripe_charge_id: null,
      });
    }
    }
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

  // Deposit PIs settle on the deposit ledger, not the payments table.
  // Lost = row already refunded (dispute.created flipped it). Won = funds
  // reinstated but the row stays refunded; flagged for manual restore.
  const { handleDepositDisputeClosed } = require('../services/estimate-deposits');
  const depositDispute = await handleDepositDisputeClosed(dispute.payment_intent, status);
  if (depositDispute.handled) return;

  // Critical ledger writes: no .catch — failures must propagate so the
  // event is NOT marked processed and Stripe retries.
  const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();
  if (payment) {
    // Record the final dispute state on the payment row so a late or
    // retried dispute.created for the same dispute is a no-op instead
    // of flipping a settled outcome back to disputed/overdue.
    let closedPaymentMeta = {};
    try {
      closedPaymentMeta = payment.metadata
        ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata)
        : {};
    } catch (e) { /* unparseable legacy metadata */ }
    const finalMeta = JSON.stringify({
      ...closedPaymentMeta,
      dispute_id: dispute.id,
      dispute_final: status,
    });

    if (status === 'won' || status === 'warning_closed') {
      // Funds reinstated — restore paid status
      await db('payments').where({ id: payment.id }).update({ status: 'paid', metadata: finalMeta });
      // Statement: restore the cascade (unless re-collected meanwhile). The
      // invoice path below no-ops for a statement payment.
      if (payment.statement_id) await restoreStatementCascadeForDispute(payment.statement_id);
      const invoice = await findInvoiceForPayment(payment);
      const wonInvoicePi = invoice?.stripe_payment_intent_id ? String(invoice.stripe_payment_intent_id) : null;
      const wonDisputedPi = payment.stripe_payment_intent_id ? String(payment.stripe_payment_intent_id) : null;
      // Only restore when no REPLACEMENT payment owns the invoice: after
      // dispute.created reopened it, the customer may have re-paid with
      // a new PI (now paid or processing). Marking that invoice paid
      // here would double-settle it while the replacement still
      // collects. The reopen path cleared the PI, so a null PI means
      // the dispute still owns it.
      if (invoice && invoice.status !== 'paid'
        && (!wonInvoicePi || (wonDisputedPi && wonInvoicePi === wonDisputedPi))) {
        await db('invoices').where({ id: invoice.id }).update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          // Restore the linkage the reopen cleared — the disputed PI's
          // funds are what settle this invoice again.
          stripe_payment_intent_id: payment.stripe_payment_intent_id || null,
          stripe_charge_id: payment.stripe_charge_id || null,
        });
      }
    } else if (status === 'lost') {
      // Money is gone for good. Set status explicitly — Stripe does not
      // guarantee dispute.created arrived first, so don't assume the
      // row is already 'disputed'. It stays/becomes 'disputed' (terminal
      // in every succeeded/failed/canceled handler guard — 'failed'
      // would let a late payment_intent.succeeded resurrect the
      // chargeback to paid), and the invoice is reopened idempotently
      // so dunning chases it even when created/closed arrive reversed.
      await db('payments').where({ id: payment.id }).update({
        status: 'disputed',
        failure_reason: `Dispute lost — $${amount} returned to customer`,
        metadata: finalMeta,
      });
      // Statement: ensure the cascade is reversed (idempotent — created already
      // did it, but closed(lost) can arrive without a created event).
      if (payment.statement_id) await reverseStatementCascadeForDispute(payment.statement_id, 'dispute.lost');
      const lostInvoice = await findInvoiceForPayment(payment);
      const lostInvoicePi = lostInvoice?.stripe_payment_intent_id ? String(lostInvoice.stripe_payment_intent_id) : null;
      const lostDisputedPi = payment.stripe_payment_intent_id ? String(payment.stripe_payment_intent_id) : null;
      // Only reopen when the disputed PI still settles the invoice.
      // Normal flow: dispute.created already reopened it, the customer
      // re-paid with a NEW PI, then closed(lost) lands days later —
      // that newly paid invoice must not be flipped back to overdue.
      if (lostInvoice && ['paid', 'processing'].includes(lostInvoice.status)
        && lostInvoicePi && lostDisputedPi && lostInvoicePi === lostDisputedPi) {
        await db('invoices').where({ id: lostInvoice.id }).update({
          status: 'overdue',
          paid_at: null,
          // Same PI-linkage clear as dispute-created: a lingering
          // non-canceled intent blocks the pay page / card-on-file
          // re-collection paths with "payment already in progress".
          stripe_payment_intent_id: null,
          stripe_charge_id: null,
        });
      }
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
        const body = await renderRequiredSmsTemplate('bank_verification_failed', {
          first_name: customer.first_name || 'there',
          billing_url: `${publicPortalUrl()}/billing`,
        }, {
          workflow: 'bank_verification_failed',
          entity_type: 'setup_intent',
          entity_id: setupIntent.id,
        });
        const smsResult = await sendBillingSms(
          customer,
          body,
          { original_message_type: 'bank_verification_failed', stripe_setup_intent_id: setupIntent.id }
        );
        if (!smsResult.sent) {
          logger.warn(`[stripe-webhook] Setup-failed SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
      }
    }
  } catch { /* non-critical */ }
}

module.exports = router;
