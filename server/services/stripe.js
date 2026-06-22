const Stripe = require('stripe');
const config = require('../config');
const stripeConfig = require('../config/stripe-config');
const db = require('../models/db');
const logger = require('./logger');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');
const { v4: uuidv4 } = require('uuid');
const { etDateString } = require('../utils/datetime-et');

// ═══════════════════════════════════════════════════════════════
// Lazy-init Stripe client — don't crash if key is missing
// ═══════════════════════════════════════════════════════════════
let _stripe;
function getStripe() {
  if (_stripe) return _stripe;
  if (!stripeConfig.secretKey) {
    logger.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe features disabled');
    return null;
  }
  // maxNetworkRetries: connection blips after Stripe has processed a
  // request are replayed by the SDK with the SAME idempotency key, so an
  // ambiguous timeout resolves to the original outcome instead of being
  // recorded as a failure (which the autopay cron would re-charge days
  // later).
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia', maxNetworkRetries: 2 });
  return _stripe;
}

// ═══════════════════════════════════════════════════════════════
// Credit card processing surcharge
// Debit/prepaid/unknown/ACH pay the quoted amount with no surcharge.
// Pure helpers live in ./stripe-pricing so they can be unit-tested
// without the Stripe SDK; one source of truth for surcharge math.
// ═══════════════════════════════════════════════════════════════
const {
  CARD_SURCHARGE_RATE,
  SURCHARGE_API_VERSION,
  SURCHARGE_POLICY_VERSION,
  CONFIGURED_COST_BPS,
  isCardMethodType,
  shouldSurcharge,
  computeChargeAmount,
  buildSurchargeAmountDetails,
  computeRefundSurcharge,
} = require('./stripe-pricing');
const { surchargeAllowed } = require('./surcharge-jurisdiction');
const {
  assertInvoicePaymentIntentTenderMatches,
  invoicePaymentStatusForIntent,
} = require('./stripe-invoice-state');
const { assertInvoiceCollectible } = require('./invoice-helpers');

// Stripe rejects a payment_method_types narrow when an incompatible
// PaymentMethod is already attached to the PaymentIntent — e.g. a customer
// who began an ACH entry (attaching a us_bank_account PM) then switches to
// Card. Detect that specific rejection so the caller can recover by minting a
// fresh PI for the selected tender rather than failing the switch.
function isIncompatibleAttachedMethodError(err) {
  const message = String(err?.message || err?.raw?.message || '').toLowerCase();
  return message.includes('incompatible with the attached paymentmethod')
    || message.includes('replace the paymentmethod first');
}

// PI statuses from which it's safe to cancel + replace the intent. A
// processing/succeeded PI has money in flight and must never be canceled.
const REPLACEABLE_PI_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
]);

