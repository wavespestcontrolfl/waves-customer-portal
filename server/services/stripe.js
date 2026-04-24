const Stripe = require('stripe');
const config = require('../config');
const stripeConfig = require('../config/stripe-config');
const db = require('../models/db');
const logger = require('./logger');
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
// ACH pays the quoted amount; cards / wallets pay base × 1.03.
// ═══════════════════════════════════════════════════════════════
const CARD_SURCHARGE_RATE = 0.03;

// Accepts a stored payment_methods.method_type ('card' | 'ach')
// OR a Stripe Payment Element type ('card' | 'us_bank_account' | 'apple_pay' | 'google_pay' | 'link')
function isCardMethodType(methodType) {
  if (!methodType) return false;
  const m = String(methodType).toLowerCase();
  if (m === 'ach' || m === 'us_bank_account' || m === 'bank' || m === 'bank_account') return false;
  // card, apple_pay, google_pay, link, and anything else default to card-family (surcharged)
  return true;
}

function computeChargeAmount(baseAmountDollars, methodType) {
  const base = Math.round(Number(baseAmountDollars) * 100) / 100;
  if (!isCardMethodType(methodType)) {
    return { base, surcharge: 0, total: base };
  }
  const surcharge = Math.round(base * CARD_SURCHARGE_RATE * 100) / 100;
  const total = Math.round((base + surcharge) * 100) / 100;
  return { base, surcharge, total };
}

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
   * @param {string} [paymentMethodType] — 'card' or 'us_bank_account'
   * @returns {{ clientSecret: string, setupIntentId: string }}
   */
  async createSetupIntent(customerId, paymentMethodType = 'card') {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

    const paymentMethodTypes = paymentMethodType === 'us_bank_account'
      ? ['us_bank_account']
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
   * @returns {object} payment_methods row
   */
  async savePaymentMethod(customerId, paymentMethodId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

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
        is_default: true,
        autopay_enabled: true,
      };

      if (pm.type === 'card' && pm.card) {
        record.method_type = 'card';
        record.card_brand = pm.card.brand ? pm.card.brand.toUpperCase() : null;
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
        await trx('payment_methods')
          .where({ customer_id: customerId })
          .whereNot({ id: inserted.id })
          .update({ is_default: false });
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

    // Apply 3% processing surcharge when the stored autopay method is card-family.
    // ACH methods are charged the quoted amount with no surcharge.
    const { base: baseAmount, surcharge: surchargeAmount, total: totalAmount } =
      computeChargeAmount(amountDollars, card.method_type);
    const amountCents = Math.round(totalAmount * 100);

    // Step 1: Charge via Stripe
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: card.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        description: surchargeAmount > 0
          ? `${description} (includes $${surchargeAmount.toFixed(2)} card processing fee)`
          : description,
        metadata: {
          waves_customer_id: customerId,
          base_amount: String(baseAmount),
          card_surcharge: String(surchargeAmount),
          ...metadata,
        },
      });
    } catch (err) {
      // Stripe charge failed — record the failure
      logger.error(`[stripe] Charge failed for ${customerId}: ${err.message}`);
      const [failedRecord] = await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        processor: 'stripe',
        payment_date: etDateString(),
        amount: totalAmount,
        status: 'failed',
        description: `${description} — FAILED`,
        failure_reason: err.message,
        metadata: JSON.stringify({
          error: err.message,
          code: err.code,
          base_amount: baseAmount,
          card_surcharge: surchargeAmount,
        }),
      }).returning('*');
      throw Object.assign(new Error('Payment processing failed'), { paymentRecord: failedRecord });
    }

    // Step 2: Stripe charge succeeded — record in DB
    const status = paymentIntent.status === 'succeeded' ? 'paid' : 'processing';
    try {
      const [paymentRecord] = await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        processor: 'stripe',
        stripe_payment_intent_id: paymentIntent.id,
        stripe_charge_id: paymentIntent.latest_charge || null,
        payment_date: etDateString(),
        amount: totalAmount,
        status,
        description: surchargeAmount > 0
          ? `${description} (includes $${surchargeAmount.toFixed(2)} card processing fee)`
          : description,
        metadata: JSON.stringify({
          stripe_receipt_url: paymentIntent.charges?.data?.[0]?.receipt_url || null,
          base_amount: baseAmount,
          card_surcharge: surchargeAmount,
        }),
      }).returning('*');

      logger.info(`[stripe] Charge processed: base=$${baseAmount} surcharge=$${surchargeAmount} total=$${totalAmount} for ${customerId}, PI: ${paymentIntent.id}`);
      return paymentRecord;
    } catch (dbErr) {
      // CRITICAL: Stripe charged the customer but DB insert failed
      logger.error(`[stripe] CRITICAL: Charge succeeded (PI: ${paymentIntent.id}) but DB insert failed: ${dbErr.message}`);
      return {
        customer_id: customerId,
        payment_method_id: card.id,
        processor: 'stripe',
        stripe_payment_intent_id: paymentIntent.id,
        amount: totalAmount,
        status,
        description,
        _db_error: dbErr.message,
      };
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
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    const card = await db('payment_methods').where({ id: paymentMethodId }).first();
    if (!card) throw new Error('Payment method not found');
    if (card.customer_id !== invoice.customer_id) {
      throw new Error('Payment method does not belong to invoice customer');
    }
    if (!card.stripe_payment_method_id) {
      throw new Error('Payment method has no Stripe id');
    }

    const stripeCustomerId = await this.ensureStripeCustomer(invoice.customer_id);

    const { base, surcharge, total } = computeChargeAmount(parseFloat(invoice.total), card.method_type);
    const amountCents = Math.round(total * 100);

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
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
          source: 'admin_card_on_file',
        },
      });
    } catch (err) {
      logger.error(`[stripe] chargeInvoiceWithSavedCard failed for invoice ${invoice.invoice_number}: ${err.message}`);
      // Record failure for audit
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

    // Link the PI to the invoice so the webhook can mark it paid.
    await db('invoices')
      .where({ id: invoiceId })
      .update({
        processor: 'stripe',
        stripe_payment_intent_id: paymentIntent.id,
      });

    const status = paymentIntent.status === 'succeeded' ? 'paid' : 'processing';
    const [paymentRecord] = await db('payments').insert({
      customer_id: invoice.customer_id,
      payment_method_id: card.id,
      processor: 'stripe',
      stripe_payment_intent_id: paymentIntent.id,
      stripe_charge_id: paymentIntent.latest_charge || null,
      payment_date: etDateString(),
      amount: total,
      status,
      description: surcharge > 0
        ? `Invoice ${invoice.invoice_number} — card on file (includes $${surcharge.toFixed(2)} fee)`
        : `Invoice ${invoice.invoice_number} — card on file`,
      metadata: JSON.stringify({
        base_amount: base,
        card_surcharge: surcharge,
        source: 'admin_card_on_file',
      }),
    }).returning('*');

    logger.info(`[stripe] Card-on-file charge succeeded: $${total} for invoice ${invoice.invoice_number}, PI ${paymentIntent.id}`);
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

      const updated = await db('payments').where({ id: paymentId }).first();
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
   * @param {{ saveCard?: boolean, cardOnly?: boolean }} [opts]
   */
  async createInvoicePaymentIntent(invoiceId, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    const saveCard = !!opts.saveCard;
    const cardOnly = !!opts.cardOnly;
    const baseAmount = parseFloat(invoice.total);
    // Card-only flow (admin manual card entry): bake the 3% surcharge
    // into the PI up front since we already know the tender is card.
    // The default non-card path leaves the PI at base amount and relies
    // on /update-amount to add surcharge when the Payment Element
    // change event fires.
    const { base: cardBase, surcharge: cardSurcharge, total: cardTotal } = cardOnly
      ? computeChargeAmount(baseAmount, 'card')
      : { base: baseAmount, surcharge: 0, total: baseAmount };
    const amountCents = Math.round(cardTotal * 100);

    const piParams = {
      amount: amountCents,
      currency: 'usd',
      description: `Invoice ${invoice.invoice_number} — ${invoice.title || 'Waves Pest Control'}`,
      metadata: {
        waves_invoice_id: invoiceId,
        invoice_number: invoice.invoice_number,
        waves_customer_id: invoice.customer_id,
        base_amount: String(cardBase),
        card_surcharge: String(cardSurcharge),
        save_card_opt_in: saveCard ? 'true' : 'false',
        selected_method_category: cardOnly ? 'card' : 'unknown',
      },
    };
    if (cardOnly) {
      piParams.payment_method_types = ['card'];
    } else {
      piParams.automatic_payment_methods = { enabled: true };
    }

    if (saveCard && invoice.customer_id) {
      piParams.customer = await this.ensureStripeCustomer(invoice.customer_id);
      piParams.setup_future_usage = 'off_session';
    }

    try {
      // Idempotency key includes saveCard + cardOnly so toggling either
      // regenerates a clean PI instead of hitting the cached one.
      const idempotencyKey = `invoice_pi_${invoiceId}_${amountCents}_${saveCard ? 'save' : 'nosave'}_${cardOnly ? 'cardonly' : 'auto'}`;
      const paymentIntent = await stripe.paymentIntents.create(piParams, { idempotencyKey });

      await db('invoices')
        .where({ id: invoiceId })
        .update({
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
        });

      logger.info(`[stripe] Invoice PaymentIntent created: ${paymentIntent.id} for invoice ${invoice.invoice_number} (base=$${baseAmount})`);
      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: baseAmount,
        baseAmount,
        cardSurchargeRate: CARD_SURCHARGE_RATE,
      };
    } catch (err) {
      logger.error(`[stripe] Invoice PaymentIntent failed for invoice ${invoiceId} (amount=${amountCents}): ${err.type || 'Error'} — ${err.message}${err.code ? ` [code=${err.code}]` : ''}${err.param ? ` [param=${err.param}]` : ''}`);
      throw new Error(`Failed to create payment intent for invoice: ${err.message}`);
    }
  },

  /**
   * Update an open invoice PaymentIntent's amount based on the payment method
   * the customer picked on the Payment Element.
   *
   * - Card / Apple Pay / Google Pay / Link → base × 1.03
   * - us_bank_account (ACH) → base × 1.00
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
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    const saveCard = !!opts.saveCard;
    const { base, surcharge, total } = computeChargeAmount(parseFloat(invoice.total), methodCategory);
    const amountCents = Math.round(total * 100);

    const updateParams = {
      amount: amountCents,
      metadata: {
        waves_invoice_id: invoiceId,
        invoice_number: invoice.invoice_number,
        base_amount: String(base),
        card_surcharge: String(surcharge),
        selected_method_category: String(methodCategory || 'unknown'),
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
      logger.info(`[stripe] PI ${paymentIntentId} updated → base=$${base} surcharge=$${surcharge} total=$${total} (method=${methodCategory})`);
      return {
        paymentIntentId: paymentIntent.id,
        base,
        surcharge,
        total,
        cardSurchargeRate: CARD_SURCHARGE_RATE,
      };
    } catch (err) {
      logger.error(`[stripe] PI update failed for ${paymentIntentId}: ${err.message}`);
      throw new Error(`Failed to update payment amount: ${err.message}`);
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
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    try {
      // Retrieve the PI to verify it succeeded
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.status !== 'succeeded') {
        throw new Error(`PaymentIntent status is "${pi.status}", expected "succeeded"`);
      }

      const charge = pi.latest_charge;
      let receiptUrl = null;
      let cardBrand = null;
      let cardLastFour = null;

      // Get receipt and card info from the charge
      if (charge) {
        try {
          const chargeObj = typeof charge === 'string'
            ? await stripe.charges.retrieve(charge)
            : charge;
          receiptUrl = chargeObj.receipt_url || null;
          if (chargeObj.payment_method_details?.card) {
            cardBrand = chargeObj.payment_method_details.card.brand?.toUpperCase();
            cardLastFour = chargeObj.payment_method_details.card.last4;
          }
        } catch {
          // Non-critical — continue without receipt details
        }
      }

      // Update invoice + record payment atomically
      const paymentRecord = await db.transaction(async trx => {
        await trx('invoices')
          .where({ id: invoiceId })
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            processor: 'stripe',
            stripe_payment_intent_id: paymentIntentId,
            stripe_charge_id: typeof charge === 'string' ? charge : null,
            payment_method: 'card',
            card_brand: cardBrand,
            card_last_four: cardLastFour,
            receipt_url: receiptUrl,
          });

        const [record] = await trx('payments').insert({
          customer_id: invoice.customer_id,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntentId,
          stripe_charge_id: typeof charge === 'string' ? charge : null,
          payment_date: etDateString(),
          amount: parseFloat(invoice.total),
          status: 'paid',
          description: `Invoice ${invoice.invoice_number}`,
          metadata: JSON.stringify({
            invoice_id: invoiceId,
            stripe_receipt_url: receiptUrl,
          }),
        }).returning('*');

        return record;
      });

      logger.info(`[stripe] Invoice ${invoice.invoice_number} paid via Stripe PI: ${paymentIntentId}`);

      // Stop the automated follow-up sequence + send thank-you if we nagged.
      try {
        await require('./invoice-followups').stopOnPayment(invoiceId);
      } catch (e) {
        logger.error(`[invoice-followups] stopOnPayment (stripe confirm) failed: ${e.message}`);
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
  };
  return map[declineCode] || map[code] || 'We could not process your payment. Please try again or use a different payment method.';
}

module.exports = StripeService;
