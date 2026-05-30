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
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia' });
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
   * @returns {object} payments table row
   */
  async charge(customerId, amountDollars, description, metadata = {}) {
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
      paymentIntent = await stripe.paymentIntents.create(
        piParams,
        surchargeDetails ? { apiVersion: SURCHARGE_API_VERSION } : undefined,
      );
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

      const [failedRecord] = await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        processor: 'stripe',
        stripe_payment_intent_id: piIdFromErr,
        payment_date: etDateString(),
        amount: totalAmount,
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
          requires_action: requiresAction,
          base_amount: baseAmount,
          card_surcharge: surchargeAmount,
        }),
      }).returning('*');

      if (requiresAction) {
        const sca = new Error('Customer authentication required');
        sca.code = 'STRIPE_REQUIRES_ACTION';
        sca.stripePaymentIntentId = piIdFromErr;
        sca.paymentRecord = failedRecord;
        throw sca;
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

      const [paymentRecord] = await db('payments').insert({
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
  async chargeMonthly(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const description = `${customer.waveguard_tier || 'WaveGuard'} WaveGuard Monthly — ${customer.first_name} ${customer.last_name}`;
    return this.charge(customerId, customer.monthly_rate, description, {
      type: 'monthly_autopay',
      tier: customer.waveguard_tier || '',
    });
  },

  // =========================================================================
  // CHARGE ONE-TIME
  // =========================================================================

  /**
   * Process a one-time charge (add-on service, event, etc.)
   */
  async chargeOneTime(customerId, amount, description) {
    return this.charge(customerId, amount, description, { type: 'one_time' });
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
  async getPaymentHistory(customerId, limit = 20) {
    return db('payments')
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

    const saveCard = !!opts.saveCard;
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

    const saveCard = !!opts.saveCard;
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
      logger.error(`[stripe] PI update failed for ${paymentIntentId}: ${err.message}`);
      throw new Error(`Failed to update payment amount: ${err.message}`);
    }
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
    const saveCard = !!opts.saveCard;

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
              metadata: JSON.stringify({
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
              alert_type: 'surcharge_bypass_unknown_funding',
              severity: 'high',
              title: `Unknown funding on unfinalized card — invoice ${invoice.invoice_number}`,
              description: `Card payment confirmed without /finalize and PM funding lookup failed. PI: ${paymentIntentId}. May be under-collected.`,
              metadata: JSON.stringify({
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
              metadata: JSON.stringify({
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