const StripeService = {
  // =========================================================================
  // AVAILABILITY
  // =========================================================================

  /**
   * Returns true if Stripe is configured and available
   */
  isAvailable() {
    return !!stripeConfig.secretKey;
  },

  // =========================================================================
  // CUSTOMER MANAGEMENT
  // =========================================================================

  /**
   * Create or retrieve a Stripe customer, store stripe_customer_id on customers table.
   * Returns the Stripe customer ID.
   */
  async ensureStripeCustomer(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    // Already linked
    if (customer.stripe_customer_id) {
      return customer.stripe_customer_id;
    }

    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    try {
      const stripeCustomer = await stripe.customers.create({
        name: `${customer.first_name} ${customer.last_name}`,
        email: customer.email || undefined,
        phone: customer.phone || undefined,
        address: {
          line1: customer.address_line1,
          line2: customer.address_line2 || undefined,
          city: customer.city,
          state: customer.state,
          postal_code: customer.zip,
          country: 'US',
        },
        metadata: {
          waves_customer_id: customerId,
          waveguard_tier: customer.waveguard_tier || '',
        },
      }, {
        idempotencyKey: `cust-create-${customerId}`,
      });

      const stripeCustomerId = stripeCustomer.id;

      await db('customers')
        .where({ id: customerId })
        .update({ stripe_customer_id: stripeCustomerId });

      logger.info(`[stripe] Customer created: ${stripeCustomerId} for ${customerId}`);
      return stripeCustomerId;
    } catch (err) {
      logger.error(`[stripe] Customer creation failed: ${err.message}`);
      throw new Error('Failed to create Stripe customer');
    }
  },

  /**
   * Create or retrieve the PAYER's Stripe customer, persisting stripe_customer_id
   * on the payers row. Kept SEPARATE from ensureStripeCustomer (homeowner) so a
   * payer and a homeowner Stripe customer never cross — a NET-terms statement
   * charges the payer's AP card, never the resident's. Returns the Stripe
   * customer ID. (Phase-1 left payers.stripe_customer_id nullable + stored-only;
   * this is the first writer.)
   */
  async ensureStripePayerCustomer(payerId) {
    const payer = await db('payers').where({ id: payerId }).first();
    if (!payer) throw new Error('Payer not found');
    if (payer.stripe_customer_id) return payer.stripe_customer_id;

    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    try {
      const stripeCustomer = await stripe.customers.create({
        name: payer.company_name || payer.display_name,
        email: payer.ap_email || undefined,
        phone: payer.ap_phone || undefined,
        address: payer.billing_address_line1 ? {
          line1: payer.billing_address_line1,
          city: payer.billing_city || undefined,
          state: payer.billing_state || undefined,
          postal_code: payer.billing_zip || undefined,
          country: 'US',
        } : undefined,
        metadata: {
          waves_payer_id: String(payerId),
          payer_billing: 'true',
        },
      }, {
        idempotencyKey: `payer-cust-create-${payerId}`,
      });

      const stripeCustomerId = stripeCustomer.id;
      await db('payers')
        .where({ id: payerId })
        .update({ stripe_customer_id: stripeCustomerId, updated_at: db.fn.now() });

      logger.info(`[stripe] Payer Stripe customer created: ${stripeCustomerId} for payer ${payerId}`);
      return stripeCustomerId;
    } catch (err) {
      logger.error(`[stripe] Payer Stripe customer creation failed: ${err.message}`);
      throw new Error('Failed to create payer Stripe customer');
    }
  },

  // =========================================================================
  // SETUP INTENT (Card / ACH Save)
  // =========================================================================

  /**
   * Create a SetupIntent for saving a card or bank account.
   * The frontend uses this clientSecret to confirm via Stripe.js.
   * @param {string} customerId — Waves customer UUID
   * @param {string} [paymentMethodType] — 'card', 'us_bank_account', or 'card_or_bank'
   * @returns {{ clientSecret: string, setupIntentId: string }}
   */
  async createSetupIntent(customerId, paymentMethodType = 'card') {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

    const paymentMethodTypes = paymentMethodType === 'us_bank_account'
      ? ['us_bank_account']
      : paymentMethodType === 'card_or_bank'
        ? ['card', 'us_bank_account']
        : ['card'];

    try {
      const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: paymentMethodTypes,
        metadata: {
          waves_customer_id: customerId,
        },
      });

      logger.info(`[stripe] SetupIntent created: ${setupIntent.id} for ${customerId}`);
      return {
        clientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id,
      };
    } catch (err) {
      logger.error(`[stripe] SetupIntent creation failed: ${err.message}`);
      throw new Error('Failed to create setup intent');
    }
  },

  // =========================================================================
  // SAVE PAYMENT METHOD
  // =========================================================================

  /**
   * After the frontend confirms a SetupIntent, call this to persist
   * the payment method in our DB. Supports card + us_bank_account.
   * @param {string} customerId — Waves customer UUID
   * @param {string} paymentMethodId — Stripe pm_xxx ID
   * @param {object} [options]
   * @param {boolean} [options.enableAutopay=false] — mark this method chargeable by the monthly autopay cron
   * @param {boolean} [options.makeDefault=true] — make this the customer's default saved method
   * @returns {object} payment_methods row
   */
  async savePaymentMethod(customerId, paymentMethodId, options = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);
    const enableAutopay = options.enableAutopay === true;
    const makeDefault = options.makeDefault !== false;

    try {
      // Retrieve PM first to verify it's not already attached to a DIFFERENT customer
      // (prevents an attacker from claiming someone else's saved payment method)
      const existingPm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (existingPm.customer && existingPm.customer !== stripeCustomerId) {
        logger.warn(`[stripe] Refusing to attach PM ${paymentMethodId} — owned by different Stripe customer`);
        throw new Error('Payment method does not belong to this customer');
      }

      // Attach PM to the Stripe customer (may already be attached via SetupIntent)
      try {
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: stripeCustomerId,
        });
      } catch (attachErr) {
        // Already attached — that's fine
        if (!attachErr.message.includes('already been attached')) {
          throw attachErr;
        }
      }

      // Retrieve full PM details (post-attach)
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

      // Build DB record
      const record = {
        customer_id: customerId,
        processor: 'stripe',
        stripe_payment_method_id: paymentMethodId,
        stripe_customer_id: stripeCustomerId,
        is_default: makeDefault,
        autopay_enabled: enableAutopay,
      };

      if (pm.type === 'card' && pm.card) {
        record.method_type = 'card';
        record.card_brand = pm.card.brand ? pm.card.brand.toUpperCase() : null;
        record.card_funding = pm.card.funding || null;
        record.card_funding_checked_at = new Date();
        record.last_four = pm.card.last4;
        record.exp_month = String(pm.card.exp_month).padStart(2, '0');
        record.exp_year = String(pm.card.exp_year);
      } else if (pm.type === 'us_bank_account' && pm.us_bank_account) {
        record.method_type = 'ach';
        record.bank_name = pm.us_bank_account.bank_name;
        record.bank_last_four = pm.us_bank_account.last4;
        record.last_four = pm.us_bank_account.last4;
        record.ach_status = pm.us_bank_account.status || 'verified';
      }

      const saved = await db.transaction(async trx => {
        const [inserted] = await trx('payment_methods').insert(record).returning('*');
        if (makeDefault) {
          await trx('payment_methods')
            .where({ customer_id: customerId })
            .whereNot({ id: inserted.id })
            .update({ is_default: false });
        }
        return inserted;
      });

      logger.info(`[stripe] Payment method saved for ${customerId}: ${pm.type} ****${record.last_four}`);
      return saved;
    } catch (err) {
      logger.error(`[stripe] Save payment method failed: ${err.message}`);
      throw new Error('Failed to save payment method');
    }
  },

  // =========================================================================
  // GET CARDS (All payment methods — both processors)
  // =========================================================================

  /**
   * Return all payment_methods for a customer (Stripe)
   */
  async getCards(customerId) {
    return db('payment_methods')
      .where({ customer_id: customerId })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');
  },

  // =========================================================================
  // RESOLVE PAYMENT METHOD TYPE (via Stripe)
  // =========================================================================

  /**
   * Retrieve a PaymentIntent with optional Stripe `expand` keys.
   * Returns null if Stripe isn't configured. Throws on Stripe errors so
   * callers can decide whether to fail closed or degrade.
   *
   * Used by routes that need server-verified PaymentIntent facts (e.g.
   * consent snapshotting on the public /pay endpoint) where trusting
   * client-supplied fields would defeat the audit trail.
   */
  async retrievePaymentIntent(paymentIntentId, options = {}) {
    if (!paymentIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.paymentIntents.retrieve(paymentIntentId, options);
  },

  async retrieveSetupIntent(setupIntentId, options = {}) {
    if (!setupIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.setupIntents.retrieve(setupIntentId, options);
  },

  /**
   * Cancel a PaymentIntent. Returns null if Stripe isn't configured.
   * Throws on Stripe errors — including the race where the intent has
   * already moved to processing/succeeded and can no longer be cancelled —
   * so callers can fail closed (e.g. skip auto-voiding an invoice whose
   * payment may be in flight).
   */
  async cancelPaymentIntent(paymentIntentId, options = {}) {
    if (!paymentIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.paymentIntents.cancel(paymentIntentId, options);
  },

  /**
   * PaymentIntent for a required estimate-acceptance deposit. Not linked to
   * any invoice — the webhook and accept-time verification route on
   * metadata.purpose, and the deposit is later credited against the first
   * invoice as a negative line item. Idempotency keyed on estimate+amount so
   * retrying the deposit step reuses the same intent instead of stacking
   * duplicate authorizations — which is also why every create param below
   * must be deterministic from (estimateId, amountCents): a mutable field
   * (e.g. receipt_email) under the same key makes Stripe reject the retry
   * as a key reuse with different parameters. The payer's receipt comes
   * from the Payment Element's collected email, not from this intent.
   * retryGeneration (the caller's count of terminal ledger rows) joins the
   * key after a refund/dispute/failure, so a replacement deposit mints a
   * fresh PI instead of Stripe replaying the old refunded one.
   */
  async createEstimateDepositIntent({ estimateId, amountDollars, retryGeneration = 0 }) {
    const stripe = getStripe();
    if (!stripe) return null;
    // PRODUCT DECISION (owner, 2026-06-12): deposits intentionally bypass
    // computeChargeAmount and the 2.9% card surcharge. The customer-facing
    // deposit amount must equal the invoice credit exactly ("pay $49 now,
    // that exact $49 is credited to your first visit") — the surcharge
    // applies only to the remaining first-invoice balance when paid by card.
    // Do NOT route this amount through computeChargeAmount; the exemption is
    // pinned by server/tests/estimate-deposit-intent-surcharge-exempt.test.js.
    const amountCents = Math.round(Number(amountDollars) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new Error('Invalid deposit amount');
    }
    return stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      // Instant tenders only. The accept gate requires the PI to be
      // `succeeded` BEFORE acceptance commits — a delayed method (ACH bank
      // debit) would sit in `processing`, bounce the accept with 402, and
      // then succeed days later against an unaccepted estimate.
      payment_method_types: ['card'],
      description: 'Waves service deposit — applied toward your first visit',
      metadata: {
        purpose: 'estimate_deposit',
        estimate_id: String(estimateId),
        // DELIBERATELY surcharge-exempt: the deposit is a flat per-service-
        // class commitment device ($49 recurring / $99 one-time),
        // charged at face value with no card surcharge,
        // and the invoice credit equals exactly the amount received. This
        // metadata marks the exemption explicitly so webhook surcharge
        // quarantine logic can distinguish it from an under-collected
        // invoice payment.
        surcharge_policy: 'deposit_exempt',
      },
    }, { idempotencyKey: `estimate_deposit_${estimateId}_${amountCents}${Number(retryGeneration) > 0 ? `_r${Number(retryGeneration)}` : ''}` });
  },

  /**
   * Raw refund of a PaymentIntent — for money that should never have been
   * collected (a stale estimate deposit that succeeded after the estimate
   * became unacceptable) or the unapplied remainder of a deposit (partial,
   * via amountCents). The payments-table refund() flow doesn't apply:
   * deposits have no payments row. Idempotency-keyed on the PI (plus the
   * amount for partials) so webhook replays can't double-refund.
   */
  async refundPaymentIntent(paymentIntentId, { reason = 'requested_by_customer', amountCents = null } = {}) {
    if (!paymentIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    const partial = Number.isFinite(Number(amountCents)) && Number(amountCents) > 0;
    return stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason,
        ...(partial ? { amount: Math.round(Number(amountCents)) } : {}),
      },
      { idempotencyKey: partial ? `refund_pi_${paymentIntentId}_${Math.round(Number(amountCents))}` : `refund_pi_${paymentIntentId}` },
    );
  },

  // =========================================================================
  // REMOVE CARD
  // =========================================================================

  /**
   * Detach a payment method via Stripe.
   */
  async removeCard(customerId, cardId) {
    const card = await db('payment_methods')
      .where({ id: cardId, customer_id: customerId })
      .first();

    if (!card) throw new Error('Payment method not found');

    if (card.processor === 'stripe' && card.stripe_payment_method_id) {
      const stripe = getStripe();
      if (!stripe) throw new Error('Stripe not configured');

      try {
        await stripe.paymentMethods.detach(card.stripe_payment_method_id);
      } catch (err) {
        // If already detached in Stripe, just remove from DB
        logger.warn(`[stripe] Detach warning (proceeding with DB removal): ${err.message}`);
      }
      await db('payment_methods').where({ id: cardId }).del();
      logger.info(`[stripe] Payment method removed for ${customerId}: ${cardId}`);
      return { success: true };
    }

    // Fallback — just remove from DB
    await db('payment_methods').where({ id: cardId }).del();
    logger.info(`[stripe] Payment method removed (DB only) for ${customerId}: ${cardId}`);
    return { success: true };
  },

  // =========================================================================
  // CHARGE — Off-session PaymentIntent
  // =========================================================================

  /**
   * Charge a customer's default Stripe payment method.
   * @param {string} customerId — Waves customer UUID
   * @param {number} amountDollars — charge amount in dollars
   * @param {string} description — charge description
   * @param {object} [metadata] — extra Stripe metadata
   * @param {string} [idempotencyKey] — Stripe idempotency key scoped to the
   *   caller's durable business operation (e.g. autopay_monthly_<cid>_<date>,
   *   autopay_retry_<paymentId>_<rung>). When omitted a random per-call key
   *   is generated, which still lets the SDK's network retries replay the
   *   same request but provides no cross-process dedupe.
   * @returns {object} payments table row
   */
  async charge(customerId, amountDollars, description, metadata = {}, idempotencyKey = null) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const card = await db('payment_methods')
      .where({ customer_id: customerId, processor: 'stripe', is_default: true, autopay_enabled: true })
      .first();

    if (!card || !card.stripe_payment_method_id) {
      throw new Error('No Stripe autopay payment method on file');
    }

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

    // Apply credit card surcharge when funding is confirmed as 'credit'.
    // Debit/prepaid/unknown-funding/ACH pay the quoted amount with no surcharge.
    if (card.method_type === 'card' && !card.card_funding && card.stripe_payment_method_id) {
      try {
        const pmObj = await stripe.paymentMethods.retrieve(card.stripe_payment_method_id);
        const fetchedFunding = pmObj.card?.funding || null;
        if (fetchedFunding) {
          card.card_funding = fetchedFunding;
          await db('payment_methods').where({ id: card.id }).update({
            card_funding: fetchedFunding,
            card_funding_checked_at: new Date(),
          });
          logger.info(`[stripe] Backfilled card_funding=${fetchedFunding} for card ${card.id}`);
        }
      } catch (fetchErr) {
        logger.warn(`[stripe] Could not fetch funding for card ${card.id}: ${fetchErr.message}`);
      }
    }
    const chargeInfo = computeChargeAmount(amountDollars, card.method_type, { funding: card.card_funding });
    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = chargeInfo;
    const baseAmount = baseCents / 100;
    const surchargeAmount = surchargeCents / 100;
    const totalAmount = totalCents / 100;

    // Build Stripe surcharge amount_details (null when no surcharge)
    const surchargeDetails = buildSurchargeAmountDetails(surchargeCents);

    // Step 1: Charge via Stripe. Expand latest_charge so we can read
    // receipt_url off it directly (the prior `paymentIntent.charges.data`
    // path was removed by Stripe's 2022-11-15 API; latest_charge is the
    // supported replacement and survives future API bumps).
    // Idempotency key: callers pass a key scoped to their durable
    // business operation so overlapping cron instances (deploy window)
    // and post-ambiguity re-runs replay the SAME PaymentIntent at
    // Stripe instead of charging twice. The random fallback still
    // gives the SDK's maxNetworkRetries a stable key to replay
    // connection blips within this call. Replayed outcomes — success
    // AND failure — are collapsed to a single ledger row by the
    // advisory-locked writes below.
    const effectiveIdempotencyKey = idempotencyKey
      || `charge_${customerId}_${require('crypto').randomUUID()}`;

    let paymentIntent;
    try {
      const piParams = {
        amount: totalCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: card.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        expand: ['latest_charge'],
        description: surchargeAmount > 0
          ? `${description} (includes $${surchargeAmount.toFixed(2)} credit card surcharge)`
          : description,
        metadata: {
          waves_customer_id: customerId,
          base_amount: String(baseAmount),
          card_surcharge: String(surchargeAmount),
          surcharge_rate_bps: String(rateBps),
          surcharge_policy_version: policyVersion,
          ...metadata,
        },
      };
      if (surchargeDetails) piParams.amount_details = surchargeDetails;
      paymentIntent = await stripe.paymentIntents.create(piParams, {
        idempotencyKey: effectiveIdempotencyKey,
        ...(surchargeDetails ? { apiVersion: SURCHARGE_API_VERSION } : {}),
      });
    } catch (err) {
      // Stripe charge failed — record the failure
      logger.error(`[stripe] Charge failed for ${customerId}: ${err.message}`);

      // Detect SCA / step-up authentication required. Off-session
      // PaymentIntents can land in `requires_action` when the cardholder's
      // bank demands 3DS — Stripe surfaces it as code/decline_code
      // 'authentication_required' on the thrown error and the PI exists in
      // requires_action state. The customer SMS path is already wired via
      // payment_intent.requires_action in the webhook handler; the cron
      // just needs to NOT schedule a retry against the same wall.
      const authCode = err.code || err.raw?.code || err.decline_code || err.raw?.decline_code;
      const requiresAction = authCode === 'authentication_required';
      const piIdFromErr = err.payment_intent?.id || err.raw?.payment_intent?.id || null;
      // A no-PI failure is only AMBIGUOUS (Stripe may have processed the
      // request) for connection/API errors. Deterministic pre-charge
      // failures — invalid params, detached payment method — definitely
      // moved no money and stay safe to auto-retry. The retry sweep
      // parks ambiguous rows for manual reconciliation.
      const errType = err.type || err.raw?.type || null;
      const ambiguousOutcome = !piIdFromErr
        && ['StripeConnectionError', 'StripeAPIError'].includes(errType);

      // Replay-aware failure record: with durable idempotency keys,
      // overlapping workers can both receive the same replayed decline
      // (same PI on the error). Serialize on the PI — or on the
      // idempotency key when Stripe failed before minting a PI — and
      // reuse the existing failed row instead of inserting a duplicate,
      // which would seed duplicate retry-queue entries.
      const failureLockScope = piIdFromErr || effectiveIdempotencyKey;
      // The classified throws below must survive even when THIS write
      // fails (DB blip): losing the AMBIGUOUS/SCA classification would
      // make callers treat the error as a safe decline and arm a
      // fresh-key retry — the exact double-charge vector being closed.
      let failedRecord = null;
      try {
        failedRecord = await db.transaction(async (trx) => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', String(failureLockScope)],
        );

        if (piIdFromErr) {
          // Check for a COLLECTED row first: a replayed error (e.g.
          // authentication_required) can arrive after the webhook
          // already flipped this PI to paid. Inserting a failed
          // duplicate would show collected money as outstanding.
          const collected = await trx('payments')
            .where({ stripe_payment_intent_id: piIdFromErr })
            .whereIn('status', ['paid', 'processing'])
            .first();
          if (collected) {
            logger.warn(`[stripe] Replayed failure for PI ${piIdFromErr} but payment ${collected.id} is ${collected.status} — surfacing collected row, no failed duplicate`);
            return collected;
          }
          const existing = await trx('payments')
            .where({ stripe_payment_intent_id: piIdFromErr, status: 'failed' })
            .first();
          if (existing) {
            logger.warn(`[stripe] Failed PI ${piIdFromErr} already recorded (payment ${existing.id}) — idempotency replay, reusing row`);
            return existing;
          }
        } else {
          // Stripe failed before minting a PI — dedupe on the durable
          // idempotency key persisted in metadata, otherwise two
          // overlapping workers each insert a null-PI failed row and
          // billing-cron later retries BOTH with distinct rung keys
          // (double charge for one obligation).
          const existing = await trx('payments')
            .where({ customer_id: customerId, status: 'failed' })
            .whereRaw("metadata->>'idempotency_key' = ?", [effectiveIdempotencyKey])
            .first();
          if (existing) {
            logger.warn(`[stripe] No-PI failure for key ${effectiveIdempotencyKey} already recorded (payment ${existing.id}) — reusing row`);
            return existing;
          }
        }

        const [row] = await trx('payments').insert({
          customer_id: customerId,
          payment_method_id: card.id,
          processor: 'stripe',
          stripe_payment_intent_id: piIdFromErr,
          payment_date: etDateString(),
          amount: totalAmount,
          base_amount_cents: baseCents,
          surcharge_amount_cents: surchargeCents,
          // payments.status is a Postgres enum (upcoming/processing/paid/
          // failed/refunded) — DON'T introduce a new value here, the
          // insert would raise enum_invalid and tank the whole catch path.
          // billing-cron skip-retry keys off the thrown STRIPE_REQUIRES_
          // ACTION code below; admin dashboards surface SCA via the
          // description suffix + metadata.requires_action flag.
          status: 'failed',
          description: requiresAction ? `${description} — REQUIRES AUTH` : `${description} — FAILED`,
          failure_reason: err.message,
          metadata: JSON.stringify({
            error: err.message,
            code: authCode || null,
            error_type: errType,
            ambiguous_outcome: ambiguousOutcome,
            requires_action: requiresAction,
            base_amount: baseAmount,
            card_surcharge: surchargeAmount,
            idempotency_key: effectiveIdempotencyKey,
          }),
        }).returning('*');
        return row;
        });
      } catch (recordErr) {
        logger.error(`[stripe] Could not record failed-charge row for ${customerId} (key ${effectiveIdempotencyKey}): ${recordErr.message}`);
      }

      // If the PI was already collected (webhook beat the replayed
      // error), the truth is SUCCESS — return the collected row instead
      // of throwing, so callers run their success path (supersede
      // original, receipt) rather than arming retries against money
      // already taken.
      if (failedRecord && ['paid', 'processing'].includes(failedRecord.status)) {
        return failedRecord;
      }

      if (requiresAction) {
        const sca = new Error('Customer authentication required');
        sca.code = 'STRIPE_REQUIRES_ACTION';
        sca.stripePaymentIntentId = piIdFromErr;
        sca.paymentRecord = failedRecord;
        throw sca;
      }
      if (ambiguousOutcome) {
        // Distinct code so NO caller treats this as a safe decline:
        // Stripe may have processed the charge, so re-attempting with a
        // fresh idempotency key (cron rung key, admin re-click) is a
        // double-charge vector. Callers must park for manual
        // reconciliation instead.
        const amb = new Error('Charge outcome ambiguous — Stripe may have processed the payment');
        amb.code = 'STRIPE_AMBIGUOUS_OUTCOME';
        amb.paymentRecord = failedRecord;
        amb.idempotencyKey = effectiveIdempotencyKey;
        throw amb;
      }
      throw Object.assign(new Error('Payment processing failed'), { paymentRecord: failedRecord });
    }

    // Step 2: Stripe charge succeeded — record in DB
    const status = paymentIntent.status === 'succeeded' ? 'paid' : 'processing';
    try {
      // latest_charge is the expanded charge object (we passed
      // expand:['latest_charge'] above). Stripe also returns the bare
      // charge id on this field when not expanded — read defensively
      // either way so a future SDK change can't strip the receipt URL.
      const latestCharge = paymentIntent.latest_charge;
      const stripeChargeId = typeof latestCharge === 'string' ? latestCharge : (latestCharge?.id || null);
      const stripeReceiptUrl = typeof latestCharge === 'object' && latestCharge ? (latestCharge.receipt_url || null) : null;

      // Serialize on the PI (same lock namespace as confirmInvoicePayment
      // and the succeeded-webhook handler) and collapse idempotency
      // replays: when Stripe returns an already-created PaymentIntent —
      // overlapping cron instances sharing a durable key, or a re-run
      // after an ambiguous failure — exactly one paid/processing ledger
      // row may exist for it.
      const paymentRecord = await db.transaction(async (trx) => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', String(paymentIntent.id)],
        );

        const existing = await trx('payments')
          .where({ stripe_payment_intent_id: paymentIntent.id })
          .whereIn('status', ['paid', 'processing'])
          .first();
        if (existing) {
          logger.warn(`[stripe] PI ${paymentIntent.id} already recorded (payment ${existing.id}) — idempotency replay, returning existing row`);
          return existing;
        }

        const [row] = await trx('payments').insert({
          customer_id: customerId,
          payment_method_id: card.id,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: stripeChargeId,
          payment_date: etDateString(),
          amount: totalAmount,
          base_amount_cents: baseCents,
          surcharge_amount_cents: surchargeCents,
          surcharge_rate_bps: rateBps,
          surcharge_policy_version: policyVersion,
          card_funding: card.card_funding || null,
          card_brand: card.card_brand || null,
          status,
          description: surchargeAmount > 0
            ? `${description} (includes $${surchargeAmount.toFixed(2)} credit card surcharge)`
            : description,
          metadata: JSON.stringify({
            stripe_receipt_url: stripeReceiptUrl,
            base_amount: baseAmount,
            card_surcharge: surchargeAmount,
            surcharge_rate_bps: rateBps,
            surcharge_policy_version: policyVersion,
          }),
        }).returning('*');
        return row;
      });

      logger.info(`[stripe] Charge processed: base=$${baseAmount} surcharge=$${surchargeAmount} total=$${totalAmount} for ${customerId}, PI: ${paymentIntent.id}`);
      return paymentRecord;
    } catch (dbErr) {
      // CRITICAL: Stripe charged the customer but our payments-table
      // write failed. Returning a synthetic success record (the prior
      // behavior) was unsafe — the autopay cron treated it as success
      // and on a real DB outage the next retry-sweep run would charge
      // the customer AGAIN since no payments row exists to dedupe
      // against.
      //
      // Recovery plan:
      //   1. Insert into stripe_orphan_charges so an admin queue can
      //      drive manual reconciliation. Uses minimal columns so it's
      //      far less likely to hit the same constraint that broke the
      //      `payments` insert.
      //   2. Throw with code='STRIPE_CHARGED_DB_FAILED' so the autopay
      //      cron's catch block can detect this case and skip retry
      //      scheduling (retry would double-charge).
      //   3. The PI id rides on the error so the cron can include it
      //      in the admin alert.
      logger.error(`[stripe] CRITICAL: Charge succeeded (PI: ${paymentIntent.id}) but DB insert failed: ${dbErr.message}`);
      // latest_charge is now expanded to a Charge object (we passed
      // expand:['latest_charge'] on create), but stripe_orphan_charges
      // .stripe_charge_id is a string column. Read defensively so the
      // reconciliation row carries the real charge id either way.
      const orphanLatestCharge = paymentIntent.latest_charge;
      const orphanChargeId = typeof orphanLatestCharge === 'string'
        ? orphanLatestCharge
        : (orphanLatestCharge?.id || null);
      try {
        await db('stripe_orphan_charges').insert({
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: orphanChargeId,
          customer_id: customerId,
          amount: totalAmount,
          source: metadata?.type === 'monthly_autopay' ? 'autopay_charge' : 'manual_charge',
          original_db_error: String(dbErr.message).slice(0, 1000),
        });
      } catch (orphanErr) {
        // Belt-and-suspenders failure — even the orphan record write
        // failed. Log loud; the only durable trail at this point is
        // Stripe's side + this log line.
        logger.error(`[stripe] DOUBLE FAILURE: orphan-charges insert also failed for PI ${paymentIntent.id}: ${orphanErr.message}`);
      }
      const err = new Error(`Stripe charge ${paymentIntent.id} succeeded but DB insert failed`);
      err.code = 'STRIPE_CHARGED_DB_FAILED';
      err.stripePaymentIntentId = paymentIntent.id;
      err.amount = totalAmount;
      throw err;
    }
  },

  // =========================================================================
  // CHARGE MONTHLY
  // =========================================================================

  /**
   * Charge monthly_rate from the customers table (autopay)
   */
  /**
   * @param {string} [idempotencyKey] — override the default day-scoped
   *   key. The retry sweep MUST pass its rung-scoped key here: two
   *   distinct failed monthly rows retried on the same ET day would
   *   otherwise share the date key and replay one PaymentIntent while
   *   both originals get marked superseded.
   */
  async chargeMonthly(customerId, idempotencyKey = null) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const description = `${customer.waveguard_tier || 'WaveGuard'} WaveGuard Monthly — ${customer.first_name} ${customer.last_name}`;
    // Default durable scope: one autopay charge per customer per ET day
    // is the business rule for the daily cron (its month-window guard
    // enforces the broader cadence). Overlapping cron instances replay
    // the same PI.
    const effectiveKey = idempotencyKey || `autopay_monthly_${customerId}_${etDateString()}`;
    return this.charge(customerId, customer.monthly_rate, description, {
      type: 'monthly_autopay',
      tier: customer.waveguard_tier || '',
    }, effectiveKey);
  },

  // =========================================================================
  // CHARGE ONE-TIME
  // =========================================================================

  /**
   * Process a one-time charge (add-on service, event, etc.)
   * @param {string} [idempotencyKey] — durable-operation key (see charge());
   *   omitted for ad-hoc admin charges, where the random fallback applies.
   */
  async chargeOneTime(customerId, amount, description, idempotencyKey = null) {
    return this.charge(customerId, amount, description, { type: 'one_time' }, idempotencyKey);
  },

  // =========================================================================
  // CHARGE AN INVOICE WITH A SPECIFIC SAVED CARD (admin-side)
  // =========================================================================

  /**
   * Charge a specific payment_methods row against an open invoice.
   * Used by the admin MobilePaymentSheet "Card on File" flow when the
   * tech wants to collect from a card the customer already consented
   * to save — distinct from the generic default-autopay-card path in
   * charge() above.
   *
   * @param {string} invoiceId — invoices.id
   * @param {string} paymentMethodId — payment_methods.id (our internal UUID)
   * @returns {object} payments row
   */
  async chargeInvoiceWithSavedCard(invoiceId, paymentMethodId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);
    // Third-party Bill-To: never charge a card on file for a payer-billed
    // invoice — the saved card belongs to invoice.customer_id (the homeowner),
    // but this bill is the payer's. AR routes to the payer AP inbox.
    if (invoice.payer_id) {
      throw new Error('Invoice is billed to a third-party payer — collect from the payer, not a saved card on the service account');
    }

    const card = await db('payment_methods').where({ id: paymentMethodId }).first();
    if (!card) throw new Error('Payment method not found');
    if (card.customer_id !== invoice.customer_id) {
      throw new Error('Payment method does not belong to invoice customer');
    }
    if (!card.stripe_payment_method_id) {
      throw new Error('Payment method has no Stripe id');
    }

    const stripeCustomerId = await this.ensureStripeCustomer(invoice.customer_id);

    // Link the PI to the invoice + write the payments-table ledger row.
    // BOTH writes happen after Stripe has already accepted the charge,
    // so a DB failure here leaves a Stripe-collected payment with no
    // local record (orphan PI). Keep the invoice row locked through the
    // Stripe call so ACH processing cannot race in and make this a second
    // collection path for the same invoice.
    let paymentIntent;
    let status;
    let paymentRecord;
    let base;
    let surcharge;
    let total;
    try {
      await db.transaction(async (trx) => {
        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceId })
          .forUpdate()
          .first();
        if (!lockedInvoice) throw new Error('Invoice not found');
        assertInvoiceCollectible(lockedInvoice.status);
        if (lockedInvoice.stripe_payment_intent_id) {
          const activePayment = await trx('payments')
            .where({ stripe_payment_intent_id: lockedInvoice.stripe_payment_intent_id })
            .first();
          const terminalStatuses = ['failed', 'canceled', 'cancelled', 'refunded'];
          if (activePayment && !terminalStatuses.includes(activePayment.status)) {
            throw new Error('Invoice has a different active payment');
          }
          if (!activePayment) {
            const activeIntent = await stripe.paymentIntents.retrieve(lockedInvoice.stripe_payment_intent_id);
            const cancellableStatuses = ['requires_payment_method', 'requires_confirmation', 'canceled'];
            if (!cancellableStatuses.includes(activeIntent.status)) {
              throw new Error('Invoice has a different active payment');
            }
            if (activeIntent.status !== 'canceled') {
              await stripe.paymentIntents.cancel(activeIntent.id);
            }
          }
        }

        // On-demand funding fetch for legacy cards missing card_funding
        if (card.method_type === 'card' && !card.card_funding && card.stripe_payment_method_id) {
          try {
            const pmObj = await stripe.paymentMethods.retrieve(card.stripe_payment_method_id);
            const fetchedFunding = pmObj.card?.funding || null;
            if (fetchedFunding) {
              card.card_funding = fetchedFunding;
              await trx('payment_methods').where({ id: card.id }).update({
                card_funding: fetchedFunding,
                card_funding_checked_at: new Date(),
              });
              logger.info(`[stripe] Backfilled card_funding=${fetchedFunding} for card ${card.id}`);
            }
          } catch (fetchErr) {
            logger.warn(`[stripe] Could not fetch funding for card ${card.id}: ${fetchErr.message}`);
          }
        }

        const chargeInfo = computeChargeAmount(parseFloat(lockedInvoice.total), card.method_type, { funding: card.card_funding });
        const { baseCents: invBaseCents, surchargeCents: invSurchargeCents, totalCents: invTotalCents, rateBps: invRateBps, policyVersion: invPolicyVersion } = chargeInfo;
        base = invBaseCents / 100;
        surcharge = invSurchargeCents / 100;
        total = invTotalCents / 100;

        const invSurchargeDetails = buildSurchargeAmountDetails(invSurchargeCents);

        // Idempotency-Key bound to invoice + amount + pm + 60-second
        // bucket. The bucket dedupes a double-click within the same
        // minute (we'd reuse the existing PI instead of charging twice)
        // but lets a deliberate admin retry a minute later get a fresh
        // attempt — Stripe replays cached responses for ~24 h on reused
        // keys, including failures, so a deterministic key would freeze
        // the admin "Charge card on file" flow on a transient decline
        // until the cache TTL expired (Codex P2 #490). Amount + pm
        // components mean re-totaling the invoice or switching cards
        // also yields a fresh key as expected.
        const minuteBucket = Math.floor(Date.now() / 60_000);
        const idempotencyKey = `inv_card_on_file_${invoiceId}_${invTotalCents}_${card.id}_${minuteBucket}`;
        const invPiParams = {
          amount: invTotalCents,
          currency: 'usd',
          customer: stripeCustomerId,
          payment_method: card.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          description: `Invoice ${invoice.invoice_number} — card on file`,
          metadata: {
            waves_invoice_id: invoiceId,
            invoice_number: invoice.invoice_number,
            waves_customer_id: invoice.customer_id,
            base_amount: String(base),
            card_surcharge: String(surcharge),
            surcharge_rate_bps: String(invRateBps),
            surcharge_policy_version: invPolicyVersion,
            source: 'admin_card_on_file',
          },
        };
        if (invSurchargeDetails) invPiParams.amount_details = invSurchargeDetails;
        paymentIntent = await stripe.paymentIntents.create(
          invPiParams,
          invSurchargeDetails
            ? { idempotencyKey, apiVersion: SURCHARGE_API_VERSION }
            : { idempotencyKey },
        );

        status = paymentIntent.status === 'succeeded' ? 'paid' : 'processing';

        const invoiceRowsUpdated = await trx('invoices')
          .where({ id: invoiceId })
          .whereNotIn('status', ['paid', 'processing'])
          .update({
            status,
            paid_at: status === 'paid' ? new Date().toISOString() : null,
            processor: 'stripe',
            stripe_payment_intent_id: paymentIntent.id,
            stripe_charge_id: paymentIntent.latest_charge || null,
            payment_method: 'card',
            card_brand: card.card_brand || null,
            card_last_four: card.last_four || null,
            total,
          });
        if (!invoiceRowsUpdated) throw new Error('Invoice is no longer collectible');

        [paymentRecord] = await trx('payments').insert({
          customer_id: invoice.customer_id,
          payment_method_id: card.id,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: paymentIntent.latest_charge || null,
          payment_date: etDateString(),
          amount: total,
          base_amount_cents: invBaseCents,
          surcharge_amount_cents: invSurchargeCents,
          surcharge_rate_bps: invRateBps,
          surcharge_policy_version: invPolicyVersion,
          card_funding: card.card_funding || null,
          card_brand: card.card_brand || null,
          status,
          description: surcharge > 0
            ? `Invoice ${invoice.invoice_number} — card on file (includes $${surcharge.toFixed(2)} credit card surcharge)`
            : `Invoice ${invoice.invoice_number} — card on file`,
          metadata: JSON.stringify({
            base_amount: base,
            card_surcharge: surcharge,
            surcharge_rate_bps: invRateBps,
            surcharge_policy_version: invPolicyVersion,
            source: 'admin_card_on_file',
          }),
        }).returning('*');
      });
    } catch (err) {
      if (!paymentIntent) {
        if ([
          'Invoice not found',
          'Invoice already paid',
          'Bank payment is already processing',
          'Invoice is void and cannot be paid',
          'Invoice has been refunded and cannot be paid',
          'Invoice is canceled and cannot be paid',
          'Invoice has a different active payment',
        ].includes(err.message)) {
          throw err;
        }
        logger.error(`[stripe] chargeInvoiceWithSavedCard failed for invoice ${invoice.invoice_number}: ${err.message}`);
        try {
          await db('payments').insert({
            customer_id: invoice.customer_id,
            payment_method_id: card.id,
            processor: 'stripe',
            payment_date: etDateString(),
            amount: total,
            status: 'failed',
            description: `Invoice ${invoice.invoice_number} — card on file (FAILED)`,
            failure_reason: err.message,
          });
        } catch { /* non-fatal */ }
        throw new Error(err.message || 'Card charge failed');
      }

      logger.error(`[stripe] CRITICAL: chargeInvoiceWithSavedCard succeeded at Stripe (PI ${paymentIntent.id}) but DB write failed: ${err.message}`);
      try {
        await db('stripe_orphan_charges').insert({
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: paymentIntent.latest_charge || null,
          customer_id: invoice.customer_id,
          invoice_id: invoiceId,
          amount: total,
          source: 'invoice_card_on_file',
          original_db_error: String(err.message).slice(0, 1000),
        });
      } catch (orphanErr) {
        logger.error(`[stripe] DOUBLE FAILURE: orphan-charges insert also failed for PI ${paymentIntent.id}: ${orphanErr.message}`);
      }
      const chargedErr = new Error(`Stripe charge ${paymentIntent.id} succeeded but DB write failed for invoice ${invoice.invoice_number}`);
      chargedErr.code = 'STRIPE_CHARGED_DB_FAILED';
      chargedErr.stripePaymentIntentId = paymentIntent.id;
      chargedErr.amount = total;
      throw chargedErr;
    }

    logger.info(`[stripe] Card-on-file charge succeeded: $${total} for invoice ${invoice.invoice_number}, PI ${paymentIntent.id}`);
    if (status === 'paid') {
      try {
        await require('./invoice-followups').stopOnPayment(invoiceId);
      } catch (err) {
        logger.error(`[invoice-followups] stopOnPayment failed for card-on-file invoice ${invoiceId}: ${err.message}`);
      }
      try {
        await require('./annual-prepay-renewals').syncTermForInvoicePayment({
          id: invoiceId,
          status: 'paid',
          paid_at: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`[annual-prepay] activation failed for card-on-file invoice ${invoiceId}: ${err.message}`);
      }

      try {
        const ReceiptDeliveryQueue = require('./receipt-delivery-queue');
        await ReceiptDeliveryQueue.enqueueReceiptDelivery({
          invoiceId,
          stripePaymentIntentId: paymentIntent.id,
          source: 'card_on_file',
        });
        ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain({ delayMs: 1000, limit: 5 });
      } catch (err) {
        logger.error(`[stripe] Card-on-file receipt queue failed for invoice ${invoice.invoice_number}: ${err.message}`);
      }
    }

    return {
      paymentId: paymentRecord.id,
      paymentIntentId: paymentIntent.id,
      status,
      amount: total,
      base,
      surcharge,
      last4: card.last_four,
      brand: card.card_brand,
    };
  },

  // =========================================================================
  // PAYMENT HISTORY
  // =========================================================================

  /**
   * Get payment history with payment method details (both processors)
   */
  async getPaymentHistory(customerId, limit = 20, offset = 0) {
    let q = db('payments')
      .where({ 'payments.customer_id': customerId })
      .leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id')
      .select(
        'payments.*',
        'payment_methods.card_brand',
        'payment_methods.last_four',
        'payment_methods.processor as pm_processor',
        'payment_methods.method_type',
        'payment_methods.bank_name'
      )
      .orderBy('payments.payment_date', 'desc')
      .limit(limit);
    if (offset > 0) q = q.offset(offset);
    return q;
  },

  // =========================================================================
  // REFUND
  // =========================================================================

  /**
   * Full or partial refund via Stripe.
   * @param {string} paymentId — Waves payment UUID
   * @param {{ amount?: number, reason?: string }} options
   * @returns {object} updated payment row
   */
  async refund(paymentId, { amount, reason } = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const payment = await db('payments').where({ id: paymentId }).first();
    if (!payment) throw new Error('Payment not found');

    if (payment.processor !== 'stripe' || !payment.stripe_payment_intent_id) {
      throw new Error('Payment is not a Stripe payment — cannot refund via Stripe');
    }

    try {
      const refundParams = {
        payment_intent: payment.stripe_payment_intent_id,
        reason: reason || 'requested_by_customer',
      };

      if (amount) {
        refundParams.amount = Math.round(amount * 100);
      }

      const refund = await stripe.refunds.create(refundParams);

      const refundAmountDollars = amount || parseFloat(payment.amount);
      const isFullRefund = refundAmountDollars >= parseFloat(payment.amount);

      await db('payments')
        .where({ id: paymentId })
        .update({
          status: isFullRefund ? 'refunded' : 'paid',
          refund_amount: refundAmountDollars,
          refund_status: refund.status,
          stripe_refund_id: refund.id,
        });

      if (isFullRefund) {
        try {
          await require('./annual-prepay-renewals').syncTermForRefundedPayment(payment);
        } catch (syncErr) {
          logger.error(`[annual-prepay] refund sync failed for payment ${paymentId}: ${syncErr.message}`);
        }
      }

      const updated = await db('payments').where({ id: paymentId }).first();
      PaymentLifecycleEmail.sendRefundIssued({
        customerId: updated?.customer_id || payment.customer_id,
        paymentId,
        refundId: refund.id,
        refundAmount: refundAmountDollars,
        refundDate: refund.created ? new Date(refund.created * 1000) : new Date(),
        refundReason: reason || 'Account adjustment',
      }).catch((emailErr) => {
        logger.warn(`[stripe] Refund issued email failed for payment ${paymentId}: ${emailErr.message}`);
      });
      logger.info(`[stripe] Refund processed: $${refundAmountDollars} for payment ${paymentId}, refund ${refund.id}`);
      return updated;
    } catch (err) {
      logger.error(`[stripe] Refund failed for payment ${paymentId}: ${err.message}`);
      throw new Error('Refund processing failed');
    }
  },

  // =========================================================================
  // INVOICE PAYMENT — PaymentIntent for /pay/:token page
  // =========================================================================

  /**
   * Create a PaymentIntent for an invoice amount (public pay page).
   *
   * When `saveCard` is true we attach the Stripe customer and set
   * `setup_future_usage: 'off_session'` so the payment method is retained
   * after the charge succeeds. Customer attachment is required for
   * Stripe to persist the pm — we only do it when the customer has
   * explicitly opted in on the pay page.
   *
   * @param {string} invoiceId
   * @param {{ saveCard?: boolean }} [opts]
   */
  async createInvoicePaymentIntent(invoiceId, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);
    // Phase 2: an accrued invoice is payable ONLY through its consolidated
    // statement — never mint an individual PaymentIntent for it (it would
    // double-collect once the statement settles).
    if (invoice.payer_statement_id) {
      throw new Error('Invoice is billed on the payer’s monthly statement — pay the statement, not the individual invoice');
    }

    // Never save the payer's payment method onto the homeowner's account.
    // For a third-party-billed invoice the person paying is the builder/AP
    // contact, not invoice.customer_id — opting them into "save card" would
    // attach their card to the homeowner for future off-session charges.
    const saveCard = !!opts.saveCard && !invoice.payer_id;
    const stripeCustomerId = saveCard && invoice.customer_id
      ? await this.ensureStripeCustomer(invoice.customer_id)
      : null;

    let paymentIntent;
    let baseAmount;
    let cardSurcharge;
    let cardTotal;
    try {
      const methodMode = 'cardonly';
      await db.transaction(async (trx) => {
        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceId })
          .forUpdate()
          .first();
        if (!lockedInvoice) throw new Error('Invoice not found');
        assertInvoiceCollectible(lockedInvoice.status);

        baseAmount = parseFloat(lockedInvoice.total);
        // PI starts at BASE amount only — no surcharge at setup time.
        // Card payments: surcharge is applied via the /quote → /finalize two-step flow.
        // Express Checkout (wallets): intentionally base-only in phase 1 (no surcharge).
        // ACH: no surcharge by design.
        // The legacy setup→confirmPayment→/confirm path charges whatever the PI
        // amount is at confirm time — if a card payment bypasses /quote+/finalize,
        // it would charge base-only (under-collect). The PayPageV2 UI prevents
        // this by routing all card submissions through the two-step flow.
        cardSurcharge = 0;
        cardTotal = baseAmount;
        const baseCents = Math.round(baseAmount * 100);

        const piParams = {
          amount: baseCents,
          currency: 'usd',
          description: `Invoice ${lockedInvoice.invoice_number} — ${lockedInvoice.title || 'Waves Pest Control'}`,
          metadata: {
            waves_invoice_id: invoiceId,
            invoice_number: lockedInvoice.invoice_number,
            waves_customer_id: lockedInvoice.customer_id,
            base_amount: String(baseAmount),
            card_surcharge: '0',
            save_card_opt_in: saveCard ? 'true' : 'false',
            selected_method_category: 'card',
          },
          payment_method_types: ['card'],
        };

        if (stripeCustomerId) {
          piParams.customer = stripeCustomerId;
          piParams.setup_future_usage = 'off_session';
        }

        if (lockedInvoice.stripe_payment_intent_id) {
          const activePayment = await trx('payments')
            .where({ stripe_payment_intent_id: lockedInvoice.stripe_payment_intent_id })
            .first();
          const terminalStatuses = ['failed', 'canceled', 'cancelled', 'refunded'];
          if (activePayment && !terminalStatuses.includes(activePayment.status)) {
            const err = new Error('Invoice payment is already in progress');
            err.statusCode = 409;
            throw err;
          }

          const activeIntent = await stripe.paymentIntents.retrieve(lockedInvoice.stripe_payment_intent_id);
          const activeIntentInvoiceId = activeIntent.metadata?.waves_invoice_id || null;
          if (activeIntentInvoiceId && String(activeIntentInvoiceId) !== String(invoiceId)) {
            throw new Error('PaymentIntent does not belong to this invoice');
          }

          if (activeIntent.status === 'requires_payment_method') {
            const updateParams = { ...piParams };
            delete updateParams.currency;
            if (!stripeCustomerId) {
              updateParams.setup_future_usage = '';
            }
            paymentIntent = await stripe.paymentIntents.update(activeIntent.id, updateParams);
            const invoiceUpdated = await trx('invoices')
              .where({ id: invoiceId })
              .whereNotIn('status', ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'])
              .update({
                processor: 'stripe',
                stripe_payment_intent_id: paymentIntent.id,
              });
            if (!invoiceUpdated) throw new Error('Invoice is no longer collectible');
            return;
          }

          if (activeIntent.status !== 'canceled') {
            const err = new Error('Invoice payment is already in progress');
            err.statusCode = 409;
            throw err;
          }
        }

        // Include the currently stored PI id in the key so a replacement
        // setup cannot replay an older canceled intent for this invoice.
        const sourceIntent = lockedInvoice.stripe_payment_intent_id || 'new';
        const idempotencyKey = `invoice_pi_${invoiceId}_${baseCents}_${saveCard ? 'save' : 'nosave'}_${methodMode}_${sourceIntent}`;
        paymentIntent = await stripe.paymentIntents.create(piParams, { idempotencyKey });

        if (paymentIntent.status === 'canceled') {
          logger.warn(`[stripe] Stripe replayed canceled PI ${paymentIntent.id} for invoice ${lockedInvoice.invoice_number}; minting replacement`);
          paymentIntent = await stripe.paymentIntents.create(piParams, {
            idempotencyKey: `${idempotencyKey}_replacement_${uuidv4()}`,
          });
        }
        if (paymentIntent.status === 'canceled') {
          throw new Error(`Stripe returned canceled PaymentIntent ${paymentIntent.id}`);
        }

        const invoiceUpdated = await trx('invoices')
          .where({ id: invoiceId })
          .whereNotIn('status', ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'])
          .update({
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
        });
        if (!invoiceUpdated) throw new Error('Invoice is no longer collectible');
      });

      logger.info(`[stripe] Invoice PaymentIntent created: ${paymentIntent.id} for invoice ${invoice.invoice_number} (base=$${baseAmount})`);
      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: baseAmount,
        baseAmount,
        cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
        surchargeRateBps: CONFIGURED_COST_BPS,
      };
    } catch (err) {
      if (err.statusCode) {
        logger.warn(`[stripe] Invoice PaymentIntent setup blocked for invoice ${invoiceId}: ${err.message}`);
        throw err;
      }
      if (paymentIntent?.id) {
        try {
          const currentInvoice = await db('invoices').where({ id: invoiceId }).first();
          if (String(currentInvoice?.stripe_payment_intent_id || '') !== String(paymentIntent.id)) {
            await stripe.paymentIntents.cancel(paymentIntent.id);
          }
        } catch (cancelErr) {
          logger.warn(`[stripe] Could not cancel unlinked invoice PI ${paymentIntent.id}: ${cancelErr.message}`);
        }
      }
      logger.error(`[stripe] Invoice PaymentIntent failed for invoice ${invoiceId}: ${err.type || 'Error'} — ${err.message}${err.code ? ` [code=${err.code}]` : ''}${err.param ? ` [param=${err.param}]` : ''}`);
      throw new Error(`Failed to create payment intent for invoice: ${err.message}`);
    }
  },

  /**
   * Update an open invoice PaymentIntent's method category.
   *
   * Both card and ACH keep the PI at base amount — no surcharge at this stage.
   * Surcharge is calculated at /quote and applied at /finalize after PM funding
   * is confirmed.
   *
   * @param {string} invoiceId
   * @param {string} paymentIntentId
   * @param {string} methodCategory — Stripe Payment Element "change" event type
   *   (e.g. 'card', 'us_bank_account', 'apple_pay', 'google_pay', 'link')
   */
  async updateInvoicePaymentIntentMethod(invoiceId, paymentIntentId, methodCategory, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);
    if (!invoice.stripe_payment_intent_id
      || String(invoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
      throw new Error('PaymentIntent does not belong to this invoice');
    }

    // Never save a third-party payer's card onto the homeowner account (see
    // createInvoicePaymentIntent) — the AP user can toggle this after the
    // Element loads, so guard the update path too.
    const saveCard = !!opts.saveCard && !invoice.payer_id;
    const selectedMethodCategory = methodCategory || 'card';
    const base = parseFloat(invoice.total);
    const baseCents = Math.round(base * 100);

    // Lock the PI to the selected tender family before Stripe can confirm.
    // The pay page exposes Card/ACH with its own selector; Stripe Elements
    // then refreshes to the one tender family that matches this amount.
    const paymentMethodTypes = isCardMethodType(selectedMethodCategory)
      ? ['card']
      : ['us_bank_account'];

    const updateParams = {
      amount: baseCents,
      payment_method_types: paymentMethodTypes,
      metadata: {
        waves_invoice_id: invoiceId,
        invoice_number: invoice.invoice_number,
        base_amount: String(base),
        card_surcharge: '0',
        selected_method_category: String(selectedMethodCategory),
        save_card_opt_in: saveCard ? 'true' : 'false',
      },
    };

    // saveCard requires a Stripe customer on the PI. Attach on first opt-in,
    // set SFU accordingly. Unticking after opting in clears SFU (''), but we
    // leave the customer attached — unsetting it isn't supported and it's
    // harmless once the PI is consumed.
    if (saveCard && invoice.customer_id) {
      updateParams.customer = await this.ensureStripeCustomer(invoice.customer_id);
      updateParams.setup_future_usage = 'off_session';
    } else {
      updateParams.setup_future_usage = '';
    }

    try {
      const paymentIntent = await stripe.paymentIntents.update(paymentIntentId, updateParams);
      logger.info(`[stripe] PI ${paymentIntentId} updated → base=$${base} surcharge=0 total=$${base} (method=${selectedMethodCategory})`);
      return {
        paymentIntentId: paymentIntent.id,
        base,
        surcharge: 0,
        total: base,
        cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
        surchargeRateBps: CONFIGURED_COST_BPS,
      };
    } catch (err) {
      // A prior confirm attempt (e.g. an abandoned ACH entry) can leave an
      // incompatible PaymentMethod attached to the PI, so narrowing
      // payment_method_types to the newly selected tender is rejected. Recover
      // by minting a fresh PI for the selected tender — a new PI has no
      // attached PM, so the lock applies cleanly and the surcharge-bypass
      // defense is preserved.
      if (isIncompatibleAttachedMethodError(err)) {
        logger.warn(
          `[stripe] PI ${paymentIntentId} tender switch blocked by attached PM; `
          + `recreating for method=${selectedMethodCategory}`,
        );
        return this.replaceInvoicePaymentIntentForTender(invoiceId, paymentIntentId, {
          paymentMethodTypes,
          metadata: updateParams.metadata,
          customer: updateParams.customer || null,
          setupFutureUsage: updateParams.setup_future_usage,
          base,
          baseCents,
          methodCategory: selectedMethodCategory,
        });
      }
      logger.error(`[stripe] PI update failed for ${paymentIntentId}: ${err.message}`);
      throw new Error(`Failed to update payment amount: ${err.message}`);
    }
  },

  /**
   * Cancel a stale invoice PaymentIntent and mint a fresh one locked to the
   * selected tender. Used when a tender switch can't be applied in place
   * because an incompatible PaymentMethod is still attached to the old PI.
   *
   * Returns the same shape as updateInvoicePaymentIntentMethod plus the new
   * `clientSecret` and `replaced: true` so the pay page can re-mount Stripe
   * Elements against the fresh PI.
   */
  async replaceInvoicePaymentIntentForTender(invoiceId, oldPaymentIntentId, ctx) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const { paymentMethodTypes, metadata, customer, setupFutureUsage, base, baseCents, methodCategory } = ctx;

    // Inspect the stale PI before touching it. Fail CLOSED: only replace when
    // we positively know the old PI is in a cancelable (or already-canceled)
    // state. If its status can't be read, or it's processing/succeeded (money
    // in flight), do NOT detach it — repointing the invoice off an in-flight
    // ACH PI would let the customer pay the replacement while the original
    // bank debit is still pending.
    let oldIntent = null;
    try {
      oldIntent = await stripe.paymentIntents.retrieve(oldPaymentIntentId);
    } catch (retrieveErr) {
      logger.warn(`[stripe] Could not retrieve stale PI ${oldPaymentIntentId} during tender switch: ${retrieveErr.message}`);
    }
    if (!oldIntent) {
      // Status unknown — surface as a hard error (visible to ops) and never
      // replace blind.
      throw new Error(`Could not verify the existing payment status for PI ${oldPaymentIntentId}`);
    }
    if (oldIntent.status !== 'canceled' && !REPLACEABLE_PI_STATUSES.has(oldIntent.status)) {
      const err = new Error('Payment is already in progress. Please refresh the invoice and try again.');
      err.statusCode = 409;
      throw err;
    }

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');

    const piParams = {
      amount: baseCents,
      currency: 'usd',
      description: `Invoice ${invoice.invoice_number} — ${invoice.title || 'Waves Pest Control'}`,
      metadata,
      payment_method_types: paymentMethodTypes,
    };
    if (customer) {
      piParams.customer = customer;
      if (setupFutureUsage) piParams.setup_future_usage = setupFutureUsage;
    }

    let newIntent;
    await db.transaction(async (trx) => {
      const lockedInvoice = await trx('invoices')
        .where({ id: invoiceId })
        .forUpdate()
        .first();
      if (!lockedInvoice) throw new Error('Invoice not found');
      assertInvoiceCollectible(lockedInvoice.status);
      // Guard against a racing setup/replace having already repointed the PI.
      if (String(lockedInvoice.stripe_payment_intent_id || '') !== String(oldPaymentIntentId)) {
        const err = new Error('Payment session changed. Please refresh the invoice and try again.');
        err.statusCode = 409;
        throw err;
      }

      // Cancel before repointing the invoice. If the old PI races into
      // processing after the status read above, Stripe will reject this cancel;
      // failing here keeps the invoice bound to the in-flight payment instead
      // of orphaning a bank debit behind a fresh card PI.
      if (oldIntent.status !== 'canceled') {
        try {
          await stripe.paymentIntents.cancel(oldPaymentIntentId);
        } catch (cancelErr) {
          logger.warn(`[stripe] Could not cancel stale PI ${oldPaymentIntentId} during tender switch: ${cancelErr.message}`);
          const err = new Error('Payment is already in progress. Please refresh the invoice and try again.');
          err.statusCode = 409;
          throw err;
        }
      }

      const saveFlag = metadata?.save_card_opt_in === 'true' ? 'save' : 'nosave';
      newIntent = await stripe.paymentIntents.create(piParams, {
        idempotencyKey: `invoice_pi_replace_${invoiceId}_${oldPaymentIntentId}_${paymentMethodTypes.join('-')}_${saveFlag}`,
      });

      const invoiceUpdated = await trx('invoices')
        .where({ id: invoiceId })
        .whereNotIn('status', ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'])
        .update({ processor: 'stripe', stripe_payment_intent_id: newIntent.id });
      if (!invoiceUpdated) throw new Error('Invoice is no longer collectible');
    });

    logger.info(
      `[stripe] Replaced PI ${oldPaymentIntentId} → ${newIntent.id} for invoice ${invoice.invoice_number} `
      + `(method=${methodCategory}, base=$${base})`,
    );
    return {
      paymentIntentId: newIntent.id,
      clientSecret: newIntent.client_secret,
      replaced: true,
      base,
      surcharge: 0,
      total: base,
      cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
      surchargeRateBps: CONFIGURED_COST_BPS,
    };
  },

  /**
   * Quote the surcharge for a specific payment method on an invoice.
   * Returns the breakdown and a quoteToken for /finalize.
   */
  async quoteInvoiceSurcharge(invoiceId, paymentMethodId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);

    // Retrieve the PM from Stripe to get real-time funding type
    let pm;
    try {
      pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    } catch (err) {
      throw new Error(`Could not retrieve payment method: ${err.message}`);
    }

    const methodType = pm.type || 'card';
    const funding = pm.card?.funding || null;
    const baseAmount = parseFloat(invoice.total);

    const chargeInfo = computeChargeAmount(baseAmount, methodType, { funding });
    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = chargeInfo;

    // Create an HMAC-signed quote token for /finalize
    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    const payloadJson = JSON.stringify({
      invoiceId,
      paymentMethodId,
      invoiceTotal: baseAmount,
      quotedAt: Date.now(),
    });
    const signature = crypto.createHmac('sha256', hmacSecret).update(payloadJson).digest('base64url');
    const quoteToken = `${Buffer.from(payloadJson).toString('base64url')}.${signature}`;

    return {
      quoteToken,
      base: baseCents / 100,
      surcharge: surchargeCents / 100,
      total: totalCents / 100,
      rateBps,
      funding,
      methodType,
    };
  },

  /**
   * Finalize an invoice payment with the surcharge from a prior /quote.
   * Updates the PI amount to include surcharge, then confirms.
   */
  async finalizeInvoicePayment(invoiceId, quoteToken, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    // Decode and verify the HMAC-signed quote token
    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    let quote;
    try {
      const [payloadPart, sigPart] = quoteToken.split('.');
      if (!payloadPart || !sigPart) throw new Error('malformed');
      const expectedSig = crypto.createHmac('sha256', hmacSecret).update(Buffer.from(payloadPart, 'base64url').toString()).digest('base64url');
      if (sigPart !== expectedSig) throw new Error('signature mismatch');
      quote = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    } catch {
      throw new Error('Invalid or tampered quote token');
    }

    if (String(quote.invoiceId) !== String(invoiceId)) {
      throw new Error('Quote token does not match this invoice');
    }

    // Quote tokens expire after 10 minutes
    if (Date.now() - (quote.quotedAt || 0) > 10 * 60 * 1000) {
      throw new Error('Quote expired — please try again');
    }

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);

    if (!invoice.stripe_payment_intent_id) {
      throw new Error('Invoice has no active PaymentIntent');
    }

    // Re-derive charge from PM + invoice — never trust client-provided amounts
    const pm = await stripe.paymentMethods.retrieve(quote.paymentMethodId);
    const funding = pm.card?.funding || null;
    const baseAmount = parseFloat(invoice.total);

    if (quote.invoiceTotal != null && Math.abs(baseAmount - quote.invoiceTotal) > 0.01) {
      throw new Error('Invoice total changed since quote was created. Please request a new quote.');
    }

    const chargeInfo = computeChargeAmount(baseAmount, pm.type || 'card', { funding });
    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = chargeInfo;

    const surchargeDetails = buildSurchargeAmountDetails(surchargeCents);
    const usePreview = !!surchargeDetails;
    // Payer invoices never save the payer's card to the homeowner account.
    const saveCard = !!opts.saveCard && !invoice.payer_id;

    // Update PI with final amount, attach PM, then confirm server-side
    const updateParams = {
      amount: totalCents,
      payment_method: quote.paymentMethodId,
      metadata: {
        waves_invoice_id: invoiceId,
        invoice_number: invoice.invoice_number,
        waves_customer_id: invoice.customer_id,
        base_amount: String(baseCents / 100),
        card_surcharge: String(surchargeCents / 100),
        surcharge_rate_bps: String(rateBps),
        surcharge_policy_version: policyVersion,
        card_funding: funding || 'unknown',
        save_card_opt_in: saveCard ? 'true' : 'false',
      },
    };

    if (surchargeDetails) updateParams.amount_details = surchargeDetails;

    if (saveCard && invoice.customer_id) {
      updateParams.customer = await this.ensureStripeCustomer(invoice.customer_id);
      updateParams.setup_future_usage = 'off_session';
    } else {
      updateParams.setup_future_usage = '';
    }

    try {
      await stripe.paymentIntents.update(
        invoice.stripe_payment_intent_id,
        updateParams,
        usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined,
      );

      // Confirm the PI server-side (attaches PM + charges the card)
      const confirmed = await stripe.paymentIntents.confirm(
        invoice.stripe_payment_intent_id,
        {},
        usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined,
      );

      logger.info(`[stripe] Finalized invoice ${invoice.invoice_number}: funding=${funding} surcharge=${surchargeCents}c total=${totalCents}c PI=${confirmed.id} status=${confirmed.status}`);

      return {
        paymentIntentId: confirmed.id,
        paymentMethodId: quote.paymentMethodId,
        clientSecret: confirmed.client_secret,
        status: confirmed.status,
        requiresAction: confirmed.status === 'requires_action',
        base: baseCents / 100,
        surcharge: surchargeCents / 100,
        total: totalCents / 100,
        rateBps,
        funding,
      };
    } catch (err) {
      logger.error(`[stripe] Finalize failed for PI ${invoice.stripe_payment_intent_id}: ${err.message}`);
      throw new Error(`Failed to finalize payment: ${err.message}`);
    }
  },

  // =========================================================================
  // PAYER STATEMENT PAYMENT (P3) — charges payer.stripe_customer_id, NOT the
  // homeowner. Mirrors the invoice setup → quote → finalize surcharge flow, but
  // keyed on a payer_statements token + status state machine. Statement settles
  // to `paid` (cascade) only via the webhook; a freshly-created PI never moves
  // the statement to `processing` (it stays replaceable until confirmed).
  // =========================================================================

  /**
   * Create (or reuse a replaceable) PaymentIntent for a FROZEN, not-in-flight
   * statement, on the payer's Stripe customer. PI starts at the BASE total (no
   * surcharge) — surcharge is applied via /quote → /finalize once PM funding is
   * known. Does NOT move the statement to `processing` (the webhook does, on the
   * confirmed money-in-flight event), so an abandoned pay page can't lock it.
   */
  async createStatementPaymentIntent(statementId, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    const { isPayableStatementStatus, PAYABLE_STATEMENT_STATUSES } = require('./payer-statement-settle');
    const payableList = [...PAYABLE_STATEMENT_STATUSES];

    const assertPayable = (status) => {
      if (isPayableStatementStatus(status)) return;
      const inFlightOrDone = status === 'processing' || status === 'paid';
      const err = new Error(status === 'processing'
        ? 'A payment is already in progress for this statement'
        : status === 'paid'
          ? 'This statement is already paid'
          : 'This statement is not payable');
      err.statusCode = inFlightOrDone ? 409 : 400;
      throw err;
    };

    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement) throw new Error('Statement not found');
    assertPayable(statement.status);

    const stripeCustomerId = await this.ensureStripePayerCustomer(statement.payer_id);
    const saveCard = !!opts.saveCard; // card-save is OPTIONAL (owner) — off by default

    let paymentIntent;
    let baseAmount;
    try {
      await db.transaction(async (trx) => {
        const locked = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
        if (!locked) throw new Error('Statement not found');
        assertPayable(locked.status);

        baseAmount = parseFloat(locked.total);
        const baseCents = Math.round(baseAmount * 100);

        const piParams = {
          amount: baseCents,
          currency: 'usd',
          customer: stripeCustomerId,
          description: `Waves statement S-${statementId}`,
          metadata: {
            waves_statement_id: String(statementId),
            waves_payer_id: String(locked.payer_id),
            base_amount: String(baseAmount),
            card_surcharge: '0',
            save_card_opt_in: saveCard ? 'true' : 'false',
            selected_method_category: 'card',
            // CLEAR any surcharge-finalization metadata (Stripe metadata updates
            // MERGE) so a reused PI that was previously finalized can't carry a
            // stale surcharge_policy_version — which the webhook guard reads as
            // "finalized" and would settle a later base-only card confirm without
            // surcharge. Empty string deletes the key on update.
            surcharge_policy_version: '',
            surcharge_rate_bps: '',
            card_funding: '',
          },
          payment_method_types: ['card', 'us_bank_account'],
        };
        if (saveCard) piParams.setup_future_usage = 'off_session';

        // Reuse a replaceable unconfirmed PI; cancel-and-replace other
        // unconfirmed states; refuse if money is genuinely in flight.
        if (locked.stripe_payment_intent_id) {
          const activeIntent = await stripe.paymentIntents.retrieve(locked.stripe_payment_intent_id);
          const activeStatementId = activeIntent.metadata?.waves_statement_id || null;
          if (activeStatementId && String(activeStatementId) !== String(statementId)) {
            throw new Error('PaymentIntent does not belong to this statement');
          }
          if (activeIntent.status === 'requires_payment_method') {
            const updateParams = { ...piParams };
            delete updateParams.currency;
            if (!saveCard) updateParams.setup_future_usage = '';
            paymentIntent = await stripe.paymentIntents.update(activeIntent.id, updateParams);
            const reused = await trx('payer_statements').where({ id: statementId }).whereIn('status', payableList)
              .update({ stripe_payment_intent_id: paymentIntent.id, updated_at: trx.fn.now() });
            if (!reused) throw new Error('Statement is no longer payable');
            return;
          }
          if (activeIntent.status !== 'canceled') {
            if (REPLACEABLE_PI_STATUSES.has(activeIntent.status)) {
              // FAIL CLOSED: if the cancel fails, the old PI may have raced into
              // processing/succeeded — minting a replacement while its client
              // secret can still collect would double-charge. Refuse instead of
              // repointing the statement at a new PI.
              try {
                await stripe.paymentIntents.cancel(activeIntent.id);
              } catch (e) {
                logger.warn(`[stripe] could not cancel replaceable statement PI ${activeIntent.id}: ${e.message}`);
                const err = new Error('Could not replace the existing payment — please try again in a moment');
                err.statusCode = 409;
                throw err;
              }
            } else {
              const err = new Error('A payment is already in progress for this statement');
              err.statusCode = 409;
              throw err;
            }
          }
        }

        const sourceIntent = locked.stripe_payment_intent_id || 'new';
        const idempotencyKey = `statement_pi_${statementId}_${baseCents}_${saveCard ? 'save' : 'nosave'}_${sourceIntent}`;
        paymentIntent = await stripe.paymentIntents.create(piParams, { idempotencyKey });
        if (paymentIntent.status === 'canceled') {
          paymentIntent = await stripe.paymentIntents.create(piParams, { idempotencyKey: `${idempotencyKey}_replacement_${uuidv4()}` });
        }
        if (paymentIntent.status === 'canceled') throw new Error(`Stripe returned canceled PaymentIntent ${paymentIntent.id}`);

        const updated = await trx('payer_statements').where({ id: statementId }).whereIn('status', payableList)
          .update({ stripe_payment_intent_id: paymentIntent.id, updated_at: trx.fn.now() });
        if (!updated) throw new Error('Statement is no longer payable');
      });

      logger.info(`[stripe] Statement PaymentIntent created: ${paymentIntent.id} for statement S-${statementId} (base=$${baseAmount})`);
      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: baseAmount,
        baseAmount,
        cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
        surchargeRateBps: CONFIGURED_COST_BPS,
      };
    } catch (err) {
      if (err.statusCode) {
        logger.warn(`[stripe] Statement PaymentIntent setup blocked for S-${statementId}: ${err.message}`);
        throw err;
      }
      if (paymentIntent?.id) {
        try {
          const cur = await db('payer_statements').where({ id: statementId }).first();
          if (String(cur?.stripe_payment_intent_id || '') !== String(paymentIntent.id)) {
            await stripe.paymentIntents.cancel(paymentIntent.id);
          }
        } catch (cancelErr) {
          logger.warn(`[stripe] could not cancel unlinked statement PI ${paymentIntent.id}: ${cancelErr.message}`);
        }
      }
      logger.error(`[stripe] Statement PaymentIntent failed for S-${statementId}: ${err.message}`);
      throw new Error(`Failed to create payment intent for statement: ${err.message}`);
    }
  },

  /**
   * Cancel a statement's PaymentIntent if it is still UNCONFIRMED (requires_*),
   * so an admin offline reconcile can't be undercut by the AP confirming the
   * online PI afterward. Throws 409 if the PI is processing/succeeded (real money
   * in flight ⇒ do NOT reconcile offline). No-op when there's no PI / already
   * canceled / Stripe unconfigured.
   */
  async cancelStatementPaymentIntentIfUnconfirmed(statementId) {
    // Load the statement FIRST — only no-op when there is genuinely no PI to
    // verify. If a PI exists but Stripe is unconfigured we CANNOT confirm it's
    // dead, so fail closed (the AP could still confirm the live client secret).
    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement?.stripe_payment_intent_id) return { canceled: false, reason: 'no_pi' };
    const stripe = getStripe();
    if (!stripe) {
      const err = new Error('Cannot verify the existing online payment intent (Stripe unavailable) — try the reconcile again shortly');
      err.statusCode = 409;
      throw err;
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(statement.stripe_payment_intent_id);
    } catch (e) {
      // FAIL CLOSED: if we can't verify/cancel the existing PI, the AP's client
      // secret may still be confirmable — recording an offline payment now risks
      // double collection once Stripe recovers. Refuse the reconcile.
      logger.warn(`[stripe] could not retrieve statement PI ${statement.stripe_payment_intent_id}: ${e.message}`);
      const err = new Error('Could not verify the existing online payment intent — try the reconcile again shortly');
      err.statusCode = 409;
      throw err;
    }
    if (intent.status === 'canceled') return { canceled: false, reason: 'already_canceled' };
    if (!REPLACEABLE_PI_STATUSES.has(intent.status)) {
      const err = new Error('An online payment is already in progress for this statement — cannot reconcile offline until it resolves');
      err.statusCode = 409;
      throw err;
    }
    await stripe.paymentIntents.cancel(intent.id);
    logger.info(`[stripe] Canceled unconfirmed statement PI ${intent.id} for S-${statementId} ahead of offline reconcile`);
    return { canceled: true, paymentIntentId: intent.id };
  },

  /** Surcharge quote for a statement payment method (HMAC-signed token → /finalize). */
  async quoteStatementSurcharge(statementId, paymentMethodId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    const { isPayableStatementStatus } = require('./payer-statement-settle');

    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement) throw new Error('Statement not found');
    if (!isPayableStatementStatus(statement.status)) throw new Error('This statement is not payable');

    let pm;
    try { pm = await stripe.paymentMethods.retrieve(paymentMethodId); }
    catch (err) { throw new Error(`Could not retrieve payment method: ${err.message}`); }

    const methodType = pm.type || 'card';
    const funding = pm.card?.funding || null;
    const baseAmount = parseFloat(statement.total);
    const { baseCents, surchargeCents, totalCents, rateBps } = computeChargeAmount(baseAmount, methodType, { funding });

    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    const payloadJson = JSON.stringify({ statementId, paymentMethodId, statementTotal: baseAmount, quotedAt: Date.now() });
    const signature = crypto.createHmac('sha256', hmacSecret).update(payloadJson).digest('base64url');
    const quoteToken = `${Buffer.from(payloadJson).toString('base64url')}.${signature}`;

    return { quoteToken, base: baseCents / 100, surcharge: surchargeCents / 100, total: totalCents / 100, rateBps, funding, methodType };
  },

  /** Finalize a statement payment: apply surcharge from the quote to the PI, confirm. */
  async finalizeStatementPayment(statementId, quoteToken, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    const { isPayableStatementStatus } = require('./payer-statement-settle');

    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    let quote;
    try {
      const [payloadPart, sigPart] = quoteToken.split('.');
      if (!payloadPart || !sigPart) throw new Error('malformed');
      const expectedSig = crypto.createHmac('sha256', hmacSecret).update(Buffer.from(payloadPart, 'base64url').toString()).digest('base64url');
      if (sigPart !== expectedSig) throw new Error('signature mismatch');
      quote = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    } catch { throw new Error('Invalid or tampered quote token'); }

    if (String(quote.statementId) !== String(statementId)) throw new Error('Quote token does not match this statement');
    if (Date.now() - (quote.quotedAt || 0) > 10 * 60 * 1000) throw new Error('Quote expired — please try again');

    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement) throw new Error('Statement not found');
    if (!isPayableStatementStatus(statement.status)) throw new Error('This statement is not payable');
    if (!statement.stripe_payment_intent_id) throw new Error('Statement has no active PaymentIntent');

    const pm = await stripe.paymentMethods.retrieve(quote.paymentMethodId);
    const funding = pm.card?.funding || null;
    const baseAmount = parseFloat(statement.total);
    if (quote.statementTotal != null && Math.abs(baseAmount - quote.statementTotal) > 0.01) {
      throw new Error('Statement total changed since quote was created. Please request a new quote.');
    }

    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = computeChargeAmount(baseAmount, pm.type || 'card', { funding });
    const surchargeDetails = buildSurchargeAmountDetails(surchargeCents);
    const usePreview = !!surchargeDetails;
    const saveCard = !!opts.saveCard;

    const updateParams = {
      amount: totalCents,
      payment_method: quote.paymentMethodId,
      metadata: {
        waves_statement_id: String(statementId),
        waves_payer_id: String(statement.payer_id),
        base_amount: String(baseCents / 100),
        card_surcharge: String(surchargeCents / 100),
        surcharge_rate_bps: String(rateBps),
        surcharge_policy_version: policyVersion,
        card_funding: funding || 'unknown',
        save_card_opt_in: saveCard ? 'true' : 'false',
      },
      setup_future_usage: saveCard ? 'off_session' : '',
    };
    if (surchargeDetails) updateParams.amount_details = surchargeDetails;

    try {
      await stripe.paymentIntents.update(statement.stripe_payment_intent_id, updateParams, usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined);
      const confirmed = await stripe.paymentIntents.confirm(statement.stripe_payment_intent_id, {}, usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined);
      logger.info(`[stripe] Finalized statement S-${statementId}: funding=${funding} surcharge=${surchargeCents}c total=${totalCents}c PI=${confirmed.id} status=${confirmed.status}`);
      return {
        paymentIntentId: confirmed.id,
        paymentMethodId: quote.paymentMethodId,
        clientSecret: confirmed.client_secret,
        status: confirmed.status,
        requiresAction: confirmed.status === 'requires_action',
        base: baseCents / 100,
        surcharge: surchargeCents / 100,
        total: totalCents / 100,
        rateBps,
        funding,
      };
    } catch (err) {
      logger.error(`[stripe] Finalize failed for statement PI ${statement.stripe_payment_intent_id}: ${err.message}`);
      throw new Error(`Failed to finalize statement payment: ${err.message}`);
    }
  },

  // =========================================================================
  // CONFIRM INVOICE PAYMENT
  // =========================================================================

  /**
   * After the frontend confirms a PaymentIntent on the pay page,
   * call this to mark the invoice as paid and record the payment.
   * @param {string} invoiceId — Waves invoice UUID
   * @param {string} paymentIntentId — Stripe pi_xxx ID
   * @returns {object} payment record
   */
  async confirmInvoicePayment(invoiceId, paymentIntentId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    // Phase 2: an accrued invoice is collected ONLY via its consolidated
    // statement — never confirm an individual payment for it.
    if (invoice.payer_statement_id) {
      throw new Error('Invoice is billed on the payer’s monthly statement — pay the statement, not the individual invoice');
    }
    if (['void', 'refunded', 'canceled', 'cancelled'].includes(String(invoice.status || '').toLowerCase())) {
      assertInvoiceCollectible(invoice.status);
    }
    if (invoice.status === 'paid') {
      const existingPayment = await db('payments')
        .where({ stripe_payment_intent_id: paymentIntentId })
        .orderBy('created_at', 'desc')
        .first();
      if (existingPayment) return existingPayment;
      throw new Error('Invoice already paid');
    }
    if (invoice.status === 'prepaid') {
      throw new Error('Invoice is already prepaid');
    }
    if (invoice.status === 'processing'
      && String(invoice.stripe_payment_intent_id || '') !== String(paymentIntentId)) {
      throw new Error('Bank payment is already processing');
    }
    if (invoice.stripe_payment_intent_id
      && String(invoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
      throw new Error('Invoice has a different active payment');
    }

    try {
      // Retrieve the PI to verify it succeeded
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      // Bind PI ↔ invoice via the metadata that createInvoicePaymentIntent
      // wrote at mint time. Without this check, a caller who knows another
      // invoice's token can submit a successful PI from a DIFFERENT
      // invoice and mark THIS invoice paid — Invoice A would settle
      // against Invoice B's actual charge, with both rows pointing at the
      // same PI. createInvoicePaymentIntent always sets waves_invoice_id;
      // a missing-metadata PI cannot belong to this flow.
      const piInvoiceId = pi.metadata?.waves_invoice_id;
      if (!piInvoiceId || String(piInvoiceId) !== String(invoiceId)) {
        logger.warn(
          `[stripe] confirmInvoicePayment refused — PI ${paymentIntentId} ` +
          `metadata.waves_invoice_id=${piInvoiceId || 'null'} does not match invoice ${invoiceId}`,
        );
        throw new Error('PaymentIntent does not belong to this invoice');
      }

      const charge = pi.latest_charge;
      let receiptUrl = null;
      let cardBrand = null;
      let cardLastFour = null;
      // Derive payment_method from the actual charge details rather than
      // hardcoding 'card' — an ACH (us_bank_account) confirm used to land
      // on the invoice as payment_method='card', which leaked the wrong
      // tender into receipts and downstream reporting.
      let resolvedPaymentMethod = pi.payment_method_types?.[0] || 'card';
      let bankLastFour = null;
      let pmdType = null;

      // Get receipt and card info from the charge
      if (charge) {
        try {
          const chargeObj = typeof charge === 'string'
            ? await stripe.charges.retrieve(charge)
            : charge;
          receiptUrl = chargeObj.receipt_url || null;
          const pmd = chargeObj.payment_method_details;
          pmdType = pmd?.type || null;
          if (pmd?.card) {
            resolvedPaymentMethod = 'card';
            cardBrand = pmd.card.brand?.toUpperCase();
            cardLastFour = pmd.card.last4;
          } else if (pmd?.us_bank_account) {
            resolvedPaymentMethod = 'us_bank_account';
            bankLastFour = pmd.us_bank_account.last4 || null;
          } else if (pmd?.type) {
            resolvedPaymentMethod = pmd.type;
          }
        } catch {
          // Non-critical — continue without receipt details
        }
      }

      // ACH PaymentIntents commonly move to `processing` after the customer
      // completes bank-account confirmation. There is no charge receipt yet,
      // but the PaymentMethod can still give us tender type + last four.
      if (!pmdType && pi.payment_method) {
        try {
          const pm = typeof pi.payment_method === 'string'
            ? await stripe.paymentMethods.retrieve(pi.payment_method)
            : pi.payment_method;
          pmdType = pm?.type || null;
          if (pm?.card) {
            resolvedPaymentMethod = 'card';
            cardBrand = pm.card.brand?.toUpperCase();
            cardLastFour = pm.card.last4;
          } else if (pm?.us_bank_account) {
            resolvedPaymentMethod = 'us_bank_account';
            bankLastFour = pm.us_bank_account.last4 || null;
          } else if (pm?.type) {
            resolvedPaymentMethod = pm.type;
          }
        } catch {
          // Non-critical — status classification can still use PI metadata.
        }
      }

      // Check for card payments that bypassed the /quote+/finalize surcharge flow.
      // Express Checkout (wallets) are allowed at base-only (phase 1).
      // The surcharge_policy_version metadata is set by /finalize. Older
      // already-surcharged PIs may lack that key, so allow a positive recorded
      // surcharge before treating the payment as a bypass.
      const isCardFamily = pmdType && pmdType !== 'us_bank_account' && pmdType !== 'ach';
      const wasFinalized = pi.metadata?.surcharge_policy_version;
      const recordedSurchargeCents = Math.max(
        Math.round(Number(pi.metadata?.card_surcharge || 0) * 100),
        Number(pi.amount_details?.surcharge?.amount || 0),
      );
      const surchargeAlreadyApplied = recordedSurchargeCents > 0;
      if (isCardFamily && !wasFinalized && !surchargeAlreadyApplied) {
        // Card payment without surcharge_policy_version = bypassed /finalize.
        // Don't block (payment already succeeded at Stripe), but check if it's
        // a credit card that should have been surcharged.
        let pmFunding = null;
        let isWalletPM = false;
        let pmLookupFailed = false;
        try {
          const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
          if (pmId) {
            const pmObj = await stripe.paymentMethods.retrieve(pmId);
            pmFunding = pmObj.card?.funding || null;
            isWalletPM = !!pmObj.card?.wallet;
          }
        } catch (pmErr) {
          pmLookupFailed = true;
          logger.error(`[stripe] PM lookup failed for bypass check on PI ${paymentIntentId}: ${pmErr.message}`);
        }

        if (pmFunding === 'credit' && !isWalletPM) {
          logger.error(
            `[stripe] Card payment on PI ${paymentIntentId} bypassed /finalize. ` +
            `Invoice ${invoice.invoice_number}. Blocking confirm — customer must use /quote+/finalize.`,
          );
          try {
            await db('customer_health_alerts').insert({
              customer_id: invoice.customer_id,
              alert_type: 'surcharge_bypass_blocked',
              severity: 'medium',
              title: `Surcharge bypass blocked — invoice ${invoice.invoice_number}`,
              description: `Credit card confirm attempt without surcharge finalization. PI: ${paymentIntentId}. Customer redirected to retry.`,
              // customer_health_alerts has trigger_data, not metadata — the old
              // column name made these alerts silently fail to insert.
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: paymentIntentId,
                card_funding: pmFunding,
              }),
            });
          } catch (alertErr) {
            logger.error(`[stripe] Bypass-blocked alert insert failed: ${alertErr.message}`);
          }
          const err = new Error('Payment requires surcharge finalization. Please refresh and try again.');
          err.code = 'SURCHARGE_NOT_FINALIZED';
          throw err;
        } else if (pmFunding === 'credit' && isWalletPM) {
          logger.info(
            `[stripe] Wallet credit card on PI ${paymentIntentId} confirmed at base-only ` +
            `(Express Checkout, phase 1). Invoice ${invoice.invoice_number}.`,
          );
        } else if (pmLookupFailed) {
          logger.error(
            `[stripe] FAIL-CLOSED: Could not determine funding for unfinalized card PI ${paymentIntentId}. ` +
            `Invoice ${invoice.invoice_number}. Blocking confirm — customer must retry through /quote+/finalize.`,
          );
          try {
            await db('customer_health_alerts').insert({
              customer_id: invoice.customer_id,
              // alert_type is varchar(30) — 'surcharge_bypass_unknown_funding'
              // (32 chars) overflowed and made the insert silently fail.
              alert_type: 'surcharge_unknown_funding',
              severity: 'high',
              title: `Unknown funding on unfinalized card — invoice ${invoice.invoice_number}`,
              description: `Card payment confirmed without /finalize and PM funding lookup failed. PI: ${paymentIntentId}. May be under-collected.`,
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: paymentIntentId,
              }),
            });
          } catch (alertErr) {
            logger.error(`[stripe] Unknown-funding alert insert failed: ${alertErr.message}`);
          }
          const err = new Error('Payment requires surcharge verification. Please refresh and try again.');
          err.code = 'SURCHARGE_FUNDING_UNKNOWN';
          throw err;
        } else {
          logger.info(
            `[stripe] Non-credit card (${pmFunding || 'unknown'}) on PI ${paymentIntentId} ` +
            `confirmed without /finalize — no surcharge expected. Invoice ${invoice.invoice_number}.`,
          );
        }
      }

      const actualMethodType = pmdType || resolvedPaymentMethod;
      const invoiceBaseAmount = Number(invoice.total);
      assertInvoicePaymentIntentTenderMatches(pi, actualMethodType, invoiceBaseAmount);

      const paymentStatus = invoicePaymentStatusForIntent(pi, actualMethodType);
      const invoiceStatus = paymentStatus === 'paid' ? 'paid' : 'processing';

      // Defense-in-depth surcharge-bypass detection. The
      // payment_method_types lock at /update-amount time is the primary
      // defense — Stripe rejects a confirm with the wrong method family.
      // If somehow a charge succeeds for less than the expected amount
      // for its actual method (Stripe API drift, a race with the lock,
      // a flow we haven't anticipated), the charge is already settled
      // and we can't unwind it cheaply. Log critical + create a health
      // alert so an operator can decide whether to follow up.
      if (paymentStatus === 'paid' && pmdType) {
        // Compare against the surcharge policy stored on the PI at charge time,
        // not a fresh recompute — the pay page may have intentionally charged
        // differently (no surcharge for debit, base-only for express checkout).
        const metaBase = Math.round(Number(pi.metadata?.base_amount || invoice.total) * 100);
        const metaSurcharge = Math.round(Number(pi.metadata?.card_surcharge || 0) * 100);
        // If metadata shows 0 surcharge but PM is credit card, re-derive expected
        // surcharge — the PI may have bypassed /finalize.
        let expectedSurcharge = metaSurcharge;
        if (metaSurcharge === 0 && pmdType && pmdType !== 'us_bank_account' && pmdType !== 'ach') {
          let pmFunding = pi.metadata?.card_funding || null;
          let isWalletBypass = false;
          if (!pmFunding) {
            try {
              const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
              if (pmId) {
                const pmObj = await stripe.paymentMethods.retrieve(pmId);
                pmFunding = pmObj.card?.funding || null;
                isWalletBypass = !!pmObj.card?.wallet;
              }
            } catch { /* non-fatal */ }
          }
          if (pmFunding === 'credit' && !isWalletBypass) {
            const { computeSurchargeCents } = require('./stripe-pricing');
            expectedSurcharge = computeSurchargeCents(metaBase);
          }
        }
        const expectedCents = metaBase + expectedSurcharge;
        const actualCents = Number(pi.amount) || 0;
        if (actualCents + 1 < expectedCents) {  // 1-cent tolerance for rounding
          logger.error(
            `[stripe] CRITICAL: Surcharge-bypass detected on PI ${paymentIntentId}. ` +
            `Method=${pmdType}, expected=$${(expectedCents / 100).toFixed(2)} (${expectedCents}c), ` +
            `actual=$${(actualCents / 100).toFixed(2)} (${actualCents}c). Invoice ${invoice.invoice_number}.`,
          );
          try {
            await db('customer_health_alerts').insert({
              customer_id: invoice.customer_id,
              alert_type: 'stripe_surcharge_bypass',
              severity: 'high',
              title: `Surcharge bypass detected — invoice ${invoice.invoice_number}`,
              description: `Customer paid $${(actualCents / 100).toFixed(2)} via ${pmdType}, expected $${(expectedCents / 100).toFixed(2)} (surcharge shortfall). PI: ${paymentIntentId}.`,
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: paymentIntentId,
                method: pmdType,
                expected_total: expectedCents / 100,
                actual_total: actualCents / 100,
                shortfall: (expectedCents - actualCents) / 100,
              }),
            });
          } catch (alertErr) {
            logger.error(`[stripe] Surcharge-bypass alert insert failed: ${alertErr.message}`);
          }
        }
      }

      const chargedCents = Number(pi.amount_received || pi.amount || 0);
      const chargedTotal = chargedCents > 0
        ? Math.round((chargedCents / 100) * 100) / 100
        : parseFloat(invoice.total);
      const metadataBaseAmount = Number(pi.metadata?.base_amount ?? invoice.total);
      const metadataCardSurcharge = Number(pi.metadata?.card_surcharge ?? 0);

      // Update invoice + record payment atomically
      const paymentRecord = await db.transaction(async trx => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', String(paymentIntentId)],
        );

        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceId })
          .forUpdate()
          .first();
        if (!lockedInvoice) throw new Error('Invoice not found');
        if (['void', 'refunded', 'canceled', 'cancelled'].includes(String(lockedInvoice.status || '').toLowerCase())) {
          assertInvoiceCollectible(lockedInvoice.status);
        }
        if (lockedInvoice.status === 'paid') {
          const existingPayment = await trx('payments')
            .where({ stripe_payment_intent_id: paymentIntentId })
            .orderBy('created_at', 'desc')
            .first();
          if (existingPayment) return existingPayment;
          throw new Error('Invoice already paid');
        }
        if (lockedInvoice.status === 'prepaid') {
          throw new Error('Invoice is already prepaid');
        }
        if (lockedInvoice.status === 'processing'
          && String(lockedInvoice.stripe_payment_intent_id || '') !== String(paymentIntentId)) {
          throw new Error('Bank payment is already processing');
        }
        if (lockedInvoice.stripe_payment_intent_id
          && String(lockedInvoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
          throw new Error('Invoice has a different active payment');
        }
        if (paymentStatus === 'processing') {
          const expected = computeChargeAmount(parseFloat(lockedInvoice.total), resolvedPaymentMethod);
          const expectedCents = Math.round(expected.total * 100);
          const actualCents = Number(pi.amount_received || pi.amount || 0);
          if (actualCents !== expectedCents) {
            logger.error(
              `[stripe] ACH processing amount mismatch on PI ${paymentIntentId}. ` +
              `Expected ${expectedCents}c from invoice ${lockedInvoice.id}; got ${actualCents}c.`,
            );
            try {
              await stripe.paymentIntents.cancel(paymentIntentId);
            } catch (cancelErr) {
              logger.warn(`[stripe] Could not cancel mismatched processing PI ${paymentIntentId}: ${cancelErr.message}`);
            }
            throw new Error('Payment amount no longer matches this invoice. Please refresh and try again.');
          }
        }

        const invoiceUpdates = {
          status: invoiceStatus,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntentId,
          stripe_charge_id: typeof charge === 'string' ? charge : null,
          payment_method: resolvedPaymentMethod,
          card_brand: cardBrand,
          // For card payments this is the card last4; for ACH we store
          // the bank-account last4 in the same column so the receipt
          // template can render "Bank •1234" via {card_line}.
          card_last_four: cardLastFour || bankLastFour,
          receipt_url: receiptUrl,
          total: chargedTotal,
        };
        if (paymentStatus === 'paid') {
          invoiceUpdates.paid_at = new Date().toISOString();
        }

        const invoiceRowsUpdated = await trx('invoices')
          .where({ id: invoiceId })
          .whereNotIn('status', ['paid', 'void', 'refunded', 'canceled', 'cancelled'])
          .where(function activePaymentIntentGuard() {
            this.whereNull('stripe_payment_intent_id')
              .orWhere({ stripe_payment_intent_id: paymentIntentId });
          })
          .update(invoiceUpdates);
        if (!invoiceRowsUpdated) {
          throw new Error('Invoice has a different active payment');
        }

        const paymentPayload = {
          customer_id: invoice.customer_id,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntentId,
          stripe_charge_id: typeof charge === 'string' ? charge : null,
          payment_date: etDateString(),
          amount: chargedTotal,
          base_amount_cents: Math.round(Number(pi.metadata?.base_amount || invoice.total) * 100),
          surcharge_amount_cents: Math.round(Number(pi.metadata?.card_surcharge || 0) * 100),
          surcharge_rate_bps: Number(pi.metadata?.surcharge_rate_bps || 0),
          surcharge_policy_version: pi.metadata?.surcharge_policy_version || null,
          card_funding: pi.metadata?.card_funding || null,
          card_brand: cardBrand || null,
          status: paymentStatus,
          description: paymentStatus === 'processing'
            ? `Invoice ${invoice.invoice_number} (bank payment pending)`
            : metadataCardSurcharge > 0
            ? `Invoice ${invoice.invoice_number} (includes $${metadataCardSurcharge.toFixed(2)} credit card surcharge)`
            : `Invoice ${invoice.invoice_number}`,
          metadata: JSON.stringify({
            invoice_id: invoiceId,
            stripe_receipt_url: receiptUrl,
            base_amount: metadataBaseAmount,
            card_surcharge: metadataCardSurcharge,
            charged_amount: chargedTotal,
            payment_method: resolvedPaymentMethod,
            payment_state: paymentStatus,
          }),
        };

        if (receiptUrl) paymentPayload.receipt_url = receiptUrl;
        if (cardLastFour || bankLastFour) paymentPayload.card_last_four = cardLastFour || bankLastFour;

        const existingPayment = await trx('payments')
          .where({ stripe_payment_intent_id: paymentIntentId })
          .orderBy('created_at', 'desc')
          .first();
        if (existingPayment) {
          const [record] = await trx('payments')
            .where({ id: existingPayment.id })
            .update(paymentPayload)
            .returning('*');
          return record;
        }

        const [record] = await trx('payments').insert(paymentPayload).returning('*');

        return record;
      });

      logger.info(`[stripe] Invoice ${invoice.invoice_number} ${paymentStatus} via Stripe PI: ${paymentIntentId}`);

      // Stop the automated follow-up sequence + send thank-you if we nagged.
      if (paymentStatus === 'paid') {
        try {
          await require('./invoice-followups').stopOnPayment(invoiceId);
        } catch (e) {
          logger.error(`[invoice-followups] stopOnPayment (stripe confirm) failed: ${e.message}`);
        }
        try {
          await require('./annual-prepay-renewals').syncTermForInvoicePayment({
            id: invoiceId,
            status: 'paid',
            paid_at: new Date().toISOString(),
          });
        } catch (e) {
          logger.error(`[annual-prepay] activation failed for invoice ${invoiceId}: ${e.message}`);
        }
      }

      return paymentRecord;
    } catch (err) {
      logger.error(`[stripe] Confirm invoice payment failed: ${err.message}`, { stack: err.stack });
      // Map Stripe decline_codes to friendly customer-facing messages.
      const friendly = friendlyStripeError(err);
      throw new Error(friendly);
    }
  },
};

// Map Stripe error codes/decline_codes to friendly customer-facing messages.
// Raw Stripe error messages are logged server-side, never returned to the customer.
// Accepts either a thrown Stripe error (`err.code` / `err.raw.code`) or a
// PaymentIntent `last_payment_error` object (`code` / `decline_code` at top
// level) — same shape for our purposes.
function friendlyStripeError(err) {
  const declineCode = err?.decline_code || err?.raw?.decline_code;
  const code = err?.code || err?.raw?.code;
  const map = {
    card_declined: 'Your card was declined. Please try another payment method.',
    insufficient_funds: 'Insufficient funds. Please use a different card.',
    expired_card: 'This card has expired. Please use a different card.',
    incorrect_cvc: 'The security code (CVC) is incorrect.',
    processing_error: 'A processing error occurred. Please try again.',
    incorrect_number: 'The card number is incorrect.',
    authentication_required: 'Your bank requires additional authentication. Please retry.',
    payment_intent_authentication_failure: 'Card authentication failed. Please retry or use a different card.',
  };
  return map[declineCode] || map[code] || 'We could not process your payment. Please try again or use a different payment method.';
}

module.exports = StripeService;
module.exports.friendlyStripeError = friendlyStripeError;
