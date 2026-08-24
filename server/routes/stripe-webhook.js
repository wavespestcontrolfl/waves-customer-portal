const express = require('express');
const Sentry = require('@sentry/node');
const { safeErrorToken } = require('../utils/sentry-scrub');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const { isBankMethodType } = require('../services/autopay-eligibility');
const stripeConfig = require('../config/stripe-config');
const {
  classifyExistingWebhookEvent,
  invoicePaymentIntentBlocksFallback,
  lateSavedCardPaymentNeedsOrphan,
  savedCardAttemptMatchesPaymentIntent,
  savedCardCreditAdjustment,
  STALE_CLAIM_WINDOW_MS,
} = require('./stripe-webhook-helpers');
const { triggerNotification } = require('../services/notification-triggers');
// Admin bell rows go through NotificationService (not raw inserts) so the
// GATE_ADMIN_BELL_POLICY chokepoint covers them.
const NotificationService = require('../services/notification-service');
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
const { INVOICE_UNCOLLECTIBLE_STATUSES, invoiceAmountDue } = require('../services/invoice-helpers');
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
  const result = await sendCustomerMessage({
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
  // Send-window hold: a Stripe event (ACH failure, requires-action,
  // setup-failure) fires ONCE and is deduped — no morning retry exists, so
  // a held notice must persist its own on the scheduled-SMS rail or the
  // customer permanently misses an actionable billing message.
  // replay_purpose pins the 8 AM dispatch to the same payment_failure
  // policy this immediate send ran under. Reported as { scheduled: true }
  // so callers log deferred, not lost; a failed enqueue falls through and
  // returns the block unchanged (loudly logged).
  if (!result.sent
    && result.code === 'QUIET_HOURS_HOLD'
    && result.deferred
    && result.nextAllowedAt) {
    try {
      const TWILIO_NUMBERS = require('../config/twilio-numbers');
      // Stable invoice identity for the replay recheck (codex r21): the
      // PaymentIntent is NOT durable linkage — a customer who switches
      // tender overnight repoints the invoice to a NEW card PI, so a
      // PI-keyed lookup at 8 AM finds nothing and the notice would read as
      // "invoice-less" and replay a frozen bank-failure text over a
      // successfully paid invoice. Resolve the invoice ONCE here, while
      // the association is still current, and persist its id.
      let resolvedInvoiceId = metadata.invoice_id || null;
      if (!resolvedInvoiceId && metadata.stripe_payment_intent_id) {
        try {
          const inv = await db('invoices')
            .where({ stripe_payment_intent_id: metadata.stripe_payment_intent_id })
            .first('id');
          resolvedInvoiceId = inv?.id || null;
        } catch (lookupErr) {
          logger.warn(`[stripe-webhook] invoice lookup for held billing SMS failed: ${lookupErr.message} — queueing without stable invoice id`);
        }
      }
      await db('sms_log').insert({
        customer_id: customer.id,
        direction: 'outbound',
        from_phone: TWILIO_NUMBERS.getOutboundNumber(),
        to_phone: customer.phone,
        message_body: body,
        status: 'scheduled',
        scheduled_for: new Date(result.nextAllowedAt),
        message_type: metadata.original_message_type || 'billing_reminder',
        metadata: JSON.stringify({
          ...metadata,
          ...(resolvedInvoiceId ? { invoice_id: resolvedInvoiceId } : {}),
          entry_point: 'stripe_webhook_billing_deferred',
          original_block_code: result.code,
          replay_purpose: 'payment_failure',
          refresh_customer_phone: true,
          resolve_from_by_customer: true,
        }),
      });
      logger.info(`[stripe-webhook] Billing SMS for customer ${customer.id} held outside the 8AM-8PM ET send window — queued for ${result.nextAllowedAt} (${metadata.original_message_type || 'billing'})`);
      return { ...result, scheduled: true };
    } catch (queueErr) {
      // The queued row is the ONLY durable form of this notice (the Stripe
      // event dedupes once the handler succeeds) — a lost enqueue must
      // fail the handler so Stripe redelivers; the ACH replay path's
      // notice probe then allows the SMS re-attempt without re-counting
      // the failure.
      logger.error(`[stripe-webhook] Held billing SMS requeue FAILED for customer ${customer.id}: ${queueErr.message} — failing the handler so the event redelivers`);
      const err = new Error(`Held billing SMS could not be queued: ${queueErr.message}`);
      err.code = 'BILLING_NOTICE_ENQUEUE_FAILED';
      throw err;
    }
  }
  return result;
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
    // `resolved` = the method/funding came from ACTUAL Stripe data (charge or PM),
    // NOT the payment_method_types[0] default. Callers that must distinguish a
    // real card from an ACH (e.g. statement surcharge validation) check this so a
    // transient lookup failure isn't treated as a card.
    resolved: false,
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

  details.resolved = resolvedFromStripeDetails;
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
      details.resolved = true;
    } else if (pm?.us_bank_account) {
      details.paymentMethod = 'us_bank_account';
      details.cardLastFour = pm.us_bank_account.last4 || details.cardLastFour;
      details.resolved = true;
    } else if (pm?.type) {
      details.paymentMethod = pm.type;
      details.resolved = true;
    }
  } catch (err) {
    logger.warn(`[stripe-webhook] payment method lookup failed for PI ${paymentIntent.id}: ${err.message}`);
  }

  return details;
}

async function findMatchingSavedCardAttempt(
  database,
  invoice,
  paymentIntent,
  { lock = false, allowResolvedSucceeded = false } = {},
) {
  if (!invoice || paymentIntent.metadata?.source !== 'admin_card_on_file') return null;
  let query = database('stripe_invoice_charge_attempts')
    .where({ invoice_id: invoice.id });
  if (paymentIntent.metadata?.saved_card_attempt_id) {
    query = query.where({ id: paymentIntent.metadata.saved_card_attempt_id });
  } else if (paymentIntent.id) {
    query = query.where({ stripe_payment_intent_id: paymentIntent.id });
  } else {
    return null;
  }
  query = query.whereIn(
    'status',
    allowResolvedSucceeded ? ['claimed', 'ambiguous', 'succeeded'] : ['claimed', 'ambiguous'],
  );
  if (!allowResolvedSucceeded) query = query.whereNull('resolved_at');
  if (lock) query = query.forUpdate();
  const candidate = await query.first(
    'id',
    'invoice_id',
    'status',
    'resolved_at',
    'created_at',
    'stripe_payment_method_id',
    'stripe_payment_intent_id',
    'idempotency_key',
    'credit_applied_delta',
    'credit_applied_total',
  );
  return savedCardAttemptMatchesPaymentIntent({
    attempt: candidate,
    invoice,
    paymentIntent,
    allowResolvedSucceeded,
  }) ? candidate : null;
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
      const savedCardAttempt = await findMatchingSavedCardAttempt(db, byMetadata, paymentIntent);
      if (savedCardAttempt) return byMetadata;
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

// Ledger row for a one-time card-hold no-show / late-cancel fee. These PIs have
// no invoice (the inline charge only touches estimate_card_holds), so without
// this they'd be charged in Stripe but absent from payments history + revenue/
// tax reports. Idempotent on the PI id; the waves_customer_id is stamped by
// chargeSavedPaymentMethodOffSession.
async function recordCardHoldNoShowFeePayment(paymentIntent) {
  const piId = paymentIntent.id;
  const amount = (paymentIntent.amount_received || paymentIntent.amount || 0) / 100;
  const customerId = paymentIntent.metadata?.waves_customer_id || null;
  if (!customerId) {
    logger.warn(`[stripe-webhook] card-hold no-show fee PI ${piId} missing waves_customer_id — recording orphan`);
    await recordOrphanSucceededPaymentIntent(paymentIntent, amount, 'card_hold_no_show_fee_no_customer');
    return;
  }
  // Settle as a paid fee invoice (refundable + customer receipt + office
  // notify), idempotent on the PI. Throw on failure so Stripe retries — a
  // charged fee must not silently miss the ledger.
  try {
    const CardHolds = require('../services/estimate-card-holds');
    await CardHolds.settleNoShowFee(paymentIntent);
  } catch (err) {
    logger.error(`[stripe-webhook] failed to settle card-hold no-show fee ${piId}: ${err.message}`);
    throw err;
  }
}

// Sibling of recordCardHoldNoShowFeePayment for fees charged by the
// appointment-card-request rail (visits secured via /secure with no
// estimate card hold). Same contract: settle as a paid refundable fee
// invoice, orphan-record when the customer pointer is missing, throw so
// Stripe retries on settlement failure.
async function recordAppointmentCardNoShowFeePayment(paymentIntent) {
  const piId = paymentIntent.id;
  const amount = (paymentIntent.amount_received || paymentIntent.amount || 0) / 100;
  const customerId = paymentIntent.metadata?.waves_customer_id || null;
  if (!customerId) {
    logger.warn(`[stripe-webhook] appointment-card no-show fee PI ${piId} missing waves_customer_id — recording orphan`);
    await recordOrphanSucceededPaymentIntent(paymentIntent, amount, 'appointment_card_no_show_fee_no_customer');
    return;
  }
  try {
    const ApptCardRequests = require('../services/appointment-card-request');
    await ApptCardRequests.settleAppointmentNoShowFee(paymentIntent);
  } catch (err) {
    logger.error(`[stripe-webhook] failed to settle appointment-card no-show fee ${piId}: ${err.message}`);
    throw err;
  }
}

// Resolve the customer whose own money just settled and clear their billing
// pause if one is waiting on exactly that (billing-pause.js owns the rules).
// Skips the non-arrears purposes: a statement is the PAYER's money, an
// estimate deposit and a no-show fee (either rail's) are not balance
// payments. A matched invoice is the customer authority (merges repoint
// invoices while stale PI metadata keeps the merged-away id) — and a
// PAYER-billed invoice yields no candidate at all, without metadata
// fallthrough: the payer's tender proves nothing about the homeowner's dead
// card, which is why they are paused.
async function maybeAutoClearBillingPauseForIntent(paymentIntent, eventCreated) {
  if (paymentIntent?.metadata?.waves_statement_id) return;
  if (paymentIntent?.metadata?.purpose === 'estimate_deposit') return;
  if (paymentIntent?.metadata?.purpose === 'card_hold_no_show_fee') return;
  // Merge-semantic exclusion (PR #3153 × #3157): the appointment-card
  // rail's no-show fee is the same kind of non-arrears money as the
  // card-hold rail's — a punitive fee settling must never re-enable
  // billing for a customer paused on a dead card.
  if (paymentIntent?.metadata?.purpose === 'appointment_card_no_show_fee') return;
  const invoice = await findInvoiceForPaymentIntent(paymentIntent);
  // Require a QUALIFYING LEDGER ROW before clearing — "Stripe says the PI
  // succeeded" is not the same as "we accepted it as settled customer
  // money". Quarantined tender mismatches and orphaned late duplicates
  // never write a customer payments row (they land in their own review
  // tables), and a disputed payment's row has left status='paid' — none of
  // them should re-enable billing. The exclusions mirror billing-cron's
  // pause veto exactly, so both sides of the race read one source of
  // truth. If a quarantine later resolves into a real settlement, THAT
  // write's own processing re-runs this dispatch and clears then.
  const ledgerRow = await db('payments')
    .where({ stripe_payment_intent_id: paymentIntent.id, status: 'paid' })
    .whereNull('statement_id')
    .whereRaw("(payments.metadata->>'purpose') IS DISTINCT FROM 'card_hold_no_show_fee'")
    .whereRaw("(payments.metadata->>'purpose') IS DISTINCT FROM 'appointment_card_no_show_fee'")
    .whereRaw("(payments.metadata->>'payer_id') IS NULL")
    .first('id', 'customer_id');
  if (!ledgerRow) return;
  // OWNERSHIP, in authority order: the matched invoice (payer-billed yields
  // NOTHING — the payer's tender proves nothing about the homeowner's dead
  // card, and no fallthrough: the invoice answers the question); else the
  // LEDGER row's customer_id — customer merges repoint payments rows while
  // PI metadata stays frozen on the merged-away id; immutable metadata only
  // as the last resort.
  const pausedCustomerId = invoice
    ? (invoice.payer_id ? null : invoice.customer_id)
    : (ledgerRow.customer_id || paymentIntent?.metadata?.waves_customer_id || null);
  if (!pausedCustomerId) return;
  const { maybeResumeBillingPauseOnPayment } = require('../services/billing-pause');
  const result = await maybeResumeBillingPauseOnPayment(pausedCustomerId, {
    paymentIntentId: paymentIntent.id,
    source: 'stripe_webhook',
    settledAt: eventCreated ? new Date(eventCreated * 1000) : null,
  });
  // Business no-ops (not paused, manual pause, ordering refusal) end here.
  // An INFRASTRUCTURE failure must not be swallowed: the handler's durable
  // writes are already committed and idempotent, so throwing lets the event
  // 500 and Stripe redeliver — the retry re-runs the clear instead of the
  // pause silently surviving a transient DB error forever.
  if (result?.reason === 'error') {
    throw new Error(`billing-pause auto-clear failed for customer ${pausedCustomerId} (PI ${paymentIntent.id}): ${result.error?.message || 'unknown'}`);
  }
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

async function resolveOrphanSucceededPaymentIntentIfSettled(paymentIntentId) {
  if (!paymentIntentId) return false;
  const invoice = await db('invoices')
    .where({ stripe_payment_intent_id: paymentIntentId, status: 'paid' })
    .first('id');
  if (!invoice) return false;
  const payment = await db('payments')
    .where({ stripe_payment_intent_id: paymentIntentId, status: 'paid' })
    .first('id');
  if (!payment) return false;
  const resolved = await db('stripe_orphan_charges')
    .where({ stripe_payment_intent_id: paymentIntentId, resolved: false })
    .update({
      resolved: true,
      resolved_at: new Date(),
      resolution_notes: 'Automatically reconciled after the retried succeeded webhook settled this exact PaymentIntent',
    });
  return resolved > 0;
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

async function shouldQuarantineUnfinalizedCardPayment(paymentIntent, details, invoice) {
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
    if (details.cardFunding === 'credit' && !details.isWallet) {
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
    if (funding === 'credit' && !isWallet) {
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
          await handlePaymentIntentSucceeded(event.data.object, event.created);
          // Auto-clear a billing pause on the customer's OWN settled money
          // (owner ruling 2026-08-01: billing goes back to normal once they
          // pay). AFTER the handler so every durable ledger write of
          // whichever branch it took (invoice paid, orphan, quarantine) has
          // landed first — clearing before the paid row exists loses the
          // race where billing-cron pauses in between and this event never
          // fires again. The helper never throws, only clears
          // 'autopay_final_failure' pauses, compare-and-swaps so a newer
          // pause is never wiped, and requires the settlement moment.
          await maybeAutoClearBillingPauseForIntent(event.data.object, event.created);
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

        case 'refund.failed':
          await handleRefundFailed(event.data.object);
          break;

        case 'refund.updated':
        case 'charge.refund.updated': {
          // Both names fire on refund status/metadata changes (refund.updated
          // is the modern event, charge.refund.updated the legacy alias); the
          // money-relevant transition is a post-creation bounce. Everything
          // else is noise — charge.refunded already recorded the creation.
          const refundObj = event.data.object;
          if (['failed', 'canceled'].includes(refundObj?.status)) {
            await handleRefundFailed(refundObj);
          } else {
            logger.info(`[stripe-webhook] refund ${refundObj?.id || '(unknown)'} updated → ${refundObj?.status} (no action)`);
          }
          break;
        }

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

      // Winston is console-only (Railway's rotating logs) and the ledger's
      // error column is purged at 90 days — Sentry is the only durable,
      // operator-visible record of a handler failure. No part of the
      // original message or stack goes to Sentry: Knex prefixes the failing
      // SQL onto err.message and provider errors echo request payloads, and
      // no scrub regex can recognize every PII form (an unquoted customer
      // name or street address passes any allowlist of patterns — AGENTS.md
      // PII rule). Capture FIXED generic text plus safe identifiers only
      // (event id/type and error name/code are not PII; the payload is
      // never attached); an explicit fingerprint keeps grouping stable
      // without a stack. err.name/err.code are only forwarded when they
      // pass the strict single-token allowlist (safeErrorToken) — length
      // alone is not PII-safety, arbitrary prose in either field is
      // DROPPED. The full message/stack stay in the ledger error column
      // (90d) and the Railway console log above. Signature failures above
      // are deliberately NOT captured (public endpoint — attack-surface
      // noise, not app failure).
      const safeName = safeErrorToken(err.name) || 'Error';
      const syntheticErr = new Error(`stripe-webhook handler failure (${event.type})`);
      syntheticErr.name = safeName;
      // A synthetic stack would point at THIS catch block for every
      // failure — misleading noise, so send none.
      syntheticErr.stack = `${safeName}: ${syntheticErr.message}`;
      Sentry.captureException(syntheticErr, {
        tags: { area: 'stripe-webhook' },
        extra: { eventType: event.type, eventId: event.id, errorName: safeName, errorCode: safeErrorToken(err.code) ?? undefined },
        fingerprint: ['stripe-webhook-handler', event.type, safeName],
      });

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
async function handleStatementPaymentIntentEvent(paymentIntent, eventType, eventCreated = null) {
  const statementId = Number(paymentIntent.metadata?.waves_statement_id);
  if (!Number.isInteger(statementId) || statementId <= 0) return;
  const piId = paymentIntent.id;
  const Settle = require('../services/payer-statement-settle');

  if (eventType === 'succeeded') {
    const { computeChargeAmount } = require('../services/stripe-pricing');
    // Funding + method from the ACTUAL confirmed payment — never trust PI
    // metadata (a failed /finalize can leave a stale surcharge_policy_version on
    // a reused PI; the same client secret could then be confirmed with a
    // different tender).
    const details = await paymentDetailsFromIntent(paymentIntent);
    // If the actual method/funding couldn't be resolved (transient Stripe lookup
    // failure), the `paymentMethod` default is `card` — settling now would either
    // strand a legit ACH (fail-closed on null funding) or mis-validate. THROW so
    // Stripe retries the webhook; the lookup almost always succeeds on retry.
    if (!details.resolved) {
      throw new Error(`statement S-${statementId} PI ${piId}: payment method/funding unresolved (transient lookup) — retrying`);
    }
    const methodType = details.paymentMethod || 'card';
    const funding = details.cardFunding || null;
    const paymentMethod = methodType === 'us_bank_account' ? 'ach' : 'card';
    const actualTotalCents = paymentIntent.amount_received || paymentIntent.amount || 0;

    // Returns true ONLY when this PI left the statement `paid` (a fresh settle or
    // an idempotent already-paid) — every anomaly path returns false so the
    // post-txn dunning-stop never fires on a still-unpaid statement.
    const settledNow = await db.transaction(async (trx) => {
      // Same per-statement money lock as disputes/refunds — serialize settlement
      // against any concurrent/out-of-order clawback on this statement.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['payer.statement.money', String(statementId)]);
      const stmt = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
      if (!stmt) { logger.warn(`[stripe-webhook] statement ${statementId} not found for PI ${piId}`); return false; }

      // Active-PI binding FIRST — before the idempotent-paid shortcut. Settle (or
      // no-op) only when the statement's stored PI is exactly this PI (NON-NULL
      // match). A null/different stored PI means this success is stale/orphan/
      // replaced; even if the statement is already `paid` by another PI/offline,
      // this PI collected money that needs a durable manual-refund record, not a
      // silent skip.
      if (String(stmt.stripe_payment_intent_id || '') !== String(piId)) {
        await recordStatementPaymentIssue(paymentIntent, statementId, `orphan/stale success: PI ${piId}, active ${stmt.stripe_payment_intent_id || 'none'} (status ${stmt.status}) — manual refund/review`);
        logger.warn(`[stripe-webhook] statement S-${statementId} non-active-PI success ${piId} (active ${stmt.stripe_payment_intent_id || 'none'})`);
        return false;
      }
      if (stmt.status === 'paid') return true; // idempotent — THIS PI already settled (dunning may stop)

      // Fail closed on UNVERIFIED card funding: surcharge must derive from the
      // ACTUAL confirmed funding, but paymentDetailsFromIntent swallows Stripe
      // charge/PM lookup failures and leaves funding null. For a card-family PI
      // (created at base) a credit card confirmed without /finalize would then
      // recompute against funding:null (no surcharge) and settle undercharged.
      // Record for manual review instead of settling the wrong amount.
      if (methodType !== 'us_bank_account' && !funding) {
        await recordStatementPaymentIssue(paymentIntent, statementId, `unverified card funding (lookup failed) for PI ${piId} — surcharge can't be validated, manual review`);
        logger.warn(`[stripe-webhook] statement S-${statementId} PI ${piId} unverified card funding — not settling`);
        return false;
      }

      // Surcharge correctness: recompute the expected total for the ACTUAL
      // confirmed funding and require the charged amount to match (binds surcharge
      // to the real tender, not stale finalization metadata). A credit card
      // confirmed at base, a stale-credit-surcharge on a debit, a wallet bypass —
      // all mismatch here → quarantine, never settle the wrong amount.
      const base = parseFloat(stmt.total);
      const { baseCents, surchargeCents, totalCents: expectedTotalCents, rateBps, policyVersion } =
        computeChargeAmount(base, methodType, { funding });
      if (Math.abs(actualTotalCents - expectedTotalCents) > 1) {
        await recordStatementPaymentIssue(paymentIntent, statementId, `surcharge mismatch: charged ${actualTotalCents}c, expected ${expectedTotalCents}c for ${methodType}/${funding || 'n/a'} — manual review`);
        logger.warn(`[stripe-webhook] statement S-${statementId} PI ${piId} surcharge mismatch (charged ${actualTotalCents}c, expected ${expectedTotalCents}c) — not settling`);
        return false;
      }

      await Settle.settleStatementPaid(statementId, {
        paymentMethod,
        processor: 'stripe',
        stripePaymentIntentId: piId,
        stripeChargeId: paymentIntent.latest_charge || null,
        amountCents: actualTotalCents,
        baseAmountCents: baseCents,
        surchargeAmountCents: surchargeCents,
        surchargeRateBps: rateBps,
        surchargePolicyVersion: policyVersion,
        cardFunding: funding,
        // Stripe's event timestamp — the settlement moment. The payment row's
        // payment_date buckets P&L revenue; stamping webhook delivery time
        // let a delayed/retried event move statement cash across a period
        // boundary.
        settledAt: eventCreated ? new Date(eventCreated * 1000) : null,
        source: 'stripe_webhook',
      }, { database: trx }); // trx is the THIRD arg — same txn re-locks the row (no self-deadlock)
      return true;
    });
    // Only when this PI actually left the statement paid — never on an anomaly
    // path (orphan/stale PI, unverified funding, surcharge quarantine), which all
    // leave the statement sent/viewed + unpaid (dunning must keep collecting).
    if (settledNow) {
      logger.info(`[stripe-webhook] statement S-${statementId} settled paid via PI ${piId}`);
      // Stop any statement-level dunning now that it's paid (best-effort, outside
      // the money txn — the eligibility filter already excludes `paid`, so this is
      // just hygiene and never gates settlement).
      await require('../services/payer-statement-followups').stopOnStatementSettled(statementId)
        .catch((e) => logger.warn(`[payer-statement-followups] stopOnStatementSettled failed: ${e.message}`));
    }
  } else if (eventType === 'processing') {
    // Re-read the CURRENT PI status before marking processing — a stale/retried
    // processing event can arrive AFTER payment_failed/canceled, and re-marking
    // processing would strand the statement (blocks online pay + admin reconcile).
    // Only honor it if Stripe still shows the PI processing (when unreachable,
    // trust the event; a later failed/canceled re-delivery would revert it).
    const stripeClient = getStripe();
    let current = null;
    if (stripeClient) {
      try { current = await stripeClient.paymentIntents.retrieve(piId); }
      catch (e) { logger.warn(`[stripe-webhook] could not re-read statement PI ${piId} on processing: ${e.message}`); }
    }
    if (current && current.status !== 'processing') {
      logger.warn(`[stripe-webhook] stale processing event for statement S-${statementId} PI ${piId} (now ${current.status}) — skipping`);
    } else {
      const moved = await Settle.markStatementProcessing(statementId, piId);
      if (moved) logger.info(`[stripe-webhook] statement S-${statementId} → processing (ACH in flight) via PI ${piId}`);
    }
  } else if (eventType === 'failed' || eventType === 'canceled') {
    const reverted = await db.transaction((trx) => Settle.revertStatementProcessing(statementId, piId, { database: trx }));
    // A `failed` that actually REVERTED a `processing` statement = a confirmed
    // payment bounced (ACH return days later, or a post-confirm card decline) —
    // the silent revert leaves AP/operators no signal, so raise a durable admin
    // notification. (A `failed` on an unconfirmed PI — a normal pay-page decline,
    // not processing — reverts nothing and stays quiet; `canceled` is usually our
    // own replaceable-PI cancel.)
    if (eventType === 'failed' && reverted) {
      const reasonMsg = paymentIntent.last_payment_error?.message || 'bank/card declined';
      try {
        await NotificationService.notifyAdmin(
          'payment',
          `Statement payment failed: S-${statementId}`,
          `PI ${piId} failed after confirmation — ${reasonMsg}. Statement reopened for collection.`,
          { icon: '⚠️', link: '/admin/payers' },
        );
      } catch (e) { logger.error(`[stripe-webhook] statement S-${statementId} failure notification insert failed: ${e.message}`); }
      logger.warn(`[stripe-webhook] statement S-${statementId} payment FAILED after confirmation via PI ${piId} (${reasonMsg}) — reverted to payable`);
    }
  }
}

// `eventCreated` is the Stripe event's unix-seconds timestamp — when Stripe
// emitted payment_intent.succeeded, i.e. the settlement moment. Threaded
// through so the ACH settlement-date restamp below can't drift onto the
// webhook DELIVERY day when a retry crosses a month/year boundary (mirrors
// handlePaymentIntentProcessing's initiatedAt).
/**
 * Combined full-balance PI (payIncludeBalance) — settle every allocated
 * invoice through the shared idempotent settle. Guards mirror the
 * single-invoice path where they still apply at the combined shape:
 * surcharge-bypass quarantine, per-invoice saved-card fences, tender match
 * against the ALLOCATION total (the PI's own pricing snapshot), and an
 * allocation-vs-captured cents check inside the settle itself. Any refusal
 * records the orphan so captured money is never silently unaccounted.
 */
async function handleCombinedPaymentIntentSucceeded(paymentIntent, eventCreated = null) {
  const PayCombined = require('../services/pay-combined');
  const piId = paymentIntent.id;
  const chargedCents = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
  const chargedTotal = chargedCents > 0 ? centsToDollars(chargedCents) : centsToDollars(paymentIntent.amount);
  const details = await paymentDetailsFromIntent(paymentIntent);

  let allocation;
  try {
    allocation = PayCombined.parseCombinedAllocation(paymentIntent.metadata);
  } catch (err) {
    logger.error(`[stripe-webhook] Combined PI ${piId} has a malformed allocation: ${err.message} — quarantining`);
    await recordOrphanSucceededPaymentIntent(paymentIntent, chargedTotal, `Malformed combined allocation: ${err.message}`);
    return;
  }

  // Surcharge-bypass quarantine (same detector as the single path; the
  // invoice arg is only used for alert labeling — pass the anchor).
  const anchorId = paymentIntent.metadata?.waves_invoice_id || allocation[0].invoiceId;
  const anchorInvoice = await db('invoices').where({ id: anchorId }).first().catch(() => null);
  const surchargeQuarantine = await shouldQuarantineUnfinalizedCardPayment(paymentIntent, details, anchorInvoice);
  if (surchargeQuarantine && !isTerminalInvoicePaymentIntent(paymentIntent, details.paymentMethod)) {
    logger.error(`[stripe-webhook] Quarantining succeeded combined PI ${piId}: ${surchargeQuarantine.reason}`);
    await alertSurchargeBypass(
      paymentIntent,
      anchorInvoice,
      surchargeQuarantine.alertType,
      surchargeQuarantine.severity,
      surchargeQuarantine.title,
      surchargeQuarantine.description,
      surchargeQuarantine.metadata,
    );
    await recordOrphanSucceededPaymentIntent(paymentIntent, chargedTotal, surchargeQuarantine.reason);
    return;
  }

  // Saved-card fences, per allocated invoice: an unresolved off-session
  // claim on ANY of them means that invoice's money state is ambiguous —
  // quarantine the whole combined settle for the operator (an active claim
  // asks Stripe to retry, mirroring the single path). The one exception
  // (codex r2 P1, mirroring the single path's retryingQuarantinedIntent):
  // a fence raised by the durable quarantine THIS exact PI wrote on an
  // earlier delivery must not refuse its own retry forever — once the
  // competing attempt resolves, the retry settles and the post-settle
  // orphan resolution below clears the quarantine row.
  const {
    assertNoInvoiceChargeReconciliationPending,
    parkInvoiceForSavedCardReconciliation,
  } = require('../services/stripe');
  for (const entry of allocation) {
    try {
      await assertNoInvoiceChargeReconciliationPending(entry.invoiceId);
    } catch (fenceErr) {
      // Composite residual keys (`<pi>:<invoiceId>`) belong to THIS PI too
      // (codex r28 P1): a provisional residual parked by the processing-
      // stage settle must not make the successful event quarantine itself —
      // the allocation-aware settle below reconciles/upgrades that share.
      const fencePiId = String(fenceErr.stripePaymentIntentId || '');
      const retryingQuarantinedIntent = fenceErr.code === 'STRIPE_CHARGED_DB_FAILED'
        && (fencePiId === String(piId) || fencePiId.startsWith(`${piId}:`));
      if (retryingQuarantinedIntent) {
        logger.info(`[stripe-webhook] Retrying quarantined combined PI ${piId} on invoice ${entry.invoiceId} after saved-card claim resolved`);
        continue;
      }
      if (fenceErr.code === 'STRIPE_CHARGE_IN_PROGRESS') {
        await recordOrphanSucceededPaymentIntent(
          paymentIntent,
          chargedTotal,
          `Succeeded combined PI ${piId} raced active saved-card attempt on invoice ${entry.invoiceId}`,
        );
        throw new Error(`Saved-card charge attempt on invoice ${entry.invoiceId} is still active; retry combined succeeded webhook`);
      }
      const reason = `Succeeded combined PI ${piId} conflicts with unresolved saved-card attempt on invoice ${entry.invoiceId}`;
      logger.error(`[stripe-webhook] Quarantining ${reason}`);
      await recordOrphanSucceededPaymentIntent(paymentIntent, chargedTotal, reason);
      // Park the conflicted invoice like the single path: status-only
      // collection surfaces must stop offering payment until the operator
      // resolves the conflict — and the parked quarantine is exactly what
      // the retry exception above recognizes and settles through.
      const quarantineError = new Error(reason);
      quarantineError.code = 'STRIPE_CHARGED_DB_FAILED';
      quarantineError.stripePaymentIntentId = piId;
      quarantineError.reconciliationRequired = true;
      await parkInvoiceForSavedCardReconciliation({
        invoiceId: entry.invoiceId,
        error: quarantineError,
      });
      return;
    }
  }

  // Tender match against the allocation total — the base the PI was priced
  // from at mint/finalize.
  try {
    assertInvoicePaymentIntentTenderMatches(
      paymentIntent,
      details.paymentMethod,
      PayCombined.allocationTotalCents(allocation) / 100,
    );
  } catch (err) {
    logger.error(`[stripe-webhook] Refusing succeeded combined PI ${piId}: ${err.message}`);
    await recordOrphanSucceededPaymentIntent(paymentIntent, chargedTotal, `Rejected combined payment tender mismatch: ${err.message}`);
    return;
  }

  let combinedSettleOutcome = null;
  try {
    combinedSettleOutcome = await PayCombined.settleCombinedPaymentIntent(paymentIntent, {
      paymentMethod: details.paymentMethod,
      cardBrand: details.cardBrand,
      cardLastFour: details.cardLastFour,
      receiptUrl: details.receiptUrl,
    }, { eventCreated });
    logger.info(`[stripe-webhook] Combined PI ${piId} settled ${combinedSettleOutcome.settled}/${allocation.length} invoices (${combinedSettleOutcome.paymentStatus})`);
  } catch (err) {
    if (err.code === 'COMBINED_ALLOCATION_MISMATCH') {
      logger.error(`[stripe-webhook] ${err.message} — quarantining`);
      await recordOrphanSucceededPaymentIntent(paymentIntent, chargedTotal, err.message);
      return;
    }
    if (err.code === 'COMBINED_PI_ALREADY_REFUNDED') {
      // The refund handler already unwound every share and reopened the
      // invoices as refunded (codex r17 P1) — the delayed success has
      // nothing left to do; no orphan (the cash is fully accounted).
      logger.warn(`[stripe-webhook] ${err.message}`);
      return;
    }
    if (err.code === 'COMBINED_PI_DISPUTED') {
      // A dispute (possibly pre-settlement — codex r5 P1) already clawed
      // this money back: settling would mark invoices paid on funds that
      // are gone. Terminal for this event — record the orphan for the
      // operator instead of retrying forever. EXCEPT when the fence is a
      // FINALIZED-LOST marker (codex r32 P2, the closed-before-succeeded
      // ordering): the chargeback already returned the cash and the lost
      // closure already ran its cleanup — a fresh quarantine here would be
      // unresolvable and would fence the anchor forever.
      const fenceMarkerRows = await db('payments').where({ stripe_payment_intent_id: piId, status: 'disputed' });
      const finalizedLost = fenceMarkerRows.some((r) => {
        try {
          const m = r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : {};
          return m.dispute_final === 'lost';
        } catch { return false; }
      });
      if (finalizedLost) {
        // Release the allocation too (codex r33 P1): the invoices are
        // still stamped with a now-succeeded PI — pay setup and every
        // off-page rail would retrieve it and refuse collection forever,
        // even though the chargeback already returned the cash. Reopen
        // any 'processing' rows (mirroring the canceled-PI revert) and
        // unbind the rest, all under the settlement lock.
        await db.transaction(async (lostTrx) => {
          await lostTrx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['stripe.pi.payment', String(piId)],
          );
          const lostStamped = await lostTrx('invoices').where({ stripe_payment_intent_id: piId, status: 'processing' });
          for (const stampedRow of lostStamped) {
            await lostTrx('invoices').where({ id: stampedRow.id, status: 'processing' }).update({
              status: nextInvoiceStatusAfterFailedPayment(stampedRow),
              paid_at: null,
              stripe_payment_intent_id: null,
              stripe_charge_id: null,
              ach_processing_notified_at: null,
              updated_at: lostTrx.fn.now(),
            });
          }
          await require('../services/pay-combined').clearPaymentIntentStamps(lostTrx, piId);
        });
        logger.warn(`[stripe-webhook] Combined PI ${piId} succeeded after a FINALIZED-LOST dispute — the chargeback already returned the cash; allocation released, no quarantine recorded`);
        return;
      }
      logger.error(`[stripe-webhook] Refusing to settle disputed combined PI ${piId}: ${err.message}`);
      await recordOrphanSucceededPaymentIntent(paymentIntent, chargedTotal, err.message);
      return;
    }
    throw err; // infrastructure failure → 500 → Stripe redelivers
  }

  // A settle that came back through the quarantine-retry exception above
  // leaves its own fence row in stripe_orphan_charges — resolve it now
  // that the anchor invoice + a paid ledger row exist (single-path
  // parity).
  await resolveOrphanSucceededPaymentIntentIfSettled(piId);

  // Review outreach per settled invoice (codex r4 P2): the shared
  // enrollment is idempotent and honors the completion's requestReview
  // intent — the combined early-return must not cost customers their
  // review invitation.
  if (combinedSettleOutcome?.paymentStatus === 'paid') {
    for (const settledId of combinedSettleOutcome.invoiceIds || []) {
      await scheduleReviewAfterPaidInvoice(piId, { invoiceId: settledId });
    }
    // A settled invoice may be gating a payment-held WDO report — nudge
    // the release sweep like the single-invoice path does (codex r22 P3);
    // the 60s interval remains the fallback.
    try {
      require('../services/project-report-hold').scheduleHoldReleaseSweep({ delayMs: 3000 });
    } catch { /* interval-backed */ }
  }

  // ACH failure-state reset BEFORE the mirror (codex r3 P1, same ordering
  // contract as the single path): a combined ACH debit clearing from a
  // previously blocked account must reset ach_status first, or the
  // enrollment below refuses the bank method the debit just proved
  // collectible.
  await resetAchFailureStateForSucceededIntent(paymentIntent);

  // Same post-settlement save/consent/enroll mirror as the single path
  // (codex r2 P1): a combined ACH signup's /consent deferred enrollment
  // to THIS event — skipping it would leave the consented method
  // unenrolled forever. Throws → Stripe retries (idempotent end to end).
  await mirrorSavedMethodForSucceededIntent(paymentIntent);

  await maybeAutoClearBillingPauseForIntent(paymentIntent, eventCreated);

  // Admin bell + push (codex r5 P2): the same one-shot PI-deduped notifier
  // the single-invoice path fires — a combined card charge or cleared ACH
  // debit is real revenue and must ring the same bell. Fire-and-forget for
  // the same reason as the single path (never gate the webhook 2xx on
  // notification fan-out).
  notifyPaymentSuccess(paymentIntent).catch((err) => {
    logger.warn(`[stripe-webhook] combined payment_succeeded notify failed: ${err.message}`);
  });
}

async function handlePaymentIntentSucceeded(paymentIntent, eventCreated = null) {
  const piId = paymentIntent.id;
  logger.info(`[stripe-webhook] PaymentIntent succeeded: ${piId}`);

  // P3: a payer-statement PI settles the consolidated statement (cascade), not an
  // invoice — route it before any invoice/tender logic and return.
  if (paymentIntent.metadata?.waves_statement_id) {
    await handleStatementPaymentIntentEvent(paymentIntent, 'succeeded', eventCreated);
    return;
  }

  // Estimate-acceptance deposits are not invoice payments — route them to
  // the deposit ledger BEFORE any invoice/tender logic runs against them.
  if (paymentIntent.metadata?.purpose === 'estimate_deposit') {
    const { handleDepositIntentSucceeded } = require('../services/estimate-deposits');
    await handleDepositIntentSucceeded(paymentIntent, eventCreated);
    return;
  }

  // One-time card-hold no-show / late-cancel fees have no invoice, but they
  // ARE real revenue — record a payments-ledger row (idempotent) so customer
  // history + admin/tax revenue reports include them, then return before the
  // invoice/tender logic (and the orphan-charge fallback).
  if (paymentIntent.metadata?.purpose === 'card_hold_no_show_fee') {
    await recordCardHoldNoShowFeePayment(paymentIntent);
    return;
  }

  // Appointment-card-lane no-show / late-cancel fees — the sibling rail for
  // visits secured via /secure (appointment_card_requests). Same settlement
  // contract, own purpose string so ledger metadata names the actual lane.
  if (paymentIntent.metadata?.purpose === 'appointment_card_no_show_fee') {
    await recordAppointmentCardNoShowFeePayment(paymentIntent);
    return;
  }

  // Combined full-balance PI (payIncludeBalance): one charge settling
  // SEVERAL invoices per its metadata allocation. Route before the
  // single-invoice guards — they resolve an arbitrary stamped row via
  // findInvoiceForPaymentIntent and would tender-mismatch the combined
  // amount against one invoice's remainder, quarantining valid money.
  {
    const PayCombined = require('../services/pay-combined');
    if (PayCombined.isCombinedPiMetadata(paymentIntent.metadata)) {
      await handleCombinedPaymentIntentSucceeded(paymentIntent, eventCreated);
      return;
    }
  }

  const chargedCents = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
  const chargedTotal = chargedCents > 0 ? Math.round((chargedCents / 100) * 100) / 100 : null;
  const details = await paymentDetailsFromIntent(paymentIntent);
  const invoiceForTenderGuard = await findInvoiceForPaymentIntent(paymentIntent);
  const savedCardAttemptForTenderGuard = invoiceForTenderGuard
    ? await findMatchingSavedCardAttempt(db, invoiceForTenderGuard, paymentIntent, {
      allowResolvedSucceeded: true,
    })
    : null;
  const invoiceForTenderGuardStatus = String(invoiceForTenderGuard?.status || '').toLowerCase();
  if (lateSavedCardPaymentNeedsOrphan({
    invoiceStatus: invoiceForTenderGuardStatus,
    activePaymentIntentId: invoiceForTenderGuard?.stripe_payment_intent_id,
    incomingPaymentIntentId: piId,
    terminalStatuses: INVOICE_TERMINAL_PAYMENT_STATUSES,
    hasMatchingSavedCardAttempt: !!savedCardAttemptForTenderGuard,
  })) {
    const reason = `Late saved-card PI ${piId} succeeded after invoice ${invoiceForTenderGuard.id} was already ${invoiceForTenderGuardStatus}`;
    logger.error(`[stripe-webhook] Quarantining ${reason}`);
    await recordOrphanSucceededPaymentIntent(
      paymentIntent,
      chargedTotal ?? centsToDollars(paymentIntent.amount),
      reason,
    );
    return;
  }
  if (invoiceForTenderGuard && !savedCardAttemptForTenderGuard) {
    const {
      assertNoInvoiceChargeReconciliationPending,
      parkInvoiceForSavedCardReconciliation,
    } = require('../services/stripe');
    let savedCardFence = null;
    try {
      await assertNoInvoiceChargeReconciliationPending(invoiceForTenderGuard.id);
    } catch (fenceErr) {
      savedCardFence = fenceErr;
    }
    const retryingQuarantinedIntent = savedCardFence?.code === 'STRIPE_CHARGED_DB_FAILED'
      && String(savedCardFence.stripePaymentIntentId || '') === String(piId);
    if (retryingQuarantinedIntent) {
      // This is the durable quarantine written when this exact public PI first
      // raced the saved-card owner. Once the owner has resolved, let the retry
      // settle the same PI; the quarantine is cleared only after both its paid
      // invoice and payment rows exist below.
      logger.info(`[stripe-webhook] Retrying quarantined public PI ${piId} after saved-card claim resolved`);
    } else if (savedCardFence) {
      if (savedCardFence.code === 'STRIPE_CHARGE_IN_PROGRESS') {
        // The owning request may still prove a deterministic failure and
        // release its claim. Persist this already-succeeded competing PI before
        // asking Stripe to retry: if the saved-card owner wins meanwhile, the
        // retry sees a paid invoice and must not make this second charge vanish.
        await recordOrphanSucceededPaymentIntent(
          paymentIntent,
          chargedTotal ?? centsToDollars(paymentIntent.amount),
          `Succeeded public PI ${piId} raced active saved-card attempt ${savedCardFence.chargeAttemptId || 'unknown'}`,
        );
        throw new Error(`Saved-card charge attempt ${savedCardFence.chargeAttemptId || 'unknown'} is still active; retry succeeded webhook`);
      }
      const reason = `Succeeded PI ${piId} conflicts with unresolved saved-card attempt ${savedCardFence.chargeAttemptId || 'unknown'}`;
      logger.error(`[stripe-webhook] Quarantining ${reason}`);
      await recordOrphanSucceededPaymentIntent(
        paymentIntent,
        chargedTotal ?? centsToDollars(paymentIntent.amount),
        reason,
      );
      const quarantineError = new Error(reason);
      quarantineError.code = 'STRIPE_CHARGED_DB_FAILED';
      quarantineError.stripePaymentIntentId = piId;
      quarantineError.reconciliationRequired = true;
      await parkInvoiceForSavedCardReconciliation({
        invoiceId: invoiceForTenderGuard.id,
        error: quarantineError,
      });
      return;
    }
  }
  if (savedCardAttemptForTenderGuard?.status === 'claimed') {
    const {
      savedCardClaimIsStale,
      promoteStaleSavedCardClaim,
      resolveSettledInvoiceSavedCardChargeAttempt,
    } = require('../services/stripe');
    // The owner commits invoice + payment before closing its durable claim.
    // If it crashed in that narrow gap, repair the claim immediately instead
    // of treating a fully-settled charge as active until the stale window.
    const alreadySettled = await resolveSettledInvoiceSavedCardChargeAttempt({
      attemptId: savedCardAttemptForTenderGuard.id,
      invoiceId: invoiceForTenderGuard.id,
      customerId: invoiceForTenderGuard.customer_id,
      stripePaymentIntentId: piId,
      amount: chargedTotal,
    });
    if (alreadySettled) {
      savedCardAttemptForTenderGuard.status = 'succeeded';
      logger.info(`[stripe-webhook] Repaired committed saved-card attempt ${savedCardAttemptForTenderGuard.id} for PI ${piId}`);
    } else if (!savedCardClaimIsStale(savedCardAttemptForTenderGuard)) {
      // The saved-card owner has not committed success/failure/ambiguity yet.
      // Ask Stripe to retry instead of settling against transaction state that
      // may still roll back (especially account-credit application).
      throw new Error(`Saved-card charge attempt ${savedCardAttemptForTenderGuard.id} is still active; retry succeeded webhook`);
    } else {
      const promoted = await promoteStaleSavedCardClaim(savedCardAttemptForTenderGuard, db);
      if (!promoted) {
        // Another request changed the fence after our read. Retry from a fresh
        // snapshot instead of guessing whether it resolved or changed owners.
        throw new Error(`Saved-card charge attempt ${savedCardAttemptForTenderGuard.id} changed during webhook recovery; retry`);
      }
      savedCardAttemptForTenderGuard.status = 'ambiguous';
    }
  }
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
    // Tender match prices from amount due (total − applied account credit).
    const metadataBaseAmount = Number(paymentIntent.metadata?.base_amount);
    const invoiceBaseAmount = savedCardAttemptForTenderGuard?.status === 'ambiguous'
      && Number.isFinite(metadataBaseAmount)
      ? metadataBaseAmount
      : invoiceAmountDue(invoiceForTenderGuard);
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
    // knex gives updated_at a default but never auto-touches it, and the
    // billing-cron pause-veto guard reads it to see an in-place ACH
    // settlement — without this stamp that guard is blind to the flip.
    updated_at: new Date(),
    stripe_charge_id: paymentIntent.latest_charge || null,
    // An async-settling row (ACH) was inserted with a "(bank payment
    // pending)" description and metadata.payment_state='processing'; the
    // status flip alone left both stale, so the ledger read "pending"
    // forever on settled bank payments. REPLACE is a no-op for rows without
    // the marker. Constant strings only — no request-derived input.
    description: db.raw("REPLACE(description, ' (bank payment pending)', '')"),
    // payment_state flip + the Stripe settlement moment in one expression —
    // the billing-cron pause veto reads settled_event_at, so a delayed
    // redelivery (updated_at = now, settlement = days ago) cannot pose as
    // fresh money. Parameterized: the timestamp is bound, never interpolated.
    metadata: invoiceForTenderGuard?.payer_id
      // Payer-funded ACH rows already 'processing' at deploy time predate
      // the payer_id stamp on the processing insert — backfill it at the
      // flip so the pause veto and the auto-clear can exclude them.
      ? db.raw(
        `jsonb_set(jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{payment_state}', '"paid"'), '{settled_event_at}', to_jsonb(?::text)), '{payer_id}', to_jsonb(?::text))`,
        [eventCreated ? new Date(eventCreated * 1000).toISOString() : new Date().toISOString(), String(invoiceForTenderGuard.payer_id)],
      )
      : db.raw(
        `jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{payment_state}', '"paid"'), '{settled_event_at}', to_jsonb(?::text))`,
        [eventCreated ? new Date(eventCreated * 1000).toISOString() : new Date().toISOString()],
      ),
    // Cash basis: the row was stamped with the INITIATION day when
    // payment_intent.processing arrived; restamp to the SETTLEMENT day so
    // revenue lands in the period the money actually cleared (an ACH
    // initiated before a month/year end and settled after was reported in
    // the wrong period). The settlement moment is the EVENT's timestamp,
    // not this handler's run time — a delayed/retried webhook must not
    // shift the date. Safe: this update is scoped to status='processing'
    // rows below, so card payments (settled same-day) are never touched,
    // and a replay matches 0 rows.
    payment_date: etDateString(eventCreated ? new Date(eventCreated * 1000) : undefined),
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
      const matchingAmbiguousAttempt = await findMatchingSavedCardAttempt(
        trx,
        lockedInvoice,
        paymentIntent,
        { lock: true },
      );
      if (invoicePaymentIntentBlocksFallback({
        invoiceStatus: lockedInvoice.status,
        activePaymentIntentId: activePi,
        incomingPaymentIntentId: piId,
        terminalStatuses: INVOICE_TERMINAL_PAYMENT_STATUSES,
        hasMatchingSavedCardAttempt: !!matchingAmbiguousAttempt,
      })) {
        logger.warn(
          `[stripe-webhook] Skipping paid fallback row for PI ${piId}; ` +
          `invoice ${invoice.id} status=${lockedInvoice.status || 'unknown'} active_pi=${activePi || 'none'}`,
        );
        return;
      }

      if (matchingAmbiguousAttempt) {
        const creditAdjustment = savedCardCreditAdjustment({
          attempt: matchingAmbiguousAttempt,
          invoice: lockedInvoice,
        });
        if (creditAdjustment) {
          // An ambiguity can be promoted from a stale `claimed` fence even if
          // the request process crashed before re-persisting its rolled-back
          // credit draw-down. Reapply the exact pre-Stripe target inside this
          // settlement transaction so cash + credit still equal the invoice.
          const { postCreditMovement } = require('../services/customer-credit');
          await postCreditMovement({
            customerId: lockedInvoice.customer_id,
            delta: -creditAdjustment.delta,
            source: 'adjustment',
            invoiceId: lockedInvoice.id,
            note: `Account credit consumed by reconciled saved-card attempt ${matchingAmbiguousAttempt.id}`,
            createdBy: 'system:saved_card_reconciliation',
          }, trx);
          await trx('invoices').where({ id: lockedInvoice.id }).update({
            credit_applied: creditAdjustment.target,
            updated_at: trx.fn.now(),
          });
          lockedInvoice.credit_applied = creditAdjustment.target;
        }
      }

      const fallbackInvoiceUpdates = {
        status: 'paid',
        paid_at: new Date().toISOString(),
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: paymentIntent.latest_charge || null,
      };
      // chargedTotal is CASH taken (amount due + surcharge); add back applied
      // account credit so the invoice keeps its real total instead of collapsing
      // to the reduced cash amount while credit_applied remains.
      if (chargedTotal !== null) {
        fallbackInvoiceUpdates.total = Math.round((chargedTotal + (Number(lockedInvoice.credit_applied) || 0)) * 100) / 100;
      }
      if (details.paymentMethod) fallbackInvoiceUpdates.payment_method = details.paymentMethod;
      if (details.cardBrand) fallbackInvoiceUpdates.card_brand = details.cardBrand;
      if (details.cardLastFour) fallbackInvoiceUpdates.card_last_four = details.cardLastFour;
      if (details.receiptUrl) fallbackInvoiceUpdates.receipt_url = details.receiptUrl;

      const invoiceLinkQuery = trx('invoices')
        .where({ id: lockedInvoice.id })
        .whereNotIn('status', INVOICE_TERMINAL_PAYMENT_STATUSES);
      if (!matchingAmbiguousAttempt) {
        invoiceLinkQuery.where(function activePaidIntentGuard() {
          this.whereNull('stripe_payment_intent_id')
            .orWhere({ stripe_payment_intent_id: piId });
        });
      }
      const invoiceLinked = await invoiceLinkQuery.update(fallbackInvoiceUpdates);
      if (!invoiceLinked) {
        throw new Error(`Invoice ${invoice.id} no longer matches PI ${piId}`);
      }
      fallbackLinkedInvoiceId = lockedInvoice.id;

      const metadataBaseAmount = Number(paymentIntent.metadata?.base_amount ?? invoiceAmountDue(invoice));
      const metadataCardSurcharge = Number(paymentIntent.metadata?.card_surcharge ?? 0);
      await trx('payments').insert({
        // OWNERSHIP COMES FROM THE LOCKED ROW, never the pre-lock read.
        // `invoice` was fetched BEFORE this transaction took FOR UPDATE on
        // it, so any writer that repoints invoices.customer_id — a customer
        // merge is the live one — can commit while we wait on that lock and
        // move the invoice to a different customer. Inserting
        // `invoice.customer_id` then attaches this payment to the PREVIOUS
        // owner: the invoice sits on one account and the money that settled
        // it on another, which reconciliation reads as both a missing
        // payment and an unexplained one. `lockedInvoice` is the post-wait
        // re-read, so it always names the invoice's CURRENT owner. No extra
        // lock is needed — settlement must never be blocked into failure by
        // one, and this ordering does not add any.
        customer_id: lockedInvoice.customer_id,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: paymentIntent.latest_charge || null,
        payment_date: etDateString(),
        amount: chargedTotal ?? centsToDollars(paymentIntent.amount),
        base_amount_cents: Math.round(Number(paymentIntent.metadata?.base_amount || invoiceAmountDue(invoice)) * 100),
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
          // Stripe's settlement moment, NOT this handler's run time — the
          // billing-cron pause veto compares this, so a delayed redelivery
          // of an old success (row created now) cannot pose as fresh money.
          settled_event_at: eventCreated ? new Date(eventCreated * 1000).toISOString() : null,
          // Payer ownership rides the ledger row: the pause veto and the
          // auto-clear both exclude payer-funded money by this marker — a
          // payer-billed invoice settling during a homeowner's failed retry
          // must not read as the homeowner's own tender.
          ...(lockedInvoice.payer_id ? { payer_id: lockedInvoice.payer_id } : {}),
        }),
      });
      if (matchingAmbiguousAttempt) {
        const attemptResolved = await trx('stripe_invoice_charge_attempts')
          .where({ id: matchingAmbiguousAttempt.id })
          .whereIn('status', ['claimed', 'ambiguous'])
          .whereNull('resolved_at')
          .update({
            status: 'succeeded',
            stripe_payment_intent_id: piId,
            amount: chargedTotal ?? centsToDollars(paymentIntent.amount),
            error_message: null,
            resolved_at: new Date(),
            updated_at: new Date(),
          });
        if (!attemptResolved) {
          throw new Error(`Ambiguous saved-card attempt ${matchingAmbiguousAttempt.id} no longer owns invoice ${invoice.id}`);
        }
        logger.info(`[stripe-webhook] Bound ambiguous saved-card attempt ${matchingAmbiguousAttempt.id} to succeeded PI ${piId}`);
      }
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
  // chargedTotal is CASH taken (amount due + surcharge); add back the row's own
  // applied account credit IN SQL (the matched invoice isn't in this outer scope)
  // so the invoice keeps its real total (credit + cash), not just the cash.
  if (chargedTotal !== null) {
    invoiceUpdates.total = db.raw('ROUND((? + COALESCE(credit_applied, 0))::numeric, 2)', [chargedTotal]);
  }
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

  if (['claimed', 'ambiguous', 'succeeded'].includes(savedCardAttemptForTenderGuard?.status)
    && invoiceForTenderGuard) {
    const { resolveSettledInvoiceSavedCardChargeAttempt } = require('../services/stripe');
    const attemptResolved = await resolveSettledInvoiceSavedCardChargeAttempt({
      attemptId: savedCardAttemptForTenderGuard.id,
      invoiceId: invoiceForTenderGuard.id,
      customerId: invoiceForTenderGuard.customer_id,
      stripePaymentIntentId: piId,
      amount: chargedTotal,
    });
    if (attemptResolved) {
      logger.info(`[stripe-webhook] Repaired settled saved-card attempt ${savedCardAttemptForTenderGuard.id} for PI ${piId}`);
    }
  }

  if (await resolveOrphanSucceededPaymentIntentIfSettled(piId)) {
    logger.info(`[stripe-webhook] Cleared reconciled orphan fence for settled PI ${piId}`);
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

  // ACH-success failure-state reset — extracted to
  // resetAchFailureStateForSucceededIntent so the combined succeeded
  // handler runs it too (codex #3427 r3 P1): the reset must precede the
  // save-card mirror or enrollConsentedMethod refuses a bank method the
  // clearing debit just proved collectible.
  await resetAchFailureStateForSucceededIntent(paymentIntent);

  // ── Save payment method on the customer if they opted in ─────
  // Extracted to mirrorSavedMethodForSucceededIntent so the combined
  // full-balance succeeded handler runs the SAME post-settlement
  // save/consent/enroll behavior (codex #3427 r2 P1) — an ACH combined
  // payment whose /consent deferred enrollment would otherwise clear
  // with the consented method unenrolled forever.
  await mirrorSavedMethodForSucceededIntent(paymentIntent);

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
    // Fire-and-forget: a settled invoice may be gating a payment-held WDO
    // report — nudge the release sweep (60s interval is the fallback).
    require('../services/project-report-hold').scheduleHoldReleaseSweep({ delayMs: 3000 });
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

/**
 * ACH-success failure-state reset for a succeeded PaymentIntent —
 * shared by the single-invoice and combined succeeded handlers. Body
 * moved verbatim from handlePaymentIntentSucceeded; must run BEFORE
 * the save-card mirror (see the inline ordering comment).
 */
async function resetAchFailureStateForSucceededIntent(paymentIntent) {
  const piId = paymentIntent.id;
  // If ACH payment succeeded, resolve any pending ACH failures for this
  // customer. ORDER MATTERS: this reset must run BEFORE the save-card
  // mirror below — a required-save customer paying by bank from a
  // previously blocked account (ach_status needs_verification/suspended)
  // has just proven the account collects, and enrollConsentedMethod
  // refuses bank targets while ach_status is unhealthy. Resetting first
  // means the enrollment attempt sees the healthy state; the old
  // reset-after ordering left the debit cleared but the method
  // saved-only with no second enrollment attempt (Codex #2507 round-6).
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
}

/**
 * Save-card mirror + consent-gated autopay enrollment for a succeeded
 * PaymentIntent — shared by the single-invoice and combined succeeded
 * handlers. Body moved verbatim from handlePaymentIntentSucceeded;
 * see the inline comments for the full contract. Throws so the caller
 * 500s and Stripe retries (idempotent end to end).
 */
async function mirrorSavedMethodForSucceededIntent(paymentIntent) {
  const piId = paymentIntent.id;
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
      let currentAutopayMethod = await db('payment_methods')
        .where({
          customer_id: wavesCustomerId,
          processor: 'stripe',
          is_default: true,
          autopay_enabled: true,
        })
        .whereNotNull('stripe_payment_method_id')
        .first('id', 'method_type');
      // A default ACH method only counts as "in charge" while the customer's
      // bank state is healthy: customerOnAutopay rejects ach_status
      // needs_verification/suspended (card-only fallback), so deferring to an
      // unhealthy ACH default would save the newly consented signup tender as
      // non-default and point the customer at a method collection refuses —
      // the visit would never auto-charge (Codex round-5 P1). Same predicate
      // as customerOnAutopay: a non-empty, non-'active' ach_status blocks
      // bank methods only. Bank rows carry either alias ('ach' from manual
      // entry, 'us_bank_account' from Stripe's pm.type) — match both, like
      // chargeInvoiceWithSavedCard.
      if (['ach', 'us_bank_account'].includes(currentAutopayMethod?.method_type)) {
        const achRow = await db('customers').where({ id: wavesCustomerId }).first('ach_status');
        if (achRow?.ach_status && achRow.ach_status !== 'active') {
          currentAutopayMethod = null;
        }
      }
      // Autopay enrollment is CONSENT-gated, not billing-mode-gated (owner
      // ruling 2026-07-09: Auto Pay is enabled for every customer who saves
      // a method, regardless of per-app / prepay / monthly) — and the gate
      // is the immutable payment_method_consents ROW, never PI metadata
      // alone (Codex #2507 P1 round-2): if the browser's consent POST never
      // lands (closed tab, network failure), enabling off-session charges
      // from metadata would leave us charging with no authorization
      // snapshot on file. The race runs BOTH directions and both are
      // covered: consent row first → this webhook enrolls below; webhook
      // first → the method is saved card-on-file only and the /consent
      // endpoint completes enrollment when it records the row
      // (enrollConsentedMethod is shared + idempotent). billing_mode only
      // decides WHAT charges the method (per-visit completion, annual
      // renewal, or the monthly cron).
      let signupBillingMode = null;
      try {
        const custRow = await db('customers')
          .where({ id: wavesCustomerId })
          .first('billing_mode');
        signupBillingMode = custRow?.billing_mode || null;
      } catch (modeErr) { /* billing_mode column absent — log detail only */ }
      let saved = existing;
      if (!saved) {
        // ANY tender saves (owner ruling 2026-07-09: capture a payment
        // method at signup — card or bank): chargeInvoiceWithSavedCard
        // locks the PI to the saved method's family, and the ach_status
        // guard in customerOnAutopay handles unhealthy bank accounts.
        // Saved autopay-OFF; the consent-row check below enrolls. Default
        // claim keeps the round-5 semantics: only when no healthy
        // incumbent is in charge.
        saved = await StripeService.savePaymentMethod(wavesCustomerId, stripePmId, {
          enableAutopay: false,
          makeDefault: !currentAutopayMethod,
        });
      }
      await ConsentService.linkPaymentMethodId(stripePmId, saved.id);
      // Ownership guard: `existing` was looked up by pm id alone — never
      // enroll a method that belongs to another customer (Codex round-2
      // short-circuit note).
      if (!existing || existing.customer_id === wavesCustomerId) {
        // Opt-out anchor for enrollConsentedMethod, resolved BEFORE any
        // backfill below: a PRE-EXISTING consent row captures the customer's
        // actual save-card election (which can postdate PI mint —
        // /update-amount flips an already-minted PI to save-card). A row
        // THIS webhook is about to backfill would carry TODAY's timestamp,
        // days after the customer authorized, and would erase an opt-out
        // made in between (Codex r2 P1). Anchor on the NEWEST of
        // PI-creation and any prior consent: covers the late-flip case
        // (prior consent newer than mint), the ACH micro-deposit backfill
        // (no prior row → PI time), and a stale pre-v8 row beside a fresh
        // election (PI time newer). Lookup failure falls back to PI time —
        // toward the guard, never past it.
        let authorizedAt = paymentIntent.created ? new Date(paymentIntent.created * 1000) : null;
        try {
          const priorConsent = await db('payment_method_consents')
            .where({ customer_id: wavesCustomerId, stripe_payment_method_id: stripePmId })
            .orderBy('created_at', 'desc')
            .first('created_at');
          if (priorConsent?.created_at) {
            const consentAt = new Date(priorConsent.created_at);
            if (!authorizedAt || consentAt > authorizedAt) authorizedAt = consentAt;
          }
        } catch (lookupErr) {
          logger.warn(`[stripe-webhook] consent-time lookup failed for pm ${stripePmId}: ${lookupErr.message}`);
        }
        if (!(await ConsentService.hasConsentFor(wavesCustomerId, stripePmId))) {
          // Record the consent snapshot SERVER-SIDE — same recipe as the
          // covered_capture webhook (Codex #2507 round-7 P1): for an ACH
          // micro-deposit signup, confirmPayment returned requires_action
          // so the browser never posted /consent (that endpoint refuses
          // non-processing/succeeded PIs), and by the time this succeeded
          // event arrives days later there is no browser left to post it —
          // deferring would leave a required-save signup paid with the
          // method saved-but-unenrolled forever. The round-2 gate stands:
          // enrollment still requires the immutable consent ROW — it is
          // CREATED here from the Stripe-signed artifact (save_card_opt_in
          // + setup_future_usage written together by the controlled /setup
          // and /update-amount paths, and the customer confirmed that PI),
          // never inferred at charge time.
          await ConsentService.recordConsent({
            customerId: wavesCustomerId,
            paymentMethodId: saved.id,
            stripePaymentMethodId: stripePmId,
            source: 'pay_page',
            methodType: saved.method_type || 'card',
          });
        }
        const { enrollConsentedMethod } = require('../services/autopay-enrollment');
        // Invoice visit scope for the in-lock payer check (#3395 r14 P1):
        // the PI belongs to an invoice — a self_pay_override visit on a
        // payer-billed account must still enroll. Best-effort: a lookup
        // miss falls to the account scope (toward refusing — fail closed).
        let mirrorScopeSsId = null;
        try {
          const piInvoice = await db('invoices')
            .where({ stripe_payment_intent_id: piId })
            .first('scheduled_service_id');
          mirrorScopeSsId = piInvoice?.scheduled_service_id || null;
        } catch (scopeErr) {
          logger.warn(`[stripe-webhook] invoice scope lookup failed for PI ${piId}: ${scopeErr.message}`);
        }
        await enrollConsentedMethod({
          customerId: wavesCustomerId,
          paymentMethodId: saved.id,
          source: 'save_card_consent',
          details: { billing_mode: signupBillingMode },
          authorizedAt,
          scheduledServiceId: mirrorScopeSsId,
        });
      }
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
      // Re-throw so the dispatcher 500s and Stripe retries (Codex #2507
      // round-7 P1): for micro-deposit ACH signups THIS event is the only
      // completion path (no browser returns days later), so a swallowed
      // transient error would leave the signup paid with nothing
      // enrolled, permanently. Every step above is idempotent
      // (lookup-first save, hasConsentFor-gated consent, idempotent
      // enrollment) and the payment settle earlier in this handler is
      // status-guarded, so the retry re-runs safely.
      logger.error(`[stripe-webhook] Save-card persist failed for PI ${piId} (pm ${stripePmId}) — rethrowing for Stripe retry: ${err.message}`);
      throw err;
    }
  }
}

async function scheduleReviewAfterPaidInvoice(piId, { invoiceId = null } = {}) {
  try {
    // A combined PI settles several invoices at once — callers pass each
    // settled invoiceId explicitly; the PI-keyed .first() remains for the
    // single-invoice path.
    const paidInvoice = await db('invoices')
      .where(invoiceId ? { id: invoiceId } : { stripe_payment_intent_id: piId })
      .select('id', 'customer_id', 'service_record_id', 'invoice_number')
      .first();
    if (!paidInvoice?.customer_id || !paidInvoice?.service_record_id) return;

    // Shared guards + enrollment (also used by the admin record-payment path
    // for off-Stripe settlements): honors the completion's requestReview
    // intent + visit outcome, dedupes/idempotent under webhook retries.
    const ReviewService = require('../services/review-request');
    const outcome = await ReviewService.enrollForPaidInvoice(paidInvoice, { source: 'stripe_webhook' });
    if (outcome.enrolled) {
      logger.info(`[stripe-webhook] Queued review outreach after invoice ${paidInvoice.invoice_number || paidInvoice.id} payment`);
    }
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
 * Arm the billing-cron retry ladder for an async monthly-autopay bounce.
 *
 * ACH autopay charges record status 'processing' at initiation
 * (services/stripe.js maps every non-succeeded PI to 'processing'), so
 * processMonthlyBilling sees success and its synchronous catch — the only
 * place that arms payments.retry_count / next_retry_at — never runs. When
 * the bank return lands days later as payment_intent.payment_failed, this
 * handler is the only place that knows the month is still uncollected.
 * Arm the SAME ladder the cron's catch arms (first rung at
 * RETRY_DELAYS_DAYS[0] days) so processPaymentRetries() picks the row up
 * and applies its full suppression-guard set (already-collected, annual
 * prepay coverage, billing-mode, autopay disabled/paused, pending prepay,
 * ambiguous-outcome).
 *
 * Guards:
 * - monthly_autopay PIs only (metadata stamped by chargeMonthly). Never
 *   invoice-linked PIs: that lane reopens the invoice and dunning
 *   collects, so arming here too would double-collect the same balance.
 * - only rows still 'processing' when the bounce arrived (the async
 *   success-at-initiation lane). Synchronously-failed rows were armed by
 *   the cron's catch; touching them would reset a live ladder.
 * - 3-attempt bound: each sweep rung mints a FRESH payments row and
 *   supersedes the bounced original, so the ladder position is
 *   reconstructed from the obligation month's prior failed attempts using
 *   the sweep's own matcher shape (metadata billed_month first,
 *   payment_date window + description marker as the legacy fallback). At
 *   3+ prior attempts the ladder is exhausted — mirrors the sweep's
 *   retry_count < 3 window; by then handleAchFailure's escalation has
 *   suspended ACH and, with a card on file, repointed autopay at it.
 */
async function armMonthlyAutopayRetryForAsyncFailure(paymentIntent, processingRow) {
  const piId = paymentIntent.id;
  if (paymentIntent.metadata?.type !== 'monthly_autopay') return;
  if (!processingRow || processingRow.superseded_by_payment_id || processingRow.next_retry_at) return;

  // Explicit invoice guard (belt over the metadata check): an
  // invoice-linked PI re-collects through invoice reopen + dunning,
  // never through this ladder. The lookup FAILS CLOSED (Codex #2822 P1):
  // a transient DB error must never read as "invoice-less" — that would
  // arm this ladder for a PI whose invoice lane also re-collects,
  // double-collecting the same balance. Let it propagate: this runs
  // before the failed flip, so the webhook 500s, Stripe redelivers, and
  // the row is still 'processing' when the retry re-runs the arming.
  const linkedInvoice = await db('invoices')
    .where({ stripe_payment_intent_id: piId })
    .first();
  if (linkedInvoice) {
    logger.info(`[stripe-webhook] PI ${piId} is invoice-linked — invoice lane re-collects, not arming autopay retry`);
    return;
  }

  let rowMeta = {};
  try {
    rowMeta = processingRow.metadata
      ? (typeof processingRow.metadata === 'string' ? JSON.parse(processingRow.metadata) : processingRow.metadata)
      : {};
  } catch (e) { /* unparseable legacy metadata — fall through to payment_date */ }
  // Month-of-obligation key (same driver-shape handling as billing-cron's
  // monthKeyOf: DATE columns arrive as Date or 'YYYY-MM-DD' string).
  const pd = processingRow.payment_date;
  const pdIso = pd instanceof Date
    ? (Number.isNaN(pd.getTime()) ? '' : pd.toISOString())
    : String(pd || '');
  const obligationMonth = rowMeta.billed_month
    || (/^\d{4}-\d{2}/.test(pdIso) ? pdIso.slice(0, 7) : null);

  // Ladder position = prior failed attempts for the same obligation month.
  let priorAttempts = 0;
  if (obligationMonth) {
    const [obYear, obMonth] = obligationMonth.split('-').map(Number);
    const obStart = `${obligationMonth}-01`;
    const obLastDay = new Date(Date.UTC(obYear, obMonth, 0)).getUTCDate();
    const obEnd = `${obligationMonth}-${String(obLastDay).padStart(2, '0')}`;
    priorAttempts = Number((await db('payments')
      .where({ customer_id: processingRow.customer_id, status: 'failed' })
      .whereNot({ id: processingRow.id })
      .where(function () {
        this.whereRaw("metadata->>'billed_month' = ?", [obligationMonth])
          .orWhere(function () {
            this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
              .andWhere('payment_date', '>=', obStart)
              .andWhere('payment_date', '<=', obEnd)
              .andWhere('description', 'like', '%WaveGuard Monthly%');
          });
      })
      .count('* as cnt')
      .first())?.cnt || 0);
  }

  if (priorAttempts >= 3) {
    logger.warn(`[stripe-webhook] Monthly autopay PI ${piId} bounced with ${priorAttempts} prior failed attempts for ${obligationMonth || 'unknown month'} — ladder exhausted, not re-arming`);
    return;
  }

  // Lazy require: pulls only the cadence constant, keeping the cron
  // machinery out of this module's load path.
  const { RETRY_DELAYS_DAYS } = require('../services/billing-cron');
  const retryAt = new Date();
  retryAt.setDate(retryAt.getDate() + (RETRY_DELAYS_DAYS?.[0] ?? 2));

  // whereNull guards make this idempotent under webhook redelivery and
  // keep it from clobbering a ladder some other path armed first.
  const armed = await db('payments')
    .where({ id: processingRow.id })
    .whereNull('superseded_by_payment_id')
    .whereNull('next_retry_at')
    .update({
      retry_count: priorAttempts,
      next_retry_at: retryAt.toISOString(),
    });
  if (armed > 0) {
    const { logAutopay } = require('../services/autopay-log');
    await logAutopay(processingRow.customer_id, 'charge_failed', {
      amountCents: Math.round(parseFloat(processingRow.amount) * 100) || null,
      paymentId: processingRow.id,
      details: {
        source: 'autopay_async_bounce',
        stripe_payment_intent_id: piId,
        billed_month: obligationMonth,
        retry_count: priorAttempts,
        next_retry_at: retryAt.toISOString(),
      },
    }).catch(() => {});
    logger.info(`[stripe-webhook] Armed autopay retry for payment ${processingRow.id} (PI ${piId}) — rung ${priorAttempts}, next retry ${retryAt.toISOString()}`);
  }
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

  // Captured BEFORE the failed flip below: the async-bounce arming path
  // must distinguish a success-at-initiation row (ACH records
  // 'processing' at initiation, so the monthly cron saw success) from a
  // synchronously-failed charge whose ladder the cron's catch already
  // armed — after the flip the two are indistinguishable.
  const processingRowBeforeFailure = await db('payments')
    .where({ stripe_payment_intent_id: piId, status: 'processing' })
    .first();

  // Arm re-collection for invoice-less monthly-autopay async bounces.
  // Runs before the status flip so a throw later in this handler (which
  // 500s the webhook for redelivery) can't strand the obligation: on
  // redelivery the row is still 'processing' and this re-runs; once
  // armed, the whereNull guards make it a no-op.
  await armMonthlyAutopayRetryForAsyncFailure(paymentIntent, processingRowBeforeFailure);

  // Stale-failure guard for COMBINED PIs (codex r20 P1): the reusable PI
  // is retried after an ACH bounce, and a newer processing delivery can
  // have already moved every row/invoice back to 'processing' before an
  // OLDER failure delivery lands — the row-status terminal guard below
  // can't see that ('processing' isn't terminal). Verify against the LIVE
  // intent, exactly like the processing handler's freshness check; a
  // still-moving replacement debit makes this failure event a no-op.
  // Fail CLOSED: an unreadable PI throws so Stripe redelivers.
  if (require('../services/pay-combined').isCombinedPiMetadata(paymentIntent.metadata)) {
    const freshFailStripe = getStripe();
    // Fail CLOSED on a missing Stripe client (codex r35 P1): skipping the
    // freshness check would apply an UNVERIFIED stale failure — marking
    // rows failed and reopening invoices while a newer attempt on the
    // reusable PI may be live. Throw so Stripe retries the event.
    if (!freshFailStripe) {
      throw new Error(`Combined payment_failed for PI ${piId} cannot be freshness-checked (Stripe client unavailable); retry`);
    }
    {
      const currentFailIntent = await freshFailStripe.paymentIntents.retrieve(piId);
      if (['processing', 'succeeded', 'requires_capture'].includes(currentFailIntent.status)
        // A NEWER attempt awaiting microdeposit verification is also live
        // (codex r31 P2): the customer switched to ACH after the old
        // failure — running the stale failure would ledger-fail rows and
        // notify the customer while their bank verification stands.
        || (currentFailIntent.status === 'requires_action'
          && currentFailIntent.next_action?.type === 'verify_with_microdeposits')) {
        logger.warn(`[stripe-webhook] stale combined payment_failed for PI ${piId} — current status is ${currentFailIntent.status}${currentFailIntent.next_action?.type ? ` (${currentFailIntent.next_action.type})` : ''}; skipping ledger revert`);
        return;
      }
    }
  }

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

  // A combined full-balance PI (payIncludeBalance) is stamped on EVERY
  // allocated invoice, so the processing revert walks all rows carrying
  // this PI — a single-row revert would strand the siblings in
  // 'processing' forever after a combined ACH bounce. Single-invoice PIs
  // keep the original single-row lookup exactly.
  const failedInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first();
  const failedInvoices = failedInvoice ? [failedInvoice] : [];
  if (require('../services/pay-combined').isCombinedPiMetadata(paymentIntent.metadata)) {
    const allStamped = await db('invoices').where({ stripe_payment_intent_id: piId });
    for (const r of (Array.isArray(allStamped) ? allStamped : [])) {
      if (!failedInvoice || String(r.id) !== String(failedInvoice.id)) failedInvoices.push(r);
    }
  }
  // Kill-switch enforcement on failure (codex r26 P1): with the gate OFF,
  // a failed combined debit returns the reusable PI to an unconfirmed
  // state — a browser retaining its client secret could retry the old
  // combined allocation despite the flip. Revoke the session as part of
  // the failure handling: cancel fail-closed (a throw retries the event)
  // and clear every stamp before the invoices reopen below.
  let gateOffRevokedPi = false;
  if (require('../services/pay-combined').isCombinedPiMetadata(paymentIntent.metadata)
    && !require('../config/feature-gates').isEnabled('payIncludeBalance')) {
    const gateOffStripe = getStripe();
    // Same fail-closed posture as the freshness check (codex r35 P1):
    // a null client must not silently skip the kill-switch revoke.
    if (!gateOffStripe) {
      throw new Error(`Gate-off revoke of failed combined PI ${piId} cannot run (Stripe client unavailable); retry`);
    }
    {
      try {
        await gateOffStripe.paymentIntents.cancel(piId);
        gateOffRevokedPi = true;
      } catch (cancelErr) {
        // Re-read instead of trusting the error text (codex r31 P1): a
        // customer retry can race the PI to succeeded/processing between
        // the freshness guard and this cancel — treating that as
        // "revoked" would reopen and unstamp invoices whose cash was
        // captured, exposing them to double collection until the
        // succeeded webhook repairs them.
        const recheck = await gateOffStripe.paymentIntents.retrieve(piId);
        if (recheck.status === 'canceled') {
          gateOffRevokedPi = true;
        } else if (['succeeded', 'processing', 'requires_capture'].includes(recheck.status)) {
          logger.warn(`[stripe-webhook] gate-off revoke skipped — combined PI ${piId} raced to ${recheck.status}; its own events own the ledger`);
          return;
        } else {
          throw new Error(`Gate-off revoke of failed combined PI ${piId} could not cancel (${cancelErr.message}); retry`);
        }
      }
      if (gateOffRevokedPi) logger.warn(`[stripe-webhook] gate OFF — revoked failed combined PI ${piId}; stamps clear after the reopen below`);
    }
  }

  for (const failedRow of failedInvoices) {
    if (failedRow.status !== 'processing') continue;
    const nextStatus = nextInvoiceStatusAfterFailedPayment(failedRow);
    // Clearing ach_processing_notified_at means a re-attempted ACH on
    // the same invoice (different bank account, customer retries, etc.)
    // will trigger a fresh "we got it" acknowledgment when its
    // payment_intent.processing fires. Without this, the per-invoice
    // dedupe lock from the first attempt would permanently suppress
    // notifications for every subsequent attempt on the same invoice.
    await db('invoices')
      .where({ id: failedRow.id })
      .update({
        status: nextStatus,
        paid_at: null,
        ach_processing_notified_at: null,
      });
  }

  // Gate-off stamp cleanup AFTER the reopen (codex r27 P2): the clear
  // helper excludes 'processing' rows, so clearing before the loop was a
  // no-op — now the rows are reopened (sent/overdue) and unbind cleanly,
  // so no invoice stays bound to the revoked PI.
  if (gateOffRevokedPi) {
    await require('../services/pay-combined').clearPaymentIntentStamps(db, piId);
  }
  // Provisional residuals from the PROCESSING-stage settle resolve when
  // the combined intent terminates without settling (codex r27 P2): the
  // parked cash never arrived, so the reconciliation queue must not keep
  // reporting it (and the sibling fence must not keep blocking the
  // invoice).
  if (require('../services/pay-combined').isCombinedPiMetadata(paymentIntent.metadata)) {
    const resolvedProvisional = await db('stripe_orphan_charges')
      .where({ resolved: false, source: 'combined_pay_processing' })
      .where('stripe_payment_intent_id', 'like', `${piId}:%`)
      .update({
        resolved: true,
        resolved_at: new Date(),
        resolution_notes: 'Automatically resolved: the combined ACH debit failed before settling — the provisional residual cash never arrived',
      });
    if (resolvedProvisional > 0) logger.info(`[stripe-webhook] combined PI ${piId} failed — resolved ${resolvedProvisional} provisional residual(s)`);
  }

  // A create timeout may have left no PI on the parked invoice. Stripe's
  // definitive failure event still carries our signed metadata + immutable
  // saved PM, so use the same exact matcher as succeeded reconciliation to
  // release the attempt, reopen the invoice, and return reserved credit.
  const failedAttemptInvoice = failedInvoice || await findInvoiceForPaymentIntent(paymentIntent);
  const failedSavedCardAttempt = failedAttemptInvoice
    ? await findMatchingSavedCardAttempt(db, failedAttemptInvoice, paymentIntent)
    : null;
  if (failedSavedCardAttempt) {
    const { resolveFailedInvoiceSavedCardChargeAttempt } = require('../services/stripe');
    const attemptResolved = await resolveFailedInvoiceSavedCardChargeAttempt({
      attemptId: failedSavedCardAttempt.id,
      invoiceId: failedAttemptInvoice.id,
      customerId: failedAttemptInvoice.customer_id,
      stripePaymentIntentId: piId,
      failureMessage: `${failureMessage}${failureCode ? ` (${failureCode})` : ''}`,
    });
    if (attemptResolved) {
      logger.info(`[stripe-webhook] Released failed saved-card attempt ${failedSavedCardAttempt.id} for PI ${piId}`);
    }
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
    await handleAchFailure(paymentIntent, failureMessage, eventId);
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
    // Combined full-balance PI (codex r7 P2): resolve the ANCHOR invoice and
    // pass the allocation total, so the failure email names the combined
    // amount the customer attempted — the PI-keyed .first() below the email
    // helper would otherwise pick an arbitrary stamped share.
    let failedCombinedAlloc = null;
    try {
      failedCombinedAlloc = require('../services/pay-combined').parseCombinedAllocation(paymentIntent.metadata);
    } catch { failedCombinedAlloc = null; }
    PaymentLifecycleEmail.sendPaymentFailed({
      paymentIntentId: piId,
      attemptId,
      ...(failedCombinedAlloc ? {
        invoiceId: paymentIntent.metadata?.waves_invoice_id || failedCombinedAlloc[0].invoiceId,
        amountDueOverride: require('../services/pay-combined').allocationTotalCents(failedCombinedAlloc) / 100,
      } : {}),
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
 * Resolve the invoice a refunded charge belongs to, trying every link the
 * different payment paths leave behind, so a full refund can restore applied
 * account credit. A charge-only reconciled payment carries NO payment_intent —
 * only payments.metadata.invoice_id (and the invoice's own stripe_charge_id) —
 * so a PI-only lookup would skip the restore and strand the credit. Runs on the
 * caller's trx. Returns the invoice id or null.
 */
async function resolveRefundedInvoiceId(trx, { pmt, charge, chargeId }) {
  // 1. payments.metadata.invoice_id — set by the admin reconcile route and by
  //    credit-applied manual / card-on-file payments.
  let metaInvoiceId = null;
  if (pmt?.metadata) {
    try {
      const m = typeof pmt.metadata === 'string' ? JSON.parse(pmt.metadata) : pmt.metadata;
      metaInvoiceId = m && m.invoice_id ? m.invoice_id : null;
    } catch { /* non-JSON metadata — fall through */ }
  }
  if (metaInvoiceId) {
    const inv = await trx('invoices').where({ id: metaInvoiceId }).first('id');
    if (inv) return inv.id;
  }
  // 2. payment intent — saved-card / pay-page charges link the invoice by PI.
  const pi = pmt?.stripe_payment_intent_id || charge?.payment_intent || null;
  if (pi) {
    const inv = await trx('invoices').where({ stripe_payment_intent_id: pi }).first('id');
    if (inv) return inv.id;
  }
  // 3. charge id — the reconcile route also stamps invoices.stripe_charge_id.
  if (chargeId) {
    const inv = await trx('invoices').where({ stripe_charge_id: chargeId }).first('id');
    if (inv) return inv.id;
  }
  return null;
}

// Durable record of WHICH refunds were counted into a payments row's
// refund_amount — stripe_refund_id alone only remembers the newest stamp, so
// a bounce of an OLDER stamped partial would otherwise be unattributable
// (handleRefundFailed can only rewind refunds it can attribute).
function metadataWithStampedRefund(rawMeta, refundId) {
  let meta = {};
  try {
    meta = rawMeta ? (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta) : {};
  } catch { meta = {}; }
  if (!refundId) return meta;
  const stamped = Array.isArray(meta.stamped_refund_ids) ? meta.stamped_refund_ids : [];
  if (stamped.includes(refundId)) return meta;
  return { ...meta, stamped_refund_ids: [...stamped, refundId] };
}

/**
 * charge.refunded — Update refund status on payments table
 */
// charge.refunded does not reliably carry the refund that triggered it: on the
// pinned API version `charge.refunds` is a NON-expanded list (data absent or
// empty) and `charge.latest_refund` can be absent too, so both id sources come
// back null. Everything downstream is keyed on that id — the failed-refund
// fence, the stamped-refund record, `payments.stripe_refund_id`, and the
// refund-email idempotency key — so a null degrades all four at once. Fetch it
// from Stripe when the event doesn't supply it. Best-effort: a lookup failure
// leaves refundId null (the same state as before this call existed), never
// throws into the webhook.
// Upper bound on how much refund history we will page through for one charge.
// Far above anything real (a charge carries one or two refunds); it exists so
// a pathological charge cannot spin the webhook through unbounded pagination.
const REFUND_HISTORY_CAP = 1000;

// Walk an oldest-first refund list and return the refund whose cumulative
// total reaches exactly `snapshotCents` — i.e. the refund that brought the
// charge to the amount_refunded the event snapshot reports. Returns null when
// nothing lands on the target, which the caller treats as unattributable.
function matchRefundToSnapshot(oldestFirst, snapshotCents) {
  let running = 0;
  for (const refund of oldestFirst) {
    running += Number(refund.amount) || 0;
    if (running === snapshotCents) return refund;
  }
  return null;
}

async function resolveRefundIdForCharge(charge) {
  const fromEvent = (Array.isArray(charge.refunds?.data) ? charge.refunds.data[0]?.id : null)
    || charge.latest_refund
    || null;
  if (fromEvent) return { refundId: fromEvent, refund: charge.refunds?.data?.[0] || null };

  const stripe = getStripe();
  if (!stripe) {
    // FAIL CLOSED: without a client we cannot attribute this refund, and
    // proceeding would stamp a null id and re-send the duplicate email.
    throw new Error(`Stripe client unavailable — cannot resolve the refund id for charge ${charge.id}`);
  }

  let refunds;
  try {
    // Paginate: a single page is not the charge's full refund history, and
    // treating it as one makes the cumulative walk fail permanently once a
    // charge carries more refunds than the page size (codex P1).
    refunds = await stripe.refunds
      .list({ charge: charge.id, limit: 100 })
      .autoPagingToArray({ limit: REFUND_HISTORY_CAP });
  } catch (err) {
    // THROW, don't degrade (codex P0): the dispatcher turns this into a 500
    // "Stripe will retry" without marking the event processed. Continuing
    // with a null would stamp `stripe_refund_id = null` over an id
    // StripeService.refund() already recorded, strand the id the bounce
    // handler needs to unwind a later failure, AND still send the duplicate
    // email — all for a transient API blip that a retry fixes.
    logger.error(`[stripe-webhook] refund lookup failed for charge ${charge.id} — retrying event: ${err.message}`);
    throw err;
  }

  // Identify the refund THIS event's snapshot describes, not merely the
  // newest one (codex P0). charge.amount_refunded is cumulative at snapshot
  // time, so walking the refunds oldest-first and taking the one whose
  // running total equals the snapshot pins the exact refund — which keeps
  // two out-of-order charge.refunded events for two partial refunds mapped
  // to their own ids instead of both collapsing onto the newest.
  //
  // Ordering comes from REVERSING Stripe's documented newest-first list, not
  // from sorting on `created` (codex P0): `created` has second precision and
  // refund ids are opaque, so a comparator tie-break would reorder two
  // same-second refunds arbitrarily and attribute the event to the wrong one.
  // The list order is authoritative; filtering preserves it.
  const snapshotCents = Number(charge.amount_refunded) || 0;
  const history = Array.isArray(refunds) ? refunds : [];

  // We are comparing an OLD event snapshot against the CURRENT refund
  // history, so two readings are possible and they must agree before either
  // is trusted (codex P0):
  //
  //  - live-only, because Stripe drops failed/canceled refunds from
  //    amount_refunded — the normal reading;
  //  - all-inclusive, because a delayed id-less event can arrive after its
  //    own refund bounced, and then only the history as it stood at emission
  //    matches (codex P1). Resolving that hands the event to the existing
  //    failed-refund fences instead of retrying until Stripe gives up.
  //
  // When both readings match but name DIFFERENT refunds, the snapshot is
  // genuinely ambiguous and neither may be trusted: e.g. A=$100 and B=$50
  // give B's event a $150 snapshot; if A later fails and C=$100 is created,
  // the live walk lands on C while the true subject is B. Accepting either
  // would stamp the wrong stripe_refund_id, corrupt bounce attribution, and
  // pick the wrong email dedupe key — so fail closed and let the retry (or a
  // visible failed event) sort it out.
  const live = history.filter((r) => r && r.status !== 'failed' && r.status !== 'canceled').reverse();
  const liveMatch = matchRefundToSnapshot(live, snapshotCents);
  const allMatch = matchRefundToSnapshot([...history].reverse(), snapshotCents);

  if (liveMatch && allMatch && liveMatch.id !== allMatch.id) {
    throw new Error(
      `charge.refunded for ${charge.id}: snapshot of ${snapshotCents} cents is ambiguous — `
      + `live history points at ${liveMatch.id} but full history points at ${allMatch.id}; `
      + 'refusing to guess which refund this event describes',
    );
  }

  const match = liveMatch || allMatch;
  if (match) {
    if (!liveMatch) {
      logger.warn(`[stripe-webhook] charge.refunded for ${charge.id} only matches once failed/canceled refunds are counted — resolved ${match.id} (status=${match.status}); the failed-refund fences own it from here`);
    } else {
      logger.info(`[stripe-webhook] charge.refunded for ${charge.id} carried no refund id — matched ${match.id} to the event snapshot (${snapshotCents} cents cumulative)`);
    }
    return { refundId: match.id, refund: match };
  }
  // FAIL CLOSED (codex P0): an empty, stale, truncated, or otherwise
  // unmatchable response must not be processed. Continuing would stamp
  // `stripe_refund_id = null` over an id StripeService.refund() already
  // recorded, leave the failed-refund fence without the id it needs to unwind
  // a later bounce, and email on a payment-scoped key that cannot match the
  // admin path's refund-id key — i.e. the duplicate this fix exists to stop.
  // Throwing returns 500 "Stripe will retry" without marking the event
  // processed; a genuinely permanent mismatch surfaces as a failed event in
  // the Stripe dashboard rather than as silently wrong books.
  throw new Error(
    `charge.refunded for ${charge.id}: no refund matches the snapshot's cumulative ${snapshotCents} cents `
    + `across ${history.length} refund(s) — refusing to process an unattributable refund`,
  );
}

async function handleChargeRefunded(charge) {
  const chargeId = charge.id;
  logger.info(`[stripe-webhook] Charge refunded: ${chargeId}`);

  const resolved = await resolveRefundIdForCharge(charge);
  const latestRefund = (Array.isArray(charge.refunds?.data) ? charge.refunds.data[0] : null)
    || resolved.refund;
  const refundId = resolved.refundId;
  const refundDate = latestRefund?.created ? new Date(latestRefund.created * 1000) : new Date();
  const refundReason = latestRefund?.reason || 'Account adjustment';
  const refundAmountCents = latestRefund?.amount || charge.amount_refunded || 0;
  const refundAmountDollars = refundAmountCents / 100;
  const cumulativeRefundAmountDollars = (charge.amount_refunded || refundAmountCents) / 100;
  const isFullRefund = charge.refunded === true;

  // Estimate deposits have no payments row — a dashboard refund (or the
  // webhook echo of our own refunds: stale deposit, exempt-path sweep,
  // unapplied remainder) must flip the deposit ledger so reversed money can
  // never satisfy acceptance or be credited, then skip the payments path
  // entirely. The cumulative refunded amount lets the handler recognize the
  // echo of a refund it already stamped (a partial remainder refund must not
  // flip a legitimately credited row); refundId lets it refuse a refund
  // whose failure was already recorded (bounce-before-creation).
  const { handleDepositChargeReversed } = require('../services/estimate-deposits');
  const depositReversal = await handleDepositChargeReversed(charge.payment_intent, 'charge.refunded', {
    amountRefundedCents: Number(charge.amount_refunded) > 0 ? Number(charge.amount_refunded) : null,
    refundId,
  });
  if (depositReversal.handled) return;

  // Out-of-order bounce guard: Stripe can deliver refund.failed BEFORE this
  // creation event. handleRefundFailed records the bounced id in the
  // payments row's metadata — stamping that refund as successful here (and
  // running the credit/deposit side effects) would resurrect money Stripe
  // kept. Events for OTHER refunds on the same charge carry different ids
  // and proceed normally.
  if (refundId) {
    // Pre-settlement fence: the bounce arrived before ANY payments row
    // existed (invoice/statement cases — deposits fence on their own
    // ledger). Table-probed for pre-migration tolerance.
    try {
      if (await db.schema.hasTable('stripe_failed_refunds')) {
        const fenced = await db('stripe_failed_refunds').where({ stripe_refund_id: refundId }).first('stripe_refund_id');
        if (fenced) {
          logger.warn(`[stripe-webhook] charge.refunded for ${refundId} arrived after its pre-settlement failure was fenced — skipping stamp + side effects`);
          return;
        }
      }
    } catch (err) {
      logger.warn(`[stripe-webhook] pre-settlement fence probe failed for ${refundId}: ${err.message}`);
    }
    // Same lookup ladder as handleRefundFailed — a processing-stage ACH row
    // may be keyed by PI only, and the fence must cover every row that
    // handler can mark.
    let bounceCheck = await db('payments').where({ stripe_charge_id: chargeId }).first('metadata');
    if (!bounceCheck && charge.payment_intent) {
      bounceCheck = await db('payments').where({ stripe_payment_intent_id: charge.payment_intent }).first('metadata');
    }
    if (bounceCheck) {
      let bounceMeta = {};
      try {
        bounceMeta = bounceCheck.metadata ? (typeof bounceCheck.metadata === 'string' ? JSON.parse(bounceCheck.metadata) : bounceCheck.metadata) : {};
      } catch { bounceMeta = {}; }
      if (Array.isArray(bounceMeta.failed_refund_ids) && bounceMeta.failed_refund_ids.includes(refundId)) {
        logger.warn(`[stripe-webhook] charge.refunded for ${refundId} arrived after its failure was already recorded — skipping stamp + side effects`);
        return;
      }
    }
  }

  // Appointment-card fee PI refunded BEFORE settlement (Codex #3153 r16
  // P0): the fee's paid rows are written by settleAppointmentNoShowFee
  // under the appointment_card_no_show_fee:<pi> advisory lock. A refund
  // landing first would find nothing to mark and be acknowledged, and the
  // later settlement would book fully-paid revenue for refunded money.
  // Under the SAME lock: re-check for the settlement row (it may have
  // landed in the window — the generic path below then stamps it) and
  // otherwise persist a durable refunded payments row that settlement's
  // in-lock replay check consumes.
  if (charge.payment_intent && charge.metadata?.purpose === 'appointment_card_no_show_fee') {
    const feePreRow = await db('payments').where({ stripe_payment_intent_id: charge.payment_intent }).first('id');
    if (!feePreRow) {
      const markerWritten = await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${charge.payment_intent}`]);
        const rowInLock = await trx('payments').where({ stripe_payment_intent_id: charge.payment_intent }).first('id');
        if (rowInLock) return null;
        // Failed-refund fence RE-CHECKED under the lock (Codex #3153 r23
        // P1): refund.failed can commit its fence between the handler's
        // early probe and this lock — a bounced refund must never gain a
        // terminal refunded marker that replay-skips settlement.
        if (refundId) {
          try {
            if (await db.schema.hasTable('stripe_failed_refunds')) {
              const fencedInLock = await trx('stripe_failed_refunds').where({ stripe_refund_id: refundId }).first('stripe_refund_id');
              if (fencedInLock) {
                logger.warn(`[stripe-webhook] fee refund ${refundId} already fenced as failed — no pre-settlement marker written`);
                return null;
              }
            }
          } catch (fenceErr) {
            // FAIL CLOSED (Codex #3153 r24 P0): writing the terminal marker
            // without a verified fence could replay-skip settlement of
            // money Stripe kept — throw so the event retries.
            logger.error(`[stripe-webhook] fee fence re-check failed for ${refundId} — retrying event: ${fenceErr.message}`);
            throw fenceErr;
          }
        }
        // Canonical refund attribution (Codex #3153 r17 P1):
        // stripe_refund_id + metadata.stamped_refund_ids are what
        // handleRefundFailed uses to unwind a bounced refund; refund_status
        // 'full' matches the statement pre-settlement marker vocabulary.
        const [markerRow] = await trx('payments').insert({
          customer_id: charge.metadata?.waves_customer_id || null,
          processor: 'stripe',
          payment_date: etDateString(),
          amount: (Number(charge.amount) || 0) / 100,
          refund_amount: cumulativeRefundAmountDollars,
          refund_status: isFullRefund ? 'full' : 'partial',
          status: isFullRefund ? 'refunded' : 'paid',
          stripe_payment_intent_id: charge.payment_intent,
          stripe_charge_id: chargeId,
          stripe_refund_id: refundId || null,
          metadata: JSON.stringify({
            purpose: 'appointment_card_no_show_fee',
            pre_settlement_refund: true,
            ...(refundId ? { stamped_refund_ids: [refundId] } : {}),
          }),
        }).returning(['id', 'customer_id']);
        return markerRow || { id: null, customer_id: charge.metadata?.waves_customer_id || null };
      });
      if (markerWritten) {
        logger.warn(`[stripe-webhook] appointment fee PI ${charge.payment_intent} refunded before settlement — durable refund marker written`);
        // Standard refund communications still fire (Codex #3153 r20 P1):
        // the early return must not swallow the customer email + admin
        // notification the shared tail sends. sendRefundIssued is
        // idempotent by refund id.
        if (markerWritten.customer_id) {
          PaymentLifecycleEmail.sendRefundIssued({
            customerId: markerWritten.customer_id,
            paymentId: markerWritten.id,
            // Same rule as the main refund tail below: a charge id here would
            // mint an idempotency key that can never match the refund-id key
            // StripeService.refund() uses, so the customer gets two emails.
            refundId: refundId || null,
            refundAmount: refundAmountDollars,
            refundDate,
            refundReason,
          }).catch((emailErr) => {
            logger.warn(`[stripe-webhook] fee pre-settlement refund email failed for charge ${chargeId}: ${emailErr.message}`);
          });
        }
        try {
          await triggerNotification('payment_refunded', {
            amount: refundAmountDollars,
            isFullRefund,
            invoiceId: null,
          });
        } catch (e) {
          logger.warn(`[stripe-webhook] fee pre-settlement refund triggerNotification failed: ${e.message}`);
        }
        return;
      }
    }
  }

  // Statement refund REORDERED ahead of settlement: if a FULL refund arrives
  // before payment_intent.succeeded wrote the statement payments row, resolve the
  // statement by PI and clear/reset its active PI (so the later succeeded fails
  // the active-PI binding and never settles refunded money) + persist a durable
  // refunded marker. Mirrors the dispute pre-settlement guard.
  if (charge.payment_intent) {
    const stmtByPi = await db('payer_statements').where({ stripe_payment_intent_id: charge.payment_intent }).first();
    const preRow = await db('payments').where({ stripe_charge_id: chargeId }).first('id');
    if (stmtByPi && !preRow) {
      const { withStatementMoneyLock } = require('../services/payer-statement-settle');
      // ANY statement refund (full OR partial) before the settlement row exists.
      // Under the money lock, RE-CHECK the row (settle may have inserted it in the
      // window). A partial refund left only to the generic 0-row update would be
      // LOST, and the later succeeded would settle the full gross — overstating cash.
      await withStatementMoneyLock(stmtByPi.id, async (trx) => {
        const rowInLock = await trx('payments').where({ stripe_charge_id: chargeId }).first();
        if (rowInLock) {
          // Settled in the window — apply the refund to the existing row.
          await trx('payments').where({ id: rowInLock.id }).update({
            status: isFullRefund ? 'refunded' : 'paid',
            refund_amount: cumulativeRefundAmountDollars,
            refund_status: isFullRefund ? 'full' : 'partial',
            stripe_refund_id: refundId,
            metadata: JSON.stringify(metadataWithStampedRefund(rowInLock.metadata, refundId)),
          });
          if (isFullRefund) await reverseStatementCascadeForDispute(stmtByPi.id, charge.payment_intent, 'charge.refunded (full)', { database: trx });
        } else if (isFullRefund) {
          // Full refund pre-settlement: reverse the cascade + durable refunded marker.
          await reverseStatementCascadeForDispute(stmtByPi.id, charge.payment_intent, 'charge.refunded (full)', { database: trx });
          await trx('payments').insert({
            customer_id: null, payer_id: stmtByPi.payer_id, statement_id: stmtByPi.id,
            processor: 'stripe', stripe_payment_intent_id: charge.payment_intent, stripe_charge_id: chargeId,
            payment_date: etDateString(), amount: (charge.amount || refundAmountCents) / 100,
            status: 'refunded', refund_amount: cumulativeRefundAmountDollars, refund_status: 'full', stripe_refund_id: refundId,
            description: `Payer statement S-${stmtByPi.id} fully refunded`,
            metadata: JSON.stringify({ statement_id: stmtByPi.id, payer_id: stmtByPi.payer_id, source: 'statement_refund', ...(refundId ? { stamped_refund_ids: [refundId] } : {}) }),
          });
        } else {
          // Partial refund pre-settlement: the eventual succeeded will settle the
          // statement, but it can't know about this refund. Persist a durable
          // manual-review item so the partial refund isn't lost from the ledger.
          await trx('stripe_orphan_charges').insert({
            stripe_payment_intent_id: charge.payment_intent, stripe_charge_id: chargeId,
            customer_id: null, invoice_id: null, amount: refundAmountDollars,
            source: 'statement_pay_webhook',
            original_db_error: `statement S-${stmtByPi.id}: partial refund $${refundAmountDollars.toFixed(2)} before settlement — reconcile refund_amount after settle`,
          }).onConflict('stripe_payment_intent_id').ignore();
        }
      });
      logger.warn(`[stripe-webhook] statement S-${stmtByPi.id} ${isFullRefund ? 'full' : 'partial'} refund handled in-lock (pre-settlement)`);
      return;
    }
  }

  // Statement payment refund: do the row update AND (full) cascade reversal
  // together UNDER the per-statement money lock — otherwise a racing
  // payment_intent.succeeded could flip the same row back to `paid` between the
  // generic update below and the reversal, leaving refunded money counted as paid.
  const preRefundRow = await db('payments').where({ stripe_charge_id: chargeId }).first();
  if (preRefundRow?.statement_id) {
    const { withStatementMoneyLock } = require('../services/payer-statement-settle');
    await withStatementMoneyLock(preRefundRow.statement_id, async (trx) => {
      await trx('payments').where({ id: preRefundRow.id }).update({
        status: isFullRefund ? 'refunded' : 'paid',
        refund_amount: cumulativeRefundAmountDollars,
        refund_status: isFullRefund ? 'full' : 'partial',
        stripe_refund_id: refundId,
        metadata: JSON.stringify(metadataWithStampedRefund(preRefundRow.metadata, refundId)),
      });
      if (isFullRefund) {
        await reverseStatementCascadeForDispute(preRefundRow.statement_id, preRefundRow.stripe_payment_intent_id, `charge.refunded (full $${cumulativeRefundAmountDollars.toFixed(2)})`, { database: trx });
      }
    });
    logger.warn(`[stripe-webhook] statement S-${preRefundRow.statement_id} ${isFullRefund ? 'fully' : 'partially'} refunded${isFullRefund ? ' — cascade reversed to owed' : ''} (in-lock)`);
    return; // statement refund fully handled; no homeowner refund-email path
  }

  // Generic (homeowner invoice) refund. Atomic + durable: the payment refund stamp
  // and the account-credit restore commit together or not at all; a failure BUBBLES
  // to the route handler (→ HTTP 500) so Stripe RETRIES the event rather than acking
  // it with the customer's returned credit stranded. Safe to retry: keyed on
  // stripe_charge_id, and returnAppliedCreditOnRefund re-reads credit_applied under a
  // row lock, so a replayed event is a no-op once the credit is back on the balance.
  let feeRefundFencedInLock = false;
  const refundedPayment = await db.transaction(async (trx) => {
    // Fee-lane refunds serialize with settlement's marker adoption (Codex
    // #3153 r24 P1): an existing fee row (pre-settlement marker or settled
    // row) updated here unlocked could commit between settlement's plain
    // read and its adopting write — the newer cumulative refund amount and
    // id would be overwritten by the stale snapshot and lost. Lane from
    // trusted charge metadata (mirrors the PI's).
    if (charge.payment_intent && charge.metadata?.purpose === 'appointment_card_no_show_fee') {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${charge.payment_intent}`]);
      // BOTH durable bounce fences RE-READ under the lock (Codex #3153
      // r26 P1): serialization alone doesn't preserve the fence —
      // refund.failed can acquire this lock first and commit its fence
      // (stripe_failed_refunds or the row's failed_refund_ids) between
      // this handler's unlocked probes and our lock acquisition; stamping
      // afterwards would mark the bounced refund successful while the
      // failed event's replay sees its fence and skips the unwind. A
      // fence-read failure throws (fail closed → Stripe retries).
      if (refundId) {
        if (await db.schema.hasTable('stripe_failed_refunds')) {
          const fencedInLock = await trx('stripe_failed_refunds').where({ stripe_refund_id: refundId }).first('stripe_refund_id');
          if (fencedInLock) {
            logger.warn(`[stripe-webhook] fee refund ${refundId} was fenced as failed while waiting for the lock — skipping stamp + side effects`);
            feeRefundFencedInLock = true;
            return null;
          }
        }
        const rowForFence = await trx('payments').where({ stripe_charge_id: chargeId }).first('metadata');
        if (rowForFence) {
          let fenceMeta = {};
          try {
            fenceMeta = rowForFence.metadata ? (typeof rowForFence.metadata === 'string' ? JSON.parse(rowForFence.metadata) : rowForFence.metadata) : {};
          } catch { fenceMeta = {}; }
          if (Array.isArray(fenceMeta.failed_refund_ids) && fenceMeta.failed_refund_ids.includes(refundId)) {
            logger.warn(`[stripe-webhook] fee refund ${refundId} already recorded as failed on the payments row — skipping stamp + side effects`);
            feeRefundFencedInLock = true;
            return null;
          }
        }
      }
    }
    // Combined full-balance charge: N per-invoice ledger rows share this
    // one charge, so the generic cumulative stamp below would smear the
    // charge-level refund total onto every row (codex r2 P1). A FULL
    // refund settles cleanly (each row refunded at its own share, each
    // invoice reopened, applied credit returned); a PARTIAL refund cannot
    // be attributed to a share from the charge alone — record it for the
    // operator and touch nothing.
    {
      let combinedRows = await trx('payments').where({ stripe_charge_id: chargeId });
      const rowMeta = (row) => {
        try { return row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {}; } catch { return {}; }
      };
      if (combinedRows.some((r) => rowMeta(r).combined_payment)) {
        // Serialize with refund.failed's combined unwind (codex r12 P1):
        // both combined-row paths take this per-charge lock, rows are
        // RE-READ under it, and the bounce fences are re-checked — a
        // refund.failed that committed its fence while this event was in
        // flight means Stripe KEPT the money, so nothing may be stamped
        // refunded or reopened.
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['combined.refund.fence', String(chargeId)],
        );
        combinedRows = await trx('payments').where({ stripe_charge_id: chargeId });
        if (refundId) {
          const rowFenced = combinedRows.some((r) => {
            const m = rowMeta(r);
            return Array.isArray(m.failed_refund_ids) && m.failed_refund_ids.includes(refundId);
          });
          let tableFenced = false;
          if (!rowFenced && await db.schema.hasTable('stripe_failed_refunds')) {
            tableFenced = !!(await trx('stripe_failed_refunds').where({ stripe_refund_id: refundId }).first('stripe_refund_id'));
          }
          if (rowFenced || tableFenced) {
            logger.warn(`[stripe-webhook] combined refund ${refundId} on charge ${chargeId} was already fenced as FAILED — skipping the refund stamp (Stripe kept the money)`);
            return combinedRows.find((r) => r.customer_id && !(r.status === 'canceled' && rowMeta(r).superseded_reason)) || combinedRows[0] || null;
          }
        }
        if (!isFullRefund) {
          logger.error(`[stripe-webhook] PARTIAL refund on combined charge ${chargeId} — cannot attribute to a share; parked for operator`);
          await trx('stripe_orphan_charges')
            .insert({
              // Keyed per REFUND (codex r7 P1): two distinct partial refunds
              // on the same charge must each keep their own reconciliation
              // case — a constant key would onConflict-ignore the second.
              stripe_payment_intent_id: `${charge.payment_intent || chargeId}:partial-refund:${refundId || 'unknown'}`,
              stripe_charge_id: chargeId,
              customer_id: combinedRows[0]?.customer_id || null,
              invoice_id: null,
              amount: refundAmountDollars,
              source: 'combined_pay_webhook',
              original_db_error: `Partial refund ${refundId || 'unknown'} of $${refundAmountDollars} on a combined balance charge — attribute and reconcile manually`,
            })
            .onConflict('stripe_payment_intent_id')
            .ignore();
          try {
            await NotificationService.notifyAdmin(
              'refund',
              `Partial refund on combined payment: $${refundAmountDollars}`,
              `Charge ${chargeId} settled multiple invoices; a partial refund can't be auto-attributed. Reconcile in /admin/revenue.`,
              { icon: '⚠️', link: '/admin/revenue' },
            );
          } catch { /* non-critical */ }
          return combinedRows.find((r) => r.customer_id && !(r.status === 'canceled' && rowMeta(r).superseded_reason)) || combinedRows[0] || null;
        }
        // CUMULATIVE-full (codex r8 P1): charge.refunded went true through
        // MULTIPLE partial refunds — the earlier partials are already
        // parked, and stamping only THIS refund's id across every row
        // would make any later bounce unwind all-or-nothing (a bounce of
        // this refund would restore everything as fully paid; a bounce of
        // an earlier parked one would restore nothing). Park this
        // contribution alongside the others for allocation-aware operator
        // reconciliation; only a SINGLE refund covering the whole charge
        // takes the clean full unwind below.
        const combinedChargeCents = Number(charge.amount) || 0;
        if (combinedChargeCents && Math.round(refundAmountDollars * 100) < combinedChargeCents) {
          logger.error(`[stripe-webhook] Combined charge ${chargeId} reached FULLY refunded via multiple partials — final contribution parked; operator reconciles all constituents`);
          await trx('stripe_orphan_charges')
            .insert({
              stripe_payment_intent_id: `${charge.payment_intent || chargeId}:partial-refund:${refundId || 'unknown'}`,
              stripe_charge_id: chargeId,
              customer_id: combinedRows[0]?.customer_id || null,
              invoice_id: null,
              amount: refundAmountDollars,
              source: 'combined_pay_webhook',
              original_db_error: `Refund ${refundId || 'unknown'} of $${refundAmountDollars} completed a CUMULATIVE full refund of combined charge ${chargeId} — reconcile every constituent refund manually (rows deliberately untouched)`,
            })
            .onConflict('stripe_payment_intent_id')
            .ignore();
          try {
            await NotificationService.notifyAdmin(
              'refund',
              `Combined charge fully refunded via partials: $${cumulativeRefundAmountDollars}`,
              `Charge ${chargeId} is now fully refunded through multiple partial refunds. No rows were auto-unwound — reconcile the constituents in /admin/revenue.`,
              { icon: '⚠️', link: '/admin/revenue' },
            );
          } catch { /* non-critical */ }
          return combinedRows.find((r) => r.customer_id && !(r.status === 'canceled' && rowMeta(r).superseded_reason)) || combinedRows[0] || null;
        }
        const { returnAppliedCreditOnRefund } = require('../services/customer-credit');
        for (const row of combinedRows) {
          const meta = rowMeta(row);
          // Superseded pre-settlement markers stay canceled (codex r21 P2)
          // — flipping the zeroed, customer-less marker back to 'refunded'
          // would let it surface as the branch's primary row and pollute
          // same-charge consumers; the real per-invoice rows carry the
          // refund.
          if (row.status === 'canceled' && meta.superseded_reason) continue;
          await trx('payments').where({ id: row.id }).update({
            status: 'refunded',
            refund_amount: row.amount,
            refund_status: 'full',
            stripe_refund_id: refundId,
            metadata: JSON.stringify(metadataWithStampedRefund(row.metadata, refundId)),
          });
          const invId = meta.invoice_id || null;
          if (invId) {
            // Ownership check before reopening (codex r36 P1): after a
            // dispute-created reopen, a REPLACEMENT payment may have paid
            // this invoice — refunding the ORIGINAL charge must not flip a
            // replacement-paid invoice to refunded or return credit the
            // replacement still consumes. The invoice reopens only when
            // the refunded PI still owns it; otherwise only the ledger row
            // was stamped (above) and the parked dispute-won reinstatement
            // case resolves — the refund just returned that reinstated
            // cash.
            const refInvoice = await trx('invoices').where({ id: invId }).first('id', 'status', 'stripe_payment_intent_id');
            const refInvPi = refInvoice?.stripe_payment_intent_id ? String(refInvoice.stripe_payment_intent_id) : null;
            const rowPi = row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : null;
            if (refInvoice && refInvPi && rowPi && refInvPi === rowPi) {
              await returnAppliedCreditOnRefund({ invoiceId: invId, createdBy: 'system:refund_webhook' }, trx);
              await trx('invoices')
                .where({ id: invId })
                .whereIn('status', ['paid', 'processing'])
                .update({ status: 'refunded', paid_at: null, updated_at: trx.fn.now() });
            } else {
              const resolvedReinstated = await trx('stripe_orphan_charges')
                .where({ resolved: false, source: 'combined_pay_webhook' })
                .where('stripe_payment_intent_id', 'like', `%:dispute-won:%:${invId}`)
                .update({
                  resolved: true,
                  resolved_at: new Date(),
                  resolution_notes: `Automatically resolved: the original combined charge was fully refunded (${refundId || 'refund id unknown'}) — the reinstated share was returned to the customer`,
                });
              logger.warn(`[stripe-webhook] combined full refund: invoice ${invId} is owned by ${refInvPi || 'no PI / another rail'} — left untouched${resolvedReinstated ? `; ${resolvedReinstated} parked reinstatement case(s) resolved` : ''}`);
            }
          }
        }
        // Residual reconciliation cases for this charge resolve WITH the
        // money (codex r18 P2): unsettleable shares were parked as
        // `<pi>:<invoiceId>` orphan rows — a full charge refund returns
        // that cash too, so the case must not keep reporting unmatched
        // money or keep fencing the invoice through
        // assertNoInvoiceChargeReconciliationPending. Partial-refund/
        // partial-dispute parks are their OWN cases and stay open.
        const residualPiId = charge.payment_intent || combinedRows[0]?.stripe_payment_intent_id || null;
        const resolvedResiduals = await trx('stripe_orphan_charges')
          .where({ resolved: false, source: 'combined_pay_webhook' })
          .where(function residualKeys() {
            this.where('stripe_charge_id', chargeId);
            if (residualPiId) this.orWhere('stripe_payment_intent_id', 'like', `${residualPiId}:%`);
          })
          .whereNot('stripe_payment_intent_id', 'like', '%:partial-%')
          .update({
            resolved: true,
            resolved_at: new Date(),
            resolution_notes: `Automatically resolved: the combined charge was fully refunded (${refundId || 'refund id unknown'}) — the unmatched cash was returned to the customer`,
          });
        if (resolvedResiduals > 0) {
          logger.info(`[stripe-webhook] Combined charge ${chargeId} full refund resolved ${resolvedResiduals} residual reconciliation case(s)`);
        }
        logger.info(`[stripe-webhook] Combined charge ${chargeId} fully refunded — ${combinedRows.length} rows refunded at their shares, invoices reopened as refunded`);
        return combinedRows.find((r) => r.customer_id && !(r.status === 'canceled' && rowMeta(r).superseded_reason)) || combinedRows[0] || null;
      }
      // PRE-SETTLEMENT combined refund (codex r6 P0): charge.refunded can
      // arrive before payment_intent.succeeded wrote any allocation rows —
      // the generic missing-row branch below would refund only the anchor
      // and the later combined settle would mark every sibling paid on
      // money Stripe already returned. Detect the combined allocation from
      // the charge/PI metadata (charge.metadata mirrors the PI's; confirm
      // against the PI itself when it's absent, failing CLOSED on an
      // unreadable read). A FULL refund persists a refunded fence marker
      // the combined settle honors (it records the orphan instead of
      // settling); a PARTIAL refund parks for the operator exactly like
      // the post-settlement partial (the eventual settle is real money —
      // only the partial needs manual attribution).
      if (!combinedRows.length && charge.payment_intent) {
        const PayCombined = require('../services/pay-combined');
        let combinedPiMeta = PayCombined.isCombinedPiMetadata(charge.metadata) ? charge.metadata : null;
        if (!combinedPiMeta) {
          const preStripe = getStripe();
          // Fail CLOSED (codex r37 P0): with no client we cannot rule out
          // a combined PI — falling through to the single-invoice path
          // would refund only the anchor and let a reordered succeeded
          // settle the siblings on fully-returned money.
          if (!preStripe) {
            throw new Error(`charge.refunded for ${chargeId}: PI ${charge.payment_intent} cannot be verified as combined or single (Stripe client unavailable); retry`);
          }
          const refundedPi = await preStripe.paymentIntents.retrieve(charge.payment_intent);
          if (PayCombined.isCombinedPiMetadata(refundedPi?.metadata)) combinedPiMeta = refundedPi.metadata;
        }
        if (combinedPiMeta) {
          // Serialize with handleRefundFailed's no-row fence write (codex
          // r9 P1): both paths take this per-charge advisory lock, and the
          // fence is RE-CHECKED under it — a bounce that committed its
          // stripe_failed_refunds row while this event was in flight means
          // Stripe KEPT the money, so no refunded marker may be written
          // (it would permanently fence a legitimate later settle).
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['combined.refund.fence', String(chargeId)],
          );
          if (refundId && await db.schema.hasTable('stripe_failed_refunds')) {
            const bounceFenced = await trx('stripe_failed_refunds').where({ stripe_refund_id: refundId }).first('stripe_refund_id');
            if (bounceFenced) {
              logger.warn(`[stripe-webhook] pre-settlement combined refund ${refundId} was already fenced as FAILED — skipping the refunded marker (Stripe kept the money)`);
              return null;
            }
          }
          // Serialize with COMBINED SETTLEMENT too (codex r10 P1): the
          // succeeded handler settles under stripe.pi.payment, not the
          // refund-fence lock — without this, both can read "no opposing
          // row" and commit (every invoice paid + a refunded marker, with
          // no later event to reopen them). Re-check for allocation rows
          // in-lock and retry against them when settlement won the race.
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['stripe.pi.payment', String(charge.payment_intent)],
          );
          const settledRowInLock = await trx('payments').where({ stripe_charge_id: chargeId }).first('id');
          if (settledRowInLock) {
            throw new Error(`payments rows appeared for charge ${chargeId} while fencing its pre-settlement refund — retry the event against the rows`);
          }
          // CUMULATIVE-full gating (codex r16 P1, mirroring the
          // post-settlement branch): charge.refunded reached via multiple
          // partials must NOT write a fence stamped with only the final
          // refund id — a bounce of that constituent would lift the whole
          // fence and resettle despite the earlier refunds standing, and a
          // bounce of an earlier one couldn't lift it at all. Park the
          // final contribution with the other parked constituents instead;
          // only a SINGLE whole-charge refund writes the clean fence.
          const preChargeCents = Number(charge.amount) || 0;
          const cumulativeFullPreSettle = isFullRefund
            && preChargeCents > 0
            && Math.round(refundAmountDollars * 100) < preChargeCents;
          if (!isFullRefund || cumulativeFullPreSettle) {
            logger.error(`[stripe-webhook] ${cumulativeFullPreSettle ? 'CUMULATIVE-full' : 'PARTIAL'} refund on unsettled combined charge ${chargeId} — parked for operator`);
            await trx('stripe_orphan_charges')
              .insert({
                // Same per-refund key as the post-settlement partial park.
                stripe_payment_intent_id: `${charge.payment_intent}:partial-refund:${refundId || 'unknown'}`,
                stripe_charge_id: chargeId,
                customer_id: null,
                invoice_id: null,
                amount: refundAmountDollars,
                source: 'combined_pay_webhook',
                original_db_error: `${cumulativeFullPreSettle ? 'Final constituent of a CUMULATIVE full refund' : 'Partial refund'} ${refundId || 'unknown'} of $${refundAmountDollars} on a combined balance charge BEFORE settlement — attribute and reconcile manually${cumulativeFullPreSettle ? ' (the charge is now fully refunded across multiple partials; if settlement proceeds, reopen the invoices from the parked cases)' : ''}`,
              })
              .onConflict('stripe_payment_intent_id')
              .ignore();
            try {
              await NotificationService.notifyAdmin(
                'refund',
                `${cumulativeFullPreSettle ? 'Combined charge fully refunded via partials (pre-settlement)' : 'Partial refund on combined payment'}: $${refundAmountDollars}`,
                `Charge ${chargeId} backs multiple invoices (not yet settled); ${cumulativeFullPreSettle ? 'it is now FULLY refunded across multiple partial refunds — every constituent is parked' : 'a partial refund can\'t be auto-attributed'}. Reconcile in /admin/revenue.`,
                { icon: '⚠️', link: '/admin/revenue' },
              );
            } catch { /* non-critical */ }
            return null;
          }
          const [refundFence] = await trx('payments').insert({
            customer_id: null,
            processor: 'stripe',
            stripe_payment_intent_id: charge.payment_intent,
            stripe_charge_id: chargeId,
            payment_date: etDateString(),
            amount: (charge.amount || refundAmountCents) / 100,
            status: 'refunded',
            refund_amount: cumulativeRefundAmountDollars,
            refund_status: 'full',
            stripe_refund_id: refundId,
            description: 'Combined balance charge fully refunded before settlement (marker)',
            metadata: JSON.stringify({
              combined_payment: true,
              pre_settlement: true,
              source: 'combined_pay_webhook',
              combined_anchor_invoice_id: combinedPiMeta.waves_invoice_id || null,
              ...(refundId ? { stamped_refund_ids: [refundId] } : {}),
            }),
          }).returning('*');
          try {
            await NotificationService.notifyAdmin(
              'refund',
              `Combined payment refunded pre-settlement: $${refundAmountDollars}`,
              `Charge ${chargeId} (combined PI ${charge.payment_intent}) was fully refunded before settlement — settlement is fenced; no invoice was marked paid.`,
              { icon: '⚠️', link: '/admin/revenue' },
            );
          } catch { /* non-critical */ }
          return refundFence;
        }
      }
    }
    await trx('payments')
      .where({ stripe_charge_id: chargeId })
      .update({
        status: isFullRefund ? 'refunded' : 'paid',
        refund_amount: cumulativeRefundAmountDollars,
        refund_status: isFullRefund ? 'full' : 'partial',
        stripe_refund_id: refundId,
      });
    const pmt = await trx('payments').where({ stripe_charge_id: chargeId }).first();
    let result = pmt;
    // Record this refund id as STAMPED (see metadataWithStampedRefund) so a
    // later bounce of it stays attributable even after newer stamps
    // overwrite stripe_refund_id.
    if (pmt && refundId) {
      await trx('payments').where({ id: pmt.id }).update({
        metadata: JSON.stringify(metadataWithStampedRefund(pmt.metadata, refundId)),
      });
    }
    // Keep the surcharge-returned tracker in step with refunds this app did
    // NOT issue (Stripe-dashboard partials): treat the cumulative refunded
    // gross as proportionally split (rs = R·S/(B+S)), monotone max() so the
    // exact tracking written by StripeService.refund is never lowered by its
    // own webhook echo. Pre-gross-up legacy refunds get counted as containing
    // their share too — conservative: the next in-app partial can only send
    // LESS surcharge, never over-refund.
    if (pmt) {
      const trkSurcharge = Math.max(0, Number(pmt.surcharge_amount_cents) || 0);
      const trkPaidCents = Math.round((parseFloat(pmt.amount) || 0) * 100);
      if (trkSurcharge > 0 && trkPaidCents > 0) {
        const proportional = Math.min(
          trkSurcharge,
          Math.round((Math.round(cumulativeRefundAmountDollars * 100) * trkSurcharge) / trkPaidCents),
        );
        if (proportional > (Number(pmt.refunded_surcharge_cents) || 0)) {
          await trx('payments').where({ id: pmt.id }).update({ refunded_surcharge_cents: proportional });
        }
      }
    }
    if (isFullRefund) {
      // Resolve the invoice from every available link (PI, metadata.invoice_id,
      // charge.payment_intent, invoices.stripe_charge_id) — a reconciled
      // charge-only payment has no PI, so a PI-only lookup would skip the restore
      // and strand the customer's applied credit.
      const invId = await resolveRefundedInvoiceId(trx, { pmt, charge, chargeId });
      if (invId) {
        const { returnAppliedCreditOnRefund } = require('../services/customer-credit');
        await returnAppliedCreditOnRefund({ invoiceId: invId, createdBy: 'system:refund_webhook' }, trx);
        // Pre-settlement refund: charge.refunded arrived before payment_intent.succeeded
        // wrote the payments row (the update above hit 0 rows → pmt is null), but the
        // invoice still resolved + was marked 'refunded'. The later succeeded handler
        // skips refunded invoices, so without a row here the refunded receipt PDF + the
        // refund email have nothing to read. Insert a durable refunded marker (mirrors
        // the statement pre-settlement branch). Idempotent: a replay updates this row
        // above and finds it via pmt, so it won't double-insert.
        if (!pmt) {
          const inv = await trx('invoices').where({ id: invId }).first('customer_id', 'invoice_number');
          const [marker] = await trx('payments').insert({
            customer_id: inv?.customer_id || null,
            processor: 'stripe',
            stripe_payment_intent_id: charge.payment_intent || null,
            stripe_charge_id: chargeId,
            payment_date: etDateString(),
            amount: (charge.amount || refundAmountCents) / 100,
            status: 'refunded',
            refund_amount: cumulativeRefundAmountDollars,
            refund_status: 'full',
            stripe_refund_id: refundId,
            description: `Invoice ${inv?.invoice_number || invId} fully refunded`,
            metadata: JSON.stringify({ invoice_id: invId, source: 'invoice_refund', ...(refundId ? { stamped_refund_ids: [refundId] } : {}) }),
          }).returning('*');
          result = marker;
        }
      }
    }
    return result;
  });
  // A fence discovered under the lock means the refund BOUNCED — nothing
  // was stamped, and no refund email/notification may fire for money
  // Stripe kept (the refund.failed handler already notified the office).
  if (feeRefundFencedInLock) return;
  if (refundedPayment?.customer_id) {
    PaymentLifecycleEmail.sendRefundIssued({
      customerId: refundedPayment.customer_id,
      paymentId: refundedPayment.id,
      // NEVER fall back to the charge id. sendRefundIssued builds its
      // idempotency key from this value, and StripeService.refund() (the
      // admin-initiated path, which emails first) keys on the REFUND id — a
      // charge id here mints a different key, the dedupe misses, and the
      // customer gets the same refund email twice. resolveRefundIdForCharge
      // now throws rather than yield an unresolved id, so this is a standing
      // invariant guard rather than a live path: keep it, so reintroducing a
      // charge-id fallback takes a deliberate edit.
      refundId: refundId || null,
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

  // Annual-prepay claw-back after a full refund — CRITICAL lifecycle
  // write, no .catch (codex r15 P1): a swallowed failure acknowledges the
  // webhook with active coverage still riding on refunded money, and no
  // cron reconciles active terms whose invoices are refunded. Propagate so
  // Stripe redelivers; the refund stamps above are idempotent on replay.
  {
    const refundSyncAnchor = await db('payments').where({ stripe_charge_id: chargeId }).first();
    if (isFullRefund && refundSyncAnchor) {
      // A combined charge refunds N per-invoice rows — the annual-prepay
      // sync must see EVERY refunded share, not the arbitrary first row
      // (codex r4 P1: a prepay invoice elsewhere in the allocation would
      // keep active coverage on refunded money). Single-invoice charges
      // have exactly one row, preserving the original behavior.
      const refundSyncRows = await db('payments')
        .where({ stripe_charge_id: chargeId, status: 'refunded' });
      const rowsToSync = refundSyncRows.length ? refundSyncRows : [refundSyncAnchor];
      for (const refundedRow of rowsToSync) {
        await require('../services/annual-prepay-renewals').syncTermForRefundedPayment(refundedRow);
      }
    }
  }

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
 * refund.failed / charge.refund.updated(status=failed|canceled) — a refund we
 * already recorded bounced after creation. charge.refunded fires when the
 * refund is CREATED, before ACH refunds actually clear, so the books
 * optimistically show the money returned (payments row stamped, credit
 * restored, refund email sent). When the bank later rejects it, Stripe keeps
 * the money and nothing corrected the ledger — this handler reverts the
 * payments stamps and raises an operator signal for the parts that need a
 * human (restored account credit, the already-sent refund email, deposit
 * ledger flips).
 */
async function handleRefundFailed(refund) {
  const refundId = refund?.id || null;
  const chargeId = refund?.charge || null;
  const piId = refund?.payment_intent || null;
  const failedCents = Number(refund?.amount) || 0;
  const failedDollars = failedCents / 100;
  logger.warn(`[stripe-webhook] Refund ${refundId} FAILED (charge ${chargeId}): ${refund?.failure_reason || refund?.status || 'no reason given'}`);

  let payment = null;
  if (refundId) payment = await db('payments').where({ stripe_refund_id: refundId }).first();
  if (!payment && chargeId) payment = await db('payments').where({ stripe_charge_id: chargeId }).first();
  // ACH rows created by payment_intent.processing may not carry a charge id
  // yet — without the PI fallback an early bounce would take the notify-only
  // path, never record failed_refund_ids, and the late charge.refunded would
  // stamp the failed refund as successful.
  if (!payment && piId) payment = await db('payments').where({ stripe_payment_intent_id: piId }).first();

  // The admin notification is the ONLY durable operator signal for the side
  // effects this handler deliberately leaves to a human (restored credit,
  // statement cascade, deposit ledger) — Stripe will not retry an acked
  // event, so its insert must never be swallowed. For payments-backed
  // bounces it commits ATOMICALLY with the revert (a failure rolls both
  // back and the 500 makes Stripe retry the whole event); for the
  // no-payments case it throws for the same reason — nothing else was
  // written, so the retry is a clean re-run.
  const insertBounceNotification = async (conn, body) => {
    // Through NotificationService (connection: conn keeps it inside the
    // caller's transaction) so the admin bell policy chokepoint covers it.
    // bell: true — a failed refund is a money failure and must keep ringing
    // under GATE_ADMIN_BELL_POLICY. create() swallows insert errors into
    // null; rethrow so the transactional/throw-on-failure contract above
    // holds and Stripe retries the event.
    const notif = await NotificationService.create({
      recipientType: 'admin',
      category: 'billing',
      title: `Refund FAILED at the bank: $${failedDollars.toFixed(2)}`,
      body: `Stripe refund ${refundId || '(unknown id)'} on charge ${chargeId || piId || '(unknown)'} did not clear (${refund?.failure_reason || 'no reason given'}). ${body}`,
      icon: '⚠️',
      link: '/admin/invoices',
      bell: true,
      connection: conn,
    });
    if (!notif) throw new Error('refund-failure notification insert failed');
  };

  // Combined full-balance charge (payIncludeBalance): the full-refund
  // handler stamped this refund onto EVERY allocation row, so its bounce
  // must unwind every row and restore every invoice — the single-row path
  // below would restore only .first() and leave the siblings 'refunded'
  // with their credit returned while Stripe kept the whole charge (codex
  // r3 P1). Partial refunds never stamp combined rows (they park for the
  // operator), so a stamped refund here is by construction the full one:
  // the unwind is a clean full reversal per row.
  {
    let combinedRefundMeta = {};
    try {
      combinedRefundMeta = payment?.metadata
        ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata)
        : {};
    } catch { combinedRefundMeta = {}; }
    if (payment && combinedRefundMeta.combined_payment) {
      const rowChargeId = chargeId || payment.stripe_charge_id || null;
      const rowPiId = piId || payment.stripe_payment_intent_id || null;
      let resettleFencedPiId = null;
      const restored = [];
      await db.transaction(async (trx) => {
        // Same per-charge lock as charge.refunded's combined branch (codex
        // r12 P1) — the two unwinds are strictly ordered, so the refunded
        // stamp and the bounce fence can never interleave.
        if (rowChargeId) {
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['combined.refund.fence', String(rowChargeId)],
          );
        }
        const rows = rowChargeId
          ? await trx('payments').where({ stripe_charge_id: rowChargeId }).forUpdate()
          : await trx('payments').where({ stripe_payment_intent_id: rowPiId }).forUpdate();
        let alreadyRecorded = false;
        let neutralizedMarker = false;
        let anyUnwound = false;
        for (const row of rows) {
          let meta = {};
          try {
            meta = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {};
          } catch { meta = {}; }
          const failedIds = Array.isArray(meta.failed_refund_ids) ? meta.failed_refund_ids : [];
          const isPreSettlementMarker = meta.pre_settlement === true && !meta.invoice_id;
          if (refundId && failedIds.includes(refundId)) {
            // Replay after a crash between the marker neutralization and
            // the resettle (codex r8 P1): the fence must not suppress the
            // recovery it exists to retry — re-arm the (idempotent)
            // succeeded re-run for an already-neutralized marker.
            if (isPreSettlementMarker) {
              resettleFencedPiId = row.stripe_payment_intent_id || rowPiId;
            }
            alreadyRecorded = true;
            continue;
          }
          const stampedIds = Array.isArray(meta.stamped_refund_ids) ? meta.stamped_refund_ids : [];
          const wasStamped = !!refundId && (row.stripe_refund_id === refundId || stampedIds.includes(refundId));
          const nextMeta = {
            ...meta,
            failed_refund_ids: refundId ? [...failedIds, refundId] : failedIds,
            ...(refundId && stampedIds.includes(refundId)
              ? { stamped_refund_ids: stampedIds.filter((id) => id !== refundId) }
              : {}),
          };
          if (!wasStamped) {
            await trx('payments').where({ id: row.id }).update({ metadata: JSON.stringify(nextMeta) });
            continue;
          }
          // PRE-SETTLEMENT refund fence marker (codex r7 P0): this row is a
          // full-amount fence, not a settled share — flipping it to 'paid'
          // would either strand the invoices unsettled (the fenced
          // succeeded already recorded its orphan and will not retry) or
          // double-count the charge once a later succeeded settles the
          // per-invoice rows. Neutralize it and re-run the full succeeded
          // lifecycle after commit.
          if (isPreSettlementMarker) {
            await trx('payments').where({ id: row.id }).update({
              refund_amount: 0,
              refund_status: null,
              stripe_refund_id: null,
              status: 'canceled',
              // Amount zeroed too (codex r8 P1): same-charge consumers (the
              // dispute handlers' full-vs-partial sums, payout recon) must
              // not count a superseded full-amount marker beside the real
              // per-invoice rows; the original amount survives in metadata.
              amount: 0,
              metadata: JSON.stringify({ ...nextMeta, superseded_reason: 'pre_settlement_refund_bounced', superseded_marker_amount: Number(row.amount) || 0 }),
            });
            neutralizedMarker = true;
            resettleFencedPiId = row.stripe_payment_intent_id || rowPiId;
            continue;
          }
          anyUnwound = true;
          // Rows refunded while the ACH debit was still PROCESSING restore
          // to 'processing', not 'paid' (codex r29 P1): the refund landed
          // before settlement, so the eventual debit outcome — not this
          // bounce — is authoritative. Flipping them 'paid' would leave
          // every invoice paid and coverage active even if the debit later
          // fails (the failure path preserves paid rows).
          let wasStillProcessing = nextMeta.payment_state === 'processing' && !nextMeta.settled_event_at;
          let debitAlreadyTerminal = false;
          if (wasStillProcessing && row.status === 'refunded') {
            // The debit may ALREADY be terminal (codex r34 P1): a
            // payment_failed/canceled delivered before this bounce skipped
            // the then-'refunded' rows, so no later intent event remains —
            // restoring 'processing' from stale metadata would strand the
            // allocation non-collectible forever. The LIVE intent decides;
            // fail closed on an unreadable read.
            const bounceStripeCheck = getStripe();
            // Fail CLOSED (codex r36 P1): restoring 'processing' without
            // the live read could strand the allocation forever.
            if (!bounceStripeCheck) {
              throw new Error(`Refund bounce for combined PI ${row.stripe_payment_intent_id || rowPiId} cannot verify the live debit (Stripe client unavailable); retry`);
            }
            if (row.stripe_payment_intent_id || rowPiId) {
              const liveBouncePi = await bounceStripeCheck.paymentIntents.retrieve(row.stripe_payment_intent_id || rowPiId);
              if (!['processing', 'succeeded', 'requires_capture'].includes(liveBouncePi.status)) {
                debitAlreadyTerminal = true;
                wasStillProcessing = false;
              }
            }
          }
          await trx('payments').where({ id: row.id }).update({
            refund_amount: 0,
            refund_status: null,
            stripe_refund_id: null,
            ...(row.status === 'refunded'
              ? {
                status: debitAlreadyTerminal ? 'failed' : (wasStillProcessing ? 'processing' : 'paid'),
                ...(debitAlreadyTerminal ? { failure_reason: 'ACH debit terminated before settling (refund bounced afterwards)' } : {}),
              }
              : {}),
            metadata: JSON.stringify(nextMeta),
          });
          const invId = meta.invoice_id || null;
          if (invId && debitAlreadyTerminal) {
            // Reopen like the failure path — the money never arrived.
            const termInvoice = await trx('invoices').where({ id: invId, status: 'refunded' }).first();
            if (termInvoice) {
              await trx('invoices').where({ id: invId, status: 'refunded' }).update({
                status: nextInvoiceStatusAfterFailedPayment(termInvoice),
                paid_at: null,
                stripe_payment_intent_id: null,
                stripe_charge_id: null,
                ach_processing_notified_at: null,
                updated_at: new Date(),
              });
            }
          } else if (invId) {
            const flipped = await trx('invoices')
              .where({ id: invId, status: 'refunded' })
              .update(wasStillProcessing
                ? {
                  // Back to the in-flight state — the debit's own
                  // succeeded/failed event decides the final outcome.
                  status: 'processing',
                  paid_at: null,
                  updated_at: new Date(),
                }
                : {
                  status: 'paid',
                  // The refund cleared paid_at, and AR/overdue queries treat
                  // paid_at IS NULL as an outstanding balance (codex r11 P1)
                  // — restore the settlement timestamp with the status, from
                  // the ledger row's recorded settle time when available.
                  paid_at: meta.settled_event_at || new Date().toISOString(),
                  updated_at: new Date(),
                });
            if (flipped > 0 && !wasStillProcessing) restored.push(invId);
          }
        }
        if (alreadyRecorded && !restored.length && !neutralizedMarker) return; // replay
        // A PARKED partial refund's bounce never stamped any row (codex r15
        // P2): the loop only recorded failed_refund_ids — reporting "the
        // full refund bounced ... credit may need claw-back" would describe
        // an unwind and a credit return that never happened. Name the real
        // event: the parked reconciliation case's refund attempt failed.
        if (!anyUnwound && !neutralizedMarker) {
          // The parked case itself resolves with the bounce (codex r20
          // P2): Stripe kept the money, so there is no movement left to
          // attribute — leaving the per-refund orphan open would keep the
          // revenue queue reporting a refund that never cleared.
          if (refundId) {
            const resolvedParked = await trx('stripe_orphan_charges')
              .where({ resolved: false, source: 'combined_pay_webhook' })
              .where('stripe_payment_intent_id', 'like', `%:partial-refund:${refundId}`)
              .update({
                resolved: true,
                resolved_at: new Date(),
                resolution_notes: `Automatically resolved: refund ${refundId} FAILED at the bank — Stripe kept the money, no movement to reconcile`,
              });
            if (resolvedParked > 0) logger.info(`[stripe-webhook] bounce of parked partial refund ${refundId} resolved its reconciliation case`);
          }
          await insertBounceNotification(trx, `Combined balance charge ${rowChargeId || rowPiId}: a PARKED partial-refund attempt (${refundId || 'unknown id'}) failed at the bank — no rows were ever stamped and no credit was returned; its reconciliation case was auto-resolved (the money never moved).`);
          return;
        }
        await insertBounceNotification(trx, `Combined balance charge ${rowChargeId || rowPiId}: the full refund bounced — ${neutralizedMarker ? 'the pre-settlement refund fence was lifted and settlement re-runs from the PI' : `${rows.length} allocation rows unwound to paid and ${restored.length} invoices restored`}. Account credit that returnAppliedCreditOnRefund restored per invoice may need manual claw-back (it is deliberately not auto-reversed).${restored.length ? ' Any annual-prepay coverage the refund CANCELLED is not auto-revived (revival is dispute-marker-gated) — the paid-sync re-runs post-commit, but if coverage stays cancelled on a restored invoice, reactivate it manually.' : ''}`);
      });
      // Post-commit paid sync per restored invoice (codex r19 P1, single-
      // payment-branch parity): the refund already ran
      // syncTermForRefundedPayment and cancelled any prepay coverage; no
      // payment_intent.succeeded will ever fire for a bounce, so this is
      // the only re-sync. payment_pending terms reactivate through the
      // sanctioned state machine; refund-cancelled terms stay cancelled by
      // design (the notification above names the manual remediation).
      for (const restoredId of restored) {
        try {
          await require('../services/annual-prepay-renewals').syncTermForInvoicePayment(restoredId);
        } catch (syncErr) {
          logger.error(`[stripe-webhook] annual-prepay resync after combined refund bounce failed for invoice ${restoredId}: ${syncErr.message}`);
        }
      }
      // Bounced pre-settlement refund → the money never left after all. If
      // the PI actually succeeded (its settle was fenced into an orphan),
      // run the FULL succeeded lifecycle now — guard chain, allocation
      // settle, orphan resolution, review/ACH/enroll/pause mirrors (codex
      // r7 P0+P1). Fail closed: an unreadable PI throws so Stripe
      // redelivers this bounce event and the (idempotent) path re-runs.
      if (resettleFencedPiId) {
        const bounceStripe = getStripe();
        if (!bounceStripe) throw new Error(`Combined refund bounce on unsettled PI ${resettleFencedPiId} but Stripe is unavailable to resettle; retry`);
        const fencedPi = await bounceStripe.paymentIntents.retrieve(resettleFencedPiId);
        if (fencedPi.status === 'succeeded') {
          await handleCombinedPaymentIntentSucceeded(fencedPi, null);
          logger.warn(`[stripe-webhook] combined refund bounce lifted the pre-settlement fence — PI ${resettleFencedPiId} re-ran the succeeded lifecycle`);
        } else {
          logger.warn(`[stripe-webhook] combined refund bounce lifted the pre-settlement fence — PI ${resettleFencedPiId} is ${fencedPi.status}, awaiting its own settle event`);
        }
      }
      return;
    }
  }

  if (!payment) {
    // Estimate-deposit refunds have no payments row — record the failed id
    // ON THE DEPOSIT so a late charge.refunded can't run the reversal for
    // money Stripe kept (handleDepositChargeReversed consults this fence).
    // Column-probed for pre-migration tolerance; the deposit-row lookup
    // doubles as the replay fence (both bounce events must notify once).
    let dep = null;
    if (piId && refundId) {
      try {
        const depCols = await db('estimate_deposits').columnInfo();
        if (depCols.failed_refund_ids) {
          dep = await db('estimate_deposits')
            .where({ stripe_payment_intent_id: piId })
            .first('id', 'failed_refund_ids', 'status');
        }
      } catch (err) {
        logger.warn(`[stripe-webhook] deposit bounce-fence probe failed for PI ${piId}: ${err.message}`);
      }
    }
    if (dep) {
      const parseFence = (v) => {
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') { try { return JSON.parse(v || '[]'); } catch { return []; } }
        return [];
      };
      if (parseFence(dep.failed_refund_ids).includes(refundId)) return; // replay — already recorded + notified
      // Fence + notification commit ATOMICALLY (same invariant as the
      // payments-backed revert below): a notify failure must roll the fence
      // back and throw so Stripe retries — a committed fence with a lost
      // notification would send the retry into the replay check above and
      // ack silently, erasing the only operator signal. The fence list is
      // RE-READ under the row lock: two overlapping bounces for different
      // partial refunds would otherwise both write from the pre-transaction
      // snapshot, and the loser's id would vanish — un-fencing its late
      // charge.refunded.
      await db.transaction(async (trx) => {
        const locked = await trx('estimate_deposits')
          .where({ id: dep.id })
          .forUpdate()
          .first('failed_refund_ids', 'status');
        if (!locked) return;
        const failed = parseFence(locked.failed_refund_ids);
        if (failed.includes(refundId)) return; // recorded while we waited on the lock
        await trx('estimate_deposits')
          .where({ id: dep.id })
          .update({ failed_refund_ids: JSON.stringify([...failed, refundId]), updated_at: new Date() });
        await insertBounceNotification(trx, `Deposit ${dep.id} (status ${locked.status || dep.status}): the failed refund id was recorded — the deposit reversal will refuse this refund's late creation event. If the deposit was already flipped to refunded, restore its ledger manually.`);
      });
      return;
    }
    // No payments row and not a deposit — an invoice/statement refund whose
    // bounce outran settlement. Fence the refund id in stripe_failed_refunds
    // (PK = refund id) so the late charge.refunded can't stamp a refunded
    // marker, terminalize the invoice, or restore credit for money Stripe
    // kept. Same atomic fence+notification contract as the deposit branch;
    // table-probed for pre-migration tolerance.
    let fenceTableReady = false;
    if (refundId) {
      try {
        fenceTableReady = await db.schema.hasTable('stripe_failed_refunds');
        if (fenceTableReady) {
          const fenced = await db('stripe_failed_refunds').where({ stripe_refund_id: refundId }).first('stripe_refund_id');
          if (fenced) return; // replay — already recorded + notified
        }
      } catch (err) {
        logger.warn(`[stripe-webhook] refund-failed fence probe failed for ${refundId}: ${err.message}`);
        fenceTableReady = false;
      }
    }
    if (refundId && fenceTableReady) {
      // Fee-purpose PIs take the fee advisory lock around the fence write
      // (Codex #3153 r23 P1): the charge.refunded marker path re-checks
      // this fence under the same lock, so exactly one of {fence, marker}
      // wins — a bounced refund can never coexist with a terminal
      // refunded marker that replay-skips settlement. Lane identified from
      // trusted PI metadata; retrieve failure throws → event retries.
      let feePiLockKey = null;
      if (piId) {
        try {
          // Local pointer first (no Stripe round-trip for the common
          // non-fee case); fall back to trusted PI metadata for the rare
          // crashed-before-pointer charge. A detection failure throws so
          // the event retries — never an unlocked fence on uncertainty.
          const feePtr = await db('appointment_card_requests')
            .where({ no_show_payment_intent_id: piId })
            .first('id');
          if (feePtr) {
            feePiLockKey = `appointment_card_no_show_fee:${piId}`;
          } else {
            const fencePi = await require('../services/stripe').retrievePaymentIntent(piId);
            if (fencePi?.metadata?.purpose === 'appointment_card_no_show_fee') {
              feePiLockKey = `appointment_card_no_show_fee:${piId}`;
            }
          }
        } catch (detectErr) {
          // FAIL CLOSED (Codex #3153 r24 P0): fencing without the fee lock
          // could lose the fence/marker race — throw so Stripe retries.
          logger.error(`[stripe-webhook] fee-lane detection for failed refund ${refundId} errored — retrying event: ${detectErr.message}`);
          throw detectErr;
        }
      }
      await db.transaction(async (trx) => {
        if (feePiLockKey) {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [feePiLockKey]);
          // A marker may have landed while we waited — if so, fall out and
          // let the normal row path (next retry) unwind it instead of
          // double-recording the fence.
          const rowInLock = await trx('payments').where({ stripe_payment_intent_id: piId }).first('id');
          if (rowInLock) {
            const e = new Error('fee payments row appeared before the fence — retry the event against the row');
            e.retryRefundFailed = true;
            throw e;
          }
        }
        // Combined pre-settlement marker race (codex r9 P1): serialize with
        // charge.refunded's marker insert on the same per-charge lock, and
        // re-check for rows that landed while waiting — if the refunded
        // marker (or settlement rows) committed first, retry this event so
        // the row-based unwind handles it instead of fencing alongside it.
        if (chargeId) {
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['combined.refund.fence', String(chargeId)],
          );
          const chargeRowInLock = await trx('payments').where({ stripe_charge_id: chargeId }).first('id');
          if (chargeRowInLock) {
            const e = new Error('payments row appeared for the charge before the fence — retry the event against the row');
            e.retryRefundFailed = true;
            throw e;
          }
        }
        await trx('stripe_failed_refunds').insert({
          stripe_refund_id: refundId,
          stripe_charge_id: chargeId,
          stripe_payment_intent_id: piId,
          context: 'refund.failed before settlement row',
        });
        await insertBounceNotification(trx, 'No payments row matched — the failed refund id was fenced, so its late charge.refunded creation event will be skipped. If an invoice or statement was already marked refunded, restore it manually.');
      });
      return;
    }
    await insertBounceNotification(db, 'No payments row matched — if this was an estimate-deposit refund, the deposit ledger may need a manual flip.');
    return;
  }

  // Pre-resolve the linked invoice (+ any prepay term the optimistic refund
  // cancelled) READ-ONLY before the transaction: a failed lookup (e.g. a
  // pre-migration table) inside the trx would poison it and wedge the event
  // in a retry loop; out here it just degrades the notification detail.
  let linkedInvoice = null;
  let cancelledPrepayTermId = null;
  let replacementScopeSsId = null;
  try {
    let pMeta = {};
    try {
      pMeta = payment.metadata ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata) : {};
    } catch { pMeta = {}; }
    // Same resolution ladder as resolveRefundedInvoiceId — a legacy
    // reconciled charge-only payment links its invoice via
    // invoices.stripe_charge_id, and charge.refunded terminalizes through
    // that fallback, so the bounce restore must reach it too.
    if (pMeta.invoice_id) {
      linkedInvoice = await db('invoices').where({ id: pMeta.invoice_id }).first('id', 'invoice_number', 'scheduled_service_id', 'service_record_id', 'updated_at');
    }
    if (!linkedInvoice && piId) {
      linkedInvoice = await db('invoices').where({ stripe_payment_intent_id: piId }).first('id', 'invoice_number', 'scheduled_service_id', 'service_record_id', 'updated_at');
    }
    const linkChargeId = chargeId || payment.stripe_charge_id || null;
    if (!linkedInvoice && linkChargeId) {
      linkedInvoice = await db('invoices').where({ stripe_charge_id: linkChargeId }).first('id', 'invoice_number', 'scheduled_service_id', 'service_record_id', 'updated_at');
    }
    if (linkedInvoice) {
      // Visit scope for the mint lock + replacement scan below. A legacy
      // invoice may carry only service_record_id (pre-push P0 round) — its
      // service record still points at the scheduled visit, and the mint
      // lock keys on THAT id, so resolve it here or the restore/scan runs
      // unserialized against a completion mint.
      replacementScopeSsId = linkedInvoice.scheduled_service_id || null;
      if (!replacementScopeSsId && linkedInvoice.service_record_id) {
        replacementScopeSsId = (await db('service_records')
          .where({ id: linkedInvoice.service_record_id })
          .first('scheduled_service_id'))?.scheduled_service_id || null;
      }
      cancelledPrepayTermId = (await db('annual_prepay_terms')
        .where({ prepay_invoice_id: linkedInvoice.id, status: 'cancelled' })
        .first('id'))?.id || null;
    }
  } catch (err) {
    logger.warn(`[stripe-webhook] refund-failed invoice/term lookup failed: ${err.message}`);
  }

  // Fee-lane rows unwind UNDER the fee PI advisory lock (Codex #3153 r24
  // P1): settlement holds that lock while adopting marker values from a
  // plain (non-FOR UPDATE) read — without the same lock here, the unwind
  // can commit between settlement's read and write, and the stale adopted
  // values would resurrect the bounced refund amount and stamped id while
  // dropping failed_refund_ids. Lane from the row's own purpose metadata
  // first; pointer fallback fails CLOSED (throw → Stripe retries).
  let feeUnwindLockKey = null;
  const feeLockPiId = piId || payment.stripe_payment_intent_id || null;
  if (feeLockPiId) {
    let rowPurpose = null;
    try {
      const pm = payment.metadata ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata) : {};
      rowPurpose = pm?.purpose || null;
    } catch { rowPurpose = null; }
    if (rowPurpose === 'appointment_card_no_show_fee') {
      feeUnwindLockKey = `appointment_card_no_show_fee:${feeLockPiId}`;
    } else {
      try {
        const feePtr = await db('appointment_card_requests')
          .where({ no_show_payment_intent_id: feeLockPiId })
          .first('id');
        if (feePtr) feeUnwindLockKey = `appointment_card_no_show_fee:${feeLockPiId}`;
      } catch (detectErr) {
        logger.error(`[stripe-webhook] fee-lane detection for refund unwind ${refundId} errored — retrying event: ${detectErr.message}`);
        throw detectErr;
      }
    }
  }

  let restoredInvoiceId = null;
  let voidedReplacementsCommitted = [];
  await db.transaction(async (trx) => {
    if (feeUnwindLockKey) {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [feeUnwindLockKey]);
    }
    // Serialize with every scheduled-service invoice writer on the shared
    // ['schedule.invoice.mint', svc.id] advisory lock (codex #3456 pre-push
    // P0): the restore + replacement scan below must not interleave with a
    // completion mint. Held here, the completion either committed its
    // replacement BEFORE this trx (the scan sees it) or wakes under the
    // lock AFTER the restore and adopts the now-'paid' original through
    // findAdoptableScheduledInvoice instead of minting a duplicate. Taken
    // before the payments row lock, same slot as the fee-lane advisory lock.
    if (replacementScopeSsId) {
      await require('../services/scheduled-invoice-mint').acquireScheduledInvoiceMintLock(trx, replacementScopeSsId);
    }
    const row = await trx('payments').where({ id: payment.id }).forUpdate().first();
    if (!row) return;
    let meta = {};
    try {
      meta = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {};
    } catch { meta = {}; }
    // Replay fence: refund.failed and charge.refund.updated both fire for
    // one bounce (plus Stripe retries) — a bounce already recorded changed
    // nothing, so it must neither re-subtract nor re-notify (the first run
    // committed the notification atomically with this fence).
    const failedIds = Array.isArray(meta.failed_refund_ids) ? meta.failed_refund_ids : [];
    if (refundId && failedIds.includes(refundId)) return;
    const stampedIds = Array.isArray(meta.stamped_refund_ids) ? meta.stamped_refund_ids : [];
    const nextMeta = {
      ...meta,
      failed_refund_ids: refundId ? [...failedIds, refundId] : failedIds,
      // A bounced refund is no longer counted in refund_amount — drop it
      // from the stamped record too.
      ...(refundId && stampedIds.includes(refundId)
        ? { stamped_refund_ids: stampedIds.filter((id) => id !== refundId) }
        : {}),
    };

    // Only a refund that was actually STAMPED into this row may rewind the
    // cumulative amounts. stamped_refund_ids records EVERY refund whose
    // amount entered refund_amount (stripe_refund_id alone only remembers
    // the newest — a $40 partial overwritten by a later $20 stamp must still
    // be rewindable when the $40 bounces); the stripe_refund_id check keeps
    // legacy rows stamped before that record existed working. A bounce we
    // can't attribute is only RECORDED — subtracting it would erase EARLIER
    // cleared refunds. The recorded id makes handleChargeRefunded skip the
    // late creation stamp, and the notification flags the manual case.
    const wasStamped = !!refundId
      && (row.stripe_refund_id === refundId || stampedIds.includes(refundId));
    if (!wasStamped) {
      await trx('payments').where({ id: row.id }).update({ metadata: JSON.stringify(nextMeta) });
      await insertBounceNotification(trx, `Payment row ${row.id}: the bounce arrived before (or without) its creation stamp — amounts were left untouched and the late charge.refunded event will be skipped. If this refund was already recorded under an earlier stamp, reconcile refund_amount manually.`);
      return;
    }

    const priorRefundCents = Math.round((parseFloat(row.refund_amount) || 0) * 100);
    const nextRefundCents = Math.max(0, priorRefundCents - failedCents);
    const rowPaidCents = Math.round((parseFloat(row.amount) || 0) * 100);
    // Rewind the cumulative surcharge-returned tracker to match the new
    // refunded total (rs = R·S/(B+S), the inverse of the gross-up split) —
    // leaving it stale would make StripeService.refund treat the bounced
    // share as already returned and under-refund the retry. min() with the
    // current value: a bounce only ever REMOVES returned surcharge, and a
    // legacy row whose refunds were never grossed keeps its 0.
    const surchargeCents = Math.max(0, Number(row.surcharge_amount_cents) || 0);
    const currentReturnedSurcharge = Math.max(0, Number(row.refunded_surcharge_cents) || 0);
    const surchargeRewind = surchargeCents > 0 && rowPaidCents > 0 && currentReturnedSurcharge > 0
      ? {
          refunded_surcharge_cents: Math.min(
            currentReturnedSurcharge,
            Math.round((nextRefundCents * surchargeCents) / rowPaidCents),
          ),
        }
      : {};
    await trx('payments').where({ id: row.id }).update({
      ...surchargeRewind,
      refund_amount: nextRefundCents / 100,
      // A surviving remainder means an EARLIER partial did clear; when the
      // bounce erased the whole refund, CLEAR the status — consumers treat
      // any non-null refund_status as refund activity (Customer360 hides the
      // Refund button on !!refund_status; prepay reconciliation skips rows
      // with one), and a fully-bounced refund must leave the row refundable.
      // failed_refund_ids in metadata stays as the durable record.
      refund_status: nextRefundCents > 0 ? 'partial' : null,
      // The row's "current refund" pointer must never name money Stripe
      // kept: cleared outright when the bounce erased the whole refund, and
      // when an earlier partial survives, repointed at the newest surviving
      // stamped id (or cleared for legacy rows with no stamped record).
      ...(nextRefundCents === 0
        ? { stripe_refund_id: null }
        : (row.stripe_refund_id === refundId
          ? { stripe_refund_id: stampedIds.filter((id) => id !== refundId).pop() || null }
          : {})),
      // A row terminalized to 'refunded' by a refund that never fully
      // cleared is still (at least partly) collected money — anything
      // short of the full paid amount reverts to 'paid', matching the
      // charge.refunded handler's full-vs-partial convention (and the
      // dashboard's full-refund exclusion).
      ...(row.status === 'refunded' && nextRefundCents < rowPaidCents ? { status: 'paid' } : {}),
      metadata: JSON.stringify(nextMeta),
    });

    // Restore the linked invoice: a full refund terminalized it to
    // 'refunded' (returnAppliedCreditOnRefund) — with the money kept by
    // Stripe that status is now false on every customer/admin surface.
    // Status-only and mechanical (collected money is a fact); the CREDIT
    // side of that settle stays a human decision below. The decision rides
    // the conditional WHERE alone — NOT a pre-trx status read: this trx can
    // wait on the payments lock while the racing charge.refunded commits
    // the very flip to 'refunded', and a stale pre-lock 'paid' would skip
    // the restore entirely.
    let invoiceRestored = null;
    // Cutoff for the replacement scan: the ORIGINAL's updated_at as locked
    // inside this trx while it is still 'refunded' — i.e. the moment
    // charge.refunded terminalized it. The pre-trx linkedInvoice.updated_at
    // is NOT usable (pre-push P0 round): this trx can wait on the payments
    // lock while charge.refunded commits the flip, so the pre-lock value
    // predates the refund and would let the scan void a legitimate older
    // sibling invoice. Null cutoff = no scan (fail closed, alert only).
    let replacementCutoff = null;
    let originalTotalCents = null;
    if (linkedInvoice && nextRefundCents < rowPaidCents) {
      const lockedOriginal = await trx('invoices')
        .where({ id: linkedInvoice.id })
        .forUpdate()
        .first('id', 'status', 'updated_at', 'scheduled_service_id', 'total');
      if (lockedOriginal?.status === 'refunded' && lockedOriginal.updated_at) {
        replacementCutoff = lockedOriginal.updated_at;
        originalTotalCents = Math.round((parseFloat(lockedOriginal.total) || 0) * 100);
      }
      const flipped = await trx('invoices')
        .where({ id: linkedInvoice.id, status: 'refunded' })
        // paid_at restored with the status (codex r11 P1, same reasoning
        // as the combined unwind): AR and overdue alerts key on
        // paid_at IS NULL, so a status-only restore keeps the invoice on
        // every outstanding-balance surface.
        .update({
          status: 'paid',
          paid_at: nextMeta.settled_event_at || new Date().toISOString(),
          updated_at: new Date(),
          // Backfill the visit link on a legacy service_record-only invoice
          // so a completion mint waking under the mint lock can ADOPT the
          // restored row (findAdoptableScheduledInvoice keys on
          // scheduled_service_id) instead of minting a duplicate.
          ...(replacementScopeSsId && lockedOriginal && !lockedOriginal.scheduled_service_id
            ? { scheduled_service_id: replacementScopeSsId }
            : {}),
        });
      if (flipped > 0) {
        invoiceRestored = linkedInvoice.invoice_number || linkedInvoice.id;
        restoredInvoiceId = linkedInvoice.id;
      }
    }

    // Replacement invoices (codex #3456 P1): a completion that landed
    // between charge.refunded (invoice → 'refunded') and this bounce no
    // longer reuses the refunded row (completionSuppressorInvoiceLookup)
    // and minted a fresh invoice for the same visit. With the original
    // restored above, that replacement is a second bill for money Stripe
    // kept — void it here, in the same trx as the restore, so no window
    // exists where the visit carries a paid AND a collectible invoice. Same
    // conditional-WHERE convention as the restore: status pinned in the
    // UPDATE, never a pre-trx read. Fail CLOSED on anything money- or
    // ledger-bearing (pre-push P0 round): a replacement that is paid/prepaid,
    // has payment_recorded_at, carries a live stripe_payment_intent_id
    // (money may be in flight — the PI triage in
    // voidOpenInvoicesForCancelledService is a Stripe round-trip that does
    // not belong inside this webhook trx), sits on a payer statement, or
    // holds applied account/deposit credit is NEVER auto-voided here — it
    // is named in the notification for a human to void through
    // InvoiceService (which restores the ledgers) or refund. Only a bare
    // collectible row — nothing to restore — takes the status-only void,
    // which is exactly what the shared void primitive would do for it.
    const voidedReplacements = [];
    const collectedReplacements = [];
    const reviewReplacements = [];
    // Scan only under the mint lock (replacementScopeSsId resolved) and with
    // an in-trx cutoff — either missing means the scan cannot be made safe,
    // so it is skipped and the human reconciles from the alert.
    if (restoredInvoiceId && replacementScopeSsId && replacementCutoff) {
      const InvoiceService = require('../services/invoice');
      const { CANCELLED_SERVICE_VOIDABLE_STATUSES } = InvoiceService;
      const replacementQuery = trx('invoices')
        .whereNot({ id: linkedInvoice.id })
        .where((qb) => {
          qb.orWhere({ scheduled_service_id: replacementScopeSsId });
          if (linkedInvoice.service_record_id) qb.orWhere({ service_record_id: linkedInvoice.service_record_id });
        })
        .whereNotIn('status', ['void', 'refunded', 'canceled', 'cancelled'])
        // Only rows minted AFTER the refund flipped the original — an older
        // sibling invoice on the same visit is not a replacement for this
        // refund.
        .where('created_at', '>', replacementCutoff);
      const replacements = await replacementQuery.select(
        'id', 'invoice_number', 'status', 'payment_recorded_at', 'stripe_payment_intent_id',
        'payer_statement_id', 'credit_applied', 'line_items', 'total',
      );
      for (const rep of replacements || []) {
        const repLabel = rep.invoice_number || rep.id;
        // Replacement identity (pre-push P0 round 3): one visit may carry
        // unrelated live invoices (add-ons, adjustments — invoice.js's
        // switch-restore classification relies on it). Only a same-visit
        // invoice minted after the refund AT THE ORIGINAL'S TOTAL is the
        // completion's re-bill of the same money; anything else is left
        // alone and surfaced for review, never voided.
        const repTotalCents = Math.round((parseFloat(rep.total) || 0) * 100);
        if (originalTotalCents === null || repTotalCents !== originalTotalCents) {
          reviewReplacements.push(repLabel);
          continue;
        }
        const moneyApplied = ['paid', 'prepaid'].includes(rep.status) || !!rep.payment_recorded_at;
        const ledgerBound = !!rep.stripe_payment_intent_id
          || !!rep.payer_statement_id
          || (parseFloat(rep.credit_applied) || 0) > 0
          || InvoiceService._invoiceHasDepositCreditLine(rep);
        if (moneyApplied || ledgerBound || !CANCELLED_SERVICE_VOIDABLE_STATUSES.includes(rep.status)) {
          collectedReplacements.push(repLabel);
          continue;
        }
        // Canonical in-trx payments-ledger guard (same predicate as
        // voidInvoice / voidOpenInvoicesForCancelledService): payments
        // reference invoices via metadata.invoice_id, and a paid/processing
        // row can exist with neither payment_recorded_at nor a paid status.
        const appliedPayment = await trx('payments')
          .whereIn('status', ['paid', 'processing'])
          .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [String(rep.id)])
          .first('id');
        if (appliedPayment) {
          collectedReplacements.push(repLabel);
          continue;
        }
        const voided = await trx('invoices')
          .where({ id: rep.id, status: rep.status })
          .update({ status: 'void', updated_at: new Date() });
        if (voided > 0) voidedReplacements.push({ id: rep.id, label: repLabel });
        else collectedReplacements.push(repLabel);
      }
    }

    // Operator signal: the reverts above are mechanical, but the remaining
    // side effects of the optimistic refund are DELIBERATELY not
    // auto-reversed — account credit restored by returnAppliedCreditOnRefund
    // may already be spent (a mechanical claw-back could drive a balance
    // negative), a payer statement reopened by the cascade reversal may have
    // re-collection in flight, and the customer already got a "refund
    // issued" email. Name the exact records so the human reconciles
    // specifics.
    let sideEffectHint = '';
    if (invoiceRestored) sideEffectHint += ` Invoice ${invoiceRestored} was restored to paid; verify its restored account credit (may need to be re-applied/clawed back).`;
    if (voidedReplacements.length) sideEffectHint += ` Replacement invoice${voidedReplacements.length > 1 ? 's' : ''} ${voidedReplacements.map((r) => r.label).join(', ')} (minted by a completion after the refund) ${voidedReplacements.length > 1 ? 'were' : 'was'} voided — superseded: refund bounced, original invoice restored.`;
    if (reviewReplacements.length) sideEffectHint += ` Same-visit invoice${reviewReplacements.length > 1 ? 's' : ''} ${reviewReplacements.join(', ')} minted after the refund at a different total ${reviewReplacements.length > 1 ? 'were' : 'was'} left untouched — review whether it re-bills this visit.`;
    if (collectedReplacements.length) sideEffectHint += ` Replacement invoice${collectedReplacements.length > 1 ? 's' : ''} ${collectedReplacements.join(', ')} for the same visit ${collectedReplacements.length > 1 ? 'were' : 'was'} NOT auto-voided (collected, payment in flight, on a statement, or carrying applied credit) — DOUBLE PAYMENT risk: refund if collected, otherwise void it through the invoice void action so its credit/statement ledgers restore.`;
    else if (linkedInvoice) sideEffectHint += ` Check invoice ${linkedInvoice.invoice_number || linkedInvoice.id}: restored account credit may need to be re-applied/clawed back.`;
    if (cancelledPrepayTermId) sideEffectHint += ` Annual-prepay term ${cancelledPrepayTermId} was CANCELLED by the refund — the paid-sync is re-run, but refund-cancelled terms are not auto-revived (revival is dispute-marker-gated); if coverage stays cancelled, reactivate it manually.`;
    if (row.statement_id) sideEffectHint += ` Statement S-${row.statement_id} was reversed to owed at refund time — reconcile before it re-collects.`;
    await insertBounceNotification(trx, `Payment row ${row.id} was reverted to collected — a refund-issued email already went out to the customer.${sideEffectHint}`);
    voidedReplacementsCommitted = voidedReplacements;
  });

  // Post-commit: re-run the annual-prepay paid sync for a restored invoice —
  // no payment_intent.succeeded will ever fire for a bounce, so nothing else
  // re-syncs coverage. For a payment_pending term this reactivates it through
  // the sanctioned state machine; a refund-cancelled term stays cancelled
  // (revival is deliberately dispute-marker-gated — see the notification).
  if (restoredInvoiceId) {
    try {
      await require('../services/annual-prepay-renewals').syncTermForInvoicePayment(restoredInvoiceId);
    } catch (err) {
      logger.error(`[stripe-webhook] annual-prepay resync after refund bounce failed for invoice ${restoredInvoiceId}: ${err.message}`);
    }
  }
  // Post-commit, matching voidInvoice: a voided replacement must not keep
  // sending payment follow-ups.
  for (const rep of voidedReplacementsCommitted) {
    await require('../services/invoice-followups').stopSequence(rep.id, { reason: 'invoice_voided' })
      .catch((e) => logger.error(`[invoice-followups] stopSequence failed for voided replacement ${rep.id}: ${e.message}`));
  }

  // Appointment-fee pre-settlement refund marker whose refund BOUNCED
  // (Codex #3153 r18 P1): Stripe kept the fee, but the acknowledged
  // succeeded event will never retry — re-run idempotent settlement so the
  // retained fee gets its paid invoice + receipt (the settle transaction
  // adopts the unwound marker row).
  if (piId) {
    // NO catch around the re-settlement (Codex #3153 r19 P1): a failure
    // must propagate so Stripe retries — acknowledging would permanently
    // strand the retained fee without its paid invoice.
    const feeRow = await db('payments').where({ stripe_payment_intent_id: piId }).first('metadata');
    let feeMeta = {};
    try {
      feeMeta = feeRow && feeRow.metadata ? (typeof feeRow.metadata === 'string' ? JSON.parse(feeRow.metadata) : feeRow.metadata) : {};
    } catch { feeMeta = {}; }
    if (feeMeta.purpose === 'appointment_card_no_show_fee' && feeMeta.pre_settlement_refund === true && !feeMeta.invoice_id) {
      const { resettleAppointmentFeeFromPi } = require('../services/appointment-card-request');
      await resettleAppointmentFeeFromPi(piId);
    }
  }
}

/**
 * payment_method.detached — Remove from our DB
 */
async function handlePaymentMethodDetached(paymentMethod) {
  const pmId = paymentMethod.id;
  logger.info(`[stripe-webhook] Payment method detached: ${pmId}`);

  // Read the rows BEFORE deleting: an out-of-band detach (Stripe dashboard,
  // support tooling) previously left customers.autopay_enabled pointing at a
  // method row that no longer exists — the admin UI showed Auto Pay Active
  // while collection threw "No Stripe autopay payment method on file".
  //
  // The delete and the customer Auto Pay cleanup commit TOGETHER, and a
  // failure ESCAPES to the dispatcher (Codex #2853 r2 P1): the old shape
  // deleted first and swallowed cleanup errors, so a transient
  // customers-update failure acked the webhook with the row already gone —
  // the Stripe retry then found no payment_methods row, could never learn
  // which customer pointer to clear, and Auto Pay stayed falsely Active.
  // A rollback keeps the row, so the retry re-enters with intact state.
  const disabledCustomers = [];
  await db.transaction(async (trx) => {
    const rows = await trx('payment_methods')
      .where({ stripe_payment_method_id: pmId })
      .select('id', 'customer_id', 'is_default', 'autopay_enabled');

    const deleted = await trx('payment_methods')
      .where({ stripe_payment_method_id: pmId })
      .del();

    if (deleted > 0) {
      logger.info(`[stripe-webhook] Removed ${deleted} payment method(s) from DB: ${pmId}`);
    }

    for (const row of rows) {
      const cust = await trx('customers')
        .where({ id: row.customer_id })
        .first('autopay_enabled', 'autopay_payment_method_id');
      const wasInCharge = cust?.autopay_enabled
        && (cust.autopay_payment_method_id === row.id
          || (!cust.autopay_payment_method_id && row.is_default && row.autopay_enabled));
      if (!wasInCharge) continue;
      // Mirror removeCard's cleanup (_disableAutopayIfMethodRemoved):
      // disable honestly rather than silently promoting another method —
      // enrollment is consent-gated and never auto-picks a replacement.
      await trx('customers')
        .where({ id: row.customer_id })
        .update({ autopay_enabled: false, autopay_payment_method_id: null });
      // The opt-out EVENT commits with the opt-out STATE: autopay_log is
      // guard input for enrollConsentedMethod's opted_out_after_authorization
      // check, and a failed insert rolls the whole cleanup back — the
      // dispatcher 500s and Stripe retries into intact state.
      await require('../services/autopay-log').logAutopay(row.customer_id, 'autopay_disabled', {
        details: { source: 'payment_method_detached', payment_method_id: row.id, stripe_payment_method_id: pmId },
        db: trx,
        required: true,
      });
      disabledCustomers.push(row);
    }
  });

  for (const row of disabledCustomers) {
    logger.info(`[stripe-webhook] Auto Pay disabled for customer ${row.customer_id} — in-charge method ${row.id} detached out-of-band`);
  }
}

/**
 * setup_intent.succeeded — Log for auditing
 */
async function handleSetupIntentSucceeded(setupIntent) {
  // One-time card-on-file hold capture (dark until ONE_TIME_CARD_HOLD): record
  // the saved payment method onto the pending hold row so accept can be
  // satisfied even if the client never echoes the setupIntentId back.
  // Replay-safe; no-op when the intent isn't a card hold.
  if (setupIntent.metadata?.purpose === 'estimate_card_hold') {
    try {
      const CardHolds = require('../services/estimate-card-holds');
      await CardHolds.handleCardHoldSetupIntentSucceeded(setupIntent);
    } catch (err) {
      logger.error(`[stripe-webhook] card-hold SetupIntent handling failed: ${err.message}`);
    }
    return;
  }
  // "Secure your appointment" capture (appointment-card-request funnel,
  // dark until APPOINTMENT_CARD_REQUEST): durability backstop when the
  // customer finishes 3DS but the browser never posts /complete — Stripe
  // is the only durable signal, and without this the request stays pending
  // and the card is never saved/enrolled (Codex #2771). Idempotent with
  // the page path (only a pending row completes). Transient failures THROW
  // so Stripe's retry schedule re-runs it; permanent states (mismatch,
  // no-longer-needed visit, already completed) ack and drop.
  if (setupIntent.metadata?.purpose === 'appointment_card_request') {
    const AppointmentCardRequests = require('../services/appointment-card-request');
    const result = await AppointmentCardRequests.completeSecureCardCaptureFromWebhook(setupIntent);
    if (result?.code === 'completion_failed' || result?.code === 'completion_in_progress') {
      throw new Error(`appointment card capture ${setupIntent.id} ${result.code} — retry`);
    }
    return;
  }
  // Recurring card-on-file capture (dark until RECURRING_CARD_ON_FILE):
  // durability backstop for the accept path's awaited enrollment. The accept
  // handler normally enrolls inline; this re-runs the same idempotent
  // save → consent → enroll when the event lands AFTER the accept committed
  // (3DS redirect the browser never finished, or a crash between the accept
  // commit and the inline enrollment). A pre-accept delivery no-ops silently —
  // an abandoned capture must not enroll anything, and the accept path owns
  // the normal case. The exemption guards below are the ones that stay
  // authoritative POST-accept — payer-billed, invoice-mode, commercial
  // manual-billing, and a prepay conversion. (The accept-time resolver's
  // plan-member check is deliberately NOT reused: the accept itself converts
  // the customer into a plan member, so re-running it here would no-op the
  // backstop for exactly the signups it exists to heal.) Enrollment itself is
  // idempotent — an already-enrolled inline run skips as already_enrolled.
  if (setupIntent.metadata?.purpose === 'estimate_recurring_card' && setupIntent.payment_method) {
    const RecurringCards = require('../services/recurring-card-on-file');
    const estimate = await db('estimates').where({ id: setupIntent.metadata.estimate_id }).first();
    if (!estimate) return;
    // Kill switch stops NEW captures — it must not strand committed ones
    // (r4 P2): an accepted estimate already suppressed its pay link
    // expecting Auto Pay, so this durable recovery still enrolls even when
    // the flag is off. Flag-off + not-yet-accepted acks and drops (no
    // retry loop for a killed feature).
    if (!RecurringCards.isRecurringCardOnFileEnabled() && estimate.status !== 'accepted') return;
    // This event normally arrives BEFORE the accept commits (the customer
    // confirms the card, then clicks through the deposit + accept). Acking it
    // then would burn the only durable retry this capture has — a deploy/crash
    // between the accept commit and the awaited inline enrollment would leave
    // the plan accepted with no Auto Pay card and no alert (Codex #2668
    // round-4 P2). THROW instead: the dispatcher records the error and 500s,
    // Stripe retries on backoff, and the reclaim path re-runs this handler —
    // by then the estimate is accepted (enroll) or terminal (ack + drop).
    // Bounded noise: retries stop as soon as the estimate leaves the
    // still-acceptable state or Stripe's retry window ends; a normal signup
    // sees at most a couple of benign "awaiting accept" retries, and the
    // inline accept-path enrollment makes them no-op as already_enrolled.
    if (estimate.status !== 'accepted') {
      const { isEstimateAcceptActive } = require('./estimate-public');
      if (isEstimateAcceptActive(estimate)) {
        throw new Error(`recurring card capture for estimate ${estimate.id} is awaiting accept — retry later`);
      }
      return; // terminal estimate — abandoned capture, nothing to enroll
    }
    // The FINAL accepted lane wins (Codex #2668 round-2): one-time accepts,
    // invoice-mode, commercial manual billing, and the prepay lane never
    // enroll. A payment-pending prepay term deliberately keeps billing_mode
    // 'per_application' until the invoice is paid, so any prepay term sourced
    // from THIS estimate marks the lane, not just billing_mode. These are
    // PERMANENT skips (ack the event); UNCERTAIN lookups throw instead —
    // Stripe's retry is the durable path, and a soft skip here would silently
    // drop the backstop (round-4: resolveForInvoice is fail-soft by default,
    // and the payer must be checked against the ACCEPTED job's per-job scope,
    // not just the customer default).
    const { isCommercialAutoAcceptEstimate, findLinkedUpcomingAppointment } = require('./estimate-public');
    if (!estimate.customer_id
      || estimate.accepted_service_mode === 'one_time'
      || estimate.bill_by_invoice === true
      || isCommercialAutoAcceptEstimate(estimate)) {
      return;
    }
    const customer = await db('customers').where({ id: estimate.customer_id }).first('billing_mode');
    let prepayLane = customer?.billing_mode === 'annual_prepay';
    if (!prepayLane) {
      prepayLane = (await db.schema.hasTable('annual_prepay_terms'))
        && !!(await db('annual_prepay_terms').where({ source_estimate_id: estimate.id }).first('id'));
    }
    if (prepayLane) return;
    const PayerService = require('../services/payer');
    let appt = await findLinkedUpcomingAppointment(estimate).catch((err) => {
      throw new Error(`recurring-cof backstop: linked-appointment lookup failed (${err.message}) — retry`);
    });
    if (!appt?.id) {
      // This durable backstop can fire AFTER the accepted visit left the
      // upcoming pending/confirmed set (completed, rescheduled) — its row
      // can still carry the per-job payer_id that must scope the payer
      // check, or the homeowner's captured card could enroll on a
      // payer-billed job (Codex #2681 r5, parent-code finding). Newest
      // COMMITTED row for this estimate, any status; a lookup failure
      // rethrows so Stripe retries (fail closed, same as above).
      try {
        appt = await db('scheduled_services')
          .where({ source_estimate_id: estimate.id })
          .whereNotNull('customer_id')
          .whereNull('reservation_expires_at')
          .orderBy('scheduled_date', 'desc')
          .first('id');
      } catch (err) {
        throw new Error(`recurring-cof backstop: accepted-service lookup failed (${err.message}) — retry`);
      }
    }
    const payer = await PayerService.resolveForInvoice({
      customerId: estimate.customer_id,
      scheduledServiceId: appt?.id ? String(appt.id) : null,
      throwOnError: true,
    });
    if (payer?.payerId) return; // payer-billed — permanent skip
    const stripePmId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method.id;
    const enrollment = await RecurringCards.completeRecurringCardEnrollment({
      customerId: estimate.customer_id,
      stripePaymentMethodId: stripePmId,
      setupIntentId: setupIntent.id,
      estimateId: estimate.id,
    });
    // This handler can be the ONLY durable recovery path (crash after the
    // accept commit, browser never returned) — a TRANSIENT failure must
    // rethrow so the dispatcher 500s and Stripe retries the idempotent
    // enrollment (Codex #2680). Policy refusals (ownership mismatch,
    // ach_blocked) stay acked: retries can't change them and the office
    // alert already fired inside the enrollment routine.
    if (!enrollment.enrolled && enrollment.transient) {
      throw new Error(`recurring-cof webhook enrollment transient failure (${enrollment.reason}) — retry`);
    }
    return;
  }
  // Covered-by-credit capture (Codex #2507 P1 round-3): the SetupIntent the
  // pay page minted for a required-save, credit-covered invoice can finish
  // AFTER the browser is gone — a 3DS/bank-auth redirect that never returns,
  // or ACH micro-deposits verified days later. Complete the same save →
  // consent → enrollment the /setup-complete endpoint runs (all steps
  // idempotent; the endpoint and this handler may both fire). The capture
  // page rendered the LOCKED v8 consent before confirmSetup — this SI only
  // exists because the server required a method on file — so recording the
  // snapshot here (no IP/UA, like other server-side completions) is the
  // faithful record of what the customer agreed to.
  if (setupIntent.metadata?.purpose === 'covered_capture'
    && setupIntent.metadata?.waves_customer_id
    && setupIntent.payment_method) {
    const wavesCustomerId = setupIntent.metadata.waves_customer_id;
    const stripePmId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method.id;
    try {
      const StripeService = require('../services/stripe');
      const ConsentService = require('../services/payment-method-consents');
      let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePmId }).first();
      if (saved && saved.customer_id !== wavesCustomerId) {
        logger.warn(`[stripe-webhook] covered-capture pm ${stripePmId} belongs to ${saved.customer_id}, SI customer ${wavesCustomerId} — skipping`);
        return;
      }
      if (!saved) {
        saved = await StripeService.savePaymentMethod(wavesCustomerId, stripePmId, {
          enableAutopay: false,
          makeDefault: false,
        });
      }
      if (!(await ConsentService.hasConsentFor(wavesCustomerId, stripePmId))) {
        await ConsentService.recordConsent({
          customerId: wavesCustomerId,
          paymentMethodId: saved.id,
          stripePaymentMethodId: stripePmId,
          source: 'pay_page',
          methodType: saved.method_type || 'card',
        });
      }
      await ConsentService.linkPaymentMethodId(stripePmId, saved.id);
      const { enrollConsentedMethod } = require('../services/autopay-enrollment');
      // authorizedAt: this webhook can complete DAYS after the customer
      // authorized (browser died / micro-deposits) — an Auto Pay disable
      // recorded since then must win over the stale authorization.
      // Invoice visit scope for the in-lock payer check (#3395 r14 P1) —
      // invoice_id was stamped server-side at /capture-setup mint.
      let coveredScopeSsId = null;
      try {
        const scopeInvoiceId = setupIntent.metadata?.invoice_id || null;
        if (scopeInvoiceId) {
          const scopeInvoice = await db('invoices')
            .where({ id: scopeInvoiceId })
            .first('scheduled_service_id', 'customer_id');
          if (scopeInvoice && String(scopeInvoice.customer_id) === String(wavesCustomerId)) {
            coveredScopeSsId = scopeInvoice.scheduled_service_id || null;
          }
        }
      } catch (scopeErr) {
        logger.warn(`[stripe-webhook] covered-capture invoice scope lookup failed for SI ${setupIntent.id}: ${scopeErr.message}`);
      }
      const enrollment = await enrollConsentedMethod({
        customerId: wavesCustomerId,
        paymentMethodId: saved.id,
        source: 'save_card_consent',
        details: { via: 'covered_capture_webhook', setup_intent_id: setupIntent.id },
        authorizedAt: setupIntent.created ? new Date(setupIntent.created * 1000) : null,
        scheduledServiceId: coveredScopeSsId,
      });
      // Capture done → apply the HELD credit coverage (Codex #2507
      // round-7 P1): under the hold flow the invoice stayed collectible
      // until this point, and when the browser never returns this webhook
      // is the only place the settle can happen. Idempotent — a
      // setup-complete race or a pre-hold prepaid invoice skips inside.
      // invoice_id was stamped server-side at /capture-setup mint;
      // ownership double-checked against the SI's customer. A REFUSED
      // enrollment (ach_blocked — e.g. micro-deposits verified but a
      // separate ACH failure suspended the customer meanwhile) must NOT
      // settle (round-8 P2): the invoice stays collectible, the capture
      // state re-derives on the customer's next visit, and the next
      // /capture-setup mint is card-only. No rethrow — a webhook retry
      // can't change the bank state.
      const enrollmentOk = enrollment.enrolled || enrollment.reason === 'already_enrolled';
      if (!enrollmentOk) {
        logger.warn(`[stripe-webhook] covered-capture enrollment refused (${enrollment.reason}) for customer ${wavesCustomerId} pm ${stripePmId} — held coverage NOT settled`);
      }
      const capturedInvoiceId = setupIntent.metadata?.invoice_id || null;
      if (enrollmentOk && capturedInvoiceId) {
        const capturedInvoice = await db('invoices').where({ id: capturedInvoiceId }).first('id', 'customer_id');
        if (capturedInvoice && String(capturedInvoice.customer_id) === String(wavesCustomerId)) {
          const settle = await StripeService.settleHeldCoverage(capturedInvoice.id);
          if (!settle.settled && !settle.alreadySettled) {
            // Not an error — credit shrank mid-capture; the invoice simply
            // stays payable through the normal pay flow (reminders never
            // stopped). Retrying the webhook can't change that.
            logger.warn(`[stripe-webhook] covered-capture settle skipped for invoice ${capturedInvoice.id}: ${settle.reason}`);
          }
        }
      }
      logger.info(`[stripe-webhook] covered-capture completed for customer ${wavesCustomerId}: pm ${stripePmId}`);
    } catch (err) {
      // Re-throw so the dispatcher returns 500 and Stripe retries (Codex
      // #2507 round-5 P1): this webhook can be the ONLY completion path
      // (browser never returned after 3DS/bank auth, or micro-deposits
      // verified days later), and every step above is idempotent — a
      // swallowed transient error would leave a required-save signup
      // prepaid with nothing chargeable, permanently.
      logger.error(`[stripe-webhook] covered-capture completion failed for SI ${setupIntent.id} (Stripe will retry): ${err.message}`);
      throw err;
    }
    return;
  }
  // Portal add-method completion (portal ACH lane): for the micro-deposit
  // deferred save this webhook is the ONLY place enrollment can finish —
  // the customer's session ended days before verification cleared. For a
  // synchronously-completed save (card, or bank via Financial Connections)
  // it's a no-op re-run: every step is idempotent (lookup-first save,
  // hasConsentFor-guarded consent, already_enrolled enrollment).
  if (setupIntent.metadata?.purpose === 'portal_add_method'
    && setupIntent.metadata?.waves_customer_id
    && setupIntent.payment_method) {
    const wavesCustomerId = setupIntent.metadata.waves_customer_id;
    const stripePmId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method.id;
    try {
      const StripeService = require('../services/stripe');
      const ConsentService = require('../services/payment-method-consents');
      const gateOn = require('../config/feature-gates').isEnabled('portalAchAutopay');
      let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePmId }).first();
      if (saved && saved.customer_id !== wavesCustomerId) {
        logger.warn(`[stripe-webhook] portal-add-method pm ${stripePmId} belongs to ${saved.customer_id}, SI customer ${wavesCustomerId} — skipping`);
        return;
      }
      // Kill-switch integrity BEFORE any persistence (Codex r4): with the
      // gate off, the browser-died path must not save a bank row at all —
      // a persisted verified row would be selectable by the billing routes
      // even though the lane is closed. No local row means probing the PM
      // type from Stripe first; a local row carries its own method_type.
      if (!gateOn) {
        const bankAlready = isBankMethodType(saved?.method_type);
        const bankIncoming = !saved
          && (await StripeService.retrievePaymentMethod(stripePmId))?.type === 'us_bank_account';
        if (bankAlready || bankIncoming) {
          logger.info(`[stripe-webhook] portal-add-method bank pm ${stripePmId} skipped — GATE_PORTAL_ACH_AUTOPAY off`);
          return;
        }
      }
      if (!saved) {
        // Browser died between confirmSetup and POST /cards. The portal
        // add modal always renders the locked consent copy before confirm,
        // so a confirmed SI means the customer saw it — same rationale as
        // the covered_capture backstop above. requireAttached (Codex
        // #2706 r1): a customer who REMOVED the method before verification
        // detached it at Stripe (removeCard detaches + deletes the row) —
        // the backstop must never resurrect and enroll it.
        try {
          saved = await StripeService.savePaymentMethod(wavesCustomerId, stripePmId, {
            enableAutopay: false,
            makeDefault: false,
            requireAttached: true,
          });
        } catch (saveErr) {
          if (saveErr.code === 'PM_NOT_ATTACHED') {
            logger.info(`[stripe-webhook] portal-add-method pm ${stripePmId} no longer attached (customer removed it) — skipping backstop for ${wavesCustomerId}`);
            return;
          }
          throw saveErr;
        }
      }
      // Verification cleared — a pending bank row becomes chargeable.
      if (isBankMethodType(saved.method_type) && saved.ach_status !== 'verified') {
        await db('payment_methods').where({ id: saved.id }).update({ ach_status: 'verified' });
      }
      // A freshly VERIFIED bank clears a customer-level needs_verification
      // block (Codex r2): that state asks for exactly this proof, and
      // without clearing it the replacement bank stays unusable
      // (enrollConsentedMethod refuses ACH targets while the customer flag
      // is non-active). 'suspended' is deliberately NOT cleared here — it
      // was earned by repeated failed debits and keeps its organic exit (a
      // successful ACH payment clears it in the payment_intent.succeeded
      // handler). The failure LOG stays authoritative for escalation.
      if (isBankMethodType(saved.method_type)) {
        await db('customers')
          .where({ id: wavesCustomerId, ach_status: 'needs_verification' })
          .update({ ach_status: 'active' });
      }
      // Ensure an ENROLLMENT-SCOPED consent exists (Codex r2): the old
      // hasConsentFor guard suppressed the portal consent whenever ANY row
      // existed — a hold-scoped-only history (estimate_card_hold) passed
      // it, so the consent the customer just granted in the locked portal
      // modal was never written and enrollment silently skipped. Recording
      // is still suppressed when an enrollment-scoped consent already
      // exists (backstop re-runs stay deduped), and enrollment stays
      // consent-gated: the row below is the authority, never SI metadata
      // (Codex #2507 P1).
      if (!(await ConsentService.hasEnrollmentScopedConsent(wavesCustomerId, stripePmId))) {
        await ConsentService.recordConsent({
          customerId: wavesCustomerId,
          paymentMethodId: saved.id,
          stripePaymentMethodId: stripePmId,
          source: isBankMethodType(saved.method_type) ? 'portal_add_bank' : 'portal_add_card',
          methodType: saved.method_type || 'card',
        });
      }
      await ConsentService.linkPaymentMethodId(stripePmId, saved.id);
      // Payer routing BEFORE enrollment (Codex #3395 r9 P1) — same fence as
      // POST /billing-v2/cards: this webhook fires independently of the
      // browser POST (before or after it), so without its own check a payer
      // assigned mid-flow still got the homeowner's card enrolled through
      // this path. Payer-billed OR an unknowable payer picture (fail
      // closed) keeps the method saved with consent recorded, skips
      // enrollment, and parks a billing office exception — no rethrow,
      // matching this branch's existing webhook-retry doctrine.
      // A TRANSIENT lookup failure must RETHROW, not skip: returning here
      // marks the event processed, Stripe never retries, and — for hosted
      // redirects / micro-deposit verification, where this webhook is the
      // ONLY completion path — a self-pay customer's method stays
      // permanently unenrolled. Every step above is idempotent, so the
      // retry re-enters safely. Only a CONFIRMED payer-billed result
      // returns successfully (that skip is correct and permanent).
      const resolvedPayer = await require('../services/payer')
        .resolveForInvoice({ customerId: wavesCustomerId, throwOnError: true });
      if (resolvedPayer?.payerId) {
        await require('../services/notification-service').notifyAdmin(
          'billing',
          'Card saved without Auto Pay (payer-billed)',
          'A portal card save (webhook completion) skipped Auto Pay enrollment because this account’s invoices route to a third-party payer — enrolling the saved card would charge the wrong party on self-pay invoices.',
          { link: `/admin/customers/${wavesCustomerId}`, metadata: { customerId: wavesCustomerId, paymentMethodId: saved.id } },
        ).catch(() => {});
        return;
      }
      const { enrollConsentedMethod } = require('../services/autopay-enrollment');
      // authorizedAt: for the micro-deposit deferred save this webhook fires
      // days after the portal add — a customer who disabled Auto Pay in the
      // meantime must not be re-enrolled by the old authorization.
      const enrollment = await enrollConsentedMethod({
        customerId: wavesCustomerId,
        paymentMethodId: saved.id,
        source: isBankMethodType(saved.method_type) ? 'portal_add_bank' : 'portal_add_card',
        details: { via: 'portal_add_method_webhook', setup_intent_id: setupIntent.id },
        authorizedAt: setupIntent.created ? new Date(setupIntent.created * 1000) : null,
      });
      if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
        // No rethrow: a webhook retry can't change a refused bank state
        // (ach_blocked); the method stays saved and the customer can
        // enable Auto Pay from the portal once the state clears.
        logger.warn(`[stripe-webhook] portal-add-method enrollment refused (${enrollment.reason}) for customer ${wavesCustomerId} pm ${stripePmId}`);
      }
      logger.info(`[stripe-webhook] portal-add-method completed for customer ${wavesCustomerId}: pm ${stripePmId}`);
    } catch (err) {
      // Re-throw so Stripe retries: for the micro-deposit flow this event
      // is the only completion path, and every step above is idempotent.
      logger.error(`[stripe-webhook] portal-add-method completion failed for SI ${setupIntent.id} (Stripe will retry): ${err.message}`);
      throw err;
    }
    return;
  }
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
      await NotificationService.notifyAdmin(
        'payout',
        `Payout deposited: $${(payout.amount / 100).toFixed(2)}`,
        `Stripe payout of $${(payout.amount / 100).toFixed(2)} has been deposited to your Capital One account.`,
        { icon: '\uD83C\uDFE6', link: '/admin/banking' },
      );
    }

    if (eventType === 'payout.failed') {
      await NotificationService.notifyAdmin(
        'payout',
        `Payout FAILED: $${(payout.amount / 100).toFixed(2)}`,
        `Payout failed: ${payout.failure_message || 'Unknown reason'}. Check your bank details.`,
        // bell: a failed payout is a money failure, not a payout FYI \u2014 it
        // must ring even though the payout category is silenced by default.
        { icon: '\u26A0\uFE0F', link: '/admin/banking', bell: true },
      );
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
async function handleAchFailure(paymentIntent, failureReason, eventId = null) {
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

    // Consent-scoped fallback candidate for the >=3-failure escalation
    // below (Codex #2822 P1): repointing Auto Pay may only select a card
    // the customer authorized for recurring billing.
    // findConsentedChargeableCard is the repo's single authority for
    // that (v8+ consent copy; hold-only sources like estimate_card_hold
    // excluded; a prior Auto Pay opt-out honored) — selecting by
    // method_type alone promoted limited-purpose cards (estimate card
    // holds) into Auto Pay without enrollment consent. Resolved BEFORE
    // the escalation transaction: consent rows are immutable and
    // autopay_log is append-only, so the pre-trx read cannot go stale in
    // a way that matters, and the helper's own db reads never acquire a
    // second pool connection while the advisory-lock trx holds one.
    // Lookup errors bubble (the helper's contract) into the outer catch
    // → webhook 500 → redelivery: a transient DB error fails closed,
    // never reads as "no consent".
    const { findConsentedChargeableCard } = require('../services/payment-method-consents');
    const fallbackCard = await findConsentedChargeableCard(customer.id);

    // Insert + count + state-update wrapped in one transaction with a
    // per-customer advisory lock. Two concurrent ACH failures (e.g.,
    // an autopay charge and a one-off invoice failing within seconds
    // of each other) used to both insert into ach_failure_log, both
    // run a separate count, and could both see the same recentFailures
    // value — escalating twice or skipping a step. Same advisory-lock
    // pattern as the terminal handoff mint serialization.
    let recentFailures = 0;
    let achReplay = false;
    await db.transaction(async (trx) => {
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['ach.escalation', String(customer.id)],
      );

      try {
        // Idempotent under webhook re-runs (the file's handler contract): a
        // RETRY of the same failure event must not log a second row —
        // duplicates double-count one real failure and can escalate straight
        // to needs_verification/suspended. Dedupe on the EVENT identity, not
        // the PI alone: the same invoice/PI is legitimately re-attempted
        // (see handlePaymentIntentProcessing's same-PI reattempt note) and
        // each real bank failure carries a distinct event id that MUST
        // count. Check-then-insert is race-safe under the advisory lock.
        // Legacy fallback (no eventId / pre-migration column): PI-level
        // dedupe, the pre-existing conservative behavior.
        // Column probe (NOT try/insert-catch: a failed statement aborts the
        // whole Postgres transaction, poisoning the count/status queries
        // below). columnInfo is the repo's pre-migration-tolerance pattern.
        const achCols = await trx('ach_failure_log').columnInfo();
        const hasEventCol = !!achCols.stripe_event_id;
        const dedupe = { customer_id: customer.id, stripe_payment_intent_id: piId };
        const alreadyLogged = await trx('ach_failure_log')
          .where(eventId && hasEventCol ? { ...dedupe, stripe_event_id: eventId } : dedupe)
          .first('id');
        if (alreadyLogged) achReplay = true;
        if (!alreadyLogged) {
          const insertRow = {
            customer_id: customer.id,
            stripe_payment_intent_id: piId,
            failure_reason: failureReason,
          };
          await trx('ach_failure_log').insert(
            eventId && hasEventCol ? { ...insertRow, stripe_event_id: eventId } : insertRow,
          );
        }
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
          if (fallbackCard) {
            // Complete flag flip, mirroring the portal's autopay-method
            // mirror (customer-autopay PUT): the chargeable-method
            // predicate requires BOTH is_default AND autopay_enabled on
            // one row, so flipping is_default alone left the customer
            // with NO chargeable method — every later collection threw
            // 'No Stripe autopay payment method on file'. Clear both
            // flags on the non-selected rows, set both on the card, and
            // repoint the customer-level autopay method at the card so
            // portal/admin surfaces agree with what will be charged.
            await trx('payment_methods')
              .where({ customer_id: customer.id })
              .update({ is_default: false, autopay_enabled: false });
            // The card was resolved OUTSIDE this transaction — if it was
            // removed in between, this customer-scoped flip hits 0 rows,
            // and repointing the customer at the dead id would leave
            // autopay armed with no chargeable row: the retry sweep then
            // final-fails 'No Stripe autopay payment method on file'
            // instead of parking. 0 rows → the same disarm as no-fallback
            // (all method flags are already cleared above).
            const flipped = await trx('payment_methods')
              .where({ id: fallbackCard.id, customer_id: customer.id })
              .update({ is_default: true, autopay_enabled: true });
            if (flipped > 0) {
              await trx('customers')
                .where({ id: customer.id })
                .update({ autopay_payment_method_id: fallbackCard.id });
            } else {
              await trx('customers')
                .where({ id: customer.id })
                .update({ autopay_enabled: false });
              logger.warn(`[stripe-webhook] fallback card ${fallbackCard.id} vanished before promotion for customer ${customer.id} — autopay disarmed, balance parked for manual follow-up`);
            }
          } else {
            // No enrollment-consented card → DISARM, not just log: the
            // failed payment row is already armed for the retry sweep, and
            // processPaymentRetries() only stops on
            // customers.autopay_enabled === false before stripe.charge()
            // selects any default+enabled method — leaving the suspended
            // bank's flags set meant the next sweep debited the same dead
            // account. Clearing the method-level autopay flags breaks the
            // chargeable predicate; clearing the customer-level switch
            // stops the sweep before it charges. is_default is left alone
            // (display state), and no autopay_log toggle is written — this
            // is a system suspension, not a customer opt-out, so a later
            // re-enroll with a fresh method stays legal.
            await trx('payment_methods')
              .where({ customer_id: customer.id })
              .update({ autopay_enabled: false });
            await trx('customers')
              .where({ id: customer.id })
              .update({ autopay_enabled: false });
            logger.warn(`[stripe-webhook] ACH suspended for customer ${customer.id} with no enrollment-consented fallback card — autopay disarmed, balance parked for manual follow-up`);
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

    // Replay (this failure was already counted): the status recompute above
    // is idempotent, but the customer SMS and the dunning-hold counter below
    // are NOT — a duplicate webhook delivery must not resend notices or
    // advance/release held follow-up sequences for a failure that already
    // did both. EXCEPTION: if the prior delivery's notice never became
    // durable (the send threw AND its quiet-hours enqueue failed, so the
    // handler 500'd and Stripe redelivered), no sms_log row exists for this
    // PI — a full skip would permanently lose the actionable notice, so
    // fall through to the SMS block only (the follow-up counters below
    // stay replay-skipped either way).
    let replaySkipFollowups = false;
    if (achReplay) {
      let noticeExists = true;
      try {
        // Two durable notice shapes: an immediate send leaves a
        // provider-accepted messaging_audit_log row (the canonical sender
        // persists the PI in its metadata); a quiet-hours hold leaves a
        // queued sms_log row. Either one means the customer's notice is
        // owned — only their joint absence proves the prior delivery lost
        // it. Fail closed to skip on a probe error (never double-text).
        // Scoped to THIS Stripe event when its id is known (codex r27): a
        // reusable PI fails repeatedly, and a PI-only probe would match an
        // EARLIER failure event's delivered notice — returning "owned" and
        // permanently losing the current escalation stage. Rows queued
        // before the event-id stamp existed match on PI alone (legacy).
        const probeAudit = db('messaging_audit_log')
          .where({ entry_point: 'stripe_webhook' })
          .whereNotNull('provider_message_id')
          .whereRaw("metadata->>'stripe_payment_intent_id' = ?", [String(piId)]);
        if (eventId) probeAudit.whereRaw("metadata->>'stripe_event_id' = ?", [String(eventId)]);
        const auditNotice = await probeAudit.first('id');
        let queuedNotice = null;
        if (!auditNotice) {
          const probeQueued = db('sms_log')
            .where({ direction: 'outbound' })
            .whereIn('status', ['queued', 'sent', 'delivered', 'scheduled', 'sending'])
            .whereRaw("metadata->>'stripe_payment_intent_id' = ?", [String(piId)]);
          if (eventId) probeQueued.whereRaw("metadata->>'stripe_event_id' = ?", [String(eventId)]);
          queuedNotice = await probeQueued.first('id');
        }
        noticeExists = !!(auditNotice || queuedNotice);
      } catch (probeErr) {
        logger.warn(`[stripe-webhook] ACH replay notice probe failed (skipping resend, fail closed): ${probeErr.message}`);
      }
      if (noticeExists) {
        logger.info(`[stripe-webhook] ACH failure replay for PI ${piId} — skipping SMS + follow-up side effects`);
        return;
      }
      replaySkipFollowups = true;
      logger.warn(`[stripe-webhook] ACH failure replay for PI ${piId} with NO durable notice — re-attempting the customer SMS only`);
    }

    // Send SMS outside the transaction so a slow provider call doesn't
    // hold the per-customer advisory lock against concurrent failures.
    try {
      if (customer.phone) {
        let body;
        let messageType;
        // Deep link into the portal's Billing tab (Codex #2822 P2). The
        // customer app has no /billing route — tab selection is
        // query-param driven (readPortalLocation reads ?tab=billing; a
        // bare path lands on Dashboard) — so this must use the
        // established /?tab=billing form, same as the billing email CTAs.
        const billingUrl = `${publicPortalUrl()}/?tab=billing`;
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
          // Event scoping for the replay notice-probe (codex r27) — a
          // reused PI's next failure event must not mistake THIS notice
          // for its own.
          ...(eventId ? { stripe_event_id: String(eventId) } : {}),
        });
        if (!smsResult.sent) {
          logger.warn(`[stripe-webhook] ACH failure SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
      }
    } catch (smsErr) {
      // A failed durable enqueue must fail the handler (Stripe redelivers;
      // the replay notice-probe re-attempts the SMS without re-counting).
      if (smsErr.code === 'BILLING_NOTICE_ENQUEUE_FAILED') throw smsErr;
      logger.error(`[stripe-webhook] ACH failure SMS failed: ${smsErr.message}`);
    }

    // Notify the per-invoice follow-up engine — increments autopay-hold counters
    // and releases sequences once the threshold is crossed. Skipped on the
    // notice-only replay path: the original delivery already counted this
    // failure, only its SMS was lost.
    if (!replaySkipFollowups) {
      try {
        await require('../services/invoice-followups').handleAutopayFailure(customer.id);
      } catch (e) {
        logger.error(`[invoice-followups] handleAutopayFailure failed: ${e.message}`);
      }
    }
  } catch (err) {
    // Rethrow so the router records the error and returns 500 — the event
    // stays unprocessed and Stripe redelivers. Swallowing here acked
    // events whose escalation transaction failed (including its
    // deliberate status-update rethrow), permanently dropping the
    // failure-count bump. Redelivery is safe: the router's event-id claim
    // dedupes, and the ach_failure_log event-id dedupe above makes the
    // recount and SMS side effects replay-proof. Genuinely non-critical
    // paths (SMS send, follow-up engine) keep their own inner catches and
    // never reach here.
    logger.error(`[stripe-webhook] ACH failure handler error: ${err.message}`);
    throw err;
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
/**
 * Combined full-balance ACH in flight: mark EVERY allocated invoice (and a
 * per-invoice ledger row) 'processing' via the shared settle, after the
 * same freshness + expected-amount guards as the single path — the
 * expected ACH amount is the ALLOCATION total (ACH is never surcharged).
 * The customer-facing "we got it" acknowledgment fires once, on the
 * anchor invoice, with the combined amount.
 */
async function handleCombinedPaymentIntentProcessing(paymentIntent, eventCreated = null, eventId = null) {
  const PayCombined = require('../services/pay-combined');
  const piId = paymentIntent.id;
  const isAch = isAchPaymentIntent(paymentIntent, paymentIntent.metadata?.selected_method_category);
  if (!isAch) {
    logger.info(`[stripe-webhook] Ignoring non-ACH combined processing event: ${piId}`);
    return;
  }
  const stripe = getStripe();
  // Fail CLOSED on a missing client (codex r35 P1 class): the freshness
  // and attempt-identity checks below are load-bearing — an unverified
  // processing event must not move money state.
  if (!stripe) {
    throw new Error(`Combined processing event for PI ${piId} cannot be freshness-checked (Stripe client unavailable); retry`);
  }
  {
    const currentIntent = await stripe.paymentIntents.retrieve(piId);
    if (currentIntent.status !== 'processing') {
      logger.info(`[stripe-webhook] Ignoring stale combined processing event for PI ${piId}; current status is ${currentIntent.status}`);
      return;
    }
    // Attempt-identity check (codex r22 P2): a retried reusable PI can be
    // 'processing' AGAIN when a delayed processing event from the PRIOR
    // attempt arrives — status alone accepts it, and the handler would run
    // the OLD event's immutable amount/allocation (acknowledging the old
    // total, settling the old sibling set). The live intent is the
    // authority: a mismatched allocation or amount marks this event stale;
    // the current attempt's own delivery carries the right snapshot.
    if (String(currentIntent.metadata?.combined_allocation || '') !== String(paymentIntent.metadata?.combined_allocation || '')
      || Number(currentIntent.amount) !== Number(paymentIntent.amount)) {
      logger.warn(`[stripe-webhook] Ignoring stale combined processing event for PI ${piId}: event allocation/amount differs from the live intent (retry superseded it)`);
      return;
    }
    // Same-balance retries keep allocation AND amount identical (codex r25
    // P2) — the ATTEMPT identity is the charge. A delayed prior-attempt
    // event would restore failed rows to 'processing' under the OLD charge
    // id, which the current attempt's event can then never repair. Fail
    // CLOSED when sameness can't be established — the live attempt's own
    // delivery carries a matching charge.
    const eventCharge = typeof paymentIntent.latest_charge === 'string'
      ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id || null;
    const liveCharge = typeof currentIntent.latest_charge === 'string'
      ? currentIntent.latest_charge : currentIntent.latest_charge?.id || null;
    if (!eventCharge || !liveCharge || eventCharge !== liveCharge) {
      logger.warn(`[stripe-webhook] Ignoring combined processing event for PI ${piId}: event charge ${eventCharge || 'unknown'} does not match the live intent's ${liveCharge || 'unknown'} (prior-attempt delivery or unestablishable identity)`);
      return;
    }
  }

  let allocation;
  try {
    allocation = PayCombined.parseCombinedAllocation(paymentIntent.metadata);
  } catch (err) {
    logger.error(`[stripe-webhook] Combined processing PI ${piId} has a malformed allocation: ${err.message}`);
    if (stripe) {
      try { await stripe.paymentIntents.cancel(piId); } catch (e) { logger.warn(`[stripe-webhook] could not cancel malformed combined PI ${piId}: ${e.message}`); }
    }
    throw new Error(`Combined processing PI ${piId} allocation malformed; retry after cancellation`);
  }

  const expectedCents = PayCombined.allocationTotalCents(allocation);
  const actualCents = Number(paymentIntent.amount || 0);
  if (actualCents !== expectedCents) {
    logger.error(`[stripe-webhook] Combined ACH processing amount mismatch on PI ${piId}. Expected ${expectedCents}c from allocation; got ${actualCents}c.`);
    if (stripe) {
      try { await stripe.paymentIntents.cancel(piId); } catch (cancelErr) { logger.warn(`[stripe-webhook] Could not cancel mismatched combined processing PI ${piId}: ${cancelErr.message}`); }
    }
    throw new Error(`Combined ACH processing PI ${piId} amount mismatch; retry after cancellation`);
  }

  try {
    await PayCombined.settleCombinedPaymentIntent(paymentIntent, {
      paymentMethod: 'us_bank_account',
      cardBrand: null,
      cardLastFour: null,
      receiptUrl: null,
    }, { eventCreated });
  } catch (err) {
    // Same terminal-fence handling as the succeeded handler (codex r17
    // P1): a refunded/disputed charge must not retry-loop the processing
    // event — the refund/dispute paths own the ledger from here.
    if (err.code === 'COMBINED_PI_ALREADY_REFUNDED' || err.code === 'COMBINED_PI_DISPUTED') {
      logger.warn(`[stripe-webhook] combined processing event for PI ${piId} skipped: ${err.message}`);
      return;
    }
    throw err;
  }

  const anchorInvoiceId = paymentIntent.metadata?.waves_invoice_id || allocation[0].invoiceId;

  // Stamp the SIBLING acknowledgment claims (codex r5 P1): every allocated
  // invoice just moved to 'processing' with this PI, but only the anchor's
  // claim is consumed by the combined-total notice below — a null sibling
  // claim would make sweepUnacknowledgedAchProcessingAcks send additional
  // per-invoice ACH acks after the customer already got the combined one.
  // If the anchor's notice fails, the sweep rescue runs through the ANCHOR
  // row (its claim is released/never taken), so stamping siblings first
  // loses nothing.
  const combinedSiblingIds = allocation
    .map((a) => a.invoiceId)
    .filter((id) => String(id) !== String(anchorInvoiceId));
  if (combinedSiblingIds.length) {
    await db('invoices')
      .whereIn('id', combinedSiblingIds)
      .where({ stripe_payment_intent_id: piId, status: 'processing' })
      .whereNull('ach_processing_notified_at')
      .update({ ach_processing_notified_at: new Date() });
  }

  setImmediate(() => {
    dispatchAchProcessingAcknowledgment({
      invoiceId: anchorInvoiceId,
      piId,
      amount: centsToDollars(actualCents),
      eventCreated,
      eventId,
    }).catch((err) => {
      logger.error(`[stripe-webhook] Combined ACH processing acknowledgment failed for PI ${piId}: ${err.message}`);
    });
  });
}

async function handlePaymentIntentProcessing(paymentIntent, eventCreated = null, eventId = null) {
  const piId = paymentIntent.id;
  logger.info(`[stripe-webhook] PaymentIntent processing (ACH in flight): ${piId}`);
  if (paymentIntent.metadata?.waves_statement_id) {
    await handleStatementPaymentIntentEvent(paymentIntent, 'processing');
    return;
  }
  // Combined full-balance PI: the single-invoice expected-amount check
  // below prices from ONE invoice's remainder and would cancel a valid
  // combined ACH debit — route to the allocation-aware path.
  {
    const PayCombined = require('../services/pay-combined');
    if (PayCombined.isCombinedPiMetadata(paymentIntent.metadata)) {
      await handleCombinedPaymentIntentProcessing(paymentIntent, eventCreated, eventId);
      return;
    }
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
    // Payer ownership survives the processing->paid flip (the flip only
    // jsonb_sets payment_state and settled_event_at), so the pause veto and
    // the auto-clear can exclude payer-funded ACH money too.
    ...(invoice?.payer_id ? { payer_id: invoice.payer_id } : {}),
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
    const matchingSavedCardAttempt = await findMatchingSavedCardAttempt(
      trx,
      lockedInvoice,
      paymentIntent,
      { lock: true },
    );
    if (activePi && activePi !== String(piId) && !matchingSavedCardAttempt) {
      logger.warn(
        `[stripe-webhook] Ignoring stale ACH processing PI ${piId} for invoice ${invoice.id}; ` +
        `active PI is ${activePi}`,
      );
      return;
    }

    if (matchingSavedCardAttempt?.status === 'claimed') {
      const {
        savedCardClaimIsStale,
        promoteStaleSavedCardClaim,
      } = require('../services/stripe');
      if (!savedCardClaimIsStale(matchingSavedCardAttempt)) {
        // The owner may still commit its invoice/payment transaction or its
        // rolled-back credit reservation. Retry instead of amount-checking an
        // intentionally incomplete local snapshot and canceling valid ACH.
        throw new Error(`Saved-card charge attempt ${matchingSavedCardAttempt.id} is still active; retry processing webhook`);
      }
      const promoted = await promoteStaleSavedCardClaim(matchingSavedCardAttempt, trx);
      if (!promoted) {
        throw new Error(`Saved-card charge attempt ${matchingSavedCardAttempt.id} changed during processing recovery; retry`);
      }
      matchingSavedCardAttempt.status = 'ambiguous';
    }

    let creditAdjustment = null;
    if (matchingSavedCardAttempt) {
      creditAdjustment = savedCardCreditAdjustment({
        attempt: matchingSavedCardAttempt,
        invoice: lockedInvoice,
      });
    }

    // Expected ACH amount prices from amount due (total − applied account credit).
    const expectedInvoice = creditAdjustment
      ? { ...lockedInvoice, credit_applied: creditAdjustment.target }
      : lockedInvoice;
    const expected = computeChargeAmount(invoiceAmountDue(expectedInvoice), 'us_bank_account');
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
      // Throw so the transaction rolls back any state already touched by this
      // event. A canceled PI is ignored on retry; a cancel failure remains
      // retryable instead of committing a mismatched credit reservation.
      throw new Error(`ACH processing PI ${piId} amount mismatch; retry after cancellation`);
    }

    if (creditAdjustment) {
      const { postCreditMovement } = require('../services/customer-credit');
      await postCreditMovement({
        customerId: lockedInvoice.customer_id,
        delta: -creditAdjustment.delta,
        source: 'adjustment',
        invoiceId: lockedInvoice.id,
        note: `Account credit consumed by processing saved-card attempt ${matchingSavedCardAttempt.id}`,
        createdBy: 'system:saved_card_reconciliation',
      }, trx);
      await trx('invoices').where({ id: lockedInvoice.id }).update({
        credit_applied: creditAdjustment.target,
        updated_at: trx.fn.now(),
      });
      lockedInvoice.credit_applied = creditAdjustment.target;
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
      if (!lockedInvoice?.customer_id) return;

      await trx('payments').insert({
        // Post-lock owner, never the pre-lock read — see the succeeded-PI
        // path above: a merge can repoint this invoice while we wait on its
        // FOR UPDATE, and `invoice` still names the old owner.
        customer_id: lockedInvoice.customer_id,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        payment_date: etDateString(),
        amount,
        base_amount_cents: Math.round(Number(paymentIntent.metadata?.base_amount || invoiceAmountDue(invoice)) * 100),
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

    const processingInvoiceUpdate = trx('invoices')
      .where({ id: lockedInvoice.id })
      .whereNotIn('status', INVOICE_TERMINAL_PAYMENT_STATUSES);
    if (!matchingSavedCardAttempt) {
      processingInvoiceUpdate.where(function activeProcessingIntentGuard() {
        this.whereNull('stripe_payment_intent_id')
          .orWhere({ stripe_payment_intent_id: piId });
      });
    }
    const invoiceRowsUpdated = await processingInvoiceUpdate.update({
        status: 'processing',
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        payment_method: isAch ? 'us_bank_account' : paymentIntent.payment_method_types?.[0] || null,
        // `amount` is the ACH cash (already reduced by applied credit); add the
        // row's credit_applied back IN SQL so total stays the real value — else the
        // succeeded handler recomputes amount due off the collapsed total.
        total: db.raw('ROUND((? + COALESCE(credit_applied, 0))::numeric, 2)', [amount]),
        // The unacknowledged-ack sweep ages candidates on updated_at; an
        // old invoice whose ACH began today must date from THIS
        // transition, or the 3-day ceiling silently excludes it and a
        // crash-lost acknowledgment never recovers.
        updated_at: new Date(),
      });
    if (!invoiceRowsUpdated) {
      throw new Error(`ACH processing PI ${piId} could not bind invoice ${lockedInvoice.id}; retry webhook`);
    }
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
  // the race (affected rows == 0) and bail. A failure to DELIVER after
  // the claim is deliberately not retried here — see the prior threads
  // on this PR for the trade-off rationale; the per-attempt clear in
  // handlePaymentIntentFailed handles the realistic re-attempt case.
  // One exception: a failed durable ENQUEUE of a window-held SMS
  // releases the claim (the rail row is the only durable form of the
  // notice once this handler acks) — see the worker's catch.
  // Channels run independently: missing phone skips SMS but email
  // still fires, and vice versa.
  //
  // Fire-and-forget via setImmediate so a Twilio/SendGrid hiccup
  // doesn't make Stripe retry the entire webhook (which would re-run
  // the amount-mismatch + status guards above).
  setImmediate(() => {
    dispatchAchProcessingAcknowledgment({ invoiceId: invoice.id, piId, amount, eventCreated, eventId })
      .catch((err) => {
        logger.error(`[stripe-webhook] ACH processing acknowledgment failed for PI ${piId}: ${err.message}`, { stack: err.stack });
      });
  });
}

// Detached worker behind the payment_intent.processing acknowledgment.
// Extracted (and exported for unit tests) so the claim/release semantics
// are testable without driving the full webhook handler; the setImmediate
// caller logs any rejection. `amount` is the ACH cash amount the handler
// validated above. `smsOnly` is the unacknowledged-ack sweep's mode: the
// inline run already attempted the email leg (it follows the SMS catch
// unconditionally, keyed on the Stripe event id), so a swept re-run must
// not repeat it under a different idempotency key.
async function dispatchAchProcessingAcknowledgment({ invoiceId, piId, amount, eventCreated, eventId, smsOnly = false }) {
  const freshInvoice = await db('invoices').where({ id: invoiceId }).first();
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
      if (smsErr.code === 'BILLING_NOTICE_ENQUEUE_FAILED') {
        // Unlike the sibling handlers, this runs inside a detached
        // setImmediate — the webhook is already acked, so a rethrow
        // lands in the outer catch below and the failure is swallowed
        // with the one-shot claim consumed and the email leg skipped.
        // Release the claim instead (guarded by PI + status so a
        // meanwhile-succeeded payment is untouched) and fall through to
        // the email leg now. The release alone creates no retry
        // obligation (the acked event's redelivery is discarded by the
        // processed-event dedupe) — the released NULL is durable state
        // that the 15-minute unacknowledged-ack sweep picks up and
        // re-runs SMS-only, so the acknowledgment survives even a
        // process restart. The failed-payment per-attempt clear remains
        // a second rescue when the payment later fails.
        try {
          await db('invoices')
            .where({ id: freshInvoice.id, stripe_payment_intent_id: piId, status: 'processing' })
            .whereNotNull('ach_processing_notified_at')
            .update({ ach_processing_notified_at: null });
          logger.error(`[stripe-webhook] ACH processing SMS enqueue failed for invoice ${freshInvoice.invoice_number} — claim released for re-attempt: ${smsErr.message}`);
        } catch (releaseErr) {
          logger.error(`[stripe-webhook] ACH processing SMS enqueue failed AND claim release failed for invoice ${freshInvoice.invoice_number} — needs manual follow-up (enqueue: ${smsErr.message}; release: ${releaseErr.message})`);
        }
      } else {
        logger.error(`[stripe-webhook] ACH processing SMS failed for invoice ${freshInvoice.invoice_number}: ${smsErr.message}`);
      }
    }
  }

  // Sweep mode stops here: the email leg already ran on the inline pass
  // (see the smsOnly note on the signature).
  if (smsOnly) return;

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
}

// Durable backstop for the detached ACH acknowledgment. The enqueue-
// failure release above cannot rely on Stripe for a retry (the event was
// acked, so redelivery is discarded by the processed-event dedupe before
// the worker runs again), and any in-process timer dies with a restart —
// but the released claim itself is durable state: status='processing' +
// ach_processing_notified_at NULL. This sweep (scheduler, every 15 min)
// re-runs the worker from that state. The age floor lets the inline
// setImmediate worker finish first; the 3-day ceiling matches the ACH
// decision window and keeps the sweep off legacy/stuck processing
// invoices that predate the acknowledgment claim (texting "we got your
// bank transfer" about a weeks-old anomaly would be wrong, not late).
// Re-claiming goes through the worker's own atomic UPDATE, so a webhook
// racing the sweep still yields at-most-once.
//
// Email leg: a NULL claim covers two histories — the enqueue-failure
// release (inline pass already attempted the email under the event-id
// idempotency key) and a worker that never ran at all (crash after the
// webhook ack; email-only customers got NOTHING). The durable
// email_messages ledger distinguishes them: any prior
// payment.ach_processing attempt for this invoice → SMS-only (a swept
// email under the (invoice, PI) fallback key would bypass the event-id
// dedupe and double-send); no prior attempt → run the email leg too.
// The probe fails CLOSED to SMS-only — never risk a duplicate email on
// an unreadable ledger.
async function sweepUnacknowledgedAchProcessingAcks({ limit = 25 } = {}) {
  const youngerThan = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const olderThan = new Date(Date.now() - 10 * 60 * 1000);
  const rows = await db('invoices')
    .where({ status: 'processing' })
    .whereNull('ach_processing_notified_at')
    .whereNull('payer_id')
    // The worker returns BEFORE claiming for these two guards — without
    // the mirrors here the sweep would re-find such rows every tick.
    .whereNotNull('customer_id')
    .whereNotNull('stripe_payment_intent_id')
    .where('updated_at', '>', youngerThan)
    .where('updated_at', '<', olderThan)
    .orderBy('updated_at', 'asc')
    .limit(limit)
    .select('id', 'stripe_payment_intent_id', 'invoice_number', 'total', 'credit_applied');
  const stripeClient = rows.length ? getStripe() : null;
  for (const row of rows) {
    // ACH-evidence gate: status='processing' + a PI is NOT proof of a bank
    // transfer — the saved-card ambiguity paths (admin-dispatch parked
    // charge, stripe-terminal) also park CARD invoices in 'processing'
    // with a PI and fresh updated_at, and after the 10-minute floor this
    // sweep would claim them and falsely tell the customer we received
    // their bank transfer. The PI record is the durable evidence: require
    // a bank-debit payment_method_type AND a still-processing PI. Fails
    // CLOSED (skip, retry next tick) when Stripe can't be read — never
    // acknowledge unverified.
    if (!stripeClient) {
      logger.warn('[stripe-webhook] ACH ack sweep: Stripe client unavailable — skipping this tick');
      break;
    }
    let pi = null;
    try {
      pi = await stripeClient.paymentIntents.retrieve(row.stripe_payment_intent_id);
    } catch (piErr) {
      logger.warn(`[stripe-webhook] ACH ack sweep could not read PI ${row.stripe_payment_intent_id} for invoice ${row.id}: ${piErr.message} — skipping (retry next tick)`);
      continue;
    }
    const methodTypes = pi?.payment_method_types || [];
    const isBankDebit = methodTypes.includes('us_bank_account') || methodTypes.includes('ach_debit');
    if (!isBankDebit || pi.status !== 'processing') {
      logger.info(`[stripe-webhook] ACH ack sweep skipping invoice ${row.invoice_number || row.id}: PI ${pi.id} is ${isBankDebit ? `status=${pi.status}` : `non-ACH (${methodTypes.join(',') || 'unknown'})`} — not an in-flight bank transfer`);
      continue;
    }
    // Combined full-balance PI (codex r5 P1): the notice is COMBINED-total,
    // dispatched once through the anchor. A swept SIBLING (missed the
    // handler's claim stamp — e.g. a pre-stamping deploy) is covered by the
    // anchor's notice: consume its claim without sending. A swept ANCHOR
    // re-acknowledges with the ALLOCATION total, not its own row's amount.
    let combinedAllocationForAck = null;
    try {
      combinedAllocationForAck = require('../services/pay-combined').parseCombinedAllocation(pi.metadata);
    } catch { combinedAllocationForAck = null; }
    if (combinedAllocationForAck) {
      const ackAnchorId = pi.metadata?.waves_invoice_id || combinedAllocationForAck[0].invoiceId;
      if (String(ackAnchorId) !== String(row.id)) {
        await db('invoices')
          .where({ id: row.id, stripe_payment_intent_id: row.stripe_payment_intent_id, status: 'processing' })
          .whereNull('ach_processing_notified_at')
          .update({ ach_processing_notified_at: new Date() });
        logger.info(`[stripe-webhook] ACH ack sweep: invoice ${row.invoice_number || row.id} is a combined sibling of PI ${pi.id} — claim stamped, anchor notice covers it`);
        continue;
      }
    }
    const priorEmailAttempt = await db('email_messages')
      .whereRaw('idempotency_key LIKE ?', [`payment.ach_processing:${row.id}:%`])
      .first('id')
      .catch(() => ({ id: 'probe-failed' }));
    // The processing transition restored `total` to the GROSS amount
    // (cash + applied credit) — subtract the credit back out so the
    // email states the actual bank transfer, never an overstated total
    // (sendAchProcessing's own fallback is the gross total).
    const cashAmount = combinedAllocationForAck
      ? require('../services/pay-combined').allocationTotalCents(combinedAllocationForAck) / 100
      : Math.round((Number(row.total || 0) - Number(row.credit_applied || 0)) * 100) / 100;
    logger.warn(`[stripe-webhook] ACH ack sweep re-running acknowledgment for invoice ${row.invoice_number || row.id} (claim was released or never taken; email ${priorEmailAttempt ? 'already attempted — SMS-only' : 'never attempted — both legs'})`);
    await dispatchAchProcessingAcknowledgment({
      invoiceId: row.id,
      piId: row.stripe_payment_intent_id,
      amount: cashAmount > 0 ? cashAmount : null,
      eventCreated: null,
      eventId: null,
      smsOnly: !!priorEmailAttempt,
    }).catch((err) => {
      logger.error(`[stripe-webhook] ACH ack sweep failed for invoice ${row.id}: ${err.message}`);
    });
  }
  return { candidates: rows.length };
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
    if (err.code === 'BILLING_NOTICE_ENQUEUE_FAILED') throw err;
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

  // PI canceled AFTER entering processing (codex r20 P2, a rare but
  // supported Stripe transition): the processing handler already moved
  // the stamped invoice(s) to 'processing' — without a revert they stay
  // non-collectible forever (excluded from dunning, blocked from a
  // replacement payment). Applies to the single-invoice ACH lane as much
  // as the combined lane (both stamp invoices.stripe_payment_intent_id).
  // Mirror the failure path's revert: reopen each stamped 'processing'
  // invoice, clear the dead PI binding and the ACH-ack claim so a retry
  // re-acknowledges. No customer notification — nothing was collected.
  const canceledStamped = await db('invoices')
    .where({ stripe_payment_intent_id: piId, status: 'processing' });
  for (const stampedRow of canceledStamped) {
    // A saved-card (admin_card_on_file) PI holds an unresolved
    // stripe_invoice_charge_attempts claim and may have reserved account
    // credit — the generic reopen below would leave that claim fencing
    // every later collection (assertNoInvoiceChargeReconciliationPending)
    // and strand the credit. Same release as the failure path: the
    // resolver reopens + unbinds the invoice itself.
    const canceledSavedCardAttempt = await findMatchingSavedCardAttempt(db, stampedRow, paymentIntent);
    if (canceledSavedCardAttempt) {
      const { resolveFailedInvoiceSavedCardChargeAttempt } = require('../services/stripe');
      const attemptResolved = await resolveFailedInvoiceSavedCardChargeAttempt({
        attemptId: canceledSavedCardAttempt.id,
        invoiceId: stampedRow.id,
        customerId: stampedRow.customer_id,
        stripePaymentIntentId: piId,
        failureMessage: 'PaymentIntent canceled before settling',
      });
      if (attemptResolved) {
        logger.info(`[stripe-webhook] Released saved-card attempt ${canceledSavedCardAttempt.id} for canceled PI ${piId}`);
        continue;
      }
    }
    // PI ownership in the predicate: a replacement PI rebinding this invoice
    // between the read and this write must not have its binding cleared.
    await db('invoices')
      .where({ id: stampedRow.id, status: 'processing', stripe_payment_intent_id: piId })
      .update({
        status: nextInvoiceStatusAfterFailedPayment(stampedRow),
        paid_at: null,
        stripe_payment_intent_id: null,
        stripe_charge_id: null,
        ach_processing_notified_at: null,
        updated_at: db.fn.now(),
      });
  }
  if (canceledStamped.length) {
    logger.warn(`[stripe-webhook] canceled PI ${piId} — reopened ${canceledStamped.length} invoice(s) from 'processing'`);
  }

  if (require('../services/pay-combined').isCombinedPiMetadata(paymentIntent.metadata)) {
    // Any remaining collectible stamps (not yet 'processing') unbind too.
    await require('../services/pay-combined').clearPaymentIntentStamps(db, piId);
    // Provisional processing-stage residuals resolve with the cancellation
    // (codex r27 P2) — the parked cash never arrived.
    const resolvedProvisional = await db('stripe_orphan_charges')
      .where({ resolved: false, source: 'combined_pay_processing' })
      .where('stripe_payment_intent_id', 'like', `${piId}:%`)
      .update({
        resolved: true,
        resolved_at: new Date(),
        resolution_notes: 'Automatically resolved: the combined intent was canceled before settling — the provisional residual cash never arrived',
      });
    if (resolvedProvisional > 0) logger.info(`[stripe-webhook] canceled combined PI ${piId} — resolved ${resolvedProvisional} provisional residual(s)`);
  }
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
async function reverseStatementCascadeForDispute(statementId, disputedPi, reason, { database = db } = {}) {
  const run = async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['payer.statement.money', String(statementId)]);
    const stmt = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
    if (!stmt) return;
    const piMatches = String(stmt.stripe_payment_intent_id || '') === String(disputedPi || '');
    const now = new Date();

    if (stmt.status === 'paid') {
      // Only reverse if the statement is STILL settled by the DISPUTED PI. Normal
      // flow: dispute.created on PI A reopens it, AP re-pays with PI B (or
      // offline), then a late closed(lost) for PI A lands — that replacement
      // settlement must NOT be undone (mirrors the invoice dispute guard).
      if (disputedPi && !piMatches) {
        logger.warn(`[stripe-webhook] statement S-${statementId} no longer settled by disputed PI ${disputedPi} (active ${stmt.stripe_payment_intent_id || 'none'}) — not reversing`);
        return;
      }
      const { priorPayableStatus } = require('../services/payer-statement-settle');
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
      logger.warn(`[stripe-webhook] statement S-${statementId} chargeback (${reason}) — reverted to owed; child invoices reopened`);
    } else if (disputedPi && piMatches) {
      // NOT yet settled, but the disputed PI is the statement's active PI — the
      // dispute raced ahead of payment_intent.succeeded. Clear the active PI so
      // the racing/late succeeded fails the active-PI binding and never settles
      // the clawed-back charge. ALSO reset a `processing` ACH statement back to
      // its prior payable status — a disputed in-flight payment is no longer
      // collecting, and leaving it `processing` with no PI would strand it (setup
      // / reconcile / the later failed|canceled revert would all refuse).
      const patch = { stripe_payment_intent_id: null, stripe_charge_id: null, updated_at: now };
      if (stmt.status === 'processing') {
        const { priorPayableStatus } = require('../services/payer-statement-settle');
        patch.status = priorPayableStatus(stmt);
      }
      await trx('payer_statements').where({ id: statementId }).update(patch);
      logger.warn(`[stripe-webhook] statement S-${statementId} dispute (${reason}) BEFORE settlement — ${patch.status ? `reset ${stmt.status}→${patch.status}, ` : ''}cleared active PI ${disputedPi} to block settle`);
    }
  };
  // Run in the caller's txn when given (so reversal + the durable disputed
  // payments-row upsert commit atomically); else open our own.
  return database === db ? db.transaction(run) : run(database);
}

async function restoreStatementCascadeForDispute(statementId, disputedPi) {
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['payer.statement.money', String(statementId)]);
    const stmt = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
    // Skip if already paid (re-collected after the reversal) or void.
    if (!stmt || stmt.status === 'paid' || stmt.status === 'void') return;
    // Skip if AP started a REPLACEMENT after dispute.created reopened it: an
    // in-flight payment (`processing`) or a different active PI must not be
    // overwritten by restoring the won-dispute PI — that would double-collect or
    // strand the replacement. Leave it for manual review.
    if (stmt.status === 'processing'
      || (stmt.stripe_payment_intent_id && String(stmt.stripe_payment_intent_id) !== String(disputedPi))) {
      logger.warn(`[stripe-webhook] statement S-${statementId} dispute won, but a replacement payment exists (status ${stmt.status}, PI ${stmt.stripe_payment_intent_id || 'none'}) — not auto-restoring`);
      return;
    }
    const now = new Date();
    await trx('payer_statements').where({ id: statementId })
      .update({ status: 'paid', paid_at: now, stripe_payment_intent_id: disputedPi || stmt.stripe_payment_intent_id || null, updated_at: now });
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

  // Appointment-card fee PI disputed BEFORE settlement (Codex #3153 r18
  // P1): the succeeded event may still be in flight — with no payments row
  // this handler would acknowledge into thin air while settlement later
  // books paid revenue for clawed-back money. Under the SAME advisory lock
  // settlement uses: re-check for the row (it may have landed in the
  // window — the normal path below then stamps it) and otherwise persist a
  // durable 'disputed' marker settlement's in-lock check respects. The fee
  // lane is identified LOCALLY by no_show_payment_intent_id.
  if (dispute.payment_intent) {
    // Lane identified from TRUSTED Stripe PI metadata (Codex #3153 r19
    // P1): the local no_show_payment_intent_id pointer is stamped
    // post-charge and can lag a fast dispute; a lookup failure here must
    // RETRY the event (throw), never read as "not the fee lane".
    const StripeService = require('../services/stripe');
    const disputedPi = await StripeService.retrievePaymentIntent(dispute.payment_intent);
    if (disputedPi?.metadata?.purpose === 'appointment_card_no_show_fee') {
      const feeReq = { customer_id: disputedPi.metadata?.waves_customer_id || null };
      // ONE locked transaction that branches on the row's presence UNDER
      // the lock (Codex #3153 r24 P1): settlement can insert the fee row
      // while we wait for the lock, and a pre-lock presence check would
      // send that row down the generic dispute path outside the fee lock —
      // where a racing won closure's dispute_final stamp could be erased
      // and its restored invoice re-opened. Existing-row handling keeps the
      // final-state re-read (r22 P1) and the invoice reopen semantics
      // (r23 P1); the missing-row branch writes the durable pre-settlement
      // marker. Fee PIs are fully handled here (return).
      const feeOutcome = await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${dispute.payment_intent}`]);
        const rowInLock = await trx('payments').where({ stripe_payment_intent_id: dispute.payment_intent }).first();
        if (!rowInLock) {
          await trx('payments').insert({
            customer_id: feeReq.customer_id || null,
            processor: 'stripe',
            payment_date: etDateString(),
            amount: (Number(dispute.amount) || 0) / 100,
            status: 'disputed',
            stripe_payment_intent_id: dispute.payment_intent,
            stripe_charge_id: chargeId,
            metadata: JSON.stringify({
              purpose: 'appointment_card_no_show_fee',
              pre_settlement_dispute: true,
              dispute_id: dispute.id,
            }),
          });
          return 'pre_settlement';
        }
        let meta = {};
        try {
          meta = rowInLock.metadata ? (typeof rowInLock.metadata === 'string' ? JSON.parse(rowInLock.metadata) : rowInLock.metadata) : {};
        } catch { meta = {}; }
        if (meta.dispute_final && meta.dispute_id === dispute.id) {
          logger.warn(`[stripe-webhook] fee dispute ${dispute.id} already closed (${meta.dispute_final}) — created event is a late replay, skipping`);
          return 'settled';
        }
        // Invoice binding captured BEFORE the reopen clears the PI (Codex
        // #3153 r23 P1) — dispute-closed(won) must still find it.
        const feeInvoice = await trx('invoices').where({ stripe_payment_intent_id: dispute.payment_intent }).first('id', 'status');
        await trx('payments').where({ id: rowInLock.id }).update({
          status: 'disputed',
          failure_reason: `Dispute: ${reason}`,
          metadata: JSON.stringify({
            ...meta,
            dispute_id: dispute.id,
            ...(feeInvoice?.id ? { dispute_invoice_id: feeInvoice.id } : {}),
          }),
        });
        // Reopen the fee invoice like the generic dispute path (r23 P1):
        // clear paid_at (reminders/alerts must not read it as paid) and
        // the PI/charge binding (a replacement payment must be mintable).
        if (feeInvoice && ['paid', 'processing'].includes(String(feeInvoice.status || '').toLowerCase())) {
          await trx('invoices').where({ id: feeInvoice.id }).update({
            status: 'overdue',
            paid_at: null,
            stripe_payment_intent_id: null,
            stripe_charge_id: null,
            updated_at: trx.fn.now(),
          });
        }
        return 'settled';
      });
      if (feeOutcome === 'pre_settlement') {
        logger.warn(`[stripe-webhook] appointment fee PI ${dispute.payment_intent} disputed before settlement — durable dispute marker written`);
      }
      // The standard dispute notification still fires (Codex #3153 r19
      // P1): the early return must not reduce a live dispute to a log
      // line — the office needs to submit evidence in time.
      try {
        await NotificationService.notifyAdmin(
          'dispute',
          `Dispute created: $${amount}`,
          `Dispute ${dispute.id} on charge ${chargeId} (${reason}) — a ${feeOutcome === 'pre_settlement' ? 'no-show fee was disputed before settlement' : 'settled no-show fee was disputed'}. Respond with evidence in the Stripe dashboard.`,
          { icon: '⚠️', link: '/admin/invoices' },
        );
      } catch { /* non-critical */ }
      return;
    }
  }

  // Statement disputes key on the PI, NOT the payments row: that row isn't created
  // until payment_intent.succeeded settles, and Stripe does not guarantee webhook
  // ordering. Resolve by PI so a dispute that races/precedes settlement still
  // reverses a settled cascade OR clears the active PI to block the later settle
  // of clawed-back money.
  if (dispute.payment_intent) {
    const disputedStmt = await db('payer_statements').where({ stripe_payment_intent_id: dispute.payment_intent }).first();
    if (disputedStmt) {
      // Late/retried created replay: if this dispute already CLOSED won (the
      // payments row carries dispute_final for it), the won-close restored the
      // active PI — reversing now would clear the PI + reopen children + undo
      // reinstated funds. Honor the recorded final outcome and skip. (Statement-
      // scoped; invoice disputes keep their own guard below.)
      const priorRow = await db('payments').where({ stripe_charge_id: chargeId }).first();
      let priorMeta = {};
      try { priorMeta = priorRow?.metadata ? (typeof priorRow.metadata === 'string' ? JSON.parse(priorRow.metadata) : priorRow.metadata) : {}; } catch (e) { /* legacy */ }
      if (priorMeta.dispute_final && priorMeta.dispute_id === dispute.id) {
        logger.warn(`[stripe-webhook] statement S-${disputedStmt.id} dispute ${dispute.id} already closed (${priorMeta.dispute_final}) — late created replay, skipping reversal`);
        return;
      }
      // ATOMIC: reverse/clear the statement AND upsert the durable disputed
      // payments row in ONE transaction. If the row write fails, the PI-clear
      // rolls back too, so the Stripe retry's PI lookup still finds the statement
      // (otherwise the event could be marked processed with the PI link gone and
      // no durable row for dispute.closed(won) to restore from).
      await db.transaction(async (trx) => {
        await reverseStatementCascadeForDispute(disputedStmt.id, dispute.payment_intent, `dispute.created (${reason})`, { database: trx });
        const existingRow = await trx('payments').where({ stripe_charge_id: chargeId }).first('id');
        if (existingRow) {
          await trx('payments').where({ id: existingRow.id }).update({ status: 'disputed', failure_reason: `Dispute: ${reason}` });
        } else {
          await trx('payments').insert({
            customer_id: null,
            payer_id: disputedStmt.payer_id,
            statement_id: disputedStmt.id,
            processor: 'stripe',
            stripe_payment_intent_id: dispute.payment_intent,
            stripe_charge_id: chargeId,
            payment_date: etDateString(),
            amount: Number(amount),
            status: 'disputed',
            failure_reason: `Dispute: ${reason}`,
            description: `Payer statement S-${disputedStmt.id} disputed charge (pre-settlement)`,
            metadata: JSON.stringify({ statement_id: disputedStmt.id, payer_id: disputedStmt.payer_id, source: 'statement_dispute' }),
          });
        }
      });
      try {
        await NotificationService.notifyAdmin(
          'dispute',
          `Statement dispute opened: $${amount}`,
          `Statement S-${disputedStmt.id} chargeback (${reason}). PI ${dispute.payment_intent}. Charge ${chargeId}.`,
          { icon: '⚠️', link: '/admin/payers' },
        );
      } catch (err) { logger.error(`[stripe-webhook] Statement dispute notification failed: ${err.message}`); }
      return;
    }
  }

  // Combined full-balance charge (payIncludeBalance): ONE charge backs a
  // payments row PER allocated invoice — a chargeback claws back the whole
  // charge, so EVERY row flips disputed and EVERY invoice it settled
  // reopens. The generic single-row path below would revert only .first().
  {
    const combinedRows = await db('payments').where({ stripe_charge_id: chargeId });
    const parseMeta = (row) => {
      try { return row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {}; } catch { return {}; }
    };
    if (combinedRows.length && combinedRows.some((r) => parseMeta(r).combined_payment)) {
      // PARTIAL dispute (codex r5 P1): Stripe can dispute part of a charge.
      // A charge-level partial cannot be attributed to a specific share
      // (same reasoning as the partial-refund branch) — reopening EVERY
      // invoice would make dunning chase the whole combined balance when
      // only dispute.amount was withdrawn. Park it for the operator and
      // touch nothing.
      // Canceled rows (neutralized pre-settlement markers) are excluded —
      // their amounts are zeroed, but the filter keeps the sum honest even
      // against legacy rows (codex r8 P1).
      let combinedFullCents = combinedRows
        .filter((r) => r.status !== 'canceled')
        .reduce((s, r) => s + Math.round(Number(r.amount || 0) * 100), 0);
      // The row sum UNDERCOUNTS when a share settled as a residual (no
      // payments row) — a partial dispute >= that reduced sum would then
      // misclassify as full-charge and wrongly reopen every recorded
      // invoice (codex r19 P1). The Stripe charge is the authority; fail
      // CLOSED on an unreadable charge (retry) rather than guess.
      {
        const disputeStripe = getStripe();
        // Fail CLOSED (codex r36 P2): the residual-reduced row sum must
        // never classify the dispute on its own.
        if (!disputeStripe) {
          throw new Error(`Dispute ${dispute.id}: charge ${chargeId} cannot be classified full-vs-partial (Stripe client unavailable); retry`);
        }
        {
          let liveCharge;
          try {
            liveCharge = await disputeStripe.charges.retrieve(chargeId);
          } catch (chargeErr) {
            throw new Error(`Dispute ${dispute.id}: charge ${chargeId} unreadable for full-vs-partial classification (${chargeErr.message}); retry`);
          }
          if (Number(liveCharge?.amount) > 0) combinedFullCents = Number(liveCharge.amount);
        }
      }
      if (Number(dispute.amount) < combinedFullCents) {
        logger.error(`[stripe-webhook] PARTIAL dispute ${dispute.id} ($${amount} of $${(combinedFullCents / 100).toFixed(2)}) on combined charge ${chargeId} — cannot attribute to a share; parked for operator`);
        await db('stripe_orphan_charges')
          .insert({
            // Keyed per DISPUTE (same reasoning as the per-refund partial
            // key): each partial dispute keeps its own reconciliation case.
            stripe_payment_intent_id: `${dispute.payment_intent || chargeId}:partial-dispute:${dispute.id}`,
            stripe_charge_id: chargeId,
            customer_id: combinedRows[0]?.customer_id || null,
            invoice_id: null,
            amount: Number(amount),
            source: 'combined_pay_webhook',
            original_db_error: `Partial dispute ${dispute.id} of $${amount} on a combined balance charge (${reason}) — attribute and reconcile manually`,
          })
          .onConflict('stripe_payment_intent_id')
          .ignore();
        try {
          await NotificationService.notifyAdmin(
            'dispute',
            `PARTIAL dispute on combined payment: $${amount}`,
            `Dispute ${dispute.id} withdrew $${amount} of a $${(combinedFullCents / 100).toFixed(2)} combined charge ${chargeId} (${reason}). Shares can't be auto-attributed — reconcile manually AND respond with evidence in the Stripe dashboard.`,
            { icon: '⚠️', link: '/admin/revenue' },
          );
        } catch (err) { logger.error(`[stripe-webhook] Combined partial-dispute notification failed: ${err.message}`); }
        return;
      }
      // Row stamps run under the shared per-PI serialization lock with a
      // FRESH in-lock re-read (codex r12 P1): a concurrent closed(won) can
      // otherwise stamp dispute_final + restore a row while this loop holds
      // a stale metadata snapshot — overwriting the final stamp and
      // reopening an invoice the won charge backs. Which invoices to reopen
      // is decided in-lock too; the reopen transactions themselves run
      // after commit (they only fire for rows this handler stamped).
      const disputeLockKey = String(dispute.payment_intent
        || combinedRows.find((r) => r.stripe_payment_intent_id)?.stripe_payment_intent_id
        || chargeId);
      const reopenPlan = [];
      let disputeAlreadyFinalized = false;
      await db.transaction(async (lockTrx) => {
        await lockTrx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', disputeLockKey],
        );
        const freshRows = await lockTrx('payments').where({ stripe_charge_id: chargeId });
        // GLOBAL late-created suppression (codex r31 P1): if ANY row for
        // this charge — including a canceled/superseded closure marker —
        // records this dispute as FINAL, the closure already owns the
        // outcome. The per-row guard below misses the shape where a
        // won-before-created marker was neutralized and settlement then
        // added fresh rows carrying no dispute stamps; disputing those
        // would reopen invoices Stripe already restored, with no later
        // closure event to repair them.
        disputeAlreadyFinalized = freshRows.some((r) => {
          const m = parseMeta(r);
          return m.dispute_final && m.dispute_id === dispute.id;
        });
        if (disputeAlreadyFinalized) {
          logger.warn(`[stripe-webhook] dispute ${dispute.id} already finalized on charge ${chargeId} — late created event suppressed globally`);
          return;
        }
        for (const row of freshRows) {
          const meta = parseMeta(row);
          // A neutralized pre-settlement marker is superseded — never
          // resurrect it (codex r8 P1); the live per-invoice rows carry the
          // dispute state.
          if (row.status === 'canceled' && meta.superseded_reason) continue;
          // Same late-replay guard as the single path: a dispute already
          // CLOSED owns its row — never flip a won charge back to disputed.
          // The in-lock re-read makes this authoritative against a racing
          // closure.
          if (meta.dispute_final && meta.dispute_id === dispute.id) continue;
          await lockTrx('payments').where({ id: row.id }).update({
            status: 'disputed',
            failure_reason: `Dispute: ${reason}`,
            metadata: JSON.stringify({ ...meta, dispute_id: dispute.id, ...(meta.invoice_id ? { dispute_invoice_id: meta.invoice_id } : {}) }),
          });
          const rowInvoice = await findInvoiceForPayment(row);
          const invoicePi = rowInvoice?.stripe_payment_intent_id ? String(rowInvoice.stripe_payment_intent_id) : null;
          const disputedPiId = row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : null;
          if (rowInvoice && ['paid', 'processing'].includes(rowInvoice.status)
            && invoicePi && disputedPiId && invoicePi === disputedPiId) {
            reopenPlan.push({ invoiceId: rowInvoice.id, rowId: row.id });
          }
        }
      });
      if (disputeAlreadyFinalized) return; // closure owns the outcome — no reopens, no notification
      for (const { invoiceId: reopenInvoiceId, rowId: reopenRowId } of reopenPlan) {
        // Same lifecycle hook as the single-invoice reopen (codex r4 P1):
        // prepaid coverage must not ride on provisionally clawed-back
        // money — SUSPEND any live term this invoice paid for; the
        // closure branches re-activate (won) or cancel (lost) it.
        // ATOMIC with the reopen and UNCAUGHT (codex r5 P1): a rollback
        // fails the event and Stripe retries it, and the world only ever
        // sees suspended-term + reopened-invoice together. The row's
        // CURRENT dispute state is re-read in this transaction: a closure
        // that finalized between the lock release and this reopen owns the
        // outcome — a won restore must not be reopened behind its back.
        await db.transaction(async (trx) => {
          const rowNow = await trx('payments').where({ id: reopenRowId }).first('status', 'metadata');
          let rowNowMeta = {};
          try { rowNowMeta = rowNow?.metadata ? (typeof rowNow.metadata === 'string' ? JSON.parse(rowNow.metadata) : rowNow.metadata) : {}; } catch { rowNowMeta = {}; }
          if (!rowNow || rowNow.status !== 'disputed'
            || (rowNowMeta.dispute_final && rowNowMeta.dispute_id === dispute.id)) {
            logger.warn(`[stripe-webhook] combined dispute ${dispute.id}: row ${reopenRowId} was finalized while the reopen was queued — closure owns invoice ${reopenInvoiceId}`);
            return;
          }
          await require('../services/annual-prepay-renewals')
            .suspendActiveTermsForDisputedInvoice(reopenInvoiceId, trx);
          await trx('invoices').where({ id: reopenInvoiceId }).update({
            status: 'overdue',
            paid_at: null,
            stripe_payment_intent_id: null,
            stripe_charge_id: null,
            updated_at: trx.fn.now(),
          });
        });
      }
      try {
        await NotificationService.notifyAdmin(
          'dispute',
          `Combined payment dispute: $${amount}`,
          `Dispute ${dispute.id} on a combined balance charge (${reason}) — ${combinedRows.length} invoices reopened. Respond with evidence in the Stripe dashboard.`,
          { icon: '⚠️', link: '/admin/invoices' },
        );
      } catch (err) { logger.error(`[stripe-webhook] Combined dispute notification failed: ${err.message}`); }
      return;
    }
  }

  // Revert payment + invoice
  // These are critical ledger writes: no .catch — a failure must
  // propagate so the event is NOT marked processed and Stripe retries.
  const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();

  // Combined PI disputed BEFORE settlement (codex r5 P1): no payments rows
  // exist yet, so the combined block above fell through — but the later
  // combined succeeded/processing settle would mark every allocated invoice
  // paid on money already clawed back. Persist a durable disputed marker on
  // the PI; settleCombinedPaymentIntent's disputed-row fence refuses to
  // settle while it stands (the succeeded handler records the orphan for
  // the operator), and dispute.closed(won) flips the marker to 'paid',
  // lifting the fence so a legitimate settle can proceed. Mirrors the
  // statement and appointment-fee pre-settlement mechanisms.
  if (!payment && dispute.payment_intent) {
    const preStripe = getStripe();
    // Fail CLOSED (codex r36 P1): a null client must not acknowledge a
    // pre-settlement dispute without fencing — the delayed succeeded
    // would settle a disputed charge.
    if (!preStripe) {
      throw new Error(`Dispute ${dispute.id} pre-settlement check cannot run (Stripe client unavailable); retry`);
    }
    {
      let disputedPi = null;
      try {
        disputedPi = await preStripe.paymentIntents.retrieve(dispute.payment_intent);
      } catch (piErr) {
        // Fail CLOSED: an unreadable PI could be a combined one — retry.
        throw new Error(`Dispute ${dispute.id} pre-settlement PI ${dispute.payment_intent} unreadable (${piErr.message}); retry`);
      }
      if (require('../services/pay-combined').isCombinedPiMetadata(disputedPi?.metadata)) {
        // PARTIAL pre-settlement dispute (codex r10 P1): a full-PI fence
        // would make settlement refuse EVERY share when Stripe withdrew
        // only dispute.amount — park it for reconciliation exactly like
        // the row-based partial branch.
        if (Number(dispute.amount) < Number(disputedPi.amount || 0)) {
          logger.error(`[stripe-webhook] PARTIAL dispute ${dispute.id} ($${amount}) on unsettled combined PI ${dispute.payment_intent} — parked for operator, no settlement fence`);
          await db('stripe_orphan_charges')
            .insert({
              stripe_payment_intent_id: `${dispute.payment_intent}:partial-dispute:${dispute.id}`,
              stripe_charge_id: chargeId,
              customer_id: null,
              invoice_id: null,
              amount: Number(amount),
              source: 'combined_pay_webhook',
              original_db_error: `Partial dispute ${dispute.id} of $${amount} on a combined balance charge BEFORE settlement (${reason}) — attribute and reconcile manually`,
            })
            .onConflict('stripe_payment_intent_id')
            .ignore();
          try {
            await NotificationService.notifyAdmin(
              'dispute',
              `PARTIAL dispute on unsettled combined payment: $${amount}`,
              `Dispute ${dispute.id} withdrew $${amount} of unsettled combined PI ${dispute.payment_intent} (${reason}). Reconcile manually AND respond with evidence in the Stripe dashboard.`,
              { icon: '⚠️', link: '/admin/revenue' },
            );
          } catch (err) { logger.error(`[stripe-webhook] pre-settlement partial-dispute notification failed: ${err.message}`); }
          return;
        }
        // Marker insert serialized on the SETTLEMENT lock (codex r10 P1):
        // a concurrent combined settle (or the closed handler's marker)
        // must be strictly ordered with this fence — re-check for rows
        // under the lock and retry the event against them if any landed.
        await db.transaction(async (trx) => {
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['stripe.pi.payment', String(dispute.payment_intent)],
          );
          const rowInLock = await trx('payments').where({ stripe_charge_id: chargeId }).first('id');
          if (rowInLock) {
            throw new Error(`payments rows appeared for charge ${chargeId} while fencing dispute ${dispute.id} — retry the event against the rows`);
          }
          await trx('payments').insert({
            customer_id: null,
            processor: 'stripe',
            stripe_payment_intent_id: dispute.payment_intent,
            stripe_charge_id: chargeId,
            payment_date: etDateString(),
            amount: Number(amount),
            status: 'disputed',
            failure_reason: `Dispute: ${reason}`,
            description: 'Combined balance charge disputed before settlement (marker)',
            metadata: JSON.stringify({
              combined_payment: true,
              pre_settlement: true,
              dispute_id: dispute.id,
              combined_anchor_invoice_id: disputedPi.metadata?.waves_invoice_id || null,
              waves_customer_id: disputedPi.metadata?.waves_customer_id || null,
            }),
          });
        });
        try {
          await NotificationService.notifyAdmin(
            'dispute',
            `Combined payment disputed pre-settlement: $${amount}`,
            `Dispute ${dispute.id} on combined PI ${dispute.payment_intent} arrived before settlement (${reason}) — settlement is fenced. Respond with evidence in the Stripe dashboard.`,
            { icon: '⚠️', link: '/admin/invoices' },
          );
        } catch (err) { logger.error(`[stripe-webhook] Combined pre-settlement dispute notification failed: ${err.message}`); }
        return;
      }
    }
  }

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

    // (Statement payments are handled by the PI-keyed block above and return early.)
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

      // Annual-prepay coverage must not ride on provisionally clawed-back
      // money: SUSPEND (active → payment_pending, never cancel) any live
      // term this invoice paid for. A won dispute restores the invoice to
      // paid and the ordinary payment sync re-activates the term; a lost
      // dispute cancels it via the refund-shaped sync in dispute-closed.
      // ATOMIC with the invoice reopen (Codex #2533 round-5 P2): a crash
      // between a committed suspension and the reopen would leave a
      // payment_pending + dispute-marked term joined to a still-'paid'
      // invoice — exactly the shape activatePaidPendingTerms (billing cron)
      // and the sweep's marker legs read as "dispute resolved", so they
      // would flip coverage back on and clear the marker mid-dispute before
      // Stripe's retry lands. One transaction means the world only ever
      // sees suspended-term + reopened-invoice together. No .catch —
      // critical-write discipline, a rollback fails the event and Stripe
      // retries it.
      await db.transaction(async (trx) => {
        await require('../services/annual-prepay-renewals')
          .suspendActiveTermsForDisputedInvoice(invoice.id, trx);

        await trx('invoices').where({ id: invoice.id }).update({
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
      });
    }
    }
  }

  // Admin notification
  try {
    await NotificationService.notifyAdmin(
      'dispute',
      `Dispute opened: $${amount}`,
      `Reason: ${reason}. Respond by ${dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) : 'soon'}. Charge: ${chargeId}`,
      { icon: '\u26A0\uFE0F', link: '/admin/invoices' },
    );
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

  // Statement disputes: if `dispute.closed` is REORDERED ahead of dispute.created
  // / payment_intent.succeeded, no `payments` row exists yet, so the charge-id
  // lookup below would no-op and a `lost` clawback would leave the active PI free
  // to settle later. Resolve by PI (mirrors dispute.created) and handle when no
  // payments row exists.
  if (dispute.payment_intent) {
    const stmtByPi = await db('payer_statements').where({ stripe_payment_intent_id: dispute.payment_intent }).first();
    const preRow = await db('payments').where({ stripe_charge_id: chargeId }).first('id');
    if (stmtByPi && !preRow) {
      const { withStatementMoneyLock } = require('../services/payer-statement-settle');
      let handled = false;
      await withStatementMoneyLock(stmtByPi.id, async (trx) => {
        // RE-CHECK under the lock — settle may have inserted the paid row between
        // the pre-check and the lock. If so, fall through to the normal
        // payments-row path (handled stays false).
        const rowInLock = await trx('payments').where({ stripe_charge_id: chargeId }).first('id');
        if (rowInLock) return;
        if (status === 'lost') {
          // Funds returned — reverse/block the statement + persist a durable
          // disputed-lost marker (atomic under the lock).
          await reverseStatementCascadeForDispute(stmtByPi.id, dispute.payment_intent, 'dispute.lost (pre-settlement)', { database: trx });
          await trx('payments').insert({
            customer_id: null, payer_id: stmtByPi.payer_id, statement_id: stmtByPi.id,
            processor: 'stripe', stripe_payment_intent_id: dispute.payment_intent, stripe_charge_id: chargeId,
            payment_date: etDateString(), amount: (dispute.amount / 100), status: 'disputed',
            failure_reason: `Dispute lost — $${amount} returned to customer`,
            description: `Payer statement S-${stmtByPi.id} disputed charge (pre-settlement)`,
            metadata: JSON.stringify({ statement_id: stmtByPi.id, payer_id: stmtByPi.payer_id, dispute_id: dispute.id, dispute_final: status, source: 'statement_dispute' }),
          });
        } else {
          // `won`/`warning_closed` before settlement: funds STOOD but nothing
          // settled. Persist a dispute-final marker so a late created skips
          // reversal; the eventual succeeded UPSERTS this row and settles with
          // validation. (Leave the active PI in place. If no succeeded ever
          // arrives — created→succeeded→won — the marker stays for operator
          // reconcile; we do NOT mark the ledger paid without validation.)
          await trx('payments').insert({
            customer_id: null, payer_id: stmtByPi.payer_id, statement_id: stmtByPi.id,
            processor: 'stripe', stripe_payment_intent_id: dispute.payment_intent, stripe_charge_id: chargeId,
            payment_date: etDateString(), amount: (dispute.amount / 100), status: 'disputed',
            description: `Payer statement S-${stmtByPi.id} dispute ${status} before settlement (marker)`,
            metadata: JSON.stringify({ statement_id: stmtByPi.id, payer_id: stmtByPi.payer_id, dispute_id: dispute.id, dispute_final: status, source: 'statement_dispute' }),
          });
        }
        handled = true;
      });
      if (handled) {
        logger.warn(`[stripe-webhook] statement S-${stmtByPi.id} dispute.closed (${status}) before settlement via PI ${dispute.payment_intent}`);
        return;
      }
    }
  }

  // Combined full-balance charge (payIncludeBalance): dispute.created
  // flipped EVERY allocation row disputed and reopened every invoice — the
  // closure must apply the final outcome across the same set (codex r3
  // P1); the single-row path below would restore only .first() and leave
  // the sibling invoices overdue after Stripe reinstated the whole charge.
  {
    const combinedClosedRows = await db('payments').where({ stripe_charge_id: chargeId });
    const rowMetaOf = (row) => {
      try { return row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {}; } catch { return {}; }
    };
    if (combinedClosedRows.length && combinedClosedRows.some((r) => rowMetaOf(r).combined_payment)) {
      // PARTIAL dispute closing (codex r5 P1): the created handler parked it
      // (no statuses touched) because a charge-level partial can't be
      // attributed to a share — the closure must not apply the full-charge
      // transition either. Stamp nothing, notify, leave for the operator.
      // Same canceled-marker exclusion as the created handler (codex r8 P1).
      let combinedClosedFullCents = combinedClosedRows
        .filter((r) => r.status !== 'canceled')
        .reduce((s, r) => s + Math.round(Number(r.amount || 0) * 100), 0);
      // Stripe charge = the classification authority (codex r19 P1, same
      // residual-undercount reasoning as the created handler); fail CLOSED
      // on an unreadable charge.
      {
        const closedDisputeStripe = getStripe();
        // Fail CLOSED (codex r36 P2), same reasoning as the created path.
        if (!closedDisputeStripe) {
          throw new Error(`Dispute ${dispute.id} closure: charge ${chargeId} cannot be classified full-vs-partial (Stripe client unavailable); retry`);
        }
        {
          let liveClosedCharge;
          try {
            liveClosedCharge = await closedDisputeStripe.charges.retrieve(chargeId);
          } catch (chargeErr) {
            throw new Error(`Dispute ${dispute.id} closure: charge ${chargeId} unreadable for full-vs-partial classification (${chargeErr.message}); retry`);
          }
          if (Number(liveClosedCharge?.amount) > 0) combinedClosedFullCents = Number(liveClosedCharge.amount);
        }
      }
      if (Number(dispute.amount) < combinedClosedFullCents) {
        logger.error(`[stripe-webhook] PARTIAL dispute ${dispute.id} on combined charge ${chargeId} closed as ${status} — ${status === 'lost' ? 'parked case stands, still needs manual reconcile' : 'funds restored, case auto-resolved'}`);
        // A restored partial (won/warning_closed) resolves its per-dispute
        // reconciliation case (codex r21 P2) — Stripe put the money back, so
        // no unmatched cash remains. The UPSERT also handles the
        // closed-before-created ordering: a pre-created RESOLVED row makes
        // the late created's onConflict-ignore insert a no-op instead of a
        // fresh false-positive case. LOST keeps its case open (money gone,
        // attribution still owed).
        if (status === 'won' || status === 'warning_closed') {
          await db('stripe_orphan_charges')
            .insert({
              stripe_payment_intent_id: `${dispute.payment_intent || chargeId}:partial-dispute:${dispute.id}`,
              stripe_charge_id: chargeId,
              customer_id: null,
              invoice_id: null,
              amount: Number(amount),
              source: 'combined_pay_webhook',
              original_db_error: `Partial dispute ${dispute.id} on a combined balance charge closed as ${status}`,
              resolved: true,
              resolved_at: new Date(),
              resolution_notes: `Automatically resolved: partial dispute ${dispute.id} closed as ${status} — Stripe restored the disputed amount`,
            })
            .onConflict('stripe_payment_intent_id')
            .merge(['resolved', 'resolved_at', 'resolution_notes']);
        }
        try {
          await NotificationService.notifyAdmin(
            'dispute',
            `PARTIAL combined dispute ${status}: $${amount}`,
            `Partial dispute ${dispute.id} on combined charge ${chargeId} closed as ${status}. ${status === 'lost' ? 'Shares were never auto-attributed — reconcile manually in /admin/revenue.' : 'The disputed amount was restored; its reconciliation case was auto-resolved.'}`,
            { icon: status === 'won' ? '✅' : '❌', link: '/admin/revenue' },
          );
        } catch { /* non-critical */ }
        return;
      }
      let restoredCount = 0;
      // Phase 1 — row stamps under the shared per-PI serialization lock
      // with a FRESH in-lock re-read (codex r12 P1): a concurrent
      // dispute.created holding a stale snapshot can otherwise overwrite
      // the final stamp this closure writes and reopen a won invoice.
      // Invoice restores/reopens, term syncs, and marker resettles run
      // AFTER the lock releases (phase 2): the resettle re-enters
      // handleCombinedPaymentIntentSucceeded, whose settle takes this same
      // advisory lock in its own transaction — running it in-lock would
      // self-deadlock — and each phase-2 action re-checks its own guards.
      const closedLockKey = String(dispute.payment_intent
        || combinedClosedRows.find((r) => r.stripe_payment_intent_id)?.stripe_payment_intent_id
        || chargeId);
      const closurePlan = [];
      await db.transaction(async (lockTrx) => {
        await lockTrx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', closedLockKey],
        );
        const freshClosedRows = await lockTrx('payments').where({ stripe_charge_id: chargeId });
        for (const row of freshClosedRows) {
          const meta = rowMetaOf(row);
          // Skip already-superseded markers (codex r8 P1) — but a
          // RESOLVED-marker replay must still re-arm the resettle (a prior
          // delivery may have crashed between neutralization and the
          // succeeded lifecycle; the re-run is idempotent).
          if (row.status === 'canceled' && meta.superseded_reason) {
            if ((status === 'won' || status === 'warning_closed')
              && meta.superseded_reason === 'pre_settlement_marker_resolved'
              && row.stripe_payment_intent_id) {
              closurePlan.push({ type: 'resettle', piId: String(row.stripe_payment_intent_id) });
            }
            continue;
          }
          const finalRowMeta = JSON.stringify({ ...meta, dispute_id: dispute.id, dispute_final: status });
          const invId = meta.invoice_id || meta.dispute_invoice_id || null;
          if (status === 'won' || status === 'warning_closed') {
            // PRE-SETTLEMENT marker won (codex r6 P0): the marker fenced the
            // settle (which recorded an orphan), so flipping it to 'paid'
            // would strand every allocated invoice unsettled — and if won
            // arrived BEFORE succeeded, a full-amount 'paid' marker would
            // double-count once settlement adds the per-invoice rows.
            // Neutralize the marker (canceled, final outcome recorded) and
            // queue the succeeded-lifecycle re-run for phase 2.
            if (meta.pre_settlement === true && !invId) {
              await lockTrx('payments').where({ id: row.id }).update({
                status: 'canceled',
                // Amount zeroed (codex r8 P1): same-charge sums and payout
                // recon must not count the superseded full-amount marker
                // beside the real per-invoice rows settlement adds.
                amount: 0,
                metadata: JSON.stringify({ ...meta, dispute_id: dispute.id, dispute_final: status, superseded_reason: 'pre_settlement_marker_resolved', superseded_marker_amount: Number(row.amount) || 0 }),
              });
              if (row.stripe_payment_intent_id) {
                closurePlan.push({ type: 'resettle', piId: String(row.stripe_payment_intent_id) });
              }
              continue;
            }
            await lockTrx('payments').where({ id: row.id }).update({ status: 'paid', metadata: finalRowMeta });
            if (invId) closurePlan.push({ type: 'won', invId, row });
          } else if (status === 'lost') {
            await lockTrx('payments').where({ id: row.id }).update({
              status: 'disputed',
              failure_reason: `Dispute lost — $${amount} returned to customer`,
              metadata: finalRowMeta,
            });
            if (invId) closurePlan.push({ type: 'lost', invId, row });
          } else {
            await lockTrx('payments').where({ id: row.id }).update({ metadata: finalRowMeta });
          }
        }
      });
      // Phase 2 — invoice-side outcomes and marker resettles, each behind
      // its own fresh-read guards.
      for (const step of closurePlan) {
        const row = step.row;
        if (step.type === 'resettle') {
          const markerStripe = getStripe();
          if (!markerStripe) throw new Error(`Combined pre-settlement dispute ${dispute.id} won but Stripe is unavailable to resettle PI ${step.piId}; retry`);
          const markerPi = await markerStripe.paymentIntents.retrieve(step.piId);
          if (markerPi.status === 'succeeded') {
            // FULL succeeded lifecycle, not a bare settle (codex r7 P1):
            // the recovered PI also owes review enrollment, the ACH
            // failure-state reset, the saved-method consent mirror, the
            // billing-pause clear, and the success notification — a
            // consented combined ACH signup must not clear with its bank
            // method unenrolled. The handler resolves the fenced orphan
            // itself; throws propagate for Stripe redelivery.
            await handleCombinedPaymentIntentSucceeded(markerPi, null);
            logger.warn(`[stripe-webhook] combined pre-settlement dispute ${dispute.id} won — PI ${step.piId} re-ran the full succeeded lifecycle`);
          } else {
            logger.warn(`[stripe-webhook] combined pre-settlement dispute ${dispute.id} won before settlement — fence lifted, PI ${step.piId} is ${markerPi.status}`);
          }
          continue;
        }
        if (step.type === 'won') {
          const invId = step.invId;
          {
            const invoice = await db('invoices').where({ id: invId }).first('id', 'status', 'stripe_payment_intent_id');
            const invoicePi = invoice?.stripe_payment_intent_id ? String(invoice.stripe_payment_intent_id) : null;
            const disputedPiId = row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : null;
            // Same replacement guard as the single path: the reopen cleared
            // the PI, so a non-null different PI means a replacement payment
            // owns this invoice — never double-settle it.
            // A DIFFERENT live PI = a replacement session started after the
            // created-reopen (codex r27 P1). The payment row above was
            // already flipped back to 'paid' — leaving both alive would let
            // the customer pay the same share AGAIN with the reinstated
            // funds unaccounted. Cancel an UNCONFIRMED replacement and take
            // the invoice back; money in flight (or a cash/other-rail
            // payment) instead PARKS the reinstated amount for the
            // operator. Fail closed on an unreadable replacement.
            let replacementNeutralized = false;
            if (invoice && invoicePi && disputedPiId && invoicePi !== disputedPiId) {
              // The replacement may ALREADY have paid the invoice (codex
              // r28 P1) — the reconciliation runs regardless of invoice
              // status: only a still-collectible invoice with an
              // UNCONFIRMED replacement gets the cancel-and-take-back;
              // paid/processing (money moved) parks the reinstated share.
              const replacementAlreadySettled = ['paid', 'processing'].includes(String(invoice.status || '').toLowerCase());
              if (!replacementAlreadySettled) {
                const wonStripe = getStripe();
                if (!wonStripe) throw new Error(`Dispute ${dispute.id} won but replacement PI ${invoicePi} on invoice ${invId} is unverifiable (Stripe unavailable); retry`);
                let replPi;
                try {
                  replPi = await wonStripe.paymentIntents.retrieve(invoicePi);
                } catch (replErr) {
                  throw new Error(`Dispute ${dispute.id} won but replacement PI ${invoicePi} on invoice ${invId} is unreadable (${replErr.message}); retry`);
                }
                if (replPi.status === 'canceled') {
                  // A prior delivery canceled the replacement but crashed
                  // before the stamp cleanup (codex r36 P2) — finish the
                  // neutralization instead of parking money that never
                  // moved. Neutralized ONLY when the binding is proven
                  // ours-or-clear (codex r37 P1): a fresh /setup
                  // replacement bound in the gap keeps its live secret and
                  // takes the park path.
                  await require('../services/pay-combined').clearPaymentIntentStamps(db, replPi.id, { keepInvoiceIds: [String(invId)] });
                  const unboundCanceled = await db('invoices').where({ id: invId, stripe_payment_intent_id: replPi.id }).update({ stripe_payment_intent_id: null, updated_at: db.fn.now() });
                  if (unboundCanceled > 0) {
                    invoice.stripe_payment_intent_id = null;
                    replacementNeutralized = true;
                  } else {
                    const nowBound = await db('invoices').where({ id: invId }).first('stripe_payment_intent_id');
                    const nowPi = nowBound?.stripe_payment_intent_id ? String(nowBound.stripe_payment_intent_id) : null;
                    if (!nowPi) {
                      invoice.stripe_payment_intent_id = null;
                      replacementNeutralized = true; // already cleared by a prior retry
                    } else {
                      logger.warn(`[stripe-webhook] dispute ${dispute.id} won — a fresh replacement (${nowPi}) bound invoice ${invId} while cleaning canceled ${replPi.id}; parking the reinstated amount`);
                    }
                  }
                  if (replacementNeutralized) logger.warn(`[stripe-webhook] dispute ${dispute.id} won — replacement PI ${replPi.id} was already canceled; stamps cleaned, the reinstated charge settles invoice ${invId}`);
                } else if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(replPi.status)) {
                  // ONLY the cancel itself may take the park-on-error path
                  // (codex r37 P2): a post-cancel DB failure must PROPAGATE
                  // so redelivery finishes through the already-canceled
                  // branch above — swallowing it would park a phantom
                  // replacement and strand the invoice behind a dead PI.
                  let cancelSucceeded = false;
                  try {
                    await wonStripe.paymentIntents.cancel(replPi.id);
                    cancelSucceeded = true;
                  } catch (cancelErr) {
                    logger.warn(`[stripe-webhook] dispute ${dispute.id} won — replacement PI ${replPi.id} raced into flight (${cancelErr.message}); parking the reinstated amount`);
                  }
                  if (cancelSucceeded) {
                    await require('../services/pay-combined').clearPaymentIntentStamps(db, replPi.id, { keepInvoiceIds: [String(invId)] });
                    // CONDITIONAL unbind (codex r36 P1): only clear the
                    // binding if it is still the replacement we canceled —
                    // a /setup racing this window can commit a FRESH
                    // replacement whose client secret the customer holds.
                    const unbound = await db('invoices').where({ id: invId, stripe_payment_intent_id: replPi.id }).update({ stripe_payment_intent_id: null, updated_at: db.fn.now() });
                    if (unbound > 0) {
                      invoice.stripe_payment_intent_id = null;
                      replacementNeutralized = true;
                      logger.warn(`[stripe-webhook] dispute ${dispute.id} won — canceled unconfirmed replacement PI ${replPi.id} on invoice ${invId}; the reinstated charge settles it`);
                    } else {
                      logger.warn(`[stripe-webhook] dispute ${dispute.id} won — a fresh replacement bound invoice ${invId} while neutralizing ${replPi.id}; parking the reinstated amount`);
                    }
                  }
                }
              }
              if (!replacementNeutralized) {
                // Replacement money is real — park the reinstated share so
                // the reconciliation queue owns it (never silently absent).
                await db('stripe_orphan_charges')
                  .insert({
                    stripe_payment_intent_id: `${disputedPiId}:dispute-won:${dispute.id}:${invId}`,
                    stripe_charge_id: row.stripe_charge_id || chargeId,
                    customer_id: row.customer_id || null,
                    invoice_id: invId,
                    amount: Number(row.amount) || 0,
                    source: 'combined_pay_webhook',
                    original_db_error: `Dispute ${dispute.id} won reinstated $${Number(row.amount || 0).toFixed(2)} for invoice ${invId}, but a replacement payment owns the invoice — credit or refund the reinstated share manually`,
                  })
                  .onConflict('stripe_payment_intent_id')
                  .ignore();
                try {
                  await NotificationService.notifyAdmin(
                    'dispute',
                    `Won dispute needs reconciliation: $${Number(row.amount || 0).toFixed(2)}`,
                    `Dispute ${dispute.id} reinstated funds for invoice ${invId}, but a replacement payment already owns it — credit or refund the reinstated share in /admin/revenue.`,
                    { icon: '⚠️', link: '/admin/revenue' },
                  );
                } catch { /* non-critical */ }
              }
            }
            // TERMINAL states stay terminal (codex r29 P2): an admin who
            // voided the invoice after the created-reopen made a deliberate
            // decision — the won closure must not overwrite it with 'paid'
            // and re-run coverage sync. Park the reinstated share instead.
            const invStatusNow = String(invoice?.status || '').toLowerCase();
            const terminalNow = ['void', 'refunded', 'canceled', 'cancelled'].includes(invStatusNow);
            if (invoice && terminalNow) {
              await db('stripe_orphan_charges')
                .insert({
                  stripe_payment_intent_id: `${disputedPiId || chargeId}:dispute-won:${dispute.id}:${invId}`,
                  stripe_charge_id: row.stripe_charge_id || chargeId,
                  customer_id: row.customer_id || null,
                  invoice_id: invId,
                  amount: Number(row.amount) || 0,
                  source: 'combined_pay_webhook',
                  original_db_error: `Dispute ${dispute.id} won reinstated $${Number(row.amount || 0).toFixed(2)} for invoice ${invId}, but the invoice is ${invStatusNow} (deliberate terminal state) — credit or refund the reinstated share manually`,
                })
                .onConflict('stripe_payment_intent_id')
                .ignore();
              try {
                await NotificationService.notifyAdmin(
                  'dispute',
                  `Won dispute needs reconciliation: $${Number(row.amount || 0).toFixed(2)}`,
                  `Dispute ${dispute.id} reinstated funds for invoice ${invId}, but the invoice is ${invStatusNow} — credit or refund the reinstated share in /admin/revenue.`,
                  { icon: '⚠️', link: '/admin/revenue' },
                );
              } catch { /* non-critical */ }
              continue;
            }
            const invoicePiNow = invoice?.stripe_payment_intent_id ? String(invoice.stripe_payment_intent_id) : null;
            const restoreNow = invoice && invoice.status !== 'paid'
              && (!invoicePiNow || (disputedPiId && invoicePiNow === disputedPiId));
            // Replay shape (codex r8 P1): a prior delivery committed the
            // restore but crashed in the term sync below — the invoice is
            // already 'paid' UNDER THIS DISPUTED PI, and skipping would
            // strand the term suspended forever. Re-run the idempotent
            // sync for that shape too.
            const alreadyRestoredByThisPi = invoice && invoice.status === 'paid'
              && invoicePi && disputedPiId && invoicePi === disputedPiId;
            let restoredThisPass = false;
            if (restoreNow) {
              // CONDITIONAL restore (codex r34 P1): the snapshot above was
              // read unlocked — a /setup can mint a replacement PI in the
              // gap, and an unconditional overwrite would stamp the
              // disputed PI over a binding whose client secret the
              // customer still holds. The WHERE re-verifies the binding at
              // write time; zero rows = a replacement raced in → park the
              // reinstated share instead.
              const restoredRows = await db('invoices')
                .where({ id: invoice.id })
                .whereNot('status', 'paid')
                .where(function bindingUnchanged() {
                  this.whereNull('stripe_payment_intent_id');
                  if (disputedPiId) this.orWhere('stripe_payment_intent_id', disputedPiId);
                })
                .update({
                  status: 'paid',
                  paid_at: new Date().toISOString(),
                  stripe_payment_intent_id: row.stripe_payment_intent_id || null,
                  stripe_charge_id: row.stripe_charge_id || null,
                });
              if (restoredRows > 0) {
                restoredCount += 1;
                restoredThisPass = true;
              } else {
                logger.warn(`[stripe-webhook] dispute ${dispute.id} won — invoice ${invId} binding changed before the restore committed; parking the reinstated share`);
                await db('stripe_orphan_charges')
                  .insert({
                    stripe_payment_intent_id: `${disputedPiId || chargeId}:dispute-won:${dispute.id}:${invId}`,
                    stripe_charge_id: row.stripe_charge_id || chargeId,
                    customer_id: row.customer_id || null,
                    invoice_id: invId,
                    amount: Number(row.amount) || 0,
                    source: 'combined_pay_webhook',
                    original_db_error: `Dispute ${dispute.id} won reinstated $${Number(row.amount || 0).toFixed(2)} for invoice ${invId}, but a replacement payment bound the invoice before the restore — credit or refund the reinstated share manually`,
                  })
                  .onConflict('stripe_payment_intent_id')
                  .ignore();
                try {
                  await NotificationService.notifyAdmin(
                    'dispute',
                    `Won dispute needs reconciliation: $${Number(row.amount || 0).toFixed(2)}`,
                    `Dispute ${dispute.id} reinstated funds for invoice ${invId}, but a replacement payment raced the restore — credit or refund the reinstated share in /admin/revenue.`,
                    { icon: '⚠️', link: '/admin/revenue' },
                  );
                } catch { /* non-critical */ }
              }
            }
            if (restoredThisPass || alreadyRestoredByThisPi) {
              // Recovery sync on the restored money (codex r4 P1): a paid
              // prepay invoice re-activates its dispute-suspended term.
              // UNCAUGHT (codex r5 P1): a swallowed failure marks the event
              // processed with the term stranded in payment_pending even
              // though the invoice is back to paid — propagate so Stripe
              // redelivers and the idempotent loop (including the
              // already-restored replay shape) re-runs the sync.
              const freshWon = await db('invoices').where({ id: invoice.id }).first();
              if (freshWon) await require('../services/annual-prepay-renewals').syncTermForInvoicePayment(freshWon);
            }
          }
          continue;
        }
        if (step.type === 'lost') {
          const invId = step.invId;
          {
            // Replacement-payment guard (codex r5 P1, exactly the single
            // path's): if dispute.created reopened this invoice and the
            // customer already re-paid it (a DIFFERENT live PI now backs
            // it), the lost closure must not clear that valid payment and
            // reopen collection a third time — and must not claw back the
            // coverage the replacement money funds.
            const lostInvoice = await db('invoices').where({ id: invId }).first('id', 'status', 'stripe_payment_intent_id');
            const lostInvoicePi = lostInvoice?.stripe_payment_intent_id ? String(lostInvoice.stripe_payment_intent_id) : null;
            const lostDisputedPi = row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : null;
            const lostStatus = String(lostInvoice?.status || '').toLowerCase();
            if (lostInvoice && ['paid', 'processing'].includes(lostStatus)
              && lostInvoicePi && lostDisputedPi && lostInvoicePi === lostDisputedPi) {
              await db('invoices')
                .where({ id: invId })
                .update({ status: 'overdue', paid_at: null, stripe_payment_intent_id: null, stripe_charge_id: null, updated_at: db.fn.now() });
            }
            // Refund-shaped term sync (codex r4 P1): lost money cancels the
            // prepaid coverage this invoice funded — but only when the
            // DISPUTED payment still owns the invoice: PI match above, or
            // the created-reopen shape (PI cleared, invoice sitting
            // 'overdue' under this dispute's recorded binding). UNCAUGHT
            // (codex r5 P1): critical lifecycle write, propagate for
            // Stripe redelivery.
            const lostDisputeOwnsInvoice = !!lostInvoice && (
              (lostInvoicePi && lostDisputedPi && lostInvoicePi === lostDisputedPi)
              || (!lostInvoicePi && lostStatus === 'overdue')
            );
            if (lostDisputeOwnsInvoice) {
              await require('../services/annual-prepay-renewals')
                .syncTermForInvoicePayment({ id: invId, status: 'refunded', paid_at: null });
            }
          }
        }
      }
      // A LOST full-charge dispute returns the residual shares' cash too
      // (codex r24 P2): resolve this charge's parked residual cases (same
      // matcher as the full-refund cleanup — partial-dispute/refund parks
      // stay open, and a WON dispute preserves everything).
      if (status === 'lost') {
        const lostResiduals = await db('stripe_orphan_charges')
          .where({ resolved: false, source: 'combined_pay_webhook' })
          .where(function lostResidualKeys() {
            this.where('stripe_charge_id', chargeId);
            this.orWhere('stripe_payment_intent_id', 'like', `${closedLockKey}:%`);
          })
          .whereNot('stripe_payment_intent_id', 'like', '%:partial-%')
          .update({
            resolved: true,
            resolved_at: new Date(),
            resolution_notes: `Automatically resolved: dispute ${dispute.id} was LOST — the unmatched cash was returned to the customer via chargeback`,
          });
        if (lostResiduals > 0) {
          logger.info(`[stripe-webhook] combined dispute ${dispute.id} lost — resolved ${lostResiduals} residual reconciliation case(s) for charge ${chargeId}`);
        }
        // Whole-charge quarantines resolve too (codex r29 P2): a combined
        // succeeded event quarantined before settlement wrote an
        // invoice_payment_webhook orphan keyed by the PLAIN PI id — the
        // lost chargeback returned that cash as well, and leaving the row
        // open keeps assertNoInvoiceChargeReconciliationPending fencing
        // the anchor from collection.
        const lostQuarantines = await db('stripe_orphan_charges')
          .where({ resolved: false, source: 'invoice_payment_webhook', stripe_payment_intent_id: closedLockKey })
          .update({
            resolved: true,
            resolved_at: new Date(),
            resolution_notes: `Automatically resolved: dispute ${dispute.id} was LOST — the quarantined charge's cash was returned to the customer via chargeback`,
          });
        if (lostQuarantines > 0) {
          logger.info(`[stripe-webhook] combined dispute ${dispute.id} lost — resolved ${lostQuarantines} whole-charge quarantine(s) for PI ${closedLockKey}`);
        }
      }
      try {
        await NotificationService.notifyAdmin(
          'dispute',
          `Combined-payment dispute ${status}: $${amount}`,
          `Dispute on combined balance charge ${chargeId} closed as ${status} — ${combinedClosedRows.length} rows finalized${status === 'won' || status === 'warning_closed' ? `, ${restoredCount} invoices restored to paid` : ''}.`,
          { icon: status === 'won' ? '✅' : '❌', link: '/admin/invoices' },
        );
      } catch { /* non-critical */ }
      return;
    }
  }

  // Critical ledger writes: no .catch — failures must propagate so the
  // event is NOT marked processed and Stripe retries.
  const payment = await db('payments').where({ stripe_charge_id: chargeId }).first();

  // Combined PI closed BEFORE dispute.created AND settlement (codex r9 P1):
  // no rows exist, so the combined block above fell through — persist the
  // final outcome so a late created can't reverse the win (its late-replay
  // guard reads dispute_final) and settlement behaves correctly: a WON
  // closure leaves a zeroed superseded marker (no fence — funds stood, the
  // eventual succeeded settles normally); a LOST closure leaves a disputed
  // fence marker (the clawed-back charge must never settle).
  if (!payment && dispute.payment_intent) {
    const preStripe = getStripe();
    // Fail CLOSED (codex r36 P1): losing an early LOST outcome to a null
    // client would let the delayed settle mark clawed-back money paid.
    if (!preStripe) {
      throw new Error(`Dispute ${dispute.id} closure pre-settlement check cannot run (Stripe client unavailable); retry`);
    }
    {
      let closedPi = null;
      try {
        closedPi = await preStripe.paymentIntents.retrieve(dispute.payment_intent);
      } catch (piErr) {
        throw new Error(`Dispute ${dispute.id} closed (${status}) pre-settlement but PI ${dispute.payment_intent} is unreadable (${piErr.message}); retry`);
      }
      if (require('../services/pay-combined').isCombinedPiMetadata(closedPi?.metadata)) {
        // Partial pre-settlement closure: created parked it (or will) — no
        // full-PI outcome marker either (codex r10 P1, same reasoning as
        // the created fallback).
        if (Number(dispute.amount) < Number(closedPi.amount || 0)) {
          logger.error(`[stripe-webhook] PARTIAL dispute ${dispute.id} on unsettled combined PI ${dispute.payment_intent} closed as ${status} — ${status === 'lost' ? 'parked case stands' : 'funds restored, case auto-resolved'}`);
          // Same restored-outcome case resolution + late-created suppression
          // as the post-settlement partial closure (codex r21 P2).
          if (status === 'won' || status === 'warning_closed') {
            await db('stripe_orphan_charges')
              .insert({
                stripe_payment_intent_id: `${dispute.payment_intent || chargeId}:partial-dispute:${dispute.id}`,
                stripe_charge_id: chargeId,
                customer_id: null,
                invoice_id: null,
                amount: Number(amount),
                source: 'combined_pay_webhook',
                original_db_error: `Partial dispute ${dispute.id} on an unsettled combined balance charge closed as ${status}`,
                resolved: true,
                resolved_at: new Date(),
                resolution_notes: `Automatically resolved: partial dispute ${dispute.id} closed as ${status} — Stripe restored the disputed amount`,
              })
              .onConflict('stripe_payment_intent_id')
              .merge(['resolved', 'resolved_at', 'resolution_notes']);
          }
          try {
            await NotificationService.notifyAdmin(
              'dispute',
              `PARTIAL combined dispute ${status} (pre-settlement): $${amount}`,
              `Partial dispute ${dispute.id} on unsettled combined PI ${dispute.payment_intent} closed as ${status}. ${status === 'lost' ? 'Reconcile manually in /admin/revenue.' : 'The disputed amount was restored; its reconciliation case was auto-resolved.'}`,
              { icon: status === 'won' ? '✅' : '❌', link: '/admin/revenue' },
            );
          } catch { /* non-critical */ }
          return;
        }
        const lostOutcome = status === 'lost';
        // Serialized on the settlement lock, marker re-checked in-lock
        // (codex r10 P1): a concurrent created-fence or settlement must be
        // strictly ordered with this outcome marker.
        await db.transaction(async (trx) => {
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['stripe.pi.payment', String(dispute.payment_intent)],
          );
          const rowInLock = await trx('payments').where({ stripe_charge_id: chargeId }).first('id');
          if (rowInLock) {
            throw new Error(`payments rows appeared for charge ${chargeId} while recording dispute ${dispute.id} closure — retry the event against the rows`);
          }
          await trx('payments').insert({
            customer_id: null,
            processor: 'stripe',
            stripe_payment_intent_id: dispute.payment_intent,
            stripe_charge_id: chargeId,
            payment_date: etDateString(),
            amount: lostOutcome ? Number(amount) : 0,
            status: lostOutcome ? 'disputed' : 'canceled',
            ...(lostOutcome ? { failure_reason: `Dispute lost — $${amount} returned to customer` } : {}),
            description: `Combined balance charge dispute ${status} before settlement (marker)`,
            metadata: JSON.stringify({
              combined_payment: true,
              pre_settlement: true,
              dispute_id: dispute.id,
              dispute_final: status,
              ...(lostOutcome ? {} : { superseded_reason: 'closed_before_created', superseded_marker_amount: Number(amount) || 0 }),
              combined_anchor_invoice_id: closedPi.metadata?.waves_invoice_id || null,
            }),
          });
        });
        try {
          await NotificationService.notifyAdmin(
            'dispute',
            `Combined dispute ${status} pre-settlement: $${amount}`,
            `Dispute ${dispute.id} on combined PI ${dispute.payment_intent} closed as ${status} before settlement — final outcome recorded${lostOutcome ? '; settlement is fenced' : '; the eventual settle proceeds normally'}.`,
            { icon: status === 'won' ? '✅' : '❌', link: '/admin/invoices' },
          );
        } catch { /* non-critical */ }
        logger.warn(`[stripe-webhook] combined dispute ${dispute.id} closed (${status}) before created/settlement — durable outcome marker written for PI ${dispute.payment_intent}`);
        return;
      }
    }
  }

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

    // Appointment-fee closures run entirely UNDER the fee PI lock (Codex
    // #3153 r23 P1): the created handler's locked path re-reads
    // dispute_final under the same lock, so the final stamp and invoice
    // restore/reopen must commit there too — otherwise a racing created
    // can overwrite the final state and strand a reinstated invoice
    // overdue. Fee invoices carry no statement/annual-prepay ties, so the
    // row is fully handled here (return). Pre-settlement markers re-run
    // idempotent settlement after the locked flip.
    if (closedPaymentMeta.purpose === 'appointment_card_no_show_fee' && payment.stripe_payment_intent_id) {
      const feePi = String(payment.stripe_payment_intent_id);
      await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${feePi}`]);
        const rowInLock = await trx('payments').where({ id: payment.id }).first();
        if (!rowInLock) return;
        let meta = {};
        try {
          meta = rowInLock.metadata ? (typeof rowInLock.metadata === 'string' ? JSON.parse(rowInLock.metadata) : rowInLock.metadata) : {};
        } catch { meta = {}; }
        const lockedFinalMeta = JSON.stringify({ ...meta, dispute_id: dispute.id, dispute_final: status });
        if (status === 'won' || status === 'warning_closed') {
          await trx('payments').where({ id: payment.id }).update({ status: 'paid', metadata: lockedFinalMeta });
          const invId = meta.invoice_id || meta.dispute_invoice_id || null;
          const wonInvoice = invId
            ? await trx('invoices').where({ id: invId }).first('id', 'status', 'stripe_payment_intent_id')
            : await trx('invoices').where({ stripe_payment_intent_id: feePi }).first('id', 'status', 'stripe_payment_intent_id');
          const wonInvoicePi = wonInvoice?.stripe_payment_intent_id ? String(wonInvoice.stripe_payment_intent_id) : null;
          // Restore only when no replacement payment owns the invoice —
          // the reopen cleared the PI, so null means the dispute owns it.
          if (wonInvoice && wonInvoice.status !== 'paid' && (!wonInvoicePi || wonInvoicePi === feePi)) {
            await trx('invoices').where({ id: wonInvoice.id }).update({
              status: 'paid',
              paid_at: new Date().toISOString(),
              stripe_payment_intent_id: feePi,
              stripe_charge_id: payment.stripe_charge_id || null,
            });
          }
        } else if (status === 'lost') {
          await trx('payments').where({ id: payment.id }).update({
            status: 'disputed',
            failure_reason: `Dispute lost — $${amount} returned to customer`,
            metadata: lockedFinalMeta,
          });
          // Reopen idempotently — created/closed can arrive reversed.
          const lostInvoice = await trx('invoices').where({ stripe_payment_intent_id: feePi }).first('id', 'status');
          if (lostInvoice && ['paid', 'processing'].includes(String(lostInvoice.status || '').toLowerCase())) {
            await trx('invoices').where({ id: lostInvoice.id }).update({
              status: 'overdue',
              paid_at: null,
              stripe_payment_intent_id: null,
              stripe_charge_id: null,
              updated_at: trx.fn.now(),
            });
          }
        } else {
          await trx('payments').where({ id: payment.id }).update({ metadata: lockedFinalMeta });
        }
      });
      // Pre-settlement dispute marker won → the retained fee still needs
      // its paid invoice/receipt: re-run idempotent settlement (throws on
      // failure so the event retries).
      if (['won', 'warning_closed'].includes(status)
        && closedPaymentMeta.pre_settlement_dispute === true && !closedPaymentMeta.invoice_id) {
        const { resettleAppointmentFeeFromPi } = require('../services/appointment-card-request');
        await resettleAppointmentFeeFromPi(feePi);
      }
      try {
        await NotificationService.notifyAdmin(
          'dispute',
          `Dispute ${status}: $${amount}`,
          `Dispute on charge ${chargeId} closed as ${status}.`,
          { icon: status === 'won' ? '✅' : '❌', link: '/admin/invoices' },
        );
      } catch { /* non-critical */ }
      return;
    }

    if (status === 'won' || status === 'warning_closed') {
      // Statement PRE-settlement dispute MARKER (base_amount_cents null ⇒ never
      // validated through settleStatementPaid). A won here may have NO future
      // succeeded to settle (created→succeeded→won leaves the succeeded event
      // orphaned), so do NOT mark the ledger paid or settle without validation —
      // record the final outcome and leave it for operator reconcile.
      if (payment.statement_id && payment.base_amount_cents == null) {
        await db('payments').where({ id: payment.id }).update({ metadata: finalMeta });
        logger.warn(`[stripe-webhook] statement S-${payment.statement_id} dispute won on a pre-settlement marker (no validated settlement) — left for manual reconcile`);
        return;
      }
      // Funds reinstated — restore paid status (a VALIDATED statement settlement,
      // or an invoice payment).
      await db('payments').where({ id: payment.id }).update({ status: 'paid', metadata: finalMeta });
      if (payment.statement_id) {
        await restoreStatementCascadeForDispute(payment.statement_id, payment.stripe_payment_intent_id);
      }
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
      // Annual-prepay sync on the restored money: a paid PREPAY invoice
      // re-activates its dispute-suspended term (payment_pending → active)
      // and re-runs the pending-window reconcile, so visits that billed
      // per-application during the dispute settle/credit against the
      // annual; a paid VISIT invoice re-enters the pending-window hook to
      // resolve a slice the activation left in-flight. Fresh read — the
      // restore above (or a replacement payment) decides the status this
      // sync sees. Idempotent; no .catch (critical-write discipline).
      if (invoice) {
        const freshWonInvoice = await db('invoices').where({ id: invoice.id }).first();
        if (freshWonInvoice) {
          await require('../services/annual-prepay-renewals')
            .syncTermForInvoicePayment(freshWonInvoice);
        }
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
      if (payment.statement_id) await reverseStatementCascadeForDispute(payment.statement_id, payment.stripe_payment_intent_id, 'dispute.lost');
      const lostInvoice = await findInvoiceForPayment(payment);
      const lostInvoicePi = lostInvoice?.stripe_payment_intent_id ? String(lostInvoice.stripe_payment_intent_id) : null;
      const lostDisputedPi = payment.stripe_payment_intent_id ? String(payment.stripe_payment_intent_id) : null;
      // Only reopen when the disputed PI still settles the invoice.
      // Normal flow: dispute.created already reopened it, the customer
      // re-paid with a NEW PI, then closed(lost) lands days later —
      // that newly paid invoice must not be flipped back to overdue.
      if (lostInvoice && ['paid', 'processing'].includes(lostInvoice.status)
        && lostInvoicePi && lostDisputedPi && lostInvoicePi === lostDisputedPi) {
        // Persist the invoice binding (mirrors dispute-created): the reopen
        // below clears the invoice's PI, so a Stripe retry of THIS event can
        // only re-find the invoice — and re-run the prepay claw-back sync —
        // through the metadata.
        await db('payments').where({ id: payment.id }).update({
          metadata: JSON.stringify({
            ...closedPaymentMeta,
            dispute_id: dispute.id,
            dispute_final: status,
            dispute_invoice_id: lostInvoice.id,
          }),
        });
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
      // Annual-prepay claw-back: lost = the money is gone for good — the
      // same semantics as a full refund. Run the refund-shaped sync
      // whenever the DISPUTED payment (not a replacement) backed the
      // invoice: on first delivery the PI still matches or the invoice sits
      // reopened ('overdue') under this dispute's recorded binding; on a
      // Stripe retry after the PI-clear above, the metadata binding decides.
      // A replacement-paid invoice never matches either arm — its coverage
      // is backed by real money and must survive. For a PREPAY invoice this
      // cancels the term (stamps cleared, coverage-settled invoices
      // reopened, pending-window credits reversed, billing mode restored);
      // for a VISIT invoice the pending-window hook reverses that visit's
      // slice credit. Idempotent; no .catch (critical-write discipline).
      const lostDisputeOwnedInvoice = !!lostInvoice && (
        (lostInvoicePi && lostDisputedPi && lostInvoicePi === lostDisputedPi)
        || (!lostInvoicePi
          && String(lostInvoice.status || '').toLowerCase() === 'overdue'
          && closedPaymentMeta.dispute_invoice_id === lostInvoice.id)
      );
      if (lostDisputeOwnedInvoice) {
        await require('../services/annual-prepay-renewals')
          .syncTermForInvoicePayment({ id: lostInvoice.id, status: 'refunded', paid_at: null });
      }
    }
  }

  // Appointment-fee pre-settlement dispute marker closed WON (Codex #3153
  // r18 P1): the funds are reinstated but the acknowledged succeeded event
  // will never retry \u2014 flip the marker settleable and re-run idempotent
  // settlement so the retained fee gets its paid invoice + receipt.
  if (['won', 'warning_closed'].includes(status) && dispute.payment_intent) {
    // NO catch around the re-settlement itself (Codex #3153 r19 P1): a
    // failure must propagate so the event is retried — acknowledging it
    // would permanently strand the reinstated fee without its invoice.
    let feeRow = await db('payments').where({ stripe_payment_intent_id: dispute.payment_intent }).first('id', 'status', 'metadata');
    if (!feeRow) {
      // WON delivered before BOTH created and succeeded (Codex #3153 r21
      // P1): identify the lane from trusted PI metadata and persist the
      // final state under the fee lock — otherwise a late created event
      // writes a permanently 'disputed' marker, or a late created after
      // settlement reopens the paid invoice (no dispute_final on record).
      const wonPi = await require('../services/stripe').retrievePaymentIntent(dispute.payment_intent);
      if (wonPi?.metadata?.purpose === 'appointment_card_no_show_fee') {
        await db.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${dispute.payment_intent}`]);
          const rowInLock = await trx('payments').where({ stripe_payment_intent_id: dispute.payment_intent }).first('id', 'metadata');
          if (rowInLock) {
            // Settlement (or a created-event marker) won the lock race
            // (Codex #3153 r24 P1): the closure must still leave its
            // final-state fence — returning unstamped would let a delayed
            // created event mark the reinstated payment disputed and
            // reopen its invoice. Stamp under the same lock; the post-txn
            // re-read below picks up marker rows for the settle flip.
            let appearedMeta = {};
            try {
              appearedMeta = rowInLock.metadata ? (typeof rowInLock.metadata === 'string' ? JSON.parse(rowInLock.metadata) : rowInLock.metadata) : {};
            } catch { appearedMeta = {}; }
            await trx('payments').where({ id: rowInLock.id }).update({
              metadata: JSON.stringify({
                ...appearedMeta,
                dispute_id: dispute.id,
                dispute_final: status,
              }),
            });
            return;
          }
          await trx('payments').insert({
            customer_id: wonPi.metadata?.waves_customer_id || null,
            processor: 'stripe',
            payment_date: etDateString(),
            amount: (Number(dispute.amount) || 0) / 100,
            status: 'paid',
            stripe_payment_intent_id: dispute.payment_intent,
            stripe_charge_id: chargeId,
            metadata: JSON.stringify({
              purpose: 'appointment_card_no_show_fee',
              pre_settlement_dispute: true,
              dispute_id: dispute.id,
              dispute_final: status,
            }),
          });
        });
        feeRow = await db('payments').where({ stripe_payment_intent_id: dispute.payment_intent }).first('id', 'status', 'metadata');
      }
    }
    let feeMeta = {};
    try {
      feeMeta = feeRow && feeRow.metadata ? (typeof feeRow.metadata === 'string' ? JSON.parse(feeRow.metadata) : feeRow.metadata) : {};
    } catch { feeMeta = {}; }
    if (feeMeta.purpose === 'appointment_card_no_show_fee' && feeMeta.pre_settlement_dispute === true && !feeMeta.invoice_id) {
      // Flip the marker settleable UNDER the fee lock, stamping the final
      // state (Codex #3153 r22 P1) — a racing created event re-reads
      // dispute_final under the same lock and skips instead of reopening.
      await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${dispute.payment_intent}`]);
        const rowInLock = await trx('payments').where({ id: feeRow.id }).first('id', 'status', 'metadata');
        if (!rowInLock) return;
        let lockedMeta = {};
        try {
          lockedMeta = rowInLock.metadata ? (typeof rowInLock.metadata === 'string' ? JSON.parse(rowInLock.metadata) : rowInLock.metadata) : {};
        } catch { lockedMeta = {}; }
        await trx('payments').where({ id: rowInLock.id }).update({
          ...(String(rowInLock.status || '').toLowerCase() === 'disputed' ? { status: 'paid' } : {}),
          metadata: JSON.stringify({ ...lockedMeta, dispute_id: dispute.id, dispute_final: status }),
        });
      });
      const { resettleAppointmentFeeFromPi } = require('../services/appointment-card-request');
      await resettleAppointmentFeeFromPi(dispute.payment_intent);
    }
  }

  try {
    await NotificationService.notifyAdmin(
      'dispute',
      `Dispute ${status}: $${amount}`,
      `Dispute on charge ${chargeId} closed as ${status}.`,
      { icon: status === 'won' ? '\u2705' : '\u274C', link: '/admin/invoices' },
    );
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

  // Portal ACH lane (Codex #2706 r3): a failed micro-deposit verification
  // must move the durable pending row OUT of pending — otherwise the
  // portal shows "Verification pending — watch for two small deposits"
  // forever with no failure state or retry path. Matched on the persisted
  // SetupIntent id; only pending rows flip (a verified row is never
  // demoted by a stale/duplicate failure event).
  // The write is NOT caught (Codex r5): swallowing it acks the event and
  // Stripe never retries, stranding the row in pending — let it bubble so
  // the dispatcher 500s and the retry re-runs this idempotent update. It
  // runs BEFORE the SMS so a retry can't double-text.
  const failedPmId = typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id;
  const rowFilter = failedPmId
    ? { stripe_payment_method_id: failedPmId }
    : { stripe_setup_intent_id: setupIntent.id };
  await db('payment_methods')
    .where(rowFilter)
    .whereIn('method_type', ['ach', 'us_bank_account'])
    .where({ ach_status: 'pending_verification' })
    .update({ ach_status: 'verification_failed' });

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
          {
            original_message_type: 'bank_verification_failed',
            stripe_setup_intent_id: setupIntent.id,
            // Customer linkage for the deferred-replay recheck: a night-
            // held copy of this notice must suppress at 8 AM if the
            // customer added/verified a replacement bank method overnight
            // — "verification failed" after the portal shows a verified
            // method reads broken. (sms_log.customer_id exists on the
            // queued row, but the executor hands rechecks METADATA only.)
            waves_customer_id: customer.id,
          }
        );
        if (!smsResult.sent) {
          logger.warn(`[stripe-webhook] Setup-failed SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
      }
    }
  } catch (err) {
    if (err?.code === 'BILLING_NOTICE_ENQUEUE_FAILED') throw err;
    /* non-critical otherwise */
  }
}

module.exports = router;
// Exposed for unit tests.
module.exports._handleRefundFailed = handleRefundFailed;
module.exports._handleChargeRefunded = handleChargeRefunded;
module.exports._resolveRefundIdForCharge = resolveRefundIdForCharge;
module.exports._handleSetupIntentSucceeded = handleSetupIntentSucceeded;
module.exports._handleSetupIntentFailed = handleSetupIntentFailed;
module.exports._resolveOrphanSucceededPaymentIntentIfSettled = resolveOrphanSucceededPaymentIntentIfSettled;
module.exports._handlePaymentIntentFailed = handlePaymentIntentFailed;
module.exports._handlePaymentIntentCanceled = handlePaymentIntentCanceled;
module.exports._dispatchAchProcessingAcknowledgment = dispatchAchProcessingAcknowledgment;
module.exports.sweepUnacknowledgedAchProcessingAcks = sweepUnacknowledgedAchProcessingAcks;
module.exports._handleAchFailure = handleAchFailure;
module.exports._armMonthlyAutopayRetryForAsyncFailure = armMonthlyAutopayRetryForAsyncFailure;
module.exports._handlePaymentIntentSucceeded = handlePaymentIntentSucceeded;
module.exports._handleSetupIntentSucceeded = handleSetupIntentSucceeded;
